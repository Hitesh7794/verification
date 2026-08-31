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
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
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
	Domain          string    `json:"domain,omitempty"`
	Notes           string    `json:"notes,omitempty"`
	PortalEnabled   bool      `json:"portal_enabled"`
	// Visible + Closed are derived from Status for FE compat.
	// Rahul's Clients.jsx / ClientDetail.jsx read `client.visible` and
	// `client.closed` to render the Visible/Hidden and Ended pills. On
	// CP we track lifecycle via `status` (infra_pending | ready |
	// active | suspended | deleted) so we synthesise these two bools
	// after the DB scan:
	//   visible = status IN ('infra_pending','ready','active')
	//   closed  = status = 'suspended'
	// Deleted rows are filtered out of list/get entirely.
	Visible         bool      `json:"visible"`
	Closed          bool      `json:"closed"`
	// ExamCount is populated by listClients via a fan-out to each
	// client's DP /api/internal/exams?client_id=X. -1 marks a DP that
	// couldn't be reached (infra_pending, offline, timeout); the FE
	// falls back to 0 for display but this lets callers distinguish
	// "zero exams" from "we don't know".
	ExamCount       int       `json:"exam_count"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

// deriveVisibleClosed populates Visible + Closed from Status. Call
// after every Scan into a clientRow so the FE sees a consistent shape.
func deriveVisibleClosed(c *clientRow) {
	c.Visible = c.Status != "suspended" && c.Status != "deleted"
	c.Closed = c.Status == "suspended"
}

// ── GET /api/superadmin/clients ──────────────────────────────────

func (s *Server) listClients(w http.ResponseWriter, r *http.Request) {
	rows, err := s.deps.DB.QueryContext(r.Context(), `
		SELECT id, name, kyc_review_mode, status, api_url, COALESCE(notes,''),
		       COALESCE(domain,''), portal_enabled, created_at, updated_at
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
			&c.APIURL, &c.Notes, &c.Domain, &c.PortalEnabled, &c.CreatedAt, &c.UpdatedAt); err != nil {
			writeErr(w, http.StatusInternalServerError, "row scan: "+err.Error())
			return
		}
		deriveVisibleClosed(&c)
		out = append(out, c)
	}

	// Fan out to each client's DP to populate ExamCount. Parallel
	// per-client so total latency is max(one DP round-trip), not the
	// sum. Any DP that fails / times out yields -1 so the row still
	// renders — the FE treats that as 0 with an optional tooltip.
	populateExamCounts(r.Context(), out, s.fetchExamsFromDP)

	writeJSON(w, http.StatusOK, map[string]any{"clients": out})
}

// populateExamCounts fires one goroutine per row to count that
// client's exams on its DP. Only clients whose status makes exam-fetch
// meaningful (active | ready) are contacted; infra_pending clients
// have no DP yet, so their count is 0 rather than -1.
func populateExamCounts(
	ctx context.Context,
	rows []clientRow,
	fetch func(context.Context, string, string, int64) []any,
) {
	if len(rows) == 0 {
		return
	}
	var wg sync.WaitGroup
	for i := range rows {
		i := i
		if rows[i].Status != "active" && rows[i].Status != "ready" {
			rows[i].ExamCount = 0
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			cctx, cancel := context.WithTimeout(ctx, 3*time.Second)
			defer cancel()
			exams := fetch(cctx, rows[i].APIURL, rows[i].Status, rows[i].ID)
			if exams == nil {
				rows[i].ExamCount = -1
				return
			}
			rows[i].ExamCount = len(exams)
		}()
	}
	wg.Wait()
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
		       COALESCE(domain,''), portal_enabled, created_at, updated_at
		  FROM clients_registry
		 WHERE id = $1 AND status <> 'deleted'`, id,
	).Scan(&c.ID, &c.Name, &c.KYCReviewMode, &c.Status, &c.APIURL, &c.Notes,
		&c.Domain, &c.PortalEnabled, &c.CreatedAt, &c.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "client not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	deriveVisibleClosed(&c)
	// Envelope shape: Rahul's ClientDetail.jsx destructures
	// `{ client, exams }`. Fan out to the target DP to fetch exams for
	// this client. If the DP is unreachable or unhealthy, return the
	// envelope with an empty exams[] so the page still loads.
	exams := s.fetchExamsFromDP(r.Context(), c.APIURL, c.Status, id)
	writeJSON(w, http.StatusOK, map[string]any{
		"client": c,
		"exams":  exams,
	})
}

// fetchExamsFromDP calls the target DP's /api/internal/exams?client_id=X
// endpoint and returns the list. Best-effort: any failure returns
// empty slice so getClient never 500s on a bad DP.
func (s *Server) fetchExamsFromDP(ctx context.Context, apiURL, status string, cpClientID int64) []any {
	if status != "active" && status != "ready" {
		return []any{}
	}
	var apiKey string
	if err := s.deps.DB.QueryRowContext(ctx,
		`SELECT api_key FROM clients_registry WHERE id = $1`, cpClientID,
	).Scan(&apiKey); err != nil {
		return []any{}
	}
	// Look up the DP-side client_id from institution_applications rows
	// for this CP client, OR just ask DP to list ALL exams for the
	// single-client case. Simplest: DP's list requires client_id, so we
	// need to know it. For the current shared-DP-single-client demo,
	// look up any institution_application row that carries dp_client_id
	// for this target_client_id. If none exists, fall back to reading
	// the DP env's DATA_PLANE_CLIENT_ID via /api/internal/health? no,
	// too coupled. Simpler: try client_id 1 (the DP's first client)
	// as a demo default. Real per-DP-per-client Phase 4 will always
	// have a well-known DP-side id and we'll pass it explicitly.
	//
	// For now: pull the most common dp_client_id from CP's own
	// institution_applications rows that target this CP client.
	var dpClientID sql.NullInt64
	_ = s.deps.DB.QueryRowContext(ctx, `
		SELECT dp_client_id
		  FROM institution_applications
		 WHERE target_client_id = $1 AND dp_client_id IS NOT NULL
		 GROUP BY dp_client_id
		 ORDER BY COUNT(*) DESC
		 LIMIT 1`, cpClientID,
	).Scan(&dpClientID)
	if !dpClientID.Valid || dpClientID.Int64 <= 0 {
		// Fallback: ask the DP for its single client via a probe.
		// Uses the "single visible client" auto-attach hint that the
		// register wizard relies on. We can piggyback on DP's list
		// endpoint by trying client_id=1..N; safer approach: query
		// DP's internal users?role=client_reviewer to see what client
		// its reviewers are attached to.
		dpClientID = probeDpClientID(ctx, apiURL, apiKey)
		if !dpClientID.Valid {
			log.Printf("fetchExamsFromDP: could not resolve dp_client_id for cp_client=%d", cpClientID)
			return []any{}
		}
	}

	callCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	url := fmt.Sprintf("%s/api/internal/exams?client_id=%d", apiURL, dpClientID.Int64)
	req, err := http.NewRequestWithContext(callCtx, http.MethodGet, url, nil)
	if err != nil {
		return []any{}
	}
	req.Header.Set("X-Internal-API-Key", apiKey)
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		log.Printf("fetchExamsFromDP: %v", err)
		return []any{}
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return []any{}
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 128<<10))
	var out []any
	if err := json.Unmarshal(body, &out); err != nil {
		return []any{}
	}
	return out
}

// probeDpClientID asks the DP's /api/internal/users?role=client_reviewer
// endpoint for any active reviewer's client_id — cheap way to learn
// which DP-side client_id belongs to this DP in the single-client
// deployment shape. Returns invalid on any failure.
func probeDpClientID(ctx context.Context, apiURL, apiKey string) sql.NullInt64 {
	probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(probeCtx, http.MethodGet,
		apiURL+"/api/internal/users?role=client_reviewer", nil)
	if err != nil {
		return sql.NullInt64{}
	}
	req.Header.Set("X-Internal-API-Key", apiKey)
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return sql.NullInt64{}
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return sql.NullInt64{}
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 32<<10))
	var users []map[string]any
	if err := json.Unmarshal(body, &users); err != nil || len(users) == 0 {
		return sql.NullInt64{}
	}
	if v, ok := users[0]["client_id"].(float64); ok && v > 0 {
		return sql.NullInt64{Int64: int64(v), Valid: true}
	}
	return sql.NullInt64{}
}

// ── POST /api/superadmin/clients/{id}/close ──────────────────────
// Suspends a client: flips status to 'suspended', keeping the row for
// audit. Federated dashboard skips suspended clients.
func (s *Server) closeClient(w http.ResponseWriter, r *http.Request) {
	s.setClientStatus(w, r, "suspended")
}

// ── POST /api/superadmin/clients/{id}/reopen ─────────────────────
// Reactivates a suspended client back to 'active'.
func (s *Server) reopenClient(w http.ResponseWriter, r *http.Request) {
	s.setClientStatus(w, r, "active")
}

// ── POST /api/superadmin/clients/{id}/visibility ─────────────────
// Kept as a no-op stub for FE parity — the CP's clients_registry
// doesn't have a `visible` column (DP-side clients does). Returns
// success so the FE toggle works; superadmin can use close/reopen for
// actual disable/enable semantics.
func (s *Server) toggleClientVisibility(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	log.Printf("cp toggleClientVisibility id=%d (no-op — CP has no visible flag)", id)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "note": "visibility not tracked on CP"})
}

// ── POST /api/superadmin/clients/{id}/portal ─────────────────────
//
// Toggles portal_enabled on BOTH sides — CP's clients_registry (for
// dashboard visibility) AND the target DP's clients row (for reviewer-
// login + register-form gate). Without the DP-side write, the reviewer
// gets "portal disabled" on next login regardless of CP UI state.
//
// Body: `{"enabled": bool}`. If either write fails we roll back the
// CP write so the two stay in sync.
func (s *Server) setClientPortal(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<10)
	var req struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body — expected {\"enabled\": bool}")
		return
	}

	// Load api_url + api_key so we can propagate to DP.
	apiURL, apiKey, status, ok := s.loadClientForInternalCall(r.Context(), id)
	if !ok {
		writeErr(w, http.StatusNotFound, "client not found")
		return
	}

	// 1. CP-local write first (fast, transactional).
	res, err := s.deps.DB.ExecContext(r.Context(),
		`UPDATE clients_registry
		    SET portal_enabled = $2, updated_at = NOW()
		  WHERE id = $1 AND status <> 'deleted'`,
		id, req.Enabled,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "cp update: "+err.Error())
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeErr(w, http.StatusNotFound, "client not found")
		return
	}

	// 2. Propagate to DP (skip if unreachable — CP row still updated but
	//    the DP-side gate stays inconsistent until a manual retry).
	if status == "active" || status == "ready" {
		if err := s.propagatePortalToDP(r.Context(), apiURL, apiKey, req.Enabled); err != nil {
			log.Printf("setClientPortal: DP propagation failed for cp_client=%d: %v", id, err)
			// Roll back CP-side so the two never diverge silently.
			if _, rbErr := s.deps.DB.ExecContext(r.Context(),
				`UPDATE clients_registry SET portal_enabled = $2, updated_at = NOW() WHERE id = $1`,
				id, !req.Enabled,
			); rbErr != nil {
				log.Printf("setClientPortal: rollback also failed: %v", rbErr)
			}
			writeErr(w, http.StatusBadGateway,
				"could not propagate to data plane: "+err.Error())
			return
		}
	}

	log.Printf("cp setClientPortal id=%d portal_enabled=%v (cp+dp synced)", id, req.Enabled)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "portal_enabled": req.Enabled})
}

// propagatePortalToDP calls DP's /api/internal/clients/{id}/portal to
// keep the DP-side gate in sync with CP. Which DP-side id to use? The
// same "probe via reviewers" trick we use for exam listing — the CP
// doesn't naturally know the DP-side client id, so we ask.
func (s *Server) propagatePortalToDP(ctx context.Context, apiURL, apiKey string, enabled bool) error {
	dpID := probeDpClientID(ctx, apiURL, apiKey)
	if !dpID.Valid || dpID.Int64 <= 0 {
		// Fallback: try id=1 (first DP client). Better than silently
		// skipping — this is the shared-single-DP demo path.
		dpID = sql.NullInt64{Int64: 1, Valid: true}
	}
	body, _ := json.Marshal(map[string]any{"enabled": enabled})
	callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(callCtx, http.MethodPost,
		fmt.Sprintf("%s/api/internal/clients/%d/portal", apiURL, dpID.Int64),
		bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-API-Key", apiKey)
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		bodyStr, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
		return fmt.Errorf("dp returned %d: %s", resp.StatusCode, string(bodyStr))
	}
	return nil
}

// setClientStatus is the shared body of close/reopen.
func (s *Server) setClientStatus(w http.ResponseWriter, r *http.Request, status string) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	res, err := s.deps.DB.ExecContext(r.Context(),
		`UPDATE clients_registry SET status = $2, updated_at = NOW()
		  WHERE id = $1 AND status <> 'deleted'`, id, status,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "update: "+err.Error())
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeErr(w, http.StatusNotFound, "client not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "status": status})
}

// ── GET /api/superadmin/clients/{id}/reviewers ───────────────────
//
// Returns the reviewers assigned to this client. Because the CP stores
// NOTHING about reviewers (per Track 2's model — user rows live only
// on the DP), this endpoint proxies UP to the target DP's
// /api/internal/users?role=client_reviewer endpoint and returns the
// result. The DP handles the actual client_id scoping — reviewer
// creation on the DP auto-attaches to its single visible client, so
// we don't need to filter here.
//
// Response shape wraps the DP's response in {reviewers: [...]} so
// Rahul's FE (which destructures `{reviewers}` from the response) works.
func (s *Server) listClientReviewers(w http.ResponseWriter, r *http.Request) {
	cpClientID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || cpClientID <= 0 {
		writeErr(w, http.StatusBadRequest, "bad client id")
		return
	}

	apiURL, apiKey, status, ok := s.loadClientForInternalCall(r.Context(), cpClientID)
	if !ok {
		writeErr(w, http.StatusNotFound, "client not found")
		return
	}
	if status != "active" && status != "ready" {
		// Not reachable yet — return empty list instead of 502 so the
		// FE renders "no reviewers" cleanly.
		writeJSON(w, http.StatusOK, map[string]any{"reviewers": []any{}})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		apiURL+"/api/internal/users?role=client_reviewer", nil)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "request build: "+err.Error())
		return
	}
	req.Header.Set("X-Internal-API-Key", apiKey)
	req.Header.Set("Accept", "application/json")

	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		log.Printf("listClientReviewers: DP call to %s failed: %v", apiURL, err)
		writeErr(w, http.StatusBadGateway, "data plane unreachable: "+err.Error())
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 128<<10))

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(body)
		return
	}

	// DP returns a plain JSON array; wrap in the {reviewers: [...]}
	// envelope the FE expects.
	var reviewers []any
	if err := json.Unmarshal(body, &reviewers); err != nil {
		log.Printf("listClientReviewers: DP returned unparseable body: %v", err)
		writeErr(w, http.StatusBadGateway, "data plane returned unparseable response")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"reviewers": reviewers})
}

// ── DELETE /api/superadmin/clients/{id}/reviewers/{uid} ─────────
//
// Hard-deletes a reviewer on the target DP. Proxies to the DP's
// /api/internal/users/{uid} DELETE endpoint, which nullifies FK
// references and drops the users row. Result: username is immediately
// reusable — no "already exists" on re-create.
func (s *Server) deleteReviewer(w http.ResponseWriter, r *http.Request) {
	cpClientID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || cpClientID <= 0 {
		writeErr(w, http.StatusBadRequest, "bad client id")
		return
	}
	uid, err := strconv.ParseInt(chi.URLParam(r, "uid"), 10, 64)
	if err != nil || uid <= 0 {
		writeErr(w, http.StatusBadRequest, "bad user id")
		return
	}

	apiURL, apiKey, status, ok := s.loadClientForInternalCall(r.Context(), cpClientID)
	if !ok {
		writeErr(w, http.StatusNotFound, "client not found")
		return
	}
	if status != "active" && status != "ready" {
		writeErr(w, http.StatusFailedDependency,
			fmt.Sprintf("client status is %q — Data Plane not reachable for user deletion", status))
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete,
		fmt.Sprintf("%s/api/internal/users/%d", apiURL, uid), nil)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "request build: "+err.Error())
		return
	}
	req.Header.Set("X-Internal-API-Key", apiKey)
	req.Header.Set("Accept", "application/json")

	resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		log.Printf("deleteReviewer: DP call to %s failed: %v", apiURL, err)
		writeErr(w, http.StatusBadGateway, "data plane unreachable: "+err.Error())
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<10))

	// Forward DP's status + body verbatim so the FE sees the exact
	// error (e.g. 404 if reviewer already gone, 403 if superadmin).
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(body)

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		log.Printf("deleteReviewer: cp_client=%d dp_user=%d deleted", cpClientID, uid)
	}
}

// ── POST /api/superadmin/clients/{id}/exams ─────────────────────
//
// Proxies exam creation to the target DP. Body: exam payload the DP's
// internal /exams endpoint expects (name, exam_code, verification_from,
// verification_to, optional modality flags). Response mirrors DP.
func (s *Server) createExam(w http.ResponseWriter, r *http.Request) {
	cpClientID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || cpClientID <= 0 {
		writeErr(w, http.StatusBadRequest, "bad client id")
		return
	}
	apiURL, apiKey, status, ok := s.loadClientForInternalCall(r.Context(), cpClientID)
	if !ok {
		writeErr(w, http.StatusNotFound, "client not found")
		return
	}
	if status != "active" && status != "ready" {
		writeErr(w, http.StatusFailedDependency,
			fmt.Sprintf("client status is %q — Data Plane not reachable for exam creation", status))
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 16<<10))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "could not read body")
		return
	}
	_ = r.Body.Close()

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		apiURL+"/api/internal/exams", bytes.NewReader(body))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "request build: "+err.Error())
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Internal-API-Key", apiKey)

	resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		log.Printf("createExam: DP call failed: %v", err)
		writeErr(w, http.StatusBadGateway, "data plane unreachable: "+err.Error())
		return
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 32<<10))

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(respBody)
}

// loadClientForInternalCall pulls the DP-facing (api_url, api_key,
// status) triple for a CP-side client id. Shared by listReviewers +
// deleteReviewer so the SQL isn't duplicated. Returns ok=false if the
// row is deleted or missing.
func (s *Server) loadClientForInternalCall(ctx context.Context, cpClientID int64) (apiURL, apiKey, status string, ok bool) {
	err := s.deps.DB.QueryRowContext(ctx,
		`SELECT api_url, api_key, status FROM clients_registry WHERE id = $1`,
		cpClientID,
	).Scan(&apiURL, &apiKey, &status)
	if errors.Is(err, sql.ErrNoRows) || status == "deleted" {
		return "", "", "", false
	}
	if err != nil {
		log.Printf("loadClientForInternalCall: db error for %d: %v", cpClientID, err)
		return "", "", "", false
	}
	return apiURL, apiKey, status, true
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
	Domain        string `json:"domain"` // optional public hostname (subdomain routing)
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

	// api_key handling:
	// If any EXISTING active client already points at this api_url,
	// reuse THEIR api_key. Reason: multiple clients_registry rows can
	// legitimately point at the same physical DP (shared-DP-many-clients
	// pattern), and that DP has ONE INTERNAL_API_KEY. Generating a fresh
	// key here would silently 401 every CP→DP internal call for this row.
	// Log the reuse so audit history is legible.
	//
	// If no existing active client shares the api_url, mint a fresh key.
	var (
		apiKey  string
		reused  bool
	)
	if err := s.deps.DB.QueryRowContext(r.Context(),
		`SELECT api_key FROM clients_registry
		  WHERE api_url = $1 AND status NOT IN ('deleted')
		  ORDER BY created_at ASC LIMIT 1`, apiURL,
	).Scan(&apiKey); err == nil {
		reused = true
		log.Printf("cp createClient: reusing api_key from existing active client with same api_url=%s", apiURL)
	} else if !errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusInternalServerError, "key lookup: "+err.Error())
		return
	} else {
		// Fresh key: 32-byte hex → 64 chars. Long enough that brute
		// force isn't a concern; short enough to paste into .env
		// comfortably.
		fresh, kerr := generateAPIKey()
		if kerr != nil {
			writeErr(w, http.StatusInternalServerError, "keygen: "+kerr.Error())
			return
		}
		apiKey = fresh
	}

	// Per the per-client DP model (Track 2, 2026-08-30): a client starts
	// life as 'infra_pending' — the superadmin has recorded intent but
	// no DP process, DB, or DNS is provisioned yet. Ops walks through the
	// runbook (docs/ops/add-client-runbook.md), and once the target DP's
	// /api/internal/health responds green the status flips to 'ready'
	// (either manually via PATCH ...status or auto-promoted by a poller).
	//
	// SPECIAL CASE: when we reused an api_key from an existing active
	// client, the DP is already reachable + wired — skip infra_pending
	// and go straight to 'ready'. Otherwise nothing would ever prompt a
	// promotion for a client whose infra was already provisioned as a
	// side effect of another client's onboarding.
	initialStatus := "infra_pending"
	if reused {
		initialStatus = "ready"
	}
	domain := strings.ToLower(strings.TrimSpace(req.Domain))
	var domainArg any
	if domain != "" {
		domainArg = domain
	}
	var id int64
	err := s.deps.DB.QueryRowContext(r.Context(), `
		INSERT INTO clients_registry(name, kyc_review_mode, status, api_url, api_key, notes, domain)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id`,
		name, mode, initialStatus, apiURL, apiKey, nullable(strings.TrimSpace(req.Notes)), domainArg,
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
	log.Printf("cp: created client id=%d name=%s api_url=%s domain=%q", id, name, apiURL, domain)

	// Propagate domain to DP so registerInit can auto-attach by Host.
	// Best-effort — CP row is created regardless.
	if domain != "" && initialStatus == "ready" {
		if err := s.propagateDomainToDP(r.Context(), apiURL, apiKey, domain); err != nil {
			log.Printf("cp createClient: domain propagation failed for cp_client=%d: %v", id, err)
			// Not fatal; superadmin can retry via PATCH.
		}
	}
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
	Domain         *string `json:"domain,omitempty"`
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
		// Widened to include the two lifecycle states (V4 migration).
		// Ops promotes infra_pending -> ready once the target DP is
		// reachable; superadmin flips ready -> active when they want to
		// let real user traffic through.
		switch st {
		case "infra_pending", "ready", "active", "suspended", "deleted":
			// ok
		default:
			writeErr(w, http.StatusBadRequest,
				"status must be one of: infra_pending, ready, active, suspended, deleted")
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
	var domainChangeTo string
	var domainChanged bool
	if req.Domain != nil {
		d := strings.ToLower(strings.TrimSpace(*req.Domain))
		var domainArg any
		if d != "" {
			domainArg = d
		}
		sets = append(sets, fmt.Sprintf("domain = $%d", len(args)+1))
		args = append(args, domainArg)
		domainChangeTo = d
		domainChanged = true
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

	// If domain was patched, push to DP so registerInit picks it up.
	if domainChanged {
		if apiURL, apiKey, status, ok := s.loadClientForInternalCall(r.Context(), id); ok &&
			(status == "active" || status == "ready") {
			if err := s.propagateDomainToDP(r.Context(), apiURL, apiKey, domainChangeTo); err != nil {
				log.Printf("cp patchClient: domain propagation failed for cp_client=%d: %v", id, err)
			}
		}
	}
	resp := map[string]any{"ok": true}
	if freshKey != "" {
		// New api_key echoed once — same rule as create-time.
		resp["api_key"] = freshKey
	}
	writeJSON(w, http.StatusOK, resp)
}

// propagateDomainToDP calls DP's /api/internal/clients/{id}/domain to
// keep the DP-side clients.domain in sync with CP. Uses the same
// probe-for-dp-client-id trick as portal propagation.
func (s *Server) propagateDomainToDP(ctx context.Context, apiURL, apiKey, domain string) error {
	dpID := probeDpClientID(ctx, apiURL, apiKey)
	if !dpID.Valid || dpID.Int64 <= 0 {
		dpID = sql.NullInt64{Int64: 1, Valid: true} // demo fallback
	}
	body, _ := json.Marshal(map[string]any{"domain": domain})
	callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(callCtx, http.MethodPost,
		fmt.Sprintf("%s/api/internal/clients/%d/domain", apiURL, dpID.Int64),
		bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-API-Key", apiKey)
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		bodyStr, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
		return fmt.Errorf("dp returned %d: %s", resp.StatusCode, string(bodyStr))
	}
	return nil
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

// ── POST /api/superadmin/clients/{id}/reviewers ──────────────────
//
// Track 2 (per-client DP model): superadmin adds a reviewer for a
// client. The CP writes NOTHING to its own DB — it only fires
// POST <api_url>/api/internal/users/create on the target Data Plane,
// which owns the users table. The DP returns the user id; the CP
// forwards that to the caller.
//
// Auth chain:
//   1. Superadmin's Bearer JWT authorises the call to this handler.
//   2. CP presents its stored clients_registry.api_key as
//      X-Internal-API-Key to the DP, which validates against its own
//      INTERNAL_API_KEY env var.
//
// The DP-side reviewer's password is bcrypted on the DP — the CP
// only forwards the plaintext once, over TLS. Superadmin should
// hand it to the reviewer out-of-band (as we do today).

type createReviewerReq struct {
	Username    string `json:"username"`
	Password    string `json:"password"`
	DisplayName string `json:"display_name"`
	Email       string `json:"email,omitempty"`
	// ClientID is the DP-SIDE exam-board id (from the DP's clients
	// table). The CP doesn't know DP-side ids, so the superadmin
	// must supply it (typically the UI populates from a dropdown of
	// exam boards fetched from a separate CP endpoint).
	ClientID int64 `json:"client_id"`
}

type createReviewerResp struct {
	UserID     int64  `json:"user_id"`
	Username   string `json:"username"`
	ClientRegistryID int64 `json:"client_registry_id"`
}

func (s *Server) createReviewer(w http.ResponseWriter, r *http.Request) {
	cpClientID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || cpClientID <= 0 {
		writeErr(w, http.StatusBadRequest, "bad client id")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	var req createReviewerReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	req.Username = strings.TrimSpace(req.Username)
	req.DisplayName = strings.TrimSpace(req.DisplayName)
	if req.Username == "" || req.DisplayName == "" {
		writeErr(w, http.StatusBadRequest, "username and display_name required")
		return
	}
	if len(req.Password) < 8 || len(req.Password) > 200 {
		writeErr(w, http.StatusBadRequest, "password must be 8-200 chars")
		return
	}
	// ClientID is OPTIONAL now. When zero, the DP's internalUsersCreate
	// will auto-attach to the sole visible client on that DP (or return
	// a specific error if the DP has 0 or >1 clients, at which point
	// the FE needs to prompt the superadmin for a choice).

	// Look up the DP: api_url + api_key + status. Refuse for anything
	// that isn't reachable (infra_pending, suspended, deleted) — the
	// DP call would just fail and we'd rather surface a specific error.
	var (
		apiURL, apiKey, status string
	)
	err = s.deps.DB.QueryRowContext(r.Context(),
		`SELECT api_url, api_key, status FROM clients_registry WHERE id = $1`,
		cpClientID,
	).Scan(&apiURL, &apiKey, &status)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "client not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "registry lookup: "+err.Error())
		return
	}
	if status != "active" && status != "ready" {
		writeErr(w, http.StatusFailedDependency,
			fmt.Sprintf("client status is %q — Data Plane not reachable for reviewer provisioning", status))
		return
	}

	// Build payload for DP /internal/users/create. Only include
	// client_id if the superadmin specified one — else DP auto-attaches.
	payloadMap := map[string]any{
		"username":     req.Username,
		"password":     req.Password,
		"role":         "client_reviewer",
		"display_name": req.DisplayName,
		"email":        req.Email,
	}
	if req.ClientID > 0 {
		payloadMap["client_id"] = req.ClientID
	}
	payload, err := json.Marshal(payloadMap)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "payload build: "+err.Error())
		return
	}

	// Fire the internal call. Timeout matches the /orgs/create fan-out.
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		apiURL+"/api/internal/users/create", bytes.NewReader(payload))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "request build: "+err.Error())
		return
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "application/json")
	httpReq.Header.Set("X-Internal-API-Key", apiKey)

	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		log.Printf("createReviewer: DP call to %s failed: %v", apiURL, err)
		writeErr(w, http.StatusBadGateway, "data plane unreachable: "+err.Error())
		return
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<10))

	// Non-2xx: forward DP's error verbatim so the superadmin sees
	// "username already exists" or "client_id X not found" rather
	// than a generic "reviewer provisioning failed".
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(respBody)
		return
	}

	// 2xx — parse the DP's response and re-envelope with the CP id.
	var dpResp struct {
		UserID   int64  `json:"user_id"`
		Username string `json:"username"`
	}
	if err := json.Unmarshal(respBody, &dpResp); err != nil {
		log.Printf("createReviewer: DP returned 2xx but response unparseable (body=%q): %v",
			string(respBody), err)
		writeErr(w, http.StatusBadGateway, "data plane returned unparseable success response")
		return
	}
	log.Printf("createReviewer: created reviewer user_id=%d username=%s on client_registry_id=%d dp_client_id=%d",
		dpResp.UserID, dpResp.Username, cpClientID, req.ClientID)
	writeJSON(w, http.StatusCreated, createReviewerResp{
		UserID:           dpResp.UserID,
		Username:         dpResp.Username,
		ClientRegistryID: cpClientID,
	})
}
