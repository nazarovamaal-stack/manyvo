package platform

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"math"
	"time"
)

type Draft struct {
	Title    string   `json:"title"`
	Question string   `json:"question"`
	Version  int      `json:"version"`
	Quota    *int     `json:"quota"`
	AgeMin   *int     `json:"age_min"`
	AgeMax   *int     `json:"age_max"`
	Country  string   `json:"country"`
	Options  []Option `json:"options"`
}

func (a *App) Create(ctx context.Context, u User) (M, error) {
	if u.Role != "owner" {
		return nil, forbidden()
	}
	id := ID()
	_, e := a.DB.Exec(ctx, "INSERT INTO studies(id,owner_id,created_at) VALUES($1,$2,$3)", id, u.ID, a.Clock())
	if e != nil {
		return nil, e
	}
	return a.Detail(ctx, u, id, false)
}
func (a *App) Save(ctx context.Context, u User, id string, d Draft) (M, error) {
	for _, x := range []struct {
		s string
		n int
	}{{d.Title, 120}, {d.Question, 500}, {d.Country, 80}} {
		if e := clean(x.s, x.n); e != nil {
			return nil, e
		}
	}
	if len(d.Options) > 5 {
		return nil, &Fault{400, "Максимум 5 вариантов."}
	}
	if d.Quota != nil && (*d.Quota < 2 || *d.Quota > 500) {
		return nil, &Fault{400, "Квота — целое число от 2 до 500."}
	}
	for _, v := range []*int{d.AgeMin, d.AgeMax} {
		if v != nil && (*v < 18 || *v > 120) {
			return nil, &Fault{400, "Возраст от 18 до 120 лет."}
		}
	}
	if d.AgeMin != nil && d.AgeMax != nil && *d.AgeMin > *d.AgeMax {
		return nil, &Fault{400, "Проверьте диапазон возраста."}
	}
	for _, o := range d.Options {
		if e := clean(o.Text, 500); e != nil {
			return nil, e
		}
		if e := validateImage(o.Image); e != nil {
			return nil, e
		}
	}
	e := a.transaction(ctx, func(tx pgx.Tx) error {
		s, e := a.getStudy(ctx, tx, id, true)
		if e != nil {
			return e
		}
		if e = owns(u, s); e != nil {
			return e
		}
		if s.Status != "draft" || s.Version != d.Version {
			return &Fault{409, "Черновик изменён или уже отправлен. Обновите страницу."}
		}
		_, e = tx.Exec(ctx, "UPDATE studies SET title=$1,question=$2,quota=$3,age_min=$4,age_max=$5,country=$6,version=version+1,moderation_reason='' WHERE id=$7", d.Title, d.Question, d.Quota, d.AgeMin, d.AgeMax, d.Country, id)
		if e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, "DELETE FROM options WHERE study_id=$1", id); e != nil {
			return e
		}
		for i, o := range d.Options {
			if _, e = tx.Exec(ctx, "INSERT INTO options VALUES($1,$2,$3,$4,$5)", ID(), id, i, o.Text, o.Image); e != nil {
				return e
			}
		}
		return nil
	})
	if e != nil {
		return nil, e
	}
	return a.Detail(ctx, u, id, false)
}
func (a *App) Publish(ctx context.Context, u User, id string) (M, error) {
	e := a.transaction(ctx, func(tx pgx.Tx) error {
		s, e := a.getStudy(ctx, tx, id, true)
		if e != nil {
			return e
		}
		if e = owns(u, s); e != nil {
			return e
		}
		if s.Status != "draft" {
			return &Fault{409, "Опубликовать можно только черновик."}
		}
		if s.Title == "" || s.Question == "" || s.Country == "" || s.AgeMin == nil || s.AgeMax == nil || len(s.Options) < 2 || len(s.Options) > 5 {
			return &Fault{400, "Заполните вопрос, 2–5 вариантов и аудиторию."}
		}
		for _, o := range s.Options {
			if o.Text == "" && (o.Image == nil || *o.Image == "") {
				return &Fault{400, "Заполните каждый вариант."}
			}
		}
		if _, e = tx.Exec(ctx, "UPDATE studies SET status='moderating',version=version+1,moderation_reason='' WHERE id=$1", id); e != nil {
			return e
		}
		_, e = tx.Exec(ctx, "INSERT INTO moderation_jobs(id,study_id,version,created_at) VALUES($1,$2,$3,$4)", ID(), id, s.Version+1, a.Clock())
		return e
	})
	if e != nil {
		return nil, e
	}
	return a.Detail(ctx, u, id, false)
}
func distributions(ctx context.Context, q queryer, s Study, column string) ([]Count, []string, error) {
	if column != "personal_id" && column != "prediction_id" {
		panic("invalid distribution")
	}
	rows, e := q.Query(ctx, "SELECT "+column+",count(*) FROM answers WHERE study_id=$1 GROUP BY "+column, s.ID)
	if e != nil {
		return nil, nil, e
	}
	defer rows.Close()
	counts := map[string]int{}
	total, max := 0, 0
	for rows.Next() {
		var id string
		var n int
		if e = rows.Scan(&id, &n); e != nil {
			return nil, nil, e
		}
		counts[id] = n
		total += n
		if n > max {
			max = n
		}
	}
	out := []Count{}
	leaders := []string{}
	if total == 0 {
		return out, leaders, nil
	}
	for _, o := range s.Options {
		n := counts[o.ID]
		out = append(out, Count{o.ID, o.Position, o.Text, n, math.Round(1000*float64(n)/float64(total)) / 10})
		if n == max {
			leaders = append(leaders, o.ID)
		}
	}
	return out, leaders, rows.Err()
}
func (a *App) closeStudy(ctx context.Context, tx pgx.Tx, s Study) error {
	if s.Status != "open" {
		return nil
	}
	var count int
	if e := tx.QueryRow(ctx, "SELECT count(*) FROM answers WHERE study_id=$1", s.ID).Scan(&count); e != nil {
		return e
	}
	if count < *s.Quota && a.Clock() < *s.Deadline {
		return nil
	}
	reason := "deadline"
	if count >= *s.Quota {
		reason = "quota"
	}
	if _, e := tx.Exec(ctx, "UPDATE studies SET status='closed',closed_at=$1,closure_reason=$2 WHERE id=$3", a.Clock(), reason, s.ID); e != nil {
		return e
	}
	_, leaders, e := distributions(ctx, tx, s, "personal_id")
	if e != nil {
		return e
	}
	rows, e := objects(ctx, tx, "SELECT jsonb_build_object('user_id',user_id,'prediction_id',prediction_id) FROM answers WHERE study_id=$1", s.ID)
	if e != nil {
		return e
	}
	for _, row := range rows {
		winner := false
		for _, l := range leaders {
			if l == str(row, "prediction_id") {
				winner = true
			}
		}
		if winner {
			if e = a.award(ctx, tx, s.ID, str(row, "user_id"), "bonus"); e != nil {
				return e
			}
		}
		var points int
		if e = tx.QueryRow(ctx, "SELECT COALESCE(sum(amount),0) FROM ledger WHERE user_id=$1 AND study_id=$2", str(row, "user_id"), s.ID).Scan(&points); e != nil {
			return e
		}
		if e = a.notify(ctx, tx, str(row, "user_id"), "study_closed", s.ID, "Исследование завершено", fmt.Sprintf("%s. Начислено за участие и прогноз: %d.", s.Title, points), s.ID); e != nil {
			return e
		}
	}
	return a.event(ctx, tx, "closed", s.ID, "", nil)
}
func (a *App) Settle(ctx context.Context) error {
	return a.transaction(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx, "SELECT id FROM studies WHERE status='open' AND deadline<=$1 ORDER BY id FOR UPDATE SKIP LOCKED", a.Clock())
		if e != nil {
			return e
		}
		ids := []string{}
		for rows.Next() {
			var id string
			if e = rows.Scan(&id); e != nil {
				rows.Close()
				return e
			}
			ids = append(ids, id)
		}
		rows.Close()
		for _, id := range ids {
			s, e := a.getStudy(ctx, tx, id, false)
			if e != nil {
				return e
			}
			if e = a.closeStudy(ctx, tx, s); e != nil {
				return e
			}
		}
		return nil
	})
}
func (a *App) Answer(ctx context.Context, u User, id, personal, prediction string) (M, error) {
	if u.Role != "participant" {
		return nil, forbidden()
	}
	e := a.transaction(ctx, func(tx pgx.Tx) error {
		s, e := a.getStudy(ctx, tx, id, true)
		if e != nil {
			return e
		}
		if !eligible(u, s) {
			return forbidden()
		}
		var previous string
		e = tx.QueryRow(ctx, "SELECT id FROM answers WHERE study_id=$1 AND user_id=$2", id, u.ID).Scan(&previous)
		if e == nil {
			return nil
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		if s.Status != "open" || a.Clock() >= *s.Deadline {
			return &Fault{409, "Сбор ответов завершён."}
		}
		var n int
		if e = tx.QueryRow(ctx, "SELECT count(*) FROM answers WHERE study_id=$1", id).Scan(&n); e != nil {
			return e
		}
		if n >= *s.Quota {
			return &Fault{409, "Квота набрана."}
		}
		valid := map[string]bool{}
		for _, o := range s.Options {
			valid[o.ID] = true
		}
		if !valid[personal] || !valid[prediction] {
			return &Fault{400, "Нужны личный выбор и прогноз из этого исследования."}
		}
		accepted := a.Clock()
		if accepted >= *s.Deadline {
			return &Fault{409, "Сбор ответов завершён."}
		}
		if _, e = tx.Exec(ctx, "INSERT INTO answers VALUES($1,$2,$3,$4,$5,$6)", ID(), id, u.ID, personal, prediction, accepted); e != nil {
			return e
		}
		if e = a.award(ctx, tx, id, u.ID, "base"); e != nil {
			return e
		}
		if e = a.event(ctx, tx, "opened", id, u.ID, nil); e != nil {
			return e
		}
		if e = a.event(ctx, tx, "answered", id, u.ID, nil); e != nil {
			return e
		}
		return a.closeStudy(ctx, tx, s)
	})
	if e != nil {
		return nil, e
	}
	return a.Detail(ctx, u, id, false)
}
func (a *App) Detail(ctx context.Context, u User, id string, opened bool) (M, error) {
	if e := a.Settle(ctx); e != nil {
		return nil, e
	}
	s, e := a.getStudy(ctx, a.DB, id, false)
	if e != nil {
		return nil, e
	}
	owner := owns(u, s) == nil
	var answer Answer
	ae := object(ctx, a.DB, "SELECT jsonb_build_object('personal_id',personal_id,'prediction_id',prediction_id,'accepted_at',accepted_at) FROM answers WHERE study_id=$1 AND user_id=$2", []any{id, u.ID}, &answer)
	answered := ae == nil
	if ae != nil && !errors.Is(ae, pgx.ErrNoRows) {
		return nil, ae
	}
	if !owner && (!(s.Status == "open" || s.Status == "closed") || (!answered && !eligible(u, s))) {
		return nil, forbidden()
	}
	if opened && !owner && s.Status == "open" {
		if e = a.transaction(ctx, func(tx pgx.Tx) error { return a.event(ctx, tx, "opened", id, u.ID, nil) }); e != nil {
			return nil, e
		}
	}
	raw, _ := json.Marshal(s)
	out := M{}
	json.Unmarshal(raw, &out)
	delete(out, "owner_id")
	delete(out, "moderation_reason")
	delete(out, "moderation_provider")
	out["my_answer"] = nil
	if answered {
		out["my_answer"] = answer
	}
	if owner {
		out["moderation_reason"] = s.Reason
		out["moderation_provider"] = s.Provider
		var n int
		if e = a.DB.QueryRow(ctx, "SELECT count(*) FROM answers WHERE study_id=$1", id).Scan(&n); e != nil {
			return nil, e
		}
		out["count"] = n
		if s.Status == "closed" {
			out["complete"] = n == *s.Quota
			var err error
			out["personal"], out["personal_leaders"], err = distributions(ctx, a.DB, s, "personal_id")
			if err != nil {
				return nil, err
			}
			out["predictions"], out["prediction_leaders"], err = distributions(ctx, a.DB, s, "prediction_id")
			if err != nil {
				return nil, err
			}
			out["comparison"], err = a.comparison(ctx, a.DB, s)
			if err != nil {
				return nil, err
			}
		}
	} else if answered {
		points := M{}
		rows, err := a.DB.Query(ctx, "SELECT kind,amount FROM ledger WHERE study_id=$1 AND user_id=$2", id, u.ID)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var kind string
			var amount int
			rows.Scan(&kind, &amount)
			points[kind] = amount
		}
		rows.Close()
		out["points"] = points
		if s.Status == "closed" {
			_, leaders, err := distributions(ctx, a.DB, s, "personal_id")
			if err != nil {
				return nil, err
			}
			out["personal_leaders"] = leaders
			var n int
			a.DB.QueryRow(ctx, "SELECT count(*) FROM answers WHERE study_id=$1", id).Scan(&n)
			out["complete"] = n == *s.Quota
		}
	}
	return out, nil
}
func (a *App) Listing(ctx context.Context, u User) ([]M, error) {
	if e := a.Settle(ctx); e != nil {
		return nil, e
	}
	query := "SELECT id FROM studies WHERE owner_id=$1 ORDER BY created_at DESC"
	args := []any{u.ID}
	if u.Role == "participant" {
		query = "SELECT s.id FROM studies s WHERE (s.status='open' AND s.country=$2 AND s.age_min<=$3 AND s.age_max>=$3 AND $3>=18) OR EXISTS(SELECT 1 FROM answers a WHERE a.study_id=s.id AND a.user_id=$1) ORDER BY s.created_at DESC"
		args = append(args, u.Country, u.Age)
	}
	rows, e := a.DB.Query(ctx, query, args...)
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
	out := []M{}
	for _, id := range ids {
		v, e := a.Detail(ctx, u, id, false)
		if e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	return out, nil
}

type FactValue struct {
	OptionID    string   `json:"option_id"`
	Value       float64  `json:"value"`
	Denominator *float64 `json:"denominator"`
}
type Fact struct {
	Version int         `json:"version"`
	Metric  string      `json:"metric"`
	Unit    string      `json:"unit"`
	Start   string      `json:"start_date"`
	End     string      `json:"end_date"`
	Rate    bool        `json:"is_rate"`
	Values  []FactValue `json:"values"`
}

func (a *App) SaveFact(ctx context.Context, u User, id string, f Fact) (M, error) {
	if f.Metric == "" || f.Unit == "" {
		return nil, &Fault{400, "Укажите метрику и единицу."}
	}
	if e := clean(f.Metric, 120); e != nil {
		return nil, e
	}
	if e := clean(f.Unit, 40); e != nil {
		return nil, e
	}
	start, e1 := time.Parse("2006-01-02", f.Start)
	end, e2 := time.Parse("2006-01-02", f.End)
	if e1 != nil || e2 != nil || start.After(end) {
		return nil, &Fault{400, "Проверьте период."}
	}
	e := a.transaction(ctx, func(tx pgx.Tx) error {
		s, e := a.getStudy(ctx, tx, id, true)
		if e != nil {
			return e
		}
		if e = owns(u, s); e != nil {
			return e
		}
		if s.Status != "closed" {
			return &Fault{409, "Факт доступен после закрытия."}
		}
		valid := map[string]bool{}
		for _, o := range s.Options {
			valid[o.ID] = true
		}
		if len(f.Values) != len(s.Options) {
			return &Fault{400, "Нужны значения всех вариантов."}
		}
		for _, v := range f.Values {
			if !valid[v.OptionID] || math.IsNaN(v.Value) || math.IsInf(v.Value, 0) || v.Value < 0 || (f.Rate && (v.Denominator == nil || *v.Denominator <= 0 || math.IsNaN(*v.Denominator) || math.IsInf(*v.Denominator, 0))) {
				return &Fault{400, "Проверьте значения и знаменатели."}
			}
			delete(valid, v.OptionID)
		}
		var version int
		if e = tx.QueryRow(ctx, "SELECT COALESCE(max(version),0)+1 FROM facts WHERE study_id=$1", id).Scan(&version); e != nil {
			return e
		}
		raw, _ := json.Marshal(f.Values)
		if _, e = tx.Exec(ctx, "INSERT INTO facts VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", id, version, f.Metric, f.Unit, f.Start, f.End, f.Rate, raw, a.Clock()); e != nil {
			return e
		}
		return a.event(ctx, tx, "fact_saved", id, "", version)
	})
	if e != nil {
		return nil, e
	}
	return a.Detail(ctx, u, id, false)
}
func (a *App) comparison(ctx context.Context, q queryer, s Study) (M, error) {
	_, pred, e := distributions(ctx, q, s, "prediction_id")
	if e != nil {
		return nil, e
	}
	var f Fact
	e = object(ctx, q, "SELECT jsonb_build_object('version',version,'metric',metric,'unit',unit,'start_date',start_date,'end_date',end_date,'is_rate',is_rate,'values',values_json) FROM facts WHERE study_id=$1 ORDER BY version DESC LIMIT 1", []any{s.ID}, &f)
	hasFact := e == nil
	if e != nil && !errors.Is(e, pgx.ErrNoRows) {
		return nil, e
	}
	actual := []string{}
	if hasFact {
		max := -1.0
		for _, v := range f.Values {
			if v.Value > max {
				max = v.Value
				actual = []string{v.OptionID}
			} else if v.Value == max {
				actual = append(actual, v.OptionID)
			}
		}
	}
	code, label := "no_fact", "Нет данных"
	if len(pred) == 0 {
		code, label = "empty", "Нет ответов — сверка невозможна"
	} else if hasFact {
		if len(actual) != 1 || len(pred) != 1 {
			code, label = "tie", "Ничья, однозначная сверка невозможна"
		} else if actual[0] == pred[0] {
			code, label = "match", "Совпало"
		} else {
			code, label = "mismatch", "Не совпало"
		}
	}
	var fact any
	if hasFact {
		fact = f
	}
	return M{"code": code, "label": label, "fact": fact, "predicted_leaders": pred, "actual_leaders": actual}, nil
}
func (a *App) History(ctx context.Context, u User) ([]M, error) {
	return objects(ctx, a.DB, "SELECT jsonb_build_object('kind',l.kind,'amount',l.amount,'created_at',l.created_at,'title',COALESCE(s.title,CASE l.kind WHEN 'spin' THEN 'Колесо призов' ELSE 'Гарантированная награда' END),'study_id',l.study_id) FROM ledger l LEFT JOIN studies s ON s.id=l.study_id WHERE l.user_id=$1 ORDER BY l.created_at DESC", u.ID)
}
