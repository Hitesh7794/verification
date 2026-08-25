package api

// Superadmin exam-catalog surface — CRUD for clients (exam bodies),
// exams under them, and per-exam candidate CSV upload.
//
// Route table (all superadmin-only, wired in server.go):
//
//   POST   /api/superadmin/clients                             create client
//   GET    /api/superadmin/clients                             list clients (+ exam counts)
//   GET    /api/superadmin/clients/{id}                        one client with its exams
//   PATCH  /api/superadmin/clients/{id}                        rename / edit notes
//   POST   /api/superadmin/clients/{id}/visibility             toggle visible flag
//   POST   /api/superadmin/clients/{id}/close                  close (marks closed_at)
//   POST   /api/superadmin/clients/{id}/reopen                 undo close
//
//   POST   /api/superadmin/clients/{id}/exams                  create exam under client
//   GET    /api/superadmin/exams/{id}                          one exam + latest uploads
//   PATCH  /api/superadmin/exams/{id}                          rename / edit window
//   POST   /api/superadmin/exams/{id}/visibility               toggle visible flag
//   POST   /api/superadmin/exams/{id}/close                    close
//   POST   /api/superadmin/exams/{id}/reopen                   undo close
//
//   POST   /api/superadmin/exams/{id}/candidates               upload CSV (multipart)
//   GET    /api/superadmin/exams/{id}/candidates               list candidates (paginated)
//   GET    /api/superadmin/exams/{id}/uploads                  raw-upload history
//   GET    /api/superadmin/exams/{id}/uploads/{upload_id}/raw  download original CSV
//
// CSV format is strict — reject-whole-file-or-nothing:
//   header row required: name, roll_no, verification_date (case-insensitive,
//   extra columns ignored)
//   every row must have all 3 values present
//   verification_date parseable as YYYY-MM-DD or DD/MM/YYYY
//   no duplicate roll_no inside one file

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/veni/neet-verification/internal/db"
)

func boolToInt(b bool) int { if b { return 1 }; return 0 }

// ── config ────────────────────────────────────────────────────────────

const (
	maxExamCSVBytes     = 20 << 20 // 20 MB cap on a single CSV
	maxCandidatesPerCSV = 500_000  // sanity cap on rows
)

// ── DTOs ──────────────────────────────────────────────────────────────

type clientRow struct {
	ID             int64      `json:"id"`
	Name           string     `json:"name"`
	Notes          string     `json:"notes,omitempty"`
	Visible        bool       `json:"visible"`
	Closed         bool       `json:"closed"`
	PortalEnabled  bool       `json:"portal_enabled"`
	KYCReviewMode  string     `json:"kyc_review_mode"` // 'admin' | 'client' | 'both'
	ClosedAt       *time.Time `json:"closed_at,omitempty"`
	ExamCount      int64      `json:"exam_count"`
	CreatedAt      time.Time  `json:"created_at"`
	UpdatedAt      time.Time  `json:"updated_at"`
}

// normalizeKYCReviewMode returns the string unchanged if it's one of the
// three accepted modes, or "admin" for anything else (empty, garbage).
// Callers use this so a client that predates V15 (no mode in the JSON
// payload) defaults to the safe "admin-only" review path.
func normalizeKYCReviewMode(s string) string {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "admin", "client", "both":
		return strings.ToLower(strings.TrimSpace(s))
	}
	return "admin"
}

type examRow struct {
	ID                int64      `json:"id"`
	ClientID          int64      `json:"client_id"`
	ClientName        string     `json:"client_name,omitempty"`
	Name              string     `json:"name"`
	ExamCode          string     `json:"exam_code"`
	TrustviewRef      string     `json:"trustview_ref,omitempty"`
	VerificationFrom  string     `json:"verification_from"` // YYYY-MM-DD
	VerificationTo    string     `json:"verification_to"`
	Visible           bool       `json:"visible"`
	Closed            bool       `json:"closed"`
	ClosedAt          *time.Time `json:"closed_at,omitempty"`
	CandidateCount    int64      `json:"candidate_count"`
	CreatedAt         time.Time  `json:"created_at"`
	UpdatedAt         time.Time  `json:"updated_at"`
	RequiresFace      bool       `json:"requires_face"`
	RequiresFP        bool       `json:"requires_fp"`
	RequiresIris      bool       `json:"requires_iris"`
}

type candidateRow struct {
	ID               int64  `json:"id"`
	RollNo           string `json:"roll_no"`
	Name             string `json:"name"`
	VerificationDate string `json:"verification_date,omitempty"`
	CreatedAt        string `json:"created_at"`
}

type uploadRow struct {
	ID          int64     `json:"id"`
	Filename    string    `json:"filename"`
	SizeBytes   int64     `json:"size_bytes"`
	SHA256      string    `json:"sha256"`
	RowsSeeded  int64     `json:"rows_seeded"`
	UploadedBy  string    `json:"uploaded_by,omitempty"`
	UploadedAt  time.Time `json:"uploaded_at"`
}

// ── CLIENTS ───────────────────────────────────────────────────────────

type createClientReq struct {
	Name          string `json:"name"`
	Notes         string `json:"notes"`
	KYCReviewMode string `json:"kyc_review_mode"` // 'admin' | 'client' | 'both'; default 'admin'
}

func (s *Server) superadminCreateClient(w http.ResponseWriter, r *http.Request) {
	var req createClientReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	name := strings.TrimSpace(req.Name)
	if len(name) < 2 || len(name) > 200 {
		writeErr(w, http.StatusBadRequest, "name required (2-200 chars)")
		return
	}
	notes := strings.TrimSpace(req.Notes)
	mode := normalizeKYCReviewMode(req.KYCReviewMode)
	var id int64
	if err := s.deps.DB.QueryRowContext(r.Context(),
		`INSERT INTO clients(name, notes, kyc_review_mode) VALUES($1, $2, $3) RETURNING id`,
		name, nullable(notes), mode,
	).Scan(&id); err != nil {
		writeErr(w, http.StatusInternalServerError, "db insert: "+err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id, "name": name, "kyc_review_mode": mode})
}

func (s *Server) superadminListClients(w http.ResponseWriter, r *http.Request) {
	rows, err := s.deps.DB.QueryContext(r.Context(), `
		SELECT c.id, c.name, COALESCE(c.notes,''),
		       c.visible, c.closed, c.kyc_review_mode,
		       c.closed_at, c.created_at, c.updated_at,
		       (SELECT COUNT(*) FROM exams e WHERE e.client_id = c.id) AS exam_count
		FROM clients c
		ORDER BY c.created_at DESC`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	defer rows.Close()
	out := []clientRow{}
	for rows.Next() {
		var c clientRow
		var visible, closed int
		var closedAt sql.NullTime
		if err := rows.Scan(&c.ID, &c.Name, &c.Notes, &visible, &closed,
			&c.KYCReviewMode,
			&closedAt, &c.CreatedAt, &c.UpdatedAt, &c.ExamCount); err != nil {
			writeErr(w, http.StatusInternalServerError, "row scan: "+err.Error())
			return
		}
		c.Visible = visible == 1
		c.Closed = closed == 1
		if closedAt.Valid {
			c.ClosedAt = &closedAt.Time
		}
		out = append(out, c)
	}
	writeJSON(w, http.StatusOK, map[string]any{"clients": out})
}

func (s *Server) superadminGetClient(w http.ResponseWriter, r *http.Request) {
	id, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	c, err := s.loadClient(r.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "client not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	exams, err := s.listExamsForClient(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"client": c, "exams": exams})
}

type patchClientReq struct {
	Name          *string `json:"name,omitempty"`
	Notes         *string `json:"notes,omitempty"`
	KYCReviewMode *string `json:"kyc_review_mode,omitempty"`
}

func (s *Server) superadminPatchClient(w http.ResponseWriter, r *http.Request) {
	id, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	var req patchClientReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	sets := []string{}
	args := []any{}
	if req.Name != nil {
		n := strings.TrimSpace(*req.Name)
		if len(n) < 2 || len(n) > 200 {
			writeErr(w, http.StatusBadRequest, "name required (2-200 chars)")
			return
		}
		sets = append(sets, "name = ?")
		args = append(args, n)
	}
	if req.Notes != nil {
		sets = append(sets, "notes = ?")
		args = append(args, nullable(strings.TrimSpace(*req.Notes)))
	}
	if req.KYCReviewMode != nil {
		mode := normalizeKYCReviewMode(*req.KYCReviewMode)
		sets = append(sets, "kyc_review_mode = ?")
		args = append(args, mode)
	}
	if len(sets) == 0 {
		writeErr(w, http.StatusBadRequest, "nothing to update")
		return
	}
	sets = append(sets, "updated_at = CURRENT_TIMESTAMP")
	args = append(args, id)
	if _, err := s.deps.DB.ExecContext(r.Context(),
		db.Q("UPDATE clients SET "+strings.Join(sets, ", ")+" WHERE id = ?"), args...); err != nil {
		writeErr(w, http.StatusInternalServerError, "db update: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) superadminToggleClientVisibility(w http.ResponseWriter, r *http.Request) {
	s.toggleFlag(w, r, "clients", "visible")
}

func (s *Server) superadminCloseClient(w http.ResponseWriter, r *http.Request) {
	s.setCloseFlag(w, r, "clients", true)
}

func (s *Server) superadminReopenClient(w http.ResponseWriter, r *http.Request) {
	s.setCloseFlag(w, r, "clients", false)
}

// DELETE /api/superadmin/clients/{id}
//
// Hard-deletes a client row. Refuses if the client still has exams —
// "End" (close) is the reversible action for shutting down a client;
// delete is only for wiping a genuinely-empty test client. The exams
// FK is intentionally not ON DELETE CASCADE so this can't nuke a
// client's whole history in one click.
func (s *Server) superadminDeleteClient(w http.ResponseWriter, r *http.Request) {
	id, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	var examCount int
	if err := s.deps.DB.QueryRowContext(r.Context(),
		`SELECT COUNT(*) FROM exams WHERE client_id = $1`, id,
	).Scan(&examCount); err != nil {
		writeErr(w, http.StatusInternalServerError, "db count: "+err.Error())
		return
	}
	if examCount > 0 {
		writeErr(w, http.StatusConflict, fmt.Sprintf(
			"cannot delete client — it still has %d exam(s). Delete the exams first, or use End to close the client.",
			examCount))
		return
	}
	res, err := s.deps.DB.ExecContext(r.Context(),
		`DELETE FROM clients WHERE id = $1`, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db delete: "+err.Error())
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeErr(w, http.StatusNotFound, "client not found")
		return
	}
	s.auditFromRequest(r, "client.delete", "client", id, nil)
	w.WriteHeader(http.StatusNoContent)
}

// ── EXAMS ─────────────────────────────────────────────────────────────

type createExamReq struct {
	Name             string `json:"name"`
	ExamCode         string `json:"exam_code"`
	TrustviewRef     string `json:"trustview_ref"`
	VerificationFrom string `json:"verification_from"` // YYYY-MM-DD
	VerificationTo   string `json:"verification_to"`
	// Per-exam biometric requirements. Omit any to accept the defaults
	// (face + fp on, iris off). At least one must be true.
	RequiresFace *bool `json:"requires_face,omitempty"`
	RequiresFP   *bool `json:"requires_fp,omitempty"`
	RequiresIris *bool `json:"requires_iris,omitempty"`
}

func (s *Server) superadminCreateExam(w http.ResponseWriter, r *http.Request) {
	clientID, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad client id")
		return
	}
	// Confirm client exists so the FK error becomes a clean 404.
	if _, err := s.loadClient(r.Context(), clientID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "client not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	var req createExamReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
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
		writeErr(w, http.StatusBadRequest, "verification_from must be a valid date/time (YYYY-MM-DD or YYYY-MM-DDTHH:MM)")
		return
	}
	toT, err := parseDateTimeWindow(to, true)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "verification_to must be a valid date/time (YYYY-MM-DD or YYYY-MM-DDTHH:MM)")
		return
	}
	if fromT.After(toT) {
		writeErr(w, http.StatusBadRequest, "verification_from must be <= verification_to")
		return
	}
	// Modality flags. Defaults match the migration-022 defaults; caller
	// can override any/all. At least one must end up true.
	rFace := true
	rFP := true
	rIris := false
	if req.RequiresFace != nil { rFace = *req.RequiresFace }
	if req.RequiresFP   != nil { rFP   = *req.RequiresFP }
	if req.RequiresIris != nil { rIris = *req.RequiresIris }
	if !rFace && !rFP && !rIris {
		writeErr(w, http.StatusBadRequest, "at least one biometric must be required (face, fp, or iris)")
		return
	}

	var id int64
	if err := s.deps.DB.QueryRowContext(r.Context(), `
		INSERT INTO exams(client_id, name, exam_code, trustview_ref,
		                  verification_from, verification_to,
		                  requires_face, requires_fp, requires_iris)
		VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING id`,
		clientID, name, code, nullable(strings.TrimSpace(req.TrustviewRef)),
		fromT.Format("2006-01-02T15:04:05Z07:00"), toT.Format("2006-01-02T15:04:05Z07:00"),
		boolToInt(rFace), boolToInt(rFP), boolToInt(rIris)).Scan(&id); err != nil {
		if isUniqueViolation(err) {
			el := strings.ToLower(err.Error())
			if strings.Contains(el, "exam_code") || strings.Contains(el, "idx_exams_code") {
				writeErr(w, http.StatusConflict,
					"An exam with this code already exists. Please choose a different code.")
				return
			}
		}
		writeErr(w, http.StatusInternalServerError, "db insert: "+err.Error())
		return
	}

	// V15 fan-out (2026-08-25): grant the new exam to every org whose
	// KYC has already been approved under this client. Without this,
	// exams created after an org's approval would show 'Available'
	// forever with no way for the admin to gain access — the org's
	// only entry point (KYC-approval fan-out) already ran once and
	// missed the newly-created exam.
	//
	// Mirror image of application_review_shared.go's fan-out at
	// approve time: same ON CONFLICT DO UPDATE shape, same
	// approval_type='blanket_client' marker so the CSV export can tell
	// how the row was minted. reviewed_by is the caller (a superadmin)
	// via claimsFrom; NULL is fine for legacy pre-JWT callers.
	var reviewer any
	if c := claimsFrom(r); c != nil {
		reviewer = c.UserID
	}
	if _, err := s.deps.DB.ExecContext(r.Context(), `
		INSERT INTO organization_exam_subscriptions(
		    org_id, exam_id, status, approval_type,
		    subscribed_by, requested_at,
		    reviewed_at, reviewed_by, review_note)
		SELECT DISTINCT
		       u.org_id, $1, 'approved', 'blanket_client',
		       $2, NOW(),
		       NOW(), $2, 'Auto-granted on new-exam create (V15)'
		  FROM users u
		 WHERE u.role = 'admin' AND u.org_id IS NOT NULL
		   AND EXISTS (
		     SELECT 1 FROM institution_applications a
		      WHERE a.status = 'approved'
		        AND a.client_id = $3
		        AND LOWER(TRIM(a.institution_name)) = LOWER(TRIM(
		          COALESCE((SELECT name FROM organizations o WHERE o.id = u.org_id), '')
		        ))
		   )
		ON CONFLICT (org_id, exam_id) DO UPDATE SET
		    status = 'approved',
		    approval_type = EXCLUDED.approval_type,
		    reviewed_at = EXCLUDED.reviewed_at,
		    reviewed_by = EXCLUDED.reviewed_by,
		    review_note = EXCLUDED.review_note`,
		id, reviewer, clientID,
	); err != nil {
		// Log the fan-out failure but don't roll back the exam create —
		// a superadmin can still trigger it later (rerun this handler
		// or hit a future backfill script) and the exam itself is live.
		log.Printf("superadminCreateExam: fan-out to approved orgs failed exam=%d client=%d: %v",
			id, clientID, err)
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"id": id, "name": name, "exam_code": code,
	})
}

func (s *Server) superadminGetExam(w http.ResponseWriter, r *http.Request) {
	id, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	e, err := s.loadExam(r.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "exam not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	uploads, err := s.listUploadsForExam(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"exam": e, "uploads": uploads})
}

type patchExamReq struct {
	Name             *string `json:"name,omitempty"`
	TrustviewRef     *string `json:"trustview_ref,omitempty"`
	VerificationFrom *string `json:"verification_from,omitempty"`
	VerificationTo   *string `json:"verification_to,omitempty"`
	RequiresFace     *bool   `json:"requires_face,omitempty"`
	RequiresFP       *bool   `json:"requires_fp,omitempty"`
	RequiresIris     *bool   `json:"requires_iris,omitempty"`
}

func (s *Server) superadminPatchExam(w http.ResponseWriter, r *http.Request) {
	id, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	var req patchExamReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	sets := []string{}
	args := []any{}
	if req.Name != nil {
		n := strings.TrimSpace(*req.Name)
		if len(n) < 2 || len(n) > 200 {
			writeErr(w, http.StatusBadRequest, "name required (2-200 chars)")
			return
		}
		sets = append(sets, "name = ?")
		args = append(args, n)
	}
	if req.TrustviewRef != nil {
		sets = append(sets, "trustview_ref = ?")
		args = append(args, nullable(strings.TrimSpace(*req.TrustviewRef)))
	}
	if req.VerificationFrom != nil {
		f := strings.TrimSpace(*req.VerificationFrom)
		fromT, err := parseDateTimeWindow(f, false)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "verification_from must be a valid date/time (YYYY-MM-DD or YYYY-MM-DDTHH:MM)")
			return
		}
		sets = append(sets, "verification_from = ?")
		args = append(args, fromT.Format("2006-01-02T15:04:05Z07:00"))
	}
	if req.VerificationTo != nil {
		t := strings.TrimSpace(*req.VerificationTo)
		toT, err := parseDateTimeWindow(t, true)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "verification_to must be a valid date/time (YYYY-MM-DD or YYYY-MM-DDTHH:MM)")
			return
		}
		sets = append(sets, "verification_to = ?")
		args = append(args, toT.Format("2006-01-02T15:04:05Z07:00"))
	}
	// Per-exam modality toggles. If any modality bit was passed, we
	// validate the final set (post-update) still has at least one
	// biometric required -- fetch the current row to compute.
	if req.RequiresFace != nil || req.RequiresFP != nil || req.RequiresIris != nil {
		var curFace, curFP, curIris bool
		if err := s.deps.DB.QueryRowContext(r.Context(),
			`SELECT requires_face, requires_fp, requires_iris FROM exams WHERE id = $1`, id,
		).Scan(&curFace, &curFP, &curIris); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				writeErr(w, http.StatusNotFound, "exam not found")
				return
			}
			writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
			return
		}
		newFace := curFace
		newFP := curFP
		newIris := curIris
		if req.RequiresFace != nil { newFace = *req.RequiresFace }
		if req.RequiresFP   != nil { newFP   = *req.RequiresFP }
		if req.RequiresIris != nil { newIris = *req.RequiresIris }
		if !newFace && !newFP && !newIris {
			writeErr(w, http.StatusBadRequest, "at least one biometric must be required (face, fp, or iris)")
			return
		}
		if req.RequiresFace != nil { sets = append(sets, "requires_face = ?"); args = append(args, boolToInt(newFace)) }
		if req.RequiresFP   != nil { sets = append(sets, "requires_fp = ?");   args = append(args, boolToInt(newFP))   }
		if req.RequiresIris != nil { sets = append(sets, "requires_iris = ?"); args = append(args, boolToInt(newIris)) }
	}
	if len(sets) == 0 {
		writeErr(w, http.StatusBadRequest, "nothing to update")
		return
	}
	sets = append(sets, "updated_at = CURRENT_TIMESTAMP")
	args = append(args, id)
	if _, err := s.deps.DB.ExecContext(r.Context(),
		db.Q("UPDATE exams SET "+strings.Join(sets, ", ")+" WHERE id = ?"), args...); err != nil {
		if strings.Contains(err.Error(), "CHECK constraint failed") {
			writeErr(w, http.StatusBadRequest, "verification_from must be <= verification_to")
			return
		}
		writeErr(w, http.StatusInternalServerError, "db update: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) superadminToggleExamVisibility(w http.ResponseWriter, r *http.Request) {
	s.toggleFlag(w, r, "exams", "visible")
}

func (s *Server) superadminCloseExam(w http.ResponseWriter, r *http.Request) {
	s.setCloseFlag(w, r, "exams", true)
}

func (s *Server) superadminReopenExam(w http.ResponseWriter, r *http.Request) {
	s.setCloseFlag(w, r, "exams", false)
}

// DELETE /api/superadmin/exams/{id}
//
// Hard-deletes an exam. Refuses if any verification row references a
// candidate in this exam — those are financial + audit records and
// mustn't be silently orphaned. If the exam is clean of verifications,
// the delete cascades to exam_candidates, exam_centres, exam_csv_uploads,
// organization_exam_subscriptions, and operator_exams via their FKs.
func (s *Server) superadminDeleteExam(w http.ResponseWriter, r *http.Request) {
	id, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	// verifications don't have an FK on exam_id — the link is via the
	// candidate roll. So we count verifications whose roll matches any
	// candidate in this exam.
	var verCount int
	if err := s.deps.DB.QueryRowContext(r.Context(), `
		SELECT COUNT(*)
		  FROM verifications v
		  JOIN exam_candidates ec ON ec.roll_no = v.roll_no
		 WHERE ec.exam_id = $1
	`, id).Scan(&verCount); err != nil {
		writeErr(w, http.StatusInternalServerError, "db count: "+err.Error())
		return
	}
	if verCount > 0 {
		writeErr(w, http.StatusConflict, fmt.Sprintf(
			"cannot delete exam — %d verification(s) reference candidates in this exam. Use End to close it instead (existing data preserved).",
			verCount))
		return
	}
	res, err := s.deps.DB.ExecContext(r.Context(),
		`DELETE FROM exams WHERE id = $1`, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db delete: "+err.Error())
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeErr(w, http.StatusNotFound, "exam not found")
		return
	}
	s.auditFromRequest(r, "exam.delete", "exam", id, nil)
	w.WriteHeader(http.StatusNoContent)
}

// ── CSV UPLOAD + CANDIDATES ───────────────────────────────────────────

type csvValidationErr struct {
	Line int    `json:"line"`
	Msg  string `json:"msg"`
}

type csvUploadResp struct {
	UploadID    int64              `json:"upload_id"`
	RowsSeeded  int                `json:"rows_seeded"`
	SHA256      string             `json:"sha256"`
	Filename    string             `json:"filename"`
	ValidationErrors []csvValidationErr `json:"validation_errors,omitempty"`
}

func (s *Server) superadminUploadExamCSV(w http.ResponseWriter, r *http.Request) {
	examID, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad exam id")
		return
	}
	if _, err := s.loadExam(r.Context(), examID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "exam not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxExamCSVBytes)
	if err := r.ParseMultipartForm(maxExamCSVBytes); err != nil {
		writeErr(w, http.StatusBadRequest, "multipart parse: "+err.Error())
		return
	}
	file, hdr, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "file required (form field 'file')")
		return
	}
	defer file.Close()

	// Buffer the whole file first so we can (a) hash it, (b) parse it, and
	// (c) if parsing succeeds, persist the exact bytes verbatim to disk.
	// 20 MB max, so no memory pressure.
	buf, err := io.ReadAll(file)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "read: "+err.Error())
		return
	}

	// Parse + validate. Strict: any error aborts the whole upload.
	parsed, verrs := parseCandidateCSV(buf)
	if len(verrs) > 0 {
		writeJSON(w, http.StatusUnprocessableEntity, csvUploadResp{
			ValidationErrors: verrs,
		})
		return
	}
	if len(parsed) == 0 {
		writeErr(w, http.StatusBadRequest, "csv had no data rows")
		return
	}
	if len(parsed) > maxCandidatesPerCSV {
		writeErr(w, http.StatusRequestEntityTooLarge,
			fmt.Sprintf("csv has %d rows, max %d", len(parsed), maxCandidatesPerCSV))
		return
	}

	// Compute hash + persist raw bytes on disk.
	sum := sha256.Sum256(buf)
	hexSum := hex.EncodeToString(sum[:])
	storageDir := filepath.Join(s.deps.Cfg.ArtifactDir, "exam_csvs",
		fmt.Sprintf("%d", examID))
	if err := os.MkdirAll(storageDir, 0o755); err != nil {
		writeErr(w, http.StatusInternalServerError, "mkdir: "+err.Error())
		return
	}
	origName := filepath.Base(hdr.Filename)
	if origName == "" || origName == "." || origName == "/" {
		origName = "upload.csv"
	}
	fname := fmt.Sprintf("%d_%s_%s.csv", time.Now().UnixNano(), hexSum[:8],
		safeSlug(strings.TrimSuffix(origName, filepath.Ext(origName))))
	storagePath := filepath.Join(storageDir, fname)
	if err := writeAtomic(storagePath, buf); err != nil {
		writeErr(w, http.StatusInternalServerError, "write: "+err.Error())
		return
	}

	// Insert candidates + upload record in a single transaction.
	tx, err := s.deps.DB.BeginTx(r.Context(), nil)
	if err != nil {
		_ = os.Remove(storagePath)
		writeErr(w, http.StatusInternalServerError, "db begin: "+err.Error())
		return
	}
	defer tx.Rollback()

	// UPSERT semantics: same (exam_id, roll_no) → update every mutable
	// field from the CSV. Keeps the CSV as source of truth for that pair
	// without exploding on re-upload. Extended columns (registration_id,
	// father_name, dob, gender, shift_name, centre_code) are all
	// nullable — a bare 3-column CSV leaves them NULL.
	stmt, err := tx.PrepareContext(r.Context(), `
		INSERT INTO exam_candidates(
			exam_id, roll_no, name, verification_date,
			registration_id, father_name, dob, gender, shift_name, centre_code
		)
		VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		ON CONFLICT(exam_id, roll_no) DO UPDATE SET
			name              = excluded.name,
			verification_date = excluded.verification_date,
			registration_id   = excluded.registration_id,
			father_name       = excluded.father_name,
			dob               = excluded.dob,
			gender            = excluded.gender,
			shift_name        = excluded.shift_name,
			centre_code       = excluded.centre_code`)
	if err != nil {
		_ = os.Remove(storagePath)
		writeErr(w, http.StatusInternalServerError, "db prepare: "+err.Error())
		return
	}
	defer stmt.Close()

	for _, p := range parsed {
		if _, err := stmt.ExecContext(r.Context(),
			examID, p.rollNo, p.name, nullable(p.verificationDate),
			nullable(p.registrationID), nullable(p.fatherName), nullable(p.dob),
			nullable(p.gender), nullable(p.shiftName), nullable(p.centreCode),
		); err != nil {
			_ = os.Remove(storagePath)
			writeErr(w, http.StatusInternalServerError, "db insert row: "+err.Error())
			return
		}
	}

	claims := claimsFrom(r)
	var uploaderID int64
	if claims != nil {
		uploaderID = claims.UserID
	}
	var uploadID int64
	if err := tx.QueryRowContext(r.Context(), `
		INSERT INTO exam_csv_uploads(exam_id, filename, storage_path, size_bytes,
		                             sha256, uploaded_by, rows_seeded)
		VALUES($1, $2, $3, $4, $5, $6, $7)
		RETURNING id`,
		examID, origName, storagePath, int64(len(buf)), hexSum,
		uploaderID, int64(len(parsed))).Scan(&uploadID); err != nil {
		_ = os.Remove(storagePath)
		writeErr(w, http.StatusInternalServerError, "db upload record: "+err.Error())
		return
	}
	if err := tx.Commit(); err != nil {
		_ = os.Remove(storagePath)
		writeErr(w, http.StatusInternalServerError, "db commit: "+err.Error())
		return
	}

	writeJSON(w, http.StatusCreated, csvUploadResp{
		UploadID:   uploadID,
		RowsSeeded: len(parsed),
		SHA256:     hexSum,
		Filename:   origName,
	})
}

func (s *Server) superadminListCandidates(w http.ResponseWriter, r *http.Request) {
	examID, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad exam id")
		return
	}
	limit := 100
	offset := 0
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 1000 {
			limit = n
		}
	}
	if v := r.URL.Query().Get("offset"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			offset = n
		}
	}
	rows, err := s.deps.DB.QueryContext(r.Context(), `
		SELECT id, roll_no, name, verification_date, created_at
		FROM exam_candidates
		WHERE exam_id = $1
		ORDER BY id
		LIMIT $2 OFFSET $3`, examID, limit, offset)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	defer rows.Close()
	out := []candidateRow{}
	for rows.Next() {
		var c candidateRow
		var vdate sql.NullString
		if err := rows.Scan(&c.ID, &c.RollNo, &c.Name, &vdate, &c.CreatedAt); err != nil {
			writeErr(w, http.StatusInternalServerError, "row scan: "+err.Error())
			return
		}
		if vdate.Valid {
			c.VerificationDate = vdate.String
		}
		out = append(out, c)
	}
	var total int64
	_ = s.deps.DB.QueryRowContext(r.Context(),
		`SELECT COUNT(*) FROM exam_candidates WHERE exam_id = $1`, examID).Scan(&total)
	writeJSON(w, http.StatusOK, map[string]any{
		"candidates": out,
		"total":      total,
		"limit":      limit,
		"offset":     offset,
	})
}

func (s *Server) superadminListUploads(w http.ResponseWriter, r *http.Request) {
	examID, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad exam id")
		return
	}
	ups, err := s.listUploadsForExam(r.Context(), examID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"uploads": ups})
}

func (s *Server) superadminDownloadRawCSV(w http.ResponseWriter, r *http.Request) {
	uploadID, err := parseInt64(chi.URLParam(r, "upload_id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad upload id")
		return
	}
	var path, filename string
	err = s.deps.DB.QueryRowContext(r.Context(),
		`SELECT storage_path, filename FROM exam_csv_uploads WHERE id = $1`,
		uploadID).Scan(&path, &filename)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "upload not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	f, err := os.Open(path)
	if err != nil {
		writeErr(w, http.StatusNotFound, "file gone: "+err.Error())
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "text/csv")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`attachment; filename="%s"`, safeSlug(filename)))
	_, _ = io.Copy(w, f)
}

// ── shared helpers ────────────────────────────────────────────────────

// loadClient fetches one client + its exam count. Returns sql.ErrNoRows if
// the row is missing so callers can 404.
func (s *Server) loadClient(ctx context.Context, id int64) (*clientRow, error) {
	var c clientRow
	var visible, closed int
	var closedAt sql.NullTime
	err := s.deps.DB.QueryRowContext(ctx, db.Q(`
		SELECT c.id, c.name, COALESCE(c.notes,''),
		       c.visible, c.closed, c.portal_enabled, c.kyc_review_mode,
		       c.closed_at, c.created_at, c.updated_at,
		       (SELECT COUNT(*) FROM exams e WHERE e.client_id = c.id) AS exam_count
		FROM clients c WHERE c.id = $1`), id).Scan(
		&c.ID, &c.Name, &c.Notes, &visible, &closed, &c.PortalEnabled, &c.KYCReviewMode,
		&closedAt, &c.CreatedAt, &c.UpdatedAt, &c.ExamCount)
	if err != nil {
		return nil, err
	}
	c.Visible = visible == 1
	c.Closed = closed == 1
	if closedAt.Valid {
		c.ClosedAt = &closedAt.Time
	}
	return &c, nil
}

func (s *Server) loadExam(ctx context.Context, id int64) (*examRow, error) {
	var e examRow
	var visible, closed int
	var closedAt sql.NullTime
	var trustview sql.NullString
	var reqFace, reqFP, reqIris int
	err := s.deps.DB.QueryRowContext(ctx, db.Q(`
		SELECT e.id, e.client_id, c.name, e.name, e.exam_code, e.trustview_ref,
		       COALESCE(TO_CHAR(e.verification_from, 'YYYY-MM-DD"T"HH24:MI'), ''),
		       COALESCE(TO_CHAR(e.verification_to,   'YYYY-MM-DD"T"HH24:MI'), ''),
		       e.visible, e.closed,
		       e.closed_at, e.created_at, e.updated_at,
		       e.requires_face, e.requires_fp, e.requires_iris,
		       (SELECT COUNT(*) FROM exam_candidates ec WHERE ec.exam_id = e.id)
		FROM exams e JOIN clients c ON c.id = e.client_id
		WHERE e.id = $1`), id).Scan(
		&e.ID, &e.ClientID, &e.ClientName, &e.Name, &e.ExamCode, &trustview,
		&e.VerificationFrom, &e.VerificationTo, &visible, &closed,
		&closedAt, &e.CreatedAt, &e.UpdatedAt,
		&reqFace, &reqFP, &reqIris,
		&e.CandidateCount)
	if err != nil {
		return nil, err
	}
	e.Visible = visible == 1
	e.Closed = closed == 1
	e.RequiresFace = reqFace == 1
	e.RequiresFP = reqFP == 1
	e.RequiresIris = reqIris == 1
	if closedAt.Valid {
		e.ClosedAt = &closedAt.Time
	}
	if trustview.Valid {
		e.TrustviewRef = trustview.String
	}
	return &e, nil
}

func (s *Server) listExamsForClient(ctx context.Context, clientID int64) ([]examRow, error) {
	rows, err := s.deps.DB.QueryContext(ctx, db.Q(`
		SELECT e.id, e.client_id, e.name, e.exam_code, e.trustview_ref,
		       COALESCE(TO_CHAR(e.verification_from, 'YYYY-MM-DD"T"HH24:MI'), ''),
		       COALESCE(TO_CHAR(e.verification_to,   'YYYY-MM-DD"T"HH24:MI'), ''),
		       e.visible, e.closed,
		       e.closed_at, e.created_at, e.updated_at,
		       e.requires_face, e.requires_fp, e.requires_iris,
		       (SELECT COUNT(*) FROM exam_candidates ec WHERE ec.exam_id = e.id)
		FROM exams e WHERE e.client_id = $1
		ORDER BY e.created_at DESC`), clientID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []examRow{}
	for rows.Next() {
		var e examRow
		var visible, closed int
		var reqFace, reqFP, reqIris int
		var closedAt sql.NullTime
		var trustview sql.NullString
		if err := rows.Scan(&e.ID, &e.ClientID, &e.Name, &e.ExamCode, &trustview,
			&e.VerificationFrom, &e.VerificationTo, &visible, &closed,
			&closedAt, &e.CreatedAt, &e.UpdatedAt,
			&reqFace, &reqFP, &reqIris,
			&e.CandidateCount); err != nil {
			return nil, err
		}
		e.Visible = visible == 1
		e.Closed = closed == 1
		e.RequiresFace = reqFace == 1
		e.RequiresFP = reqFP == 1
		e.RequiresIris = reqIris == 1
		if closedAt.Valid {
			e.ClosedAt = &closedAt.Time
		}
		if trustview.Valid {
			e.TrustviewRef = trustview.String
		}
		out = append(out, e)
	}
	return out, nil
}

func (s *Server) listUploadsForExam(ctx context.Context, examID int64) ([]uploadRow, error) {
	rows, err := s.deps.DB.QueryContext(ctx, db.Q(`
		SELECT u.id, u.filename, u.size_bytes, u.sha256, u.rows_seeded,
		       COALESCE(usr.username,''), u.uploaded_at
		FROM exam_csv_uploads u
		LEFT JOIN users usr ON usr.id = u.uploaded_by
		WHERE u.exam_id = $1 ORDER BY u.uploaded_at DESC LIMIT 50`), examID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []uploadRow{}
	for rows.Next() {
		var u uploadRow
		if err := rows.Scan(&u.ID, &u.Filename, &u.SizeBytes, &u.SHA256,
			&u.RowsSeeded, &u.UploadedBy, &u.UploadedAt); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, nil
}

// toggleFlag flips a 0/1 column on a row and bumps updated_at. Table
// name and column name are validated against a whitelist so this can't
// be abused to touch other tables.
func (s *Server) toggleFlag(w http.ResponseWriter, r *http.Request, table, col string) {
	if table != "clients" && table != "exams" {
		writeErr(w, http.StatusInternalServerError, "bad table")
		return
	}
	if col != "visible" {
		writeErr(w, http.StatusInternalServerError, "bad column")
		return
	}
	id, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	q := fmt.Sprintf(
		"UPDATE %s SET %s = 1 - %s, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
		table, col, col)
	res, err := s.deps.DB.ExecContext(r.Context(), db.Q(q), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db update: "+err.Error())
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		writeErr(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) setCloseFlag(w http.ResponseWriter, r *http.Request, table string, closed bool) {
	if table != "clients" && table != "exams" {
		writeErr(w, http.StatusInternalServerError, "bad table")
		return
	}
	id, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	var q string
	if closed {
		q = fmt.Sprintf(
			"UPDATE %s SET closed = 1, closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
			table)
	} else {
		q = fmt.Sprintf(
			"UPDATE %s SET closed = 0, closed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
			table)
	}
	res, err := s.deps.DB.ExecContext(r.Context(), db.Q(q), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db update: "+err.Error())
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		writeErr(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ── CSV parsing ───────────────────────────────────────────────────────

type parsedRow struct {
	rollNo           string
	name             string
	verificationDate string // YYYY-MM-DD or empty

	// Optional fields — all may be empty. Present when the CSV carries
	// extra columns from the extended template (candidates_template.csv).
	// These land on the PDF receipt at verification time.
	registrationID string
	fatherName     string
	dob            string // YYYY-MM-DD or empty
	gender         string
	shiftName      string
	centreCode     string
}

// parseCandidateCSV enforces the strict spec on the two required
// columns (name + roll_no) and opportunistically picks up extended
// fields when present.
//
//   - Header row required (any casing).
//   - Must contain columns: name, roll_no.
//   - Optional columns picked up when present: verification_date,
//     registration_id, fname (father name), dob, gender, shift_name,
//     centre_code. Unknown columns are ignored.
//   - Every data row must have name + roll_no non-empty.
//   - verification_date + dob parseable as YYYY-MM-DD or DD/MM/YYYY
//     when present; validated only if provided.
//   - Duplicate roll_no inside one file is a hard error.
//
// verification_date used to be mandatory (matching the original 3-column
// template) but the extended NEET-style template omits it entirely, so
// it's now optional — absent → NULL on the DB row.
//
// Returns (rows, errors). Any non-empty errors list means the caller
// must reject the upload — nothing gets seeded.
func parseCandidateCSV(buf []byte) ([]parsedRow, []csvValidationErr) {
	rd := csv.NewReader(strings.NewReader(string(buf)))
	rd.FieldsPerRecord = -1 // tolerate rows with extra trailing columns

	header, err := rd.Read()
	if err != nil {
		return nil, []csvValidationErr{{Line: 1, Msg: "could not read header: " + err.Error()}}
	}
	nameIdx, rollIdx, dateIdx := -1, -1, -1
	regIdx, fnameIdx, dobIdx, genderIdx, shiftIdx, centreIdx := -1, -1, -1, -1, -1, -1
	for i, h := range header {
		h = strings.ToLower(strings.TrimSpace(h))
		switch h {
		case "name":
			nameIdx = i
		case "roll_no", "rollno", "roll":
			rollIdx = i
		case "verification_date", "verification date", "date":
			dateIdx = i
		case "registration_id", "registrationid", "reg_id", "regid":
			regIdx = i
		case "fname", "father_name", "father", "fathers_name":
			fnameIdx = i
		case "dob", "date_of_birth", "birth_date":
			dobIdx = i
		case "gender", "sex":
			genderIdx = i
		case "shift_name", "shift":
			shiftIdx = i
		case "centre_code", "center_code", "centercode", "centrecode":
			centreIdx = i
		}
	}
	if nameIdx < 0 || rollIdx < 0 {
		return nil, []csvValidationErr{{Line: 1,
			Msg: "header must contain 'name' and 'roll_no'"}}
	}

	// Pull a cell by index; returns "" if index missing or out of range.
	pick := func(row []string, idx int) string {
		if idx < 0 || idx >= len(row) {
			return ""
		}
		return strings.TrimSpace(row[idx])
	}

	var out []parsedRow
	var verrs []csvValidationErr
	seen := map[string]int{} // roll_no → line-number of first sighting
	line := 1
	for {
		row, err := rd.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		line++
		if err != nil {
			verrs = append(verrs, csvValidationErr{Line: line, Msg: err.Error()})
			continue
		}
		name := pick(row, nameIdx)
		roll := pick(row, rollIdx)
		if name == "" || roll == "" {
			verrs = append(verrs, csvValidationErr{Line: line,
				Msg: "name and roll_no are required"})
			continue
		}
		// verification_date is optional; validate only if provided.
		dateRaw := pick(row, dateIdx)
		normDate := ""
		if dateRaw != "" {
			nd, ok := normaliseDate(dateRaw)
			if !ok {
				verrs = append(verrs, csvValidationErr{Line: line,
					Msg: "verification_date must be YYYY-MM-DD or DD/MM/YYYY"})
				continue
			}
			normDate = nd
		}
		if prev, dup := seen[roll]; dup {
			verrs = append(verrs, csvValidationErr{Line: line,
				Msg: fmt.Sprintf("duplicate roll_no %q (first at line %d)", roll, prev)})
			continue
		}
		// Optional DOB — validated only if provided.
		dobRaw := pick(row, dobIdx)
		dobNorm := ""
		if dobRaw != "" {
			if d, ok := normaliseDate(dobRaw); ok {
				dobNorm = d
			} else {
				verrs = append(verrs, csvValidationErr{Line: line,
					Msg: "dob must be YYYY-MM-DD or DD/MM/YYYY"})
				continue
			}
		}
		seen[roll] = line
		out = append(out, parsedRow{
			rollNo:           roll,
			name:             name,
			verificationDate: normDate,
			registrationID:   pick(row, regIdx),
			fatherName:       pick(row, fnameIdx),
			dob:              dobNorm,
			gender:           pick(row, genderIdx),
			shiftName:        pick(row, shiftIdx),
			centreCode:       pick(row, centreIdx),
		})
	}
	return out, verrs
}

func normaliseDate(s string) (string, bool) {
	for _, layout := range []string{"2006-01-02", "02/01/2006", "2/1/2006"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.Format("2006-01-02"), true
		}
	}
	return "", false
}

func max3(a, b, c int) int {
	m := a
	if b > m {
		m = b
	}
	if c > m {
		m = c
	}
	return m
}

// safeSlug scrubs a filename component to safe chars (keeps ASCII
// alphanumerics, dash, underscore). Prevents path traversal via
// Content-Disposition or on-disk name.
func safeSlug(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z',
			r >= 'A' && r <= 'Z',
			r >= '0' && r <= '9',
			r == '_' || r == '-' || r == '.':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	out := b.String()
	if out == "" {
		return "file"
	}
	return out
}

func writeAtomic(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
