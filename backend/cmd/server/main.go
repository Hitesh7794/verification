package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/veni/neet-verification/internal/api"
	"github.com/veni/neet-verification/internal/auth"
	"github.com/veni/neet-verification/internal/config"
	"github.com/veni/neet-verification/internal/data"
	"github.com/veni/neet-verification/internal/db"
)

func main() {
	cfg := config.Load()

	database, err := db.Open(cfg.DBPath)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	defer database.Close()

	if err := db.Migrate(database); err != nil {
		log.Fatalf("migrate: %v", err)
	}

	log.Printf("loading candidate index from %s ...", cfg.DataDir)
	index, err := data.LoadIndex(cfg.DataDir)
	if err != nil {
		log.Printf("warning: candidate index load failed: %v", err)
		index = data.NewEmptyIndex()
	}
	log.Printf("indexed %d candidates across %d centers", index.CandidateCount(), index.CenterCount())

	if err := db.Seed(database, index); err != nil {
		log.Fatalf("seed: %v", err)
	}

	jwtSvc := auth.NewJWTService(cfg.JWTSecret, 12*time.Hour)

	srv := api.NewServer(api.Deps{
		DB:    database,
		Index: index,
		JWT:   jwtSvc,
		Cfg:   cfg,
	})

	httpSrv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           srv.Router(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		log.Printf("listening on %s", cfg.HTTPAddr)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("listen: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	log.Println("shutting down...")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(ctx)
}
