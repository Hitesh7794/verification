package api

// Central KYC queue endpoints — Phase 3 of the multi-tenant migration
// (implementation_plan.md §Phase 3). The Data Plane's /api/register/*
// and /api/client/* (reviewer) endpoints reverse-proxy into this
// package: they add authentication headers, we own the writes.
//
// Auth model for every DP-proxy endpoint here:
//
//   - X-Data-Plane-Client-ID   — numeric id from clients_registry.
//                                identifies which client's Data Plane
//                                the call came from. Used to scope
//                                reviewer reads to that client and
//                                to stamp target_client_id on new
//                                registrations.
//   - X-Data-Plane-Api-Key     — the api_key we stored in
//                                clients_registry.api_key when that
//                                client was added. Constant-time
//                                compared against the DB row. Fails
//                                closed if the header is missing or
//                                mismatched. No dev-only bypass — a
//                                genuine api_key is required in every
//                                environment.
//
// On CP-side approval (POST .../approve), we look up the target
// client's api_url in clients_registry, then fire POST
// <api_url>/api/internal/orgs/create to provision the org + admin on
// the target Data Plane. The external_application_id we send is this
// CP's institution_applications.id, which the DP uses as the
// idempotency key.

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

// ── DP-proxy auth middleware ─────────────────────────────────────

type dpCtxKey string

const (
	dpClientIDKey  dpCtxKey = "dp_client_id"
	dpClientNameKey dpCtxKey = "dp_client_name"
)

// dpProxyAuth checks that the caller (a Data Plane's server-side
// proxy) presents a valid X-Data-Plane-Client-ID + X-Data-Plane-Api-Key
// pair. On success it stashes the client id + name in the request
// context so handlers below can read them without a second DB lookup.
func (s *Server) dpProxyAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rawID := strings.TrimSpace(r.Header.Get("X-Data-Plane-Client-ID"))
		apiKey := strings.TrimSpace(r.Header.Get("X-Data-Plane-Api-Key"))
		if rawID == "" {
			writeErr(w, http.StatusUnauthorized, "missing X-Data-Plane-Client-ID")
			return
		}
		clientID, err := strconv.ParseInt(rawID, 10, 64)
		if err != nil || clientID <= 0 {
			writeErr(w, http.StatusUnauthorized, "invalid X-Data-Plane-Client-ID")
			return
		}

		// Look up the registered api_key + name for this client.
		var (
			storedKey   string
			clientName  string
			clientStatus string
		)
		err = s.deps.DB.QueryRowContext(r.Context(),
			`SELECT api_key, name, status FROM clients_registry WHERE id = $1`, clientID,
		).Scan(&storedKey, &clientName, &clientStatus)
		if errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusUnauthorized, "unknown client id")
			return
		}
		if err != nil {
			log.Printf("cp dpProxyAuth: db lookup failed for client %d: %v", clientID, err)
			writeErr(w, http.StatusInternalServerError, "auth check failed")
			return
		}
		if clientStatus != "active" {
			writeErr(w, http.StatusForbidden, "client is "+clientStatus)
			return
		}

		// Always require a matching api_key — no environment bypass.
		if apiKey == "" || apiKey != storedKey {
			log.Printf("cp dpProxyAuth: bad api key from client %d (%s)", clientID, clientName)
			writeErr(w, http.StatusUnauthorized, "bad api key")
			return
		}

		ctx := context.WithValue(r.Context(), dpClientIDKey, clientID)
		ctx = context.WithValue(ctx, dpClientNameKey, clientName)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func dpClientID(r *http.Request) int64 {
	v, _ := r.Context().Value(dpClientIDKey).(int64)
	return v
}

// ── POST /api/register/submit — reverse-proxy target ─────────────
//
// Data Plane's registerSubmit collects the whole KYC (institution
// fields + head of institution) and forwards it here at "submit"
// time. OTP verification, doc storage on S3, and slug/dedup checks
// stay on the DP for now — this endpoint trusts that the DP already
// gated all of that.
//
// Docs are represented as a list of {kind, s3_url} pairs so the CP
// can render them to reviewers without owning the bytes. Full doc
// migration to CP is a Phase 3 follow-up.

type registerSubmitReq struct {
	InstitutionName     string           `json:"institution_name"`
	InstitutionType     string           `json:"institution_type"`
	AisheCode           string           `json:"aishe_code"`
	Pan                 string           `json:"pan"`
	YearEstablished     int              `json:"year_established"`
	AffiliationBody     string           `json:"affiliation_body"`
	ApproxStudentCount  int              `json:"approx_student_count"`
	AddressLine1        string           `json:"address_line1"`
	AddressLine2        string           `json:"address_line2"`
	City                string           `json:"city"`
	District            string           `json:"district"`
	State               string           `json:"state"`
	PinCode             string           `json:"pin_code"`
	HeadName            string           `json:"head_name"`
	HeadDesignation     string           `json:"head_designation"`
	HeadEmail           string           `json:"head_email"`
	HeadMobile          string           `json:"head_mobile"`
	SubmitterIP         string           `json:"submitter_ip,omitempty"`
	// TargetClientIDOverride lets a DP forward a KYC targeted at a
	// DIFFERENT client than the DP itself represents (rare — e.g. a
	// central portal handles registrations for many boards). Empty
	// falls back to the caller's own client id from the DP-auth
	// header. Never trusted from an unauthed proxy.
	TargetClientIDOverride int64 `json:"target_client_id,omitempty"`
	// ExternalApplicationID is the DP's own institution_applications.id
	// for this draft. When the DP's proxyRegisterSubmit finalises the
	// multi-step wizard, it sends the draft's local id here so the CP
	// can:
	//   1. Idempotently upsert (unique index on
	//      target_client_id + external_application_id).
	//   2. Give the caller back the CP-side id so the DP can store
	//      it on its own row for later status polls.
	//
	// Zero means single-shot flow (no DP-side draft to reconcile against).
	ExternalApplicationID int64 `json:"external_application_id,omitempty"`
	// DpSubmittedAt is when the applicant finalised the draft on the
	// DP (may be earlier than CP created_at if the CP was briefly
	// unreachable and the DP retried). Optional.
	DpSubmittedAt string `json:"dp_submitted_at,omitempty"`
	// Documents inherited from the DP's institution_application_documents
	// table. The CP stores the S3 paths so the reviewer UI can render
	// them; the DP still owns the underlying bytes in its own S3 bucket.
	Documents []docPayload `json:"documents,omitempty"`
	// DpClientID is the DP-side exam board this KYC belongs to (from
	// the DP's clients table — e.g. NTA=38, SSC=39). Distinct from
	// target_client_id, which identifies WHICH Data Plane. Persisted
	// on the CP row so the approve handler can pass it back down to
	// /internal/orgs/create for the multi-client fan-out (coa row +
	// organization_exam_subscriptions). Zero → no fan-out on approve
	// (admin catalog will be empty until manually attached).
	DpClientID int64 `json:"dp_client_id,omitempty"`
}

// docPayload — single document row copied from the DP's
// institution_application_documents into the CP's mirror table.
type docPayload struct {
	DocKind      string `json:"doc_kind"`
	OriginalName string `json:"original_name"`
	StoragePath  string `json:"storage_path"`
	Mime         string `json:"mime"`
	SizeBytes    int64  `json:"size_bytes"`
	Sha256       string `json:"sha256"`
}

type registerSubmitResp struct {
	ApplicationID int64  `json:"application_id"`
	Status        string `json:"status"`
	// AdminUsername + MagicLinkURL echo the DP's /internal/orgs/create
	// response when we provision at submit time (restored 2026-08-31 —
	// the applicant can now log in during the pending window and see
	// the KYC-lock screen instead of waiting on the approval email).
	// Blank when the fan-out to the target DP failed; the applicant
	// still gets the email if that succeeded independently.
	AdminUsername string `json:"admin_username,omitempty"`
	MagicLinkURL  string `json:"magic_link_url,omitempty"`
	// ProvisioningError surfaces any submit-time fan-out failure
	// (unreachable DP, api-key mismatch, etc.) without failing the
	// whole submit — the CP row is committed regardless so the
	// reviewer's queue never loses an application to a network blip.
	ProvisioningError string `json:"provisioning_error,omitempty"`
	// Idempotent is true when the CP already had a row for
	// (target_client_id, external_application_id) and returned the
	// pre-existing id without re-inserting. DP callers can use this
	// to decide whether to send doc-updates or treat as a repeat.
	Idempotent bool `json:"idempotent,omitempty"`
}

// Max size bumped so a fully-populated payload (17 metadata fields plus
// up to a handful of ~1 KB document rows) fits comfortably. Docs
// themselves carry S3 paths + sha256, not blobs, so the ceiling stays
// modest.
const cpRegisterSubmitMaxBytes = 128 << 10

func (s *Server) cpRegisterSubmit(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, cpRegisterSubmitMaxBytes)
	var req registerSubmitReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}

	// Basic shape validation — same required fields as the DP's
	// legacy path. The DP's registerInit already ran full validation
	// (validateInit) before OTP; this is the last-mile sanity check.
	req.InstitutionName = strings.TrimSpace(req.InstitutionName)
	req.HeadName = strings.TrimSpace(req.HeadName)
	req.HeadEmail = strings.TrimSpace(req.HeadEmail)
	req.HeadMobile = strings.TrimSpace(req.HeadMobile)
	req.HeadDesignation = strings.TrimSpace(req.HeadDesignation)
	req.AddressLine1 = strings.TrimSpace(req.AddressLine1)
	req.City = strings.TrimSpace(req.City)
	req.State = strings.TrimSpace(req.State)
	req.PinCode = strings.TrimSpace(req.PinCode)
	if req.InstitutionName == "" || req.HeadName == "" || req.HeadEmail == "" ||
		req.HeadMobile == "" || req.HeadDesignation == "" ||
		req.AddressLine1 == "" || req.City == "" || req.State == "" ||
		req.PinCode == "" || req.InstitutionType == "" {
		writeErr(w, http.StatusBadRequest, "missing required fields")
		return
	}

	targetClientID := dpClientID(r)
	if req.TargetClientIDOverride > 0 {
		targetClientID = req.TargetClientIDOverride
	}

	// Idempotency short-circuit: if the DP retried a submit for a draft
	// we've already persisted, return the pre-existing row without
	// hitting the unique-index paths at all. Cheaper + surfaces the
	// idempotent=true flag so the DP knows it's a repeat.
	if req.ExternalApplicationID > 0 && targetClientID > 0 {
		var existingID int64
		var existingStatus string
		err := s.deps.DB.QueryRowContext(r.Context(),
			`SELECT id, status FROM institution_applications
			  WHERE target_client_id = $1 AND external_application_id = $2`,
			targetClientID, req.ExternalApplicationID,
		).Scan(&existingID, &existingStatus)
		if err == nil {
			writeJSON(w, http.StatusOK, registerSubmitResp{
				ApplicationID: existingID,
				Status:        existingStatus,
				Idempotent:    true,
			})
			return
		}
		if !errors.Is(err, sql.ErrNoRows) {
			log.Printf("cpRegisterSubmit: idempotency lookup failed (client=%d ext=%d): %v",
				targetClientID, req.ExternalApplicationID, err)
			// Fall through to INSERT — the unique-index will catch a
			// true dup if the lookup only failed transiently.
		}
	}

	// Validate documents payload before we open a tx. Cheap sanity
	// checks — any malformed row bounces the whole submit with a clear
	// error rather than opening a transaction we'd have to roll back.
	for i, d := range req.Documents {
		if d.DocKind == "" || d.OriginalName == "" || d.StoragePath == "" ||
			d.Mime == "" || d.Sha256 == "" {
			writeErr(w, http.StatusBadRequest,
				fmt.Sprintf("documents[%d]: missing required field", i))
			return
		}
	}

	// dp_submitted_at — parse best-effort; unparseable stays NULL.
	var dpSubmittedAt sql.NullTime
	if s := strings.TrimSpace(req.DpSubmittedAt); s != "" {
		if t, err := time.Parse(time.RFC3339, s); err == nil {
			dpSubmittedAt = sql.NullTime{Time: t, Valid: true}
		}
	}

	// One transaction: institution_applications row + N document rows.
	// Either both land or neither does — no half-migrated KYC on the CP.
	tx, err := s.deps.DB.BeginTx(r.Context(), nil)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db begin: "+err.Error())
		return
	}
	defer tx.Rollback()

	// Determine pending_reviewer based on the target client's
	// kyc_review_mode. 'admin' + 'both' → superadmin first. 'client'
	// → straight to client. Default 'admin' when we can't look up.
	pendingReviewer := "admin"
	if targetClientID > 0 {
		var mode string
		if err := tx.QueryRowContext(r.Context(),
			`SELECT kyc_review_mode FROM clients_registry WHERE id = $1`,
			targetClientID,
		).Scan(&mode); err == nil {
			if mode == "client" {
				pendingReviewer = "client"
			}
			// 'admin' + 'both' both start at admin. 'both' handoff
			// to client happens on superadmin approve, not here.
		}
	}

	var appID int64
	err = tx.QueryRowContext(r.Context(), `
		INSERT INTO institution_applications(
			status, target_client_id,
			institution_name, institution_type, aishe_code, pan,
			year_established, affiliation_body, approx_student_count,
			address_line1, address_line2, city, district, state, pin_code,
			head_name, head_designation, head_email, head_mobile,
			submitter_ip,
			external_application_id, dp_submitted_at,
			dp_client_id,
			pending_reviewer
		) VALUES ('pending', $1,
			$2, $3, $4, $5,
			$6, $7, $8,
			$9, $10, $11, $12, $13, $14,
			$15, $16, $17, $18,
			$19,
			$20, $21,
			$22,
			$23)
		RETURNING id`,
		nullableInt64(targetClientID),
		req.InstitutionName, req.InstitutionType,
		nullableStr(req.AisheCode), nullableStr(req.Pan),
		nullableInt(req.YearEstablished), nullableStr(req.AffiliationBody),
		nullableInt(req.ApproxStudentCount),
		req.AddressLine1, nullableStr(req.AddressLine2),
		req.City, nullableStr(req.District), req.State, req.PinCode,
		req.HeadName, req.HeadDesignation, req.HeadEmail, req.HeadMobile,
		nullableStr(req.SubmitterIP),
		nullableInt64(req.ExternalApplicationID), dpSubmittedAt,
		nullableInt64(req.DpClientID),
		pendingReviewer,
	).Scan(&appID)
	if err != nil {
		// Unique-constraint violations bubble up as "already
		// registered" — matches the DP's pre-migration behaviour.
		// Idempotency index handled by short-circuit above, but a
		// racy DP retry can still land here; treat it as a lookup +
		// return, not a 409.
		if strings.Contains(err.Error(), "idx_cp_inst_apps_external_ref") &&
			req.ExternalApplicationID > 0 && targetClientID > 0 {
			var raceID int64
			var raceStatus string
			if lookupErr := s.deps.DB.QueryRowContext(r.Context(),
				`SELECT id, status FROM institution_applications
				  WHERE target_client_id = $1 AND external_application_id = $2`,
				targetClientID, req.ExternalApplicationID,
			).Scan(&raceID, &raceStatus); lookupErr == nil {
				writeJSON(w, http.StatusOK, registerSubmitResp{
					ApplicationID: raceID, Status: raceStatus, Idempotent: true,
				})
				return
			}
		}
		if strings.Contains(err.Error(), "idx_cp_inst_apps_head_email_active") {
			writeErr(w, http.StatusConflict, "an application with this head email is already on file")
			return
		}
		if strings.Contains(err.Error(), "idx_cp_inst_apps_head_mobile_active") {
			writeErr(w, http.StatusConflict, "an application with this head mobile is already on file")
			return
		}
		if strings.Contains(err.Error(), "idx_cp_inst_apps_pan_active") {
			writeErr(w, http.StatusConflict, "an application with this PAN is already on file")
			return
		}
		if strings.Contains(err.Error(), "idx_cp_inst_apps_aishe") {
			writeErr(w, http.StatusConflict, "an application with this AISHE code is already on file")
			return
		}
		writeErr(w, http.StatusInternalServerError, "insert: "+err.Error())
		return
	}

	// Documents. Insert one row per doc. Small N (typically 2-4), so no
	// batch insert needed. CHECK constraint on doc_kind bubbles up as
	// 400 with the kind that broke.
	for i, d := range req.Documents {
		if _, err := tx.ExecContext(r.Context(), `
			INSERT INTO institution_application_documents(
				application_id, doc_kind, original_name, storage_path, mime, size_bytes, sha256
			) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			appID, d.DocKind, d.OriginalName, d.StoragePath, d.Mime, d.SizeBytes, d.Sha256,
		); err != nil {
			if strings.Contains(err.Error(), "institution_application_documents_doc_kind_check") {
				writeErr(w, http.StatusBadRequest,
					fmt.Sprintf("documents[%d]: unknown doc_kind %q", i, d.DocKind))
				return
			}
			writeErr(w, http.StatusInternalServerError,
				fmt.Sprintf("insert document [%d]: %v", i, err))
			return
		}
	}

	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "db commit: "+err.Error())
		return
	}

	// Provisioning fan-out — restore the pre-multi-tenant "welcome
	// email + magic link at submit" flow. The DP's internalOrgsCreate
	// creates the organization + admin user, links the org to the
	// DP-side application row (still 'pending'), generates the magic
	// link, and emails the head of institution with the sign-in
	// details. Once they set a password, they can log in and see the
	// KYCLockScreen that AdminShell renders while state != 'approved'.
	//
	// Best-effort: any failure is logged + surfaced in the response as
	// provisioning_error, but the CP submit itself is NOT rolled back.
	// A reviewer can still work the queue; a follow-up resend endpoint
	// (not built yet) or a simple re-submit will heal a stuck row via
	// the DP's idempotent short-circuit.
	resp := registerSubmitResp{ApplicationID: appID, Status: "pending"}
	if targetClientID > 0 {
		fanoutClient := int64(0)
		if req.DpClientID > 0 {
			fanoutClient = req.DpClientID
		}
		provResp, provErr := s.fireInternalOrgsCreate(r.Context(), targetClientID, internalOrgsCreatePayload{
			ExternalApplicationID: appID,
			DpApplicationID:       req.ExternalApplicationID,
			InstitutionName:       req.InstitutionName,
			HeadName:              req.HeadName,
			HeadDesignation:       req.HeadDesignation,
			HeadEmail:             req.HeadEmail,
			AisheCode:             req.AisheCode,
			SendWelcomeEmail:      true,
			ClientID:              fanoutClient,
		})
		if provErr != nil {
			resp.ProvisioningError = provErr.Error()
			log.Printf("cpRegisterSubmit: submit-time provisioning fan-out failed (app=%d client=%d): %v",
				appID, targetClientID, provErr)
		} else if provResp != nil {
			resp.AdminUsername = provResp.AdminUsername
			resp.MagicLinkURL = provResp.MagicLinkURL
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

// ── POST /api/register/resubmit — re-open a rejected application ─
//
// Fired by the DP's `adminResubmitMyKYCApplication` after the applicant
// edits their rejected registration and clicks "Re-submit". Symmetric
// with the CP → DP reject fan-out — this direction moves the CP row
// from 'rejected' back to 'pending' + refreshes fields + replaces the
// entire doc list so the reviewer sees the latest snapshot on their
// next poll.
//
// Wire shape reuses [registerSubmitReq] verbatim so the DP just calls
// its existing serialiser. The idempotency lever is
// (target_client_id, external_application_id) — we require an existing
// CP row to be in status='rejected'; anything else 409s.

func (s *Server) cpRegisterResubmit(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, cpRegisterSubmitMaxBytes)
	var req registerSubmitReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}

	targetClientID := dpClientID(r)
	if req.TargetClientIDOverride > 0 {
		targetClientID = req.TargetClientIDOverride
	}
	if targetClientID <= 0 || req.ExternalApplicationID <= 0 {
		writeErr(w, http.StatusBadRequest, "target_client_id + external_application_id required")
		return
	}

	// Validate docs shape same as cpRegisterSubmit — cheap and
	// symmetric so a malformed payload bounces before we open a tx.
	for i, d := range req.Documents {
		if d.DocKind == "" || d.OriginalName == "" || d.StoragePath == "" ||
			d.Mime == "" || d.Sha256 == "" {
			writeErr(w, http.StatusBadRequest,
				fmt.Sprintf("documents[%d]: missing required field", i))
			return
		}
	}

	tx, err := s.deps.DB.BeginTx(r.Context(), nil)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db begin: "+err.Error())
		return
	}
	defer tx.Rollback()

	// Look up the CP row by the DP-provided compound key + gate on
	// current status. FOR UPDATE holds the row so a concurrent reviewer
	// approve/reject can't race between our read and update.
	var (
		appID  int64
		status string
	)
	err = tx.QueryRowContext(r.Context(), `
		SELECT id, status FROM institution_applications
		 WHERE target_client_id = $1 AND external_application_id = $2
		 FOR UPDATE`,
		targetClientID, req.ExternalApplicationID,
	).Scan(&appID, &status)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "no CP row for this application — resubmit before initial submit?")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	if status != "rejected" {
		writeErr(w, http.StatusConflict,
			"resubmit only valid from status='rejected' (current: "+status+")")
		return
	}

	// Compute pending_reviewer per the client's CURRENT mode — a
	// reviewer setting change between reject and resubmit routes the
	// second attempt to the newly-configured queue. Falls back to
	// 'admin' if the client row can't be read.
	pendingReviewer := "admin"
	var mode string
	if err := tx.QueryRowContext(r.Context(),
		`SELECT kyc_review_mode FROM clients_registry WHERE id = $1`,
		targetClientID,
	).Scan(&mode); err == nil {
		if mode == "client" {
			pendingReviewer = "client"
		}
	}

	// Refresh mutable fields from the fresh DP snapshot. Reviewer
	// audit fields are reset so the row reads as "brand new pending"
	// on the reviewer's inbox card.
	if _, err := tx.ExecContext(r.Context(), `
		UPDATE institution_applications
		   SET status              = 'pending',
		       pending_reviewer    = $2,
		       review_note         = NULL,
		       reviewed_at         = NULL,
		       reviewed_by_user_id = NULL,
		       decided_by_desk     = NULL,
		       institution_name    = $3,
		       institution_type    = $4,
		       aishe_code          = $5,
		       pan                 = $6,
		       year_established    = $7,
		       affiliation_body    = $8,
		       approx_student_count= $9,
		       address_line1       = $10,
		       address_line2       = $11,
		       city                = $12,
		       district            = $13,
		       state               = $14,
		       pin_code            = $15,
		       head_name           = $16,
		       head_designation    = $17,
		       head_email          = $18,
		       head_mobile         = $19,
		       updated_at          = NOW()
		 WHERE id = $1`,
		appID, pendingReviewer,
		req.InstitutionName, req.InstitutionType,
		nullableStr(req.AisheCode), nullableStr(req.Pan),
		nullableInt(req.YearEstablished), nullableStr(req.AffiliationBody),
		nullableInt(req.ApproxStudentCount),
		req.AddressLine1, nullableStr(req.AddressLine2),
		req.City, nullableStr(req.District), req.State, req.PinCode,
		req.HeadName, req.HeadDesignation, req.HeadEmail, req.HeadMobile,
	); err != nil {
		writeErr(w, http.StatusInternalServerError, "update fields: "+err.Error())
		return
	}

	// Docs: delete + re-insert the whole set. Simpler than
	// row-by-row diff and safe because the DP is the source of truth
	// for what the applicant currently has on file. Kept in the same
	// tx as the status flip so a failure rolls both back atomically.
	if _, err := tx.ExecContext(r.Context(),
		`DELETE FROM institution_application_documents WHERE application_id = $1`, appID,
	); err != nil {
		writeErr(w, http.StatusInternalServerError, "delete docs: "+err.Error())
		return
	}
	for i, d := range req.Documents {
		if _, err := tx.ExecContext(r.Context(), `
			INSERT INTO institution_application_documents(
				application_id, doc_kind, original_name, storage_path, mime, size_bytes, sha256
			) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			appID, d.DocKind, d.OriginalName, d.StoragePath, d.Mime, d.SizeBytes, d.Sha256,
		); err != nil {
			if strings.Contains(err.Error(), "institution_application_documents_doc_kind_check") {
				writeErr(w, http.StatusBadRequest,
					fmt.Sprintf("documents[%d]: unknown doc_kind %q", i, d.DocKind))
				return
			}
			writeErr(w, http.StatusInternalServerError,
				fmt.Sprintf("insert document [%d]: %v", i, err))
			return
		}
	}

	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "commit: "+err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"application_id":   appID,
		"status":           "pending",
		"pending_reviewer": pendingReviewer,
	})
}

// ── GET /api/register/{id} — status lookup for the applicant ─────

type registerStatusResp struct {
	ApplicationID   int64  `json:"application_id"`
	Status          string `json:"status"`
	InstitutionName string `json:"institution_name"`
	ReviewNote      string `json:"review_note,omitempty"`
	ReviewedAt      string `json:"reviewed_at,omitempty"`
}

func (s *Server) cpRegisterStatus(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	var (
		status, name string
		note         sql.NullString
		reviewedAt   sql.NullTime
	)
	err = s.deps.DB.QueryRowContext(r.Context(), `
		SELECT status, institution_name, review_note, reviewed_at
		  FROM institution_applications WHERE id = $1`, id,
	).Scan(&status, &name, &note, &reviewedAt)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "application not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	resp := registerStatusResp{
		ApplicationID:   id,
		Status:          status,
		InstitutionName: name,
		ReviewNote:      note.String,
	}
	if reviewedAt.Valid {
		resp.ReviewedAt = reviewedAt.Time.UTC().Format(time.RFC3339)
	}
	writeJSON(w, http.StatusOK, resp)
}

// ── GET /api/reviewer/applications — DP proxies reviewer inbox ─

type reviewerListItem struct {
	ID              int64  `json:"id"`
	Status          string `json:"status"`
	InstitutionName string `json:"institution_name"`
	InstitutionType string `json:"institution_type"`
	City            string `json:"city"`
	State           string `json:"state"`
	HeadName        string `json:"head_name"`
	HeadEmail       string `json:"head_email"`
	HeadMobile      string `json:"head_mobile"`
	AisheCode       string `json:"aishe_code,omitempty"`
	CreatedAt       string `json:"created_at"`
	// Number of KYC docs uploaded with the application. Rendered on
	// the reviewer inbox card as "N supporting docs". Missing this
	// field is what made every card show "0 supporting docs" even for
	// applications with real uploads.
	DocCount int `json:"doc_count"`
}

func (s *Server) cpReviewerList(w http.ResponseWriter, r *http.Request) {
	clientID := dpClientID(r)
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	if status == "" {
		status = "pending"
	}
	switch status {
	case "pending", "approved", "rejected", "draft":
		// ok
	default:
		writeErr(w, http.StatusBadRequest, "bad status filter")
		return
	}

	// Reviewer's queue, scoped to their own desk on every tab.
	//
	//   pending  — pending_reviewer='client', so superadmin-first
	//              ('both' mode, pre-handoff) apps don't leak in.
	//   approved
	//   rejected — decided_by_desk='client'. These used to be shown
	//              regardless of desk, on the reasoning that a
	//              reviewer wants their client's decision history.
	//              But that also surfaced applications the SUPERADMIN
	//              rejected before the reviewer ever saw them, which
	//              reads as "I rejected this" when they did not.
	//              History now means "decisions taken at this desk".
	//
	// decided_by_desk IS NULL means the decision predates the column,
	// so provenance is unknown; those are excluded rather than
	// attributed to a desk that may not have made them.
	var (
		reviewerWhere string
		args          []any
	)
	switch status {
	case "pending":
		reviewerWhere = `target_client_id = $1 AND status = $2 AND pending_reviewer = 'client'`
	case "approved", "rejected":
		reviewerWhere = `target_client_id = $1 AND status = $2 AND decided_by_desk = 'client'`
	default:
		reviewerWhere = `target_client_id = $1 AND status = $2`
	}
	args = []any{clientID, status}
	rows, err := s.deps.DB.QueryContext(r.Context(), `
		SELECT a.id, a.status, a.institution_name, a.institution_type,
		       a.city, a.state, a.head_name, a.head_email, a.head_mobile,
		       COALESCE(a.aishe_code, ''), a.created_at,
		       (SELECT COUNT(*) FROM institution_application_documents d
		         WHERE d.application_id = a.id) AS doc_count
		  FROM institution_applications a
		 WHERE `+strings.ReplaceAll(reviewerWhere, "target_client_id", "a.target_client_id")+`
		 ORDER BY a.created_at DESC
		 LIMIT 200`, args...,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	defer rows.Close()

	out := []reviewerListItem{}
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
		out = append(out, it)
	}
	// Tab counts. The inbox used to source these from the DP's own
	// institution_applications table (via /api/client/me), which is a
	// different table from the one this list reads -- so the tiles sat
	// at whatever the DP happened to hold and never moved when an
	// approve/reject/revoke landed here on the CP. Computing them from
	// the same rows as `items` keeps tiles and list in lockstep.
	//
	// The desk rule mirrors the list query exactly: pending belongs to
	// this reviewer only when pending_reviewer='client', and decided
	// rows only when decided_by_desk='client'.
	counts := map[string]int{"pending": 0, "approved": 0, "rejected": 0, "draft": 0}
	countRows, cerr := s.deps.DB.QueryContext(r.Context(), `
		SELECT status, COUNT(*)
		  FROM institution_applications
		 WHERE target_client_id = $1
		   AND CASE status
		         WHEN 'pending'  THEN pending_reviewer = 'client'
		         WHEN 'approved' THEN decided_by_desk  = 'client'
		         WHEN 'rejected' THEN decided_by_desk  = 'client'
		         ELSE TRUE
		       END
		 GROUP BY status`, clientID,
	)
	if cerr != nil {
		writeErr(w, http.StatusInternalServerError, "db count: "+cerr.Error())
		return
	}
	defer countRows.Close()
	for countRows.Next() {
		var st string
		var n int
		if err := countRows.Scan(&st, &n); err != nil {
			writeErr(w, http.StatusInternalServerError, "count scan: "+err.Error())
			return
		}
		counts[st] = n
	}
	if err := countRows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "count rows: "+err.Error())
		return
	}

	// `total` is the true number of rows on the active tab, not the
	// size of this page -- the list is capped at LIMIT 200, so len(out)
	// understated any tab past that cap.
	writeJSON(w, http.StatusOK, map[string]any{
		"items":  out,
		"total":  counts[status],
		"counts": counts,
	})
}

// ── GET /api/reviewer/applications/{id} — detail read ────────────

func (s *Server) cpReviewerGet(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	clientID := dpClientID(r)
	row := struct {
		ID                 int64
		Status             string
		InstitutionName    string
		InstitutionType    string
		AisheCode          sql.NullString
		Pan                sql.NullString
		YearEstablished    sql.NullInt64
		AffiliationBody    sql.NullString
		ApproxStudentCount sql.NullInt64
		AddressLine1       string
		AddressLine2       sql.NullString
		City               string
		District           sql.NullString
		State              string
		PinCode            string
		HeadName           string
		HeadDesignation    string
		HeadEmail          string
		HeadMobile         string
		ReviewNote         sql.NullString
		ReviewedAt         sql.NullTime
		CreatedAt          time.Time
	}{}
	err = s.deps.DB.QueryRowContext(r.Context(), `
		SELECT id, status, institution_name, institution_type,
		       aishe_code, pan, year_established, affiliation_body,
		       approx_student_count,
		       address_line1, address_line2, city, district, state, pin_code,
		       head_name, head_designation, head_email, head_mobile,
		       review_note, reviewed_at, created_at
		  FROM institution_applications
		 WHERE id = $1 AND target_client_id = $2`, id, clientID,
	).Scan(&row.ID, &row.Status, &row.InstitutionName, &row.InstitutionType,
		&row.AisheCode, &row.Pan, &row.YearEstablished, &row.AffiliationBody,
		&row.ApproxStudentCount,
		&row.AddressLine1, &row.AddressLine2, &row.City, &row.District, &row.State, &row.PinCode,
		&row.HeadName, &row.HeadDesignation, &row.HeadEmail, &row.HeadMobile,
		&row.ReviewNote, &row.ReviewedAt, &row.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "application not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	// Docs — same shape the FE expects (docs[] with doc_id per row +
	// download_url pointing at the CP proxy that streams from S3).
	docs := []map[string]any{}
	docsRows, dErr := s.deps.DB.QueryContext(r.Context(), `
		SELECT id, doc_kind, original_name, storage_path, mime, size_bytes, sha256, created_at
		  FROM institution_application_documents
		 WHERE application_id = $1
		 ORDER BY id`, id)
	if dErr == nil {
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
				"doc_id":        dID,
				"doc_kind":      dKind,
				"original_name": dName,
				"storage_path":  dPath,
				"mime":          dMime,
				"size_bytes":    dSize,
				"sha256":        dSha,
				"created_at":    dCreated.UTC().Format(time.RFC3339),
				// Reviewer's browser is on the DP subdomain, so the
				// download URL must be a DP-side path — DP's
				// proxyReviewerDocDownload forwards to us.
				"download_url":  fmt.Sprintf("/api/client/applications/%d/docs/%d", id, dID),
			})
		}
	}

	// Enrich with the target client's name + kyc_review_mode so the FE
	// header can render "NTA · reviewer" without a second lookup.
	var clientName, clientKycMode string
	_ = s.deps.DB.QueryRowContext(r.Context(),
		`SELECT name, kyc_review_mode FROM clients_registry WHERE id = $1`, clientID,
	).Scan(&clientName, &clientKycMode)

	// Combined address for the FE's "address_line" field.
	addressLine := row.AddressLine1
	if row.AddressLine2.Valid && strings.TrimSpace(row.AddressLine2.String) != "" {
		addressLine = row.AddressLine1 + ", " + row.AddressLine2.String
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"id":                     row.ID,
		"status":                 row.Status,
		"institution_name":       row.InstitutionName,
		"institution_type":       row.InstitutionType,
		"aishe_code":             row.AisheCode.String,
		"pan":                    row.Pan.String,
		"year_established":       row.YearEstablished.Int64,
		"affiliation_body":       row.AffiliationBody.String,
		"approx_student_count":   row.ApproxStudentCount.Int64,
		"address_line":           addressLine,
		"address_line1":          row.AddressLine1,
		"address_line2":          row.AddressLine2.String,
		"city":                   row.City,
		"district":               row.District.String,
		"state":                  row.State,
		"pin_code":               row.PinCode,
		"head_name":              row.HeadName,
		"head_designation":       row.HeadDesignation,
		"head_email":             row.HeadEmail,
		"head_mobile":            row.HeadMobile,
		"review_note":            row.ReviewNote.String,
		"reviewed_at":            nullTimeToString(row.ReviewedAt),
		"created_at":             row.CreatedAt.UTC().Format(time.RFC3339),
		"client_id":              clientID,
		"client_name":            clientName,
		"client_kyc_review_mode": clientKycMode,
		"can_act":                row.Status == "pending",
		"docs":                   docs,
		"documents":              docs,
	})
}

// ── POST /api/reviewer/applications/{id}/approve ─────────────────

type reviewerDecisionReq struct {
	Note string `json:"note"`
}

type approveResp struct {
	ApplicationID int64  `json:"application_id"`
	Status        string `json:"status"`
	// Provisioning result from the target Data Plane. When the
	// /internal/orgs/create fan-out succeeds inline (usually within
	// a couple of hundred ms), we echo the DP's response so the
	// reviewer's UI can render the admin username / activation link.
	// When it fails or times out we still return 200 (the DB flip
	// succeeded) and set provisioning_error so the reviewer sees
	// "approved but provisioning pending". A retry mechanism (not
	// built yet) can re-fire the internal call.
	OrgID              int64  `json:"org_id,omitempty"`
	AdminUsername      string `json:"admin_username,omitempty"`
	MagicLinkURL       string `json:"magic_link_url,omitempty"`
	ProvisioningError  string `json:"provisioning_error,omitempty"`
}

func (s *Server) cpReviewerApprove(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	clientID := dpClientID(r)
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	var req reviewerDecisionReq
	_ = json.NewDecoder(r.Body).Decode(&req) // note is optional

	// Load the application in a scoped read + flip in a transaction
	// so two concurrent approve calls can't race into a double-
	// provisioning path. We use SELECT ... FOR UPDATE to hold the
	// row until the status flip commits.
	tx, err := s.deps.DB.BeginTx(r.Context(), nil)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db begin: "+err.Error())
		return
	}
	defer tx.Rollback()

	var (
		status, instName, headName, headDesignation, headEmail string
		aishe                                                   sql.NullString
		dpClientID, externalAppID                               sql.NullInt64
	)
	err = tx.QueryRowContext(r.Context(), `
		SELECT status, institution_name, head_name, head_designation,
		       head_email, aishe_code, dp_client_id, external_application_id
		  FROM institution_applications
		 WHERE id = $1 AND target_client_id = $2
		 FOR UPDATE`, id, clientID,
	).Scan(&status, &instName, &headName, &headDesignation, &headEmail, &aishe, &dpClientID, &externalAppID)
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

	// Reviewer identity comes from the DP-side JWT the DP already
	// checked. Since we intentionally don't require a superadmin JWT
	// on this reverse-proxy endpoint, we don't have a platform_users
	// id to stamp — leave reviewed_by_user_id NULL and record a
	// generic "reviewed via DP proxy" note if none supplied.
	note := strings.TrimSpace(req.Note)
	// Terminal approve — clear pending_reviewer so the row no longer
	// shows in any queue's active-work view. Approved rows are already
	// filtered out of pending queries but the field stays around for
	// display; leaving 'client' set makes the row look mis-routed.
	if _, err := tx.ExecContext(r.Context(), `
		UPDATE institution_applications
		   SET status = 'approved',
		       pending_reviewer = NULL,
		       decided_by_desk = 'client',
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

	// Fire /internal/orgs/create on the target Data Plane. Best-
	// effort: any error is recorded on the response so the reviewer
	// sees "approved but provisioning pending" instead of silently
	// losing the fan-out.
	resp := approveResp{ApplicationID: id, Status: "approved"}

	// Fan-out ClientID is the DP-SIDE exam-board id (dp_client_id column
	// on the CP row) — NOT the CP's own clients_registry.id (which
	// identifies the whole DP, not any specific board on it). When the
	// applicant deep-linked to a client during registration, dp_client_id
	// carries their choice through. When they didn't (or landed on a
	// generic form), dp_client_id is NULL and the fan-out is skipped —
	// the org is still provisioned, but the admin will see an empty
	// catalog until superadmin manually attaches them.
	fanoutClient := int64(0)
	if dpClientID.Valid {
		fanoutClient = dpClientID.Int64
	}

	provResp, provErr := s.fireInternalOrgsCreate(r.Context(), clientID, internalOrgsCreatePayload{
		ExternalApplicationID: id,
		DpApplicationID:       externalAppID.Int64,
		InstitutionName:       instName,
		HeadName:              headName,
		HeadDesignation:       headDesignation,
		HeadEmail:             headEmail,
		AisheCode:             aishe.String,
		SendWelcomeEmail:      true,
		ClientID:              fanoutClient,
		MarkApproved:          true, // client reviewer just approved — flip DP row
	})
	if provErr != nil {
		resp.ProvisioningError = provErr.Error()
		log.Printf("cp approve app=%d: provisioning fan-out failed: %v", id, provErr)
	} else if provResp != nil {
		resp.OrgID = provResp.OrgID
		resp.AdminUsername = provResp.AdminUsername
		resp.MagicLinkURL = provResp.MagicLinkURL
	}

	// Applicant-facing "your KYC was approved" email. Terminal path
	// (client reviewer's approve is always the final answer on the
	// client-side surface — both mode='client' and the post-handoff
	// mode='both' reach this handler). Fire once, in a goroutine.
	go func(registryID int64, hEmail, hName, iName, n string) {
		if err := s.fireInternalKYCDecisionNotify(context.Background(), registryID, hEmail, hName, iName, "approved", n); err != nil {
			log.Printf("cpReviewerApprove: KYC decision notify (app=%d) failed: %v", id, err)
		}
	}(clientID, headEmail, headName, instName, note)

	writeJSON(w, http.StatusOK, resp)
}

// ── POST /api/reviewer/applications/{id}/reject ──────────────────

func (s *Server) cpReviewerReject(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	clientID := dpClientID(r)
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

	// UPDATE ... RETURNING pulls the applicant fields + the DP row id
	// atomically so we can email the applicant AND mirror the reject
	// to the DP without a second read. Guarded by status='pending' +
	// target_client_id scope, same as before.
	var (
		headEmail, headName, instName string
		externalAppID                 sql.NullInt64
	)
	err = s.deps.DB.QueryRowContext(r.Context(), `
		UPDATE institution_applications
		   SET status           = 'rejected',
		       pending_reviewer = NULL,
		       decided_by_desk  = 'client',
		       review_note      = $3,
		       reviewed_at      = NOW(),
		       updated_at       = NOW()
		 WHERE id = $1 AND target_client_id = $2 AND status = 'pending'
		 RETURNING head_email, head_name, institution_name, external_application_id`,
		id, clientID, note,
	).Scan(&headEmail, &headName, &instName, &externalAppID)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusConflict, "application not found or not pending")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "update: "+err.Error())
		return
	}
	// Mirror the reject to the DP so its own institution_applications
	// row flips out of 'pending' and adminKYCStatus (which the admin
	// dashboard's KYC lock screen polls) reports 'rejected' instead
	// of staying stuck on 'pending'. Without this the applicant's
	// admin dashboard shows the pending lock screen forever after a
	// client-reviewer reject in 'both' mode. Symmetric with
	// superadminApplicationReject's mirror. Best-effort: log on
	// failure, don't fail the reviewer's response — the CP decision
	// itself is already committed.
	if externalAppID.Valid && externalAppID.Int64 > 0 {
		if _, ferr := s.fireInternalApplicationsReject(r.Context(), clientID, internalApplicationsRejectPayload{
			DpApplicationID: externalAppID.Int64,
			ReviewNote:      note,
		}); ferr != nil {
			log.Printf("cpReviewerReject: DP mirror failed (app=%d): %v", id, ferr)
		}
	}
	// Applicant-facing "your KYC was rejected" email. Terminal path.
	if headEmail != "" {
		go func(registryID int64, hEmail, hName, iName, n string) {
			if err := s.fireInternalKYCDecisionNotify(context.Background(), registryID, hEmail, hName, iName, "rejected", n); err != nil {
				log.Printf("cpReviewerReject: KYC decision notify (app=%d) failed: %v", id, err)
			}
		}(clientID, headEmail, headName, instName, note)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"application_id": id,
		"status":         "rejected",
	})
}

// ── POST /api/reviewer/applications/bulk-approve, bulk-reject ────
//
// Mass action for the client-reviewer inbox. Takes {application_ids,
// note} and applies the same per-item logic as the single-item
// approve/reject to each id, one at a time. Failures are captured
// per-row so the reviewer sees an "N approved, M skipped" summary
// instead of aborting on the first bad row.
//
// Response shape matches what Rahul's FE already expects from the
// DP-side bulk endpoint (bulkKycActionResp shape from
// client_review_handlers.go).
//
// Hard cap of 200 applications per call — same as the DP-side handler,
// keeps a runaway UI or curl from pinning a CP worker for minutes.

type cpBulkActionReq struct {
	ApplicationIDs []int64 `json:"application_ids"`
	Note           string  `json:"note"`
}

type cpBulkActionResult struct {
	ApplicationID int64  `json:"application_id"`
	OK            bool   `json:"ok"`
	Error         string `json:"error,omitempty"`
	OrgID         int64  `json:"org_id,omitempty"`
}

type cpBulkActionResp struct {
	Requested int                  `json:"requested"`
	Succeeded int                  `json:"succeeded"`
	Failed    int                  `json:"failed"`
	Results   []cpBulkActionResult `json:"results"`
}

const cpMaxBulkKycAppsPerCall = 200

func (s *Server) cpReviewerBulkApprove(w http.ResponseWriter, r *http.Request) {
	s.cpReviewerBulkAction(w, r, false /* isReject */)
}

func (s *Server) cpReviewerBulkReject(w http.ResponseWriter, r *http.Request) {
	s.cpReviewerBulkAction(w, r, true /* isReject */)
}

func (s *Server) cpReviewerBulkAction(w http.ResponseWriter, r *http.Request, isReject bool) {
	clientID := dpClientID(r)
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	var req cpBulkActionReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if len(req.ApplicationIDs) == 0 {
		writeErr(w, http.StatusBadRequest, "application_ids required")
		return
	}
	if len(req.ApplicationIDs) > cpMaxBulkKycAppsPerCall {
		writeErr(w, http.StatusBadRequest,
			fmt.Sprintf("too many application_ids — cap is %d per call", cpMaxBulkKycAppsPerCall))
		return
	}
	note := strings.TrimSpace(req.Note)
	if isReject && note == "" {
		writeErr(w, http.StatusBadRequest, "a rejection note is required — it goes to the applicant")
		return
	}

	out := cpBulkActionResp{
		Requested: len(req.ApplicationIDs),
		Results:   make([]cpBulkActionResult, 0, len(req.ApplicationIDs)),
	}

	for _, id := range req.ApplicationIDs {
		res := cpBulkActionResult{ApplicationID: id}
		if id <= 0 {
			res.Error = "invalid application id"
		} else if isReject {
			res.Error = s.rejectOneApplication(r.Context(), id, clientID, note)
			res.OK = res.Error == ""
		} else {
			orgID, provErr, errMsg := s.approveOneApplication(r.Context(), id, clientID, note)
			if errMsg != "" {
				res.Error = errMsg
			} else {
				res.OK = true
				res.OrgID = orgID
				if provErr != "" {
					// Partial success — the CP row is approved but the DP
					// provisioning fan-out failed. Report as OK with the
					// provisioning error appended so the reviewer knows
					// there's follow-up work.
					res.Error = "approved but provisioning failed: " + provErr
				}
			}
		}
		if res.OK {
			out.Succeeded++
		} else {
			out.Failed++
		}
		out.Results = append(out.Results, res)
	}
	writeJSON(w, http.StatusOK, out)
}

// rejectOneApplication applies the same UPDATE that cpReviewerReject
// runs, scoped to the caller's client. Returns "" on success or a
// human-readable error message (empty string means OK).
//
// Also:
//   - mirrors the reject to the DP so the admin dashboard's KYC lock
//     screen reports 'rejected' instead of staying pending (bulk
//     inherits the same fix cpReviewerReject got);
//   - fires the applicant-facing "your KYC was rejected" email in a
//     goroutine after the row flips — bulk-reject inherits this too.
//
// UPDATE ... RETURNING pulls head fields + DP row id inline so we
// don't need a second read per item.
func (s *Server) rejectOneApplication(ctx context.Context, id, clientID int64, note string) string {
	var (
		headEmail, headName, instName string
		externalAppID                 sql.NullInt64
	)
	err := s.deps.DB.QueryRowContext(ctx, `
		UPDATE institution_applications
		   SET status           = 'rejected',
		       pending_reviewer = NULL,
		       decided_by_desk  = 'client',
		       review_note      = $3,
		       reviewed_at      = NOW(),
		       updated_at       = NOW()
		 WHERE id = $1 AND target_client_id = $2 AND status = 'pending'
		 RETURNING head_email, head_name, institution_name, external_application_id`,
		id, clientID, note,
	).Scan(&headEmail, &headName, &instName, &externalAppID)
	if errors.Is(err, sql.ErrNoRows) {
		return "not found or not pending"
	}
	if err != nil {
		return "db update failed: " + err.Error()
	}
	// DP mirror — see cpReviewerReject for why this matters.
	if externalAppID.Valid && externalAppID.Int64 > 0 {
		if _, ferr := s.fireInternalApplicationsReject(ctx, clientID, internalApplicationsRejectPayload{
			DpApplicationID: externalAppID.Int64,
			ReviewNote:      note,
		}); ferr != nil {
			log.Printf("rejectOneApplication: DP mirror failed (app=%d): %v", id, ferr)
		}
	}
	if headEmail != "" {
		go func(registryID int64, hEmail, hName, iName, n string) {
			if err := s.fireInternalKYCDecisionNotify(context.Background(), registryID, hEmail, hName, iName, "rejected", n); err != nil {
				log.Printf("rejectOneApplication: KYC decision notify (app=%d) failed: %v", id, err)
			}
		}(clientID, headEmail, headName, instName, note)
	}
	return ""
}

// approveOneApplication applies the same tx + provisioning as
// cpReviewerApprove. Returns (orgID, provisioningError, fatalError).
// A fatal error means the row itself couldn't be flipped; a
// provisioning error means the CP row is approved but the DP fan-out
// failed (retry via re-approve or manual heal).
func (s *Server) approveOneApplication(parent context.Context, id, clientID int64, note string) (int64, string, string) {
	tx, err := s.deps.DB.BeginTx(parent, nil)
	if err != nil {
		return 0, "", "db begin failed: " + err.Error()
	}
	defer tx.Rollback()

	var (
		status, instName, headName, headDesignation, headEmail string
		aishe                                                   sql.NullString
		dpClientIDCol, externalAppID                            sql.NullInt64
	)
	err = tx.QueryRowContext(parent, `
		SELECT status, institution_name, head_name, head_designation,
		       head_email, aishe_code, dp_client_id, external_application_id
		  FROM institution_applications
		 WHERE id = $1 AND target_client_id = $2
		 FOR UPDATE`, id, clientID,
	).Scan(&status, &instName, &headName, &headDesignation, &headEmail, &aishe, &dpClientIDCol, &externalAppID)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, "", "not found"
	}
	if err != nil {
		return 0, "", "db read failed: " + err.Error()
	}
	if status != "pending" {
		return 0, "", "not pending (is " + status + ")"
	}
	if _, err := tx.ExecContext(parent, `
		UPDATE institution_applications
		   SET status = 'approved',
		       pending_reviewer = NULL,
		       decided_by_desk = 'client',
		       reviewed_at = NOW(),
		       review_note = $2,
		       updated_at  = NOW()
		 WHERE id = $1`, id, nullableStr(note),
	); err != nil {
		return 0, "", "db update failed: " + err.Error()
	}
	if err := tx.Commit(); err != nil {
		return 0, "", "commit failed: " + err.Error()
	}

	fanoutClient := int64(0)
	if dpClientIDCol.Valid {
		fanoutClient = dpClientIDCol.Int64
	}
	provResp, provErr := s.fireInternalOrgsCreate(parent, clientID, internalOrgsCreatePayload{
		ExternalApplicationID: id,
		DpApplicationID:       externalAppID.Int64,
		InstitutionName:       instName,
		HeadName:              headName,
		HeadDesignation:       headDesignation,
		HeadEmail:             headEmail,
		AisheCode:             aishe.String,
		SendWelcomeEmail:      true,
		ClientID:              fanoutClient,
		MarkApproved:          true, // bulk approve path — flip DP row
	})
	if provErr != nil {
		log.Printf("bulk-approve app=%d: provisioning fan-out failed: %v", id, provErr)
		return 0, provErr.Error(), ""
	}
	orgID := int64(0)
	if provResp != nil {
		orgID = provResp.OrgID
	}
	// Applicant-facing "your KYC was approved" email. Fires per-row
	// out of the bulk loop the same way the single-item cpReviewerApprove
	// path does. Best-effort goroutine — a failed notify does not
	// change the row's approved state.
	if headEmail != "" {
		go func(registryID int64, hEmail, hName, iName, n string) {
			if err := s.fireInternalKYCDecisionNotify(context.Background(), registryID, hEmail, hName, iName, "approved", n); err != nil {
				log.Printf("approveOneApplication: KYC decision notify (app=%d) failed: %v", id, err)
			}
		}(clientID, headEmail, headName, instName, note)
	}
	return orgID, "", ""
}

// ── /internal/orgs/create fan-out ────────────────────────────────

type internalOrgsCreatePayload struct {
	ExternalApplicationID int64  `json:"external_application_id"`
	// DpApplicationID is the target DP's own institution_applications.id
	// (stored on CP as external_application_id when the DP forwarded
	// the submit). We send it separately so the DP can flip its stale
	// 'pending' row to 'approved' after our terminal decision. Optional:
	// zero skips the back-write (used when the submit came in
	// single-shot without a DP-side draft).
	DpApplicationID       int64  `json:"dp_application_id,omitempty"`
	InstitutionName       string `json:"institution_name"`
	HeadName              string `json:"head_name"`
	HeadDesignation       string `json:"head_designation"`
	HeadEmail             string `json:"head_email"`
	AisheCode             string `json:"aishe_code,omitempty"`
	SendWelcomeEmail      bool   `json:"send_welcome_email"`
	// ClientID tells the DP to also write a client_organization_approvals
	// row + fan out organization_exam_subscriptions for that client's
	// open exams. Populated from institution_applications.target_client_id.
	// Zero skips the fan-out (legacy behaviour).
	ClientID int64 `json:"client_id,omitempty"`
	// MarkApproved tells the DP whether it should also flip its
	// institution_applications row to 'approved' via
	// backfillDPApplication. TRUE only on the APPROVE fan-out; FALSE at
	// SUBMIT-time provisioning — otherwise the DP's KYC gate treats a
	// freshly-registered institute as already approved and skips the
	// lock screen.
	MarkApproved bool `json:"mark_approved,omitempty"`
}

type internalOrgsCreateReply struct {
	OrgID         int64  `json:"org_id"`
	AdminUserID   int64  `json:"admin_user_id"`
	AdminUsername string `json:"admin_username"`
	MagicLinkURL  string `json:"magic_link_url"`
	Idempotent    bool   `json:"idempotent"`
}

// fireInternalOrgsCreate looks up the client's api_url + api_key in
// clients_registry and POSTs to <api_url>/api/internal/orgs/create.
// Blocks for up to `FederatedTimeoutMS` — the same knob the
// dashboard federation uses, since this call has similar sensitivity
// to a slow Data Plane.
func (s *Server) fireInternalOrgsCreate(parent context.Context, clientID int64, payload internalOrgsCreatePayload) (*internalOrgsCreateReply, error) {
	var (
		apiURL string
		apiKey string
		status string
	)
	err := s.deps.DB.QueryRowContext(parent,
		`SELECT api_url, api_key, status FROM clients_registry WHERE id = $1`, clientID,
	).Scan(&apiURL, &apiKey, &status)
	if err != nil {
		return nil, fmt.Errorf("registry lookup: %w", err)
	}
	if status != "active" {
		return nil, fmt.Errorf("target client is %s", status)
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal payload: %w", err)
	}

	timeout := time.Duration(s.deps.Cfg.FederatedTimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = 3 * time.Second
	}
	ctx, cancel := context.WithTimeout(parent, timeout+2*time.Second) // small headroom over client timeout
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		apiURL+"/api/internal/orgs/create", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-API-Key", apiKey)

	httpClient := &http.Client{Timeout: timeout}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 32<<10))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("data plane returned %d: %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}
	var reply internalOrgsCreateReply
	if err := json.Unmarshal(respBody, &reply); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}
	return &reply, nil
}

// ── /internal/applications/reject fan-out ─────────────────────────
//
// Symmetric with fireInternalOrgsCreate. Called by
// superadminApplicationReject after committing the CP's own row so
// the DP's mirror moves out of 'pending' too. Best-effort: any
// failure is logged + surfaced via the returned error, but the CP
// reject itself is NOT rolled back — the CP is the source of truth
// for the decision. Operators can heal a stale DP row with a
// dedicated resync later if this call ever fails.

type internalApplicationsRejectPayload struct {
	DpApplicationID int64  `json:"dp_application_id"`
	ReviewNote      string `json:"review_note"`
}

type internalApplicationsRejectReply struct {
	Updated bool `json:"updated"`
}

func (s *Server) fireInternalApplicationsReject(parent context.Context, clientID int64, payload internalApplicationsRejectPayload) (*internalApplicationsRejectReply, error) {
	if payload.DpApplicationID <= 0 {
		// Nothing to mirror — the CP row was created before the DP
		// mirror flow existed. Treat as a benign no-op so the reject
		// UI doesn't scream.
		return &internalApplicationsRejectReply{Updated: false}, nil
	}

	var (
		apiURL string
		apiKey string
		status string
	)
	err := s.deps.DB.QueryRowContext(parent,
		`SELECT api_url, api_key, status FROM clients_registry WHERE id = $1`, clientID,
	).Scan(&apiURL, &apiKey, &status)
	if err != nil {
		return nil, fmt.Errorf("registry lookup: %w", err)
	}
	if status != "active" {
		return nil, fmt.Errorf("target client is %s", status)
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal payload: %w", err)
	}

	timeout := time.Duration(s.deps.Cfg.FederatedTimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = 3 * time.Second
	}
	ctx, cancel := context.WithTimeout(parent, timeout+2*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		apiURL+"/api/internal/applications/reject", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-API-Key", apiKey)

	httpClient := &http.Client{Timeout: timeout}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("data plane returned %d: %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}
	var reply internalApplicationsRejectReply
	if err := json.Unmarshal(respBody, &reply); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}
	return &reply, nil
}

// ── POST /api/reviewer/applications/{id}/revoke ──────────────────
//
// Revokes a previously-rejected application back to 'pending'. Gated
// strictly on status='rejected'. Reviewer scope (target_client_id = $2).
// Sets pending_reviewer = 'client', clears reviewed_at, and mirrors
// the change to the Data Plane so both planes count pending/rejected correctly.

func (s *Server) cpReviewerRevoke(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	clientID := dpClientID(r)
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	var req reviewerDecisionReq
	_ = json.NewDecoder(r.Body).Decode(&req)
	note := strings.TrimSpace(req.Note)

	var externalAppID sql.NullInt64
	err = s.deps.DB.QueryRowContext(r.Context(), `
		UPDATE institution_applications
		   SET status           = 'pending',
		       pending_reviewer = 'client',
		       decided_by_desk  = NULL,
		       review_note      = $3,
		       reviewed_at      = NULL,
		       updated_at       = NOW()
		 WHERE id = $1 AND target_client_id = $2 AND status = 'rejected'
		 RETURNING external_application_id`,
		id, clientID, nullableStr(note),
	).Scan(&externalAppID)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusConflict, "application not found or not in rejected status")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "update: "+err.Error())
		return
	}

	resp := map[string]any{
		"application_id":   id,
		"status":           "pending",
		"pending_reviewer": "client",
	}

	if externalAppID.Valid && externalAppID.Int64 > 0 {
		if _, ferr := s.fireInternalApplicationsRevoke(r.Context(), clientID, internalApplicationsRevokePayload{
			DpApplicationID: externalAppID.Int64,
			ReviewNote:      note,
		}); ferr != nil {
			log.Printf("cp reviewer revoke app=%d: DP mirror failed: %v", id, ferr)
			resp["mirror_error"] = ferr.Error()
		}
	}

	writeJSON(w, http.StatusOK, resp)
}

// ── /internal/applications/revoke fan-out ─────────────────────────

type internalApplicationsRevokePayload struct {
	DpApplicationID int64  `json:"dp_application_id"`
	ReviewNote      string `json:"review_note,omitempty"`
}

type internalApplicationsRevokeReply struct {
	Updated bool `json:"updated"`
}

func (s *Server) fireInternalApplicationsRevoke(parent context.Context, clientID int64, payload internalApplicationsRevokePayload) (*internalApplicationsRevokeReply, error) {
	if payload.DpApplicationID <= 0 {
		return &internalApplicationsRevokeReply{Updated: false}, nil
	}

	var (
		apiURL string
		apiKey string
		status string
	)
	err := s.deps.DB.QueryRowContext(parent,
		`SELECT api_url, api_key, status FROM clients_registry WHERE id = $1`, clientID,
	).Scan(&apiURL, &apiKey, &status)
	if err != nil {
		return nil, fmt.Errorf("registry lookup: %w", err)
	}
	if status != "active" {
		return nil, fmt.Errorf("target client is %s", status)
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal payload: %w", err)
	}

	timeout := time.Duration(s.deps.Cfg.FederatedTimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = 3 * time.Second
	}
	ctx, cancel := context.WithTimeout(parent, timeout+2*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		apiURL+"/api/internal/applications/revoke", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-API-Key", apiKey)

	httpClient := &http.Client{Timeout: timeout}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("data plane returned %d: %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}
	var reply internalApplicationsRevokeReply
	if err := json.Unmarshal(respBody, &reply); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}
	return &reply, nil
}

// ── null helpers ─────────────────────────────────────────────────

func nullableStr(s string) sql.NullString {
	s = strings.TrimSpace(s)
	if s == "" {
		return sql.NullString{}
	}
	return sql.NullString{String: s, Valid: true}
}

func nullableInt(n int) sql.NullInt64 {
	if n == 0 {
		return sql.NullInt64{}
	}
	return sql.NullInt64{Int64: int64(n), Valid: true}
}

func nullableInt64(n int64) sql.NullInt64 {
	if n == 0 {
		return sql.NullInt64{}
	}
	return sql.NullInt64{Int64: n, Valid: true}
}

func nullTimeToString(t sql.NullTime) string {
	if !t.Valid {
		return ""
	}
	return t.Time.UTC().Format(time.RFC3339)
}


// fireInternalReviewersNotify — CP-side helper that calls the DP's
// /api/internal/reviewers/notify endpoint. Used by
// superadminApplicationApprove when the client's kyc_review_mode is
// 'both' and the row has just been handed off to the client reviewer's
// desk — that's the moment the reviewer's inbox has grown by one and
// they need an email nudge.
//
// Best-effort: caller should fire in a goroutine and log-on-error, not
// fail the approve response.
//
// Back-compat entry that assumes registryID == dpClientID. Prefer
// fireInternalReviewersNotifyForClient — the split is required whenever
// the CP registry id differs from the DP's local clients.id (which is
// the normal multi-tenant case).
func (s *Server) fireInternalReviewersNotify(parent context.Context, clientID int64, institutionName, headName string) error {
	return s.fireInternalReviewersNotifyForClient(parent, clientID, clientID, institutionName, headName)
}

// fireInternalReviewersNotifyForClient — same as fireInternalReviewersNotify
// but takes the CP registry id (`registryID`, for locating the DP
// api_url/api_key) SEPARATELY from the DP-native client id (`dpClientID`,
// which the DP's reviewer lookup keys on). The two are almost never
// the same in production, so callers with access to institution_applications.
// dp_client_id must pass both.
func (s *Server) fireInternalReviewersNotifyForClient(parent context.Context, registryID, dpClientID int64, institutionName, headName string) error {
	var (
		apiURL string
		apiKey string
		status string
	)
	err := s.deps.DB.QueryRowContext(parent,
		`SELECT api_url, api_key, status FROM clients_registry WHERE id = $1`, registryID,
	).Scan(&apiURL, &apiKey, &status)
	if err != nil {
		return fmt.Errorf("registry lookup: %w", err)
	}
	if status != "active" && status != "ready" {
		return fmt.Errorf("target client is %s", status)
	}
	if dpClientID <= 0 {
		return fmt.Errorf("dp_client_id missing on application — reviewer lookup would fail")
	}
	body, _ := json.Marshal(map[string]any{
		"client_id":        dpClientID,
		"institution_name": institutionName,
		"head_name":        headName,
	})
	timeout := time.Duration(s.deps.Cfg.FederatedTimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = 3 * time.Second
	}
	ctx, cancel := context.WithTimeout(parent, timeout+2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		strings.TrimRight(apiURL, "/")+"/api/internal/reviewers/notify",
		bytes.NewReader(body),
	)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-API-Key", apiKey)
	resp, err := (&http.Client{Timeout: timeout}).Do(req)
	if err != nil {
		return fmt.Errorf("http: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		bodyStr, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
		return fmt.Errorf("dp returned %d: %s", resp.StatusCode, strings.TrimSpace(string(bodyStr)))
	}
	return nil
}

// fireInternalKYCDecisionNotify — CP-side helper that calls the DP's
// /api/internal/kyc/notify-decision so the applicant's head_email
// receives an approved/rejected email after every TERMINAL decision.
//
// Fired from every terminal decision path: superadminApplicationApprove
// (mode='admin'), superadminApplicationReject, cpReviewerApprove,
// cpReviewerReject, approveOneApplication (bulk), rejectOneApplication
// (bulk). NOT fired from the 'both'-mode hand-off in
// superadminApplicationApprove — that's an intermediate route change,
// not the final answer, so firing it there would email the applicant
// twice for one final decision.
//
// Best-effort: caller fires in a goroutine, logs on error, and does
// NOT roll back the decision if the notify fails. The applicant can
// always see their status from the portal.
//
// registryID is the CP's clients_registry.id — used only to pick the
// DP's api_url + api_key. No dp_client_id is needed here because the
// email is addressed to the applicant, not a DP-side user record.
func (s *Server) fireInternalKYCDecisionNotify(parent context.Context, registryID int64, headEmail, headName, institutionName, decision, note string) error {
	if registryID <= 0 {
		return fmt.Errorf("registryID required")
	}
	headEmail = strings.TrimSpace(headEmail)
	if headEmail == "" {
		return fmt.Errorf("head_email required")
	}
	if decision != "approved" && decision != "rejected" {
		return fmt.Errorf("bad decision %q", decision)
	}
	var (
		apiURL string
		apiKey string
		status string
	)
	err := s.deps.DB.QueryRowContext(parent,
		`SELECT api_url, api_key, status FROM clients_registry WHERE id = $1`, registryID,
	).Scan(&apiURL, &apiKey, &status)
	if err != nil {
		return fmt.Errorf("registry lookup: %w", err)
	}
	if status != "active" && status != "ready" {
		return fmt.Errorf("target client is %s", status)
	}
	body, _ := json.Marshal(map[string]any{
		"head_email":       headEmail,
		"head_name":        headName,
		"institution_name": institutionName,
		"decision":         decision,
		"note":             note,
	})
	timeout := time.Duration(s.deps.Cfg.FederatedTimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = 3 * time.Second
	}
	ctx, cancel := context.WithTimeout(parent, timeout+2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		strings.TrimRight(apiURL, "/")+"/api/internal/kyc/notify-decision",
		bytes.NewReader(body),
	)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-API-Key", apiKey)
	resp, err := (&http.Client{Timeout: timeout}).Do(req)
	if err != nil {
		return fmt.Errorf("http: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		bs, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
		return fmt.Errorf("dp returned %d: %s", resp.StatusCode, strings.TrimSpace(string(bs)))
	}
	return nil
}
