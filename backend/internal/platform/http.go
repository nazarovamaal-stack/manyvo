package platform

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

func decode(r *http.Request, dest any) error {
	if strings.Split(r.Header.Get("Content-Type"), ";")[0] != "application/json" {
		return &Fault{415, "Ожидается JSON."}
	}
	d := json.NewDecoder(r.Body)
	if e := d.Decode(dest); e != nil {
		return &Fault{400, "Некорректные поля запроса."}
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return &Fault{400, "Некорректный JSON."}
	}
	return nil
}
func respond(w http.ResponseWriter, data any, e error) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if e != nil {
		status, message := 500, "Не удалось выполнить действие. Повторите попытку."
		var fault *Fault
		if errors.As(e, &fault) {
			status, message = fault.Status, fault.Message
		} else {
			log.Printf("request: %T %v", e, e)
		}
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(M{"error": message})
		return
	}
	json.NewEncoder(w).Encode(data)
}

type limiter struct {
	sync.Mutex
	entries map[string][]time.Time
}

func (a *App) Handler() http.Handler {
	limits := &limiter{entries: map[string][]time.Time{}}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if e := recover(); e != nil {
				log.Printf("panic: %T", e)
				respond(w, nil, errors.New("internal panic"))
			}
		}()
		r.Body = http.MaxBytesReader(w, r.Body, 37*1024*1024)
		ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
		defer cancel()
		path := r.URL.Path
		method := r.Method
		extension := strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") && r.Header.Get("X-Manyvo-Client") == "extension"
		mutate := method != "GET"
		if mutate {
			origin := r.Header.Get("Origin")
			if !extension && origin != "" && origin != a.Origin && origin != "http://127.0.0.1:3000" {
				respond(w, nil, &Fault{403, "Запрос с другого сайта запрещён."})
				return
			}
			if !extension && r.Header.Get("X-Manyvo-Client") != "web" {
				respond(w, nil, forbidden())
				return
			}
		}
		if path == "/api/health" && method == "GET" {
			db := a.DB.Ping(ctx)
			redis := a.Redis.Ping(ctx).Err()
			respond(w, M{"ok": db == nil && redis == nil}, nil)
			return
		}
		if path == "/api/config" && method == "GET" {
			accounts := []M{}
			if a.SeedDemo {
				accounts = DemoAccounts
			}
			respond(w, M{"demo": a.Demo, "demo_accounts": accounts, "moderation": "openai", "demo_economy": true}, nil)
			return
		}
		if (path == "/api/login" || path == "/api/register") && method == "POST" {
			limits.Lock()
			remote, _, _ := net.SplitHostPort(r.RemoteAddr)
			times := limits.entries[remote]
			kept := []time.Time{}
			for _, v := range times {
				if time.Since(v) < time.Minute {
					kept = append(kept, v)
				}
			}
			allowed := len(kept) < 30
			limits.entries[remote] = append(kept, time.Now())
			limits.Unlock()
			if !allowed {
				respond(w, nil, &Fault{429, "Слишком много попыток входа."})
				return
			}
			if path == "/api/register" {
				var registration Registration
				if e := decode(r, &registration); e != nil {
					respond(w, nil, e)
					return
				}
				if e := a.Register(ctx, registration); e != nil {
					respond(w, nil, e)
					return
				}
				token, csrf, e := a.Login(ctx, registration.Email, registration.Password)
				if e == nil {
					http.SetCookie(w, &http.Cookie{Name: "manyvo_session", Value: token, Path: "/", MaxAge: 86400, HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: strings.HasPrefix(a.Origin, "https://")})
				}
				respond(w, M{"csrf": csrf}, e)
				return
			}
			var input struct {
				Email    string `json:"email"`
				Password string `json:"password"`
			}
			if e := decode(r, &input); e != nil {
				respond(w, nil, e)
				return
			}
			token, csrf, e := a.Login(ctx, input.Email, input.Password)
			if e == nil {
				http.SetCookie(w, &http.Cookie{Name: "manyvo_session", Value: token, Path: "/", MaxAge: 86400, HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: strings.HasPrefix(a.Origin, "https://")})
			}
			respond(w, M{"csrf": csrf}, e)
			return
		}
		token := ""
		if extension {
			token = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		} else if c, e := r.Cookie("manyvo_session"); e == nil {
			token = c.Value
		}
		u, e := a.Auth(ctx, token, extension)
		if e != nil {
			respond(w, nil, e)
			return
		}
		if extension && (strings.HasPrefix(path, "/api/devices") || path == "/api/logout") {
			respond(w, nil, forbidden())
			return
		}
		if mutate && !extension && r.Header.Get("X-CSRF-Token") != u.CSRF {
			respond(w, nil, &Fault{403, "Обновите страницу и повторите действие."})
			return
		}
		var result any
		switch {
		case path == "/api/me" && method == "GET":
			result, e = a.Me(ctx, u)
		case path == "/api/logout" && method == "POST":
			_, e = a.DB.Exec(ctx, "DELETE FROM sessions WHERE token_hash=$1", digest(token))
			http.SetCookie(w, &http.Cookie{Name: "manyvo_session", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: strings.HasPrefix(a.Origin, "https://")})
			result = M{"ok": true}
		case path == "/api/studies" && method == "GET":
			var list []M
			list, e = a.Listing(ctx, u)
			result = M{"studies": list}
		case path == "/api/studies" && method == "POST":
			result, e = a.Create(ctx, u)
		case path == "/api/history" && method == "GET":
			var list []M
			list, e = a.History(ctx, u)
			result = M{"history": list}
		case path == "/api/metrics" && method == "GET":
			result, e = a.Metrics(ctx, u)
		case path == "/api/notifications" && method == "GET":
			result, e = a.Notifications(ctx, u)
		case path == "/api/notifications/read" && method == "POST":
			var p struct {
				IDs []string `json:"ids"`
			}
			e = decode(r, &p)
			if e == nil {
				result, e = a.ReadNotifications(ctx, u, p.IDs)
			}
		case path == "/api/notifications/test" && method == "POST":
			result, e = a.TestNotification(ctx, u)
		case path == "/api/devices" && method == "GET":
			result, e = a.Devices(ctx, u)
		case path == "/api/devices" && method == "POST":
			var p struct {
				Name string `json:"name"`
			}
			e = decode(r, &p)
			if e == nil {
				result, e = a.CreateDevice(ctx, u, p.Name)
			}
		case strings.HasPrefix(path, "/api/devices/") && method == "POST":
			result, e = a.RevokeDevice(ctx, u, strings.TrimPrefix(path, "/api/devices/"))
		case path == "/api/extension/feed" && method == "GET" && extension:
			result, e = a.ExtensionFeed(ctx, u)
		case path == "/api/extension/ack" && method == "POST" && extension:
			var p struct {
				IDs []string `json:"ids"`
			}
			e = decode(r, &p)
			if e == nil {
				result, e = a.Ack(ctx, u, p.IDs)
			}
		case path == "/api/rewards" && method == "GET":
			result, e = a.Rewards(ctx, u)
		case path == "/api/rewards" && method == "POST":
			var p RewardInput
			e = decode(r, &p)
			if e == nil {
				result, e = a.CreateReward(ctx, u, p)
			}
		case path == "/api/rewards/claims" && method == "GET":
			result, e = a.Claims(ctx, u)
		case path == "/api/rewards/spin" && method == "POST":
			var p struct {
				Key string `json:"request_key"`
			}
			e = decode(r, &p)
			if e == nil {
				result, e = a.Spend(ctx, u, p.Key, "", true)
			}
		case strings.HasPrefix(path, "/api/rewards/") && method == "POST":
			parts := strings.Split(strings.TrimPrefix(path, "/api/rewards/"), "/")
			if len(parts) != 2 {
				e = &Fault{404, "Маршрут не найден."}
				break
			}
			if parts[1] == "redeem" {
				var p struct {
					Key string `json:"request_key"`
				}
				e = decode(r, &p)
				if e == nil {
					result, e = a.Spend(ctx, u, p.Key, parts[0], false)
				}
			} else if parts[1] == "codes" {
				var p struct {
					Codes []string `json:"codes"`
				}
				e = decode(r, &p)
				if e == nil {
					result, e = a.AddCodes(ctx, u, parts[0], p.Codes)
				}
			} else if parts[1] == "status" {
				var p struct {
					Active bool `json:"active"`
				}
				e = decode(r, &p)
				if e == nil {
					result, e = a.RewardStatus(ctx, u, parts[0], p.Active)
				}
			} else {
				e = &Fault{404, "Маршрут не найден."}
			}
		case strings.HasPrefix(path, "/api/studies/"):
			parts := strings.Split(strings.TrimPrefix(path, "/api/studies/"), "/")
			id := parts[0]
			action := ""
			if len(parts) == 2 {
				action = parts[1]
			}
			switch {
			case action == "" && method == "GET":
				result, e = a.Detail(ctx, u, id, true)
			case action == "" && method == "PUT":
				var p Draft
				e = decode(r, &p)
				if e == nil {
					result, e = a.Save(ctx, u, id, p)
				}
			case action == "publish" && method == "POST":
				result, e = a.Publish(ctx, u, id)
			case action == "answer" && method == "POST":
				var p Answer
				e = decode(r, &p)
				if e == nil {
					result, e = a.Answer(ctx, u, id, p.Personal, p.Prediction)
				}
			case action == "fact" && method == "POST":
				var p Fact
				e = decode(r, &p)
				if e == nil {
					result, e = a.SaveFact(ctx, u, id, p)
				}
			default:
				e = &Fault{404, "Маршрут не найден."}
			}
		default:
			e = &Fault{404, "Маршрут не найден."}
		}
		respond(w, result, e)
	})
}
