package platform

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5/pgconn"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"net/http"
	"net/mail"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"golang.org/x/crypto/pbkdf2"
)

//go:embed schema.sql
var schema embed.FS

type M = map[string]any
type Fault struct {
	Status  int
	Message string
}

func (e *Fault) Error() string { return e.Message }
func check(ok bool, msg string) error {
	if !ok {
		return &Fault{400, msg}
	}
	return nil
}
func forbidden() error { return &Fault{403, "Нет доступа."} }
func ID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func Token() string {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func digest(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
func password(s, salt string) string {
	if salt == "" {
		salt = ID()
	}
	return salt + ":" + hex.EncodeToString(pbkdf2.Key([]byte(s), []byte(salt), 210000, 32, sha256.New))
}
func validPassword(s, encoded string) bool {
	salt, _, ok := strings.Cut(encoded, ":")
	return ok && subtle.ConstantTimeCompare([]byte(password(s, salt)), []byte(encoded)) == 1
}
func now() float64                   { return float64(time.Now().UnixMilli()) / 1000 }
func ptr[T any](v T) *T              { return &v }
func number(m M, key string) float64 { v, _ := m[key].(float64); return v }
func str(m M, key string) string     { v, _ := m[key].(string); return v }
func clean(s string, max int) error {
	return check(len([]rune(s)) <= max, fmt.Sprintf("Максимум %d символов.", max))
}

type User struct {
	ID       string  `json:"id"`
	Email    string  `json:"email"`
	Name     string  `json:"name"`
	Role     string  `json:"role"`
	Age      *int    `json:"age"`
	Country  *string `json:"country"`
	Password string  `json:"password_hash,omitempty"`
	CSRF     string  `json:"csrf,omitempty"`
	DeviceID string  `json:"device_id,omitempty"`
}
type Option struct {
	ID       string  `json:"id"`
	StudyID  string  `json:"study_id,omitempty"`
	Position int     `json:"position"`
	Text     string  `json:"text"`
	Image    *string `json:"image"`
}
type Study struct {
	ID        string   `json:"id"`
	OwnerID   string   `json:"owner_id"`
	Title     string   `json:"title"`
	Question  string   `json:"question"`
	Status    string   `json:"status"`
	Version   int      `json:"version"`
	Quota     *int     `json:"quota"`
	AgeMin    *int     `json:"age_min"`
	AgeMax    *int     `json:"age_max"`
	Country   string   `json:"country"`
	Created   float64  `json:"created_at"`
	Published *float64 `json:"published_at"`
	Deadline  *float64 `json:"deadline"`
	Closed    *float64 `json:"closed_at"`
	Reason    string   `json:"moderation_reason"`
	Provider  *string  `json:"moderation_provider"`
	Options   []Option `json:"options"`
}
type Answer struct {
	Personal   string  `json:"personal_id"`
	Prediction string  `json:"prediction_id"`
	Accepted   float64 `json:"accepted_at"`
}
type Count struct {
	ID       string  `json:"id"`
	Position int     `json:"position"`
	Text     string  `json:"text"`
	Count    int     `json:"count"`
	Percent  float64 `json:"percent"`
}

// Queries use a small interface shared by the pool and transactions.
type queryer interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}
type App struct {
	DB       *pgxpool.Pool
	Redis    *redis.Client
	Demo     bool
	SeedDemo bool
	APIKey   string
	Model    string
	Origin   string
	Clock    func() float64
	HTTP     *http.Client
	Draw     func(int) (int, error)
}

func New(ctx context.Context, dsn, redisURL string) (*App, error) {
	db, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, err
	}
	if err = db.Ping(ctx); err != nil {
		return nil, err
	}
	raw, _ := schema.ReadFile("schema.sql")
	if _, err = db.Exec(ctx, string(raw)); err != nil {
		return nil, err
	}
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, err
	}
	r := redis.NewClient(opts)
	if err = r.Ping(ctx).Err(); err != nil {
		return nil, err
	}
	a := &App{DB: db, Redis: r, Demo: os.Getenv("DEMO_MODE") == "true", SeedDemo: os.Getenv("SEED_DEMO") == "true", APIKey: os.Getenv("OPENAI_API_KEY"), Model: os.Getenv("OPENAI_MODERATION_MODEL"), Origin: os.Getenv("APP_ORIGIN"), Clock: now, HTTP: &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }}}
	if a.Model == "" {
		a.Model = "omni-moderation-latest"
	}
	if a.Origin == "" {
		a.Origin = "http://localhost:3000"
	}
	return a, nil
}
func object(ctx context.Context, q queryer, sql string, args []any, dest any) error {
	var raw []byte
	if err := q.QueryRow(ctx, sql, args...).Scan(&raw); err != nil {
		return err
	}
	return json.Unmarshal(raw, dest)
}
func objects(ctx context.Context, q queryer, sql string, args ...any) ([]M, error) {
	rows, e := q.Query(ctx, sql, args...)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []M{}
	for rows.Next() {
		var raw []byte
		if e = rows.Scan(&raw); e != nil {
			return nil, e
		}
		var m M
		if e = json.Unmarshal(raw, &m); e != nil {
			return nil, e
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
func (a *App) getStudy(ctx context.Context, q queryer, id string, lock bool) (Study, error) {
	var s Study
	sql := "SELECT to_jsonb(s) FROM studies s WHERE id=$1"
	if lock {
		sql += " FOR UPDATE"
	}
	e := object(ctx, q, sql, []any{id}, &s)
	if errors.Is(e, pgx.ErrNoRows) {
		e = &Fault{404, "Исследование не найдено."}
	}
	if e != nil {
		return s, e
	}
	raw, e := objects(ctx, q, "SELECT to_jsonb(o) FROM options o WHERE study_id=$1 ORDER BY position", id)
	if e != nil {
		return s, e
	}
	b, _ := json.Marshal(raw)
	e = json.Unmarshal(b, &s.Options)
	return s, e
}
func eligible(u User, s Study) bool {
	return u.Role == "participant" && u.ID != s.OwnerID && u.Age != nil && *u.Age >= 18 && u.Country != nil && *u.Country == s.Country && s.AgeMin != nil && s.AgeMax != nil && *u.Age >= *s.AgeMin && *u.Age <= *s.AgeMax
}
func owns(u User, s Study) error {
	if u.Role != "owner" || u.ID != s.OwnerID {
		return forbidden()
	}
	return nil
}
func (a *App) transaction(ctx context.Context, f func(pgx.Tx) error) error {
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if e = f(tx); e != nil {
		return e
	}
	return tx.Commit(ctx)
}
func (a *App) balance(ctx context.Context, q queryer, userID string) (int, error) {
	var n int
	e := q.QueryRow(ctx, "SELECT COALESCE(SUM(amount),0) FROM ledger WHERE user_id=$1", userID).Scan(&n)
	return n, e
}
func (a *App) Me(ctx context.Context, u User) (M, error) {
	n, e := a.balance(ctx, a.DB, u.ID)
	return M{"id": u.ID, "email": u.Email, "name": u.Name, "role": u.Role, "age": u.Age, "country": u.Country, "balance": n, "csrf": u.CSRF}, e
}
func (a *App) notify(ctx context.Context, tx pgx.Tx, user, kind, ref, title, body string, study any) error {
	_, e := tx.Exec(ctx, "INSERT INTO notifications VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL) ON CONFLICT(user_id,kind,reference) DO NOTHING", ID(), user, kind, ref, study, title, body, a.Clock())
	return e
}
func (a *App) event(ctx context.Context, tx pgx.Tx, kind, study, user string, version any) error {
	var anonymous any
	if user != "" {
		anonymous = digest("manyvo:" + user)
	}
	_, e := tx.Exec(ctx, "INSERT INTO events VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", ID(), kind, study, anonymous, a.Clock(), version)
	return e
}
func (a *App) award(ctx context.Context, tx pgx.Tx, study, user, kind string) error {
	tag, e := tx.Exec(ctx, "INSERT INTO ledger VALUES($1,$2,$3,$4,1,NULL,$5) ON CONFLICT DO NOTHING", ID(), user, study, kind, a.Clock())
	if e == nil && tag.RowsAffected() > 0 {
		return a.notify(ctx, tx, user, "points_"+kind, study, "Начислен балл", map[string]string{"base": "+1 за два принятых ответа.", "bonus": "+1 за верный прогноз большинства."}[kind], study)
	}
	return e
}
func validateImage(s *string) error {
	if s == nil || *s == "" {
		return nil
	}
	prefix, data, ok := strings.Cut(*s, ",")
	if !ok || !(prefix == "data:image/png;base64" || prefix == "data:image/jpeg;base64") {
		return &Fault{400, "Разрешены PNG и JPEG."}
	}
	if len(data) > 7*1024*1024 {
		return &Fault{400, "Изображение больше 5 МБ."}
	}
	raw, e := base64.StdEncoding.DecodeString(data)
	if e != nil || len(raw) > 5*1024*1024 {
		return &Fault{400, "Неверное изображение или размер."}
	}
	config, format, e := image.DecodeConfig(strings.NewReader(string(raw)))
	if e != nil || config.Width < 1 || config.Height < 1 || config.Width > 16000 || config.Height > 16000 || !(format == "png" && strings.Contains(prefix, "png") || format == "jpeg" && strings.Contains(prefix, "jpeg")) {
		return &Fault{400, "Повреждённое изображение."}
	}
	return nil
}
func (a *App) Login(ctx context.Context, email, pass string) (string, string, error) {
	var u User
	e := object(ctx, a.DB, "SELECT to_jsonb(u) FROM users u WHERE lower(email)=$1", []any{strings.ToLower(strings.TrimSpace(email))}, &u)
	if e != nil || !validPassword(pass, u.Password) {
		return "", "", &Fault{401, "Неверная почта или пароль."}
	}
	token, csrf := Token(), Token()
	_, e = a.DB.Exec(ctx, "INSERT INTO sessions VALUES($1,$2,$3,$4)", digest(token), u.ID, csrf, a.Clock()+86400)
	return token, csrf, e
}
func (a *App) Auth(ctx context.Context, token string, device bool) (User, error) {
	var u User
	var e error
	if device {
		e = object(ctx, a.DB, "SELECT to_jsonb(u)||jsonb_build_object('device_id',d.id) FROM users u JOIN devices d ON d.user_id=u.id WHERE d.token_hash=$1 AND d.revoked_at IS NULL AND d.expires_at>$2", []any{digest(token), a.Clock()}, &u)
		if e == nil {
			_, e = a.DB.Exec(ctx, "UPDATE devices SET last_seen=$1 WHERE id=$2", a.Clock(), u.DeviceID)
		}
	} else {
		e = object(ctx, a.DB, "SELECT to_jsonb(u)||jsonb_build_object('csrf',s.csrf) FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>$2", []any{digest(token), a.Clock()}, &u)
	}
	if e == nil && device && u.Role != "participant" {
		return u, forbidden()
	}
	if errors.Is(e, pgx.ErrNoRows) {
		e = &Fault{401, "Войдите в аккаунт или подключите расширение заново."}
	}
	return u, e
}
func integerEnv(key string, fallback int) int {
	n, e := strconv.Atoi(os.Getenv(key))
	if e != nil {
		return fallback
	}
	return n
}

type Registration struct {
	Name     string `json:"name"`
	Email    string `json:"email"`
	Password string `json:"password"`
	Role     string `json:"role"`
	Age      int    `json:"age"`
	Country  string `json:"country"`
}

func (a *App) Register(ctx context.Context, r Registration) error {
	r.Name = strings.TrimSpace(r.Name)
	r.Email = strings.ToLower(strings.TrimSpace(r.Email))
	r.Country = strings.TrimSpace(r.Country)
	if r.Name == "" || clean(r.Name, 80) != nil || r.Country == "" || clean(r.Country, 80) != nil || r.Age < 18 || r.Age > 120 || len(r.Password) < 10 || len(r.Password) > 128 || !(r.Role == "owner" || r.Role == "participant") {
		return &Fault{400, "Заполните профиль. Возраст от 18 лет, пароль от 10 до 128 символов."}
	}
	addr, e := mail.ParseAddress(r.Email)
	if e != nil || addr.Address != r.Email || len(r.Email) > 254 {
		return &Fault{400, "Укажите корректную почту."}
	}
	_, e = a.DB.Exec(ctx, "INSERT INTO users VALUES($1,$2,$3,$4,$5,$6,$7)", ID(), r.Email, r.Name, r.Role, r.Age, r.Country, password(r.Password, ""))
	var pe *pgconn.PgError
	if errors.As(e, &pe) && pe.Code == "23505" {
		return &Fault{409, "Аккаунт с этой почтой уже существует. Войдите в него."}
	}
	return e
}
