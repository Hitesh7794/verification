package api

// Phase-2 multi-operator management for the college admin.
//
// The existing "shared operator access" model (one client-role user per
// org, admin sees a single username+password) still works via the older
// endpoints in admin_operator_access_handlers.go. This file adds a
// parallel per-operator surface so a college can run multiple operators,
// each with its own budget + date window + assigned-exams list.
//
//   GET    /api/admin/operators              list org's operators
//   POST   /api/admin/operators              create — {username, password,
//                                            display_name, spending_cap_paise,
//                                            valid_from, valid_to, exam_ids[]}
//   GET    /api/admin/operators/{id}         one operator + assigned exams
//   PATCH  /api/admin/operators/{id}         edit any field incl. exam_ids
//   POST   /api/admin/operators/{id}/disable soft-disable (kicks on next JWT)
//   POST   /api/admin/operators/{id}/enable  restore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"golang.org/x/crypto/bcrypt"

	"github.com/veni/neet-verification/internal/email"
	"github.com/veni/neet-verification/internal/db"
)

// ── DTOs ──────────────────────────────────────────────────────────────

type operatorRow struct {
	ID               int64      `json:"id"`
	Username         string     `json:"username"`
	Password         string     `json:"password,omitempty"` // plaintext, admin visibility only
	DisplayName      string     `json:"display_name"`
	Email            string     `json:"email,omitempty"`
	Phone            string     `json:"phone,omitempty"`
	Status           string     `json:"status"` // active | disabled
	SpendingCapPaise *int64     `json:"spending_cap_paise,omitempty"`
	SpentPaise       int64      `json:"spent_paise"`
	ValidFrom        *string    `json:"valid_from,omitempty"` // YYYY-MM-DD
	ValidTo          *string    `json:"valid_to,omitempty"`
	AssignedExamIDs  []int64    `json:"assigned_exam_ids"`
	CreatedAt        time.Time  `json:"created_at"`
	DisabledAt       *time.Time `json:"disabled_at,omitempty"`
}

// ── LIST ──────────────────────────────────────────────────────────────

func (s *Server) adminListOperators(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r)
	if claims == nil || claims.OrgID == nil {
		writeErr(w, http.StatusForbidden, "admin org context required")
		return
	}
	orgID := *claims.OrgID
	rows, err := s.deps.DB.QueryContext(r.Context(), `
		SELECT id, username, COALESCE(password_plaintext,''), display_name,
		       COALESCE(email,''), COALESCE(phone,''), disabled_at,
		       spending_cap_paise, spent_paise,
		       valid_from, valid_to, created_at
		FROM users
		WHERE org_id = $1 AND role = 'client'
		ORDER BY created_at DESC, id DESC`, orgID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	defer rows.Close()
	out := []operatorRow{}
	for rows.Next() {
		var o operatorRow
		var disabledAt sql.NullTime
		var cap sql.NullInt64
		var vFrom, vTo sql.NullString
		if err := rows.Scan(&o.ID, &o.Username, &o.Password, &o.DisplayName,
			&o.Email, &o.Phone, &disabledAt, &cap, &o.SpentPaise, &vFrom, &vTo, &o.CreatedAt); err != nil {
			writeErr(w, http.StatusInternalServerError, "row scan: "+err.Error())
			return
		}
		o.Status = "active"
		if disabledAt.Valid {
			o.Status = "disabled"
			o.DisabledAt = &disabledAt.Time
		}
		if cap.Valid {
			o.SpendingCapPaise = &cap.Int64
		}
		if vFrom.Valid {
			d := vFrom.String
			if t, err := parseDateTimeWindow(d, false); err == nil {
				d = t.Format("2006-01-02T15:04")
			}
			o.ValidFrom = &d
		}
		if vTo.Valid {
			d := vTo.String
			if t, err := parseDateTimeWindow(d, true); err == nil {
				d = t.Format("2006-01-02T15:04")
			}
			o.ValidTo = &d
		}
		o.AssignedExamIDs = []int64{}
		out = append(out, o)
	}
	// Hydrate exam_ids in one grouped query. Cheap for typical row counts
	// (a college has <100 operators).
	if len(out) > 0 {
		byID := map[int64]*operatorRow{}
		for i := range out {
			byID[out[i].ID] = &out[i]
		}
		erows, err := s.deps.DB.QueryContext(r.Context(), `
			SELECT oe.user_id, oe.exam_id
			  FROM operator_exams oe
			  JOIN users u ON u.id = oe.user_id
			 WHERE u.org_id = $1`, orgID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "db read exams: "+err.Error())
			return
		}
		defer erows.Close()
		for erows.Next() {
			var uid, eid int64
			_ = erows.Scan(&uid, &eid)
			if op, ok := byID[uid]; ok {
				op.AssignedExamIDs = append(op.AssignedExamIDs, eid)
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"operators": out})
}

// ── GET one ───────────────────────────────────────────────────────────

func (s *Server) adminGetOperator(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r)
	if claims == nil || claims.OrgID == nil {
		writeErr(w, http.StatusForbidden, "admin org context required")
		return
	}
	orgID := *claims.OrgID
	id, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	op, err := s.loadOperatorForOrg(r, orgID, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "verification agent not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, op)
}

func (s *Server) loadOperatorForOrg(r *http.Request, orgID, id int64) (*operatorRow, error) {
	var o operatorRow
	var disabledAt sql.NullTime
	var cap sql.NullInt64
	var vFrom, vTo sql.NullString
	err := s.deps.DB.QueryRowContext(r.Context(), `
		SELECT id, username, COALESCE(password_plaintext,''), display_name,
		       COALESCE(email,''), COALESCE(phone,''), disabled_at,
		       spending_cap_paise, spent_paise,
		       valid_from, valid_to, created_at
		  FROM users
		 WHERE id = $1 AND org_id = $2 AND role = 'client'`, id, orgID,
	).Scan(&o.ID, &o.Username, &o.Password, &o.DisplayName,
		&o.Email, &o.Phone, &disabledAt, &cap, &o.SpentPaise, &vFrom, &vTo, &o.CreatedAt)
	if err != nil {
		return nil, err
	}
	o.Status = "active"
	if disabledAt.Valid {
		o.Status = "disabled"
		o.DisabledAt = &disabledAt.Time
	}
	if cap.Valid {
		o.SpendingCapPaise = &cap.Int64
	}
	if vFrom.Valid {
		d := vFrom.String
		if t, err := parseDateTimeWindow(d, false); err == nil {
			d = t.Format("2006-01-02T15:04")
		}
		o.ValidFrom = &d
	}
	if vTo.Valid {
		d := vTo.String
		if t, err := parseDateTimeWindow(d, true); err == nil {
			d = t.Format("2006-01-02T15:04")
		}
		o.ValidTo = &d
	}
	o.AssignedExamIDs = []int64{}
	erows, err := s.deps.DB.QueryContext(r.Context(),
		`SELECT exam_id FROM operator_exams WHERE user_id = $1`, id)
	if err != nil {
		return nil, err
	}
	defer erows.Close()
	for erows.Next() {
		var eid int64
		_ = erows.Scan(&eid)
		o.AssignedExamIDs = append(o.AssignedExamIDs, eid)
	}
	return &o, nil
}

// ── CREATE ────────────────────────────────────────────────────────────

type createOperatorReq struct {
	Username         string  `json:"username"`
	Password         string  `json:"password"`
	DisplayName      string  `json:"display_name"`
	Email            string  `json:"email,omitempty"` // required; welcome mail dispatched
	Phone            string  `json:"phone,omitempty"` // required; admin's own record
	SpendingCapPaise *int64  `json:"spending_cap_paise,omitempty"`
	ValidFrom        string  `json:"valid_from,omitempty"` // YYYY-MM-DD or YYYY-MM-DDTHH:MM
	ValidTo          string  `json:"valid_to,omitempty"`
	ExamIDs          []int64 `json:"exam_ids"`
}

func (s *Server) adminCreateOperator(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r)
	if claims == nil || claims.OrgID == nil {
		writeErr(w, http.StatusForbidden, "admin org context required")
		return
	}
	orgID := *claims.OrgID
	var req createOperatorReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	req.Username = strings.TrimSpace(req.Username)
	req.DisplayName = strings.TrimSpace(req.DisplayName)
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))
	req.Phone = normalizePhone(req.Phone)
	if len(req.Username) < 3 || len(req.Username) > 60 {
		writeErr(w, http.StatusBadRequest, "username required (3-60 chars)")
		return
	}
	if req.Email == "" {
		writeErr(w, http.StatusBadRequest, "email is required")
		return
	}
	if !isPlausibleEmail(req.Email) {
		writeErr(w, http.StatusBadRequest, "email is not a valid address")
		return
	}
	if req.Phone == "" {
		writeErr(w, http.StatusBadRequest, "phone number is required")
		return
	}
	if !isPlausiblePhone(req.Phone) {
		writeErr(w, http.StatusBadRequest, "phone number must be 10–15 digits (optionally starting with +)")
		return
	}
	// Pre-check uniqueness (case-insensitive) to give a clean 409
	// instead of a raw "UNIQUE constraint failed" error. Scoped to
	// this admin's org so the same person can be provisioned as an
	// operator under multiple orgs (migration V6). The DB index
	// enforces the same (org_id, LOWER(email)) tuple at commit time.
	var dupID int64
	if err := s.deps.DB.QueryRowContext(r.Context(),
		`SELECT id FROM users
		 WHERE org_id = $1 AND email IS NOT NULL AND LOWER(email) = LOWER($2)
		 LIMIT 1`,
		orgID, req.Email,
	).Scan(&dupID); err == nil {
		writeErr(w, http.StatusConflict, "a user with this email already exists in this organisation")
		return
	} else if !errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusInternalServerError, "email check: "+err.Error())
		return
	}

	if strings.TrimSpace(req.ValidFrom) == "" || strings.TrimSpace(req.ValidTo) == "" {
		writeErr(w, http.StatusBadRequest, "valid_from and valid_to are required (YYYY-MM-DD or YYYY-MM-DDTHH:MM)")
		return
	}
	if err := validatePassword(req.Password); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.DisplayName == "" {
		req.DisplayName = req.Username
	}
	if req.SpendingCapPaise != nil && *req.SpendingCapPaise < int64(s.deps.Cfg.WalletFeePerLookupPaise) {
		// Cap below one fee = operator can't verify a single roll,
		// which is never what the admin intends. Match the frontend
		// validation (min ₹1) so a direct API call can't bypass.
		writeErr(w, http.StatusBadRequest,
			"Spending cap must be at least ₹1 (one verification), or omitted for no cap.")
		return
	}
	if err := s.checkCapAgainstWallet(r, orgID, req.SpendingCapPaise); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	vFrom, vTo, err := parseDateWindow(req.ValidFrom, req.ValidTo)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "bcrypt: "+err.Error())
		return
	}

	tx, err := s.deps.DB.BeginTx(r.Context(), nil)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db begin")
		return
	}
	defer tx.Rollback()

	// Operators are scoped by their operator_exams entries (chosen from
	// the org's subscribed exams). The legacy centre concept was removed
	// in migration 021.
	var uid int64
	if err := tx.QueryRowContext(r.Context(), `
		INSERT INTO users(username, password_hash, role, org_id,
		                  display_name, email, phone, password_plaintext,
		                  spending_cap_paise, valid_from, valid_to)
		VALUES($1, $2, 'client', $3, $4, $5, $6, $7, $8, $9, $10)
		RETURNING id`,
		req.Username, string(hash), orgID, req.DisplayName,
		nullable(req.Email), nullable(req.Phone), req.Password,
		nullableInt64(req.SpendingCapPaise), vFrom, vTo).Scan(&uid); err != nil {
		if isUniqueViolation(err) && strings.Contains(strings.ToLower(err.Error()), "username") {
			writeErr(w, http.StatusConflict, "username already taken")
			return
		}
		writeErr(w, http.StatusInternalServerError, "db insert: "+err.Error())
		return
	}
	if err := s.setOperatorExams(tx, orgID, uid, req.ExamIDs); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "db commit: "+err.Error())
		return
	}
	s.auditFromRequest(r, "operator.create", "user", uid, map[string]any{
		"username": req.Username,
		"exams":    req.ExamIDs,
		"emailed":  req.Email != "",
	})

	// Best-effort welcome email. Fire-and-forget in a goroutine so a
	// slow SMTP handshake (Gmail STARTTLS can take multiple seconds)
	// doesn't stretch the admin's create-operator response. Any
	// failure is logged; the admin already has the credentials in the
	// API response and can re-share them manually.
	if req.Email != "" && s.emailer != nil {
		loginURL := strings.TrimRight(s.deps.Cfg.PublicBaseURL, "/") + "/client/login"
		to := req.Email
		body := buildOperatorWelcomeEmail(req.DisplayName, req.Username, req.Password, loginURL)
		go func(sender email.Sender) {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			if err := sender.Send(ctx, email.Message{
				To:      to,
				Subject: "Your Verification Portal verification agent account",
				Body:    body,
			}); err != nil {
				log.Printf("welcome email to %s: %v", to, err)
			}
		}(s.emailer)
	}

	op, _ := s.loadOperatorForOrg(r, orgID, uid)
	writeJSON(w, http.StatusCreated, op)
}

// ── PATCH ─────────────────────────────────────────────────────────────

type patchOperatorReq struct {
	DisplayName      *string  `json:"display_name,omitempty"`
	Email            *string  `json:"email,omitempty"` // required if present
	Phone            *string  `json:"phone,omitempty"` // required if present
	Password         *string  `json:"password,omitempty"`     // if present, hash + store plaintext
	SpendingCapPaise *int64   `json:"spending_cap_paise,omitempty"`
	ClearSpendingCap bool     `json:"clear_spending_cap,omitempty"` // sentinel: set to NULL
	ResetSpent       bool     `json:"reset_spent,omitempty"`         // set spent_paise back to 0
	ValidFrom        *string  `json:"valid_from,omitempty"`
	ValidTo          *string  `json:"valid_to,omitempty"`
	ExamIDs          *[]int64 `json:"exam_ids,omitempty"`
}

func (s *Server) adminPatchOperator(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r)
	if claims == nil || claims.OrgID == nil {
		writeErr(w, http.StatusForbidden, "admin org context required")
		return
	}
	orgID := *claims.OrgID
	id, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	var req patchOperatorReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}

	tx, err := s.deps.DB.BeginTx(r.Context(), nil)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db begin")
		return
	}
	defer tx.Rollback()

	// Confirm operator exists and belongs to org (rest of the patch runs
	// UPDATE ... WHERE org_id = ? so this is defence-in-depth).
	var ownedByOrg int64
	if err := tx.QueryRow(db.Q(`SELECT COUNT(*) FROM users WHERE id = $1 AND org_id = $2 AND role = 'client'`),
		id, orgID).Scan(&ownedByOrg); err != nil || ownedByOrg == 0 {
		writeErr(w, http.StatusNotFound, "verification agent not found")
		return
	}

	sets := []string{}
	args := []any{}
	if req.DisplayName != nil {
		n := strings.TrimSpace(*req.DisplayName)
		if n == "" {
			writeErr(w, http.StatusBadRequest, "display_name cannot be empty")
			return
		}
		sets = append(sets, "display_name = ?")
		args = append(args, n)
	}
	if req.Email != nil {
		e := strings.ToLower(strings.TrimSpace(*req.Email))
		if e == "" {
			writeErr(w, http.StatusBadRequest, "email cannot be empty")
			return
		}
		if !isPlausibleEmail(e) {
			writeErr(w, http.StatusBadRequest, "email is not a valid address")
			return
		}
		// Reject if any OTHER user in THIS org has the same email.
		// Scoped to org_id since V6 — a person can legitimately be an
		// operator under a different org with the same email; only
		// collisions inside the caller's own org are the problem.
		var dupID int64
		err := tx.QueryRow(
			`SELECT id FROM users
			 WHERE org_id = $1 AND email IS NOT NULL
			   AND LOWER(email) = LOWER($2) AND id != $3
			 LIMIT 1`,
			orgID, e, id,
		).Scan(&dupID)
		if err == nil {
			writeErr(w, http.StatusConflict, "a user with this email already exists in this organisation")
			return
		} else if !errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusInternalServerError, "email check: "+err.Error())
			return
		}

		sets = append(sets, "email = ?")
		args = append(args, e)
	}
	if req.Phone != nil {
		p := normalizePhone(*req.Phone)
		if p == "" {
			writeErr(w, http.StatusBadRequest, "phone cannot be empty")
			return
		}
		if !isPlausiblePhone(p) {
			writeErr(w, http.StatusBadRequest, "phone number must be 10–15 digits (optionally starting with +)")
			return
		}
		sets = append(sets, "phone = ?")
		args = append(args, p)
	}
	if req.Password != nil {
		if err := validatePassword(*req.Password); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		hash, err := bcrypt.GenerateFromPassword([]byte(*req.Password), bcrypt.DefaultCost)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "bcrypt: "+err.Error())
			return
		}
		sets = append(sets, "password_hash = ?", "password_plaintext = ?")
		args = append(args, string(hash), *req.Password)
	}
	if req.ClearSpendingCap {
		sets = append(sets, "spending_cap_paise = NULL")
	} else if req.SpendingCapPaise != nil {
		if *req.SpendingCapPaise < int64(s.deps.Cfg.WalletFeePerLookupPaise) {
			writeErr(w, http.StatusBadRequest,
				"Spending cap must be at least ₹1 (one verification), or use clear_spending_cap to remove.")
			return
		}
		if err := s.checkCapAgainstWallet(r, orgID, req.SpendingCapPaise); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		sets = append(sets, "spending_cap_paise = ?")
		args = append(args, *req.SpendingCapPaise)
	}
	if req.ResetSpent {
		sets = append(sets, "spent_paise = 0")
	}
	if req.ValidFrom != nil || req.ValidTo != nil {
		vFromStr, vToStr := "", ""
		if req.ValidFrom != nil {
			vFromStr = strings.TrimSpace(*req.ValidFrom)
			if vFromStr == "" {
				writeErr(w, http.StatusBadRequest, "valid_from cannot be empty")
				return
			}
		}
		if req.ValidTo != nil {
			vToStr = strings.TrimSpace(*req.ValidTo)
			if vToStr == "" {
				writeErr(w, http.StatusBadRequest, "valid_to cannot be empty")
				return
			}
		}
		vFrom, vTo, err := parseDateWindow(vFromStr, vToStr)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		if req.ValidFrom != nil {
			sets = append(sets, "valid_from = ?")
			args = append(args, vFrom)
		}
		if req.ValidTo != nil {
			sets = append(sets, "valid_to = ?")
			args = append(args, vTo)
		}
	}

	if len(sets) > 0 {
		args = append(args, id, orgID)
		if _, err := tx.ExecContext(r.Context(),
			db.Q("UPDATE users SET "+strings.Join(sets, ", ")+
				" WHERE id = ? AND org_id = ?"), args...); err != nil {
			writeErr(w, http.StatusInternalServerError, "db update: "+err.Error())
			return
		}
	}

	if req.ExamIDs != nil {
		if err := s.setOperatorExams(tx, orgID, id, *req.ExamIDs); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
	}

	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "db commit: "+err.Error())
		return
	}
	s.auditFromRequest(r, "operator.update", "user", id, nil)
	op, _ := s.loadOperatorForOrg(r, orgID, id)
	writeJSON(w, http.StatusOK, op)
}

// ── DISABLE / ENABLE ──────────────────────────────────────────────────

func (s *Server) adminDisableOperator(w http.ResponseWriter, r *http.Request) {
	s.setOperatorDisabled(w, r, true)
}
func (s *Server) adminEnableOperator(w http.ResponseWriter, r *http.Request) {
	s.setOperatorDisabled(w, r, false)
}

func (s *Server) setOperatorDisabled(w http.ResponseWriter, r *http.Request, disabled bool) {
	claims := claimsFrom(r)
	if claims == nil || claims.OrgID == nil {
		writeErr(w, http.StatusForbidden, "admin org context required")
		return
	}
	orgID := *claims.OrgID
	id, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	var q string
	if disabled {
		q = `UPDATE users SET disabled_at = CURRENT_TIMESTAMP
		     WHERE id = $1 AND org_id = $2 AND role = 'client'`
	} else {
		q = `UPDATE users SET disabled_at = NULL
		     WHERE id = $1 AND org_id = $2 AND role = 'client'`
	}
	res, err := s.deps.DB.ExecContext(r.Context(), q, id, orgID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db: "+err.Error())
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		writeErr(w, http.StatusNotFound, "verification agent not found")
		return
	}
	action := "operator.enable"
	if disabled {
		action = "operator.disable"
	}
	s.auditFromRequest(r, action, "user", id, nil)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ── helpers ───────────────────────────────────────────────────────────

func parseDateWindow(fromStr, toStr string) (any, any, error) {
	var vFrom, vTo any
	fromStr = strings.TrimSpace(fromStr)
	toStr = strings.TrimSpace(toStr)
	var fromT, toT time.Time
	var hasFrom, hasTo bool

	if fromStr != "" {
		t, err := parseDateTimeWindow(fromStr, false)
		if err != nil {
			return nil, nil, errors.New("valid_from must be a valid date/time (YYYY-MM-DD or YYYY-MM-DDTHH:MM)")
		}
		fromT = t
		hasFrom = true
		vFrom = t.Format("2006-01-02T15:04:05Z07:00")
	}
	if toStr != "" {
		t, err := parseDateTimeWindow(toStr, true)
		if err != nil {
			return nil, nil, errors.New("valid_to must be a valid date/time (YYYY-MM-DD or YYYY-MM-DDTHH:MM)")
		}
		toT = t
		hasTo = true
		vTo = t.Format("2006-01-02T15:04:05Z07:00")
		// Reject already-expired operators.
		if toT.Before(time.Now().UTC()) {
			return nil, nil, errors.New("valid_to cannot be in the past")
		}
	}
	if hasFrom && hasTo && fromT.After(toT) {
		return nil, nil, errors.New("valid_from must be <= valid_to")
	}
	return vFrom, vTo, nil
}

func nullableInt64(p *int64) any {
	if p == nil {
		return nil
	}
	return *p
}

// Wrapper so the operator handler doesn't need to reach into the
// onboarding-register package's regex directly. Same lax pattern —
// "shape looks like an email address"; delivery is the real validator.
func isPlausibleEmail(s string) bool {
	return reEmail.MatchString(s)
}

// normalizePhone trims whitespace and collapses interior spaces/dashes
// commonly pasted from address books. Leading '+' is preserved. Empty
// input stays empty (caller decides required-vs-optional).
func normalizePhone(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	var b strings.Builder
	b.Grow(len(s))
	for i, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		} else if r == '+' && i == 0 {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// isPlausiblePhone accepts 10–15 digit numbers (optionally prefixed
// with '+' for international format). Loose on purpose — the admin is
// filling in their own record for the agent; the portal doesn't SMS
// or verify it.
func isPlausiblePhone(s string) bool {
	digits := s
	if strings.HasPrefix(digits, "+") {
		digits = digits[1:]
	}
	if len(digits) < 10 || len(digits) > 15 {
		return false
	}
	for _, r := range digits {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// buildOperatorWelcomeEmail composes the plain-text welcome message
// sent to a newly-created operator. Contains their username, the
// admin-chosen password (in plain text because the admin already saw
// it in the API response — this email is purely a delivery
// convenience), and the login URL.
//
// If the admin later rotates the operator's password via the PATCH
// endpoint, this email is NOT resent — the admin is responsible for
// sharing the new credential.
func buildOperatorWelcomeEmail(displayName, username, password, loginURL string) string {
	if displayName == "" {
		displayName = username
	}
	return fmt.Sprintf(`Hello %s,

Your Verification Portal operator account is ready. Sign in and start
verifying candidates.

  Sign-in URL: %s
  Username:    %s
  Password:    %s

Keep this email — the password is not stored elsewhere in a form you
can recover. If you lose it, ask your administrator to reset it from
the portal's Operators page.

— Verification Portal
`, displayName, loginURL, username, password)
}

// checkCapAgainstWallet enforces the rule the admin asked for: a new
// or updated operator spending cap can't exceed the org's current
// wallet balance. Returns a user-facing error string with the numbers
// filled in so the admin can act on it (top up + retry, or use a
// smaller cap).
//
// A NULL cap (no cap at all) is allowed regardless of balance — that's
// the "no ceiling, wallet-empty is the only limit" mode.
//
// This is a per-operator check, not a sum-of-all-operator-caps check.
// Multiple operators can each be capped at ≤ balance; the wallet is
// still a shared pool and gets debited atomically at charge time, so
// the first-come-first-served semantics remain correct.
func (s *Server) checkCapAgainstWallet(r *http.Request, orgID int64, cap *int64) error {
	if cap == nil {
		return nil
	}
	bal, err := s.wallet.Balance(r.Context(), orgID)
	if err != nil {
		return fmt.Errorf("wallet balance lookup: %w", err)
	}
	if int64(bal) < *cap {
		return fmt.Errorf(
			"cap ₹%.2f exceeds wallet balance ₹%.2f — top up the wallet or use a smaller cap",
			float64(*cap)/100, float64(bal)/100,
		)
	}
	return nil
}

