package api

import (
	"database/sql"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"

	"github.com/veni/neet-verification/internal/auth"
	"github.com/veni/neet-verification/internal/config"
	"github.com/veni/neet-verification/internal/data"
)

type Deps struct {
	DB    *sql.DB
	Index *data.Index
	JWT   *auth.JWTService
	Cfg   config.Config
}

type Server struct {
	deps Deps
}

func NewServer(d Deps) *Server { return &Server{deps: d} }

func (s *Server) Router() http.Handler {
	r := chi.NewRouter()

	r.Use(chimw.RequestID)
	r.Use(chimw.RealIP)
	r.Use(chimw.Recoverer)
	r.Use(chimw.Timeout(30 * time.Second))
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"http://localhost:5173", "http://127.0.0.1:5173"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Authorization", "Content-Type"},
		AllowCredentials: true,
		MaxAge:           300,
	}))

	r.Get("/api/health", s.health)
	r.Post("/api/auth/login", s.login)

	r.Group(func(r chi.Router) {
		r.Use(s.authMiddleware)

		r.Get("/api/me", s.me)

		// Client portal
		r.Get("/api/candidates/{roll}", s.requireRole("client", "admin", "superadmin")(s.getCandidate))
		r.Get("/api/candidates/{roll}/photo", s.requireRole("client", "admin", "superadmin")(s.getCandidatePhoto))
		r.Get("/api/candidates/{roll}/fp-template", s.requireRole("client")(s.getCandidateFPTemplate))
		r.Post("/api/verifications", s.requireRole("client")(s.createVerification))
		r.Post("/api/verifications/{id}/artifacts", s.requireRole("client")(s.uploadArtifact))

		// Admin / Superadmin
		r.Get("/api/admin/stats", s.requireRole("admin", "superadmin")(s.adminStats))
		r.Get("/api/admin/recent", s.requireRole("admin", "superadmin")(s.adminRecent))
		r.Get("/api/admin/by-center", s.requireRole("admin", "superadmin")(s.adminByCenter))
		r.Get("/api/admin/timeline", s.requireRole("admin", "superadmin")(s.adminTimeline))

		r.Get("/api/super/stats", s.requireRole("superadmin")(s.superStats))
		r.Get("/api/super/organizations", s.requireRole("superadmin")(s.superOrganizations))
		r.Get("/api/super/top-centers", s.requireRole("superadmin")(s.superTopCenters))
	})

	return r
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":     "ok",
		"candidates": s.deps.Index.CandidateCount(),
		"centers":    s.deps.Index.CenterCount(),
	})
}
