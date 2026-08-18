package main

import (
	"context"
	"database/sql"
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

	// Production safety: refuse to boot with the dev fallback JWT secret.
	// In dev (APP_ENV unset / "development" / "dev") the default is fine —
	// it's deliberately the same constant so tests are reproducible and
	// new contributors don't have to set env vars to run the server. In
	// production a missing JWT_SECRET would silently sign tokens with a
	// publicly-known secret, which is the worst kind of security incident.
	if cfg.IsProduction() && cfg.JWTSecret == config.DefaultDevJWTSecret {
		log.Fatal("SECURITY: APP_ENV=production but JWT_SECRET is unset or the default dev value — refusing to boot. Set JWT_SECRET to a random string.")
	}
	// Even in dev, surface the misconfiguration as a warning so an
	// operator running locally with APP_ENV unset still notices.
	if cfg.JWTSecret == config.DefaultDevJWTSecret {
		log.Println("WARNING: JWT_SECRET is the dev default — fine for local dev, MUST be set before production.")
	}

	database, err := db.Open(cfg.DatabaseURL)
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

	// Magic-link table cleanup runs hourly. Deletes rows that are both
	// used AND older than 30 days (we keep them around briefly for audit
	// trail), plus unused-but-long-expired rows. Idempotent + tiny — a
	// proper cron migration would do this nightly in prod, but an
	// in-process goroutine is fine until then.
	go startMagicLinkCleanup(database)

	// Per-IP rate-limiter map cleanup. Removes expired entries every 10
	// minutes so the map stays bounded under sustained traffic.
	go api.StartLimiterCleanup()

	httpSrv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           srv.Router(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		// WriteTimeout is the deadline for the ENTIRE response write,
		// not just headers. 30 min accommodates the ~370 MB operator
		// install bundle over slow connections (e.g. college Wi-Fi at
		// 1-2 MB/s = 3-6 min). JSON API endpoints all respond in <1s
		// so they're never affected. Caddy fronts the server and has
		// its own request+response timeouts + slow-loris protection,
		// so a long stdlib WriteTimeout is not an exposure.
		WriteTimeout: 30 * time.Minute,
		IdleTimeout:  120 * time.Second,
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

// startMagicLinkCleanup runs forever. Used + 30-day-old rows get
// dropped; expired + unused rows that are 30+ days past their expiry
// also get dropped. Failures are logged; we never block startup or
// shutdown on this.
func startMagicLinkCleanup(d *sql.DB) {
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		_, err := d.ExecContext(ctx,
			db.Q(`DELETE FROM magic_links
			 WHERE (used_at IS NOT NULL    AND used_at    < NOW() - INTERVAL '30 days')
			    OR (used_at IS NULL        AND expires_at < NOW() - INTERVAL '30 days')`),
		)
		cancel()
		if err != nil {
			log.Printf("magic-link cleanup: %v", err)
		}
		time.Sleep(1 * time.Hour)
	}
}
