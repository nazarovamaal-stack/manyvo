package platform

import (
	"context"
	"fmt"
	"github.com/jackc/pgx/v5"
)

func (a *App) Notifications(ctx context.Context, u User) (M, error) {
	items, e := objects(ctx, a.DB, "SELECT jsonb_build_object('id',id,'kind',kind,'study_id',study_id,'title',title,'body',body,'created_at',created_at,'read_at',read_at) FROM notifications WHERE user_id=$1 ORDER BY created_at DESC,id LIMIT 200", u.ID)
	if e != nil {
		return nil, e
	}
	var unread int
	e = a.DB.QueryRow(ctx, "SELECT count(*) FROM notifications WHERE user_id=$1 AND read_at IS NULL", u.ID).Scan(&unread)
	return M{"notifications": items, "unread": unread}, e
}
func (a *App) ReadNotifications(ctx context.Context, u User, ids []string) (M, error) {
	if len(ids) > 200 {
		return nil, &Fault{400, "Слишком много уведомлений."}
	}
	_, e := a.DB.Exec(ctx, "UPDATE notifications SET read_at=COALESCE(read_at,$1) WHERE user_id=$2 AND id=ANY($3)", a.Clock(), u.ID, ids)
	return M{"ok": true}, e
}
func (a *App) Devices(ctx context.Context, u User) (M, error) {
	items, e := objects(ctx, a.DB, "SELECT jsonb_build_object('id',id,'name',name,'created_at',created_at,'expires_at',expires_at,'last_seen',last_seen,'revoked_at',revoked_at) FROM devices WHERE user_id=$1 ORDER BY created_at DESC", u.ID)
	return M{"devices": items}, e
}
func (a *App) CreateDevice(ctx context.Context, u User, name string) (M, error) {
	if u.Role != "participant" {
		return nil, forbidden()
	}
	if name == "" {
		name = "Мой Яндекс Браузер"
	}
	if e := clean(name, 80); e != nil {
		return nil, e
	}
	id, token := ID(), "mvo_"+Token()
	expires := a.Clock() + 30*86400
	e := a.transaction(ctx, func(tx pgx.Tx) error {
		var lock string
		if e := tx.QueryRow(ctx, "SELECT id FROM users WHERE id=$1 FOR UPDATE", u.ID).Scan(&lock); e != nil {
			return e
		}
		var count int
		tx.QueryRow(ctx, "SELECT count(*) FROM devices WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>$2", u.ID, a.Clock()).Scan(&count)
		if count >= 10 {
			return &Fault{409, "Отключите старое устройство."}
		}
		_, e := tx.Exec(ctx, "INSERT INTO devices VALUES($1,$2,$3,$4,$5,$6,NULL,NULL)", id, u.ID, name, digest(token), a.Clock(), expires)
		return e
	})
	return M{"id": id, "token": token, "expires_at": expires}, e
}
func (a *App) RevokeDevice(ctx context.Context, u User, id string) (M, error) {
	tag, e := a.DB.Exec(ctx, "UPDATE devices SET revoked_at=COALESCE(revoked_at,$1) WHERE id=$2 AND user_id=$3", a.Clock(), id, u.ID)
	if e == nil && tag.RowsAffected() == 0 {
		e = &Fault{404, "Устройство не найдено."}
	}
	return M{"ok": true}, e
}
func (a *App) ExtensionFeed(ctx context.Context, u User) (M, error) {
	items, e := objects(ctx, a.DB, `SELECT jsonb_build_object('id',n.id,'kind',n.kind,'study_id',n.study_id,'title',n.title,'body',n.body,'created_at',n.created_at) FROM notifications n JOIN devices d ON d.id=$1 AND d.user_id=n.user_id LEFT JOIN notification_deliveries nd ON nd.device_id=d.id AND nd.notification_id=n.id LEFT JOIN studies s ON s.id=n.study_id WHERE n.user_id=$2 AND n.created_at>=d.created_at AND n.read_at IS NULL AND nd.notification_id IS NULL AND (n.kind!='new_study' OR (s.status='open' AND NOT EXISTS(SELECT 1 FROM answers a WHERE a.study_id=s.id AND a.user_id=n.user_id))) ORDER BY n.created_at,n.id LIMIT 100`, u.DeviceID, u.ID)
	if e != nil {
		return nil, e
	}
	studies, e := a.Listing(ctx, u)
	if e != nil {
		return nil, e
	}
	available := []M{}
	for _, s := range studies {
		if str(s, "status") == "open" && s["my_answer"] == nil {
			available = append(available, M{"id": s["id"], "title": s["title"], "question": s["question"], "deadline": s["deadline"]})
		}
	}
	me, e := a.Me(ctx, u)
	delete(me, "csrf")
	return M{"user": me, "available": available, "notifications": items}, e
}
func (a *App) Ack(ctx context.Context, u User, ids []string) (M, error) {
	if u.DeviceID == "" || len(ids) > 100 {
		return nil, forbidden()
	}
	e := a.transaction(ctx, func(tx pgx.Tx) error {
		for _, id := range ids {
			_, e := tx.Exec(ctx, "INSERT INTO notification_deliveries SELECT id,$1,$2 FROM notifications WHERE id=$3 AND user_id=$4 ON CONFLICT DO NOTHING", u.DeviceID, a.Clock(), id, u.ID)
			if e != nil {
				return e
			}
		}
		return nil
	})
	return M{"ok": true}, e
}
func (a *App) TestNotification(ctx context.Context, u User) (M, error) {
	if u.Role != "participant" {
		return nil, forbidden()
	}
	e := a.transaction(ctx, func(tx pgx.Tx) error {
		return a.notify(ctx, tx, u.ID, "test", ID(), "Manyvo на связи", "Уведомления работают. Здесь появятся новые исследования, итоги и начисления.", nil)
	})
	return M{"ok": true}, e
}
func (a *App) Metrics(ctx context.Context, u User) (M, error) {
	if u.Role != "owner" {
		return nil, forbidden()
	}
	rows, e := a.DB.Query(ctx, "SELECT id FROM studies WHERE owner_id=$1 AND published_at IS NOT NULL ORDER BY created_at DESC", u.ID)
	if e != nil {
		return nil, e
	}
	ids := []string{}
	for rows.Next() {
		var id string
		rows.Scan(&id)
		ids = append(ids, id)
	}
	rows.Close()
	items := []M{}
	starts, pairs, matches, comparable, ties, missing := 0, 0, 0, 0, 0, 0
	for _, id := range ids {
		s, e := a.getStudy(ctx, a.DB, id, false)
		if e != nil {
			return nil, e
		}
		var opened, count int
		a.DB.QueryRow(ctx, "SELECT count(*) FROM events WHERE study_id=$1 AND type='opened'", id).Scan(&opened)
		a.DB.QueryRow(ctx, "SELECT count(*) FROM answers WHERE study_id=$1", id).Scan(&count)
		var fiftieth *float64
		a.DB.QueryRow(ctx, "SELECT accepted_at FROM answers WHERE study_id=$1 ORDER BY accepted_at,id OFFSET 49 LIMIT 1", id).Scan(&fiftieth)
		var t50 any
		if fiftieth != nil {
			t50 = *fiftieth - *s.Published
		}
		item := M{"id": id, "title": s.Title, "quota": s.Quota, "starts": opened, "pairs": count, "t50_seconds": t50}
		starts += opened
		pairs += count
		if s.Status == "closed" {
			comparison, e := a.comparison(ctx, a.DB, s)
			if e != nil {
				return nil, e
			}
			item["comparison"] = comparison["code"]
			switch comparison["code"] {
			case "match":
				matches++
				comparable++
			case "mismatch":
				comparable++
			case "tie":
				ties++
			default:
				missing++
			}
		}
		items = append(items, item)
	}
	var completion, agreement any
	if starts > 0 {
		completion = float64(pairs) * 100 / float64(starts)
	}
	if comparable > 0 {
		agreement = float64(matches) * 100 / float64(comparable)
	}
	return M{"studies": items, "starts": starts, "pairs": pairs, "completion_percent": completion, "agreement_percent": agreement, "comparable": comparable, "ties": ties, "missing": missing, "note": fmt.Sprintf("Демоэкономика: %d балл за прокрутку.", 1)}, nil
}
