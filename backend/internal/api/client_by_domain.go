package api

// Domain-based client resolution — reads r.Host + looks up
// clients.domain so the register wizard auto-attaches the applicant
// to the right exam board without requiring a dropdown pick.
//
// Also exposes a public GET /api/register/current-client that the FE
// hits on page load to render "Registering with <client name>" and
// hide the client-picker when the URL already tells us the answer.

import (
	"database/sql"
	"errors"
	"log"
	"net/http"
	"strings"
)

// resolveClientIDFromHost normalises r.Host (lowercase, no port) and
// returns clients.id if a matching visible+open+portal-enabled row
// exists. Zero on any miss (unmapped domain / disabled portal / etc.).
func (s *Server) resolveClientIDFromHost(r *http.Request) int64 {
	host := normaliseHost(r.Host)
	if host == "" {
		return 0
	}
	var id int64
	err := s.deps.DB.QueryRowContext(r.Context(),
		`SELECT id FROM clients
		  WHERE LOWER(domain) = $1
		    AND visible = 1 AND closed = 0
		    AND portal_enabled = TRUE`, host,
	).Scan(&id)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			log.Printf("resolveClientIDFromHost: db lookup for %q: %v", host, err)
		}
		return 0
	}
	return id
}

// normaliseHost strips the :port suffix + lowercases so "NTA.example.com:443"
// matches a stored "nta.example.com". Handles IPv6 brackets too.
func normaliseHost(h string) string {
	h = strings.ToLower(strings.TrimSpace(h))
	if h == "" {
		return ""
	}
	if strings.HasPrefix(h, "[") {
		if end := strings.Index(h, "]"); end > 0 {
			return h[:end+1]
		}
	}
	if i := strings.LastIndex(h, ":"); i > 0 {
		return h[:i]
	}
	return h
}

// ── GET /api/register/current-client ────────────────────────────
//
// Public endpoint. FE calls it on /register page load to learn which
// client this subdomain belongs to.

type currentClientResp struct {
	ID              int64  `json:"id"`
	Name            string `json:"name"`
	Domain          string `json:"domain"`
	KYCReviewMode   string `json:"kyc_review_mode"`
	PortalEnabled   bool   `json:"portal_enabled"`
}

func (s *Server) registerCurrentClient(w http.ResponseWriter, r *http.Request) {
	host := normaliseHost(r.Host)
	if host == "" {
		writeErr(w, http.StatusBadRequest, "missing host header")
		return
	}
	var (
		id            int64
		name          string
		domain        sql.NullString
		kycMode       string
		portalEnabled bool
	)
	err := s.deps.DB.QueryRowContext(r.Context(), `
		SELECT id, name, domain, kyc_review_mode, portal_enabled
		  FROM clients
		 WHERE LOWER(domain) = $1
		   AND visible = 1 AND closed = 0`, host,
	).Scan(&id, &name, &domain, &kycMode, &portalEnabled)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound,
			"no client is mapped to this domain — this URL is not a client-specific registration page")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, currentClientResp{
		ID:            id,
		Name:          name,
		Domain:        domain.String,
		KYCReviewMode: kycMode,
		PortalEnabled: portalEnabled,
	})
}
