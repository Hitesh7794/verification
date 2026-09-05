package api

// Internal API — server-to-server surface consumed by the Control Plane
// as part of the multi-tenant migration (Phase 1). Every handler in
// this file sits behind internalAuth so a curious external caller sees
// 401; the only legitimate caller is the Control Plane, holding the
// shared INTERNAL_API_KEY.
//
// Three endpoints per the implementation plan:
//
//   GET  /internal/health        — DB connectivity probe + migration
//                                  version, so the Control Plane can
//                                  route away from an unhealthy Data
//                                  Plane before firing user traffic.
//
//   GET  /internal/metrics       — Aggregated counts the Control Plane
//                                  sums across every Data Plane to
//                                  build its federated superadmin
//                                  dashboard. Reads only, no writes.
//
//   POST /internal/orgs/create   — Idempotent org + admin user + magic
//                                  link provisioning. Fired by the
//                                  Control Plane when a KYC application
//                                  is fully approved. The Control Plane
//                                  supplies the payload; the Data Plane
//                                  owns the resulting rows.
//
// All three deliberately reuse the existing single-DB shape — no
// per-tenant scoping needed yet. Physical DB split happens in Phase 4
// of the migration; the code here doesn't change at that point,
// because each Data Plane binary will then be pointed at its own DB
// via DATABASE_URL and these queries will scope themselves naturally.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"golang.org/x/crypto/bcrypt"

	"github.com/veni/neet-verification/internal/db"
	"github.com/veni/neet-verification/internal/email"
	"github.com/veni/neet-verification/internal/magiclink"
)

// ── GET /internal/health ──────────────────────────────────────────

type internalHealthResp struct {
	// Status is "ok" when the DB is reachable, "degraded" when the
	// process is up but Postgres has just gone missing (DB restarted
	// out from under us, network blip, credential rotation in
	// progress). The Control Plane uses this to decide whether to
	// include this Data Plane in the next federated metrics fan-out.
	Status string `json:"status"`
	// DB is either "ok" or the error string from the ping (kept short
	// so log-scraping stays readable). Never a full stack.
	DB string `json:"db"`
	// SchemaVersion is the highest applied migration version on this
	// Data Plane. If two Data Planes disagree the Control Plane can
	// hold off on Phase-3 KYC provisioning until they reconcile.
	SchemaVersion int64 `json:"schema_version"`
}

func (s *Server) internalHealth(w http.ResponseWriter, r *http.Request) {
	resp := internalHealthResp{Status: "ok", DB: "ok"}

	if err := s.deps.DB.PingContext(r.Context()); err != nil {
		resp.Status = "degraded"
		resp.DB = err.Error()
		writeJSON(w, http.StatusServiceUnavailable, resp)
		return
	}

	// Best-effort. If schema_migrations is missing something has gone
	// very wrong; we still return 200 with SchemaVersion=0 so the
	// Control Plane sees "DB alive, migrations unclear" rather than
	// nothing at all.
	_ = s.deps.DB.QueryRowContext(r.Context(),
		`SELECT COALESCE(MAX(version), 0) FROM schema_migrations`,
	).Scan(&resp.SchemaVersion)

	writeJSON(w, http.StatusOK, resp)
}

// ── GET /internal/metrics ────────────────────────────────────────

// internalMetricsResp mirrors the fields the Control Plane's federated
// dashboard SUMs across Data Planes. Keep field names + JSON tags
// stable — the Control Plane's aggregation depends on them.
type internalMetricsResp struct {
	Users              int64 `json:"users"`
	Organizations      int64 `json:"organizations"`
	Exams              int64 `json:"exams"`
	Candidates         int64 `json:"candidates"`
	VerificationsTotal int64 `json:"verifications_total"`
	VerificationsToday int64 `json:"verifications_today"`
	// Outcome split of VerificationsTotal. status is CHECK-constrained
	// to exactly 'verified'|'denied', so these two always sum to
	// VerificationsTotal and a success rate is verified/total.
	VerificationsVerified int64 `json:"verifications_verified"`
	VerificationsDenied   int64 `json:"verifications_denied"`
	// Wallet flow is money-in vs money-out in paise. The Control
	// Plane divides by 100 to display rupees, so keep the raw paise
	// here to avoid rounding at every hop.
	WalletCreditPaiseToday int64 `json:"wallet_credit_paise_today"`
	WalletChargePaiseToday int64 `json:"wallet_charge_paise_today"`
	// Orgs with at least one verification in the last 24h — the
	// "active tenants" tile on the federated dashboard.
	ActiveOrgs24h int64 `json:"active_orgs_24h"`
}

func (s *Server) internalMetrics(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var out internalMetricsResp

	// One-liner scans; every query is a single indexed COUNT or SUM.
	// Errors are logged but not surfaced — a partial metrics payload
	// beats a 500 on the federated dashboard.
	scan := func(q string, dst any) {
		if err := s.deps.DB.QueryRowContext(ctx, q).Scan(dst); err != nil {
			log.Printf("internalMetrics: %s failed: %v", strings.SplitN(q, "\n", 2)[0], err)
		}
	}

	// "users" count on the federated dashboard maps to reviewers +
	// agents (operators) + institute admins — the people who actually
	// work the system. Exclude platform superadmins (role='superadmin')
	// so the FE tile 'Reviewers & agents' shows a meaningful number,
	// not just "somebody with a login".
	scan(`SELECT COUNT(*) FROM users WHERE role <> 'superadmin' AND disabled_at IS NULL`, &out.Users)
	scan(`SELECT COUNT(*) FROM institution_applications WHERE status = 'approved'`, &out.Organizations)
	scan(`SELECT COUNT(*) FROM exams`, &out.Exams)
	scan(`SELECT COUNT(*) FROM exam_candidates`, &out.Candidates)
	scan(`SELECT COUNT(*) FROM verifications`, &out.VerificationsTotal)
	scan(`SELECT COUNT(*) FROM verifications WHERE created_at::date = CURRENT_DATE`, &out.VerificationsToday)
	scan(`SELECT COUNT(*) FROM verifications WHERE status = 'verified'`, &out.VerificationsVerified)
	scan(`SELECT COUNT(*) FROM verifications WHERE status = 'denied'`, &out.VerificationsDenied)
	scan(`SELECT COALESCE(SUM(amount_paise), 0) FROM wallet_transactions
	       WHERE kind IN ('deposit','admin_credit') AND created_at::date = CURRENT_DATE`,
		&out.WalletCreditPaiseToday)
	scan(`SELECT COALESCE(-SUM(amount_paise), 0) FROM wallet_transactions
	       WHERE kind = 'charge' AND created_at::date = CURRENT_DATE`,
		&out.WalletChargePaiseToday)
	scan(`SELECT COUNT(DISTINCT org_id) FROM verifications
	       WHERE created_at >= NOW() - INTERVAL '24 hours'`,
		&out.ActiveOrgs24h)

	writeJSON(w, http.StatusOK, out)
}

// ── POST /internal/orgs/create ────────────────────────────────────

// internalOrgsCreateReq is the payload the Control Plane POSTs when a
// KYC application has been fully approved and it wants the target Data
// Plane to provision the org + admin + welcome email.
//
// ExternalApplicationID is the KEY to idempotency: the Control Plane
// may retry on network hiccups, and the Data Plane must return the
// SAME OrgID / AdminUserID on every retry rather than creating a
// duplicate. We derive the organizations.code from this ID so the
// existing UNIQUE (code) constraint enforces idempotency at the DB
// layer, not just in a best-effort application check.
type internalOrgsCreateReq struct {
	ExternalApplicationID int64  `json:"external_application_id"`
	// DpApplicationID is this DP's own institution_applications.id
	// (i.e. what CP stores as external_application_id on its row).
	// Populated by CP so the DP can flip its stale 'pending' row to
	// 'approved' after CP's terminal decision. Optional — old CPs
	// that don't send this field just skip the back-write.
	DpApplicationID int64  `json:"dp_application_id,omitempty"`
	InstitutionName       string `json:"institution_name"`
	HeadName              string `json:"head_name"`
	HeadDesignation       string `json:"head_designation"`
	HeadEmail             string `json:"head_email"`
	// AisheCode is optional — when supplied it flavors the
	// organizations.code so the code stays human-recognisable in
	// downstream S3 keys / audit logs. Empty → we fall back to
	// APP_EXT_<external_application_id>.
	AisheCode string `json:"aishe_code,omitempty"`
	// SendWelcomeEmail controls whether the Data Plane fires the
	// "you're onboarded" mail. Default true; set false when the
	// Control Plane wants to email the applicant itself.
	SendWelcomeEmail bool `json:"send_welcome_email"`
	// MarkApproved determines whether the DP's institution_applications
	// row should be flipped to 'approved' by backfillDPApplication.
	// Set true only when the CP is calling this from an APPROVE flow —
	// setting it true from the submit-time provisioning would leak
	// "approved" into the DP's KYC gate and bypass the lock screen.
	// Nil / false (Go zero value) leaves the DP row's status alone,
	// which is what we want at submit time (row stays 'pending').
	MarkApproved bool `json:"mark_approved"`
	// ClientID, when set, attaches the newly-provisioned org to a
	// specific client (exam board) and fans out subscriptions for
	// that client's currently open exams. Mirrors what Rahul's
	// on-DP reviewer approve does — without this, an org created
	// via /orgs/create has no client_organization_approvals row
	// and the institute admin's catalog is empty on first login.
	//
	// Zero (default) skips the fan-out entirely so legacy callers
	// keep the old behaviour. Set by the Control Plane's approve
	// handler using the CP's target_client_id column.
	ClientID int64 `json:"client_id,omitempty"`
}

type internalOrgsCreateResp struct {
	OrgID         int64  `json:"org_id"`
	AdminUserID   int64  `json:"admin_user_id"`
	AdminUsername string `json:"admin_username"`
	MagicLinkURL  string `json:"magic_link_url"`
	// Idempotent tells the Control Plane whether this was a fresh
	// provisioning or a lookup of an existing row. Handy for logs +
	// for the Control Plane's own audit: "we retried and it was
	// already there, so we didn't send a duplicate email."
	Idempotent bool `json:"idempotent"`
}

func (s *Server) internalOrgsCreate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)

	var req internalOrgsCreateReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}

	// Basic shape validation — every field the org row NOT NULL
	// requires must be present. Additional business rules (email
	// format, name length) belong in the Control Plane where the
	// KYC is reviewed; we accept whatever survives that gate.
	if req.ExternalApplicationID <= 0 {
		writeErr(w, http.StatusBadRequest, "external_application_id required")
		return
	}
	req.InstitutionName = strings.TrimSpace(req.InstitutionName)
	req.HeadName = strings.TrimSpace(req.HeadName)
	req.HeadEmail = strings.TrimSpace(req.HeadEmail)
	req.HeadDesignation = strings.TrimSpace(req.HeadDesignation)
	if req.InstitutionName == "" || req.HeadName == "" || req.HeadEmail == "" || req.HeadDesignation == "" {
		writeErr(w, http.StatusBadRequest, "institution_name, head_name, head_email, head_designation required")
		return
	}

	// Deterministic org code — this is the idempotency lever.
	// AisheCode-prefixed when supplied so the code stays legible.
	orgCode := "APP_EXT_" + strconv.FormatInt(req.ExternalApplicationID, 10)
	if trimmed := strings.TrimSpace(req.AisheCode); trimmed != "" {
		orgCode = "AISHE_" + trimmed
	}

	// Idempotency check — if the org (identified by code) already
	// has an admin user, this call is a retry. Return the cached
	// row without touching the DB further; specifically DO NOT
	// send another welcome email, because the Control Plane may
	// have already had one delivered on the first call.
	var (
		existingOrgID, existingUserID int64
		existingUsername              string
	)
	err := s.deps.DB.QueryRowContext(ctx, db.Q(`
		SELECT o.id, u.id, u.username
		  FROM organizations o
		  JOIN users u ON u.org_id = o.id AND u.role = 'admin'
		 WHERE o.code = ?
		 LIMIT 1`), orgCode,
	).Scan(&existingOrgID, &existingUserID, &existingUsername)
	if err == nil {
		// Idempotent retry: keep the org untouched, but still
		// backfill the DP institution_applications row if it's
		// stale. Approvals from before we started sending
		// DpApplicationID left DP rows stuck at 'pending' — a
		// retry click surfaces them here so operators can heal
		// without a DB touch.
		if req.MarkApproved {
		backfillDPApplication(ctx, s.deps.DB, req.DpApplicationID)
	}
		writeJSON(w, http.StatusOK, internalOrgsCreateResp{
			OrgID:         existingOrgID,
			AdminUserID:   existingUserID,
			AdminUsername: existingUsername,
			// MagicLinkURL intentionally blank on the retry —
			// re-issuing a token here would race the one the
			// applicant is already following. Control Plane can
			// call /internal/orgs/resend-link (added later) if a
			// fresh link is genuinely needed.
			MagicLinkURL: "",
			Idempotent:   true,
		})
		return
	}
	if !errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusInternalServerError, "provision precheck: "+err.Error())
		return
	}

	// Fresh provisioning path. Wrapped in a transaction so a mid-
	// flight failure (bcrypt panic, network blip on the users
	// insert) leaves no partial org behind. Magic link + email
	// happen post-commit — those are best-effort and don't roll
	// the org back.
	tx, err := s.deps.DB.BeginTx(ctx, nil)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db begin: "+err.Error())
		return
	}
	defer tx.Rollback()

	var orgID int64
	// Link the org back to the DP-side institution_applications row so
	// the KYC gate middleware can look up its status without a
	// name-match join. When called at SUBMIT time (2026-08-31 flow
	// restore), that row is still 'pending' — the gate will 403 the
	// admin's data-plane requests until the CP superadmin approves,
	// which flips the DP row via backfillDPApplication. When called at
	// APPROVE time (legacy path, and idempotent retries), the DP row is
	// already 'approved' by the time this runs, so the gate is a no-op.
	//
	// DpApplicationID == 0 falls back to NULL — matches the pre-V17
	// semantics where a NULL application_id is treated as "approved"
	// (Control Plane already gated). Keeps the door open for callers
	// that don't know / don't care about the DP row id.
	appLinkArg := interface{}(nil)
	if req.DpApplicationID > 0 {
		appLinkArg = req.DpApplicationID
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO organizations(code, name, application_id)
		VALUES ($1, $2, $3)
		ON CONFLICT (code) DO UPDATE
		   SET name = EXCLUDED.name,
		       application_id = COALESCE(organizations.application_id, EXCLUDED.application_id)`,
		orgCode, req.InstitutionName, appLinkArg,
	); err != nil {
		writeErr(w, http.StatusInternalServerError, "org insert: "+err.Error())
		return
	}
	if err := tx.QueryRowContext(ctx,
		`SELECT id FROM organizations WHERE code = $1`, orgCode,
	).Scan(&orgID); err != nil {
		writeErr(w, http.StatusInternalServerError, "org read: "+err.Error())
		return
	}

	// Admin username is derived from the institution name so it
	// reads sensibly in admin dashboards. The external application
	// id is the disambiguator so two institutes with the same
	// slugified name don't collide.
	username := slugifyUsername(req.InstitutionName) + "_" + strconv.FormatInt(req.ExternalApplicationID, 10)
	// Placeholder password — never a valid credential; the applicant
	// sets a real one via the magic link on their first visit.
	placeholder, err := bcrypt.GenerateFromPassword([]byte("placeholder-"+username), bcrypt.MinCost)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "bcrypt: "+err.Error())
		return
	}
	adminEmail := strings.ToLower(req.HeadEmail)

	var userID int64
	if err := tx.QueryRowContext(ctx, `
		INSERT INTO users(username, password_hash, role, org_id, display_name, email)
		VALUES ($1, $2, 'admin', $3, $4, $5)
		RETURNING id`,
		username, string(placeholder), orgID,
		req.HeadName+" ("+req.HeadDesignation+")",
		nullable(adminEmail),
	).Scan(&userID); err != nil {
		writeErr(w, http.StatusInternalServerError, "user insert: "+err.Error())
		return
	}

	// Multi-client fan-out — matches what the on-DP reviewer approve
	// handler writes (client_review_handlers.go, clientApproveApplication):
	// one client_organization_approvals row, plus organization_exam_subscriptions
	// for every currently visible + open exam under that client. Kept in
	// the same tx as the org + user inserts so a fan-out failure rolls
	// the whole provisioning back.
	//
	// approved_by / subscribed_by / reviewed_by are NULL — the actual
	// human reviewer lives on the Control Plane's platform_users table,
	// which the DP has no foreign key to. The note field records
	// provenance for audits.
	if req.ClientID > 0 {
		// Ensure the client actually exists on this DP; if not we can't
		// fan out and the whole provisioning should fail rather than
		// silently drop the coa. A missing client here means the CP's
		// clients_registry has drifted from the DP's clients table.
		var clientExists int
		if err := tx.QueryRowContext(ctx,
			`SELECT 1 FROM clients WHERE id = $1`, req.ClientID,
		).Scan(&clientExists); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				writeErr(w, http.StatusBadRequest,
					fmt.Sprintf("client_id %d not found on this data plane", req.ClientID))
				return
			}
			writeErr(w, http.StatusInternalServerError, "client lookup: "+err.Error())
			return
		}

		if _, err := tx.ExecContext(ctx, `
			INSERT INTO client_organization_approvals(
				client_id, org_id, status, approved_by, approved_at, note
			) VALUES ($1, $2, 'approved', NULL, NOW(), 'Approved via Control Plane')
			ON CONFLICT (client_id, org_id) DO UPDATE SET
				status = 'approved',
				approved_at = NOW(),
				note = EXCLUDED.note`,
			req.ClientID, orgID,
		); err != nil {
			writeErr(w, http.StatusInternalServerError, "coa insert: "+err.Error())
			return
		}

		if _, err := tx.ExecContext(ctx, `
			INSERT INTO organization_exam_subscriptions(
				org_id, exam_id, status, approval_type,
				subscribed_by, requested_at,
				reviewed_at, reviewed_by, review_note
			)
			SELECT $1, e.id, 'approved', 'blanket_client',
			       NULL, NOW(),
			       NOW(), NULL, 'Approved via Control Plane'
			  FROM exams e
			 WHERE e.client_id = $2 AND e.visible = 1 AND e.closed = 0
			ON CONFLICT (org_id, exam_id) DO UPDATE SET
				status = 'approved',
				approval_type = EXCLUDED.approval_type,
				reviewed_at = EXCLUDED.reviewed_at,
				review_note = EXCLUDED.review_note`,
			orgID, req.ClientID,
		); err != nil {
			writeErr(w, http.StatusInternalServerError, "exam subs fan-out: "+err.Error())
			return
		}
	}

	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "commit: "+err.Error())
		return
	}

	// Back-update the DP's own institution_applications row so its
	// status matches CP after approval. Keeping DP's row in sync
	// stops the client-reviewer inbox showing a phantom "pending"
	// count from an application that CP already terminally decided.
	if req.MarkApproved {
		backfillDPApplication(ctx, s.deps.DB, req.DpApplicationID)
	}

	// Post-commit: magic link + email. Failures logged, not fatal —
	// the applicant can request a fresh link from their locked
	// dashboard, and the Control Plane can retry the whole call
	// safely (the idempotency path above will short-circuit before
	// touching the DB).
	token, err := s.magicLinks.Generate(ctx, userID, magiclink.PurposeSetPassword, 0)
	if err != nil {
		log.Printf("internalOrgsCreate: magic-link generation failed for user %d: %v", userID, err)
	}
	linkURL := ""
	if token != "" {
		linkURL = s.buildMagicLinkURL(r, token)
	}

	// SendWelcomeEmail defaults to false when the caller doesn't
	// send the field, so an old Control Plane that hasn't been
	// updated won't accidentally trigger duplicate emails.
	if req.SendWelcomeEmail && s.emailer != nil && linkURL != "" {
		body := buildRegistrationSubmittedEmail(req.InstitutionName, req.HeadName, username, linkURL)
		if err := s.emailer.Send(ctx, email.Message{
			To:      req.HeadEmail,
			Subject: fmt.Sprintf("Welcome to the Verification Portal — %s", req.InstitutionName),
			Body:    body,
		}); err != nil {
			log.Printf("internalOrgsCreate: welcome email to %s failed: %v", req.HeadEmail, err)
		}
	}

	// Reviewer notification. Only fire when:
	//   1. This is a FRESH submit (mark_approved=false — the approve-
	//      flow's second call has mark_approved=true).
	//   2. The client's kyc_review_mode is 'client' — meaning the row
	//      lands DIRECTLY in the client reviewer's queue and nobody
	//      else touches it. For 'admin' mode the row never reaches
	//      the reviewer. For 'both' mode the row goes to superadmin
	//      first; the reviewer only sees it after superadmin hands
	//      off, and that email is fired from a separate CP-side hook
	//      (superadminApplicationApprove → /internal/reviewers/notify).
	if !req.MarkApproved && s.emailer != nil && req.ClientID > 0 {
		var mode string
		if err := s.deps.DB.QueryRowContext(r.Context(),
			`SELECT COALESCE(kyc_review_mode, 'admin') FROM clients WHERE id = $1`,
			req.ClientID,
		).Scan(&mode); err == nil && mode == "client" {
			s.notifyClientReviewersOfNewApp(r, req.ClientID, req.InstitutionName, req.HeadName)
		}
	}

	writeJSON(w, http.StatusOK, internalOrgsCreateResp{
		OrgID:         orgID,
		AdminUserID:   userID,
		AdminUsername: username,
		MagicLinkURL:  linkURL,
		Idempotent:    false,
	})
}

// ── POST /internal/users/create ──────────────────────────────────
//
// Provisions a user on this Data Plane on behalf of the Control Plane
// (Track 2, per-client DP model — 2026-08-30). Superadmin clicks
// "Add reviewer" on the CP UI, CP fires this endpoint on the target
// DP, DP writes into its own users table. The CP DB never stores
// the user or password — it's a stateless trigger, so the DP retains
// exclusive ownership of its user credentials.
//
// Supported roles:
//   - "client_reviewer"  — client_id required, scopes the reviewer to
//                          that DP-side exam board
//   - "admin"            — org_id required, provisions an institute admin
//                          (rare from this path; usually /orgs/create
//                          handles admins)
//
// Idempotency: username UNIQUE constraint. If the username already
// exists we DO NOT overwrite — return 409 so the caller knows to pick
// a different username or explicitly call a reset-password endpoint
// (which we intentionally do NOT auto-fold into this handler so accidental
// creates never silently clobber a live account's password).

type internalUsersCreateReq struct {
	Username    string `json:"username"`
	Password    string `json:"password"`
	Role        string `json:"role"`
	DisplayName string `json:"display_name"`
	Email       string `json:"email,omitempty"`
	// ClientID: required when role='client_reviewer'. FKs to the DP's
	// clients table (NOT the CP's clients_registry). If not set for a
	// reviewer, we return 400.
	ClientID int64 `json:"client_id,omitempty"`
	// OrgID: required when role='admin'. FKs to the DP's organizations
	// table. Left unset for reviewers.
	OrgID int64 `json:"org_id,omitempty"`
}

type internalUsersCreateResp struct {
	UserID   int64  `json:"user_id"`
	Username string `json:"username"`
	Role     string `json:"role"`
}

func (s *Server) internalUsersCreate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)

	var req internalUsersCreateReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}

	// Trim + validate shape.
	req.Username = strings.TrimSpace(req.Username)
	req.DisplayName = strings.TrimSpace(req.DisplayName)
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))
	req.Role = strings.TrimSpace(req.Role)

	if req.Username == "" {
		writeErr(w, http.StatusBadRequest, "username required")
		return
	}
	if len(req.Username) > 128 {
		writeErr(w, http.StatusBadRequest, "username too long (max 128)")
		return
	}
	if len(req.Password) < 8 || len(req.Password) > 200 {
		writeErr(w, http.StatusBadRequest, "password must be 8-200 chars")
		return
	}
	if req.DisplayName == "" {
		writeErr(w, http.StatusBadRequest, "display_name required")
		return
	}

	// Role-specific validation.
	var (
		orgIDArg    any = nil
		clientIDArg any = nil
	)
	switch req.Role {
	case "client_reviewer":
		// Auto-attach fallback: if the caller didn't supply a client_id
		// AND this DP has exactly ONE visible+open client, use it.
		// Matches Rahul's DP-side registerSubmit auto-attach and makes
		// the superadmin UX bearable — they shouldn't need to know
		// DP-internal ids. Requires exactly one candidate; 0 or >1
		// forces the explicit-client_id path.
		if req.ClientID <= 0 {
			var count int
			var candidate int64
			if err := s.deps.DB.QueryRowContext(ctx,
				`SELECT COUNT(*), COALESCE(MIN(id), 0)
				   FROM clients
				  WHERE visible = 1 AND closed = 0`,
			).Scan(&count, &candidate); err == nil && count == 1 && candidate > 0 {
				req.ClientID = candidate
			}
		}
		if req.ClientID <= 0 {
			writeErr(w, http.StatusBadRequest,
				"client_id required for role=client_reviewer (this Data Plane hosts multiple exam boards; specify which)")
			return
		}
		// Sanity: DP client must exist. Prevents an orphaned reviewer
		// row that references a client that doesn't exist on THIS DP.
		var exists int
		err := s.deps.DB.QueryRowContext(ctx,
			`SELECT 1 FROM clients WHERE id = $1`, req.ClientID,
		).Scan(&exists)
		if errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusBadRequest,
				fmt.Sprintf("client_id %d not found on this data plane", req.ClientID))
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "client lookup: "+err.Error())
			return
		}
		clientIDArg = req.ClientID
	case "admin":
		if req.OrgID <= 0 {
			writeErr(w, http.StatusBadRequest, "org_id required for role=admin")
			return
		}
		var exists int
		err := s.deps.DB.QueryRowContext(ctx,
			`SELECT 1 FROM organizations WHERE id = $1`, req.OrgID,
		).Scan(&exists)
		if errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusBadRequest,
				fmt.Sprintf("org_id %d not found on this data plane", req.OrgID))
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "org lookup: "+err.Error())
			return
		}
		orgIDArg = req.OrgID
	default:
		writeErr(w, http.StatusBadRequest,
			"role must be one of: client_reviewer, admin")
		return
	}

	// bcrypt the password before any DB write. DefaultCost keeps this
	// under a second even on the smallest EC2 tier.
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "bcrypt: "+err.Error())
		return
	}

	var userID int64
	err = s.deps.DB.QueryRowContext(ctx, `
		INSERT INTO users(username, password_hash, role, display_name, email,
		                  org_id, client_id, activated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
		RETURNING id`,
		req.Username, string(hash), req.Role, req.DisplayName,
		nullable(req.Email),
		orgIDArg, clientIDArg,
	).Scan(&userID)
	if err != nil {
		// Differentiate the specific unique constraints so the
		// superadmin sees actionable feedback instead of a generic
		// "already exists". Order matters: the one-reviewer-per-client
		// constraint (ux_users_client_reviewer_single) is more
		// specific than username, so check it first.
		errMsg := err.Error()
		if strings.Contains(errMsg, "ux_users_client_reviewer_single") {
			// Business rule: at most one active client_reviewer per
			// client (V12 originally, V24 dropped, V25 restored). The
			// superadmin has to delete the existing reviewer before
			// adding another one for the same client.
			writeErr(w, http.StatusConflict,
				fmt.Sprintf("client_id %d already has a reviewer — delete the existing one first", req.ClientID))
			return
		}
		if strings.Contains(errMsg, "users_username_key") {
			writeErr(w, http.StatusConflict, "username already exists on this data plane")
			return
		}
		if strings.Contains(errMsg, "ux_users_org_email_ci") {
			writeErr(w, http.StatusConflict, "email already used by another user in this organisation")
			return
		}
		if strings.Contains(errMsg, "unique") || strings.Contains(errMsg, "duplicate key") {
			// Generic fallback for any other unique constraint we
			// haven't specifically named.
			writeErr(w, http.StatusConflict, "duplicate value violates a unique constraint: "+errMsg)
			return
		}
		writeErr(w, http.StatusInternalServerError, "user insert: "+err.Error())
		return
	}

	log.Printf("internalUsersCreate: created user id=%d username=%s role=%s (client=%v org=%v)",
		userID, req.Username, req.Role, clientIDArg, orgIDArg)

	writeJSON(w, http.StatusCreated, internalUsersCreateResp{
		UserID:   userID,
		Username: req.Username,
		Role:     req.Role,
	})
}

// ── GET /api/internal/users?role=&client_id=&org_id= ────────────
//
// Lists users on this Data Plane filtered by role and/or client_id
// and/or org_id. Called by the Control Plane's listClientReviewers
// so the superadmin UI can show the actual reviewers assigned to a
// client (CP itself stores no user data).
//
// Returns a plain JSON array — matches what Rahul's FE expects at
// `const rows = await listClientReviewers(client.id)`. Empty filters
// mean "no filter"; combining several ANDs them.
//
// Deliberately does NOT return password_hash or password_plaintext.

func (s *Server) internalUsersList(w http.ResponseWriter, r *http.Request) {
	role := strings.TrimSpace(r.URL.Query().Get("role"))
	clientIDStr := strings.TrimSpace(r.URL.Query().Get("client_id"))
	orgIDStr := strings.TrimSpace(r.URL.Query().Get("org_id"))

	where := []string{"1=1"}
	args := []any{}
	if role != "" {
		where = append(where, fmt.Sprintf("role = $%d", len(args)+1))
		args = append(args, role)
	}
	if clientIDStr != "" {
		cid, err := strconv.ParseInt(clientIDStr, 10, 64)
		if err != nil || cid <= 0 {
			writeErr(w, http.StatusBadRequest, "bad client_id")
			return
		}
		where = append(where, fmt.Sprintf("client_id = $%d", len(args)+1))
		args = append(args, cid)
	}
	if orgIDStr != "" {
		oid, err := strconv.ParseInt(orgIDStr, 10, 64)
		if err != nil || oid <= 0 {
			writeErr(w, http.StatusBadRequest, "bad org_id")
			return
		}
		where = append(where, fmt.Sprintf("org_id = $%d", len(args)+1))
		args = append(args, oid)
	}

	q := `SELECT id, username, role, COALESCE(display_name,''), COALESCE(email,''),
	             client_id, org_id, disabled_at, created_at
	        FROM users
	       WHERE ` + strings.Join(where, " AND ") + `
	       ORDER BY id`
	rows, err := s.deps.DB.QueryContext(r.Context(), q, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "list: "+err.Error())
		return
	}
	defer rows.Close()

	out := []map[string]any{}
	for rows.Next() {
		var (
			id                                            int64
			username, roleCol, displayName, emailCol      string
			clientID, orgID                               sql.NullInt64
			disabledAt                                    sql.NullTime
			createdAt                                     time.Time
		)
		if err := rows.Scan(&id, &username, &roleCol, &displayName, &emailCol,
			&clientID, &orgID, &disabledAt, &createdAt); err != nil {
			continue
		}
		row := map[string]any{
			"id":           id,
			"username":     username,
			"role":         roleCol,
			"display_name": displayName,
			"email":        emailCol,
			"created_at":   createdAt.UTC().Format(time.RFC3339),
		}
		if clientID.Valid {
			row["client_id"] = clientID.Int64
		}
		if orgID.Valid {
			row["org_id"] = orgID.Int64
		}
		if disabledAt.Valid {
			row["disabled_at"] = disabledAt.Time.UTC().Format(time.RFC3339)
		}
		out = append(out, row)
	}
	writeJSON(w, http.StatusOK, out)
}

// ── DELETE /api/internal/users/{id} ─────────────────────────────
//
// Hard-delete a user. Called by the Control Plane's
// deleteClientReviewer so the superadmin can remove a reviewer and
// then re-create with the same username (soft-disable would keep the
// username reserved and confuse the operator).
//
// Because a user may have referenced rows across the DB (approved
// KYCs, subscribed exams, wallet transactions, etc.), the handler
// nullifies those FKs first inside a transaction — none of the
// business tables have ON DELETE SET NULL on their user references,
// so a bare DELETE would fail with a foreign-key violation for any
// reviewer who's ever done anything.
//
// Superadmin users are refused as a safety — they must be removed
// through a deliberate SQL command, not a CP UI click.

type internalUsersDeleteResp struct {
	Ok            bool   `json:"ok"`
	DeletedUserID int64  `json:"deleted_user_id"`
	Username      string `json:"username"`
	Role          string `json:"role"`
}

func (s *Server) internalUsersDelete(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}

	var username, role string
	err = s.deps.DB.QueryRowContext(r.Context(),
		`SELECT username, role FROM users WHERE id = $1`, id,
	).Scan(&username, &role)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "user not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "lookup: "+err.Error())
		return
	}
	if role == "superadmin" {
		writeErr(w, http.StatusForbidden, "refusing to delete a superadmin user via internal API")
		return
	}

	tx, err := s.deps.DB.BeginTx(r.Context(), nil)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db begin: "+err.Error())
		return
	}
	defer tx.Rollback()

	// Nullify every FK ref to this user id so the DELETE doesn't
	// violate a constraint. Every one of these is nullable in the
	// schema; the actual audit information (what happened when) is
	// preserved on the referring rows via their own timestamps +
	// notes. ON DELETE CASCADE tables (magic_links, operator_exams)
	// clean themselves.
	nullifies := []string{
		`UPDATE client_organization_approvals SET approved_by = NULL WHERE approved_by = $1`,
		`UPDATE organization_exam_subscriptions SET subscribed_by = NULL WHERE subscribed_by = $1`,
		`UPDATE organization_exam_subscriptions SET reviewed_by = NULL WHERE reviewed_by = $1`,
		`UPDATE institution_applications SET reviewed_by_user_id = NULL WHERE reviewed_by_user_id = $1`,
		`UPDATE exam_csv_uploads SET uploaded_by = NULL WHERE uploaded_by = $1`,
		`UPDATE wallet_transactions SET actor_user_id = NULL WHERE actor_user_id = $1`,
		`UPDATE razorpay_orders SET actor_user_id = NULL WHERE actor_user_id = $1`,
	}
	for _, q := range nullifies {
		if _, err := tx.ExecContext(r.Context(), q, id); err != nil {
			// Table might not exist on some deployment; log + continue
			// only for missing-relation. Any other error rolls back.
			if strings.Contains(err.Error(), "does not exist") {
				log.Printf("internalUsersDelete: skipping cleanup on missing table: %v", err)
				continue
			}
			writeErr(w, http.StatusInternalServerError, "fk cleanup: "+err.Error())
			return
		}
	}

	if _, err := tx.ExecContext(r.Context(), `DELETE FROM users WHERE id = $1`, id); err != nil {
		writeErr(w, http.StatusInternalServerError, "delete: "+err.Error())
		return
	}
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "commit: "+err.Error())
		return
	}

	log.Printf("internalUsersDelete: hard-deleted user id=%d username=%s role=%s", id, username, role)
	writeJSON(w, http.StatusOK, internalUsersDeleteResp{
		Ok:            true,
		DeletedUserID: id,
		Username:      username,
		Role:          role,
	})
}

// ── POST /api/internal/clients/{id}/domain ──────────────────────
//
// Sets clients.domain — the public hostname that maps to this client
// (e.g. "nta.13-127-17-248.nip.io"). CP calls this whenever a domain
// is configured for a client so DP's registerInit can auto-attach
// client_id based on the Host header.
//
// Body: {"domain": "<hostname>"}
// Auth: X-Internal-API-Key.
func (s *Server) internalClientDomain(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<10)
	var req struct {
		Domain string `json:"domain"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	domain := strings.ToLower(strings.TrimSpace(req.Domain))
	// Nil-domain support so CP can clear it later.
	var domainArg any
	if domain == "" {
		domainArg = nil
	} else {
		domainArg = domain
	}
	res, err := s.deps.DB.ExecContext(r.Context(),
		`UPDATE clients SET domain = $2, updated_at = NOW() WHERE id = $1`,
		id, domainArg,
	)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "idx_clients_domain") ||
			strings.Contains(strings.ToLower(err.Error()), "unique") {
			writeErr(w, http.StatusConflict,
				fmt.Sprintf("domain %q is already assigned to another client", domain))
			return
		}
		writeErr(w, http.StatusInternalServerError, "update: "+err.Error())
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeErr(w, http.StatusNotFound, "client not found on this data plane")
		return
	}
	log.Printf("internalClientDomain: dp client %d domain=%q", id, domain)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "domain": domain})
}

// ── GET /api/internal/org-metrics ───────────────────────────────
//
// Per-organisation verification counts, for the Control Plane's
// "Approved organizations" table. /internal/metrics only returns
// deployment-wide aggregates, so the CP had no per-institute source
// and rendered 0 for every row.
//
// Keyed by organizations.code rather than id: the code is derived
// deterministically by internalOrgsCreate from CP-side data
// ("AISHE_<aishe_code>", else "APP_EXT_<cp application id>"), so the
// CP can compute the same key without a lookup. organizations.
// application_id is NOT usable for this -- it is only populated when
// the application originated on this Data Plane, so it is NULL for
// most rows.

type internalOrgMetricRow struct {
	Code     string `json:"code"`
	Total    int64  `json:"total"`
	Verified int64  `json:"verified"`
	Denied   int64  `json:"denied"`
}

func (s *Server) internalOrgMetrics(w http.ResponseWriter, r *http.Request) {
	// COUNT(v.id), not COUNT(*): the LEFT JOIN emits one null row for an
	// organisation with no verifications, and COUNT(*) would score that
	// as 1. status is CHECK-constrained to verified|denied, so the two
	// filtered counts always sum to total.
	rows, err := s.deps.DB.QueryContext(r.Context(), `
		SELECT o.code,
		       COUNT(v.id)                                    AS total,
		       COUNT(*) FILTER (WHERE v.status = 'verified')  AS verified,
		       COUNT(*) FILTER (WHERE v.status = 'denied')    AS denied
		  FROM organizations o
		  LEFT JOIN verifications v ON v.org_id = o.id
		 GROUP BY o.code`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	defer rows.Close()

	out := []internalOrgMetricRow{}
	for rows.Next() {
		var it internalOrgMetricRow
		if err := rows.Scan(&it.Code, &it.Total, &it.Verified, &it.Denied); err != nil {
			continue
		}
		out = append(out, it)
	}
	writeJSON(w, http.StatusOK, out)
}

// ── GET /api/internal/documents/download?path=X ────────────────
//
// Streams a KYC document from S3 given its storage_path. The CP calls
// this on behalf of a superadmin or reviewer clicking a doc — CP has
// no S3 creds, DP does, so DP streams the bytes.
//
// Path is validated to be under a known KYC prefix so this endpoint
// can't be abused as a generic S3 bytes-fetcher.
func (s *Server) internalDocumentsDownload(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimSpace(r.URL.Query().Get("path"))
	if path == "" {
		writeErr(w, http.StatusBadRequest, "path required")
		return
	}
	// Allow-list KYC-related prefixes only — never exam photos or other
	// storage families. storage_path arrives in three shapes and all
	// three have to normalise to the same thing before the check:
	//
	//   s3://bucket/_kyc/...              S3-backed row
	//   apps/... | _kyc/...               bare S3 key
	//   artifacts\institution_docs\...    disk row (no S3 configured)
	//
	// The disk shape is what registerUploadDoc writes via docPath():
	// filepath.Join(Cfg.ArtifactDir, "institution_docs", ...). That
	// carries the ArtifactDir prefix the allow-list is written without,
	// and on Windows it carries backslashes — so a plain HasPrefix
	// against "institution_docs/" rejected every disk-stored document
	// with "path prefix not allowed", making KYC docs unviewable from
	// the CP on any deployment without S3.
	checkPath := strings.ReplaceAll(path, "\\", "/")
	if strings.HasPrefix(checkPath, "s3://") {
		// s3://bucket/key/here → key/here
		rest := checkPath[len("s3://"):]
		if slash := strings.IndexByte(rest, '/'); slash > 0 {
			checkPath = rest[slash+1:]
		}
	}
	checkPath = strings.TrimPrefix(checkPath, "./")
	if art := strings.Trim(strings.ReplaceAll(s.deps.Cfg.ArtifactDir, "\\", "/"), "/"); art != "" {
		checkPath = strings.TrimPrefix(checkPath, art+"/")
	}
	// Traversal can't be allowed to climb back out of the allowed
	// prefixes once we start trimming things off the front.
	if strings.Contains(checkPath, "../") {
		writeErr(w, http.StatusForbidden, "path traversal not allowed")
		return
	}
	if !strings.HasPrefix(checkPath, "apps/") &&
		!strings.HasPrefix(checkPath, "institution_docs/") &&
		!strings.HasPrefix(checkPath, "_kyc/") {
		writeErr(w, http.StatusForbidden, "path prefix not allowed via internal API")
		return
	}
	// Content-Type + Content-Disposition are set by the CALLER (CP)
	// before streaming — this handler just returns raw bytes.
	if err := s.streamDocBytes(w, r, path); err != nil {
		log.Printf("internalDocumentsDownload: stream failed for %s: %v", path, err)
	}
}

// ── POST /api/internal/clients/{id}/portal ──────────────────────
//
// Toggles DP-side clients.portal_enabled. Called by the CP's
// setClientPortal handler so the CP UI's portal toggle actually
// propagates to the DP gates (reviewer login, register-form dropdown).
//
// Body: {"enabled": bool}
// Auth: X-Internal-API-Key.

type internalClientPortalReq struct {
	Enabled bool `json:"enabled"`
}

func (s *Server) internalClientPortal(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<10)
	var req internalClientPortalReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	res, err := s.deps.DB.ExecContext(r.Context(),
		`UPDATE clients SET portal_enabled = $2, updated_at = NOW() WHERE id = $1`,
		id, req.Enabled,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "update: "+err.Error())
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeErr(w, http.StatusNotFound, "client not found on this data plane")
		return
	}
	log.Printf("internalClientPortal: dp client %d portal_enabled=%v", id, req.Enabled)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "portal_enabled": req.Enabled})
}

// ── POST /api/internal/exams ────────────────────────────────────
//
// Provisions an exam on this Data Plane on behalf of the Control
// Plane. Same shape as the DP-native superadminCreateExam, but gated
// by X-Internal-API-Key instead of a superadmin JWT. When client_id
// is omitted, auto-attaches to the sole visible+open client on this
// DP (matches Rahul's registerSubmit auto-attach logic + keeps the
// per-client-DP flow simple).

type internalExamCreateReq struct {
	ClientID         int64  `json:"client_id,omitempty"`
	Name             string `json:"name"`
	ExamCode         string `json:"exam_code"`
	TrustviewRef     string `json:"trustview_ref,omitempty"`
	VerificationFrom string `json:"verification_from"`
	VerificationTo   string `json:"verification_to"`
	RequiresFace     *bool  `json:"requires_face,omitempty"`
	RequiresFP       *bool  `json:"requires_fp,omitempty"`
	RequiresIris     *bool  `json:"requires_iris,omitempty"`
}

func (s *Server) internalExamsCreate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	var req internalExamCreateReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}

	// Auto-attach if client_id not supplied. Matches the reviewer
	// auto-attach: works iff DP has exactly one visible+open client.
	if req.ClientID <= 0 {
		var count int
		var candidate int64
		if err := s.deps.DB.QueryRowContext(ctx,
			`SELECT COUNT(*), COALESCE(MIN(id), 0)
			   FROM clients WHERE visible = 1 AND closed = 0`,
		).Scan(&count, &candidate); err == nil && count == 1 && candidate > 0 {
			req.ClientID = candidate
		}
	}
	if req.ClientID <= 0 {
		writeErr(w, http.StatusBadRequest,
			"client_id required (this Data Plane hosts multiple clients; specify which)")
		return
	}

	// Confirm client exists.
	var exists int
	err := s.deps.DB.QueryRowContext(ctx,
		`SELECT 1 FROM clients WHERE id = $1`, req.ClientID,
	).Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusBadRequest,
			fmt.Sprintf("client_id %d not found on this data plane", req.ClientID))
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "client lookup: "+err.Error())
		return
	}

	name := strings.TrimSpace(req.Name)
	code := strings.TrimSpace(req.ExamCode)
	from := strings.TrimSpace(req.VerificationFrom)
	to := strings.TrimSpace(req.VerificationTo)
	if len(name) < 2 || len(name) > 200 {
		writeErr(w, http.StatusBadRequest, "name required (2-200 chars)")
		return
	}
	if len(code) < 2 || len(code) > 60 {
		writeErr(w, http.StatusBadRequest, "exam_code required (2-60 chars)")
		return
	}
	fromT, err := parseDateTimeWindow(from, false)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "verification_from must be YYYY-MM-DD or YYYY-MM-DDTHH:MM")
		return
	}
	toT, err := parseDateTimeWindow(to, true)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "verification_to must be YYYY-MM-DD or YYYY-MM-DDTHH:MM")
		return
	}
	if fromT.After(toT) {
		writeErr(w, http.StatusBadRequest, "verification_from must be <= verification_to")
		return
	}

	// Modality flags with same defaults as superadminCreateExam.
	rFace, rFP, rIris := true, true, false
	if req.RequiresFace != nil {
		rFace = *req.RequiresFace
	}
	if req.RequiresFP != nil {
		rFP = *req.RequiresFP
	}
	if req.RequiresIris != nil {
		rIris = *req.RequiresIris
	}
	if !rFace && !rFP && !rIris {
		writeErr(w, http.StatusBadRequest,
			"at least one biometric must be required (face, fp, or iris)")
		return
	}

	var id int64
	if err := s.deps.DB.QueryRowContext(ctx, `
		INSERT INTO exams(client_id, name, exam_code, trustview_ref,
		                  verification_from, verification_to,
		                  requires_face, requires_fp, requires_iris)
		VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING id`,
		req.ClientID, name, code, nullable(strings.TrimSpace(req.TrustviewRef)),
		fromT.Format("2006-01-02T15:04:05Z07:00"), toT.Format("2006-01-02T15:04:05Z07:00"),
		boolToInt(rFace), boolToInt(rFP), boolToInt(rIris),
	).Scan(&id); err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "idx_exams_code") ||
			strings.Contains(strings.ToLower(err.Error()), "exam_code") {
			writeErr(w, http.StatusConflict, "an exam with this code already exists")
			return
		}
		writeErr(w, http.StatusInternalServerError, "insert: "+err.Error())
		return
	}
	// Fan out to every blanket-approved org under this client — otherwise
	// orgs that got their KYC approved BEFORE this exam existed would
	// never see it in their catalog (their internalOrgsCreate fan-out
	// ran when this exam didn't exist yet). Idempotent via ON CONFLICT.
	if _, err := s.deps.DB.ExecContext(ctx, `
		INSERT INTO organization_exam_subscriptions(
			org_id, exam_id, status, approval_type,
			subscribed_by, requested_at,
			reviewed_at, reviewed_by, review_note
		)
		SELECT coa.org_id, $1, 'approved', 'blanket_client',
		       NULL, NOW(),
		       NOW(), NULL, 'Auto-subscribed on exam create (blanket)'
		  FROM client_organization_approvals coa
		 WHERE coa.client_id = $2 AND coa.status = 'approved'
		ON CONFLICT (org_id, exam_id) DO NOTHING`,
		id, req.ClientID,
	); err != nil {
		// Best-effort: log + continue. The exam is created; ops can
		// re-run the backfill if needed.
		log.Printf("internalExamsCreate: blanket fan-out failed for exam %d: %v", id, err)
	}

	log.Printf("internalExamsCreate: created exam id=%d code=%s client_id=%d", id, code, req.ClientID)
	writeJSON(w, http.StatusCreated, map[string]any{
		"id":                id,
		"name":              name,
		"exam_code":         code,
		"client_id":         req.ClientID,
		"verification_from": fromT.Format("2006-01-02T15:04:05Z07:00"),
		"verification_to":   toT.Format("2006-01-02T15:04:05Z07:00"),
		"requires_face":     rFace,
		"requires_fp":       rFP,
		"requires_iris":     rIris,
	})
}

// ── GET /api/internal/exams?client_id=X ─────────────────────────
//
// Lists exams on this DP filtered by client_id (required). Used by
// CP's getClient handler to populate the exams[] envelope for the
// ClientDetail page.

func (s *Server) internalExamsList(w http.ResponseWriter, r *http.Request) {
	clientIDStr := strings.TrimSpace(r.URL.Query().Get("client_id"))
	if clientIDStr == "" {
		writeErr(w, http.StatusBadRequest, "client_id query param required")
		return
	}
	clientID, err := strconv.ParseInt(clientIDStr, 10, 64)
	if err != nil || clientID <= 0 {
		writeErr(w, http.StatusBadRequest, "bad client_id")
		return
	}
	rows, err := s.deps.DB.QueryContext(r.Context(), `
		SELECT id, name, exam_code, COALESCE(trustview_ref,''),
		       verification_from, verification_to,
		       visible, closed, requires_face, requires_fp, requires_iris,
		       created_at,
		       (SELECT COUNT(*) FROM exam_candidates ec WHERE ec.exam_id = e.id)
		         AS candidate_count
		  FROM exams e WHERE client_id = $1
		 ORDER BY created_at DESC`, clientID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "list: "+err.Error())
		return
	}
	defer rows.Close()

	out := []map[string]any{}
	for rows.Next() {
		var (
			id                                       int64
			name, code, tvRef                        string
			verFrom, verTo, createdAt                time.Time
			visible, closed, rFace, rFP, rIris       int
			candidateCount                           int64
		)
		if err := rows.Scan(&id, &name, &code, &tvRef,
			&verFrom, &verTo, &visible, &closed, &rFace, &rFP, &rIris, &createdAt,
			&candidateCount); err != nil {
			continue
		}
		out = append(out, map[string]any{
			"id":                id,
			"client_id":         clientID,
			"name":              name,
			"exam_code":         code,
			"trustview_ref":     tvRef,
			"verification_from": verFrom.UTC().Format(time.RFC3339),
			"verification_to":   verTo.UTC().Format(time.RFC3339),
			"visible":           visible == 1,
			"closed":            closed == 1,
			"requires_face":     rFace == 1,
			"requires_fp":       rFP == 1,
			"requires_iris":     rIris == 1,
			"created_at":        createdAt.UTC().Format(time.RFC3339),
			// candidate_count drives the "CANDIDATES" tile on the CP
			// client-detail page + the per-exam column in the table
			// below it. Without this field the FE reads undefined →
			// treats as 0 → tile shows 0 even after seeding rolls.
			"candidate_count":   candidateCount,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// backfillDPApplication flips this DP's institution_applications row
// to 'approved' after CP has terminally decided. Called from both the
// fresh-provision and idempotent-retry paths of internalOrgsCreate so a
// re-approve heals stale rows without a manual DB touch. Best-effort:
// any failure just logs — provisioning succeeds regardless.
func backfillDPApplication(ctx context.Context, dbConn *sql.DB, dpAppID int64) {
	if dpAppID <= 0 {
		return
	}
	if _, err := dbConn.ExecContext(ctx, `
		UPDATE institution_applications
		   SET status = 'approved',
		       updated_at = NOW()
		 WHERE id = $1 AND status IN ('draft','pending')`,
		dpAppID,
	); err != nil {
		log.Printf("backfillDPApplication: DP row %d update failed: %v", dpAppID, err)
	}
}

// ── POST /internal/applications/reject ────────────────────────────
//
// Mirror endpoint for CP → DP reject fan-out. Symmetric with the
// approve path (which flows through /internal/orgs/create +
// backfillDPApplication). Without this, a CP superadmin reject only
// updates the CP's institution_applications row; the DP's mirror stays
// stuck at 'pending', which mis-counts the client reviewer's inbox
// tiles ("Pending 1, Rejected 0" for a row that IS rejected upstream).
//
// The DP owns the row's lifecycle here, so this handler DOES NOT do a
// status transition check — the CP already gated on status='pending'.
// If the DP row is already 'rejected' this is a benign idempotent
// retry.

type internalApplicationsRejectReq struct {
	DpApplicationID int64  `json:"dp_application_id"`
	ReviewNote      string `json:"review_note"`
}

type internalApplicationsRejectResp struct {
	Updated bool `json:"updated"`
}

func (s *Server) internalApplicationsReject(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	var req internalApplicationsRejectReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if req.DpApplicationID <= 0 {
		writeErr(w, http.StatusBadRequest, "dp_application_id required")
		return
	}
	note := strings.TrimSpace(req.ReviewNote)

	res, err := s.deps.DB.ExecContext(r.Context(), `
		UPDATE institution_applications
		   SET status           = 'rejected',
		       pending_reviewer = NULL,
		       review_note      = COALESCE(NULLIF($2, ''), review_note),
		       reviewed_at      = COALESCE(reviewed_at, NOW()),
		       updated_at       = NOW()
		 WHERE id = $1 AND status IN ('draft','pending')`,
		req.DpApplicationID, note,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "update: "+err.Error())
		return
	}
	n, _ := res.RowsAffected()
	writeJSON(w, http.StatusOK, internalApplicationsRejectResp{Updated: n > 0})
}

// ── POST /internal/applications/revoke ────────────────────────────
//
// Mirror endpoint for CP → DP revoke fan-out.
// When CP superadmin or reviewer revokes a rejected application,
// this endpoint resets the DP's institution_applications mirror row back to 'pending'.

type internalApplicationsRevokeReq struct {
	DpApplicationID int64  `json:"dp_application_id"`
	ReviewNote      string `json:"review_note,omitempty"`
}

type internalApplicationsRevokeResp struct {
	Updated bool `json:"updated"`
}

func (s *Server) internalApplicationsRevoke(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	var req internalApplicationsRevokeReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if req.DpApplicationID <= 0 {
		writeErr(w, http.StatusBadRequest, "dp_application_id required")
		return
	}
	note := strings.TrimSpace(req.ReviewNote)

	res, err := s.deps.DB.ExecContext(r.Context(), `
		UPDATE institution_applications
		   SET status           = 'pending',
		       pending_reviewer = 'client',
		       review_note      = $2,
		       reviewed_at      = NULL,
		       updated_at       = NOW()
		 WHERE id = $1 AND status = 'rejected'`,
		req.DpApplicationID, nullable(note),
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "update: "+err.Error())
		return
	}
	n, _ := res.RowsAffected()
	writeJSON(w, http.StatusOK, internalApplicationsRevokeResp{Updated: n > 0})
}


// notifyClientReviewersOfNewApp emails every active reviewer scoped to
// clientID that a new institution application has landed in their
// queue. Fire-and-forget from a goroutine so a slow SMTP send never
// blocks the CP→DP provisioning path. Best-effort: individual send
// failures are logged and swallowed.
//
// The email carries a login link to the reviewer portal on this DP so
// the reviewer can click through, sign in, and act. The base URL is
// resolved the same way buildMagicLinkURL does — PublicBaseURL wins,
// then X-Forwarded-Host, then r.Host — so the URL matches whatever
// front door the request actually came in on.
func (s *Server) notifyClientReviewersOfNewApp(r *http.Request, clientID int64, institutionName, headName string) {
	loginURL := s.buildReviewerLoginURL(r)
	// Grab the request Host now — the goroutine may outlive the request
	// so anything read off *http.Request must be copied out first.
	loginURLCopy := loginURL
	instCopy := strings.TrimSpace(institutionName)
	headCopy := strings.TrimSpace(headName)
	clientIDCopy := clientID

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		rows, err := s.deps.DB.QueryContext(ctx,
			`SELECT COALESCE(email,''), COALESCE(display_name,'')
			   FROM users
			  WHERE role = 'client_reviewer'
			    AND client_id = $1
			    AND disabled_at IS NULL
			    AND email IS NOT NULL AND email <> ''`,
			clientIDCopy,
		)
		if err != nil {
			log.Printf("notifyClientReviewersOfNewApp: db lookup failed (client=%d): %v", clientIDCopy, err)
			return
		}
		defer rows.Close()

		type reviewer struct{ email, name string }
		var reviewers []reviewer
		for rows.Next() {
			var r reviewer
			if err := rows.Scan(&r.email, &r.name); err != nil {
				log.Printf("notifyClientReviewersOfNewApp: scan failed: %v", err)
				return
			}
			reviewers = append(reviewers, r)
		}
		if len(reviewers) == 0 {
			return // no reviewers with email — nothing to send
		}

		subject := fmt.Sprintf("New institution registration — %s", instCopy)
		for _, rv := range reviewers {
			body := buildReviewerNotificationEmail(rv.name, instCopy, headCopy, loginURLCopy)
			if err := s.emailer.Send(ctx, email.Message{
				To:      rv.email,
				Subject: subject,
				Body:    body,
			}); err != nil {
				log.Printf("notifyClientReviewersOfNewApp: email to %s failed: %v", rv.email, err)
			}
		}
	}()
}

// buildReviewerLoginURL returns the URL a reviewer clicks in the
// notification email to open the login screen. Same base-URL logic as
// buildMagicLinkURL — PublicBaseURL, X-Forwarded-Host, then request
// Host. Trailing "/reviewer/login" is where the reviewer signs in.
func (s *Server) buildReviewerLoginURL(r *http.Request) string {
	const path = "/reviewer/login"
	if base := s.deps.Cfg.PublicBaseURL; base != "" {
		return strings.TrimRight(base, "/") + path
	}
	if fwdHost := r.Header.Get("X-Forwarded-Host"); fwdHost != "" {
		scheme := r.Header.Get("X-Forwarded-Proto")
		if scheme == "" {
			scheme = "https"
		}
		return scheme + "://" + fwdHost + path
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + r.Host + path
}

func buildReviewerNotificationEmail(reviewerName, institutionName, headName, loginURL string) string {
	greeting := "Hello"
	if reviewerName != "" {
		greeting = "Hello " + reviewerName
	}
	return greeting + ",\n\n" +
		"A new institution has just registered under your review queue on the Verification Portal.\n\n" +
		"  Institution : " + institutionName + "\n" +
		"  Head of inst.: " + headName + "\n\n" +
		"You can log in with your reviewer credentials at:\n" +
		"  " + loginURL + "\n\n" +
		"— Verification Portal\n" +
		"(This is an automated notification. Reply-to is not monitored.)"
}

// internalReviewersNotifyReq is the payload for a hand-off notification
// fired by the Control Plane after superadmin's approve moves a 'both'-
// mode application into the client reviewer's queue.
type internalReviewersNotifyReq struct {
	ClientID        int64  `json:"client_id"`
	InstitutionName string `json:"institution_name"`
	HeadName        string `json:"head_name"`
}

// internalReviewersNotify — server-to-server hook the CP calls when a
// 'both'-mode application is handed off from superadmin to the client
// reviewer. Same email body as the fresh-submit notification (the
// reviewer's queue has grown by one either way), but the trigger point
// is different — see internalOrgsCreate for the fresh-submit path.
//
// This endpoint does NOT check kyc_review_mode; the CP already gated
// the call on mode == 'both'. It DOES require ClientID and at least
// one email-carrying reviewer under that client — otherwise it returns
// 200 with a "no reviewers" note so the CP handler doesn't fail its
// approve just because the reviewer list is empty.
func (s *Server) internalReviewersNotify(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	var req internalReviewersNotifyReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body: "+err.Error())
		return
	}
	if req.ClientID <= 0 {
		writeErr(w, http.StatusBadRequest, "client_id required")
		return
	}
	if s.emailer == nil {
		writeJSON(w, http.StatusOK, map[string]any{"sent": 0, "reason": "email disabled"})
		return
	}
	s.notifyClientReviewersOfNewApp(r, req.ClientID, req.InstitutionName, req.HeadName)
	writeJSON(w, http.StatusOK, map[string]any{"queued": true})
}

// ── POST /api/internal/kyc/notify-decision ────────────────────────
//
// Server-to-server hook the Control Plane calls after any TERMINAL
// approve/reject on an institution_applications row so the applicant
// (head_email on the application) hears back. Kept applicant-scoped:
// the DP looks nothing up locally beyond building a login URL — the
// CP is authoritative on the decision + note text.
//
// The CP calls this in a goroutine; failures on this side are logged
// but never fail the CP's decision. Do NOT call this from the
// 'both'-mode hand-off (superadmin → client reviewer): that is not a
// terminal decision, and firing it there would email the applicant
// twice for one final answer.
type internalKYCNotifyDecisionReq struct {
	HeadEmail       string `json:"head_email"`
	HeadName        string `json:"head_name"`
	InstitutionName string `json:"institution_name"`
	Decision        string `json:"decision"` // "approved" | "rejected"
	Note            string `json:"note,omitempty"`
	// LoginURL is optional; when omitted the DP builds one the same
	// way buildReviewerLoginURL does — PublicBaseURL, X-Forwarded-Host,
	// then r.Host.
	LoginURL string `json:"login_url,omitempty"`
}

func (s *Server) internalKYCNotifyDecision(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	var req internalKYCNotifyDecisionReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body: "+err.Error())
		return
	}
	req.HeadEmail = strings.TrimSpace(req.HeadEmail)
	req.Decision = strings.TrimSpace(strings.ToLower(req.Decision))
	if req.HeadEmail == "" {
		writeErr(w, http.StatusBadRequest, "head_email required")
		return
	}
	if req.Decision != "approved" && req.Decision != "rejected" {
		writeErr(w, http.StatusBadRequest, "decision must be 'approved' or 'rejected'")
		return
	}
	if s.emailer == nil {
		writeJSON(w, http.StatusOK, map[string]any{"sent": 0, "reason": "email disabled"})
		return
	}
	loginURL := req.LoginURL
	if loginURL == "" {
		loginURL = s.buildAdminLoginURL(r)
	}
	subject := kycDecisionSubject(req.Decision, req.InstitutionName)
	body := buildKYCDecisionEmail(req.Decision, req.HeadName, req.InstitutionName, req.Note, loginURL)
	// Send in a goroutine so a slow SMTP round-trip doesn't hold the
	// CP call. Copy everything we need first — r is not safe to touch
	// after this handler returns.
	toCopy := req.HeadEmail
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := s.emailer.Send(ctx, email.Message{
			To:      toCopy,
			Subject: subject,
			Body:    body,
		}); err != nil {
			log.Printf("internalKYCNotifyDecision: email to %s failed: %v", toCopy, err)
		}
	}()
	writeJSON(w, http.StatusOK, map[string]any{"queued": true})
}

func kycDecisionSubject(decision, inst string) string {
	inst = strings.TrimSpace(inst)
	if inst == "" {
		inst = "your institution"
	}
	if decision == "approved" {
		return fmt.Sprintf("Your registration has been approved — %s", inst)
	}
	return fmt.Sprintf("Your registration was not approved — %s", inst)
}

// buildKYCDecisionEmail renders the plain-text body sent to the
// applicant after a terminal KYC decision. The reviewer's note is
// included verbatim on rejection (that's the whole point — the
// applicant needs to know what to fix) and only when non-empty on
// approval (approve notes are optional and rarely used).
func buildKYCDecisionEmail(decision, headName, inst, note, loginURL string) string {
	name := strings.TrimSpace(headName)
	if name == "" {
		name = "there"
	}
	inst = strings.TrimSpace(inst)
	if inst == "" {
		inst = "your institution"
	}
	note = strings.TrimSpace(note)
	if decision == "approved" {
		noteBlock := ""
		if note != "" {
			noteBlock = fmt.Sprintf("Reviewer note:\n%s\n\n", note)
		}
		return fmt.Sprintf(`Hi %s,

Your registration for %s has been approved. Full portal access is now unlocked for your admin account.

%sIf you haven't set your password yet, follow the activation link we emailed at registration time. You can sign in here:

  %s

— The Verification Portal team
`, name, inst, noteBlock, loginURL)
	}
	// rejected
	noteBlock := ""
	if note != "" {
		noteBlock = fmt.Sprintf("Reviewer note:\n%s\n\n", note)
	}
	return fmt.Sprintf(`Hi %s,

Your registration for %s was not approved at this time.

%sYou may submit a fresh application with the updated information whenever you're ready.

— The Verification Portal team
`, name, inst, noteBlock)
}

// buildAdminLoginURL — the URL an approved applicant clicks to sign
// in as their org's admin. Same base-URL logic as
// buildReviewerLoginURL: PublicBaseURL, X-Forwarded-Host, then Host.
func (s *Server) buildAdminLoginURL(r *http.Request) string {
	const path = "/admin/login"
	if base := s.deps.Cfg.PublicBaseURL; base != "" {
		return strings.TrimRight(base, "/") + path
	}
	if fwdHost := r.Header.Get("X-Forwarded-Host"); fwdHost != "" {
		scheme := r.Header.Get("X-Forwarded-Proto")
		if scheme == "" {
			scheme = "https"
		}
		return scheme + "://" + fwdHost + path
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + r.Host + path
}
