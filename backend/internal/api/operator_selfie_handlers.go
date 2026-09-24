package api

import (
	"database/sql"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/veni/neet-verification/internal/db"
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

	key := fmt.Sprintf("operator-selfies/%d.jpg", c.UserID)
	if err := s.storage.PutBiometric(r.Context(), key, body, operatorSelfieMIME); err != nil {
		writeErr(w, http.StatusInternalServerError, "s3 put: "+err.Error())
		return
	}

	if _, err := s.deps.DB.ExecContext(r.Context(), db.Q(`
		INSERT INTO operator_selfies (user_id, s3_key, captured_at)
		     VALUES (?, ?, NOW())
		ON CONFLICT (user_id) DO UPDATE
		    SET s3_key      = EXCLUDED.s3_key,
		        captured_at = EXCLUDED.captured_at
	`), c.UserID, key); err != nil {
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
