package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/veni/neet-verification/internal/email"
	"github.com/veni/neet-verification/internal/magiclink"
	"github.com/veni/neet-verification/internal/db"
)

// Superadmin endpoints for the institution-application queue.
//
// The approve path is the only one with real side-effects: it creates
// an organizations row + a users row + a magic_links row + sends the
// activation email, all in a single transaction. Failure rolls back
// every side-effect so partial activation can't happen.
//
// Reject and request-more-info are simple status flips plus an
// optional note that gets emailed to the head.

const (
	// Defaults / max for paginated list endpoint.
	listDefaultLimit = 25
	listMaxLimit     = 100
)

// ----- GET /api/superadmin/applications -----

type applicationListItem struct {
	ID              int64  `json:"id"`
	Status          string `json:"status"`
	InstitutionName string `json:"institution_name"`
	InstitutionType string `json:"institution_type"`
	Tier            string `json:"tier,omitempty"`
	AisheCode       string `json:"aishe_code,omitempty"`
	State           string `json:"state"`
	City            string `json:"city"`
	HeadName        string `json:"head_name"`
	HeadEmail       string `json:"head_email"`
	CreatedAt       string `json:"created_at"`
	DocCount        int    `json:"doc_count"`
}

type applicationListResp struct {
	Items  []applicationListItem `json:"items"`
	Total  int                   `json:"total"`
	Limit  int                   `json:"limit"`
	Offset int                   `json:"offset"`
}

func (s *Server) superadminListApplications(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	// Pagination — clamped server-side so a malicious limit=1000000
	// can't blow the response.
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 {
		limit = listDefaultLimit
	}
	if limit > listMaxLimit {
		limit = listMaxLimit
	}
	offset, _ := strconv.Atoi(q.Get("offset"))
	if offset < 0 {
		offset = 0
	}

	// Filter by status. Empty / "all" = no filter, otherwise must be a
	// known value or we 400 to flag the caller's bug instead of silently
	// returning nothing.
	status := strings.TrimSpace(q.Get("status"))
	allowedStatuses := map[string]bool{
		"": true, "all": true,
		"draft": true, "pending": true, "approved": true, "rejected": true,
	}
	if !allowedStatuses[status] {
		writeErr(w, http.StatusBadRequest, "invalid status filter")
		return
	}

	// Free-text search across name / AISHE / PAN / head_email. LIKE with
	// leading-wildcard isn't index-friendly but the dataset is bounded
	// (~10k rows at steady state) so it's fine; promotable to FTS later.
	search := strings.TrimSpace(q.Get("q"))

	where := []string{"1=1"}
	args := []any{}
	if status != "" && status != "all" {
		where = append(where, "status = ?")
		args = append(args, status)
	}
	// V15 routing: pending applications routed to the client reviewer
	// (mode='client' at submit, or mode='both' after superadmin approves)
	// live in `pending_reviewer='client'` and are NOT shown in this
	// superadmin queue. Approved/rejected historical rows and pre-V15
	// pending rows (pending_reviewer=NULL) always show.
	where = append(where, "(status != 'pending' OR pending_reviewer IS NULL OR pending_reviewer = 'admin')")
	if search != "" {
		where = append(where, "(institution_name LIKE ? OR aishe_code LIKE ? OR pan LIKE ? OR head_email LIKE ?)")
		p := "%" + search + "%"
		args = append(args, p, p, p, p)
	}
	whereSQL := strings.Join(where, " AND ")

	// Count for pagination footer.
	var total int
	if err := s.deps.DB.QueryRowContext(r.Context(),
		db.Q("SELECT COUNT(*) FROM institution_applications WHERE "+whereSQL), args...,
	).Scan(&total); err != nil {
		writeErr(w, http.StatusInternalServerError, "db count")
		return
	}

	// Page query. The COALESCE wraps optional columns so Scan doesn't
	// need NullString for everything.
	listArgs := append([]any{}, args...)
	listArgs = append(listArgs, limit, offset)
	rows, err := s.deps.DB.QueryContext(r.Context(),
		db.Q("SELECT id, status, institution_name, institution_type, "+
			"COALESCE(tier,''), COALESCE(aishe_code,''), state, city, "+
			"head_name, head_email, created_at, "+
			"(SELECT COUNT(*) FROM institution_application_documents d WHERE d.application_id = institution_applications.id) "+
			"FROM institution_applications WHERE "+whereSQL+
			" ORDER BY created_at DESC LIMIT ? OFFSET ?"),
		listArgs...,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db list")
		return
	}
	defer rows.Close()

	out := []applicationListItem{}
	for rows.Next() {
		var it applicationListItem
		var createdAt time.Time
		if err := rows.Scan(&it.ID, &it.Status, &it.InstitutionName, &it.InstitutionType,
			&it.Tier, &it.AisheCode, &it.State, &it.City,
			&it.HeadName, &it.HeadEmail, &createdAt, &it.DocCount); err != nil {
			continue
		}
		it.CreatedAt = createdAt.UTC().Format(time.RFC3339)
		out = append(out, it)
	}
	writeJSON(w, http.StatusOK, applicationListResp{
		Items:  out,
		Total:  total,
		Limit:  limit,
		Offset: offset,
	})
}

// ----- GET /api/superadmin/applications/{id} -----

type applicationDetail struct {
	ID                 int64  `json:"id"`
	Status             string `json:"status"`
	InstitutionName    string `json:"institution_name"`
	InstitutionType    string `json:"institution_type"`
	Tier               string `json:"tier,omitempty"`
	AisheCode          string `json:"aishe_code,omitempty"`
	PAN                string `json:"pan,omitempty"`
	YearEstablished    int    `json:"year_established,omitempty"`
	AffiliationBody    string `json:"affiliation_body,omitempty"`
	AddressLine1       string `json:"address_line1"`
	AddressLine2       string `json:"address_line2,omitempty"`
	City               string `json:"city"`
	District           string `json:"district,omitempty"`
	State              string `json:"state"`
	PinCode            string `json:"pin_code"`
	ApproxStudentCount int    `json:"approx_student_count,omitempty"`
	ExpectedCentres    int    `json:"expected_centres"`
	HeadName           string `json:"head_name"`
	HeadDesignation    string `json:"head_designation"`
	HeadEmail          string `json:"head_email"`
	HeadMobile         string `json:"head_mobile"`
	ReviewNote         string `json:"review_note,omitempty"`
	ReviewedAt         string `json:"reviewed_at,omitempty"`
	CreatedAt          string `json:"created_at"`
	UpdatedAt          string `json:"updated_at"`
	// V15 routing surface — tells the UI which queue the row currently
	// sits in and (if routed) which client owns it.
	ClientID           *int64      `json:"client_id,omitempty"`
	ClientName         string      `json:"client_name,omitempty"`
	ClientKYCReviewMode string     `json:"client_kyc_review_mode,omitempty"`
	PendingReviewer    string      `json:"pending_reviewer,omitempty"`
	Docs               []docDetail `json:"docs"`
}

type docDetail struct {
	DocID        int64  `json:"doc_id"`
	DocKind      string `json:"doc_kind"`
	OriginalName string `json:"original_name"`
	Mime         string `json:"mime"`
	SizeBytes    int64  `json:"size_bytes"`
	Sha256       string `json:"sha256"`
	DownloadURL  string `json:"download_url"`
	UploadedAt   string `json:"uploaded_at"`
}

func (s *Server) superadminGetApplication(w http.ResponseWriter, r *http.Request) {
	appID, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil || appID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid id")
		return
	}
	d, err := s.loadApplicationDetail(r.Context(), appID)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "application not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read")
		return
	}
	writeJSON(w, http.StatusOK, d)
}

func (s *Server) loadApplicationDetail(ctx context.Context, appID int64) (*applicationDetail, error) {
	var (
		d           applicationDetail
		tier, aishe, pan, addr2, district, affil, reviewNote, pendingReviewer sql.NullString
		yearEst, studentCount sql.NullInt64
		clientID            sql.NullInt64
		reviewedAt          sql.NullTime
		createdAt, updatedAt time.Time
	)
	err := s.deps.DB.QueryRowContext(ctx,
		db.Q(`SELECT id, status, institution_name, institution_type,
		        tier, aishe_code, pan, year_established, affiliation_body,
		        address_line1, address_line2, city, district, state, pin_code,
		        approx_student_count, expected_centres,
		        head_name, head_designation, head_email, head_mobile,
		        review_note, reviewed_at, created_at, updated_at,
		        client_id, pending_reviewer
		 FROM institution_applications WHERE id = $1`), appID,
	).Scan(&d.ID, &d.Status, &d.InstitutionName, &d.InstitutionType,
		&tier, &aishe, &pan, &yearEst, &affil,
		&d.AddressLine1, &addr2, &d.City, &district, &d.State, &d.PinCode,
		&studentCount, &d.ExpectedCentres,
		&d.HeadName, &d.HeadDesignation, &d.HeadEmail, &d.HeadMobile,
		&reviewNote, &reviewedAt, &createdAt, &updatedAt,
		&clientID, &pendingReviewer,
	)
	if err != nil {
		return nil, err
	}
	if clientID.Valid {
		cid := clientID.Int64
		d.ClientID = &cid
		// Best-effort client name + mode enrichment — the detail page
		// uses these to render the current routing state chip.
		_ = s.deps.DB.QueryRowContext(ctx,
			`SELECT name, kyc_review_mode FROM clients WHERE id = $1`, cid,
		).Scan(&d.ClientName, &d.ClientKYCReviewMode)
	}
	if pendingReviewer.Valid {
		d.PendingReviewer = pendingReviewer.String
	}
	d.Tier = tier.String
	d.AisheCode = aishe.String
	d.PAN = pan.String
	d.AddressLine2 = addr2.String
	d.District = district.String
	d.AffiliationBody = affil.String
	d.ReviewNote = reviewNote.String
	if yearEst.Valid {
		d.YearEstablished = int(yearEst.Int64)
	}
	if studentCount.Valid {
		d.ApproxStudentCount = int(studentCount.Int64)
	}
	if reviewedAt.Valid {
		d.ReviewedAt = reviewedAt.Time.UTC().Format(time.RFC3339)
	}
	d.CreatedAt = createdAt.UTC().Format(time.RFC3339)
	d.UpdatedAt = updatedAt.UTC().Format(time.RFC3339)

	rows, err := s.deps.DB.QueryContext(ctx,
		db.Q(`SELECT id, doc_kind, original_name, mime, size_bytes, sha256, uploaded_at
		 FROM institution_application_documents
		 WHERE application_id = $1 ORDER BY id`), appID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	d.Docs = []docDetail{}
	for rows.Next() {
		var doc docDetail
		var ua time.Time
		if err := rows.Scan(&doc.DocID, &doc.DocKind, &doc.OriginalName,
			&doc.Mime, &doc.SizeBytes, &doc.Sha256, &ua); err != nil {
			continue
		}
		doc.UploadedAt = ua.UTC().Format(time.RFC3339)
		doc.DownloadURL = fmt.Sprintf("/api/superadmin/applications/%d/docs/%d", appID, doc.DocID)
		d.Docs = append(d.Docs, doc)
	}
	return &d, nil
}

// ----- GET /api/superadmin/applications/{id}/docs/{doc_id} -----
//
// Streams the file back to the superadmin's browser with the right
// Content-Type so it renders inline (PDF / image). os.Open + io.Copy
// means even a 10 MB file is served without holding bytes in RAM.

func (s *Server) superadminDownloadDoc(w http.ResponseWriter, r *http.Request) {
	appID, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid id")
		return
	}
	docID, err := parseInt64(chi.URLParam(r, "doc_id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid doc_id")
		return
	}
	// V15 gate — KYC document bytes are visible to superadmin ONLY when
	// the app is routed to a board they have decision authority on
	// (mode='admin' or 'both'). Un-routed apps and client-only routed
	// apps → sealed. Superadmin still sees basic contact fields on the
	// detail page (they need those to route sensibly) but not the
	// sensitive document bytes.
	mode, clientID, mErr := s.applicationReviewMode(r.Context(), appID)
	if mErr != nil && !errors.Is(mErr, sql.ErrNoRows) {
		writeErr(w, http.StatusInternalServerError, "db read")
		return
	}
	if clientID == nil {
		writeErr(w, http.StatusForbidden,
			"Route this application to a client first — KYC documents become viewable once routed to an admin/both board.")
		return
	}
	if mode == "client" {
		writeErr(w, http.StatusForbidden,
			"KYC documents for a client-only board are only visible to that client's reviewer.")
		return
	}

	var storagePath, mime, original string
	err = s.deps.DB.QueryRowContext(r.Context(),
		`SELECT storage_path, mime, original_name
		 FROM institution_application_documents
		 WHERE id = $1 AND application_id = $2`, docID, appID,
	).Scan(&storagePath, &mime, &original)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "document not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read")
		return
	}
	w.Header().Set("Content-Type", mime)
	// Inline so PDF renders in the browser tab; the filename hints the
	// "save as" name if the superadmin chooses to download.
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`inline; filename="%s"`, safeFilename(original)))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if err := s.streamDocBytes(w, r, storagePath); err != nil {
		// Header hasn't been fully sent yet if we didn't write body,
		// but be defensive: caller already saw content-type. Log and
		// return — writing an error JSON after headers would produce
		// a corrupt response.
		fmt.Fprintf(os.Stderr,
			"superadminDownloadDoc: stream failed doc=%d: %v\n", docID, err)
	}
}

// safeFilename strips characters that could escape the Content-
// Disposition quoting. Belt-and-braces; the registrant's filename was
// already accepted into the DB so it's not freshly-attacker-controlled,
// but we treat it as such on the way out.
func safeFilename(s string) string {
	r := strings.NewReplacer(`"`, "", `\`, "", "\n", "", "\r", "")
	return r.Replace(s)
}

// streamDocBytes serves the bytes at storage_path to the response. The
// path is either an "s3://…" URI (new S3-backed rows) or an absolute
// filesystem path (legacy disk rows) — we discriminate on the s3://
// prefix. Both download handlers (superadmin + client reviewer) route
// through here so the storage transition is invisible to their code.
//
// KYC docs are NOT presigned-redirected the way photos are — an audit
// review pulling PANs and authorization letters should always flow
// through our backend so access is logged, cache-controlled, and
// cannot be re-shared as a bare S3 link that outlives the reviewer's
// session. Photos are lower-risk (already-published faces) and get
// the presign to save bandwidth.
func (s *Server) streamDocBytes(w http.ResponseWriter, r *http.Request, storagePath string) error {
	if strings.HasPrefix(storagePath, "s3://") {
		if s.storage == nil || !s.storage.Enabled() {
			writeErr(w, http.StatusServiceUnavailable,
				"storage disabled — this document lives in s3 but S3_BUCKET is not configured on this deployment")
			return fmt.Errorf("s3 disabled but doc URI is %s", storagePath)
		}
		body, err := s.storage.GetDocBytes(r.Context(), storagePath)
		if err != nil {
			writeErr(w, http.StatusBadGateway,
				"could not read document from storage: "+err.Error())
			return err
		}
		_, err = w.Write(body)
		return err
	}
	f, err := os.Open(storagePath)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "file open")
		return err
	}
	defer f.Close()
	_, err = io.Copy(w, f)
	return err
}

// ----- POST /api/superadmin/applications/{id}/approve -----

type approveReq struct {
	Note string `json:"note"`
}

type approveResp struct {
	ApplicationID int64  `json:"application_id"`
	OrgID         int64  `json:"org_id"`
	AdminUserID   int64  `json:"admin_user_id"`
	AdminUsername string `json:"admin_username"`
	MagicLinkURL  string `json:"magic_link_url"`

	// Shared operator credential, created automatically alongside the
	// admin. Every operator machine at this institution logs in with
	// this same username + password. The admin can view + reset these
	// from their dashboard after first sign-in.
	OperatorUsername string `json:"operator_username"`
	OperatorPassword string `json:"operator_password"`
}

// approveApplication is the only side-effectful endpoint. Everything
// happens in one DB transaction so partial activation is impossible:
// either we have a verified institution + org + admin user + valid
// magic link, or we have nothing changed. The email send happens AFTER
// commit (it's not transactional, but it's idempotent — re-sending the
// same magic link is fine).
func (s *Server) superadminApproveApplication(w http.ResponseWriter, r *http.Request) {
	appID, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil || appID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid id")
		return
	}
	claims := claimsFrom(r)

	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	var req approveReq
	_ = json.NewDecoder(r.Body).Decode(&req) // optional body

	// V15 authorization gates. Order matters so the error message the
	// caller sees names the actual missing precondition.
	mode, clientID, err := s.applicationReviewMode(r.Context(), appID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}

	// (1) If application is single-routed to a 'both' mode client:
	if clientID != nil && mode == "both" {
		if err := s.advanceApplicationToClientQueue(r.Context(), appID, claims.UserID, req.Note); err != nil {
			code, msg := mapReviewErrorToHTTP(err)
			writeErr(w, code, msg)
			return
		}
		s.auditFromRequest(r, "application.advance_to_client", "application", appID, map[string]any{
			"actor":     "superadmin",
			"client_id": *clientID,
		})
		writeJSON(w, http.StatusOK, map[string]any{
			"application_id":   appID,
			"status":           "pending",
			"pending_reviewer": "client",
			"message":          "First-stage approval recorded. Handed off to the client reviewer for final approval.",
		})
		return
	}

	// scope=nil → superadmin sees every application regardless of
	// client_id (both legacy null-scoped rows and client-scoped ones).
	out, err := s.approveApplication(r, appID, claims.UserID, nil, req.Note)
	if err != nil {
		code, msg := mapReviewErrorToHTTP(err)
		writeErr(w, code, msg)
		return
	}

	s.auditFromRequest(r, "application.approve", "application", appID, map[string]any{
		"org_id":           out.OrgID,
		"institution_name": out.InstitutionName,
		"admin_user_id":    out.AdminUserID,
		"actor":            "superadmin",
	})
	writeJSON(w, http.StatusOK, approveResp{
		ApplicationID:    out.ApplicationID,
		OrgID:            out.OrgID,
		AdminUserID:      out.AdminUserID,
		AdminUsername:    out.AdminUsername,
		MagicLinkURL:     out.MagicLinkURL,
		OperatorUsername: out.OperatorUsername,
		OperatorPassword: out.OperatorPassword,
	})
}

// POST /api/superadmin/applications/{id}/route retired 2026-08-27.
// The FE panel that called it was removed 2026-08-25; Rahul's
// multi-client flow now routes via each client reviewer's own inbox
// (unattached KYCs appear in every reviewer queue, each decides for
// their client). If a superadmin-picks-clients flow returns, resurrect
// from git — routeApplicationReq + superadminRouteApplication were the
// entire surface.

// ----- POST /api/superadmin/applications/{id}/resend-admin-link -----
//
// If the superadmin's first-time approval response was lost, this
// re-issues a fresh magic link for the admin that was created at
// approval time. Any previously-issued unused links for the admin are
// invalidated so only the most recent one works. Rejected if the admin
// has already activated.

type resendAdminLinkResp struct {
	ApplicationID int64  `json:"application_id"`
	AdminUserID   int64  `json:"admin_user_id"`
	AdminUsername string `json:"admin_username"`
	MagicLinkURL  string `json:"magic_link_url"`
	EmailDelivery string `json:"email_delivery"`
}

func (s *Server) superadminResendAdminLink(w http.ResponseWriter, r *http.Request) {
	appID, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil || appID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid id")
		return
	}

	// Find the admin user attached to this approved application. The
	// admin is the role='admin' user under the application's org
	// whose magic_links row was issued by the approval — we identify
	// them by joining on the slugified username convention.
	var (
		appStatus       string
		instName        string
		headEmail       string
		headName        string
		orgID           sql.NullInt64
		adminUserID     int64
		adminUsername   string
		adminActivated  sql.NullTime
		adminDisabledAt sql.NullTime
	)
	err = s.deps.DB.QueryRowContext(r.Context(),
		`SELECT a.status, a.institution_name, a.head_email, a.head_name,
		        u.org_id, u.id, u.username, u.activated_at, u.disabled_at
		 FROM institution_applications a
		 JOIN users u
		   ON u.role = 'admin'
		   AND u.username = (
		     -- mirror slugifyUsername(instName) + "_" + appID convention
		     -- via a simple suffix match; in practice the admin user
		     -- created at approval-time is unique under this org.
		     SELECT username FROM users
		     WHERE role = 'admin'
		       AND username LIKE '%_' || a.id
		     ORDER BY id DESC LIMIT 1
		   )
		 WHERE a.id = $1`,
		appID,
	).Scan(&appStatus, &instName, &headEmail, &headName,
		&orgID, &adminUserID, &adminUsername, &adminActivated, &adminDisabledAt)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "application not found or not yet approved")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "lookup: "+err.Error())
		return
	}
	if appStatus != "approved" {
		writeErr(w, http.StatusConflict, "application is "+appStatus+", only approved applications can have a resent link")
		return
	}
	if adminDisabledAt.Valid {
		writeErr(w, http.StatusConflict, "admin account is disabled; enable it before resending a link")
		return
	}
	if adminActivated.Valid {
		writeErr(w, http.StatusConflict, "admin has already activated their account — they should sign in instead")
		return
	}

	// Invalidate any previously-issued unused tokens for this admin
	// so only the most recent link works.
	if _, err := s.deps.DB.ExecContext(r.Context(),
		`UPDATE magic_links SET used_at = CURRENT_TIMESTAMP
		 WHERE user_id = $1 AND used_at IS NULL`, adminUserID,
	); err != nil {
		writeErr(w, http.StatusInternalServerError, "invalidate prior: "+err.Error())
		return
	}
	token, err := s.magicLinks.Generate(r.Context(), adminUserID, magiclink.PurposeSetPassword, 0)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "magic link: "+err.Error())
		return
	}
	linkURL := s.buildMagicLinkURL(r, token)

	delivery := "skipped"
	if s.emailer != nil {
		body := buildApprovalEmail(instName, headName, adminUsername, linkURL, "")
		if err := s.emailer.Send(r.Context(), email.Message{
			To:      headEmail,
			Subject: "Activate your portal admin account",
			Body:    body,
		}); err != nil {
			log.Printf("emailer.Send resend to %s: %v", headEmail, err)
			delivery = "failed"
		} else if _, isConsole := s.emailer.(*email.ConsoleSender); isConsole {
			delivery = "console"
		} else {
			delivery = "sent"
		}
	}

	writeJSON(w, http.StatusOK, resendAdminLinkResp{
		ApplicationID: appID,
		AdminUserID:   adminUserID,
		AdminUsername: adminUsername,
		MagicLinkURL:  linkURL,
		EmailDelivery: delivery,
	})
}

// ----- POST /api/superadmin/applications/{id}/reject -----

type rejectReq struct {
	Note string `json:"note"`
}

func (s *Server) superadminRejectApplication(w http.ResponseWriter, r *http.Request) {
	appID, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil || appID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid id")
		return
	}
	claims := claimsFrom(r)
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	var req rejectReq
	_ = json.NewDecoder(r.Body).Decode(&req)

	// Same V15 gates as approve — superadmin only decides on rows that
	// belong to their queue. Un-routed → route first. Client-only mode
	// → not superadmin's call (only the client reviewer decides).
	mode, clientID, err := s.applicationReviewMode(r.Context(), appID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "application not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	if clientID == nil {
		writeErr(w, http.StatusBadRequest,
			"Route this application to a client first — the decision belongs to that board.")
		return
	}
	if mode == "client" {
		writeErr(w, http.StatusForbidden,
			"This application is routed to a client-only board. Only that client's reviewer can reject it.")
		return
	}

	// scope=nil → superadmin can act on rows for admin/both boards.
	if err := s.rejectApplication(r.Context(), appID, claims.UserID, nil, req.Note); err != nil {
		code, msg := mapReviewErrorToHTTP(err)
		writeErr(w, code, msg)
		return
	}
	s.auditFromRequest(r, "application.reject", "application", appID, map[string]any{
		"actor": "superadmin",
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"application_id": appID,
		"status":         "rejected",
	})
}

// ----- helpers / templates -----

func slugifyUsername(s string) string {
	s = strings.ToLower(s)
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == ' ' || r == '-' || r == '_':
			b.WriteByte('_')
		}
	}
	out := strings.Trim(b.String(), "_")
	if len(out) > 32 {
		out = out[:32]
	}
	if out == "" {
		out = "institution"
	}
	return out
}

// buildMagicLinkURL composes the URL the recipient clicks. Priority
// order, highest first:
//
//  1. PUBLIC_BASE_URL config — explicit, authoritative. Set this in
//     production so emails always point at the user-facing portal,
//     never at the backend's API host (which would 404 the React SPA).
//  2. X-Forwarded-Proto + X-Forwarded-Host — set by ALB/nginx in
//     production deployments that don't pin PUBLIC_BASE_URL.
//  3. Origin request header — present on browser-initiated XHR; honours
//     the page the caller is on, so a dev hitting localhost stays on
//     localhost and a LAN tester on 192.168.x.x stays on the LAN IP.
//  4. r.Host as last resort — fine in dev, dangerous in prod (this is
//     the backend's host, not the frontend's).
func (s *Server) buildMagicLinkURL(r *http.Request, token string) string {
	if base := s.deps.Cfg.PublicBaseURL; base != "" {
		return base + "/register/set-password?token=" + token
	}
	if fwdHost := r.Header.Get("X-Forwarded-Host"); fwdHost != "" {
		scheme := r.Header.Get("X-Forwarded-Proto")
		if scheme == "" {
			scheme = "https"
		}
		return scheme + "://" + fwdHost + "/register/set-password?token=" + token
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		scheme := "http"
		if r.TLS != nil {
			scheme = "https"
		}
		origin = scheme + "://" + r.Host
	}
	return strings.TrimRight(origin, "/") + "/register/set-password?token=" + token
}

func buildApprovalEmail(institutionName, headName, username, link, note string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Dear %s,\n\n", headName)
	fmt.Fprintf(&b, "Your institution \"%s\" has been approved on the Verification Portal.\n\n", institutionName)
	fmt.Fprintf(&b, "Your admin username is: %s\n\n", username)
	fmt.Fprintf(&b, "Set your password using the link below (valid for 7 days):\n\n  %s\n\n", link)
	if strings.TrimSpace(note) != "" {
		fmt.Fprintf(&b, "Reviewer's note: %s\n\n", note)
	}
	b.WriteString("Once you set a password, you can sign in at /admin/login and create verification agent accounts for your centre staff.\n\n")
	b.WriteString("If you didn't apply for an account, please ignore this email.\n")
	return b.String()
}

func buildRejectionEmail(institutionName, headName, note string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Dear %s,\n\n", headName)
	fmt.Fprintf(&b, "Thank you for your interest in registering \"%s\" on the Verification Portal.\n\n", institutionName)
	b.WriteString("Unfortunately we couldn't approve your registration at this time. Reviewer's note:\n\n")
	fmt.Fprintf(&b, "  %s\n\n", note)
	b.WriteString("You can sign in to see this decision. To re-apply you'll need to contact the platform team — the identity you registered with is locked to this outcome.\n")
	return b.String()
}

// buildRegistrationSubmittedEmail is the welcome mail sent right after
// an applicant submits their KYC. It carries the magic link for
// password setup so they can log in and track status while the KYC
// review is pending.
func buildRegistrationSubmittedEmail(institutionName, headName, username, link string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Dear %s,\n\n", headName)
	fmt.Fprintf(&b, "Your registration for \"%s\" has been received on the Verification Portal and is under review.\n\n", institutionName)
	fmt.Fprintf(&b, "Your admin username is: %s\n\n", username)
	fmt.Fprintf(&b, "Set your password using the link below (valid for 7 days):\n\n  %s\n\n", link)
	b.WriteString("Once you set a password, you can sign in and see the review status of your application. Access to agents, exams, and wallet is unlocked when the review is approved.\n\n")
	b.WriteString("You'll get another email as soon as the review lands.\n\n")
	b.WriteString("If you didn't apply for an account, please ignore this email.\n")
	return b.String()
}

// buildKYCApprovedEmail is sent when the review lands as approved.
// No magic link — the applicant already set their password when they
// received the welcome email at submit time.
func buildKYCApprovedEmail(institutionName, headName, username, note string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Dear %s,\n\n", headName)
	fmt.Fprintf(&b, "Your registration for \"%s\" has been approved on the Verification Portal.\n\n", institutionName)
	fmt.Fprintf(&b, "Sign in with your admin username %s and start creating verification agents.\n\n", username)
	if strings.TrimSpace(note) != "" {
		fmt.Fprintf(&b, "Reviewer's note: %s\n\n", note)
	}
	b.WriteString("If you forgot the password you set earlier, use \"Forgot password\" on the sign-in page.\n")
	return b.String()
}
