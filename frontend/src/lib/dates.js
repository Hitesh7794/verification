// Date formatting helpers shared across the catalog screens.
//
// The backend stores verification windows in SQLite DATE columns but
// Go's encoding/json marshals them through time.Time, so they arrive
// as full RFC 3339 timestamps: "2026-08-06T00:00:00Z". The time half is
// always midnight UTC and carries no information — these are calendar
// dates, not instants — so rendering it just adds noise to the table.

// dateOnly strips the time component from an RFC 3339 timestamp.
//
//   "2026-08-06T00:00:00Z"  →  "2026-08-06"
//   "2026-08-06"            →  "2026-08-06"   (already date-only)
//   null / "" / undefined   →  ""
//
// Implemented as a string cut rather than `new Date(s).toISOString()`
// on purpose: parsing through Date would re-interpret the value in the
// browser's timezone, and any backend value that ever arrives without a
// trailing Z would shift by a day for anyone east or west of UTC.
export function dateOnly(value) {
  if (!value) return ''
  const s = String(value)
  const t = s.indexOf('T')
  return t === -1 ? s : s.slice(0, t)
}

// dateRange renders a verification window as "from - to".
// Falls back gracefully when only one end is present.
export function dateRange(from, to, separator = ' - ') {
  const a = dateOnly(from)
  const b = dateOnly(to)
  if (a && b) return `${a}${separator}${b}`
  return a || b || ''
}
