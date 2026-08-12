package api

import (
	"context"
	"database/sql"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"

	"github.com/veni/neet-verification/internal/auth"
	"github.com/veni/neet-verification/internal/config"
	"github.com/veni/neet-verification/internal/data"
	"github.com/veni/neet-verification/internal/email"
	"github.com/veni/neet-verification/internal/fpmatch"
	"github.com/veni/neet-verification/internal/luxand"
	"github.com/veni/neet-verification/internal/magiclink"
	"github.com/veni/neet-verification/internal/razorpay"
	"github.com/veni/neet-verification/internal/trustview"
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
	luxand     *luxand.Client    // optional; nil disables /api/face-match cleanly (kept as rollback path)
	fpMatchCl  *fpmatch.Client   // optional; nil disables /api/fp-match cleanly  (kept as rollback path)
	trustview  *trustview.Client // optional; nil = TRUSTVIEW_TOKEN empty, biometric compare handlers return 503
	wallet     *wallet.Store     // optional; nil disables /api/wallet/* + candidate charge
	razorpayCl *razorpay.Client  // optional; nil disables Razorpay deposit flow (admin_credit still works)

	// Institution onboarding deps. Both always wire up — magicLinks is
	// just a DB wrapper; emailer is the console sender by default and
	// can be swapped for SMTP later via the constructor.
	magicLinks *magiclink.Store
	emailer    email.Sender
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
	// TrustView hosted compare API — the new primary matcher for face,
	// fingerprint, and iris. Client is safe to construct even without a
	// token (Compare() preflights and returns KindNoToken cleanly); we
	// wire it unconditionally so the handler can produce a nice 503
	// with a specific error message instead of a nil-pointer panic.
	s.trustview = trustview.New(trustview.Config{
		BaseURL: d.Cfg.TrustViewBaseURL,
		Token:   d.Cfg.TrustViewToken,
	})
	// Wallet store always wires up (it's just a thin DB wrapper); the
	// candidate-charge middleware below short-circuits cleanly when
	// the per-deployment fee is 0, so deployments that don't want the
	// wallet feature don't need to do anything special — just set
	// WALLET_FEE_PER_LOOKUP_PAISE=0.
	s.wallet = wallet.New(d.DB)
	if d.Cfg.RazorpayKeyID != "" && d.Cfg.RazorpayKeySecret != "" {
		s.razorpayCl = razorpay.New(d.Cfg.RazorpayKeyID, d.Cfg.RazorpayKeySecret)
	}
	// Onboarding deps. When SMTP_HOST is configured we use a real
	// SMTPSender that talks to Gmail / SES / Zoho / etc; otherwise
	// the ConsoleSender prints magic links to the backend log so dev
	// without creds still works.
	s.magicLinks = magiclink.New(d.DB)
	if d.Cfg.SMTPHost != "" && d.Cfg.SMTPUser != "" && d.Cfg.SMTPPass != "" {
		s.emailer = email.NewSMTPSender(
			d.Cfg.SMTPHost, d.Cfg.SMTPPort,
			d.Cfg.SMTPUser, d.Cfg.SMTPPass, d.Cfg.SMTPFrom,
		)
	} else {
		s.emailer = email.NewConsoleSender()
	}
	return s
}

func (s *Server) Router() http.Handler {
	r := chi.NewRouter()

	r.Use(chimw.RequestID)
	r.Use(chimw.RealIP)
	r.Use(chimw.Recoverer)
	r.Use(chimw.Timeout(30 * time.Second))
	// CORS allowlist comes from config (ALLOWED_ORIGINS env). When unset
	// we fall back to the Vite dev server URLs so a fresh `go run` against
	// `npm run dev` Just Works. In production main.go enforces that
	// AllowedOrigins is non-empty before NewServer is called.
	allowed := s.deps.Cfg.AllowedOrigins
	if len(allowed) == 0 {
		allowed = []string{"http://localhost:5173", "http://127.0.0.1:5173"}
	}
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   allowed,
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Authorization", "Content-Type"},
		AllowCredentials: true,
		MaxAge:           300,
	}))

	r.Get("/api/health", s.health)
	r.Get("/api/readyz", s.readyz)
	r.Post("/api/auth/login", s.login)

	// ----- public institution-registration endpoints -----
	// These are intentionally unauthenticated — anyone with the form
	// can apply. Spam/abuse defence is per-IP rate limiting + honeypot
	// + superadmin manual review before any side-effect lands.
	r.Post("/api/register/init", s.registerInit)
	r.Post("/api/register/{id}/docs", s.registerUploadDoc)
	r.Delete("/api/register/{id}/docs/{doc_id}", s.registerDeleteDoc)
	r.Post("/api/register/{id}/submit", s.registerSubmit)
	r.Get("/api/register/{id}", s.registerStatus)

	// ----- public set-password landing -----
	// Backs the magic-link the head clicks after approval.
	r.Get("/api/set-password/verify", s.setPasswordVerify)
	r.Post("/api/set-password", s.setPassword)

	// ----- public Razorpay webhook -----
	// Razorpay POSTs payment events here directly (server-to-server, no
	// user session). Authentication is the HMAC-SHA256 of the body using
	// RAZORPAY_WEBHOOK_SECRET; the handler refuses any unsigned POST.
	// Public on purpose — Razorpay's servers can't carry our JWTs.
	r.Post("/api/razorpay/webhook", s.razorpayWebhook)

	r.Group(func(r chi.Router) {
		r.Use(s.authMiddleware)

		r.Get("/api/me", s.me)
		r.Post("/api/me/change-password", s.changePassword)

		// Client portal — FACE-FIRST FLOW:
		//   Candidate lookup is FREE for everyone (operator confirms a
		//   roll exists before opening the webcam; no incentive to
		//   avoid the confirmation).
		//   The chargeable event is the face-match itself: the wallet
		//   is debited on every face capture, regardless of match
		//   outcome — the operator committed to spending by capturing.
		//   Same-roll 5-min cache still applies for retries.
		r.Get("/api/candidates/{roll}",
			s.requireRole("client", "admin", "superadmin")(s.getCandidate))
		r.Get("/api/candidates/{roll}/photo", s.requireRole("client", "admin", "superadmin")(s.getCandidatePhoto))
		r.Get("/api/candidates/{roll}/fp-template", s.requireRole("client")(s.getCandidateFPTemplate))
		r.Get("/api/candidates/{roll}/face-template", s.requireRole("client", "admin", "superadmin")(s.getCandidateFaceTemplate))
		// Phase 3c: attempt counter for the operator UI's "Nth attempt" chip.
		r.Get("/api/candidates/{roll}/attempts", s.requireRole("client", "admin")(s.getCandidateAttempts))
		// New URL-scoped routes so the wallet middleware can extract
		// {roll} for the same-roll 5-min cache. Old body-based routes
		// stay wired below for anything still calling them.
		r.Post("/api/candidates/{roll}/face-match", s.requireRole("client")(s.walletCharge(s.faceMatch)))
		r.Post("/api/candidates/{roll}/fp-match",   s.requireRole("client")(s.fpMatch))
		// Iris moved server-side with the TrustView migration — used to
		// live entirely on the operator laptop against the Marvis daemon.
		// No wallet charge here: the face-match on the same verification
		// already covered the same-roll cache window, so iris is a free
		// follow-on decision.
		r.Post("/api/candidates/{roll}/iris-match", s.requireRole("client")(s.irisMatch))
		// Legacy (kept for a release window; the new operator UI uses
		// the URL-scoped routes above).
		r.Post("/api/face-match", s.requireRole("client")(s.faceMatch))
		r.Post("/api/fp-match",   s.requireRole("client")(s.fpMatch))
		r.Post("/api/verifications", s.requireRole("client")(s.createVerification))
		r.Post("/api/verifications/{id}/artifacts", s.requireRole("client")(s.uploadArtifact))

		// Wallet — admin sees own org, superadmin sees any org via ?org_id=N.
		// Razorpay top-up is admin-only (admin tops up own org); superadmin
		// uses /api/admin/wallet/credit for manual support credits.
		r.Get("/api/wallet/config", s.requireRole("admin", "superadmin")(s.walletConfig))
		r.Get("/api/wallet", s.requireRole("admin", "superadmin")(s.walletBalance))
		r.Post("/api/wallet/order", s.requireRole("admin")(s.walletOrder))
		r.Post("/api/wallet/verify-payment", s.requireRole("admin")(s.walletVerifyPayment))

		// Admin / Superadmin
		r.Get("/api/admin/stats", s.requireRole("admin", "superadmin")(s.adminStats))
		r.Get("/api/admin/recent", s.requireRole("admin", "superadmin")(s.adminRecent))
		r.Get("/api/admin/by-center", s.requireRole("admin", "superadmin")(s.adminByCenter))
		r.Get("/api/admin/timeline", s.requireRole("admin", "superadmin")(s.adminTimeline))
		r.Get("/api/admin/verifications", s.requireRole("admin", "superadmin")(s.adminListVerifications))
		r.Get("/api/admin/verifications.csv", s.requireRole("admin", "superadmin")(s.adminExportVerificationsCSV))
		r.Post("/api/admin/wallet/credit", s.requireRole("superadmin")(s.adminWalletCredit))

		// Phase-2 admin surface: exam catalog subscribe / unsubscribe.
		r.Get("/api/admin/catalog",                    s.requireRole("admin")(s.adminCatalog))
		r.Get("/api/admin/subscriptions",              s.requireRole("admin")(s.adminListSubscriptions))
		r.Post("/api/admin/subscriptions",             s.requireRole("admin")(s.adminSubscribe))
		r.Delete("/api/admin/subscriptions/{exam_id}", s.requireRole("admin")(s.adminUnsubscribe))

		// Phase-2 admin surface: multi-operator management.
		r.Get("/api/admin/operators",                  s.requireRole("admin")(s.adminListOperators))
		r.Post("/api/admin/operators",                 s.requireRole("admin")(s.adminCreateOperator))
		r.Get("/api/admin/operators/{id}",             s.requireRole("admin")(s.adminGetOperator))
		r.Patch("/api/admin/operators/{id}",           s.requireRole("admin")(s.adminPatchOperator))
		r.Post("/api/admin/operators/{id}/disable",    s.requireRole("admin")(s.adminDisableOperator))
		r.Post("/api/admin/operators/{id}/enable",     s.requireRole("admin")(s.adminEnableOperator))

		// Downloads — serves the operator-laptop install bundle. Open
		// to admin (so an admin can grab + redistribute), to client
		// (so an operator on a fresh laptop can self-serve when the
		// admin can't physically deliver the zip), and to superadmin
		// (for support work). Org-scoped: last-download metadata is
		// recorded per org regardless of which role triggered it.
		// Bundle artefact lives in DOWNLOADS_DIR; the handler picks
		// the latest matching file at request time so a deploy drops
		// a new build in place without a restart.
		r.Get("/api/downloads",
			s.requireRole("admin", "client", "superadmin")(s.adminListDownloads))
		r.Get("/api/downloads/operator-client",
			s.requireRole("admin", "client", "superadmin")(s.adminDownloadOperatorClient))

		r.Get("/api/super/stats", s.requireRole("superadmin")(s.superStats))
		r.Get("/api/super/organizations", s.requireRole("superadmin")(s.superOrganizations))
		r.Get("/api/super/top-centers", s.requireRole("superadmin")(s.superTopCenters))
		r.Get("/api/super/metrics", s.requireRole("superadmin")(s.superMetrics))
		r.Get("/api/super/audit", s.requireRole("superadmin")(s.superAuditList))

		// Institution-application review queue. Superadmin-only — the
		// docs contain head-of-institution PII (mobile, email, PAN) so
		// admin role intentionally doesn't have read access.
		// Institution-application review queue. Allowed for
		// superadmin (platform owner) AND ops_admin (dedicated
		// onboarding-team role). Same endpoints, two roles — see
		// migration 7 for the role split rationale.
		r.Get("/api/superadmin/applications", s.requireRole("superadmin", "ops_admin")(s.superadminListApplications))
		r.Get("/api/superadmin/applications/{id}", s.requireRole("superadmin", "ops_admin")(s.superadminGetApplication))
		r.Get("/api/superadmin/applications/{id}/docs/{doc_id}", s.requireRole("superadmin", "ops_admin")(s.superadminDownloadDoc))
		r.Post("/api/superadmin/applications/{id}/approve", s.requireRole("superadmin", "ops_admin")(s.superadminApproveApplication))
		r.Post("/api/superadmin/applications/{id}/reject", s.requireRole("superadmin", "ops_admin")(s.superadminRejectApplication))
		r.Post("/api/superadmin/applications/{id}/resend-admin-link", s.requireRole("superadmin", "ops_admin")(s.superadminResendAdminLink))

		// ── Exam catalog (Phase 1: superadmin creates clients + exams + candidates)
		// Everything under this prefix is superadmin-only.
		r.Post("/api/superadmin/clients",                              s.requireRole("superadmin")(s.superadminCreateClient))
		r.Get("/api/superadmin/clients",                               s.requireRole("superadmin")(s.superadminListClients))
		r.Get("/api/superadmin/clients/{id}",                          s.requireRole("superadmin")(s.superadminGetClient))
		r.Patch("/api/superadmin/clients/{id}",                        s.requireRole("superadmin")(s.superadminPatchClient))
		r.Post("/api/superadmin/clients/{id}/visibility",              s.requireRole("superadmin")(s.superadminToggleClientVisibility))
		r.Post("/api/superadmin/clients/{id}/close",                   s.requireRole("superadmin")(s.superadminCloseClient))
		r.Post("/api/superadmin/clients/{id}/reopen",                  s.requireRole("superadmin")(s.superadminReopenClient))

		r.Post("/api/superadmin/clients/{id}/exams",                   s.requireRole("superadmin")(s.superadminCreateExam))
		r.Get("/api/superadmin/exams/{id}",                            s.requireRole("superadmin")(s.superadminGetExam))
		r.Patch("/api/superadmin/exams/{id}",                          s.requireRole("superadmin")(s.superadminPatchExam))
		r.Post("/api/superadmin/exams/{id}/visibility",                s.requireRole("superadmin")(s.superadminToggleExamVisibility))
		r.Post("/api/superadmin/exams/{id}/close",                     s.requireRole("superadmin")(s.superadminCloseExam))
		r.Post("/api/superadmin/exams/{id}/reopen",                    s.requireRole("superadmin")(s.superadminReopenExam))

		r.Post("/api/superadmin/exams/{id}/candidates",                s.requireRole("superadmin")(s.superadminUploadExamCSV))
		r.Get("/api/superadmin/exams/{id}/candidates",                 s.requireRole("superadmin")(s.superadminListCandidates))
		r.Get("/api/superadmin/exams/{id}/uploads",                    s.requireRole("superadmin")(s.superadminListUploads))
		r.Get("/api/superadmin/uploads/{upload_id}/raw",               s.requireRole("superadmin")(s.superadminDownloadRawCSV))

		// Per-exam centre catalog (migration 019). Superadmin uploads /
		// lists (board-owned data); admin reads if their org is subscribed.
		r.Post("/api/superadmin/exams/{id}/centres/upload", s.requireRole("superadmin")(s.uploadExamCentres))
		r.Get("/api/superadmin/exams/{id}/centres",         s.requireRole("superadmin")(s.listExamCentres))
		r.Get("/api/admin/exams/{id}/centres",              s.requireRole("admin")(s.listExamCentres))

		// Per-exam bulk operator upload — admin creates their own
		// operators in bulk and links them to a subscribed exam.
		r.Post("/api/admin/exams/{id}/operators/upload", s.requireRole("admin")(s.uploadExamOperators))

		// PDF verification receipt — role-scoped inside the handler
		// (operator: own rows; admin: org rows; superadmin: all).
		r.Get("/api/verifications/{id}/pdf",
			s.requireRole("client", "admin", "superadmin", "ops_admin")(s.verificationPDF))
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

// readyz is the orchestrator-readable check that the process can
// actually serve traffic right now (DB reachable). Distinct from
// `/api/health` which only proves the process is running — orchestrators
// like Kubernetes use readiness probes to gate traffic during rolling
// restarts and DB-failure backoff. Returns 503 instead of 500 so a
// load balancer correctly drops the instance.
func (s *Server) readyz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.deps.DB.PingContext(ctx); err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"ready":false,"reason":"db-unreachable"}`))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ready": true})
}
