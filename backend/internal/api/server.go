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
	"github.com/veni/neet-verification/internal/fpmatch"
	"github.com/veni/neet-verification/internal/luxand"
	"github.com/veni/neet-verification/internal/razorpay"
	"github.com/veni/neet-verification/internal/wallet"
)

type Deps struct {
	DB    *sql.DB
	Index *data.Index
	JWT   *auth.JWTService
	Cfg   config.Config
}

type Server struct {
	deps       Deps
	luxand     *luxand.Client    // optional; nil disables /api/face-match cleanly
	fpMatchCl  *fpmatch.Client   // optional; nil disables /api/fp-match cleanly
	wallet     *wallet.Store     // optional; nil disables /api/wallet/* + candidate charge
	razorpayCl *razorpay.Client  // optional; nil disables Razorpay deposit flow (admin_credit still works)
}

// NewServer wires the API. The luxand + fp-match + razorpay clients are
// constructed lazily here so the server can boot before any external
// service is reachable — those endpoints fail with 503 until the service
// is up, but the rest of the API stays available. This is what lets the
// backend run on a dev laptop without all the auxiliary services yet.
func NewServer(d Deps) *Server {
	s := &Server{deps: d}
	if d.Cfg.LuxandBase != "" {
		s.luxand = luxand.New(d.Cfg.LuxandBase)
	}
	if d.Cfg.FpMatchBase != "" {
		s.fpMatchCl = fpmatch.New(d.Cfg.FpMatchBase)
	}
	// Wallet store always wires up (it's just a thin DB wrapper); the
	// candidate-charge middleware below short-circuits cleanly when
	// the per-deployment fee is 0, so deployments that don't want the
	// wallet feature don't need to do anything special — just set
	// WALLET_FEE_PER_LOOKUP_PAISE=0.
	s.wallet = wallet.New(d.DB)
	if d.Cfg.RazorpayKeyID != "" && d.Cfg.RazorpayKeySecret != "" {
		s.razorpayCl = razorpay.New(d.Cfg.RazorpayKeyID, d.Cfg.RazorpayKeySecret)
	}
	return s
}

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

		// Client portal — note that getCandidate is wrapped in walletCharge
		// for client-role users only. Admin/superadmin can lookup rolls
		// for free (e.g. for audit/support); the charge fires once per
		// (user_id, roll_no) within WalletSameRollCacheMin minutes so a
		// refresh or quick re-search doesn't double-bill.
		r.Get("/api/candidates/{roll}",
			s.requireRole("client", "admin", "superadmin")(
				s.walletCharge(s.getCandidate)))
		r.Get("/api/candidates/{roll}/photo", s.requireRole("client", "admin", "superadmin")(s.getCandidatePhoto))
		r.Get("/api/candidates/{roll}/fp-template", s.requireRole("client")(s.getCandidateFPTemplate))
		r.Get("/api/candidates/{roll}/face-template", s.requireRole("client", "admin", "superadmin")(s.getCandidateFaceTemplate))
		r.Post("/api/face-match", s.requireRole("client")(s.faceMatch))
		r.Post("/api/fp-match", s.requireRole("client")(s.fpMatch))
		r.Post("/api/verifications", s.requireRole("client")(s.createVerification))
		r.Post("/api/verifications/{id}/artifacts", s.requireRole("client")(s.uploadArtifact))

		// Wallet (client-role only)
		r.Get("/api/wallet/config", s.requireRole("client")(s.walletConfig))
		r.Get("/api/wallet", s.requireRole("client")(s.walletBalance))
		r.Post("/api/wallet/order", s.requireRole("client")(s.walletOrder))
		r.Post("/api/wallet/verify-payment", s.requireRole("client")(s.walletVerifyPayment))

		// Admin / Superadmin
		r.Get("/api/admin/stats", s.requireRole("admin", "superadmin")(s.adminStats))
		r.Get("/api/admin/recent", s.requireRole("admin", "superadmin")(s.adminRecent))
		r.Get("/api/admin/by-center", s.requireRole("admin", "superadmin")(s.adminByCenter))
		r.Get("/api/admin/timeline", s.requireRole("admin", "superadmin")(s.adminTimeline))
		r.Post("/api/admin/wallet/credit", s.requireRole("admin", "superadmin")(s.adminWalletCredit))

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
