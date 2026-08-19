// One-off tool: read every row from a SQLite portal DB and re-insert
// it into a Postgres portal DB.
//
// Usage:
//
//	pgmigrate -sqlite /path/to/verification.db \
//	          -pg postgres://portal:pw@127.0.0.1:5434/verification?sslmode=disable
//
// The Postgres database must already have the schema applied
// (`portal-server` boots once against an empty DB, which runs
// Migrate()). This tool does NOT drop or recreate tables — it will
// refuse to run if any target table is non-empty.
//
// Row IDs are preserved. After each identity-column table finishes
// copying, the tool resets the sequence so future portal-server
// inserts start from the right number.
package main

import (
	"context"
	"database/sql"
	"flag"
	"fmt"
	"log"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"
)

// Copy plan. Order is FK-safe. `identity` means the table has a
// GENERATED ALWAYS AS IDENTITY primary key that needs OVERRIDING
// SYSTEM VALUE + SETVAL after the copy.
var tables = []struct {
	name     string
	identity bool
}{
	{"organizations", true},
	{"users", true},
	{"clients", true},
	{"exams", true},
	{"exam_candidates", true},
	{"exam_centres", true},
	{"exam_csv_uploads", true},
	{"organization_exam_subscriptions", false}, // composite PK
	{"operator_exams", false},                  // composite PK
	{"verifications", true},
	{"wallets", false}, // PK is org_id (not identity)
	{"wallet_transactions", true},
	{"razorpay_orders", false}, // PK is razorpay_order_id (text)
	{"magic_links", true},
	{"audit_log", true},
	{"institution_applications", true},
	{"institution_application_documents", true},
}

func main() {
	sqlitePath := flag.String("sqlite", "", "path to SQLite verification.db")
	pgDSN := flag.String("pg", "", "Postgres DSN (postgres://user:pw@host:port/db?sslmode=disable)")
	flag.Parse()
	if *sqlitePath == "" || *pgDSN == "" {
		log.Fatal("both -sqlite and -pg are required")
	}

	sq, err := sql.Open("sqlite", "file:"+*sqlitePath+"?mode=ro")
	if err != nil {
		log.Fatalf("open sqlite: %v", err)
	}
	defer sq.Close()

	pg, err := sql.Open("pgx", *pgDSN)
	if err != nil {
		log.Fatalf("open pg: %v", err)
	}
	defer pg.Close()
	if err := pg.Ping(); err != nil {
		log.Fatalf("ping pg: %v", err)
	}

	ctx := context.Background()

	// Safety check — refuse to run if a target table already has rows.
	for _, t := range tables {
		var n int
		if err := pg.QueryRowContext(ctx, `SELECT COUNT(*) FROM `+t.name).Scan(&n); err != nil {
			log.Fatalf("count %s: %v", t.name, err)
		}
		if n > 0 {
			log.Fatalf("target table %s already has %d rows — refusing to run", t.name, n)
		}
	}
	log.Println("target database is empty; starting copy")

	totalRows := 0
	start := time.Now()
	for _, t := range tables {
		n, err := copyTable(ctx, sq, pg, t.name, t.identity)
		if err != nil {
			log.Fatalf("copy %s: %v", t.name, err)
		}
		totalRows += n
		log.Printf("  %-38s %6d rows", t.name, n)
	}

	// Align every identity sequence to the max(id) so the next portal-
	// server INSERT gets a fresh id, not a collision with a copied row.
	if err := resetSequences(ctx, pg); err != nil {
		log.Fatalf("reset sequences: %v", err)
	}
	log.Printf("copied %d rows across %d tables in %s", totalRows, len(tables), time.Since(start).Round(time.Millisecond))
}

// copyTable walks every row of one SQLite table and inserts it into
// Postgres. Column list is discovered from SQLite's PRAGMA (both DBs
// have the same column names, verified by the schema port).
func copyTable(ctx context.Context, sq, pg *sql.DB, table string, identity bool) (int, error) {
	cols, err := sqliteColumns(sq, table)
	if err != nil {
		return 0, fmt.Errorf("columns: %w", err)
	}

	rows, err := sq.QueryContext(ctx, "SELECT "+strings.Join(cols, ", ")+" FROM "+table)
	if err != nil {
		return 0, fmt.Errorf("select: %w", err)
	}
	defer rows.Close()

	placeholders := make([]string, len(cols))
	for i := range cols {
		placeholders[i] = fmt.Sprintf("$%d", i+1)
	}
	suffix := ""
	if identity {
		suffix = " OVERRIDING SYSTEM VALUE"
	}
	insertSQL := fmt.Sprintf(
		"INSERT INTO %s (%s)%s VALUES (%s)",
		table,
		strings.Join(cols, ", "),
		suffix,
		strings.Join(placeholders, ", "),
	)

	tx, err := pg.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	stmt, err := tx.PrepareContext(ctx, insertSQL)
	if err != nil {
		return 0, fmt.Errorf("prepare: %w", err)
	}
	defer stmt.Close()

	n := 0
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range cols {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return 0, fmt.Errorf("scan row %d: %w", n, err)
		}
		// SQLite driver returns DATETIME as []byte or time.Time; either
		// works with pgx if passed through unchanged.
		if _, err := stmt.ExecContext(ctx, vals...); err != nil {
			return 0, fmt.Errorf("insert row %d: %w", n, err)
		}
		n++
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	return n, tx.Commit()
}

func sqliteColumns(sq *sql.DB, table string) ([]string, error) {
	rows, err := sq.Query("PRAGMA table_info(" + table + ")")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var cols []string
	for rows.Next() {
		var cid int
		var name, ctype string
		var notnull int
		var dflt sql.NullString
		var pk int
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return nil, err
		}
		cols = append(cols, name)
	}
	return cols, rows.Err()
}

// resetSequences aligns every identity sequence to max(id)+1 so
// subsequent inserts by portal-server don't collide with copied rows.
// Postgres's GENERATED AS IDENTITY sequences are named
// pg_get_serial_sequence(table, 'id').
func resetSequences(ctx context.Context, pg *sql.DB) error {
	for _, t := range tables {
		if !t.identity {
			continue
		}
		q := fmt.Sprintf(
			`SELECT setval(pg_get_serial_sequence('%s','id'), COALESCE((SELECT MAX(id) FROM %s), 0) + 1, false)`,
			t.name, t.name,
		)
		var newval int64
		if err := pg.QueryRowContext(ctx, q).Scan(&newval); err != nil {
			return fmt.Errorf("setval %s: %w", t.name, err)
		}
	}
	return nil
}
