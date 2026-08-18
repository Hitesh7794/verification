package db

import (
	"database/sql"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

// Open returns a Postgres handle configured for the portal's workload.
//
// The DSN is a standard Postgres URL:
//
//	postgres://user:pass@host:port/dbname?sslmode=disable
//
// In dev + local single-host prod we run Postgres on loopback so
// sslmode=disable is fine. When we point at RDS later, switch to
// sslmode=require in the .env — no code change needed.
//
// Pool sizing matches the previous SQLite tuning (64 max, 16 idle,
// 30-min lifetime). Postgres handles pooled connections natively, so
// these numbers become the pgx driver's connection pool bounds.
func Open(dsn string) (*sql.DB, error) {
	d, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, err
	}
	d.SetMaxOpenConns(64)
	d.SetMaxIdleConns(16)
	d.SetConnMaxLifetime(30 * time.Minute)
	if err := d.Ping(); err != nil {
		return nil, err
	}
	return d, nil
}
