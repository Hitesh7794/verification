package api

// GET /api/admin/kyc-status — always accessible to an authenticated
// admin regardless of their org's KYC review state. Powers the
// frontend lock screen: the admin's dashboard calls this on mount, and
// renders the pending / rejected / approved view based on what comes
// back. Never gated by requireApprovedKYC.
//
// Response shape:
//
//   {
//     "state":        "pending" | "approved" | "rejected" | "unknown",
//     "institution_name": "...",
//     "review_note":  "...",           // optional, populated on reject/approve
//     "submitted_at": "2026-08-25T...", // when it went to 'pending'
//     "reviewed_at":  "2026-08-25T..."  // when it left 'pending'
//   }
//
// 'unknown' means the org has no linked institution_application (a
// legacy org from before the V17 rebuild, or one seeded directly by
// superadmin). We treat that as approved for gating purposes so the
// UI shows the full dashboard.

import (
	"database/sql"
	"errors"
	"net/http"
	"time"
)

type kycStatusResp struct {
	State           string `json:"state"`
	InstitutionName string `json:"institution_name,omitempty"`
	ReviewNote      string `json:"review_note,omitempty"`
	SubmittedAt     string `json:"submitted_at,omitempty"`
	ReviewedAt      string `json:"reviewed_at,omitempty"`
}

func (s *Server) adminKYCStatus(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r)
	if claims == nil || claims.OrgID == nil {
		writeErr(w, http.StatusForbidden, "admin org context required")
		return
	}
	var (
		status, instName, note sql.NullString
		submittedAt, reviewedAt sql.NullTime
	)
	err := s.deps.DB.QueryRowContext(r.Context(), `
		SELECT a.status, a.institution_name, a.review_note, a.created_at, a.reviewed_at
		  FROM organizations o
		  LEFT JOIN institution_applications a ON a.id = o.application_id
		 WHERE o.id = $1`, *claims.OrgID,
	).Scan(&status, &instName, &note, &submittedAt, &reviewedAt)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	out := kycStatusResp{State: "unknown"}
	if status.Valid && status.String != "" {
		out.State = status.String
	}
	if instName.Valid {
		out.InstitutionName = instName.String
	}
	if note.Valid {
		out.ReviewNote = note.String
	}
	if submittedAt.Valid {
		out.SubmittedAt = submittedAt.Time.UTC().Format(time.RFC3339)
	}
	if reviewedAt.Valid {
		out.ReviewedAt = reviewedAt.Time.UTC().Format(time.RFC3339)
	}
	writeJSON(w, http.StatusOK, out)
}
