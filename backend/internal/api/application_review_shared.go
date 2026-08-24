package api

// Shared approve/reject flow for institution_applications.
//
// The same steps run whether the review is done from the superadmin
// global queue or from a client reviewer's client-scoped inbox — the
// only difference is who's allowed to act on which row. Extracted here
// so both callers stay thin wrappers that do auth + response shaping
// only.

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
// relevant fields to the client — superadmin surfaces every field
// (including the operator credential); a client reviewer might choose
// to hide some.
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

// approveApplication runs the full approval flow inside its own
// transaction: atomic state-change, org + admin + operator user
// creation, magic-link issuance, best-effort email.
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

	tx, err := s.deps.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("db begin: %w", err)
	}
	defer tx.Rollback()

	// Atomically claim the application as approved BEFORE doing any
	// other work. Two concurrent approvals would otherwise both read
	// status='pending', both proceed, and both create user/operator
	// rows; the second would see UNIQUE failures on some inserts but
	// might leave half-created state. UPDATE ... WHERE status='pending'
	// guarantees exactly one transaction wins.
	//
	// The scope predicate is folded into the same UPDATE so a reviewer
	// out-of-scope can't even race a superadmin — the row simply
	// doesn't match their WHERE clause. pending_reviewer is nulled out
	// on approve since the row is now terminal.
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
	res0, err := tx.ExecContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("app claim: %w", err)
	}
	affected, _ := res0.RowsAffected()
	if affected == 0 {
		// Disambiguate why the row didn't move for a helpful error.
		var (
			status  string
			gotScope sql.NullInt64
		)
		err := tx.QueryRowContext(ctx,
			`SELECT status, client_id FROM institution_applications WHERE id = $1`, appID,
		).Scan(&status, &gotScope)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, errAppNotFound
		}
		if err != nil {
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
		return nil, errAppNotFound
	}

	// Now read the rest of the columns we need to provision the org.
	// We already own the row's state transition; concurrent readers
	// will see status='approved' and skip.
	var (
		instName, headName, headEmail, headDesignation string
		aishe                                          sql.NullString
		appClientID                                    sql.NullInt64
	)
	err = tx.QueryRowContext(ctx,
		`SELECT institution_name, head_name, head_email, head_designation, aishe_code, client_id
		   FROM institution_applications WHERE id = $1`, appID,
	).Scan(&instName, &headName, &headEmail, &headDesignation, &aishe, &appClientID)
	if err != nil {
		return nil, fmt.Errorf("db read: %w", err)
	}

	// Choose an org code. Prefer AISHE code (always unique); fall back
	// to a synthetic code derived from the application ID.
	orgCode := "APP_" + strconv.FormatInt(appID, 10)
	if aishe.Valid && aishe.String != "" {
		orgCode = "AISHE_" + aishe.String
	}

	// Insert organization (or find existing — orgs.code is UNIQUE).
	var orgID int64
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO organizations(code, name) VALUES($1, $2) ON CONFLICT (code) DO NOTHING`,
		orgCode, instName,
	); err != nil {
		return nil, fmt.Errorf("org insert: %w", err)
	}
	if err := tx.QueryRowContext(ctx,
		`SELECT id FROM organizations WHERE code = $1`, orgCode,
	).Scan(&orgID); err != nil {
		return nil, fmt.Errorf("org read: %w", err)
	}

	// Insert the admin user with a *placeholder* bcrypt of random data.
	// They can't sign in until they set their own password via the
	// magic link — the placeholder is for the NOT NULL constraint only.
	username := slugifyUsername(instName) + "_" + strconv.FormatInt(appID, 10)
	placeholder, err := bcrypt.GenerateFromPassword([]byte("placeholder-"+username), bcrypt.MinCost)
	if err != nil {
		return nil, fmt.Errorf("bcrypt: %w", err)
	}
	// Copy the KYC head_email onto the users row so the admin can sign
	// in with either their username or the email they used to register.
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

	// Auto-created default "Centre Operator" retired 2026-08-23. Under
	// the post-V9 subscription-approval flow operators must be assigned
	// to specific exams via operator_exams; a default one with zero
	// assignments was just noise on the admin's Operators page. Admin
	// creates real, exam-scoped operators after logging in via the
	// magic link below.
	//
	// The OperatorUsername / OperatorPassword fields on the response
	// struct stay for wire-shape compatibility (existing FE reads them,
	// now gets empty strings and hides its CredBlocks).

	// V15 exam fan-out: if the application was routed through a
	// specific client (kyc_review_mode routing put a client_id on this
	// row), auto-grant the newly-created org access to every visible +
	// open exam under that client. This is the replacement for the old
	// admin-driven exam-subscribe flow — the admin no longer has a UI
	// to subscribe, so subscription is minted here at approval time.
	// Existing pre-V15 approvals had client_id=NULL and hit no rows;
	// this only fires for post-V15 rows.
	if appClientID.Valid {
		if _, err := tx.ExecContext(ctx, `
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
			orgID, reviewerUserID, appClientID.Int64,
		); err != nil {
			return nil, fmt.Errorf("exam fan-out: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("db commit: %w", err)
	}

	// Everything below is post-commit and best-effort; a failure here
	// doesn't roll the approval back. The admin can request a fresh
	// magic link via the resend endpoint.
	token, err := s.magicLinks.Generate(ctx, userID, magiclink.PurposeSetPassword, 0)
	if err != nil {
		return nil, fmt.Errorf("magic link: %w", err)
	}
	linkURL := s.buildMagicLinkURL(r, token)

	if s.emailer != nil {
		body := buildApprovalEmail(instName, headName, username, linkURL, note)
		if err := s.emailer.Send(ctx, email.Message{
			To:      headEmail,
			Subject: "Your institution has been approved — set your portal password",
			Body:    body,
		}); err != nil {
			log.Printf("emailer.Send approval to %s: %v", headEmail, err)
		}
	}

	return &approvedApplication{
		ApplicationID:    appID,
		OrgID:            orgID,
		AdminUserID:      userID,
		AdminUsername:    username,
		MagicLinkURL:     linkURL,
		// OperatorUsername + OperatorPassword deliberately empty —
		// auto-created default operator was removed 2026-08-23. See
		// note above the Commit call.
		InstitutionName:  instName,
		HeadName:         headName,
		HeadEmail:        headEmail,
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
