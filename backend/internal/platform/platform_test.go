package platform

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
)

type fixture struct {
	a   *App
	u   User
	p   []User
	ctx context.Context
	t   *testing.T
}

func setup(t *testing.T) *fixture {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL required for isolated PostgreSQL integration tests")
	}
	ctx := context.Background()
	admin, e := pgxpool.New(ctx, dsn)
	if e != nil {
		t.Fatal(e)
	}
	schemaName := "test_" + ID()
	if _, e = admin.Exec(ctx, "CREATE SCHEMA "+schemaName); e != nil {
		t.Fatal(e)
	}
	parsed, _ := url.Parse(dsn)
	query := parsed.Query()
	query.Set("search_path", schemaName)
	parsed.RawQuery = query.Encode()
	redisURL := os.Getenv("TEST_REDIS_URL")
	if redisURL == "" {
		redisURL = "redis://127.0.0.1:63799/15"
	}
	a, e := New(ctx, parsed.String(), redisURL)
	if e != nil {
		t.Fatal(e)
	}
	a.Demo = true
	a.SeedDemo = false
	a.APIKey = "test-key"
	t.Cleanup(func() {
		a.DB.Close()
		a.Redis.Close()
		admin.Exec(ctx, "DROP SCHEMA "+schemaName+" CASCADE")
		admin.Close()
	})
	f := &fixture{a: a, ctx: ctx, t: t}
	encoded := password("test-password", "")
	for i, role := range []string{"owner", "participant", "participant", "participant", "participant", "participant", "owner"} {
		u := User{ID: ID(), Email: fmt.Sprintf("u%d@test.local", i), Name: fmt.Sprintf("User %d", i), Role: role, Age: ptr(25), Country: ptr("Россия")}
		_, e = a.DB.Exec(ctx, "INSERT INTO users VALUES($1,$2,$3,$4,$5,$6,$7)", u.ID, u.Email, u.Name, role, u.Age, u.Country, encoded)
		if e != nil {
			t.Fatal(e)
		}
		if i == 0 {
			f.u = u
		} else {
			f.p = append(f.p, u)
		}
	}
	return f
}
func (f *fixture) draft(quota int, variants int) Study {
	f.t.Helper()
	m, e := f.a.Create(f.ctx, f.u)
	if e != nil {
		f.t.Fatal(e)
	}
	options := []Option{}
	for i := 0; i < variants; i++ {
		options = append(options, Option{Text: fmt.Sprintf("Variant %d", i)})
	}
	_, e = f.a.Save(f.ctx, f.u, str(m, "id"), Draft{Title: "Title", Question: "Question", Version: 1, Quota: ptr(quota), AgeMin: ptr(18), AgeMax: ptr(65), Country: "Россия", Options: options})
	if e != nil {
		f.t.Fatal(e)
	}
	s, e := f.a.getStudy(f.ctx, f.a.DB, str(m, "id"), false)
	if e != nil {
		f.t.Fatal(e)
	}
	return s
}
func (f *fixture) opened(quota int, variants int) Study {
	s := f.draft(quota, variants)
	_, e := f.a.Publish(f.ctx, f.u, s.ID)
	if e != nil {
		f.t.Fatal(e)
	}
	var job string
	if e = f.a.DB.QueryRow(f.ctx, "SELECT id FROM moderation_jobs WHERE study_id=$1", s.ID).Scan(&job); e != nil {
		f.t.Fatal(e)
	}
	if e = f.a.ProcessJob(f.ctx, job); e != nil {
		f.t.Fatal(e)
	}
	s, e = f.a.getStudy(f.ctx, f.a.DB, s.ID, false)
	if e != nil {
		f.t.Fatal(e)
	}
	if s.Status != "open" {
		f.t.Fatalf("not opened: %+v", s)
	}
	return s
}
func (f *fixture) answer(s Study, p, personal, prediction int) M {
	m, e := f.a.Answer(f.ctx, f.p[p], s.ID, s.Options[personal].ID, s.Options[prediction].ID)
	if e != nil {
		f.t.Fatal(e)
	}
	return m
}
func must(t *testing.T, e error) {
	t.Helper()
	if e != nil {
		t.Fatal(e)
	}
}
func expectFault(t *testing.T, e error, status int) {
	t.Helper()
	var fault *Fault
	if !errors.As(e, &fault) || fault.Status != status {
		t.Fatalf("wanted %d, got %v", status, e)
	}
}
func TestPassword(t *testing.T) {
	encoded := password("test-password", "")
	if !validPassword("test-password", encoded) || validPassword("wrong", encoded) {
		t.Fatal("password hash mismatch")
	}
}
func TestImages(t *testing.T) {
	bad := "data:image/svg+xml;base64,AAAA"
	if validateImage(&bad) == nil {
		t.Fatal("SVG should be rejected")
	}
	png := "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jTr0AAAAASUVORK5CYII="
	must(t, validateImage(&png))
}
func TestDraftValidationAndVersion(t *testing.T) {
	f := setup(t)
	m, e := f.a.Create(f.ctx, f.u)
	must(t, e)
	s, e := f.a.Save(f.ctx, f.u, str(m, "id"), Draft{Version: 1, Options: []Option{}})
	must(t, e)
	if s["status"] != "draft" {
		t.Fatal(s)
	}
	_, e = f.a.Publish(f.ctx, f.u, str(m, "id"))
	expectFault(t, e, 400)
	_, e = f.a.Save(f.ctx, f.u, str(m, "id"), Draft{Version: 1})
	expectFault(t, e, 409)
	for _, n := range []int{1, 501} {
		_, e = f.a.Save(f.ctx, f.u, str(m, "id"), Draft{Version: 2, Quota: ptr(n)})
		expectFault(t, e, 400)
	}
	_, e = f.a.Save(f.ctx, f.u, str(m, "id"), Draft{Version: 2, Options: make([]Option, 6)})
	expectFault(t, e, 400)
}
func TestTwoAnswersAudienceAndHiddenResults(t *testing.T) {
	f := setup(t)
	s := f.opened(5, 3)
	_, e := f.a.Answer(f.ctx, f.p[0], s.ID, s.Options[0].ID, "")
	expectFault(t, e, 400)
	young := f.p[0]
	young.Age = ptr(17)
	_, e = f.a.Answer(f.ctx, young, s.ID, s.Options[0].ID, s.Options[0].ID)
	expectFault(t, e, 403)
	outsider := f.p[0]
	outsider.Country = ptr("Другая")
	_, e = f.a.Answer(f.ctx, outsider, s.ID, s.Options[0].ID, s.Options[0].ID)
	expectFault(t, e, 403)
	_, e = f.a.Answer(f.ctx, f.u, s.ID, s.Options[0].ID, s.Options[0].ID)
	expectFault(t, e, 403)
	f.answer(s, 0, 0, 0)
	for _, u := range []User{f.u, f.p[0]} {
		view, e := f.a.Detail(f.ctx, u, s.ID, false)
		must(t, e)
		for _, key := range []string{"personal", "predictions", "personal_leaders", "comparison"} {
			if _, ok := view[key]; ok {
				t.Fatalf("leaked %s", key)
			}
		}
	}
	balance, e := f.a.balance(f.ctx, f.a.DB, f.p[0].ID)
	must(t, e)
	if balance != 1 {
		t.Fatal(balance)
	}
}
func TestConcurrentDuplicateAndQuota(t *testing.T) {
	f := setup(t)
	s := f.opened(2, 2)
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, e := f.a.Answer(f.ctx, f.p[0], s.ID, s.Options[0].ID, s.Options[0].ID)
			errs <- e
		}()
	}
	wg.Wait()
	for i := 0; i < 2; i++ {
		must(t, <-errs)
	}
	var n int
	f.a.DB.QueryRow(f.ctx, "SELECT count(*) FROM answers WHERE study_id=$1", s.ID).Scan(&n)
	if n != 1 {
		t.Fatal(n)
	}
	for _, p := range []User{f.p[1], f.p[2]} {
		wg.Add(1)
		go func(u User) {
			defer wg.Done()
			_, e := f.a.Answer(f.ctx, u, s.ID, s.Options[0].ID, s.Options[0].ID)
			errs <- e
		}(p)
	}
	wg.Wait()
	accepted := 0
	for i := 0; i < 2; i++ {
		if <-errs == nil {
			accepted++
		}
	}
	if accepted != 1 {
		t.Fatal(accepted)
	}
	view, e := f.a.Detail(f.ctx, f.u, s.ID, false)
	must(t, e)
	if view["count"] != 2 || view["status"] != "closed" {
		t.Fatal(view)
	}
}
func TestTieBonusFactVersionAndMetrics(t *testing.T) {
	f := setup(t)
	s := f.opened(5, 3)
	for i, p := range []int{0, 0, 1, 1, 2} {
		f.answer(s, i, p, []int{0, 1, 1, 1, 2}[i])
	}
	view, e := f.a.Detail(f.ctx, f.u, s.ID, false)
	must(t, e)
	personal := view["personal"].([]Count)
	if personal[0].Percent != 40 || personal[1].Percent != 40 || personal[2].Percent != 20 {
		t.Fatal(personal)
	}
	for i, want := range []int{2, 2, 2, 2, 1} {
		n, e := f.a.balance(f.ctx, f.a.DB, f.p[i].ID)
		must(t, e)
		if n != want {
			t.Fatalf("user %d: %d", i, n)
		}
	}
	fact := Fact{Metric: "Orders", Unit: "items", Start: "2026-10-01", End: "2026-10-07", Values: []FactValue{{OptionID: s.Options[0].ID, Value: 1}, {OptionID: s.Options[1].ID, Value: 3}, {OptionID: s.Options[2].ID, Value: 2}}}
	for i, tc := range []struct {
		values []float64
		code   string
	}{{[]float64{1, 3, 2}, "match"}, {[]float64{3, 1, 2}, "mismatch"}, {[]float64{3, 3, 1}, "tie"}} {
		for j, v := range tc.values {
			fact.Values[j].Value = v
		}
		result, e := f.a.SaveFact(f.ctx, f.u, s.ID, fact)
		must(t, e)
		cmp := result["comparison"].(M)
		if cmp["code"] != tc.code || cmp["fact"].(Fact).Version != i+1 {
			t.Fatal(cmp)
		}
	}
	before, _ := f.a.balance(f.ctx, f.a.DB, f.p[0].ID)
	fact.Values[0].Value = -1
	_, e = f.a.SaveFact(f.ctx, f.u, s.ID, fact)
	expectFault(t, e, 400)
	after, _ := f.a.balance(f.ctx, f.a.DB, f.p[0].ID)
	if before != after {
		t.Fatal("fact changed points")
	}
	m, e := f.a.Metrics(f.ctx, f.u)
	must(t, e)
	if m["ties"] != 1 {
		t.Fatal(m)
	}
	_, e = f.a.Detail(f.ctx, f.p[5], s.ID, false)
	expectFault(t, e, 403)
}
func TestDeadlineZeroAndIncompleteSample(t *testing.T) {
	f := setup(t)
	s := f.opened(5, 2)
	f.answer(s, 0, 0, 0)
	f.a.Clock = func() float64 { return *s.Deadline + 1 }
	_, e := f.a.Answer(f.ctx, f.p[1], s.ID, s.Options[0].ID, s.Options[0].ID)
	expectFault(t, e, 409)
	must(t, f.a.Settle(f.ctx))
	view, e := f.a.Detail(f.ctx, f.u, s.ID, false)
	must(t, e)
	if view["complete"] != false || view["status"] != "closed" {
		t.Fatal(view)
	}
	n, _ := f.a.balance(f.ctx, f.a.DB, f.p[0].ID)
	if n != 2 {
		t.Fatal(n)
	}
	f.a.Clock = now
	zero := f.opened(5, 2)
	f.a.Clock = func() float64 { return *zero.Deadline + 1 }
	view, e = f.a.Detail(f.ctx, f.u, zero.ID, false)
	must(t, e)
	if view["comparison"].(M)["code"] != "empty" || len(view["personal_leaders"].([]string)) != 0 {
		t.Fatal(view)
	}
}
func TestNotificationsFilterDedupeDevicesAndRevoke(t *testing.T) {
	f := setup(t)
	device, e := f.a.CreateDevice(f.ctx, f.p[0], "Яндекс Браузер")
	must(t, e)
	u, e := f.a.Auth(f.ctx, str(device, "token"), true)
	must(t, e)
	s := f.opened(2, 2)
	feed, e := f.a.ExtensionFeed(f.ctx, u)
	must(t, e)
	pending := feed["notifications"].([]M)
	if len(pending) != 1 || pending[0]["kind"] != "new_study" {
		t.Fatal(pending)
	}
	_, e = f.a.Ack(f.ctx, u, []string{str(pending[0], "id")})
	must(t, e)
	feed, e = f.a.ExtensionFeed(f.ctx, u)
	must(t, e)
	if len(feed["notifications"].([]M)) != 0 {
		t.Fatal("duplicate notification")
	}
	f.answer(s, 0, 0, 0)
	f.answer(s, 1, 0, 0)
	feed, e = f.a.ExtensionFeed(f.ctx, u)
	must(t, e)
	counts := map[string]int{}
	for _, n := range feed["notifications"].([]M) {
		counts[str(n, "kind")]++
	}
	if counts["study_closed"] != 1 || counts["points_base"] != 1 || counts["points_bonus"] != 1 {
		t.Fatal(counts)
	}
	f.answer(s, 0, 1, 1)
	again, e := f.a.Notifications(f.ctx, u)
	must(t, e)
	if len(again["notifications"].([]M)) != 4 {
		t.Fatal(again)
	}
	_, e = f.a.RevokeDevice(f.ctx, f.p[1], str(device, "id"))
	expectFault(t, e, 404)
	_, e = f.a.RevokeDevice(f.ctx, f.p[0], str(device, "id"))
	must(t, e)
	_, e = f.a.Auth(f.ctx, str(device, "token"), true)
	expectFault(t, e, 401)
}
func fund(f *fixture, u User, amount int) {
	_, e := f.a.DB.Exec(f.ctx, "INSERT INTO ledger VALUES($1,$2,NULL,'base',$3,NULL,$4)", ID(), u.ID, amount, f.a.Clock())
	must(f.t, e)
}
func reward(f *fixture, channel string, stock int) string {
	codes := []string{}
	for i := 0; i < stock; i++ {
		codes = append(codes, ID())
	}
	r, e := f.a.CreateReward(f.ctx, f.u, RewardInput{Title: "Coupon", Description: "Test coupon", Channel: channel, Cost: 10, Demo: true, Codes: codes})
	must(f.t, e)
	return str(r, "id")
}
func TestGuaranteedRewardsIdempotencyInventoryAndPrivacy(t *testing.T) {
	f := setup(t)
	id := reward(f, "guaranteed", 1)
	fund(f, f.p[0], 20)
	key := ID()
	result, e := f.a.Spend(f.ctx, f.p[0], key, id, false)
	must(t, e)
	if result["cost"] != 10 || result["balance"] != 10 || result["claim"] == nil {
		t.Fatal(result)
	}
	again, e := f.a.Spend(f.ctx, f.p[0], key, id, false)
	must(t, e)
	if again["operation_id"] != result["operation_id"] {
		t.Fatal("retry duplicated claim")
	}
	_, e = f.a.Spend(f.ctx, f.p[0], key, "", true)
	expectFault(t, e, 409)
	_, e = f.a.Spend(f.ctx, f.p[0], ID(), id, false)
	expectFault(t, e, 409)
	n, _ := f.a.balance(f.ctx, f.a.DB, f.p[0].ID)
	if n != 10 {
		t.Fatal("empty stock charged")
	}
	claims, e := f.a.Claims(f.ctx, f.p[1])
	must(t, e)
	if len(claims["claims"].([]M)) != 0 {
		t.Fatal("claim leaked")
	}
	catalog, e := f.a.Rewards(f.ctx, f.p[0])
	must(t, e)
	raw, _ := json.Marshal(catalog)
	code := result["claim"].(M)["code"].(string)
	if strings.Contains(string(raw), code) {
		t.Fatal("coupon leaked through catalog")
	}
}
func TestConcurrentRewardsCannotOverspendOrReuseCoupon(t *testing.T) {
	f := setup(t)
	id := reward(f, "guaranteed", 2)
	fund(f, f.p[0], 10)
	var wg sync.WaitGroup
	var accepted int
	var mu sync.Mutex
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, e := f.a.Spend(f.ctx, f.p[0], ID(), id, false); e == nil {
				mu.Lock()
				accepted++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if accepted != 1 {
		t.Fatal(accepted)
	}
	n, _ := f.a.balance(f.ctx, f.a.DB, f.p[0].ID)
	if n != 0 {
		t.Fatal(n)
	}
}
func TestWheelWinLossRetriesAndEmptyStock(t *testing.T) {
	f := setup(t)
	reward(f, "wheel", 1)
	fund(f, f.p[0], 4)
	f.a.Draw = func(n int) (int, error) {
		if n != 4 {
			t.Fatal(n)
		}
		return 0, nil
	}
	lose, e := f.a.Spend(f.ctx, f.p[0], ID(), "", true)
	must(t, e)
	if lose["won"] != false || lose["balance"] != 3 {
		t.Fatal(lose)
	}
	f.a.Draw = func(n int) (int, error) { return 3, nil }
	key := ID()
	win, e := f.a.Spend(f.ctx, f.p[0], key, "", true)
	must(t, e)
	if win["won"] != true || win["balance"] != 2 {
		t.Fatal(win)
	}
	_, e = f.a.Spend(f.ctx, f.p[0], key, "", true)
	must(t, e)
	_, e = f.a.Spend(f.ctx, f.p[0], ID(), "", true)
	expectFault(t, e, 409)
	n, _ := f.a.balance(f.ctx, f.a.DB, f.p[0].ID)
	if n != 2 {
		t.Fatal(n)
	}
}
func TestRewardFailureRollsBackDebit(t *testing.T) {
	f := setup(t)
	reward(f, "wheel", 1)
	fund(f, f.p[0], 3)
	f.a.Draw = func(int) (int, error) { return 0, errors.New("simulated failure") }
	_, e := f.a.Spend(f.ctx, f.p[0], ID(), "", true)
	if e == nil {
		t.Fatal("expected failure")
	}
	n, _ := f.a.balance(f.ctx, f.a.DB, f.p[0].ID)
	if n != 3 {
		t.Fatal(n)
	}
}
func TestRedisQueueApprovalAndRetry(t *testing.T) {
	f := setup(t)
	s := f.draft(2, 2)
	_, e := f.a.Publish(f.ctx, f.u, s.ID)
	must(t, e)
	must(t, f.a.DispatchJobs(f.ctx))
	var job string
	for i := 0; i < 100; i++ {
		id, e := f.a.Redis.RPop(f.ctx, queue).Result()
		if e != nil {
			t.Fatal(e)
		}
		var exists bool
		f.a.DB.QueryRow(f.ctx, "SELECT EXISTS(SELECT 1 FROM moderation_jobs WHERE id=$1 AND study_id=$2)", id, s.ID).Scan(&exists)
		if exists {
			job = id
			break
		}
	}
	if job == "" {
		t.Fatal("not queued")
	}
	must(t, f.a.ProcessJob(f.ctx, job))
	must(t, f.a.ProcessJob(f.ctx, job))
	s, e = f.a.getStudy(f.ctx, f.a.DB, s.ID, false)
	must(t, e)
	if s.Status != "open" {
		t.Fatal(s.Status)
	}
	var n int
	f.a.DB.QueryRow(f.ctx, "SELECT count(*) FROM events WHERE study_id=$1 AND type='published'", s.ID).Scan(&n)
	if n != 1 {
		t.Fatal("duplicate publication")
	}
}

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestOpenAIModerationRejectsAndChecksEveryVariant(t *testing.T) {
	f := setup(t)
	f.a.Demo = false
	s := f.draft(2, 3)
	calls := 0
	f.a.HTTP = &http.Client{Transport: transportFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.String() != "https://api.openai.com/v1/moderations" || r.Header.Get("Authorization") != "Bearer test-key" {
			t.Fatal("bad OpenAI request")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"results":[{"flagged":false}]}`)), Header: http.Header{}}, nil
	})}
	ok, _ := f.a.moderate(f.ctx, s)
	if !ok || calls != 3 {
		t.Fatal(ok, calls)
	}
	f.a.HTTP.Transport = transportFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"results":[{"flagged":true}]}`)), Header: http.Header{}}, nil
	})
	_, e := f.a.Publish(f.ctx, f.u, s.ID)
	must(t, e)
	var job string
	f.a.DB.QueryRow(f.ctx, "SELECT id FROM moderation_jobs WHERE study_id=$1", s.ID).Scan(&job)
	must(t, f.a.ProcessJob(f.ctx, job))
	s, e = f.a.getStudy(f.ctx, f.a.DB, s.ID, false)
	must(t, e)
	if s.Status != "draft" || s.Reason == "" {
		t.Fatal(s)
	}
	f.a.APIKey = ""
	ok, _ = f.a.moderate(f.ctx, s)
	if ok {
		t.Fatal("missing key allowed")
	}
}
func TestHTTPCompleteFlowAndCSRF(t *testing.T) {
	f := setup(t)
	handler := f.a.Handler()
	call := func(method, path string, body any, headers map[string]string) *httptest.ResponseRecorder {
		raw, _ := json.Marshal(body)
		r := httptest.NewRequest(method, path, bytes.NewReader(raw))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Manyvo-Client", "web")
		for k, v := range headers {
			r.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	if call("GET", "/api/studies", nil, nil).Code != 401 {
		t.Fatal("guest allowed")
	}
	login := call("POST", "/api/login", M{"email": f.u.Email, "password": "test-password"}, nil)
	if login.Code != 200 {
		t.Fatal(login.Body.String())
	}
	cookie := login.Result().Cookies()[0]
	var result M
	json.Unmarshal(login.Body.Bytes(), &result)
	headers := map[string]string{"Cookie": cookie.Name + "=" + cookie.Value, "X-CSRF-Token": str(result, "csrf")}
	if call("POST", "/api/studies", M{}, map[string]string{"Cookie": headers["Cookie"]}).Code != 403 {
		t.Fatal("CSRF bypass")
	}
	created := call("POST", "/api/studies", M{}, headers)
	if created.Code != 200 {
		t.Fatal(created.Body.String())
	}
	var s M
	json.Unmarshal(created.Body.Bytes(), &s)
	if str(s, "id") == "" {
		t.Fatal(s)
	}
	if call("POST", "/api/studies", M{}, map[string]string{"Origin": "https://evil.example"}).Code != 403 {
		t.Fatal("origin allowed")
	}
	must(t, f.a.DB.Ping(f.ctx))
}

func TestRegistrationAndExtensionHTTPAccess(t *testing.T) {
	f := setup(t)
	registration := Registration{Name: "Новый участник", Email: "new@test.local", Password: "strong-test-password", Role: "participant", Age: 24, Country: "Россия"}
	must(t, f.a.Register(f.ctx, registration))
	token, csrf, e := f.a.Login(f.ctx, registration.Email, registration.Password)
	must(t, e)
	u, e := f.a.Auth(f.ctx, token, false)
	must(t, e)
	if u.Role != "participant" || csrf == "" {
		t.Fatal(u)
	}
	expectFault(t, f.a.Register(f.ctx, registration), 409)
	registration.Email = "underage@test.local"
	registration.Age = 17
	expectFault(t, f.a.Register(f.ctx, registration), 400)
	device, e := f.a.CreateDevice(f.ctx, u, "Яндекс")
	must(t, e)
	r := httptest.NewRequest("GET", "/api/extension/feed", nil)
	r.Header.Set("Authorization", "Bearer "+str(device, "token"))
	r.Header.Set("X-Manyvo-Client", "extension")
	r.Header.Set("Origin", "chrome-extension://manyvo")
	w := httptest.NewRecorder()
	f.a.Handler().ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	r = httptest.NewRequest("POST", "/api/devices", strings.NewReader(`{}`))
	r.Header.Set("Authorization", "Bearer "+str(device, "token"))
	r.Header.Set("X-Manyvo-Client", "extension")
	w = httptest.NewRecorder()
	f.a.Handler().ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("device created another device")
	}
}
func TestExpiredApprovalCannotPublishEditedMaterials(t *testing.T) {
	f := setup(t)
	f.a.Demo = false
	s := f.draft(2, 2)
	_, e := f.a.Publish(f.ctx, f.u, s.ID)
	must(t, e)
	started, release := make(chan struct{}), make(chan struct{})
	calls := 0
	f.a.HTTP = &http.Client{Transport: transportFunc(func(*http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			close(started)
			<-release
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"results":[{"flagged":false}]}`)), Header: http.Header{}}, nil
	})}
	var job string
	f.a.DB.QueryRow(f.ctx, "SELECT id FROM moderation_jobs WHERE study_id=$1", s.ID).Scan(&job)
	done := make(chan error, 1)
	go func() { done <- f.a.ProcessJob(f.ctx, job) }()
	<-started
	_, e = f.a.DB.Exec(f.ctx, "UPDATE studies SET status='draft',version=version+1 WHERE id=$1", s.ID)
	must(t, e)
	current, e := f.a.getStudy(f.ctx, f.a.DB, s.ID, false)
	must(t, e)
	_, e = f.a.Save(f.ctx, f.u, s.ID, Draft{Version: current.Version, Title: "Changed", Question: "New question", Quota: ptr(2), AgeMin: ptr(18), AgeMax: ptr(65), Country: "Россия", Options: []Option{{Text: "New A"}, {Text: "New B"}}})
	must(t, e)
	_, e = f.a.Publish(f.ctx, f.u, s.ID)
	must(t, e)
	close(release)
	must(t, <-done)
	current, e = f.a.getStudy(f.ctx, f.a.DB, s.ID, false)
	must(t, e)
	if current.Status != "moderating" || current.Title != "Changed" {
		t.Fatal("old approval published new version")
	}
}

func TestAnswerAndBonusDatabaseFailuresRollbackAtomically(t *testing.T) {
	f := setup(t)
	s := f.opened(2, 2)
	_, e := f.a.DB.Exec(f.ctx, `CREATE FUNCTION fail_base() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='base' THEN RAISE EXCEPTION 'simulated write failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER base_failure BEFORE INSERT ON ledger FOR EACH ROW EXECUTE FUNCTION fail_base();`)
	must(t, e)
	_, e = f.a.Answer(f.ctx, f.p[0], s.ID, s.Options[0].ID, s.Options[0].ID)
	if e == nil {
		t.Fatal("database failure should propagate")
	}
	var answers int
	must(t, f.a.DB.QueryRow(f.ctx, "SELECT count(*) FROM answers WHERE study_id=$1", s.ID).Scan(&answers))
	if answers != 0 {
		t.Fatal("partial answer committed")
	}
	balance, e := f.a.balance(f.ctx, f.a.DB, f.p[0].ID)
	must(t, e)
	if balance != 0 {
		t.Fatal("partial point committed")
	}
	_, e = f.a.DB.Exec(f.ctx, "DROP TRIGGER base_failure ON ledger")
	must(t, e)
	f.answer(s, 0, 0, 0)
	_, e = f.a.DB.Exec(f.ctx, `CREATE FUNCTION fail_bonus() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='bonus' THEN RAISE EXCEPTION 'simulated closing failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER bonus_failure BEFORE INSERT ON ledger FOR EACH ROW EXECUTE FUNCTION fail_bonus();`)
	must(t, e)
	_, e = f.a.Answer(f.ctx, f.p[1], s.ID, s.Options[0].ID, s.Options[0].ID)
	if e == nil {
		t.Fatal("closing failure should propagate")
	}
	view, e := f.a.Detail(f.ctx, f.u, s.ID, false)
	must(t, e)
	if view["status"] != "open" || view["count"] != 1 {
		t.Fatal("partial close or second answer committed")
	}
	balance, e = f.a.balance(f.ctx, f.a.DB, f.p[0].ID)
	must(t, e)
	if balance != 1 {
		t.Fatal("partial bonus committed")
	}
	_, e = f.a.DB.Exec(f.ctx, "DROP TRIGGER bonus_failure ON ledger")
	must(t, e)
	f.answer(s, 1, 0, 0)
	for _, u := range f.p[:2] {
		n, e := f.a.balance(f.ctx, f.a.DB, u.ID)
		must(t, e)
		if n != 2 {
			t.Fatalf("retry did not restore the expected balance: %d", n)
		}
	}
}

func TestDifferentUsersCannotReceiveOneCouponTwice(t *testing.T) {
	f := setup(t)
	id := reward(f, "guaranteed", 1)
	fund(f, f.p[0], 10)
	fund(f, f.p[1], 10)
	var wg sync.WaitGroup
	var mu sync.Mutex
	accepted := 0
	for _, u := range f.p[:2] {
		wg.Add(1)
		go func(u User) {
			defer wg.Done()
			_, e := f.a.Spend(f.ctx, u, ID(), id, false)
			if e == nil {
				mu.Lock()
				accepted++
				mu.Unlock()
			}
		}(u)
	}
	wg.Wait()
	if accepted != 1 {
		t.Fatal("coupon issued more than once")
	}
	var count int
	must(t, f.a.DB.QueryRow(f.ctx, "SELECT count(*) FROM claims WHERE reward_id=$1", id).Scan(&count))
	if count != 1 {
		t.Fatal(count)
	}
	total := 0
	for _, u := range f.p[:2] {
		n, e := f.a.balance(f.ctx, f.a.DB, u.ID)
		must(t, e)
		total += n
	}
	if total != 10 {
		t.Fatal("losing requester was charged")
	}
}

func TestAudienceNotificationFilteringAndReadIsolation(t *testing.T) {
	f := setup(t)
	_, e := f.a.DB.Exec(f.ctx, "UPDATE users SET age=17 WHERE id=$1", f.p[1].ID)
	must(t, e)
	_, e = f.a.DB.Exec(f.ctx, "UPDATE users SET country='Другая' WHERE id=$1", f.p[2].ID)
	must(t, e)
	f.opened(2, 2)
	mine, e := f.a.Notifications(f.ctx, f.p[0])
	must(t, e)
	items := mine["notifications"].([]M)
	if len(items) != 1 {
		t.Fatal(items)
	}
	for _, u := range []User{f.p[1], f.p[2], f.u} {
		n, e := f.a.Notifications(f.ctx, u)
		must(t, e)
		if len(n["notifications"].([]M)) != 0 {
			t.Fatal("notice sent to wrong audience")
		}
	}
	_, e = f.a.ReadNotifications(f.ctx, f.p[1], []string{str(items[0], "id")})
	must(t, e)
	mine, e = f.a.Notifications(f.ctx, f.p[0])
	must(t, e)
	if mine["unread"] != 1 {
		t.Fatal("another user changed read state")
	}
	_, e = f.a.ReadNotifications(f.ctx, f.p[0], []string{str(items[0], "id")})
	must(t, e)
	mine, e = f.a.Notifications(f.ctx, f.p[0])
	must(t, e)
	if mine["unread"] != 0 {
		t.Fatal("read state not saved")
	}
}
