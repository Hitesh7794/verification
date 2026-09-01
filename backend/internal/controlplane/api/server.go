// Package api builds the Control Plane's HTTP surface. Deliberately
// smaller than the Data Plane's api package: superadmin CRUD +
// federated dashboard + (Phase 3) central KYC review. No candidate
// verification, no wallet, no operator flows — those live on the
// Data Plane forever.
package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"golang.org/x/crypto/bcrypt"

	"github.com/veni/neet-verification/internal/auth"
	cpcfg "github.com/veni/neet-verification/internal/controlplane/config"
)

// Deps is what main.go passes in — mirrors the Data Plane's Deps
// shape for muscle-memory but with CP-specific types where they
// matter (the JWTService is a different instance signed with
// CP_JWT_SECRET, and the DB points at the CP's own database).
type Deps struct {
	DB  *sql.DB
	JWT *auth.JWTService
	Cfg cpcfg.Config
}

type Server struct {
	deps Deps
}

func NewServer(d Deps) *Server {
	return &Server{deps: d}
}

// Router wires the whole HTTP surface. Kept in one method — the CP
// is small enough that splitting into subrouters would add more
// ceremony than value.
func (s *Server) Router() http.Handler {
	r := chi.NewRouter()

	r.Use(chimw.RequestID)
	r.Use(chimw.RealIP)
	r.Use(chimw.Recoverer)
	r.Use(chimw.Timeout(30 * time.Second))

	allowed := s.deps.Cfg.AllowedOrigins
	if len(allowed) == 0 {
		// Dev fallback so the CP's own frontend can talk to it from
		// Vite. Production must set CP_ALLOWED_ORIGINS explicitly.
		allowed = []string{"http://localhost:5174", "http://127.0.0.1:5174"}
	}
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   allowed,
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Authorization", "Content-Type"},
		AllowCredentials: true,
		MaxAge:           300,
	}))

	// Public: liveness probes + platform login.
	r.Get("/api/health", s.health)
	r.Post("/api/superadmin/login", s.login)
	// Alias for Rahul's CP frontend which posts to /api/auth/login.
	// Same handler, same response shape; keeps two branches of FE work
	// (his commits + mine) compatible without a rebase.
	r.Post("/api/auth/login", s.login)

	// Authenticated superadmin surface.
	r.Group(func(r chi.Router) {
		r.Use(s.authMiddleware)

		r.Get("/api/me", s.me)

		// Federated verifications report — walks every active client's
		// DP and stitches into one CSV with a client_name column.
		r.Get("/api/superadmin/verifications.csv", s.superadminVerificationsExportCSV)

		// Clients registry CRUD (Phase 2D).
		r.Get("/api/superadmin/clients", s.listClients)
		r.Post("/api/superadmin/clients", s.createClient)
		r.Get("/api/superadmin/clients/{id}", s.getClient)
		r.Patch("/api/superadmin/clients/{id}", s.patchClient)
		r.Delete("/api/superadmin/clients/{id}", s.deleteClient)
		// Client lifecycle actions — Rahul's FE calls these directly
		// instead of PATCH-ing status. Kept as thin wrappers to match.
		r.Post("/api/superadmin/clients/{id}/close", s.closeClient)
		r.Post("/api/superadmin/clients/{id}/reopen", s.reopenClient)
		r.Post("/api/superadmin/clients/{id}/visibility", s.toggleClientVisibility)
		r.Post("/api/superadmin/clients/{id}/portal", s.setClientPortal)
		r.Get("/api/superadmin/clients/{id}/reviewers", s.listClientReviewers)
		// Track 2: reviewer provisioning fires an internal call to the
		// target DP; CP DB stores nothing about the reviewer.
		r.Post("/api/superadmin/clients/{id}/reviewers", s.createReviewer)
		// Hard-delete: fires internal DELETE on target DP. Reviewer row
		// vanishes from DP DB; username immediately reusable.
		r.Delete("/api/superadmin/clients/{id}/reviewers/{uid}", s.deleteReviewer)
		// Exam create — proxies to DP's /api/internal/exams.
		r.Post("/api/superadmin/clients/{id}/exams", s.createExam)
		// Bulk exam CSV upload — proxies to DP legacy superadmin.
		r.Post("/api/superadmin/clients/{id}/exams/csv", s.proxyClientExamsCSV)
		// Exam management — all proxy to DP's /api/superadmin/exams/*
		// using a cached DP superadmin JWT (see exam_proxy.go).
		r.Get("/api/superadmin/exams/{id}", s.proxyExamGet)
		r.Patch("/api/superadmin/exams/{id}", s.proxyExamPatch)
		r.Delete("/api/superadmin/exams/{id}", s.proxyExamDelete)
		r.Post("/api/superadmin/exams/{id}/visibility", s.proxyExamVisibility)
		r.Post("/api/superadmin/exams/{id}/close", s.proxyExamClose)
		r.Post("/api/superadmin/exams/{id}/reopen", s.proxyExamReopen)
		r.Get("/api/superadmin/exams/{id}/candidates", s.proxyExamCandidatesList)
		r.Post("/api/superadmin/exams/{id}/candidates", s.proxyExamCandidatesUpload)
		r.Get("/api/superadmin/exams/{id}/completeness", s.proxyExamCompleteness)
		r.Get("/api/superadmin/exams/{id}/uploads", s.proxyExamUploadsList)
		r.Post("/api/superadmin/exams/{id}/candidates/{roll}/biometric", s.proxyExamCandidateBiometric)
		r.Post("/api/superadmin/exams/{id}/bulk/{modality}", s.proxyExamBulkModality)
		// Self-service password change on CP.
		r.Post("/api/me/change-password", s.changePassword)
		// Downloads panel stub — not implemented, returns empty list.
		r.Get("/api/downloads", s.downloadsList)
		// Superadmin-facing central KYC queue. Same underlying data as
		// /api/reviewer/applications but not scoped to a single client.
		r.Get("/api/superadmin/applications", s.superadminApplicationsList)
		r.Get("/api/superadmin/applications/{id}", s.superadminApplicationGet)
		r.Post("/api/superadmin/applications/{id}/approve", s.superadminApplicationApprove)
		r.Post("/api/superadmin/applications/{id}/reject", s.superadminApplicationReject)
		r.Post("/api/superadmin/applications/{id}/revoke", s.superadminApplicationRevoke)
		// Doc download — streams from S3 via DP internal (superadmin path).
		r.Get("/api/superadmin/applications/{id}/docs/{doc_id}/download", s.proxyDocDownloadSuperadmin)
		// Track 3: compat aliases for Rahul's CP frontend, which was
		// authored against Rahul's own CP backend and calls a few
		// endpoints under different paths. Aliases point at the same
		// handlers as the canonical routes so the FE works with this
		// backend as-is; no FE code churn.
		r.Get("/api/super/stats", s.superStatsCompat)
		r.Get("/api/super/organizations", s.superOrganizationsCompat)

		// Federated dashboard (Phase 2E).
		r.Get("/api/superadmin/dashboard", s.federatedDashboard)
	})

	// Data-Plane-proxied surface (Phase 3). Every endpoint below is
	// called by a Data Plane's server-side reverse proxy, NOT
	// directly by a browser. Gated by dpProxyAuth (shared api_key +
	// client_id headers). Handlers live in kyc_handlers.go.
	r.Group(func(r chi.Router) {
		r.Use(s.dpProxyAuth)

		// Registration surface — the DP forwards the applicant's
		// finished KYC to us at submit time.
		r.Post("/api/register/submit", s.cpRegisterSubmit)
		// DP calls this after an admin edits their rejected app and hits
		// "Re-submit" so the CP row moves rejected → pending + refreshes
		// fields + replaces the doc list. Without this the reviewer's
		// inbox never sees the resubmit and the app stays on the
		// Rejected tab forever.
		r.Post("/api/register/resubmit", s.cpRegisterResubmit)
		r.Get("/api/register/{id}", s.cpRegisterStatus)

		// Reviewer surface — the DP forwards its already-authed
		// reviewer's list/detail/decide calls to us. Scoping is by
		// the X-Data-Plane-Client-ID header, not by any CP-side JWT.
		r.Get("/api/reviewer/applications", s.cpReviewerList)
		r.Get("/api/reviewer/applications/{id}", s.cpReviewerGet)
		r.Post("/api/reviewer/applications/{id}/approve", s.cpReviewerApprove)
		r.Post("/api/reviewer/applications/{id}/reject", s.cpReviewerReject)
		r.Post("/api/reviewer/applications/{id}/revoke", s.cpReviewerRevoke)
		// Bulk equivalents — same auth model, iterate per id with
		// per-row error capture (returns {requested, succeeded, failed,
		// results[]}). Rahul's inbox POSTs {application_ids, note} here.
		r.Post("/api/reviewer/applications/bulk-approve", s.cpReviewerBulkApprove)
		r.Post("/api/reviewer/applications/bulk-reject", s.cpReviewerBulkReject)
		r.Get("/api/reviewer/applications/{id}/docs/{doc_id}/download", s.proxyDocDownloadReviewer)
	})

	return r
}

// ── shared HTTP helpers ──────────────────────────────────────────

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// friendlyServerError is the generic 5xx copy shown when a handler
// tried to hand us a raw driver / stack string. Matches the DP's
// wording so both planes read the same in the operator's UI.
const friendlyServerError = "Something went wrong on our end. Please try again in a moment."

// writeErr sends {"error": msg} at the given status code.
//
// For 4xx: message passes through unchanged (hand-crafted per handler).
//
// For 5xx: passes through when the message is already operator-facing
// (starts uppercase, no tech tokens like `pq:`, `sqlstate`,
// `constraint`, `panic`, `nil pointer`) — otherwise it's swapped for
// the generic and the technical detail is logged. Same rule as the DP
// side's writeErr; kept as an independent copy because the two api
// packages don't share code.
func writeErr(w http.ResponseWriter, status int, msg string) {
	if status >= 500 {
		if msg != "" && msg != friendlyServerError {
			log.Printf("[cp 5xx %d] %s", status, msg)
		}
		safe := msg
		if !isOperatorFacingMessage(msg) {
			safe = friendlyServerError
		}
		writeJSON(w, status, map[string]string{"error": safe})
		return
	}
	writeJSON(w, status, map[string]string{"error": msg})
}

// isOperatorFacingMessage — see backend/internal/api/helpers.go for
// the rationale. Kept as a lowercase-first table since CP is a
// separate package. Same tech-token list.
func isOperatorFacingMessage(msg string) bool {
	if msg == "" {
		return false
	}
	first := msg[0]
	if !(first >= 'A' && first <= 'Z') {
		return false
	}
	low := strings.ToLower(msg)
	techTokens := []string{
		"pq:", "pgx", "sqlstate", "constraint",
		"violates", "unique index", "foreign key",
		"null value in column",
		"db error", "db begin", "db commit", "db rollback",
		"db lookup", "db update", "db insert", "db read", "db list", "db tx",
		"row scan", "scan:", "exec ",
		"panic", "nil pointer", "runtime error",
		"http 5", "internal server error",
	}
	for _, t := range techTokens {
		if strings.Contains(low, t) {
			return false
		}
	}
	return true
}

// ── auth ────────────────────────────────────────────────────────

type ctxKey string

const claimsKey ctxKey = "cp_claims"

func (s *Server) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := r.Header.Get("Authorization")
		if !strings.HasPrefix(h, "Bearer ") {
			writeErr(w, http.StatusUnauthorized, "Your session has expired. Please sign in again.")
			return
		}
		tok := strings.TrimPrefix(h, "Bearer ")
		c, err := s.deps.JWT.Parse(tok)
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "Your session has expired. Please sign in again.")
			return
		}
		// Re-check the user against the CP DB on every request so a
		// mid-session disable / delete actually takes effect. Same
		// pattern as the Data Plane's authMiddleware.
		var disabledAt sql.NullTime
		var dbRole string
		err = s.deps.DB.QueryRowContext(r.Context(),
			`SELECT role, disabled_at FROM platform_users WHERE id = $1`, c.UserID,
		).Scan(&dbRole, &disabledAt)
		if errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusUnauthorized, "Your account is no longer available.")
			return
		}
		if err != nil {
			log.Printf("cp auth: db lookup failed: %v", err)
			writeErr(w, http.StatusInternalServerError, "auth check failed")
			return
		}
		if disabledAt.Valid {
			writeErr(w, http.StatusUnauthorized, "Your account has been disabled.")
			return
		}
		if dbRole != c.Role {
			writeErr(w, http.StatusUnauthorized, "Your session has expired. Please sign in again.")
			return
		}
		ctx := context.WithValue(r.Context(), claimsKey, c)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func claimsFrom(r *http.Request) *auth.Claims {
	c, _ := r.Context().Value(claimsKey).(*auth.Claims)
	return c
}

// ── endpoints ────────────────────────────────────────────────────

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	if err := s.deps.DB.PingContext(r.Context()); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"status": "degraded",
			"db":     err.Error(),
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "db": "ok"})
}

type loginReq struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	var req loginReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	var (
		id                       int64
		passHash                 string
		role                     string
		displayName              string
		disabledAt               sql.NullTime
		passChangeReq            int
	)
	err := s.deps.DB.QueryRowContext(r.Context(),
		`SELECT id, password_hash, role, display_name, disabled_at, password_change_required
		   FROM platform_users
		  WHERE username = $1
		  LIMIT 1`, strings.TrimSpace(req.Username),
	).Scan(&id, &passHash, &role, &displayName, &disabledAt, &passChangeReq)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	if err != nil {
		log.Printf("cp login: db error: %v", err)
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(passHash), []byte(req.Password)) != nil {
		writeErr(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	if disabledAt.Valid {
		writeErr(w, http.StatusForbidden, "account disabled")
		return
	}

	tok, err := s.deps.JWT.Issue(auth.Claims{
		UserID:   id,
		Username: strings.TrimSpace(req.Username),
		Role:     role,
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "token error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"token": tok,
		"user": map[string]any{
			"id":                       id,
			"username":                 strings.TrimSpace(req.Username),
			"role":                     role,
			"display_name":             displayName,
			"password_change_required": passChangeReq != 0,
		},
	})
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"id":       c.UserID,
		"username": c.Username,
		"role":     c.Role,
	})
}
