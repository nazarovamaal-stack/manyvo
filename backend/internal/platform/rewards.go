package platform

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"math/big"
)

const SpinCost = 1

func (a *App) Rewards(ctx context.Context, u User) (M, error) {
	where := "r.active"
	args := []any{}
	if u.Role == "owner" {
		where = "r.owner_id=$1"
		args = append(args, u.ID)
	}
	items, e := objects(ctx, a.DB, "SELECT to_jsonb(r)||jsonb_build_object('stock',(SELECT count(*) FROM inventory i WHERE i.reward_id=r.id AND i.claim_id IS NULL)) FROM rewards r WHERE "+where+" ORDER BY r.created_at DESC", args...)
	if e != nil {
		return nil, e
	}
	var prize M
	e = object(ctx, a.DB, "SELECT to_jsonb(r)||jsonb_build_object('stock',(SELECT count(*) FROM inventory i WHERE i.reward_id=r.id AND i.claim_id IS NULL)) FROM rewards r WHERE channel='wheel' AND active LIMIT 1", nil, &prize)
	if e != nil && !errors.Is(e, pgx.ErrNoRows) {
		return nil, e
	}
	balance, e := a.balance(ctx, a.DB, u.ID)
	return M{"rewards": items, "balance": balance, "wheel": M{"cost": SpinCost, "sectors": []M{{"label": "Без приза", "weight": 1}, {"label": "Без приза", "weight": 1}, {"label": "Без приза", "weight": 1}, {"label": "Приз", "weight": 1}}, "prize": prize, "available": prize != nil && number(prize, "stock") > 0, "demo_economy": true}}, e
}

type RewardInput struct {
	Title       string   `json:"title"`
	Description string   `json:"description"`
	Channel     string   `json:"channel"`
	Cost        int      `json:"cost"`
	Demo        bool     `json:"is_demo"`
	Codes       []string `json:"codes"`
}

func codesValid(codes []string) error {
	if len(codes) < 1 || len(codes) > 1000 {
		return &Fault{400, "Добавьте от 1 до 1000 кодов."}
	}
	seen := map[string]bool{}
	for _, code := range codes {
		if code == "" || len(code) > 200 || seen[code] {
			return &Fault{400, "Коды должны быть непустыми и уникальными, до 200 символов."}
		}
		seen[code] = true
	}
	return nil
}
func (a *App) CreateReward(ctx context.Context, u User, input RewardInput) (M, error) {
	if u.Role != "owner" {
		return nil, forbidden()
	}
	if input.Title == "" || clean(input.Title, 120) != nil || clean(input.Description, 1000) != nil || !(input.Channel == "guaranteed" || input.Channel == "wheel") {
		return nil, &Fault{400, "Заполните название, описание и тип награды."}
	}
	if input.Cost < 2 || input.Cost > 1000000 {
		return nil, &Fault{400, "Стоимость гарантированной награды — от 2 до 1000000 баллов."}
	}
	if e := codesValid(input.Codes); e != nil {
		return nil, e
	}
	id := ID()
	e := a.transaction(ctx, func(tx pgx.Tx) error {
		if _, e := tx.Exec(ctx, "INSERT INTO rewards VALUES($1,$2,$3,$4,$5,$6,$7,true,$8)", id, u.ID, input.Title, input.Description, input.Cost, input.Channel, input.Demo, a.Clock()); e != nil {
			return e
		}
		for _, code := range input.Codes {
			if _, e := tx.Exec(ctx, "INSERT INTO inventory VALUES($1,$2,$3,NULL)", ID(), id, code); e != nil {
				return e
			}
		}
		return nil
	})
	var pe *pgconn.PgError
	if errors.As(e, &pe) && pe.Code == "23505" {
		return nil, &Fault{409, "Код уже добавлен или приз колеса уже настроен."}
	}
	return M{"id": id}, e
}
func (a *App) AddCodes(ctx context.Context, u User, id string, codes []string) (M, error) {
	if u.Role != "owner" {
		return nil, forbidden()
	}
	if e := codesValid(codes); e != nil {
		return nil, e
	}
	e := a.transaction(ctx, func(tx pgx.Tx) error {
		var owner string
		if e := tx.QueryRow(ctx, "SELECT owner_id FROM rewards WHERE id=$1 FOR UPDATE", id).Scan(&owner); e != nil {
			return &Fault{404, "Награда не найдена."}
		}
		if owner != u.ID {
			return forbidden()
		}
		for _, code := range codes {
			if _, e := tx.Exec(ctx, "INSERT INTO inventory VALUES($1,$2,$3,NULL)", ID(), id, code); e != nil {
				return e
			}
		}
		return nil
	})
	var pe *pgconn.PgError
	if errors.As(e, &pe) && pe.Code == "23505" {
		return nil, &Fault{409, "Один из кодов уже существует. Набор не добавлен."}
	}
	return M{"ok": true}, e
}
func (a *App) Claims(ctx context.Context, u User) (M, error) {
	items, e := objects(ctx, a.DB, "SELECT jsonb_build_object('id',c.id,'title',r.title,'description',r.description,'is_demo',r.is_demo,'code',i.code,'created_at',c.created_at) FROM claims c JOIN rewards r ON r.id=c.reward_id JOIN inventory i ON i.id=c.inventory_id WHERE c.user_id=$1 ORDER BY c.created_at DESC", u.ID)
	return M{"claims": items}, e
}
func requestKey(key string) bool {
	if len(key) < 16 || len(key) > 80 {
		return false
	}
	for _, c := range key {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}
func (a *App) Spend(ctx context.Context, u User, key, rewardID string, spin bool) (M, error) {
	if u.Role != "participant" {
		return nil, forbidden()
	}
	if !requestKey(key) {
		return nil, &Fault{400, "Неверный идентификатор операции."}
	}
	fingerprint := "redeem:" + rewardID
	if spin {
		fingerprint = "spin"
	}
	var result M
	e := a.transaction(ctx, func(tx pgx.Tx) error {
		var locked string
		if e := tx.QueryRow(ctx, "SELECT id FROM users WHERE id=$1 FOR UPDATE", u.ID).Scan(&locked); e != nil {
			return e
		}
		var oldFingerprint string
		var old []byte
		e := tx.QueryRow(ctx, "SELECT fingerprint,result FROM reward_operations WHERE user_id=$1 AND request_key=$2", u.ID, key).Scan(&oldFingerprint, &old)
		if e == nil {
			if oldFingerprint != fingerprint {
				return &Fault{409, "Идентификатор уже использован для другого действия."}
			}
			return json.Unmarshal(old, &result)
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		cost := SpinCost
		var reward M
		if spin {
			e = object(ctx, tx, "SELECT to_jsonb(r) FROM rewards r WHERE channel='wheel' AND active FOR UPDATE", nil, &reward)
		} else {
			e = object(ctx, tx, "SELECT to_jsonb(r) FROM rewards r WHERE id=$1 AND channel='guaranteed' AND active FOR UPDATE", []any{rewardID}, &reward)
			cost = int(number(reward, "cost"))
		}
		if errors.Is(e, pgx.ErrNoRows) {
			return &Fault{409, "Награда пока недоступна."}
		}
		if e != nil {
			return e
		}
		var inventoryID, code string
		e = tx.QueryRow(ctx, "SELECT id,code FROM inventory WHERE reward_id=$1 AND claim_id IS NULL ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1", str(reward, "id")).Scan(&inventoryID, &code)
		if errors.Is(e, pgx.ErrNoRows) {
			return &Fault{409, "Все коды разобраны. Баллы не списаны."}
		}
		if e != nil {
			return e
		}
		balance, e := a.balance(ctx, tx, u.ID)
		if e != nil {
			return e
		}
		if balance < cost {
			return &Fault{409, fmt.Sprintf("Недостаточно баллов. Нужно %d, доступно %d.", cost, balance)}
		}
		sector := 3
		if spin {
			if a.Draw != nil {
				sector, e = a.Draw(4)
			} else {
				var n *big.Int
				n, e = rand.Int(rand.Reader, big.NewInt(4))
				if e == nil {
					sector = int(n.Int64())
				}
			}
			if e != nil {
				return e
			}
			if sector < 0 || sector > 3 {
				return errors.New("invalid random draw")
			}
		}
		operation := ID()
		kind := "redeem"
		if spin {
			kind = "spin"
		}
		if _, e = tx.Exec(ctx, "INSERT INTO ledger VALUES($1,$2,NULL,$3,$4,$5,$6)", ID(), u.ID, kind, -cost, operation, a.Clock()); e != nil {
			return e
		}
		result = M{"operation_id": operation, "request_key": key, "kind": kind, "cost": cost, "balance": balance - cost, "sector": sector, "won": !spin || sector == 3, "claim": nil}
		if !spin || sector == 3 {
			claimID := ID()
			if _, e = tx.Exec(ctx, "UPDATE inventory SET claim_id=$1 WHERE id=$2 AND claim_id IS NULL", claimID, inventoryID); e != nil {
				return e
			}
			if _, e = tx.Exec(ctx, "INSERT INTO claims VALUES($1,$2,$3,$4,$5,$6)", claimID, u.ID, str(reward, "id"), inventoryID, operation, a.Clock()); e != nil {
				return e
			}
			result["claim"] = M{"id": claimID, "title": reward["title"], "description": reward["description"], "is_demo": reward["is_demo"], "code": code, "created_at": a.Clock()}
			if e = a.notify(ctx, tx, u.ID, "reward", operation, "Награда получена", str(reward, "title")+". Код доступен в разделе «Мои награды».", nil); e != nil {
				return e
			}
		}
		raw, e := json.Marshal(result)
		if e != nil {
			return e
		}
		_, e = tx.Exec(ctx, "INSERT INTO reward_operations VALUES($1,$2,$3,$4,$5,$6)", operation, u.ID, key, fingerprint, raw, a.Clock())
		return e
	})
	return result, e
}

func (a *App) RewardStatus(ctx context.Context, u User, id string, active bool) (M, error) {
	if u.Role != "owner" {
		return nil, forbidden()
	}
	tag, e := a.DB.Exec(ctx, "UPDATE rewards SET active=$1 WHERE id=$2 AND owner_id=$3", active, id, u.ID)
	var pe *pgconn.PgError
	if errors.As(e, &pe) && pe.Code == "23505" {
		return nil, &Fault{409, "Сначала приостановите другой приз колеса."}
	}
	if e == nil && tag.RowsAffected() == 0 {
		e = &Fault{404, "Награда не найдена."}
	}
	return M{"ok": true}, e
}
