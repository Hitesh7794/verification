package db

import (
	"strconv"
	"strings"
)

// Q rewrites a SQLite-style '?' placeholder query into the Postgres
// '$N' placeholder form. Used at every callsite that BUILDS its SQL
// dynamically (WHERE clauses composed conditionally, IN (...) lists
// with a variable arg count, etc). Static SQL literals were rewritten
// once at migration time and pass through Q as no-ops.
//
// The rewrite is naive on purpose: it walks byte-by-byte and skips
// characters inside single-quoted string literals (so a literal '?'
// in SQL text is not counted as a placeholder). It does NOT try to
// handle Postgres-specific casts like '?::int' — callers can put the
// cast after the parameter, e.g. `$1::int`, after rebinding.
//
// Cost: a couple of allocations per query, dwarfed by network + DB
// latency. If it ever shows up in a profile we can memoise per string
// via a sync.Map.
func Q(sql string) string {
	if !strings.ContainsRune(sql, '?') {
		return sql
	}
	var out strings.Builder
	out.Grow(len(sql) + 8)
	n := 0
	inQuote := false
	for i := 0; i < len(sql); i++ {
		c := sql[i]
		if c == '\'' {
			if inQuote && i+1 < len(sql) && sql[i+1] == '\'' {
				out.WriteByte('\'')
				out.WriteByte('\'')
				i++
				continue
			}
			inQuote = !inQuote
			out.WriteByte(c)
			continue
		}
		if c == '?' && !inQuote {
			n++
			out.WriteByte('$')
			out.WriteString(strconv.Itoa(n))
			continue
		}
		out.WriteByte(c)
	}
	return out.String()
}
