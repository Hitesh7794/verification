package api

// Superadmin-facing KYC queue endpoints.
//
// The pre-existing /api/reviewer/applications/* endpoints are for
// reviewers whose auth arrives via the DP-proxy (X-Data-Plane-Client-ID
// + X-Data-Plane-Api-Key) — they are ALWAYS scoped to that reviewer's
// client. The superadmin needs a fleet-wide view + the ability to
// approve or reject on behalf, so this file exposes the same operations
// under /api/superadmin/applications/*, authenticated only by the
// platform superadmin's Bearer JWT (no DP-auth headers required).
//
// SQL is intentionally close-to-identical to the reviewer handlers,
// minus the "target_client_id = ?" scope filter. Kept as separate
// handlers rather than a shared helper because the auth model + the
// response envelope both differ; folding them into one function would
// hide the security-relevant branching.
//
// Wired in server.go under the auth group so BasicJWT (superadmin
// context) is required.

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
)

// ── GET /api/superadmin/applications ─────────────────────────────
//
// Params:
//   status  — pending | approved | rejected | draft | (omit=any except draft)
//   q       — case-insensitive substring match against institution_name +
//             head_email + aishe_code + pan
//   limit   — max rows (default 50, cap 500)
//   offset  — pagination offset
//
// Response shape:
//   { items: [...], total: <int> }
// items[]: same superadmin-facing row shape reviewer's list returns.

func (s *Server) superadminApplicationsList(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	limit, offset := parseListParams(r)

	// Build WHERE + args dynamically. status is optional; when omitted
	// we exclude 'draft' (drafts are half-filled wizard state, not
	// something a superadmin should be reviewing).
	//
	// Routing rule (mirrors DP V15 flow):
	//   status='pending' — superadmin only sees rows where pending_reviewer='admin'.
	//                       Rows waiting on client reviewer stay out of the
	//                       superadmin's decision queue.
	//   status='approved' / 'rejected' / (all)  — superadmin sees everything
	//                       for oversight. Whether they can act on it is a
	//                       separate FE gate driven by the client's mode.
	where := []string{}
	args := []any{}
	if status != "" {
		switch status {
		case "pending", "approved", "rejected", "draft":
			// ok
		default:
			writeErr(w, http.StatusBadRequest, "bad status filter")
			return
		}
		where = append(where, fmt.Sprintf("status = $%d", len(args)+1))
		args = append(args, status)
		if status == "pending" {
			where = append(where, "pending_reviewer = 'admin'")
		}
	} else {
		where = append(where, "status <> 'draft'")
	}
	if q != "" {
		like := "%" + strings.ToLower(q) + "%"
		where = append(where, fmt.Sprintf(
			"(LOWER(institution_name) LIKE $%d OR LOWER(head_email) LIKE $%d OR LOWER(COALESCE(aishe_code,'')) LIKE $%d OR LOWER(COALESCE(pan,'')) LIKE $%d)",
			len(args)+1, len(args)+1, len(args)+1, len(args)+1,
		))
		args = append(args, like)
	}
	whereSQL := "WHERE " + strings.Join(where, " AND ")

	// Total count first (cheap, uses status index).
	var total int
	countSQL := "SELECT COUNT(*) FROM institution_applications " + whereSQL
	if err := s.deps.DB.QueryRowContext(r.Context(), countSQL, args...).Scan(&total); err != nil {
		writeErr(w, http.StatusInternalServerError, "count: "+err.Error())
		return
	}

	// Then the page. Note: `LIMIT $N OFFSET $N+1` — args are appended AFTER
	// the WHERE args.
	pageArgs := append([]any{}, args...)
	pageArgs = append(pageArgs, limit, offset)
	// doc_count is a correlated subquery rather than a JOIN so the row
	// count is unaffected, and the table is named in full because
	// whereSQL is built with unaliased column names.
	//
	// This list reuses reviewerListItem, whose DocCount the reviewer's
	// own list populates -- but this query never selected it, so the
	// field marshalled as its zero value and the superadmin table
	// reported "0 documents" on every application regardless of how
	// many the institute had actually uploaded.
	pageSQL := `
		SELECT id, status, institution_name, institution_type,
		       city, state, head_name, head_email, head_mobile,
		       COALESCE(aishe_code, ''), created_at,
		       (SELECT COUNT(*) FROM institution_application_documents d
		         WHERE d.application_id = institution_applications.id) AS doc_count
		  FROM institution_applications ` + whereSQL + `
		 ORDER BY created_at DESC
		 LIMIT $` + strconv.Itoa(len(args)+1) + ` OFFSET $` + strconv.Itoa(len(args)+2)

	rows, err := s.deps.DB.QueryContext(r.Context(), pageSQL, pageArgs...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "list: "+err.Error())
		return
	}
	defer rows.Close()

	items := []reviewerListItem{}
	for rows.Next() {
		var it reviewerListItem
		var createdAt time.Time
		if err := rows.Scan(&it.ID, &it.Status, &it.InstitutionName, &it.InstitutionType,
			&it.City, &it.State, &it.HeadName, &it.HeadEmail, &it.HeadMobile,
			&it.AisheCode, &createdAt, &it.DocCount); err != nil {
			writeErr(w, http.StatusInternalServerError, "scan: "+err.Error())
			return
		}
		it.CreatedAt = createdAt.UTC().Format(time.RFC3339)
		items = append(items, it)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items": items,
		"total": total,
	})
}

// parseListParams pulls limit + offset from the query string with sane
// defaults + caps. Kept small; if we grow more list endpoints we can
// promote to a shared helper.
func parseListParams(r *http.Request) (int, int) {
	limit := 50
	offset := 0
	if v := strings.TrimSpace(r.URL.Query().Get("limit")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			if n > 500 {
				n = 500
			}
			limit = n
		}
	}
	if v := strings.TrimSpace(r.URL.Query().Get("offset")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			offset = n
		}
	}
	return limit, offset
}

// ── GET /api/superadmin/applications/{id} ────────────────────────
//
// Same detail shape as cpReviewerGet, but with the target_client_id
// scope filter dropped so superadmin sees any application. Also
// includes the target_client_id in the response so the UI can render
// "assigned to <client name>".

func (s *Server) superadminApplicationGet(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	var (
		status, instName, instType, addr1, city, state, pin string
		headName, headDesig, headEmail, headMobile          string
		aishe, panN, affil, addr2, district                 sql.NullString
		yrEst, approxStudents, targetClientID, dpClientID   sql.NullInt64
		note                                                sql.NullString
		reviewedAt                                          sql.NullTime
		createdAt                                           time.Time
	)
	err = s.deps.DB.QueryRowContext(r.Context(), `
		SELECT status, institution_name, institution_type,
		       aishe_code, pan, year_established, affiliation_body,
		       approx_student_count,
		       address_line1, address_line2, city, district, state, pin_code,
		       head_name, head_designation, head_email, head_mobile,
		       review_note, reviewed_at, created_at,
		       target_client_id, dp_client_id
		  FROM institution_applications
		 WHERE id = $1`, id,
	).Scan(&status, &instName, &instType,
		&aishe, &panN, &yrEst, &affil,
		&approxStudents,
		&addr1, &addr2, &city, &district, &state, &pin,
		&headName, &headDesig, &headEmail, &headMobile,
		&note, &reviewedAt, &createdAt,
		&targetClientID, &dpClientID)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "application not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}

	// Docs: return the mirror rows so the UI can render download
	// buttons. Both `id` and `doc_id` on each row so the FE's
	// `d.doc_id` lookup works (Rahul's UI convention).
	docsRows, err := s.deps.DB.QueryContext(r.Context(), `
		SELECT id, doc_kind, original_name, storage_path, mime, size_bytes, sha256, created_at
		  FROM institution_application_documents
		 WHERE application_id = $1
		 ORDER BY id`, id)
	docs := []map[string]any{}
	if err == nil {
		defer docsRows.Close()
		for docsRows.Next() {
			var (
				dID       int64
				dKind, dName, dPath, dMime, dSha string
				dSize     int64
				dCreated  time.Time
			)
			if err := docsRows.Scan(&dID, &dKind, &dName, &dPath, &dMime, &dSize, &dSha, &dCreated); err != nil {
				continue
			}
			docs = append(docs, map[string]any{
				"id":            dID,
				"doc_id":        dID, // alias — Rahul's FE reads d.doc_id
				"doc_kind":      dKind,
				"original_name": dName,
				"storage_path":  dPath,
				"mime":          dMime,
				"size_bytes":    dSize,
				"sha256":        dSha,
				"created_at":    dCreated.UTC().Format(time.RFC3339),
				"download_url":  fmt.Sprintf("/api/superadmin/applications/%d/docs/%d/download", id, dID),
			})
		}
	}

	// Enrich with the target client's name + kyc_review_mode so the FE
	// can render "Assigned to <client>" without a second lookup. Best-
	// effort — if the join fails, leave empty strings and let the FE
	// render the raw id.
	var clientName, clientKycMode string
	if targetClientID.Valid {
		_ = s.deps.DB.QueryRowContext(r.Context(),
			`SELECT name, kyc_review_mode FROM clients_registry WHERE id = $1`,
			targetClientID.Int64,
		).Scan(&clientName, &clientKycMode)
	}

	// Load pending_reviewer so the FE can drive its "can_act" gate.
	// Superadmin can act only when this row is in their queue OR the
	// row is already terminal (approved/rejected — no action available).
	var pendingReviewer sql.NullString
	_ = s.deps.DB.QueryRowContext(r.Context(),
		`SELECT pending_reviewer FROM institution_applications WHERE id = $1`, id,
	).Scan(&pendingReviewer)
	canAct := status == "pending" && (!pendingReviewer.Valid || pendingReviewer.String == "admin")

	// Docs visibility gate (mirrors DP V15 rule): if the target
	// client is 'client'-only mode, superadmin sees the row for
	// oversight but the doc bytes are sealed. Strip docs from the
	// response so nothing leaks + so the FE's document panel renders
	// "sealed" instead of a broken list.
	if clientKycMode == "client" {
		docs = []map[string]any{}
	}

	// Assemble address_line for the FE — some pages concatenate
	// address_line1 + address_line2. Also keep the split fields so
	// anything that reads them individually still works.
	addressLine := addr1
	if addr2.Valid && strings.TrimSpace(addr2.String) != "" {
		addressLine = addr1 + ", " + addr2.String
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"id":                       id,
		"status":                   status,
		"institution_name":         instName,
		"institution_type":         instType,
		"aishe_code":               aishe.String,
		"pan":                      panN.String,
		"year_established":         yrEst.Int64,
		"affiliation_body":         affil.String,
		"approx_student_count":     approxStudents.Int64,
		"address_line":             addressLine, // FE reads this combined form
		"address_line1":            addr1,
		"address_line2":            addr2.String,
		"city":                     city,
		"district":                 district.String,
		"state":                    state,
		"pin_code":                 pin,
		"head_name":                headName,
		"head_designation":         headDesig,
		"head_email":               headEmail,
		"head_mobile":              headMobile,
		"review_note":              note.String,
		"reviewed_at":              nullTimeToString(reviewedAt),
		"created_at":               createdAt.UTC().Format(time.RFC3339),
		"target_client_id":         nullInt64OrZero(targetClientID),
		"dp_client_id":             nullInt64OrZero(dpClientID),
		"client_id":                nullInt64OrZero(targetClientID), // FE alias
		"client_name":              clientName,
		"client_kyc_review_mode":   clientKycMode,
		"pending_reviewer":         nullStrOrEmpty(pendingReviewer),
		"can_act":                  canAct, // FE reads this to hide approve/reject
		"docs":                     docs,   // FE reads app.docs
		"documents":                docs,   // keep both for callers using the new name
	})
}

func nullStrOrEmpty(n sql.NullString) string {
	if n.Valid {
		return n.String
	}
	return ""
}

func nullInt64OrZero(n sql.NullInt64) int64 {
	if n.Valid {
		return n.Int64
	}
	return 0
}

// ── POST /api/superadmin/applications/{id}/approve ───────────────
//
// Superadmin approval. Same semantics as the reviewer path: flip
// status to 'approved', then fire /internal/orgs/create on the target
// Data Plane. Difference: no client_id scope filter (superadmin can
// approve any client's KYC); target_client_id is read from the row
// itself.

func (s *Server) superadminApplicationApprove(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	var req reviewerDecisionReq
	_ = json.NewDecoder(r.Body).Decode(&req)

	tx, err := s.deps.DB.BeginTx(r.Context(), nil)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db begin: "+err.Error())
		return
	}
	defer tx.Rollback()

	var (
		status, instName, headName, headDesignation, headEmail string
		aishe                                                   sql.NullString
		targetClientID, dpClientID, externalAppID               sql.NullInt64
		pendingReviewer                                         sql.NullString
	)
	err = tx.QueryRowContext(r.Context(), `
		SELECT status, institution_name, head_name, head_designation,
		       head_email, aishe_code, target_client_id, dp_client_id,
		       pending_reviewer, external_application_id
		  FROM institution_applications
		 WHERE id = $1
		 FOR UPDATE`, id,
	).Scan(&status, &instName, &headName, &headDesignation, &headEmail, &aishe, &targetClientID, &dpClientID, &pendingReviewer, &externalAppID)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "application not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	if status != "pending" {
		writeErr(w, http.StatusConflict, "application is "+status+", cannot approve")
		return
	}
	if !targetClientID.Valid {
		writeErr(w, http.StatusPreconditionFailed,
			"application has no target_client_id — assign a Data Plane first before approving")
		return
	}
	// Superadmin can only act when the row is in their queue.
	if pendingReviewer.Valid && pendingReviewer.String != "admin" {
		writeErr(w, http.StatusForbidden,
			"this application is in the client reviewer's queue — superadmin has no decision authority")
		return
	}

	// Look up the target client's kyc_review_mode to decide whether
	// this superadmin approve is TERMINAL or a HAND-OFF to the client.
	var clientMode string
	_ = tx.QueryRowContext(r.Context(),
		`SELECT kyc_review_mode FROM clients_registry WHERE id = $1`,
		targetClientID.Int64,
	).Scan(&clientMode)

	note := strings.TrimSpace(req.Note)

	if clientMode == "both" {
		// Hand off to client reviewer — status stays 'pending', flip
		// pending_reviewer to 'client'. No provisioning yet — the
		// client's final approve is what fires /orgs/create.
		if _, err := tx.ExecContext(r.Context(), `
			UPDATE institution_applications
			   SET pending_reviewer = 'client',
			       review_note = $2,
			       updated_at  = NOW()
			 WHERE id = $1`, id, nullableStr(note),
		); err != nil {
			writeErr(w, http.StatusInternalServerError, "handoff: "+err.Error())
			return
		}
		if err := tx.Commit(); err != nil {
			writeErr(w, http.StatusInternalServerError, "commit: "+err.Error())
			return
		}
		// Fire the reviewer notification AFTER the commit succeeds so
		// a rolled-back handoff never triggers a spurious email. The
		// call is best-effort — failure is logged but does not fail the
		// approve response (the row IS in the reviewer's queue either
		// way; the email is a convenience). Runs in a background
		// goroutine so a slow DP round-trip doesn't hold the operator.
		//
		// IMPORTANT: `fireInternalReviewersNotify`'s FIRST argument is
		// used TWICE — once to pick the CP registry row (api_url/api_key)
		// AND once as the `client_id` sent in the DP payload. The DP
		// looks up reviewers by its own local `users.client_id`, which
		// equals the DP-native id (`dp_client_id`), NOT the CP registry
		// id. Passing the registry id here silently missed every
		// reviewer (bug: superadmin approve fired the goroutine but
		// zero emails were sent). We now pass dp_client_id so the DP
		// finds the right reviewer rows — see helper for the split.
		go func(registryID, dpClientID int64, name, head string) {
			if err := s.fireInternalReviewersNotifyForClient(context.Background(), registryID, dpClientID, name, head); err != nil {
				log.Printf("superadminApplicationApprove: reviewer notify (registry=%d dp=%d) failed: %v", registryID, dpClientID, err)
			}
		}(targetClientID.Int64, dpClientID.Int64, instName, headName)
		writeJSON(w, http.StatusOK, map[string]any{
			"application_id":    id,
			"status":            "pending",
			"pending_reviewer":  "client",
			"message":           "handed off to client reviewer for final decision",
		})
		return
	}

	// Terminal approve (mode='admin' or unknown). Flip status + clear
	// pending_reviewer + provision.
	if _, err := tx.ExecContext(r.Context(), `
		UPDATE institution_applications
		   SET status = 'approved',
		       pending_reviewer = NULL,
		       decided_by_desk = 'admin',
		       reviewed_at = NOW(),
		       review_note = $2,
		       updated_at  = NOW()
		 WHERE id = $1`, id, nullableStr(note),
	); err != nil {
		writeErr(w, http.StatusInternalServerError, "update: "+err.Error())
		return
	}
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "commit: "+err.Error())
		return
	}

	resp := approveResp{ApplicationID: id, Status: "approved"}
	fanoutClient := int64(0)
	if dpClientID.Valid {
		fanoutClient = dpClientID.Int64
	}
	provResp, provErr := s.fireInternalOrgsCreate(r.Context(), targetClientID.Int64, internalOrgsCreatePayload{
		ExternalApplicationID: id,
		DpApplicationID:       externalAppID.Int64,
		InstitutionName:       instName,
		HeadName:              headName,
		HeadDesignation:       headDesignation,
		HeadEmail:             headEmail,
		AisheCode:             aishe.String,
		SendWelcomeEmail:      true,
		ClientID:              fanoutClient,
		MarkApproved:          true, // superadmin just approved — flip DP row
	})
	if provErr != nil {
		resp.ProvisioningError = provErr.Error()
		log.Printf("cp superadmin approve app=%d: provisioning fan-out failed: %v", id, provErr)
	} else if provResp != nil {
		resp.OrgID = provResp.OrgID
		resp.AdminUsername = provResp.AdminUsername
		resp.MagicLinkURL = provResp.MagicLinkURL
	}

	// Applicant-facing "your KYC was approved" email. Fire only on
	// terminal decisions — this branch is mode='admin' or unknown, so
	// this IS the final answer. The 'both'-mode branch above is a
	// hand-off (not terminal) and deliberately doesn't call this.
	go func(registryID int64, hEmail, hName, iName, n string) {
		if err := s.fireInternalKYCDecisionNotify(context.Background(), registryID, hEmail, hName, iName, "approved", n); err != nil {
			log.Printf("superadminApplicationApprove: KYC decision notify (app=%d) failed: %v", id, err)
		}
	}(targetClientID.Int64, headEmail, headName, instName, note)

	writeJSON(w, http.StatusOK, resp)
}

// ── POST /api/superadmin/applications/{id}/reject ────────────────
//
// Straight UPDATE with a required note. No fan-out.

func (s *Server) superadminApplicationReject(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	var req reviewerDecisionReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	note := strings.TrimSpace(req.Note)
	if note == "" {
		writeErr(w, http.StatusBadRequest, "a rejection note is required — it goes to the applicant")
		return
	}

	// Read routing hints in the same statement that flips the row so
	// we can fire the /internal/applications/reject mirror on the
	// target Data Plane after commit. UPDATE … RETURNING gives us the
	// pre-flip target_client_id + external_application_id (the DP-side
	// row id) atomically; if the row wasn't in a rejectable state, we
	// get zero rows and 409 like before.
	var (
		targetClientID        sql.NullInt64
		externalAppID         sql.NullInt64
		headEmail, headName   string
		instName              string
	)
	err = s.deps.DB.QueryRowContext(r.Context(), `
		UPDATE institution_applications
		   SET status           = 'rejected',
		       pending_reviewer = NULL,
		       decided_by_desk  = 'admin',
		       review_note      = $2,
		       reviewed_at      = NOW(),
		       updated_at       = NOW()
		 WHERE id = $1 AND status = 'pending'
		 RETURNING target_client_id, external_application_id,
		           head_email, head_name, institution_name`,
		id, note,
	).Scan(&targetClientID, &externalAppID, &headEmail, &headName, &instName)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusConflict, "application not found or not pending")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "update: "+err.Error())
		return
	}

	// Mirror the reject to the target DP so its
	// institution_applications row moves out of 'pending' and the
	// client reviewer's inbox tiles count correctly. Best-effort:
	// log on failure, but the CP decision itself is not rolled back.
	// Skip cleanly if the row was never assigned to a DP.
	resp := map[string]any{
		"application_id": id,
		"status":         "rejected",
	}
	if targetClientID.Valid && externalAppID.Valid && externalAppID.Int64 > 0 {
		if _, ferr := s.fireInternalApplicationsReject(r.Context(), targetClientID.Int64, internalApplicationsRejectPayload{
			DpApplicationID: externalAppID.Int64,
			ReviewNote:      note,
		}); ferr != nil {
			log.Printf("cp superadmin reject app=%d: DP mirror failed: %v", id, ferr)
			resp["mirror_error"] = ferr.Error()
		}
	}
	// Applicant-facing "your KYC was rejected" email. Terminal path;
	// safe to fire unconditionally after the UPDATE succeeded. Skipped
	// only when the row was never assigned to a DP (no registry to
	// route the email through).
	if targetClientID.Valid && headEmail != "" {
		go func(registryID int64, hEmail, hName, iName, n string) {
			if err := s.fireInternalKYCDecisionNotify(context.Background(), registryID, hEmail, hName, iName, "rejected", n); err != nil {
				log.Printf("superadminApplicationReject: KYC decision notify (app=%d) failed: %v", id, err)
			}
		}(targetClientID.Int64, headEmail, headName, instName, note)
	}
	writeJSON(w, http.StatusOK, resp)
}

// ── POST /api/superadmin/applications/{id}/revoke ────────────────
//
// Superadmin revoke. Flips status from 'rejected' back to 'pending'.
// Recalculates pending_reviewer based on client's kyc_review_mode
// (if mode == 'client', pending_reviewer is 'client', else 'admin').
// Mirrors back to target Data Plane.

func (s *Server) superadminApplicationRevoke(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	var req reviewerDecisionReq
	_ = json.NewDecoder(r.Body).Decode(&req)
	note := strings.TrimSpace(req.Note)

	tx, err := s.deps.DB.BeginTx(r.Context(), nil)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db begin: "+err.Error())
		return
	}
	defer tx.Rollback()

	var (
		status                                    string
		targetClientID, dpClientID, externalAppID sql.NullInt64
	)
	err = tx.QueryRowContext(r.Context(), `
		SELECT status, target_client_id, dp_client_id, external_application_id
		  FROM institution_applications
		 WHERE id = $1
		 FOR UPDATE`, id,
	).Scan(&status, &targetClientID, &dpClientID, &externalAppID)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "application not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	if status != "rejected" {
		writeErr(w, http.StatusConflict, "application is "+status+", can only revoke rejected applications")
		return
	}

	pendingReviewer := "admin"
	if targetClientID.Valid {
		var clientMode string
		_ = tx.QueryRowContext(r.Context(),
			`SELECT kyc_review_mode FROM clients_registry WHERE id = $1`,
			targetClientID.Int64,
		).Scan(&clientMode)
		if clientMode == "client" {
			pendingReviewer = "client"
		}
	}

	if _, err := tx.ExecContext(r.Context(), `
		UPDATE institution_applications
		   SET status           = 'pending',
		       pending_reviewer = $2,
		       decided_by_desk  = NULL,
		       review_note      = $3,
		       reviewed_at      = NULL,
		       updated_at       = NOW()
		 WHERE id = $1`,
		id, pendingReviewer, nullableStr(note),
	); err != nil {
		writeErr(w, http.StatusInternalServerError, "update: "+err.Error())
		return
	}
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "commit: "+err.Error())
		return
	}

	resp := map[string]any{
		"application_id":   id,
		"status":           "pending",
		"pending_reviewer": pendingReviewer,
	}

	if targetClientID.Valid && externalAppID.Valid && externalAppID.Int64 > 0 {
		if _, ferr := s.fireInternalApplicationsRevoke(r.Context(), targetClientID.Int64, internalApplicationsRevokePayload{
			DpApplicationID: externalAppID.Int64,
			ReviewNote:      note,
		}); ferr != nil {
			log.Printf("cp superadmin revoke app=%d: DP mirror failed: %v", id, ferr)
			resp["mirror_error"] = ferr.Error()
		}
	}

	writeJSON(w, http.StatusOK, resp)
}

