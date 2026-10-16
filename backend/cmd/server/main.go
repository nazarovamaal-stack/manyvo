package main

import (
	"context"
	"log"
	"manyvo/backend/internal/platform"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://manyvo:manyvo-local-only@127.0.0.1:54329/manyvo?sslmode=disable"
	}
	redisURL := os.Getenv("REDIS_URL")
	if redisURL == "" {
		redisURL = "redis://127.0.0.1:63799/0"
	}
	a, e := platform.New(ctx, dsn, redisURL)
	if e != nil {
		log.Fatalf("Cannot start database/queue: %v", e)
	}
	defer a.DB.Close()
	defer a.Redis.Close()
	if a.SeedDemo {
		if e = a.Seed(ctx); e != nil {
			log.Fatal(e)
		}
	}
	a.Workers(ctx)
	port := os.Getenv("PORT")
	if port == "" {
		port = "8088"
	}
	bind := os.Getenv("BIND")
	if bind == "" {
		bind = "127.0.0.1"
	}
	server := &http.Server{Addr: bind + ":" + port, Handler: a.Handler(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32768}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		server.Shutdown(shutdown)
	}()
	log.Printf("Manyvo Go API listening on %s, demo=%v", port, a.Demo)
	if e = server.ListenAndServe(); e != nil && e != http.ErrServerClosed {
		log.Fatal(e)
	}
}
