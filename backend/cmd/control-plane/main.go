// Command control-plane is the Innovatiview-wide Control Plane
// binary for the multi-tenant portal architecture (Phase 2 of the
// migration plan).
//
// Runs on its own port + its own Postgres, separate from every Data
// Plane. Its jobs:
//
//   - Own the superadmin login surface (platform_users).
//   - Own the registry of clients (clients_registry) — where each
//     Data Plane lives and how to authenticate against its /internal
//     API.
//   - Serve the federated dashboard by fanning out to every active
//     Data Plane's /api/internal/metrics in parallel.
//   - (Phase 3) Own the central KYC queue and, on approval, provision
//     the org + admin on the target Data Plane via /internal/orgs/create.
//
// The Control Plane never touches candidate biometrics, wallet
// transactions, or verifications — those stay strictly on the Data
// Plane.
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

	"github.com/veni/neet-verification/internal/auth"
	"github.com/veni/neet-verification/internal/controlplane/api"
	cpcfg "github.com/veni/neet-verification/internal/controlplane/config"
	cpdb "github.com/veni/neet-verification/internal/controlplane/db"
	sharedDB "github.com/veni/neet-verification/internal/db"
)

func main() {
	cfg := cpcfg.Load()

	// Production safety mirror of the Data Plane's main.go: refuse to
	// boot in production with the dev default JWT secret. The two
	// binaries share the same "if secret == default, log warning
	// (dev) or fatal (prod)" pattern for consistency.
	if cfg.IsProduction() && cfg.JWTSecret == cpcfg.DefaultDevJWTSecret {
		log.Fatal("SECURITY: APP_ENV=production but CP_JWT_SECRET is unset or the default dev value — refusing to boot.")
	}
	if cfg.JWTSecret == cpcfg.DefaultDevJWTSecret {
		log.Println("WARNING: CP_JWT_SECRET is the dev default — fine for local dev, MUST be set before production.")
	}

	// Reuse the Data Plane's db.Open (pgx pool + sensible defaults).
	// Only the migration package is CP-specific.
	database, err := sharedDB.Open(cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("cp: open db (%s): %v", cfg.DatabaseURL, err)
	}
	defer database.Close()

	if err := cpdb.Migrate(database); err != nil {
		log.Fatalf("cp: migrate: %v", err)
	}

	// Superadmin session TTL. Same 12h as the Data Plane so operators
	// running dashboards across both surfaces don't get kicked at
	// different times.
	jwtSvc := auth.NewJWTService(cfg.JWTSecret, 12*time.Hour)

	srv := api.NewServer(api.Deps{
		DB:  database,
		JWT: jwtSvc,
		Cfg: cfg,
	})

	httpSrv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           srv.Router(),
		ReadHeaderTimeout: 15 * time.Second,
		// The federated dashboard fires N parallel HTTP calls with
		// their own per-client timeout (Cfg.FederatedTimeoutMS). Give
		// the outer request a comfortable ceiling so a slow N doesn't
		// trip the server-wide default.
		WriteTimeout: 60 * time.Second,
	}

	// Graceful shutdown so an in-flight federated call has time to
	// finish rather than being cut mid-fanout.
	done := make(chan error, 1)
	go func() {
		log.Printf("control-plane listening on %s (db=%s)", cfg.HTTPAddr, redactDSN(cfg.DatabaseURL))
		done <- httpSrv.ListenAndServe()
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	select {
	case s := <-sig:
		log.Printf("control-plane: caught %s, shutting down…", s)
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := httpSrv.Shutdown(ctx); err != nil {
			log.Printf("control-plane: graceful shutdown failed: %v", err)
		}
	case err := <-done:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("control-plane: server exited: %v", err)
		}
	}
}

// redactDSN strips credentials out of a Postgres URL for log
// output. Keeps the host + dbname so an operator can tell WHICH DB
// the CP booted against, without leaking the password to journalctl.
func redactDSN(dsn string) string {
	// Naive but sufficient: replace anything between "://" and "@" with "***".
	i := indexOf(dsn, "://")
	if i < 0 {
		return dsn
	}
	rest := dsn[i+3:]
	at := indexOf(rest, "@")
	if at < 0 {
		return dsn
	}
	return dsn[:i+3] + "***" + rest[at:]
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

// The sql import is only referenced through cpdb.Migrate + sharedDB.Open;
// this line keeps the import graph honest for future code that needs a
// direct handle.
var _ = sql.ErrNoRows
