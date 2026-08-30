package api

// Doc download endpoints — both superadmin + reviewer paths.
//
// Streaming route: browser → CP → DP /api/internal/documents/download → S3
//
// The DP owns the S3 credentials so it does the actual GET; CP just
// proxies the byte stream with the correct Content-Type +
// Content-Disposition headers pulled from CP's docs mirror.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

// ── GET /api/superadmin/applications/{id}/docs/{doc_id}/download ─
//
// Superadmin-JWT-authenticated. Enforces the same visibility gate as
// the detail endpoint: if the target client is 'client'-only mode,
// bytes are sealed.
func (s *Server) proxyDocDownloadSuperadmin(w http.ResponseWriter, r *http.Request) {
	appID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || appID <= 0 {
		writeErr(w, http.StatusBadRequest, "bad app id")
		return
	}
	docID, err := strconv.ParseInt(chi.URLParam(r, "doc_id"), 10, 64)
	if err != nil || docID <= 0 {
		writeErr(w, http.StatusBadRequest, "bad doc id")
		return
	}
	s.streamKycDoc(w, r, appID, docID, true /* enforceModeGate */)
}

// ── GET /api/reviewer/applications/{id}/docs/{doc_id}/download ──
//
// DP-proxy-authenticated (X-Data-Plane-Client-ID + X-Data-Plane-Api-Key).
// Reviewer's browser hits the DP subdomain; DP reverse-proxies here.
// Scoping check: the app must belong to the caller's client.
func (s *Server) proxyDocDownloadReviewer(w http.ResponseWriter, r *http.Request) {
	appID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || appID <= 0 {
		writeErr(w, http.StatusBadRequest, "bad app id")
		return
	}
	docID, err := strconv.ParseInt(chi.URLParam(r, "doc_id"), 10, 64)
	if err != nil || docID <= 0 {
		writeErr(w, http.StatusBadRequest, "bad doc id")
		return
	}
	// Enforce target_client_id scope: this reviewer can only see their
	// own client's docs.
	callerClient := dpClientID(r)
	var appClient sql.NullInt64
	if err := s.deps.DB.QueryRowContext(r.Context(),
		`SELECT target_client_id FROM institution_applications WHERE id = $1`, appID,
	).Scan(&appClient); errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "application not found")
		return
	} else if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	if !appClient.Valid || appClient.Int64 != callerClient {
		writeErr(w, http.StatusForbidden, "application does not belong to your client")
		return
	}
	s.streamKycDoc(w, r, appID, docID, false /* mode gate is DP-side */)
}

// streamKycDoc is the shared body: load doc metadata from CP, call DP
// /internal/documents/download for the bytes, stream to caller.
func (s *Server) streamKycDoc(w http.ResponseWriter, r *http.Request, appID, docID int64, enforceModeGate bool) {
	var (
		storagePath, mime, original string
		targetClientID              sql.NullInt64
	)
	err := s.deps.DB.QueryRowContext(r.Context(), `
		SELECT d.storage_path, d.mime, d.original_name, a.target_client_id
		  FROM institution_application_documents d
		  JOIN institution_applications a ON a.id = d.application_id
		 WHERE d.id = $1 AND d.application_id = $2`, docID, appID,
	).Scan(&storagePath, &mime, &original, &targetClientID)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "document not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	if !targetClientID.Valid {
		writeErr(w, http.StatusForbidden, "document has no target client — cannot resolve which Data Plane to fetch from")
		return
	}

	// Mode gate: only enforced for superadmin path. In 'client' mode
	// the superadmin gets sealed docs (403).
	if enforceModeGate {
		var mode string
		_ = s.deps.DB.QueryRowContext(r.Context(),
			`SELECT kyc_review_mode FROM clients_registry WHERE id = $1`,
			targetClientID.Int64,
		).Scan(&mode)
		if mode == "client" {
			writeErr(w, http.StatusForbidden,
				"documents for a client-only board are only visible to that client's reviewer")
			return
		}
	}

	// Look up DP api_url + api_key.
	apiURL, apiKey, status, ok := s.loadClientForInternalCall(r.Context(), targetClientID.Int64)
	if !ok {
		writeErr(w, http.StatusFailedDependency, "target Data Plane not registered")
		return
	}
	if status != "active" && status != "ready" {
		writeErr(w, http.StatusFailedDependency,
			fmt.Sprintf("target Data Plane status is %q — cannot fetch doc bytes", status))
		return
	}

	// Fire internal call to DP.
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	dpURL := fmt.Sprintf("%s/api/internal/documents/download?path=%s",
		apiURL, url.QueryEscape(storagePath))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, dpURL, nil)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "build req: "+err.Error())
		return
	}
	req.Header.Set("X-Internal-API-Key", apiKey)
	resp, err := (&http.Client{Timeout: 120 * time.Second}).Do(req)
	if err != nil {
		log.Printf("streamKycDoc: DP call failed: %v", err)
		writeErr(w, http.StatusBadGateway, "data plane unreachable: "+err.Error())
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(body)
		return
	}

	// Set response headers using metadata from CP's docs mirror (CP
	// knows the mime + original filename; DP just returned raw bytes).
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`inline; filename="%s"`, safeDocFilename(original)))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if cl := resp.Header.Get("Content-Length"); cl != "" {
		w.Header().Set("Content-Length", cl)
	}
	_, _ = io.Copy(w, resp.Body)
}

// safeDocFilename strips characters that would break Content-Disposition
// quoting. Same as DP's safeFilename.
func safeDocFilename(s string) string {
	r := strings.NewReplacer(`"`, "", `\`, "", "\n", "", "\r", "")
	return r.Replace(s)
}
