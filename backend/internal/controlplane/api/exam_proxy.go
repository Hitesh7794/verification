package api

// Exam proxy — forwards every /api/superadmin/exams/* call to the
// target DP's existing legacy superadmin endpoints. Rahul's FE calls
// a long tail of paths (get, patch, close, reopen, visibility,
// candidates list + upload, completeness, uploads, per-candidate
// biometric, bulk zip). Rather than reimplement each on the CP,
// this file provides ONE proxy that:
//
//   1. Obtains a DP-side superadmin JWT (cached for its 12h TTL).
//   2. Forwards the incoming request to <api_url>/api/superadmin/exams/*
//      with the JWT in Authorization.
//   3. Streams request + response bodies verbatim — works for CSV
//      uploads, multipart biometric zips, and JSON alike.
//
// Single-DP assumption: the proxy uses the first active client in
// clients_registry. When Phase 4 splits DPs per-client, we'll extend
// this to route by exam ownership (either via a CP-side exam→dp map
// or by asking each DP "do you have exam id X").
//
// Auth on the DP side is the seeded `super` user, credentials from
// CP env DP_SUPER_USERNAME + DP_SUPER_PASSWORD (defaults super/
// super123 — override in cp.env for prod). This is a trust concession
// for the shared-DP demo; a proper per-DP-per-client Phase 4 setup
// would swap this for an internal-key auth mode.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"golang.org/x/crypto/bcrypt"
)

// dpJWTCache holds a single active DP superadmin JWT + its refresh
// deadline. Threadsafe. Refresh is lazy: any proxy call that finds
// the token expired triggers a fresh login before forwarding.
type dpJWTCache struct {
	mu         sync.Mutex
	token      string
	expires    time.Time
	lastLogin  time.Time
}

// dpSuperCreds reads the DP superadmin username + password from env.
// Defaults to the seeded super/super123 for this shared-DP demo. Real
// deploys should override.
func dpSuperCreds() (string, string) {
	u := os.Getenv("DP_SUPER_USERNAME")
	if u == "" {
		u = "super"
	}
	p := os.Getenv("DP_SUPER_PASSWORD")
	if p == "" {
		p = "super123"
	}
	return u, p
}

var globalDPJWT = &dpJWTCache{}

// ensureDPJWT returns a valid DP superadmin JWT, logging in fresh if
// the cache is empty or the token expires in under 5 minutes.
func (s *Server) ensureDPJWT(ctx context.Context, apiURL string) (string, error) {
	globalDPJWT.mu.Lock()
	defer globalDPJWT.mu.Unlock()

	if globalDPJWT.token != "" && time.Until(globalDPJWT.expires) > 5*time.Minute {
		return globalDPJWT.token, nil
	}

	// Login fresh.
	username, password := dpSuperCreds()
	body, _ := json.Marshal(map[string]string{
		"username": username,
		"password": password,
	})
	loginCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(loginCtx, http.MethodPost,
		apiURL+"/api/auth/login", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("build login req: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return "", fmt.Errorf("DP login call: %w", err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 32<<10))
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("DP login returned %d: %s", resp.StatusCode, string(respBody))
	}
	var parsed struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(respBody, &parsed); err != nil || parsed.Token == "" {
		return "", fmt.Errorf("DP login response missing token: %s", string(respBody))
	}
	globalDPJWT.token = parsed.Token
	// DP JWTs are 12h; refresh 30min before expiry.
	globalDPJWT.expires = time.Now().Add(11*time.Hour + 30*time.Minute)
	globalDPJWT.lastLogin = time.Now()
	log.Printf("dpJWTCache: refreshed DP superadmin JWT (valid until %s)",
		globalDPJWT.expires.Format(time.RFC3339))
	return parsed.Token, nil
}

// firstActiveDP returns the (api_url, api_key) of the first active or
// ready client in clients_registry. Single-DP assumption; returns an
// error if nothing is reachable.
func (s *Server) firstActiveDP(ctx context.Context) (string, string, error) {
	_, apiURL, apiKey, err := s.firstActiveDPWithID(ctx)
	return apiURL, apiKey, err
}

// firstActiveDPWithID is the id-returning variant of [firstActiveDP].
// Callers that need to attribute the response back to the CP-side
// clients_registry row (e.g. so the FE can build a link to
// /superadmin/clients/:cp_id from a DP-native exam.client_id) use this.
func (s *Server) firstActiveDPWithID(ctx context.Context) (int64, string, string, error) {
	var id int64
	var apiURL, apiKey string
	err := s.deps.DB.QueryRowContext(ctx,
		`SELECT id, api_url, api_key
		   FROM clients_registry
		  WHERE status IN ('active','ready')
		  ORDER BY id ASC
		  LIMIT 1`,
	).Scan(&id, &apiURL, &apiKey)
	if err != nil {
		return 0, "", "", fmt.Errorf("no active client registered: %w", err)
	}
	return id, apiURL, apiKey, nil
}

// proxyToDPSuperadmin forwards the current request to the DP's
// /api/superadmin/... path, injecting the cached DP JWT. Streams
// both request + response bodies so CSV uploads and multipart zips
// pass through without buffering.
func (s *Server) proxyToDPSuperadmin(w http.ResponseWriter, r *http.Request, dpPath string) {
	apiURL, _, err := s.firstActiveDP(r.Context())
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, "no active data plane registered: "+err.Error())
		return
	}

	jwt, err := s.ensureDPJWT(r.Context(), apiURL)
	if err != nil {
		log.Printf("proxyToDPSuperadmin: DP JWT failed: %v", err)
		writeErr(w, http.StatusBadGateway, "could not authenticate to data plane: "+err.Error())
		return
	}

	// Build outbound URL preserving query string.
	outURL := apiURL + dpPath
	if r.URL.RawQuery != "" {
		outURL += "?" + r.URL.RawQuery
	}

	// 5 min timeout — covers CSV uploads and biometric zips (nginx on
	// the DP side has 60min for the bulk path; matching client timeout
	// keeps things sane).
	client := &http.Client{Timeout: 5 * time.Minute}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, outURL, r.Body)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "build proxy req: "+err.Error())
		return
	}
	// Preserve content-type + accept + range headers so multipart /
	// CSV / video downloads all flow.
	for _, h := range []string{"Content-Type", "Accept", "Content-Length", "Content-Encoding"} {
		if v := r.Header.Get(h); v != "" {
			req.Header.Set(h, v)
		}
	}
	req.Header.Set("Authorization", "Bearer "+jwt)
	// Forward client IP for audit_log entries on the DP side.
	if ip := r.Header.Get("X-Forwarded-For"); ip != "" {
		req.Header.Set("X-Forwarded-For", ip)
	}

	resp, err := client.Do(req)
	if err != nil {
		log.Printf("proxyToDPSuperadmin: DP call %s %s failed: %v", r.Method, outURL, err)
		writeErr(w, http.StatusBadGateway, "data plane unreachable: "+err.Error())
		return
	}
	defer resp.Body.Close()

	// 401 from DP means our cached JWT expired between refresh and use.
	// Try one retry with a fresh JWT before giving up.
	if resp.StatusCode == http.StatusUnauthorized {
		globalDPJWT.mu.Lock()
		globalDPJWT.token = ""
		globalDPJWT.mu.Unlock()
		jwt2, jerr := s.ensureDPJWT(r.Context(), apiURL)
		if jerr == nil {
			req2, _ := http.NewRequestWithContext(r.Context(), r.Method, outURL, http.NoBody)
			req2.Header.Set("Authorization", "Bearer "+jwt2)
			if ct := r.Header.Get("Content-Type"); ct != "" {
				req2.Header.Set("Content-Type", ct)
			}
			// Can't replay the body (already read) — best we can do
			// for retry is idempotent GETs. Non-GET stays 401.
			if r.Method == http.MethodGet {
				resp.Body.Close()
				resp, err = client.Do(req2)
				if err != nil {
					writeErr(w, http.StatusBadGateway, "retry after 401 failed: "+err.Error())
					return
				}
				defer resp.Body.Close()
			}
		}
	}

	// Forward response verbatim.
	for k, vv := range resp.Header {
		// Skip hop-by-hop headers.
		lower := strings.ToLower(k)
		if lower == "connection" || lower == "keep-alive" ||
			lower == "transfer-encoding" || lower == "upgrade" {
			continue
		}
		for _, v := range vv {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

// ── Exam-scoped handlers (all thin wrappers) ─────────────────────

func (s *Server) proxyExamGet(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	// The DP returns `exam.client_id` as its own native `clients.id`
	// (44 for NTA), but the CP FE navigates to
	// /superadmin/clients/:cp_client_id where :cp_client_id is the
	// CP-side `clients_registry.id` (9 for NTA). Same conflation bug
	// that broke reviewer notify earlier — fix here by intercepting
	// the response, unmarshalling, and injecting `cp_client_id` so
	// the FE has a stable field to link back to. Original
	// `client_id` is preserved for any caller that still wants the
	// DP-native id.
	cpRegistryID, apiURL, apiKey, err := s.firstActiveDPWithID(r.Context())
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, "no active data plane registered: "+err.Error())
		return
	}
	_ = apiKey // helper kept parallel with firstActiveDP even though only apiURL is used here
	jwt, err := s.ensureDPJWT(r.Context(), apiURL)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "could not authenticate to data plane: "+err.Error())
		return
	}
	outURL := apiURL + "/api/superadmin/exams/" + id
	if r.URL.RawQuery != "" {
		outURL += "?" + r.URL.RawQuery
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, outURL, nil)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "build proxy req: "+err.Error())
		return
	}
	req.Header.Set("Authorization", "Bearer "+jwt)
	req.Header.Set("Accept", "application/json")
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "data plane unreachable: "+err.Error())
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	// Non-2xx: forward verbatim so the FE sees the DP's error text
	// (404 "exam not found", etc.).
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(body)
		return
	}

	// Unmarshal → inject cp_client_id → re-marshal. Falls back to the
	// raw body if the DP response isn't the expected shape (unknown
	// future fields survive because we use a map, not the strict
	// examRow struct).
	var envelope map[string]any
	if err := json.Unmarshal(body, &envelope); err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(body)
		return
	}
	if exam, ok := envelope["exam"].(map[string]any); ok {
		exam["cp_client_id"] = cpRegistryID
		envelope["exam"] = exam
	}
	patched, err := json.Marshal(envelope)
	if err != nil {
		// Marshal shouldn't fail on a valid unmarshalled map, but if
		// it does, forward the original body untouched.
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(body)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(patched)
}
func (s *Server) proxyExamPatch(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	s.proxyToDPSuperadmin(w, r, "/api/superadmin/exams/"+id)
}
func (s *Server) proxyExamDelete(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	s.proxyToDPSuperadmin(w, r, "/api/superadmin/exams/"+id)
}
func (s *Server) proxyExamVisibility(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	s.proxyToDPSuperadmin(w, r, "/api/superadmin/exams/"+id+"/visibility")
}
func (s *Server) proxyExamClose(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	s.proxyToDPSuperadmin(w, r, "/api/superadmin/exams/"+id+"/close")
}
func (s *Server) proxyExamReopen(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	s.proxyToDPSuperadmin(w, r, "/api/superadmin/exams/"+id+"/reopen")
}
func (s *Server) proxyExamCandidatesList(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	s.proxyToDPSuperadmin(w, r, "/api/superadmin/exams/"+id+"/candidates")
}
func (s *Server) proxyExamCandidatesUpload(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	s.proxyToDPSuperadmin(w, r, "/api/superadmin/exams/"+id+"/candidates")
}
func (s *Server) proxyExamCompleteness(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	s.proxyToDPSuperadmin(w, r, "/api/superadmin/exams/"+id+"/completeness")
}
func (s *Server) proxyExamUploadsList(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	s.proxyToDPSuperadmin(w, r, "/api/superadmin/exams/"+id+"/uploads")
}
func (s *Server) proxyExamCandidateBiometric(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	roll := chi.URLParam(r, "roll")
	s.proxyToDPSuperadmin(w, r, "/api/superadmin/exams/"+id+"/candidates/"+roll+"/biometric")
}
func (s *Server) proxyExamBulkModality(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	modality := chi.URLParam(r, "modality")
	s.proxyToDPSuperadmin(w, r, "/api/superadmin/exams/"+id+"/bulk/"+modality)
}
func (s *Server) proxyClientExamsCSV(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	s.proxyToDPSuperadmin(w, r, "/api/superadmin/clients/"+id+"/exams/csv")
}

// ── /me/change-password ─────────────────────────────────────────
//
// Changes the CURRENT superadmin's password on the CP DB
// (platform_users). Different from anything on DP — this is a CP-native
// operation. FE calls POST /api/me/change-password with
// {current_password, new_password}.

type changePasswordReq struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
}

func (s *Server) changePassword(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r)
	if c == nil || c.UserID <= 0 {
		writeErr(w, http.StatusUnauthorized, "not authenticated")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<10)
	var req changePasswordReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if len(req.NewPassword) < 8 || len(req.NewPassword) > 200 {
		writeErr(w, http.StatusBadRequest, "new password must be 8-200 chars")
		return
	}

	// Verify current_password against stored hash.
	var storedHash string
	if err := s.deps.DB.QueryRowContext(r.Context(),
		`SELECT password_hash FROM platform_users WHERE id = $1`, c.UserID,
	).Scan(&storedHash); err != nil {
		writeErr(w, http.StatusInternalServerError, "read: "+err.Error())
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(storedHash), []byte(req.CurrentPassword)) != nil {
		writeErr(w, http.StatusForbidden, "current password is incorrect")
		return
	}

	newHash, err := bcrypt.GenerateFromPassword([]byte(req.NewPassword), bcrypt.DefaultCost)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "hash: "+err.Error())
		return
	}
	if _, err := s.deps.DB.ExecContext(r.Context(),
		`UPDATE platform_users
		    SET password_hash = $1,
		        password_change_required = 0,
		        updated_at = NOW()
		  WHERE id = $2`,
		string(newHash), c.UserID,
	); err != nil {
		writeErr(w, http.StatusInternalServerError, "update: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ── /downloads stub ─────────────────────────────────────────────
//
// FE's DownloadsPanel expects a downloads list. Not implemented on CP;
// return empty so the panel renders "no downloads" rather than 404.
func (s *Server) downloadsList(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"downloads": []any{}})
}