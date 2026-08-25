package api

// Admin re-submit endpoints for rejected KYC applications.
//
// When a KYC review lands as 'rejected', the admin's dashboard shows
// a lock screen with the reviewer's note and a "Re-submit application"
// button. Clicking it opens a page where the admin edits any fields
// the reviewer flagged and replaces/reuploads documents, then resubmits.
// Resubmit flips the row back to status='pending', clears the review
// note, and re-routes based on the client's current kyc_review_mode.
//
// All endpoints here are KYC-open (bypass the requireApprovedKYC gate
// via requireRoleOpen) since the whole point is to be reachable while
// the admin is locked out. They're all scoped to the caller's own
// org via organizations.application_id — an admin can't touch another
// tenant's application.
//
//   GET    /api/admin/kyc-application               pre-fill the resubmit form
//   PATCH  /api/admin/kyc-application               update editable fields
//   POST   /api/admin/kyc-application/docs          upload/replace a doc
//   DELETE /api/admin/kyc-application/docs/{doc_id} remove a doc
//   POST   /api/admin/kyc-application/resubmit      flip back to pending

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/go-chi/chi/v5"
)

// resolveMyApplication returns the application_id for the caller's
// org. Returns errAppNotFound if the org doesn't have a linked
// application (legacy pre-V17 org — resubmit doesn't apply).
func (s *Server) resolveMyApplication(r *http.Request) (int64, error) {
	c := claimsFrom(r)
	if c == nil || c.OrgID == nil {
		return 0, errAppNotFound
	}
	var appID sql.NullInt64
	if err := s.deps.DB.QueryRowContext(r.Context(),
		`SELECT application_id FROM organizations WHERE id = $1`, *c.OrgID,
	).Scan(&appID); err != nil {
		return 0, err
	}
	if !appID.Valid {
		return 0, errAppNotFound
	}
	return appID.Int64, nil
}

// requireOwnedRejectedApp is the common precondition for every
// mutation endpoint in this file: caller must own an app whose
// current status is 'rejected'. Anything else (draft / pending /
// approved / missing) 409s so the FE can't accidentally trigger a
// resubmit path when there's nothing to resubmit.
func (s *Server) requireOwnedRejectedApp(w http.ResponseWriter, r *http.Request) (int64, bool) {
	appID, err := s.resolveMyApplication(r)
	if err != nil {
		if errors.Is(err, errAppNotFound) || errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "no application on file for this account")
			return 0, false
		}
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return 0, false
	}
	var status string
	if err := s.deps.DB.QueryRowContext(r.Context(),
		`SELECT status FROM institution_applications WHERE id = $1`, appID,
	).Scan(&status); err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return 0, false
	}
	if status != "rejected" {
		writeErr(w, http.StatusConflict,
			"resubmit is only available for rejected applications (current: "+status+")")
		return 0, false
	}
	return appID, true
}

// GET /api/admin/kyc-application — pre-fill the resubmit form.
//
// Returns the current application record + its documents in the same
// shape the superadmin's ApplicationDetail sees, minus fields the
// admin has no business seeing (reviewed_by_user_id, pending_reviewer,
// client_id). No status gate — even a pending / approved admin can
// read their own submission for reference; the mutating endpoints
// gate on 'rejected' separately.
func (s *Server) adminGetMyKYCApplication(w http.ResponseWriter, r *http.Request) {
	appID, err := s.resolveMyApplication(r)
	if err != nil {
		if errors.Is(err, errAppNotFound) || errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "no application on file for this account")
			return
		}
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	d, err := s.loadApplicationDetail(r.Context(), appID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "application not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	// Rewrite doc URLs so the admin's browser fetches through the admin-
	// scoped endpoint (not the superadmin's).
	for i := range d.Docs {
		d.Docs[i].DownloadURL = fmt.Sprintf("/api/admin/kyc-application/docs/%d", d.Docs[i].DocID)
	}
	writeJSON(w, http.StatusOK, d)
}

// PATCH /api/admin/kyc-application — update editable fields on the
// admin's own application. Only allowed while status='rejected'.
// Field set mirrors the fields the register form exposes; the review
// / routing fields (client_id, pending_reviewer, reviewed_*) are NOT
// mutable here.
type resubmitPatchReq struct {
	InstitutionName      *string `json:"institution_name,omitempty"`
	InstitutionType      *string `json:"institution_type,omitempty"`
	Tier                 *string `json:"tier,omitempty"`
	AisheCode            *string `json:"aishe_code,omitempty"`
	PAN                  *string `json:"pan,omitempty"`
	YearEstablished      *int    `json:"year_established,omitempty"`
	AffiliationBody      *string `json:"affiliation_body,omitempty"`
	AddressLine1         *string `json:"address_line1,omitempty"`
	AddressLine2         *string `json:"address_line2,omitempty"`
	City                 *string `json:"city,omitempty"`
	District             *string `json:"district,omitempty"`
	State                *string `json:"state,omitempty"`
	PinCode              *string `json:"pin_code,omitempty"`
	ApproxStudentCount   *int    `json:"approx_student_count,omitempty"`
	ExpectedCentres      *int    `json:"expected_centres,omitempty"`
	HeadName             *string `json:"head_name,omitempty"`
	HeadDesignation      *string `json:"head_designation,omitempty"`
	HeadEmail            *string `json:"head_email,omitempty"`
	HeadMobile           *string `json:"head_mobile,omitempty"`
}

func (s *Server) adminPatchMyKYCApplication(w http.ResponseWriter, r *http.Request) {
	appID, ok := s.requireOwnedRejectedApp(w, r)
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	var req resubmitPatchReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}

	sets := []string{}
	args := []any{}
	push := func(col string, val any) {
		sets = append(sets, fmt.Sprintf("%s = $%d", col, len(args)+1))
		args = append(args, val)
	}
	if req.InstitutionName != nil {
		v := strings.TrimSpace(*req.InstitutionName)
		if len(v) < 3 || len(v) > 200 {
			writeErr(w, http.StatusBadRequest, "institution_name must be 3–200 characters")
			return
		}
		push("institution_name", v)
	}
	if req.InstitutionType != nil {
		v := strings.ToLower(strings.TrimSpace(*req.InstitutionType))
		if v == "" || len(v) > 80 {
			writeErr(w, http.StatusBadRequest, "institution_type is required (up to 80 chars)")
			return
		}
		push("institution_type", v)
	}
	if req.Tier != nil {
		v := strings.TrimSpace(*req.Tier)
		if !allowedTiers[v] {
			writeErr(w, http.StatusBadRequest, "invalid tier")
			return
		}
		if v == "" {
			push("tier", nil)
		} else {
			push("tier", v)
		}
	}
	if req.AisheCode != nil {
		push("aishe_code", nullable(strings.TrimSpace(*req.AisheCode)))
	}
	if req.PAN != nil {
		v := strings.ToUpper(strings.TrimSpace(*req.PAN))
		if v != "" && !rePAN.MatchString(v) && !reTAN.MatchString(v) {
			writeErr(w, http.StatusBadRequest, "PAN or TAN format looks wrong")
			return
		}
		push("pan", nullable(v))
	}
	if req.YearEstablished != nil {
		push("year_established", nullInt(*req.YearEstablished))
	}
	if req.AffiliationBody != nil {
		push("affiliation_body", nullable(strings.TrimSpace(*req.AffiliationBody)))
	}
	if req.AddressLine1 != nil {
		v := strings.TrimSpace(*req.AddressLine1)
		if v == "" {
			writeErr(w, http.StatusBadRequest, "address_line1 is required")
			return
		}
		push("address_line1", v)
	}
	if req.AddressLine2 != nil {
		push("address_line2", nullable(strings.TrimSpace(*req.AddressLine2)))
	}
	if req.City != nil {
		push("city", nullable(strings.TrimSpace(*req.City)))
	}
	if req.District != nil {
		push("district", nullable(strings.TrimSpace(*req.District)))
	}
	if req.State != nil {
		v := strings.TrimSpace(*req.State)
		if v == "" {
			writeErr(w, http.StatusBadRequest, "state is required")
			return
		}
		push("state", v)
	}
	if req.PinCode != nil {
		v := strings.TrimSpace(*req.PinCode)
		if !rePIN.MatchString(v) {
			writeErr(w, http.StatusBadRequest, "PIN must be 6 digits")
			return
		}
		push("pin_code", v)
	}
	if req.ApproxStudentCount != nil {
		push("approx_student_count", nullInt(*req.ApproxStudentCount))
	}
	if req.ExpectedCentres != nil {
		push("expected_centres", maxInt(*req.ExpectedCentres, 1))
	}
	if req.HeadName != nil {
		v := strings.TrimSpace(*req.HeadName)
		if len(v) < 2 {
			writeErr(w, http.StatusBadRequest, "head_name is required")
			return
		}
		push("head_name", v)
	}
	if req.HeadDesignation != nil {
		push("head_designation", strings.TrimSpace(*req.HeadDesignation))
	}
	if req.HeadEmail != nil {
		v := strings.ToLower(strings.TrimSpace(*req.HeadEmail))
		if !reEmail.MatchString(v) {
			writeErr(w, http.StatusBadRequest, "head_email is not a valid address")
			return
		}
		push("head_email", v)
	}
	if req.HeadMobile != nil {
		v := strings.TrimSpace(*req.HeadMobile)
		if !reMobile.MatchString(v) {
			writeErr(w, http.StatusBadRequest, "head_mobile must be a 10-digit Indian mobile")
			return
		}
		push("head_mobile", v)
	}

	if len(sets) == 0 {
		writeErr(w, http.StatusBadRequest, "nothing to update")
		return
	}
	sets = append(sets, "updated_at = CURRENT_TIMESTAMP")
	args = append(args, appID)

	q := fmt.Sprintf(
		"UPDATE institution_applications SET %s WHERE id = $%d",
		strings.Join(sets, ", "), len(args),
	)
	if _, err := s.deps.DB.ExecContext(r.Context(), q, args...); err != nil {
		// The unique partial indexes on head_email / head_mobile / PAN /
		// AISHE will surface here if the admin tries to change an
		// identity field to something another application already
		// owns. Return a friendly hint.
		if isUniqueViolation(err) {
			el := strings.ToLower(err.Error())
			switch {
			case strings.Contains(el, "head_email"):
				writeErr(w, http.StatusConflict, "That email is already registered to another application.")
			case strings.Contains(el, "head_mobile"):
				writeErr(w, http.StatusConflict, "That mobile is already registered to another application.")
			case strings.Contains(el, "pan_active"):
				writeErr(w, http.StatusConflict, "That PAN/TAN is already registered to another application.")
			case strings.Contains(el, "aishe"):
				writeErr(w, http.StatusConflict, "That AISHE code is already registered to another application.")
			default:
				writeErr(w, http.StatusConflict, "One of the identity fields is already in use.")
			}
			return
		}
		writeErr(w, http.StatusInternalServerError, "db update: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "application_id": appID})
}

// POST /api/admin/kyc-application/docs — upload / replace a doc.
// Only allowed while status='rejected'. Delegates the actual file
// write + insert to the shared saveUploadedDoc helper (extracted
// from registerUploadDoc). The FE typically deletes the old doc of
// the same kind first, then uploads the replacement; nothing here
// enforces that pairing.
func (s *Server) adminUploadMyKYCDoc(w http.ResponseWriter, r *http.Request) {
	appID, ok := s.requireOwnedRejectedApp(w, r)
	if !ok {
		return
	}
	s.saveUploadedDoc(w, r, appID)
}

// DELETE /api/admin/kyc-application/docs/{doc_id}
//
// Removes one document from the admin's own application. Scoped by
// application_id so the docID URL param can't sneak a delete on
// another tenant's doc. Only allowed while status='rejected'.
func (s *Server) adminDeleteMyKYCDoc(w http.ResponseWriter, r *http.Request) {
	appID, ok := s.requireOwnedRejectedApp(w, r)
	if !ok {
		return
	}
	docID, err := parseInt64(chi.URLParam(r, "doc_id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid doc_id")
		return
	}
	// Best-effort disk cleanup — read storage_path first, then delete
	// the row, then unlink the file. If the row DELETE fails we leave
	// disk alone; if the file unlink fails we've already lost the DB
	// reference so an orphaned file is the worst that happens.
	var storagePath string
	if err := s.deps.DB.QueryRowContext(r.Context(),
		`SELECT storage_path FROM institution_application_documents
		  WHERE id = $1 AND application_id = $2`, docID, appID,
	).Scan(&storagePath); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "document not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	if _, err := s.deps.DB.ExecContext(r.Context(),
		`DELETE FROM institution_application_documents WHERE id = $1 AND application_id = $2`,
		docID, appID,
	); err != nil {
		writeErr(w, http.StatusInternalServerError, "db delete: "+err.Error())
		return
	}
	// Fire-and-forget disk cleanup for legacy disk-backed rows.
	// s3:// storage_paths are ignored (S3 GC is a separate concern).
	if strings.HasPrefix(storagePath, "/") {
		_ = os.Remove(storagePath)
	}
	w.WriteHeader(http.StatusNoContent)
}

// GET /api/admin/kyc-application/docs/{doc_id}
//
// Admin's own doc download — mirrors the superadmin/reviewer scoped
// download but scoped by the caller's application_id. Reused by the
// KycResubmit page to preview docs before deciding to keep or replace.
func (s *Server) adminDownloadMyKYCDoc(w http.ResponseWriter, r *http.Request) {
	appID, err := s.resolveMyApplication(r)
	if err != nil {
		writeErr(w, http.StatusNotFound, "application not found")
		return
	}
	docID, err := parseInt64(chi.URLParam(r, "doc_id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid doc_id")
		return
	}
	var storagePath, mime, original string
	if err := s.deps.DB.QueryRowContext(r.Context(),
		`SELECT storage_path, mime, original_name
		   FROM institution_application_documents
		  WHERE id = $1 AND application_id = $2`, docID, appID,
	).Scan(&storagePath, &mime, &original); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "document not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`inline; filename="%s"`, safeFilename(original)))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if err := s.streamDocBytes(w, r, storagePath); err != nil {
		fmt.Fprintf(w, "\n<!-- stream error: %v -->\n", err)
	}
}

// POST /api/admin/kyc-application/resubmit — flip status back to
// 'pending' and re-route via the client's current kyc_review_mode.
//
// Preconditions:
//   * Caller owns an application with status='rejected'.
//   * The required document set (recognition_letter, pan_card,
//     authorization_letter) is on file. Missing docs → 400 with the
//     names so the FE can highlight them.
//
// Side effects:
//   * status = 'pending'
//   * review_note = NULL, reviewed_at = NULL, reviewed_by_user_id = NULL
//   * pending_reviewer = per client.kyc_review_mode (same rule as
//     registerSubmit — mode='client' → 'client', else 'admin').
//   * updated_at bumped so the reviewer's queue sorts it fresh.
//
// No email is sent from here today — the FE bounces to the lock
// screen, which now shows the 'pending' state. Adding a resubmit
// notification email is a follow-up.
func (s *Server) adminResubmitMyKYCApplication(w http.ResponseWriter, r *http.Request) {
	appID, ok := s.requireOwnedRejectedApp(w, r)
	if !ok {
		return
	}

	// Confirm all required doc_kinds are present.
	rows, err := s.deps.DB.QueryContext(r.Context(),
		`SELECT doc_kind FROM institution_application_documents WHERE application_id = $1`, appID,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	have := map[string]bool{}
	for rows.Next() {
		var k string
		_ = rows.Scan(&k)
		have[k] = true
	}
	rows.Close()
	var missing []string
	for _, k := range requiredDocKinds {
		if !have[k] {
			missing = append(missing, k)
		}
	}
	if len(missing) > 0 {
		writeErr(w, http.StatusBadRequest,
			"missing required documents: "+strings.Join(missing, ", "))
		return
	}

	// Compute pending_reviewer per the client's current mode. Same
	// rule as registerSubmit — 'client' mode → client queue, everything
	// else (admin / both / no client) → admin queue.
	pendingReviewer := "admin"
	var clientID sql.NullInt64
	_ = s.deps.DB.QueryRowContext(r.Context(),
		`SELECT client_id FROM institution_applications WHERE id = $1`, appID,
	).Scan(&clientID)
	if clientID.Valid {
		var mode string
		if err := s.deps.DB.QueryRowContext(r.Context(),
			`SELECT kyc_review_mode FROM clients WHERE id = $1`, clientID.Int64,
		).Scan(&mode); err == nil && mode == "client" {
			pendingReviewer = "client"
		}
	}

	if _, err := s.deps.DB.ExecContext(r.Context(),
		`UPDATE institution_applications
		    SET status = 'pending',
		        pending_reviewer = $2,
		        review_note = NULL,
		        reviewed_at = NULL,
		        reviewed_by_user_id = NULL,
		        updated_at = CURRENT_TIMESTAMP
		  WHERE id = $1 AND status = 'rejected'`,
		appID, pendingReviewer,
	); err != nil {
		writeErr(w, http.StatusInternalServerError, "db update: "+err.Error())
		return
	}

	s.auditFromRequest(r, "application.resubmit", "application", appID, map[string]any{
		"pending_reviewer": pendingReviewer,
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":               true,
		"application_id":   appID,
		"status":           "pending",
		"pending_reviewer": pendingReviewer,
	})
}
