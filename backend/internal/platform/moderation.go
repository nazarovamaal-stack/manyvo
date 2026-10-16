package platform

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"
	"io"
	"log"
	"net/http"
	"time"
)

const queue = "manyvo:moderation"

func (a *App) moderate(ctx context.Context, s Study) (bool, string) {
	if a.Demo {
		return true, ""
	}
	if a.APIKey == "" {
		return false, "Добавьте OPENAI_API_KEY в .env и перезапустите API."
	}
	for i, o := range s.Options {
		input := []M{{"type": "text", "text": s.Title + "\n" + s.Question + "\n" + o.Text}}
		if o.Image != nil && *o.Image != "" {
			input = append(input, M{"type": "image_url", "image_url": M{"url": *o.Image}})
		}
		raw, _ := json.Marshal(M{"model": a.Model, "input": input})
		req, e := http.NewRequestWithContext(ctx, "POST", "https://api.openai.com/v1/moderations", bytes.NewReader(raw))
		if e != nil {
			return false, "Не удалось начать модерацию."
		}
		req.Header.Set("Authorization", "Bearer "+a.APIKey)
		req.Header.Set("Content-Type", "application/json")
		response, e := a.HTTP.Do(req)
		if e != nil {
			return false, "OpenAI недоступен. Попробуйте ещё раз."
		}
		body, e := io.ReadAll(io.LimitReader(response.Body, 2*1024*1024))
		response.Body.Close()
		if e != nil || response.StatusCode != 200 {
			switch response.StatusCode {
			case 401:
				return false, "OpenAI не принял API-ключ."
			case 429:
				return false, "Достигнут лимит OpenAI. Повторите позже."
			}
			return false, "Не удалось завершить модерацию OpenAI."
		}
		var result struct {
			Results []struct {
				Flagged *bool `json:"flagged"`
			} `json:"results"`
		}
		if json.Unmarshal(body, &result) != nil || len(result.Results) == 0 {
			return false, "OpenAI вернул неполный результат проверки."
		}
		for _, r := range result.Results {
			if r.Flagged == nil {
				return false, "OpenAI вернул неполный результат проверки."
			}
			if *r.Flagged {
				return false, fmt.Sprintf("Вариант %d не прошёл модерацию. Измените материалы.", i+1)
			}
		}
	}
	return true, ""
}
func (a *App) DispatchJobs(ctx context.Context) error {
	rows, e := a.DB.Query(ctx, "SELECT id FROM moderation_jobs WHERE (state IN ('pending','queued') AND enqueued_at<$1) OR (state='running' AND lease_until<$2) ORDER BY created_at LIMIT 100", a.Clock()-10, a.Clock())
	if e != nil {
		return e
	}
	ids := []string{}
	for rows.Next() {
		var id string
		rows.Scan(&id)
		ids = append(ids, id)
	}
	rows.Close()
	for _, id := range ids {
		if e = a.Redis.LPush(ctx, queue, id).Err(); e != nil {
			return e
		}
		if _, e = a.DB.Exec(ctx, "UPDATE moderation_jobs SET enqueued_at=$1,state=CASE WHEN state='pending' THEN 'queued' ELSE state END WHERE id=$2", a.Clock(), id); e != nil {
			return e
		}
	}
	return nil
}
func (a *App) ProcessJob(ctx context.Context, id string) error {
	var s Study
	attempt := 0
	run := false
	e := a.transaction(ctx, func(tx pgx.Tx) error {
		var studyID, state string
		var version int
		var lease float64
		e := tx.QueryRow(ctx, "SELECT study_id,version,state,lease_until,attempt FROM moderation_jobs WHERE id=$1 FOR UPDATE", id).Scan(&studyID, &version, &state, &lease, &attempt)
		if errors.Is(e, pgx.ErrNoRows) {
			return nil
		}
		if e != nil {
			return e
		}
		if state == "done" || (state == "running" && lease > a.Clock()) {
			return nil
		}
		s, e = a.getStudy(ctx, tx, studyID, true)
		if e != nil {
			return e
		}
		if s.Status != "moderating" || s.Version != version {
			_, e = tx.Exec(ctx, "UPDATE moderation_jobs SET state='done' WHERE id=$1", id)
			return e
		}
		attempt++
		_, e = tx.Exec(ctx, "UPDATE moderation_jobs SET state='running',attempt=$1,lease_until=$2 WHERE id=$3", attempt, a.Clock()+120, id)
		run = e == nil
		return e
	})
	if e != nil || !run {
		return e
	}
	allowed, reason := a.moderate(ctx, s)
	return a.transaction(ctx, func(tx pgx.Tx) error {
		var currentAttempt int
		var state string
		if e := tx.QueryRow(ctx, "SELECT attempt,state FROM moderation_jobs WHERE id=$1 FOR UPDATE", id).Scan(&currentAttempt, &state); e != nil {
			return e
		}
		if currentAttempt != attempt || state != "running" {
			return nil
		}
		current, e := a.getStudy(ctx, tx, s.ID, true)
		if e != nil {
			return e
		}
		if current.Version == s.Version && current.Status == "moderating" {
			provider := "openai"
			if a.Demo {
				provider = "demo"
			}
			if allowed {
				n := a.Clock()
				_, e = tx.Exec(ctx, "UPDATE studies SET status='open',quota=COALESCE(quota,50),published_at=$1,deadline=$2,moderation_provider=$3 WHERE id=$4", n, n+86400, provider, s.ID)
				if e != nil {
					return e
				}
				if e = a.event(ctx, tx, "published", s.ID, "", nil); e != nil {
					return e
				}
				rows, err := objects(ctx, tx, "SELECT to_jsonb(u) FROM users u WHERE role='participant' AND age>=18 AND country=$1 AND age>=$2 AND age<=$3", s.Country, *s.AgeMin, *s.AgeMax)
				if err != nil {
					return err
				}
				for _, r := range rows {
					if str(r, "id") == s.OwnerID {
						continue
					}
					if e = a.notify(ctx, tx, str(r, "id"), "new_study", s.ID, "Новое исследование", s.Title, s.ID); e != nil {
						return e
					}
				}
			} else {
				_, e = tx.Exec(ctx, "UPDATE studies SET status='draft',moderation_reason=$1,moderation_provider=$2 WHERE id=$3", reason, provider, s.ID)
				if e != nil {
					return e
				}
			}
		}
		_, e = tx.Exec(ctx, "UPDATE moderation_jobs SET state='done' WHERE id=$1", id)
		return e
	})
}
func (a *App) Workers(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			if e := a.Settle(ctx); e != nil && ctx.Err() == nil {
				log.Printf("settlement: %T", e)
			}
			if e := a.DispatchJobs(ctx); e != nil && ctx.Err() == nil {
				log.Printf("queue dispatch: %T", e)
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	for i := 0; i < 2; i++ {
		go func() {
			for {
				result, e := a.Redis.BRPop(ctx, time.Second, queue).Result()
				if ctx.Err() != nil {
					return
				}
				if e == redis.Nil {
					continue
				}
				if e != nil {
					time.Sleep(time.Second)
					continue
				}
				if len(result) == 2 {
					if e = a.ProcessJob(ctx, result[1]); e != nil {
						log.Printf("moderation job: %T", e)
					}
				}
			}
		}()
	}
}
