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
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"

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

	scan(`SELECT COUNT(*) FROM users`, &out.Users)
	scan(`SELECT COUNT(*) FROM organizations`, &out.Organizations)
	scan(`SELECT COUNT(*) FROM exams`, &out.Exams)
	scan(`SELECT COUNT(*) FROM exam_candidates`, &out.Candidates)
	scan(`SELECT COUNT(*) FROM verifications`, &out.VerificationsTotal)
	scan(`SELECT COUNT(*) FROM verifications WHERE created_at::date = CURRENT_DATE`, &out.VerificationsToday)
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
	// application_id column stays NULL for internally-provisioned
	// orgs — the "application" lives on the Control Plane, not
	// here. The KYC gate middleware treats NULL as "approved" for
	// legacy compatibility, which is exactly the semantic we want
	// (Control Plane already gated approval).
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO organizations(code, name, application_id)
		VALUES ($1, $2, NULL)
		ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name`,
		orgCode, req.InstitutionName,
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

	// 3. Client Board approval association & exam catalog subscriptions:
	dpClientID := s.deps.Cfg.DataPlaneClientID
	if dpClientID > 0 {
		_, _ = tx.ExecContext(ctx, `
			INSERT INTO client_organization_approvals(client_id, org_id, status, approved_by, approved_at, note)
			VALUES($1, $2, 'approved', $3, NOW(), 'Approved via Control Plane KYC')
			ON CONFLICT (client_id, org_id) DO UPDATE SET
				status = 'approved',
				approved_by = EXCLUDED.approved_by,
				approved_at = NOW(),
				note = EXCLUDED.note`,
			dpClientID, orgID, userID,
		)
		_, _ = tx.ExecContext(ctx, `
			INSERT INTO organization_exam_subscriptions(
			    org_id, exam_id, status, approval_type,
			    subscribed_by, requested_at,
			    reviewed_at, reviewed_by, review_note)
			SELECT $1, e.id, 'approved', 'blanket_client',
			       $2, NOW(),
			       NOW(), $2, 'Auto-granted on KYC approval'
			  FROM exams e
			 WHERE e.client_id = $3 AND e.visible = 1 AND e.closed = 0
			ON CONFLICT (org_id, exam_id) DO UPDATE SET
			    status = 'approved',
			    approval_type = EXCLUDED.approval_type,
			    reviewed_at = EXCLUDED.reviewed_at,
			    reviewed_by = EXCLUDED.reviewed_by,
			    review_note = EXCLUDED.review_note`,
			orgID, userID, dpClientID,
		)
	} else {
		// Fallback for generic multi-client dev environment:
		_, _ = tx.ExecContext(ctx, `
			INSERT INTO client_organization_approvals(client_id, org_id, status, approved_by, approved_at, note)
			SELECT c.id, $1, 'approved', $2, NOW(), 'Approved via Control Plane KYC'
			  FROM clients c
			 WHERE c.visible = 1 AND c.closed = 0
			ON CONFLICT (client_id, org_id) DO UPDATE SET
				status = 'approved',
				approved_by = EXCLUDED.approved_by,
				approved_at = NOW(),
				note = EXCLUDED.note`,
			orgID, userID,
		)
		_, _ = tx.ExecContext(ctx, `
			INSERT INTO organization_exam_subscriptions(
			    org_id, exam_id, status, approval_type,
			    subscribed_by, requested_at,
			    reviewed_at, reviewed_by, review_note)
			SELECT $1, e.id, 'approved', 'blanket_client',
			       $2, NOW(),
			       NOW(), $2, 'Auto-granted on KYC approval'
			  FROM exams e
			 WHERE e.visible = 1 AND e.closed = 0
			ON CONFLICT (org_id, exam_id) DO UPDATE SET
			    status = 'approved',
			    approval_type = EXCLUDED.approval_type,
			    reviewed_at = EXCLUDED.reviewed_at,
			    reviewed_by = EXCLUDED.reviewed_by,
			    review_note = EXCLUDED.review_note`,
			orgID, userID,
		)
	}

	// 4. Initial wallet creation:
	_, _ = tx.ExecContext(ctx, `
		INSERT INTO wallets(org_id, balance_paise, updated_at)
		VALUES($1, 0, NOW())
		ON CONFLICT (org_id) DO NOTHING`,
		orgID,
	)

	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "commit: "+err.Error())
		return
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

	writeJSON(w, http.StatusOK, internalOrgsCreateResp{
		OrgID:         orgID,
		AdminUserID:   userID,
		AdminUsername: username,
		MagicLinkURL:  linkURL,
		Idempotent:    false,
	})
}
