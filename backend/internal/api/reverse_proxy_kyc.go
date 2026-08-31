package api

// Reverse-proxy shims — Phase 3 of the multi-tenant migration.
//
// These handlers own /api/register/{submit,{id}} and the client-reviewer
// /api/client/applications/* endpoints. Every DP proxies these paths up
// to the Control Plane; CP owns the institution_applications table for
// every client. Each handler:
//
//   1. Adds two headers identifying this Data Plane to the Control
//      Plane (X-Data-Plane-Client-ID + X-Data-Plane-Api-Key).
//   2. Streams the request body forward to
//      Cfg.ControlPlaneURL + <same path> + <query string>.
//   3. Streams the response back to the browser, preserving status
//      + Content-Type.
//
// Deliberately transparent — the DP doesn't parse the payload, doesn't
// mutate JSON fields, doesn't validate anything. Any business logic
// still owned by the DP (OTP, doc upload to S3) is exercised by the
// existing routes that remain wired IN ADDITION to these proxies.
//
// Failure modes:
//   - CP unreachable / timeout / 5xx: return 502 to the browser with
//     a short message. The browser sees a hard failure rather than
//     "silently approved on the CP, not visible on the DP".
//   - CONTROL_PLANE_URL not configured: return 503 with a very
//     specific error so a misconfigured deployment is obvious in
//     logs.

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
)

// proxyToCP forwards `r` to the Control Plane, preserving path +
// query + method + body + Content-Type. Attaches the two DP-auth
// headers before dispatch. Writes the CP's response verbatim to `w`.
//
// Called from the wrapper handlers below (proxyRegisterSubmit, etc.).
// A single shared helper keeps the auth attachment + header copy in
// one place — a bug in any of that would silently affect every
// proxied endpoint otherwise.
func (s *Server) proxyToCP(w http.ResponseWriter, r *http.Request, cpPath string) {
	cpBase := s.deps.Cfg.ControlPlaneURL
	if cpBase == "" {
		writeErr(w, http.StatusServiceUnavailable,
			"KYC is proxied to the Control Plane, but CONTROL_PLANE_URL is not set on this deployment")
		return
	}
	if s.deps.Cfg.DataPlaneClientID <= 0 {
		writeErr(w, http.StatusServiceUnavailable,
			"KYC proxy misconfigured: DATA_PLANE_CLIENT_ID is not set on this deployment")
		return
	}

	// Build outbound URL — preserve query string so ?status=pending
	// filters etc. survive the hop.
	outURL := cpBase + cpPath
	if r.URL.RawQuery != "" {
		outURL += "?" + r.URL.RawQuery
	}

	// Bound the round-trip: 30s is generous for slowest realistic
	// CP-side work (approve fires /internal/orgs/create with its
	// own 3s timeout, so worst-case the CP responds inside ~5s).
	// If it doesn't, we'd rather 502 the browser than keep it
	// spinning.
	client := &http.Client{Timeout: 30 * time.Second}

	// Stream the request body to the CP. For JSON payloads this is
	// a couple of KB; for multipart doc uploads (Phase 3 follow-up)
	// io.Copy handles the streaming without buffering everything
	// in memory.
	req, err := http.NewRequestWithContext(r.Context(), r.Method, outURL, r.Body)
	if err != nil {
		log.Printf("proxyToCP: build request %s %s: %v", r.Method, outURL, err)
		writeErr(w, http.StatusInternalServerError, "proxy build failed")
		return
	}

	// Forward the caller's Content-Type so the CP knows how to
	// decode the body. Everything else is dropped on the floor —
	// we do NOT forward Authorization (the CP has its own auth via
	// X-Data-Plane-Api-Key) or cookies (CP sessions are separate).
	if ct := r.Header.Get("Content-Type"); ct != "" {
		req.Header.Set("Content-Type", ct)
	}
	if ct := r.Header.Get("Accept"); ct != "" {
		req.Header.Set("Accept", ct)
	}

	// Attach the DP-auth headers the Control Plane's dpProxyAuth
	// middleware expects.
	req.Header.Set("X-Data-Plane-Client-ID", strconv.FormatInt(s.deps.Cfg.DataPlaneClientID, 10))
	req.Header.Set("X-Data-Plane-Api-Key", s.deps.Cfg.DataPlaneAPIKey)

	// Forward-For chain so CP audit rows carry the real applicant
	// IP, not just the DP's box IP.
	if callerIP := clientIP(r); callerIP != "" {
		req.Header.Set("X-Forwarded-For", callerIP)
	}

	resp, err := client.Do(req)
	if err != nil {
		// context.DeadlineExceeded shows up here as a wrapped
		// net.Error; keep the message short so it doesn't leak a
		// full URL to the browser.
		if errors.Is(err, io.EOF) || errors.Is(err, http.ErrHandlerTimeout) {
			log.Printf("proxyToCP: CP call to %s timed out: %v", outURL, err)
			writeErr(w, http.StatusBadGateway, "control plane timeout")
			return
		}
		log.Printf("proxyToCP: CP call to %s failed: %v", outURL, err)
		writeErr(w, http.StatusBadGateway, "control plane unreachable")
		return
	}
	defer resp.Body.Close()

	// Copy the response headers we care about, then stream body.
	// Deliberately NOT copying Set-Cookie or Authorization — CP
	// sessions are separate from DP sessions.
	if ct := resp.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.WriteHeader(resp.StatusCode)
	if _, err := io.Copy(w, resp.Body); err != nil {
		log.Printf("proxyToCP: response stream to caller failed: %v", err)
	}
}

// ── Per-endpoint wrappers ─────────────────────────────────────────
//
// Each of these delegates to proxyToCP with the CP-side path. Kept as
// individually-named handlers so server.go's route table reads
// naturally and so we can add per-endpoint pre/post work later
// (e.g. audit_log entries on the DP side for a decision that lands
// on CP) without an if-tree inside the shared proxy helper.

// POST /api/register/{id}/submit — reverse-proxy for the final wizard
// step. The DP owns the multi-step draft (/init, /docs, /otp/*); this
// handler hydrates the CP with the full draft state so the CP can
// insert an institution_applications row atomically with its document
// mirror. Steps:
//
//  1. Read the DP draft row and its uploaded documents.
//  2. Build a full JSON payload including external_application_id (the
//     DP id) so the CP can idempotently upsert on retry.
//  3. Forward to the CP's /api/register/submit.
//  4. On CP 2xx: parse response, stash the CP-issued application id
//     onto the DP row (cp_application_id) and flip status to 'pending'
//     — same transaction, non-cancellable context so a client
//     disconnect after we've committed on CP doesn't leave the DP row
//     stale.
//  5. On CP non-2xx: stream the CP error verbatim to the browser and
//     do NOT update the DP row (draft stays 'draft', applicant can
//     retry).
//
// Backwards-compatible with the single-shot flow: if the browser sends
// a non-empty JSON body, we honour it and skip the DP-side lookup.
// A body override still passes through external_application_id if the
// caller included it, so the CP still gets its idempotency key.
func (s *Server) proxyRegisterSubmit(w http.ResponseWriter, r *http.Request) {
	appID, _ := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)

	// Read the incoming body once so we can classify it (empty →
	// hydrate from DB) or forward it verbatim (single-shot → trust
	// caller).
	incoming, err := io.ReadAll(io.LimitReader(r.Body, 512<<10))
	if err != nil {
		log.Printf("proxyRegisterSubmit: read body: %v", err)
		writeErr(w, http.StatusBadRequest, "could not read request body")
		return
	}
	_ = r.Body.Close()

	var forwardBody []byte
	if isEmptyOrNoFields(incoming) {
		if appID <= 0 {
			writeErr(w, http.StatusBadRequest, "missing application id in URL")
			return
		}
		hydrated, hErr := s.hydrateDraftPayload(r.Context(), appID)
		if hErr != nil {
			log.Printf("proxyRegisterSubmit: hydrate draft %d: %v", appID, hErr)
			if errors.Is(hErr, sql.ErrNoRows) {
				writeErr(w, http.StatusNotFound, "application draft not found")
				return
			}
			writeErr(w, http.StatusInternalServerError, "could not load draft: "+hErr.Error())
			return
		}
		forwardBody = hydrated
	} else {
		// Single-shot caller. Preserve the body verbatim. If it lacks
		// external_application_id but the URL carries an id, inject
		// the id so the CP gets an idempotency key regardless of
		// which entry point was used.
		if appID > 0 {
			forwardBody = injectExternalID(incoming, appID)
		} else {
			forwardBody = incoming
		}
	}

	// Replace the body with the (possibly rewritten) payload and set a
	// definite Content-Type — the CP handler decodes strict JSON.
	r.Body = io.NopCloser(bytes.NewReader(forwardBody))
	r.ContentLength = int64(len(forwardBody))
	r.Header.Set("Content-Type", "application/json")

	// Buffer the CP's response so we can parse it AND stream it back
	// to the caller. Reusing proxyToCP would consume the body writing
	// it straight to w; here we need both.
	cpResp, cpErr := s.callCPRegisterSubmit(r, forwardBody)
	if cpErr != nil {
		log.Printf("proxyRegisterSubmit: CP call failed: %v", cpErr)
		writeErr(w, http.StatusBadGateway, "control plane unreachable")
		return
	}
	defer cpResp.Body.Close()

	respBody, _ := io.ReadAll(cpResp.Body)

	// Forward CP's status + body verbatim, whatever it was.
	if ct := cpResp.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	} else {
		w.Header().Set("Content-Type", "application/json")
	}
	w.WriteHeader(cpResp.StatusCode)
	_, _ = w.Write(respBody)

	// Only reconcile the DP row when the CP accepted the submission.
	// A non-2xx means the draft is still in 'draft' on the DP and the
	// applicant can retry from the same URL.
	if cpResp.StatusCode < 200 || cpResp.StatusCode >= 300 {
		return
	}
	if appID <= 0 {
		return
	}

	// Extract the CP-issued application id so status polls on the DP
	// can translate DP id → CP id without a second CP round-trip.
	var respObj struct {
		ApplicationID int64  `json:"application_id"`
		Status        string `json:"status"`
	}
	if err := json.Unmarshal(respBody, &respObj); err != nil || respObj.ApplicationID <= 0 {
		log.Printf("proxyRegisterSubmit: CP returned 2xx but response missing application_id (body=%q): %v",
			truncate(respBody, 200), err)
		return
	}

	// Non-cancellable context: the browser may disconnect between our
	// w.Write above and this UPDATE, but we've already told the CP the
	// submit went through — the DP row MUST reflect that or the two
	// planes diverge.
	bgCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := s.deps.DB.ExecContext(bgCtx, `
		UPDATE institution_applications
		   SET status = 'pending',
		       cp_application_id = $2,
		       updated_at = NOW()
		 WHERE id = $1 AND status IN ('draft','pending')`,
		appID, respObj.ApplicationID,
	); err != nil {
		log.Printf("proxyRegisterSubmit: DP reconcile UPDATE failed (dp=%d cp=%d): %v",
			appID, respObj.ApplicationID, err)
	}
}

// isEmptyOrNoFields returns true when the body is genuinely empty
// (multi-step flow — /init already wrote the draft) OR is `{}` /
// whitespace. Malformed JSON is treated as non-empty and forwarded
// unchanged so the CP can return a specific 400 rather than us
// silently replacing the body with hydrated fields.
func isEmptyOrNoFields(b []byte) bool {
	trimmed := bytes.TrimSpace(b)
	if len(trimmed) == 0 {
		return true
	}
	if string(trimmed) == "{}" {
		return true
	}
	var m map[string]any
	if err := json.Unmarshal(trimmed, &m); err != nil {
		return false
	}
	return len(m) == 0
}

// injectExternalID adds external_application_id to a caller-provided
// JSON body when the field is missing, so the CP always gets its
// idempotency key. If the body is malformed or already has the field,
// returns the body unchanged.
func injectExternalID(body []byte, id int64) []byte {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return body
	}
	var m map[string]any
	if err := json.Unmarshal(trimmed, &m); err != nil {
		return body
	}
	if _, exists := m["external_application_id"]; exists {
		return body
	}
	m["external_application_id"] = id
	out, err := json.Marshal(m)
	if err != nil {
		return body
	}
	return out
}

// truncate keeps log lines readable when the CP dumps a huge error body.
func truncate(b []byte, max int) string {
	if len(b) <= max {
		return string(b)
	}
	return string(b[:max]) + "…"
}

// hydrateDraftPayload builds the full JSON payload the CP expects,
// pulling the DP's draft row and every document uploaded so far.
// Returns sql.ErrNoRows if the draft doesn't exist so the caller can
// surface a 404. Any other error is wrapped.
func (s *Server) hydrateDraftPayload(ctx context.Context, appID int64) ([]byte, error) {
	// Metadata. Nullable fields → sql.NullString / sql.NullInt64 so
	// zero-value TEXTs don't get serialised as "" if the applicant
	// genuinely skipped an optional field.
	var (
		instName, instType, addr1, city, state, pin      string
		headName, headDesig, headEmail, headMobile       string
		aishe, panN, affil, addr2, district, submitterIP sql.NullString
		yrEst, approxStudents                            sql.NullInt64
		createdAt                                        sql.NullTime
		dpClientID                                       sql.NullInt64
	)
	err := s.deps.DB.QueryRowContext(ctx, `
		SELECT institution_name, institution_type,
		       aishe_code, pan, year_established, affiliation_body,
		       address_line1, address_line2, city, district, state, pin_code,
		       approx_student_count,
		       head_name, head_designation, head_email, head_mobile,
		       submitter_ip, created_at, client_id
		  FROM institution_applications
		 WHERE id = $1`, appID,
	).Scan(
		&instName, &instType,
		&aishe, &panN, &yrEst, &affil,
		&addr1, &addr2, &city, &district, &state, &pin,
		&approxStudents,
		&headName, &headDesig, &headEmail, &headMobile,
		&submitterIP, &createdAt, &dpClientID,
	)
	if err != nil {
		return nil, err
	}

	// Auto-attach fallback for the sole-visible-client case.
	// Mirrors what Rahul's DP-side registerSubmit does: if the draft
	// wasn't deep-linked to a specific client and there is EXACTLY
	// ONE visible+open client on the platform, attach to that one.
	// With 0 or >1 candidates we leave client_id NULL — the CP will
	// still write the row, approve will still work, but the fan-out
	// will be skipped and the admin will need to be manually attached.
	if !dpClientID.Valid {
		var count int
		var candidate int64
		if err := s.deps.DB.QueryRowContext(ctx,
			`SELECT COUNT(*), COALESCE(MIN(id), 0)
			   FROM clients
			  WHERE visible = 1 AND closed = 0`,
		).Scan(&count, &candidate); err == nil && count == 1 && candidate > 0 {
			dpClientID = sql.NullInt64{Int64: candidate, Valid: true}
		}
	}

	// Documents.
	docsRows, err := s.deps.DB.QueryContext(ctx, `
		SELECT doc_kind, original_name, storage_path, mime, size_bytes, sha256
		  FROM institution_application_documents
		 WHERE application_id = $1
		 ORDER BY id`, appID,
	)
	if err != nil {
		return nil, fmt.Errorf("read docs: %w", err)
	}
	defer docsRows.Close()

	type outDoc struct {
		DocKind      string `json:"doc_kind"`
		OriginalName string `json:"original_name"`
		StoragePath  string `json:"storage_path"`
		Mime         string `json:"mime"`
		SizeBytes    int64  `json:"size_bytes"`
		Sha256       string `json:"sha256"`
	}
	docs := []outDoc{}
	for docsRows.Next() {
		var d outDoc
		if err := docsRows.Scan(&d.DocKind, &d.OriginalName, &d.StoragePath, &d.Mime, &d.SizeBytes, &d.Sha256); err != nil {
			return nil, fmt.Errorf("scan doc: %w", err)
		}
		docs = append(docs, d)
	}
	if err := docsRows.Err(); err != nil {
		return nil, fmt.Errorf("iter docs: %w", err)
	}

	payload := map[string]any{
		"institution_name":        instName,
		"institution_type":        instType,
		"aishe_code":              aishe.String,
		"pan":                     panN.String,
		"year_established":        int(yrEst.Int64),
		"affiliation_body":        affil.String,
		"approx_student_count":    int(approxStudents.Int64),
		"address_line1":           addr1,
		"address_line2":           addr2.String,
		"city":                    city,
		"district":                district.String,
		"state":                   state,
		"pin_code":                pin,
		"head_name":               headName,
		"head_designation":        headDesig,
		"head_email":              headEmail,
		"head_mobile":             headMobile,
		"submitter_ip":            submitterIP.String,
		"external_application_id": appID,
		"documents":               docs,
	}
	if createdAt.Valid {
		payload["dp_submitted_at"] = createdAt.Time.UTC().Format(time.RFC3339)
	}
	if dpClientID.Valid {
		payload["dp_client_id"] = dpClientID.Int64
	}
	return json.Marshal(payload)
}

// callCPRegisterSubmit posts the built payload to the CP with the
// standard DP-auth headers. Returns the raw response so the caller can
// forward status + body AND parse the JSON for reconciliation. Keeps
// proxyToCP untouched — that helper is designed for straight streaming.
func (s *Server) callCPRegisterSubmit(r *http.Request, body []byte) (*http.Response, error) {
	cpBase := s.deps.Cfg.ControlPlaneURL
	if cpBase == "" {
		return nil, errors.New("CONTROL_PLANE_URL not set")
	}
	if s.deps.Cfg.DataPlaneClientID <= 0 {
		return nil, errors.New("DATA_PLANE_CLIENT_ID not set")
	}

	out := cpBase + "/api/register/submit"
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, out, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Data-Plane-Client-ID", strconv.FormatInt(s.deps.Cfg.DataPlaneClientID, 10))
	req.Header.Set("X-Data-Plane-Api-Key", s.deps.Cfg.DataPlaneAPIKey)
	if callerIP := clientIP(r); callerIP != "" {
		req.Header.Set("X-Forwarded-For", callerIP)
	}

	client := &http.Client{Timeout: 30 * time.Second}
	return client.Do(req)
}

// GET /api/register/{id} — status readback for the applicant.
//
// The URL id is DP-local. We translate to the CP-side id via the
// cp_application_id column populated by proxyRegisterSubmit. If the
// row never made it to the CP (cp_application_id NULL) we fall back
// to a DP-local status response so an applicant polling in the window
// between /submit failing and their retry still sees SOMETHING useful.
func (s *Server) proxyRegisterStatus(w http.ResponseWriter, r *http.Request) {
	dpID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || dpID <= 0 {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}

	var (
		cpID   sql.NullInt64
		status string
		name   string
	)
	err = s.deps.DB.QueryRowContext(r.Context(), `
		SELECT cp_application_id, status, institution_name
		  FROM institution_applications WHERE id = $1`, dpID,
	).Scan(&cpID, &status, &name)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "application not found")
		return
	}
	if err != nil {
		log.Printf("proxyRegisterStatus: DB lookup for dp id %d: %v", dpID, err)
		writeErr(w, http.StatusInternalServerError, "db read")
		return
	}

	// Never reached the CP — return DP-local status. Small envelope
	// matching the CP's registerStatusResp shape so the FE handles it
	// identically.
	if !cpID.Valid {
		writeJSON(w, http.StatusOK, map[string]any{
			"application_id":   dpID,
			"status":           status,
			"institution_name": name,
		})
		return
	}
	s.proxyToCP(w, r, fmt.Sprintf("/api/register/%d", cpID.Int64))
}

// GET /api/client/applications → GET /api/reviewer/applications on CP
// Note the path RENAME: DP legacy uses /client/, CP standardises on
// /reviewer/. Same shape.
func (s *Server) proxyReviewerList(w http.ResponseWriter, r *http.Request) {
	s.proxyToCP(w, r, "/api/reviewer/applications")
}

// GET /api/client/applications/{id} → CP /api/reviewer/applications/{id}
// Note the path RENAME: DP legacy uses /client/, CP standardises on
// /reviewer/. Same shape.
func (s *Server) proxyReviewerGet(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}
	s.proxyToCP(w, r, "/api/reviewer/applications/"+url.PathEscape(id))
}

func (s *Server) proxyReviewerApprove(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}
	s.proxyToCP(w, r, fmt.Sprintf("/api/reviewer/applications/%s/approve", url.PathEscape(id)))
}

func (s *Server) proxyReviewerReject(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}
	s.proxyToCP(w, r, fmt.Sprintf("/api/reviewer/applications/%s/reject", url.PathEscape(id)))
}

// Bulk approve/reject — forwarded straight through to CP. The CP
// endpoint iterates and returns a per-row summary; we just relay.
// The old DP-local bulk handlers looked up applications in DP's
// institution_applications table, but reviewer rows now live on CP —
// hitting the DP handler with CP row ids always resulted in "0 approved,
// N skipped" errors.
func (s *Server) proxyReviewerBulkApprove(w http.ResponseWriter, r *http.Request) {
	s.proxyToCP(w, r, "/api/reviewer/applications/bulk-approve")
}

func (s *Server) proxyReviewerBulkReject(w http.ResponseWriter, r *http.Request) {
	s.proxyToCP(w, r, "/api/reviewer/applications/bulk-reject")
}

// GET /api/client/applications/{id}/docs/{doc_id} — DP → CP proxy for
// reviewer doc downloads. CP handles the S3 fetch (via DP's internal
// /documents/download endpoint) and streams bytes back through here.
func (s *Server) proxyReviewerDocDownload(w http.ResponseWriter, r *http.Request) {
	appID := chi.URLParam(r, "id")
	docID := chi.URLParam(r, "doc_id")
	if appID == "" || docID == "" {
		writeErr(w, http.StatusBadRequest, "missing id or doc_id")
		return
	}
	s.proxyToCP(w, r, fmt.Sprintf(
		"/api/reviewer/applications/%s/docs/%s/download",
		url.PathEscape(appID), url.PathEscape(docID)))
}
