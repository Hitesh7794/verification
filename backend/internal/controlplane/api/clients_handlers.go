package api

// Clients registry CRUD — the Control Plane's authoritative list of
// every Data Plane it knows about (name, api_url, api_key,
// kyc_review_mode, status). Phase 2D of the multi-tenant migration.
//
// The `api_key` field is the shared secret this Control Plane
// presents in the X-Internal-API-Key header when calling that Data
// Plane's /internal/* surface. It's generated server-side at create
// time so the operator can't accidentally pick a weak value, and
// echoed ONCE in the create response. Never re-read after that (the
// list + get endpoints redact it), so if the operator loses the value
// they rotate via PATCH — same as any other one-shot secret.

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

// clientRow is the JSON shape returned by GET endpoints. api_key
// stays out on purpose — see the file-level comment above.
type clientRow struct {
	ID              int64     `json:"id"`
	Name            string    `json:"name"`
	KYCReviewMode   string    `json:"kyc_review_mode"`
	Status          string    `json:"status"`
	APIURL          string    `json:"api_url"`
	Notes           string    `json:"notes,omitempty"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

// ── GET /api/superadmin/clients ──────────────────────────────────

func (s *Server) listClients(w http.ResponseWriter, r *http.Request) {
	rows, err := s.deps.DB.QueryContext(r.Context(), `
		SELECT id, name, kyc_review_mode, status, api_url, COALESCE(notes,''),
		       created_at, updated_at
		  FROM clients_registry
		 WHERE status <> 'deleted'
		 ORDER BY created_at DESC`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	defer rows.Close()

	out := []clientRow{}
	for rows.Next() {
		var c clientRow
		if err := rows.Scan(&c.ID, &c.Name, &c.KYCReviewMode, &c.Status,
			&c.APIURL, &c.Notes, &c.CreatedAt, &c.UpdatedAt); err != nil {
			writeErr(w, http.StatusInternalServerError, "row scan: "+err.Error())
			return
		}
		out = append(out, c)
	}
	writeJSON(w, http.StatusOK, map[string]any{"clients": out})
}

// ── GET /api/superadmin/clients/{id} ─────────────────────────────

func (s *Server) getClient(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	var c clientRow
	err = s.deps.DB.QueryRowContext(r.Context(), `
		SELECT id, name, kyc_review_mode, status, api_url, COALESCE(notes,''),
		       created_at, updated_at
		  FROM clients_registry
		 WHERE id = $1 AND status <> 'deleted'`, id,
	).Scan(&c.ID, &c.Name, &c.KYCReviewMode, &c.Status, &c.APIURL, &c.Notes,
		&c.CreatedAt, &c.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "client not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, c)
}

// ── POST /api/superadmin/clients ─────────────────────────────────
//
// Creates a new client + generates its api_key. The api_key is
// echoed ONCE in the response and never returned again — the
// superadmin must copy it into the target Data Plane's .env as
// INTERNAL_API_KEY before that Data Plane will accept /internal/*
// calls from this Control Plane.

type createClientReq struct {
	Name          string `json:"name"`
	KYCReviewMode string `json:"kyc_review_mode"` // default 'admin'
	APIURL        string `json:"api_url"`
	Notes         string `json:"notes"`
}

type createClientResp struct {
	ID     int64  `json:"id"`
	Name   string `json:"name"`
	APIURL string `json:"api_url"`
	// APIKey is echoed ONCE — surface it in the FE with a copy-to-
	// clipboard affordance because no subsequent read returns it.
	APIKey string `json:"api_key"`
}

func (s *Server) createClient(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	var req createClientReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	name := strings.TrimSpace(req.Name)
	if len(name) < 2 || len(name) > 200 {
		writeErr(w, http.StatusBadRequest, "name required (2-200 chars)")
		return
	}
	// Trailing slash trimmed so federated calls can concatenate
	// paths ("api_url + /api/internal/metrics") without producing
	// a double slash that some middleware normalises weirdly.
	apiURL := strings.TrimRight(strings.TrimSpace(req.APIURL), "/")
	if apiURL == "" {
		writeErr(w, http.StatusBadRequest, "api_url required")
		return
	}
	if !strings.HasPrefix(apiURL, "http://") && !strings.HasPrefix(apiURL, "https://") {
		writeErr(w, http.StatusBadRequest, "api_url must start with http:// or https://")
		return
	}
	mode := strings.TrimSpace(req.KYCReviewMode)
	switch mode {
	case "", "admin":
		mode = "admin"
	case "client", "both":
		// ok
	default:
		writeErr(w, http.StatusBadRequest, "kyc_review_mode must be admin, client, or both")
		return
	}

	// 32-byte hex secret → 64 chars. Long enough that brute force
	// isn't a concern; short enough to paste into .env comfortably.
	apiKey, err := generateAPIKey()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "keygen: "+err.Error())
		return
	}

	var id int64
	err = s.deps.DB.QueryRowContext(r.Context(), `
		INSERT INTO clients_registry(name, kyc_review_mode, status, api_url, api_key, notes)
		VALUES ($1, $2, 'active', $3, $4, $5)
		RETURNING id`,
		name, mode, apiURL, apiKey, nullable(strings.TrimSpace(req.Notes)),
	).Scan(&id)
	if err != nil {
		// UNIQUE (name) violation is the common one — surface as 409.
		if strings.Contains(err.Error(), "unique") {
			writeErr(w, http.StatusConflict, "a client with that name already exists")
			return
		}
		writeErr(w, http.StatusInternalServerError, "insert: "+err.Error())
		return
	}
	log.Printf("cp: created client id=%d name=%s api_url=%s", id, name, apiURL)
	writeJSON(w, http.StatusCreated, createClientResp{
		ID:     id,
		Name:   name,
		APIURL: apiURL,
		APIKey: apiKey,
	})
}

// ── PATCH /api/superadmin/clients/{id} ───────────────────────────
//
// Partial update. Any subset of {name, kyc_review_mode, status,
// api_url, notes, rotate_api_key} allowed. rotate_api_key=true
// generates a fresh api_key and echoes it once in the response —
// same semantics as create-time key generation.

type patchClientReq struct {
	Name           *string `json:"name,omitempty"`
	KYCReviewMode  *string `json:"kyc_review_mode,omitempty"`
	Status         *string `json:"status,omitempty"`
	APIURL         *string `json:"api_url,omitempty"`
	Notes          *string `json:"notes,omitempty"`
	RotateAPIKey   bool    `json:"rotate_api_key,omitempty"`
}

func (s *Server) patchClient(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	var req patchClientReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}

	sets := []string{}
	args := []any{}
	if req.Name != nil {
		n := strings.TrimSpace(*req.Name)
		if len(n) < 2 || len(n) > 200 {
			writeErr(w, http.StatusBadRequest, "name must be 2-200 chars")
			return
		}
		sets = append(sets, fmt.Sprintf("name = $%d", len(args)+1))
		args = append(args, n)
	}
	if req.KYCReviewMode != nil {
		m := strings.TrimSpace(*req.KYCReviewMode)
		if m != "admin" && m != "client" && m != "both" {
			writeErr(w, http.StatusBadRequest, "kyc_review_mode must be admin, client, or both")
			return
		}
		sets = append(sets, fmt.Sprintf("kyc_review_mode = $%d", len(args)+1))
		args = append(args, m)
	}
	if req.Status != nil {
		st := strings.TrimSpace(*req.Status)
		if st != "active" && st != "suspended" && st != "deleted" {
			writeErr(w, http.StatusBadRequest, "status must be active, suspended, or deleted")
			return
		}
		sets = append(sets, fmt.Sprintf("status = $%d", len(args)+1))
		args = append(args, st)
	}
	if req.APIURL != nil {
		u := strings.TrimRight(strings.TrimSpace(*req.APIURL), "/")
		if !strings.HasPrefix(u, "http://") && !strings.HasPrefix(u, "https://") {
			writeErr(w, http.StatusBadRequest, "api_url must start with http:// or https://")
			return
		}
		sets = append(sets, fmt.Sprintf("api_url = $%d", len(args)+1))
		args = append(args, u)
	}
	if req.Notes != nil {
		sets = append(sets, fmt.Sprintf("notes = $%d", len(args)+1))
		args = append(args, nullable(strings.TrimSpace(*req.Notes)))
	}

	var freshKey string
	if req.RotateAPIKey {
		k, err := generateAPIKey()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "keygen: "+err.Error())
			return
		}
		freshKey = k
		sets = append(sets, fmt.Sprintf("api_key = $%d", len(args)+1))
		args = append(args, k)
	}

	if len(sets) == 0 {
		writeErr(w, http.StatusBadRequest, "nothing to update")
		return
	}

	sets = append(sets, "updated_at = NOW()")
	args = append(args, id)
	q := fmt.Sprintf(`UPDATE clients_registry SET %s WHERE id = $%d`,
		strings.Join(sets, ", "), len(args))

	res, err := s.deps.DB.ExecContext(r.Context(), q, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "update: "+err.Error())
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeErr(w, http.StatusNotFound, "client not found")
		return
	}

	resp := map[string]any{"ok": true}
	if freshKey != "" {
		// New api_key echoed once — same rule as create-time.
		resp["api_key"] = freshKey
	}
	writeJSON(w, http.StatusOK, resp)
}

// ── DELETE /api/superadmin/clients/{id} ──────────────────────────
// Soft-delete: sets status='deleted'. Audit trail preserved, the
// row disappears from list / get / federated-fan-out.

func (s *Server) deleteClient(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	res, err := s.deps.DB.ExecContext(r.Context(),
		`UPDATE clients_registry SET status = 'deleted', updated_at = NOW() WHERE id = $1`, id,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "delete: "+err.Error())
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeErr(w, http.StatusNotFound, "client not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ── helpers ─────────────────────────────────────────────────────

// generateAPIKey mints a 32-byte crypto-random secret hex-encoded to
// 64 chars. Not JWT — this is a shared symmetric secret carried in
// the X-Internal-API-Key header.
func generateAPIKey() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// nullable converts an empty string to sql.NullString{Valid:false}
// so we can INSERT NULL instead of an empty string into TEXT columns
// where NULL carries meaning (e.g. "no notes yet"). Non-empty
// strings pass through as Valid=true.
func nullable(s string) sql.NullString {
	if s == "" {
		return sql.NullString{}
	}
	return sql.NullString{String: s, Valid: true}
}
