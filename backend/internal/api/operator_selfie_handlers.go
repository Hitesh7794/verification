package api

import (
	"database/sql"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/veni/neet-verification/internal/db"
)

// Bounds for the operator's declared name + phone. Kept generous;
// the point is to reject empty / laughably-long inputs, not to
// validate against a country-specific phone format (the client is
// doing that in the form already).
const (
	operatorNameMaxLen  = 120
	operatorPhoneMaxLen = 32
)

// POST /api/operator/selfie — the Android app posts the operator's own
// selfie JPEG here on the new post-login "take your photo" screen.
//
// Body: raw image/jpeg bytes (application/octet-stream also accepted).
//   ≤ 2 MiB — the app compresses to ~50–150 KiB at 480 px, quality 85.
// Auth: client role only (verification agents).
// Storage: S3 key `operator-selfies/<user_id>.jpg`, overwritten on
//   every upload (latest wins — the DB row + S3 object are one-per-user).
// DB: upsert one row in operator_selfies (created by V31) recording the
//   S3 key + capture time.
//
// GET /api/operator/selfie — returns { captured_at, present } so the
// client can tell whether the operator has ever uploaded one. Bytes
// aren't returned here; presence is enough for the client's decide-
// whether-to-prompt logic.
//
// Additive endpoints — no existing route touches operator_selfies, and
// no existing flow reads the S3 key. Shipping is safe.

const (
	operatorSelfieMaxBytes = int64(2 * 1024 * 1024) // 2 MiB
	operatorSelfieMIME     = "image/jpeg"
)

type operatorSelfieResp struct {
	Present    bool   `json:"present"`
	CapturedAt string `json:"captured_at,omitempty"`
}

func (s *Server) postOperatorSelfie(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r)
	if c == nil || c.UserID == 0 {
		writeErr(w, http.StatusUnauthorized, "auth required")
		return
	}
	if s.storage == nil || !s.storage.Enabled() {
		writeErr(w, http.StatusServiceUnavailable, "photo storage not configured")
		return
	}

	// Read at most maxBytes+1 so we can distinguish "exactly max"
	// from "over max" without holding an unbounded body in memory.
	r.Body = http.MaxBytesReader(w, r.Body, operatorSelfieMaxBytes+1)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeErr(w, http.StatusRequestEntityTooLarge, "selfie too large or read failed: "+err.Error())
		return
	}
	if int64(len(body)) > operatorSelfieMaxBytes {
		writeErr(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("selfie exceeds %d bytes", operatorSelfieMaxBytes))
		return
	}
	if len(body) < 64 {
		writeErr(w, http.StatusBadRequest, "selfie body empty or too small to be a JPEG")
		return
	}

	// Optional declared identity — the Android post-login screen
	// asks the operator for their name + phone, and the client
	// sends both as headers so the JPEG body stays raw. Trimmed
	// and length-bounded here; empty values are stored as NULL so
	// a partial upload doesn't leave misleading "" strings.
	name := strings.TrimSpace(r.Header.Get("X-Operator-Name"))
	phone := strings.TrimSpace(r.Header.Get("X-Operator-Phone"))
	if len(name) > operatorNameMaxLen {
		writeErr(w, http.StatusBadRequest, "operator name too long")
		return
	}
	if len(phone) > operatorPhoneMaxLen {
		writeErr(w, http.StatusBadRequest, "operator phone too long")
		return
	}

	// Timestamped key so historical uploads survive in S3 — every
	// re-login writes a new object rather than overwriting the last
	// one. verifications rows snapshot this key at insert time so
	// the history screen renders the selfie the operator was
	// wearing when they did each check. Old <user_id>.jpg objects
	// from the V31-era single-key layout are read-only artefacts;
	// no cleanup needed (they're a few hundred KB apiece).
	key := fmt.Sprintf("operator-selfies/%d/%d.jpg", c.UserID, time.Now().UnixMilli())
	if err := s.storage.PutBiometric(r.Context(), key, body, operatorSelfieMIME); err != nil {
		writeErr(w, http.StatusInternalServerError, "s3 put: "+err.Error())
		return
	}

	// Store the identity as NULLs when blank so the column reads
	// as "not provided" rather than empty string. On conflict we
	// overwrite name/phone too — the operator is re-declaring
	// their identity along with the fresh photo.
	var (
		nameArg  interface{} = nil
		phoneArg interface{} = nil
	)
	if name != "" { nameArg = name }
	if phone != "" { phoneArg = phone }
	if _, err := s.deps.DB.ExecContext(r.Context(), db.Q(`
		INSERT INTO operator_selfies (user_id, s3_key, captured_at, name, phone)
		     VALUES (?, ?, NOW(), ?, ?)
		ON CONFLICT (user_id) DO UPDATE
		    SET s3_key      = EXCLUDED.s3_key,
		        captured_at = EXCLUDED.captured_at,
		        name        = EXCLUDED.name,
		        phone       = EXCLUDED.phone
	`), c.UserID, key, nameArg, phoneArg); err != nil {
		writeErr(w, http.StatusInternalServerError, "db upsert: "+err.Error())
		return
	}

	writeJSON(w, http.StatusOK, operatorSelfieResp{
		Present:    true,
		CapturedAt: time.Now().UTC().Format("2006-01-02T15:04:05Z"),
	})
}

func (s *Server) getOperatorSelfie(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r)
	if c == nil || c.UserID == 0 {
		writeErr(w, http.StatusUnauthorized, "auth required")
		return
	}
	var (
		key       string
		capturedAt time.Time
	)
	err := s.deps.DB.QueryRowContext(r.Context(), db.Q(
		`SELECT s3_key, captured_at FROM operator_selfies WHERE user_id = ?`,
	), c.UserID).Scan(&key, &capturedAt)
	if errors.Is(err, sql.ErrNoRows) {
		writeJSON(w, http.StatusOK, operatorSelfieResp{Present: false})
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, operatorSelfieResp{
		Present:    true,
		CapturedAt: capturedAt.UTC().Format("2006-01-02T15:04:05Z"),
	})
}

// GET /api/operator/selfies/bytes?key=<s3 key> — streams the JPEG
// bytes for a selfie the caller owns. The gate is a strict prefix
// check on the key: it must start with "operator-selfies/<user_id>/".
// That means a compromised token can only ever fetch its own
// selfies, and there's no path to enumerate other operators' photos.
// Used by the Android history screen to render each verification
// row's thumbnail + full-screen preview.
func (s *Server) getOperatorSelfieBytes(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r)
	if c == nil || c.UserID == 0 {
		writeErr(w, http.StatusUnauthorized, "auth required")
		return
	}
	if s.storage == nil || !s.storage.Enabled() {
		writeErr(w, http.StatusServiceUnavailable, "photo storage not configured")
		return
	}
	key := strings.TrimSpace(r.URL.Query().Get("key"))
	if key == "" {
		writeErr(w, http.StatusBadRequest, "key query param required")
		return
	}
	// Strict prefix — allow both the V33+ per-upload keys
	// (operator-selfies/<uid>/<ms>.jpg) and the V31-era single-key
	// artefacts (operator-selfies/<uid>.jpg). Any key not in the
	// caller's namespace is a 403 regardless of the actual S3
	// object's existence.
	prefixDir  := fmt.Sprintf("operator-selfies/%d/", c.UserID)
	prefixFile := fmt.Sprintf("operator-selfies/%d.jpg", c.UserID)
	if !strings.HasPrefix(key, prefixDir) && key != prefixFile {
		writeErr(w, http.StatusForbidden, "not your selfie")
		return
	}
	bytes, err := s.storage.GetDocBytes(r.Context(), s.storage.URI(key))
	if err != nil {
		writeErr(w, http.StatusNotFound, "selfie not found")
		return
	}
	w.Header().Set("Content-Type", operatorSelfieMIME)
	w.Header().Set("Cache-Control", "private, max-age=86400")
	_, _ = w.Write(bytes)
}
