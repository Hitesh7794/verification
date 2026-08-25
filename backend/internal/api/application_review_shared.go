package api

// Shared submit / approve / reject flow for institution_applications.
//
// 2026-08-25 UX rebuild: the org + admin user are now created at
// registerSubmit time (not at approval time). The user can log in
// during the "pending" window but sees a lock screen until the KYC
// review lands; approve just flips the status flag that unlocks
// their portal. See project_snapshot memory for the state machine.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"

	"golang.org/x/crypto/bcrypt"

	"github.com/veni/neet-verification/internal/email"
	"github.com/veni/neet-verification/internal/magiclink"
)

// Sentinel errors from the shared helpers so callers can map to HTTP
// status without string-matching. Every other error is treated as 500.
var (
	errAppNotFound       = errors.New("application not found")
	errAppNotPending     = errors.New("application is not pending")
	errAppOutOfScope     = errors.New("application belongs to a different client")
	errAppNoteRequired   = errors.New("rejection note required")
	errAppPortalDisabled = errors.New("this board's review portal is currently disabled")
)

// approvedApplication is what the shared approve helper returns after
// the DB tx commits + the magic link is generated. Callers echo the
// relevant fields to the client. Under the 2026-08-25 rebuild, the
// MagicLinkURL is populated at SUBMIT time (not approve); approve
// callers just get the same URL echoed for convenience.
type approvedApplication struct {
	ApplicationID    int64  `json:"application_id"`
	OrgID            int64  `json:"org_id"`
	AdminUserID      int64  `json:"admin_user_id"`
	AdminUsername    string `json:"admin_username"`
	MagicLinkURL     string `json:"magic_link_url"`
	OperatorUsername string `json:"operator_username"`
	OperatorPassword string `json:"operator_password"`

	// For audit + email context — not part of the JSON envelope the
	// callers usually return, but handy so the wrapper doesn't need
	// its own second read.
	InstitutionName string `json:"-"`
	HeadName        string `json:"-"`
	HeadEmail       string `json:"-"`
}

// provisionOrgAndAdmin creates the org row + admin user + magic link
// for a submitted application, and emails the applicant. Idempotent —
// if the org already exists (linked via organizations.application_id),
// returns the existing IDs without a second insert or second email.
//
// Called from:
//   - registerSubmit — at submit time (new locked-account flow).
//   - approveApplication — as a legacy safety net for pre-V17 apps
//     that were submitted before this rebuild and don't have an org
//     yet. In that path we DON'T re-send the welcome email since the
//     applicant is about to get the approval email instead.
//
// sendWelcomeEmail = false suppresses the welcome mail (used by the
// legacy approve path). registerSubmit passes true.
func (s *Server) provisionOrgAndAdmin(r *http.Request, appID int64, sendWelcomeEmail bool) (*approvedApplication, error) {
	ctx := r.Context()

	// Idempotency check — if there's already an admin user under an
	// org linked to this application, we're done. Return the existing
	// IDs and skip the insert path entirely.
	var existingOrgID, existingUserID int64
	var existingUsername string
	err := s.deps.DB.QueryRowContext(ctx, `
		SELECT o.id, u.id, u.username
		  FROM organizations o
		  JOIN users u ON u.org_id = o.id AND u.role = 'admin'
		 WHERE o.application_id = $1
		 LIMIT 1`, appID,
	).Scan(&existingOrgID, &existingUserID, &existingUsername)
	if err == nil {
		return &approvedApplication{
			ApplicationID: appID,
			OrgID:         existingOrgID,
			AdminUserID:   existingUserID,
			AdminUsername: existingUsername,
		}, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("provision precheck: %w", err)
	}

	// Read application details in one query.
	var (
		instName, headName, headEmail, headDesignation string
		aishe                                          sql.NullString
	)
	if err := s.deps.DB.QueryRowContext(ctx,
		`SELECT institution_name, head_name, head_email, head_designation, aishe_code
		   FROM institution_applications WHERE id = $1`, appID,
	).Scan(&instName, &headName, &headEmail, &headDesignation, &aishe); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, errAppNotFound
		}
		return nil, fmt.Errorf("read app: %w", err)
	}

	tx, err := s.deps.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("provision begin: %w", err)
	}
	defer tx.Rollback()

	// Org code preference: AISHE (guaranteed unique per application),
	// else a synthetic APP_<id>. Same convention as the pre-V17 flow.
	orgCode := "APP_" + strconv.FormatInt(appID, 10)
	if aishe.Valid && aishe.String != "" {
		orgCode = "AISHE_" + aishe.String
	}

	var orgID int64
	// ON CONFLICT (code) DO UPDATE lets a pre-V17 org (created before
	// the application_id column existed) get its FK back-filled the
	// first time provision runs. New rows just insert.
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO organizations(code, name, application_id)
		VALUES($1, $2, $3)
		ON CONFLICT (code) DO UPDATE SET
		    application_id = COALESCE(organizations.application_id, EXCLUDED.application_id)`,
		orgCode, instName, appID,
	); err != nil {
		return nil, fmt.Errorf("org insert: %w", err)
	}
	if err := tx.QueryRowContext(ctx,
		`SELECT id FROM organizations WHERE code = $1`, orgCode,
	).Scan(&orgID); err != nil {
		return nil, fmt.Errorf("org read: %w", err)
	}

	// Placeholder password — applicant sets a real one via the magic
	// link. NOT NULL on password_hash makes the placeholder necessary
	// even though it's never a valid login credential (magic link is
	// verified out-of-band and password gets replaced on set-password).
	username := slugifyUsername(instName) + "_" + strconv.FormatInt(appID, 10)
	placeholder, err := bcrypt.GenerateFromPassword([]byte("placeholder-"+username), bcrypt.MinCost)
	if err != nil {
		return nil, fmt.Errorf("bcrypt: %w", err)
	}
	adminEmail := strings.ToLower(strings.TrimSpace(headEmail))
	var userID int64
	if err := tx.QueryRowContext(ctx,
		`INSERT INTO users(username, password_hash, role, org_id, display_name, email)
		 VALUES($1, $2, 'admin', $3, $4, $5)
		 RETURNING id`,
		username, string(placeholder), orgID, headName+" ("+headDesignation+")",
		nullable(adminEmail),
	).Scan(&userID); err != nil {
		return nil, fmt.Errorf("user insert: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("provision commit: %w", err)
	}

	// Best-effort — token + email happen post-commit. A failure here
	// doesn't roll the org back; the applicant can request another
	// link via the existing resend endpoint.
	token, err := s.magicLinks.Generate(ctx, userID, magiclink.PurposeSetPassword, 0)
	if err != nil {
		return nil, fmt.Errorf("magic link: %w", err)
	}
	linkURL := s.buildMagicLinkURL(r, token)

	if sendWelcomeEmail && s.emailer != nil {
		body := buildRegistrationSubmittedEmail(instName, headName, username, linkURL)
		if err := s.emailer.Send(ctx, email.Message{
			To:      headEmail,
			Subject: "Your Verification Portal registration is under review",
			Body:    body,
		}); err != nil {
			log.Printf("emailer.Send submit-welcome to %s: %v", headEmail, err)
		}
	}

	return &approvedApplication{
		ApplicationID:   appID,
		OrgID:           orgID,
		AdminUserID:     userID,
		AdminUsername:   username,
		MagicLinkURL:    linkURL,
		InstitutionName: instName,
		HeadName:        headName,
		HeadEmail:       headEmail,
	}, nil
}

// approveApplication finalises a pending KYC review. Under the
// 2026-08-25 rebuild the org + admin user are already created at
// submit time; this function just:
//
//   1. Flips status='approved' + clears pending_reviewer.
//   2. Runs the exam fan-out for the routed client (if any).
//   3. Emails the applicant the "you're approved" notice (no magic
//      link — they already have their password).
//
// The provisionOrgAndAdmin safety net runs first for the pre-V17
// legacy path (rare — approved orgs from before this rebuild).
//
// scope, when non-nil, requires the application's client_id to match.
// Superadmin callers pass nil (no scope filter). Client reviewers pass
// &clientID so a reviewer for NTA can't approve an AIIMS application.
func (s *Server) approveApplication(
	r *http.Request,
	appID int64,
	reviewerUserID int64,
	scope *int64,
	note string,
) (*approvedApplication, error) {
	ctx := r.Context()

	// Defence in depth: the reviewer's login gate already blocks new
	// sessions when portal_enabled=false, but a JWT minted just before
	// the toggle flipped stays valid for its 12h expiry. Re-check here
	// so a stale-JWT approve during a disabled window fails cleanly.
	if scope != nil {
		if err := s.checkPortalEnabled(ctx, *scope); err != nil {
			return nil, err
		}
	}

	// Read + validate pre-conditions on the pending row.
	var (
		status       string
		gotScope     sql.NullInt64
		appClientID  sql.NullInt64
	)
	if err := s.deps.DB.QueryRowContext(ctx,
		`SELECT status, client_id, client_id
		   FROM institution_applications WHERE id = $1`, appID,
	).Scan(&status, &gotScope, &appClientID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, errAppNotFound
		}
		return nil, fmt.Errorf("db read: %w", err)
	}
	if scope != nil {
		if !gotScope.Valid || gotScope.Int64 != *scope {
			return nil, errAppOutOfScope
		}
	}
	if status != "pending" {
		return nil, fmt.Errorf("%w (currently %s)", errAppNotPending, status)
	}

	// Legacy safety net — pre-V17 apps may not have an org yet.
	// New apps (post-2026-08-25) had provisionOrgAndAdmin run at
	// submit, so this is a no-op idempotent lookup.
	prov, err := s.provisionOrgAndAdmin(r, appID, false)
	if err != nil {
		return nil, err
	}

	// Atomic state flip. Gates on status='pending' so two concurrent
	// approvers can't both win. Scope predicate folded in for the
	// client-reviewer path.
	q := `UPDATE institution_applications
	         SET status = 'approved',
	             pending_reviewer = NULL,
	             reviewed_by_user_id = $1,
	             reviewed_at = CURRENT_TIMESTAMP,
	             review_note = $2,
	             updated_at = CURRENT_TIMESTAMP
	       WHERE id = $3 AND status = 'pending'`
	args := []any{reviewerUserID, nullable(note), appID}
	if scope != nil {
		q += ` AND client_id = $4`
		args = append(args, *scope)
	}
	res, err := s.deps.DB.ExecContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("app approve: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		// Lost the race — someone else just finalised. Report as
		// out-of-scope for scoped callers, "not pending" for others.
		if scope != nil {
			return nil, errAppOutOfScope
		}
		return nil, errAppNotPending
	}

	// V15 exam fan-out — if a client_id is attached, grant this org
	// access to every visible + open exam under that client. Same
	// insert as before the rebuild.
	if appClientID.Valid {
		if _, err := s.deps.DB.ExecContext(ctx, `
			INSERT INTO organization_exam_subscriptions(
			    org_id, exam_id, status, approval_type,
			    subscribed_by, requested_at,
			    reviewed_at, reviewed_by, review_note)
			SELECT $1, e.id, 'approved', 'blanket_client',
			       $2, NOW(),
			       NOW(), $2, 'Auto-granted on KYC approval (V15)'
			  FROM exams e
			 WHERE e.client_id = $3 AND e.visible = 1 AND e.closed = 0
			ON CONFLICT (org_id, exam_id) DO UPDATE SET
			    status = 'approved',
			    approval_type = EXCLUDED.approval_type,
			    reviewed_at = EXCLUDED.reviewed_at,
			    reviewed_by = EXCLUDED.reviewed_by,
			    review_note = EXCLUDED.review_note`,
			prov.OrgID, reviewerUserID, appClientID.Int64,
		); err != nil {
			return nil, fmt.Errorf("exam fan-out: %w", err)
		}
	}

	// Post-approval email — the applicant already has their password
	// (they set it at registration time via the welcome magic link).
	// This mail just tells them they're unlocked.
	if s.emailer != nil {
		body := buildKYCApprovedEmail(prov.InstitutionName, prov.HeadName, prov.AdminUsername, note)
		if err := s.emailer.Send(ctx, email.Message{
			To:      prov.HeadEmail,
			Subject: "Your Verification Portal registration has been approved",
			Body:    body,
		}); err != nil {
			log.Printf("emailer.Send approval to %s: %v", prov.HeadEmail, err)
		}
	}

	return &approvedApplication{
		ApplicationID:   appID,
		OrgID:           prov.OrgID,
		AdminUserID:     prov.AdminUserID,
		AdminUsername:   prov.AdminUsername,
		MagicLinkURL:    prov.MagicLinkURL,
		InstitutionName: prov.InstitutionName,
		HeadName:        prov.HeadName,
		HeadEmail:       prov.HeadEmail,
	}, nil
}

// rejectApplication runs the reject flow. scope semantics match
// approveApplication.
func (s *Server) rejectApplication(
	ctx context.Context,
	appID int64,
	reviewerUserID int64,
	scope *int64,
	note string,
) error {
	note = strings.TrimSpace(note)
	if note == "" {
		return errAppNoteRequired
	}
	if scope != nil {
		if err := s.checkPortalEnabled(ctx, *scope); err != nil {
			return err
		}
	}

	// Read + validate the row up front so we can send the rejection
	// email after the UPDATE lands.
	var (
		status, instName, headName, headEmail string
		gotScope                              sql.NullInt64
	)
	if err := s.deps.DB.QueryRowContext(ctx,
		`SELECT status, institution_name, head_name, head_email, client_id
		   FROM institution_applications WHERE id = $1`, appID,
	).Scan(&status, &instName, &headName, &headEmail, &gotScope); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return errAppNotFound
		}
		return fmt.Errorf("db read: %w", err)
	}
	if scope != nil {
		if !gotScope.Valid || gotScope.Int64 != *scope {
			return errAppOutOfScope
		}
	}
	if status != "pending" {
		return fmt.Errorf("%w (currently %s)", errAppNotPending, status)
	}

	if _, err := s.deps.DB.ExecContext(ctx,
		`UPDATE institution_applications
		    SET status = 'rejected',
		        pending_reviewer = NULL,
		        reviewed_by_user_id = $1,
		        reviewed_at = CURRENT_TIMESTAMP,
		        review_note = $2,
		        updated_at = CURRENT_TIMESTAMP
		  WHERE id = $3 AND status = 'pending'`,
		reviewerUserID, note, appID,
	); err != nil {
		return fmt.Errorf("db update: %w", err)
	}

	if s.emailer != nil {
		body := buildRejectionEmail(instName, headName, note)
		if err := s.emailer.Send(ctx, email.Message{
			To:      headEmail,
			Subject: "Update on your portal registration",
			Body:    body,
		}); err != nil {
			log.Printf("emailer.Send rejection to %s: %v", headEmail, err)
		}
	}
	return nil
}

// mapReviewErrorToHTTP translates a shared-helper error into the HTTP
// status callers should return, plus the user-facing message.
func mapReviewErrorToHTTP(err error) (int, string) {
	switch {
	case errors.Is(err, errAppNotFound), errors.Is(err, errAppOutOfScope):
		// Merged for information disclosure — client reviewers
		// shouldn't be able to probe for the existence of another
		// client's applications.
		return http.StatusNotFound, "application not found"
	case errors.Is(err, errAppNotPending):
		return http.StatusConflict, err.Error()
	case errors.Is(err, errAppNoteRequired):
		return http.StatusBadRequest, "rejection note required"
	case errors.Is(err, errAppPortalDisabled):
		return http.StatusForbidden,
			"this board's review portal is currently disabled — contact the platform team"
	}
	return http.StatusInternalServerError, err.Error()
}

// applicationReviewMode returns (mode, client_id) for the given app.
// mode is the destination client's kyc_review_mode ('admin'|'client'|'both')
// or "admin" if the app has no client_id. client_id is nil if unset.
// Errors: sql.ErrNoRows if the application doesn't exist.
func (s *Server) applicationReviewMode(ctx context.Context, appID int64) (string, *int64, error) {
	var clientID sql.NullInt64
	if err := s.deps.DB.QueryRowContext(ctx,
		`SELECT client_id FROM institution_applications WHERE id = $1`, appID,
	).Scan(&clientID); err != nil {
		return "", nil, err
	}
	if !clientID.Valid {
		return "admin", nil, nil
	}
	var mode string
	if err := s.deps.DB.QueryRowContext(ctx,
		`SELECT kyc_review_mode FROM clients WHERE id = $1`, clientID.Int64,
	).Scan(&mode); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			// Orphaned client_id — treat like unattached.
			return "admin", nil, nil
		}
		return "", nil, err
	}
	cid := clientID.Int64
	return mode, &cid, nil
}

// advanceApplicationToClientQueue is the "both" mode intermediate
// step: superadmin has said yes, hand it off to the client reviewer.
// Only pre-condition is that the row is currently in the admin queue
// (status='pending', pending_reviewer='admin'). The org and admin user
// are NOT created here — that happens when the client reviewer also
// approves (via approveApplication).
//
// note (if non-empty) is stored in review_note so the client reviewer
// can see the superadmin's context. reviewed_by_user_id / reviewed_at
// are left untouched so a later `client_reviewer` approve can stamp
// them with the FINAL approver's identity.
func (s *Server) advanceApplicationToClientQueue(ctx context.Context, appID, superadminUserID int64, note string) error {
	res, err := s.deps.DB.ExecContext(ctx,
		`UPDATE institution_applications
		    SET pending_reviewer = 'client',
		        review_note = COALESCE(NULLIF($1, ''), review_note),
		        updated_at = CURRENT_TIMESTAMP
		  WHERE id = $2
		    AND status = 'pending'
		    AND (pending_reviewer IS NULL OR pending_reviewer = 'admin')`,
		note, appID,
	)
	if err != nil {
		return fmt.Errorf("advance to client queue: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		// Either the row doesn't exist, isn't pending, or has already
		// moved out of the admin queue.
		var status, pendingReviewer sql.NullString
		if err := s.deps.DB.QueryRowContext(ctx,
			`SELECT status, pending_reviewer FROM institution_applications WHERE id = $1`,
			appID,
		).Scan(&status, &pendingReviewer); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return errAppNotFound
			}
			return err
		}
		if status.Valid && status.String != "pending" {
			return fmt.Errorf("%w (currently %s)", errAppNotPending, status.String)
		}
		return errAppNotFound
	}
	_ = superadminUserID // reserved for future audit column
	return nil
}

// checkPortalEnabled returns errAppPortalDisabled if the given client's
// portal_enabled flag is off. Also returns errAppOutOfScope if the
// client id itself doesn't exist (couldn't happen from a valid JWT,
// but keeps the failure mode explicit).
func (s *Server) checkPortalEnabled(ctx context.Context, clientID int64) error {
	var enabled bool
	err := s.deps.DB.QueryRowContext(ctx,
		`SELECT portal_enabled FROM clients WHERE id = $1`, clientID,
	).Scan(&enabled)
	if errors.Is(err, sql.ErrNoRows) {
		return errAppOutOfScope
	}
	if err != nil {
		return fmt.Errorf("portal probe: %w", err)
	}
	if !enabled {
		return errAppPortalDisabled
	}
	return nil
}
