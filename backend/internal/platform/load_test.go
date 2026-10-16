package platform

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestLoadProfile(t *testing.T) {
	if os.Getenv("RUN_LOAD_TEST") != "true" {
		t.Skip("explicit 10 minute load profile")
	}
	f := setup(t)
	duration := time.Duration(integerEnv("LOAD_SECONDS", 600)) * time.Second
	const users = 100
	server := httptest.NewServer(f.a.Handler())
	defer server.Close()
	type loadClient struct {
		u           User
		token, csrf string
	}
	clients := []loadClient{}
	encoded := password("load-test-password", "")
	for i := 0; i < users; i++ {
		u := User{ID: ID(), Email: fmt.Sprintf("load%d@test.local", i), Name: "Load", Role: "participant", Age: ptr(25), Country: ptr("Россия")}
		_, e := f.a.DB.Exec(f.ctx, "INSERT INTO users VALUES($1,$2,$3,$4,$5,$6,$7)", u.ID, u.Email, u.Name, u.Role, u.Age, u.Country, encoded)
		must(t, e)
		token, csrf := Token(), Token()
		_, e = f.a.DB.Exec(f.ctx, "INSERT INTO sessions VALUES($1,$2,$3,$4)", digest(token), u.ID, csrf, f.a.Clock()+86400)
		must(t, e)
		clients = append(clients, loadClient{u, token, csrf})
	}
	httpClient := &http.Client{Timeout: 20 * time.Second, Transport: &http.Transport{MaxIdleConns: 200, MaxIdleConnsPerHost: 200}}
	defer httpClient.CloseIdleConnections()
	samples := map[string][]float64{"get": {}, "answer": {}}
	failures := 0
	var mu sync.Mutex
	rounds := 0
	start := time.Now()
	for time.Since(start) < duration {
		s := f.opened(users, 2)
		var wg sync.WaitGroup
		barrier := make(chan struct{})
		for _, client := range clients {
			wg.Add(1)
			go func(c loadClient) {
				defer wg.Done()
				<-barrier
				for _, kind := range []string{"get", "answer"} {
					method, path, body := "GET", server.URL+"/api/studies/"+s.ID, ""
					if kind == "answer" {
						method = "POST"
						path += "/answer"
						body = fmt.Sprintf(`{"personal_id":%q,"prediction_id":%q}`, s.Options[0].ID, s.Options[0].ID)
					}
					req, _ := http.NewRequest(method, path, strings.NewReader(body))
					req.Header.Set("Cookie", "manyvo_session="+c.token)
					req.Header.Set("X-Manyvo-Client", "web")
					req.Header.Set("X-CSRF-Token", c.csrf)
					req.Header.Set("Content-Type", "application/json")
					before := time.Now()
					response, e := httpClient.Do(req)
					code := 0
					if e == nil {
						code = response.StatusCode
						io.Copy(io.Discard, response.Body)
						response.Body.Close()
					}
					elapsed := time.Since(before).Seconds()
					mu.Lock()
					samples[kind] = append(samples[kind], elapsed)
					if code != 200 {
						failures++
					}
					mu.Unlock()
				}
			}(client)
		}
		close(barrier)
		wg.Wait()
		rounds++
		if failures > 0 {
			t.Fatalf("load: %d requests failed", failures)
		}
		if rounds%25 == 0 {
			t.Logf("%ds, %d waves, %d requests", int(time.Since(start).Seconds()), rounds, rounds*users*2)
		}
	}
	operations := M{}
	passed := true
	for kind, values := range samples {
		sort.Float64s(values)
		p95 := values[(len(values)*95+99)/100-1]
		operations[kind] = M{"requests": len(values), "p95_seconds": p95, "max_seconds": values[len(values)-1]}
		if p95 > 2 {
			passed = false
		}
	}
	report := M{"stack": "Go / PostgreSQL / Redis", "profile": "100 authenticated users per wave, text options, GET and one new pair per user. Moderation excluded.", "users": users, "requested_duration_seconds": duration.Seconds(), "elapsed_seconds": time.Since(start).Seconds(), "rounds": rounds, "operations": operations, "non_200": failures, "passed": passed, "full_tc13_profile": duration >= 600*time.Second}
	raw, _ := json.MarshalIndent(report, "", "  ")
	t.Log(string(raw))
	if filename := os.Getenv("LOAD_REPORT"); filename != "" {
		must(t, os.WriteFile(filename, append(raw, '\n'), 0644))
	}
	if !passed {
		t.Fatal("p95 exceeds 2 seconds")
	}
	must(t, f.a.DB.Ping(context.Background()))
}
