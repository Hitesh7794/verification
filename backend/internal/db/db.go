package db

import (
	"database/sql"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

// Open returns a SQLite handle tuned for many concurrent readers.
// WAL + busy timeout + a small write pool keeps things smooth under
// the kind of load this portal needs to handle (target ~10k concurrent
// users — for that scale you would point this at Postgres in prod, but
// the schema and queries here are written to port over directly).
func Open(path string) (*sql.DB, error) {
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(wal)&_pragma=synchronous(normal)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(on)", path)
	d, err := sql.Open("sqlite", dsn)
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
