package api

import (
	"context"
	"database/sql"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"

	"github.com/veni/neet-verification/internal/auth"
	"github.com/veni/neet-verification/internal/config"
	"github.com/veni/neet-verification/internal/data"
	"github.com/veni/neet-verification/internal/email"
	"github.com/veni/neet-verification/internal/luxand"
	"github.com/veni/neet-verification/internal/magiclink"
	"github.com/veni/neet-verification/internal/otp"
	"github.com/veni/neet-verification/internal/razorpay"
	"github.com/veni/neet-verification/internal/sms"
	"github.com/veni/neet-verification/internal/storage"
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
	trustview  *trustview.Client // optional; nil = TRUSTVIEW_TOKEN empty, biometric compare handlers return 503
	luxand     *luxand.Client    // active-liveness only; nil-safe (client returns ErrDisabled)
	storage    *storage.Client   // S3 for photos + KYC docs; nil = disabled (dev) — every method is nil-safe
	wallet     *wallet.Store     // optional; nil disables /api/wallet/* + candidate charge
	razorpayCl *razorpay.Client  // optional; nil disables Razorpay deposit flow (admin_credit still works)

	// Institution onboarding deps. Both always wire up — magicLinks is
	// just a DB wrapper; emailer is the console sender by default and
	// can be swapped for SMTP later via the constructor.
	magicLinks *magiclink.Store
	emailer    email.Sender
	smsSender  sms.Sender
	otpStore   *otp.Store
}

// NewServer wires the API. External clients (TrustView, Razorpay) are
// constructed lazily here so the server can boot before those services
// are reachable — dependent endpoints fail with 503 until the service
// is up, but the rest of the API stays available. This is what lets
// the backend run on a dev laptop without all the auxiliary services.
func NewServer(d Deps) *Server {
	s := &Server{deps: d}
	// TrustView hosted compare API — the new primary matcher for face,
	// fingerprint, and iris. Client is safe to construct even without a
	// token (Compare() preflights and returns KindNoToken cleanly); we
	// wire it unconditionally so the handler can produce a nice 503
	// with a specific error message instead of a nil-pointer panic.
	s.trustview = trustview.New(trustview.Config{
		BaseURL: d.Cfg.TrustViewBaseURL,
		Token:   d.Cfg.TrustViewToken,
	})
	// Luxand: liveness-only, nil-safe. If LUXAND_BASE_URL is blank the
	// client itself returns ErrDisabled when called, so downstream
	// handlers can 503 with a specific message.
	s.luxand = luxand.New(luxand.Config{
		BaseURL: d.Cfg.LuxandBaseURL,
	})
	// S3 storage. Nil-safe — if S3_BUCKET is empty (dev machines
	// without AWS creds) the client is nil and the disk fallback stays
	// in effect. Boot-time HeadBucket probe surfaces a bad role or
	// wrong-region config LOUD instead of silently on the first
	// photo request.
	if cli, err := storage.New(context.Background(), storage.Config{
		Bucket: d.Cfg.S3Bucket,
		Region: d.Cfg.S3Region,
	}); err != nil {
		log.Printf("storage: init failed (%s region=%s): %v — falling back to disk",
			d.Cfg.S3Bucket, d.Cfg.S3Region, err)
	} else if cli != nil {
		s.storage = cli
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if perr := s.storage.Probe(ctx); perr != nil {
			log.Printf("storage: HeadBucket probe failed on %s: %v — the role attached to this instance may lack s3:ListBucket or the bucket doesn't exist",
				s.storage.Bucket(), perr)
		} else {
			log.Printf("storage: S3 ready (bucket=%s region=%s photos_backend=%s)",
				s.storage.Bucket(), d.Cfg.S3Region, d.Cfg.PhotosBackend)
		}
		cancel()
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

	// SMS sender for OTP delivery. AuthKey.io when key is provided, else ConsoleSender.
	if d.Cfg.AuthKeySMSKey != "" {
		s.smsSender = sms.NewAuthKeySender(sms.AuthKeyConfig{
			BaseURL:     d.Cfg.AuthKeySMSURL,
			AuthKey:     d.Cfg.AuthKeySMSKey,
			SID:         d.Cfg.AuthKeySMSSID,
			Company:     d.Cfg.AuthKeySMSCompany,
			CountryCode: d.Cfg.AuthKeySMSCountryCode,
		})
	} else {
		s.smsSender = sms.NewConsoleSender()
	}

	// OTP store initialized with JWT secret for HMAC proof signing
	s.otpStore = otp.NewStore(d.Cfg.JWTSecret)

	return s
}

func (s *Server) Router() http.Handler {
	r := chi.NewRouter()

	r.Use(chimw.RequestID)
	r.Use(chimw.RealIP)
	r.Use(chimw.Recoverer)
	r.Use(skipTimeoutFor(chimw.Timeout(30*time.Second),
		"/api/downloads/",
		"/bulk/", // superadmin bulk zip upload — 2 GB uploads can take 10+ min
	))
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

	// ----- public OTP verification endpoints -----
	r.Post("/api/otp/send-email", s.sendEmailOTP)
	r.Post("/api/otp/verify-email", s.verifyEmailOTP)
	r.Post("/api/otp/send-sms", s.sendSmsOTP)
	r.Post("/api/otp/verify-sms", s.verifySmsOTP)

	// ----- public institution-registration endpoints -----
	// These are intentionally unauthenticated — anyone with the form
	// can apply. Spam/abuse defence is per-IP rate limiting + honeypot
	// + superadmin manual review before any side-effect lands.
	r.Post("/api/register/check", s.registerCheckIdentifiers)
	r.Post("/api/register/init", s.registerInit)
	r.Post("/api/register/{id}/docs", s.registerUploadDoc)
	r.Delete("/api/register/{id}/docs/{doc_id}", s.registerDeleteDoc)
	r.Post("/api/register/{id}/submit", s.registerSubmit)
	r.Get("/api/register/{id}", s.registerStatus)

	// ----- public: which clients accept KYC -----
	// Feeds the register form's exam-board dropdown. Filters to clients
	// where portal_enabled AND visible AND not closed so we never route
	// a KYC to a board that can't act on it.
	r.Get("/api/clients/public", s.publicListClients)

	// ----- public: mobile app runtime knobs -----
	// Unauthenticated: the Android verification-agent app hits this
	// BEFORE login to decide whether the installed version is still
	// supported. All fields are display / soft-tuning; no secrets.
	r.Get("/api/mobile/config", s.mobileConfig)

	// ----- public password recovery & set-password endpoints -----
	r.Post("/api/auth/forgot-password", s.forgotPassword)
	r.Get("/api/set-password/verify", s.setPasswordVerify)
	r.Post("/api/set-password", s.setPassword)
	r.Get("/api/reset-password/verify", s.setPasswordVerify)
	r.Post("/api/reset-password", s.setPassword)

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
		r.Post("/api/auth/refresh", s.authRefresh)

		// Client portal — LIVENESS-GATED FLOW:
		//   Candidate lookup is FREE for everyone (operator confirms a
		//   roll exists before starting the flow; no incentive to
		//   avoid the confirmation).
		//   The chargeable event is the *liveness pass* (see the
		//   /liveness-check route below and wallet_middleware.go for
		//   the details on the X-Wallet-Skip skip-charge signal).
		//   Debiting at liveness covers face-only, fp-only, iris-only,
		//   and multi-modality exams uniformly — every real session
		//   pays exactly once. Same-roll 5-min cache still applies
		//   for retries, so a retake within the window is free.
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
		// Active-liveness gate. Runs BEFORE face/fp/iris match — the
		// operator records a short blink challenge, we forward frames
		// to luxand-service, and on pass we stash a liveness_checks
		// row keyed by session_id (same key the biometric matchers
		// use as idempotency_key).
		//
		// WALLET DEBIT LIVES HERE (2026-08-24 change). Previously the
		// charge fired on /face-match, which meant fingerprint-only
		// or iris-only exams (`requires_face=false`) were completely
		// free — the app never called /face-match. Moving the charge
		// to /liveness-check fixes that: liveness always fires for
		// any biometric session (see FlowRouting.kt + Dashboard.jsx
		// unconditional S_LIVENESS), so every real verification pays
		// exactly once.
		//
		// Failed liveness attempts do NOT charge — the handler sets
		// X-Wallet-Skip:1 on the pass:false path and walletCharge
		// honors it. Retries are free until the operator clears the
		// gate. Same-roll 5-min cache continues to apply.
		r.Post("/api/candidates/{roll}/liveness-check",
			s.requireRole("client")(s.walletCharge(s.livenessCheck)))
		r.Post("/api/candidates/{roll}/face-match", s.requireRole("client")(s.faceMatch))
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
		// Mobile app calls the candidate-scoped URL for symmetry with
		// /face-match, /fp-match, /iris-match, /liveness-check — all
		// of which live under /api/candidates/{roll}/. Alias so the
		// mobile client works without a rebuild; handler reads roll
		// from the request body and ignores the path param.
		r.Post("/api/candidates/{roll}/verifications", s.requireRole("client")(s.createVerification))
		r.Patch("/api/verifications/{id}", s.requireRole("client")(s.patchVerification))

		// Wallet — admin sees own org, superadmin sees any org via ?org_id=N.
		// Razorpay top-up is admin-only (admin tops up own org); superadmin
		// uses /api/admin/wallet/credit for manual support credits.
		r.Get("/api/wallet/config", s.requireRole("admin", "superadmin")(s.walletConfig))
		r.Get("/api/wallet", s.requireRole("admin", "superadmin")(s.walletBalance))
		// Lightweight summary — balance + fee only, no txn history.
		// Client (operator) role allowed so the operator UI can render
		// a live wallet pill.
		r.Get("/api/wallet/summary", s.requireRole("client", "admin", "superadmin")(s.walletSummary))
		r.Post("/api/wallet/order", s.requireRole("admin")(s.walletOrder))
		r.Post("/api/wallet/verify-payment", s.requireRole("admin")(s.walletVerifyPayment))

		// Admin / Superadmin
		// Open (no KYC gate) — the frontend lock screen needs these to
		// render pending / rejected UX and drive the rejected-app
		// resubmit flow. Every other admin endpoint is KYC-gated via
		// requireRole.
		r.Get("/api/admin/kyc-status", s.requireRoleOpen("admin")(s.adminKYCStatus))
		r.Get("/api/admin/kyc-application",                       s.requireRoleOpen("admin")(s.adminGetMyKYCApplication))
		r.Patch("/api/admin/kyc-application",                     s.requireRoleOpen("admin")(s.adminPatchMyKYCApplication))
		r.Get("/api/admin/kyc-application/docs/{doc_id}",         s.requireRoleOpen("admin")(s.adminDownloadMyKYCDoc))
		r.Post("/api/admin/kyc-application/docs",                 s.requireRoleOpen("admin")(s.adminUploadMyKYCDoc))
		r.Delete("/api/admin/kyc-application/docs/{doc_id}",      s.requireRoleOpen("admin")(s.adminDeleteMyKYCDoc))
		r.Post("/api/admin/kyc-application/resubmit",             s.requireRoleOpen("admin")(s.adminResubmitMyKYCApplication))
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
		r.Get("/api/downloads/agent-android",
			s.requireRole("admin", "client", "superadmin")(s.downloadAgentAndroid))

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
		r.Post("/api/superadmin/applications/{id}/route",  s.requireRole("superadmin", "ops_admin")(s.superadminRouteApplication))
		r.Post("/api/superadmin/applications/{id}/resend-admin-link", s.requireRole("superadmin", "ops_admin")(s.superadminResendAdminLink))

		// ── Client-reviewer portal (per-client KYC inbox)
		// A client_reviewer user's JWT carries their client_id; every
		// handler below is scoped to that id server-side. Superadmin
		// keeps using /api/superadmin/applications/*, which sees every
		// row regardless of client_id.
		r.Get("/api/client/me",                              s.requireRole("client_reviewer")(s.clientReviewerMe))
		r.Get("/api/client/applications",                    s.requireRole("client_reviewer")(s.clientListApplications))
		r.Get("/api/client/applications/{id}",               s.requireRole("client_reviewer")(s.clientGetApplication))
		r.Get("/api/client/applications/{id}/docs/{doc_id}", s.requireRole("client_reviewer")(s.clientDownloadDoc))
		r.Post("/api/client/applications/{id}/approve",      s.requireRole("client_reviewer")(s.clientApproveApplication))
		r.Post("/api/client/applications/{id}/reject",       s.requireRole("client_reviewer")(s.clientRejectApplication))

		// Client-reviewer subscription request management
		r.Get("/api/client/subscription-requests",                                 s.requireRole("client_reviewer")(s.clientListSubscriptionRequests))
		r.Post("/api/client/subscription-requests/bulk-approve",                    s.requireRole("client_reviewer")(s.clientBulkApproveSubscriptionRequests))
		r.Post("/api/client/subscription-requests/bulk-reject",                     s.requireRole("client_reviewer")(s.clientBulkRejectSubscriptionRequests))
		r.Post("/api/client/subscription-requests/bulk-csv-decide",                 s.requireRole("client_reviewer")(s.clientBulkDecideSubscriptionRequestsCSV))
		r.Post("/api/client/subscription-requests/{org_id}/{exam_id}/approve",     s.requireRole("client_reviewer")(s.clientApproveSubscriptionRequest))
		r.Post("/api/client/subscription-requests/{org_id}/{exam_id}/reject",      s.requireRole("client_reviewer")(s.clientRejectSubscriptionRequest))
		r.Post("/api/client/subscription-requests/{org_id}/{exam_id}/revoke",      s.requireRole("client_reviewer")(s.clientRevokeSubscriptionRequest))
		r.Get("/api/client/subscription-requests/export.csv",                     s.requireRole("client_reviewer")(s.clientExportApprovedSubscriptionsCSV))
		r.Post("/api/client/subscription-requests/{org_id}/{exam_id}/reset-pending", s.requireRole("client_reviewer")(s.clientResetSubscriptionRequestToPending))

		// Superadmin management of the per-client portal — enable/disable
		// the client's inbox and CRUD the reviewer users that log into it.
		r.Post("/api/superadmin/clients/{id}/portal",              s.requireRole("superadmin")(s.superadminSetClientPortal))
		r.Get("/api/superadmin/clients/{id}/reviewers",            s.requireRole("superadmin")(s.superadminListReviewers))
		r.Post("/api/superadmin/clients/{id}/reviewers",           s.requireRole("superadmin")(s.superadminCreateReviewer))
		r.Delete("/api/superadmin/clients/{id}/reviewers/{uid}",   s.requireRole("superadmin")(s.superadminDeleteReviewer))

		// ── Exam catalog (Phase 1: superadmin creates clients + exams + candidates)
		// Everything under this prefix is superadmin-only.
		r.Post("/api/superadmin/clients",                              s.requireRole("superadmin")(s.superadminCreateClient))
		r.Get("/api/superadmin/clients",                               s.requireRole("superadmin")(s.superadminListClients))
		r.Get("/api/superadmin/clients/{id}",                          s.requireRole("superadmin")(s.superadminGetClient))
		r.Patch("/api/superadmin/clients/{id}",                        s.requireRole("superadmin")(s.superadminPatchClient))
		r.Post("/api/superadmin/clients/{id}/visibility",              s.requireRole("superadmin")(s.superadminToggleClientVisibility))
		r.Post("/api/superadmin/clients/{id}/close",                   s.requireRole("superadmin")(s.superadminCloseClient))
		r.Post("/api/superadmin/clients/{id}/reopen",                  s.requireRole("superadmin")(s.superadminReopenClient))
		r.Delete("/api/superadmin/clients/{id}",                       s.requireRole("superadmin")(s.superadminDeleteClient))

		r.Post("/api/superadmin/clients/{id}/exams",                   s.requireRole("superadmin")(s.superadminCreateExam))
		r.Get("/api/superadmin/exams/{id}",                            s.requireRole("superadmin")(s.superadminGetExam))
		r.Patch("/api/superadmin/exams/{id}",                          s.requireRole("superadmin")(s.superadminPatchExam))
		r.Post("/api/superadmin/exams/{id}/visibility",                s.requireRole("superadmin")(s.superadminToggleExamVisibility))
		r.Post("/api/superadmin/exams/{id}/close",                     s.requireRole("superadmin")(s.superadminCloseExam))
		r.Post("/api/superadmin/exams/{id}/reopen",                    s.requireRole("superadmin")(s.superadminReopenExam))
		r.Delete("/api/superadmin/exams/{id}",                         s.requireRole("superadmin")(s.superadminDeleteExam))

		r.Post("/api/superadmin/exams/{id}/candidates",                s.requireRole("superadmin")(s.superadminUploadExamCSV))
		r.Get("/api/superadmin/exams/{id}/candidates",                 s.requireRole("superadmin")(s.superadminListCandidates))
		r.Get("/api/superadmin/exams/{id}/completeness",               s.requireRole("superadmin")(s.superadminExamCompleteness))
		r.Post("/api/superadmin/exams/{id}/candidates/{roll}/biometric", s.requireRole("superadmin")(s.superadminUploadBiometric))
		// Bulk zip upload — one route per modality. Superadmin picks a
		// .zip on their machine, browser POSTs it here, backend streams
		// entries straight into S3 keyed by <exam_code>/<modality>/<roll>.<ext>
		// and flips the has_* flag on exam_candidates. Strict filename
		// convention (<roll>.<ext>) — bad names land in the per-file
		// summary as "skipped".
		r.Post("/api/superadmin/exams/{id}/bulk/{modality}",
			s.requireRole("superadmin")(s.superadminBulkUpload))
		r.Post("/api/superadmin/reindex",                              s.requireRole("superadmin")(s.superadminReindex))
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

// skipTimeoutFor lets a middleware apply globally EXCEPT for a set of
// URL-path patterns. Matches on substring (not just prefix) so we can
// exempt routes with a dynamic segment in the middle — e.g. "/bulk/"
// matches "/api/superadmin/exams/12/bulk/photos" without exempting
// every other endpoint under /api/superadmin/exams/.
//
// Existing "/api/downloads/" caller still works: any URL starting
// with that prefix also contains it, so semantics don't change for
// prefix-style patterns.
//
// Used to keep the 30s request-timeout guard on all JSON endpoints
// while letting long-running operations run: the operator-bundle
// download (~300 MB streamed) + bulk biometric uploads (up to 2 GB
// zips, which can take 10+ minutes on a centre uplink). Without the
// exemption chi.Timeout wraps the ResponseWriter and cuts off the
// stream mid-flight, which the reverse proxy sees as an unexpected
// EOF and the browser reports as ERR_HTTP2_PROTOCOL_ERROR.
func skipTimeoutFor(mw func(http.Handler) http.Handler, patterns ...string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		wrapped := mw(next)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			for _, p := range patterns {
				if strings.Contains(r.URL.Path, p) {
					next.ServeHTTP(w, r)
					return
				}
			}
			wrapped.ServeHTTP(w, r)
		})
	}
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
