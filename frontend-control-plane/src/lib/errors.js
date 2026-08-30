// Centralized "what should the user see when a call fails" logic.
//
// The backend already sends friendly `error` strings for 4xx cases (and
// after 2026-08-24, a friendly generic for 5xx too — see
// backend/internal/api/helpers.go). This module fills the gaps:
//   1. Server returned nothing parseable (network drop, proxy 502, CORS).
//   2. Server returned a technical string that slipped through (defense
//      in depth — matches on obvious tech tokens and swaps in a safe
//      fallback).
//   3. Native fetch failures ("Failed to fetch", TypeError, etc.).
//
// Everything here is text-only — no branching logic, no re-throwing.
// Existing setErr(e.message) call sites keep working; they just see
// nicer copy.

// Copy pulled out so a designer can tweak wording without hunting through
// business logic. Keep sentences short + non-technical.
const COPY = {
  network:      'Cannot reach the server. Please check your internet connection and try again.',
  unauthorized: 'Your session has expired. Please sign in again.',
  forbidden:    "You don't have access to that.",
  notFound:     'That could not be found.',
  conflict:     'That conflicts with existing data. Please refresh and try again.',
  tooMany:      'Too many attempts. Please wait a moment and try again.',
  server:       'Something went wrong on our end. Please try again in a moment.',
  generic:      'Something went wrong. Please try again.',
}

// Substrings that indicate a message is technical/leaked — swap them
// for the safe generic. Case-insensitive. Kept small on purpose — the
// backend guard is the primary defense; this is a belt.
const TECH_TOKENS = [
  'sql', 'pgx', 'pq:', 'sqlstate', 'constraint',
  'violates', 'unique index', 'foreign key',
  'null value in column',
  'db error', 'db begin', 'db commit', 'db rollback',
  'db lookup', 'db update', 'db insert', 'db read', 'db list', 'db tx',
  'row scan', 'scan:', 'exec ',
  'panic', 'nil pointer',
  'http 5', 'http 4', 'internal server error',
]

// Returns true when the given string reads like server/driver output
// rather than user-facing copy.
function looksTechnical(s) {
  if (!s || typeof s !== 'string') return false
  const low = s.toLowerCase()
  return TECH_TOKENS.some((t) => low.includes(t))
}

// Map an HTTP status to friendly copy.
function copyForStatus(status) {
  if (status === 401) return COPY.unauthorized
  if (status === 403) return COPY.forbidden
  if (status === 404) return COPY.notFound
  if (status === 409) return COPY.conflict
  if (status === 429) return COPY.tooMany
  if (status >= 500)  return COPY.server
  return COPY.generic
}

// Given a raw error thrown by fetch/api/lib/*, return a string safe to
// show a non-technical user. Never throws; always returns a non-empty
// string. Preserves the original message on the error object (as
// `err.rawMessage`) for dev debugging.
export function toFriendlyError(err) {
  if (!err) return COPY.generic

  // Network / offline / DNS: fetch throws a TypeError with
  // "Failed to fetch" (Chrome/Edge) or "NetworkError" (Firefox).
  if (err.name === 'TypeError' && /fetch|network/i.test(err.message || '')) {
    return COPY.network
  }

  // ApiError shape (see lib/api.js) — has .status.
  const status = err.status
  const raw = err.message || ''
  const bodyErr = err.body?.error || ''

  // Prefer the server's message when it's clearly user-facing.
  const serverMsg = bodyErr || raw
  if (serverMsg && !looksTechnical(serverMsg) && !/^HTTP \d/i.test(serverMsg)) {
    return serverMsg
  }

  // Otherwise fall back to status-based copy.
  if (typeof status === 'number') return copyForStatus(status)
  return COPY.generic
}

// Convenience: attach `.userMessage` to an error in-place so a page
// can do `setErr(e.userMessage || e.message)` without importing this
// module. Not currently required (existing sites work as-is via api.js)
// but useful for handlers that want an explicit hook.
export function decorateError(err) {
  if (err && typeof err === 'object' && !err.userMessage) {
    try {
      Object.defineProperty(err, 'rawMessage', { value: err.message, enumerable: false })
      err.userMessage = toFriendlyError(err)
    } catch {}
  }
  return err
}
