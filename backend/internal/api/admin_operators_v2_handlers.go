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
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"strconv"
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
	rows, err := s.deps.DB.QueryContext(r.Context(), db.Q(`
		SELECT id, username, COALESCE(password_plaintext,''), display_name,
		       COALESCE(email,''), COALESCE(phone,''), disabled_at,
		       spending_cap_paise, spent_paise,
		       valid_from, valid_to, created_at
		FROM users
		WHERE org_id = ? AND role = 'client'
		ORDER BY created_at DESC, id DESC`), orgID)
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
		erows, err := s.deps.DB.QueryContext(r.Context(), db.Q(`
			SELECT oe.user_id, oe.exam_id
			  FROM operator_exams oe
			  JOIN users u ON u.id = oe.user_id
			 WHERE u.org_id = ?`), orgID)
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
	err := s.deps.DB.QueryRowContext(r.Context(), db.Q(`
		SELECT id, username, COALESCE(password_plaintext,''), display_name,
		       COALESCE(email,''), COALESCE(phone,''), disabled_at,
		       spending_cap_paise, spent_paise,
		       valid_from, valid_to, created_at
		  FROM users
		 WHERE id = ? AND org_id = ? AND role = 'client'`), id, orgID,
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
		db.Q(`SELECT exam_id FROM operator_exams WHERE user_id = ?`), id)
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

// validateOperatorWindowAgainstExam ensures the operator validity window [opFromStr, opToStr]
// is strictly within the exam's superadmin-defined verification window [examFrom, examTo].
func validateOperatorWindowAgainstExam(opFromStr, opToStr string, examFrom, examTo sql.NullString) error {
	var opFrom, opTo time.Time
	var hasOpFrom, hasOpTo bool

	if s := strings.TrimSpace(opFromStr); s != "" {
		if t, err := parseDateTimeWindow(s, false); err == nil {
			opFrom = t
			hasOpFrom = true
		}
	}
	if s := strings.TrimSpace(opToStr); s != "" {
		if t, err := parseDateTimeWindow(s, true); err == nil {
			opTo = t
			hasOpTo = true
		}
	}

	ist := time.FixedZone("IST", 5*3600+30*60)

	if examFrom.Valid && strings.TrimSpace(examFrom.String) != "" {
		if ef, err := parseDateTimeWindow(examFrom.String, false); err == nil {
			if hasOpFrom && opFrom.Before(ef) {
				return fmt.Errorf("valid_from (%s) cannot be earlier than exam verification start (%s)",
					opFrom.In(ist).Format("2006-01-02 15:04"),
					ef.In(ist).Format("2006-01-02 15:04"))
			}
		}
	}

	if examTo.Valid && strings.TrimSpace(examTo.String) != "" {
		if et, err := parseDateTimeWindow(examTo.String, true); err == nil {
			if hasOpTo && opTo.After(et) {
				return fmt.Errorf("valid_to (%s) cannot be later than exam verification end (%s)",
					opTo.In(ist).Format("2006-01-02 15:04"),
					et.In(ist).Format("2006-01-02 15:04"))
			}
		}
	}

	return nil
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
		writeErr(w, http.StatusBadRequest, "phone number must be a valid 10-digit Indian mobile (starting 6/7/8/9, +91 optional)")
		return
	}
	if len(req.ExamIDs) == 0 {
		writeErr(w, http.StatusBadRequest, "a verification agent must be assigned to at least one exam")
		return
	}
	// One agent = one exam. Multi-assignment was briefly enabled by V18
	// (2026-08-26) and reverted by V27 (this fix) because it made
	// per-exam wallet accounting + audit scoping fragile.
	if len(req.ExamIDs) > 1 {
		writeErr(w, http.StatusBadRequest,
			"a verification agent can only be assigned to ONE exam — pick a single exam per agent")
		return
	}
	for _, eid := range req.ExamIDs {
		var eFrom, eTo sql.NullString
		if err := s.deps.DB.QueryRowContext(r.Context(), db.Q(`
			SELECT verification_from, verification_to FROM exams WHERE id = ?`), eid).Scan(&eFrom, &eTo); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				writeErr(w, http.StatusBadRequest, fmt.Sprintf("assigned exam %d does not exist", eid))
				return
			}
			writeErr(w, http.StatusInternalServerError, "db check exam: "+err.Error())
			return
		}
		if err := validateOperatorWindowAgainstExam(req.ValidFrom, req.ValidTo, eFrom, eTo); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
	}

	// Pre-check uniqueness (case-insensitive) to give a clean 409
	// instead of a raw "UNIQUE constraint failed" error. Scoped to
	// this admin's org so the same person can be provisioned as an
	// operator under multiple orgs (migration V6). The DB index
	// enforces the same (org_id, LOWER(email)) tuple at commit time.
	var dupID int64
	if err := s.deps.DB.QueryRowContext(r.Context(), db.Q(
		`SELECT id FROM users
		 WHERE org_id = ? AND email IS NOT NULL AND LOWER(email) = LOWER(?)
		 LIMIT 1`),
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
	if err := tx.QueryRowContext(r.Context(), db.Q(`
		INSERT INTO users(username, password_hash, role, org_id,
		                  display_name, email, phone, password_plaintext,
		                  spending_cap_paise, valid_from, valid_to)
		VALUES(?, ?, 'client', ?, ?, ?, ?, ?, ?, ?, ?)
		RETURNING id`),
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

// ── BULK CREATE OPERATORS CSV ─────────────────────────────────────────

type parsedBulkOperator struct {
	Username         string
	Password         string
	DisplayName      string
	Email            string
	Phone            string
	SpendingCapPaise *int64
	ValidFrom        string
	ValidTo          string
	ExamCodes        []string
	Line             int
}

func parseBulkOperatorsCSV(buf []byte) ([]parsedBulkOperator, []csvValidationErr) {
	head := buf
	if len(head) > 4096 {
		head = head[:4096]
	}
	rd := csv.NewReader(strings.NewReader(string(buf)))
	rd.Comma = sniffCSVDelimiter(head)
	rd.FieldsPerRecord = -1
	rd.LazyQuotes = true

	hdr, err := rd.Read()
	if err != nil {
		return nil, []csvValidationErr{{Line: 1, Msg: "cannot read header: " + err.Error()}}
	}

	uIdx, pIdx, dIdx, fIdx, lIdx, eIdx, phIdx, capIdx, fromIdx, toIdx, examIdx := -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1

	for i, raw := range hdr {
		key := strings.ToLower(strings.TrimSpace(raw))
		key = strings.TrimPrefix(key, "\ufeff")
		switch key {
		case "username", "user", "login":
			uIdx = i
		case "password", "pass", "pwd":
			pIdx = i
		case "display_name", "displayname", "name", "full_name", "fullname":
			dIdx = i
		case "first_name", "firstname":
			fIdx = i
		case "last_name", "lastname":
			lIdx = i
		case "email", "mail", "email_address":
			eIdx = i
		case "phone", "mobile", "phone_number", "mobile_number", "contact":
			phIdx = i
		case "cap_amount", "spending_cap", "spending_cap_rupees", "cap_rupees", "spending_cap_paise", "cap", "cap_in_rupees":
			capIdx = i
		case "valid_from", "from", "start_date", "start_time", "start":
			fromIdx = i
		case "valid_to", "to", "end_date", "end_time", "end":
			toIdx = i
		case "exam_codes", "exams", "exam_code", "exam":
			examIdx = i
		}
	}

	if uIdx < 0 || pIdx < 0 || eIdx < 0 {
		return nil, []csvValidationErr{{Line: 1,
			Msg: "header must contain at least 'username', 'password', and 'email'"}}
	}

	pick := func(row []string, idx int) string {
		if idx < 0 || idx >= len(row) {
			return ""
		}
		return strings.TrimSpace(row[idx])
	}

	var out []parsedBulkOperator
	var verrs []csvValidationErr
	seenUsers := map[string]int{}
	seenEmails := map[string]int{}
	seenPhones := map[string]int{}
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

		empty := true
		for _, cell := range row {
			if strings.TrimSpace(cell) != "" {
				empty = false
				break
			}
		}
		if empty {
			continue
		}

		username := pick(row, uIdx)
		password := pick(row, pIdx)
		email := strings.ToLower(pick(row, eIdx))
		phone := normalizePhone(pick(row, phIdx))
		displayName := pick(row, dIdx)
		if displayName == "" {
			fn := pick(row, fIdx)
			ln := pick(row, lIdx)
			if fn != "" || ln != "" {
				displayName = strings.TrimSpace(fn + " " + ln)
			} else {
				displayName = username
			}
		}

		if len(username) < 3 || len(username) > 60 {
			verrs = append(verrs, csvValidationErr{Line: line, Msg: "username required (3-60 characters)"})
			continue
		}
		if strings.ContainsAny(username, " \t\r\n") {
			verrs = append(verrs, csvValidationErr{Line: line, Msg: "username cannot contain spaces"})
			continue
		}

		if err := validatePassword(password); err != nil {
			verrs = append(verrs, csvValidationErr{Line: line, Msg: "password: " + err.Error()})
			continue
		}

		if email == "" {
			verrs = append(verrs, csvValidationErr{Line: line, Msg: "email is required"})
			continue
		}
		if !isPlausibleEmail(email) {
			verrs = append(verrs, csvValidationErr{Line: line, Msg: fmt.Sprintf("email %q is not a valid address", email)})
			continue
		}

		if phone == "" {
			verrs = append(verrs, csvValidationErr{Line: line, Msg: "phone number is required"})
			continue
		}
		if !isPlausiblePhone(phone) {
			verrs = append(verrs, csvValidationErr{Line: line, Msg: fmt.Sprintf("phone %q must be a valid 10-digit Indian mobile (starting 6/7/8/9, +91 optional)", phone)})
			continue
		}

		// Check duplicates within CSV
		uLower := strings.ToLower(username)
		if prev, dup := seenUsers[uLower]; dup {
			verrs = append(verrs, csvValidationErr{Line: line, Msg: fmt.Sprintf("duplicate username %q in CSV (first on line %d)", username, prev)})
			continue
		}
		seenUsers[uLower] = line

		if prev, dup := seenEmails[email]; dup {
			verrs = append(verrs, csvValidationErr{Line: line, Msg: fmt.Sprintf("duplicate email %q in CSV (first on line %d)", email, prev)})
			continue
		}
		seenEmails[email] = line

		if prev, dup := seenPhones[phone]; dup {
			verrs = append(verrs, csvValidationErr{Line: line, Msg: fmt.Sprintf("duplicate phone %q in CSV (first on line %d)", phone, prev)})
			continue
		}
		seenPhones[phone] = line

		// Spending cap parsing
		var spendingCapPaise *int64
		capStr := pick(row, capIdx)
		if capStr != "" {
			capStr = strings.TrimPrefix(capStr, "₹")
			capStr = strings.TrimPrefix(capStr, "Rs.")
			capStr = strings.TrimPrefix(capStr, "INR")
			capStr = strings.TrimSpace(capStr)
			val, err := strconv.ParseFloat(capStr, 64)
			if err != nil || val < 1.0 {
				verrs = append(verrs, csvValidationErr{Line: line, Msg: fmt.Sprintf("spending cap %q must be a valid number >= ₹1", capStr)})
				continue
			}
			paise := int64(math.Round(val * 100))
			spendingCapPaise = &paise
		}

		// Windows: optional
		fromStr := pick(row, fromIdx)
		toStr := pick(row, toIdx)
		if fromStr != "" || toStr != "" {
			_, _, err = parseDateWindow(fromStr, toStr)
			if err != nil {
				verrs = append(verrs, csvValidationErr{Line: line, Msg: err.Error()})
				continue
			}
		}

		// Exam codes
		var examCodes []string
		rawExams := pick(row, examIdx)
		if rawExams != "" {
			f := func(c rune) bool {
				return c == ',' || c == ';' || c == '|'
			}
			for _, part := range strings.FieldsFunc(rawExams, f) {
				cleanCode := strings.ToUpper(strings.TrimSpace(part))
				if cleanCode != "" {
					examCodes = append(examCodes, cleanCode)
				}
			}
		}

		out = append(out, parsedBulkOperator{
			Username:         username,
			Password:         password,
			DisplayName:      displayName,
			Email:            email,
			Phone:            phone,
			SpendingCapPaise: spendingCapPaise,
			ValidFrom:        fromStr,
			ValidTo:          toStr,
			ExamCodes:        examCodes,
			Line:             line,
		})
	}

	return out, verrs
}

func (s *Server) adminBulkCreateOperatorsCSV(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r)
	if claims == nil || claims.OrgID == nil {
		writeErr(w, http.StatusForbidden, "admin org context required")
		return
	}
	orgID := *claims.OrgID

	r.Body = http.MaxBytesReader(w, r.Body, maxExamCSVBytes)
	if err := r.ParseMultipartForm(maxExamCSVBytes); err != nil {
		writeErr(w, http.StatusBadRequest, "multipart parse: "+err.Error())
		return
	}
	file, _, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "file required (form field 'file')")
		return
	}
	defer file.Close()

	buf, err := io.ReadAll(file)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "read file: "+err.Error())
		return
	}

	parsed, verrs := parseBulkOperatorsCSV(buf)
	if len(verrs) > 0 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
			"validation_errors": verrs,
		})
		return
	}
	if len(parsed) == 0 {
		writeErr(w, http.StatusBadRequest, "csv contains no data rows")
		return
	}
	if len(parsed) > 1000 {
		writeErr(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("csv has %d operators, max 1000 per bulk upload", len(parsed)))
		return
	}

	// 1. Check spending caps against org's wallet balance
	walletBal, err := s.wallet.Balance(r.Context(), orgID)
	if err == nil {
		for _, p := range parsed {
			if p.SpendingCapPaise != nil && *p.SpendingCapPaise > int64(walletBal) {
				verrs = append(verrs, csvValidationErr{
					Line: p.Line,
					Msg: fmt.Sprintf("spending cap ₹%.2f exceeds current wallet balance ₹%.2f",
						float64(*p.SpendingCapPaise)/100, float64(walletBal)/100),
				})
			}
		}
	}
	if len(verrs) > 0 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
			"validation_errors": verrs,
		})
		return
	}

	// 2. Check for username collisions
	userMap := make(map[string]int, len(parsed))
	uPlaceholders := make([]string, len(parsed))
	uArgs := make([]any, len(parsed))
	for i, p := range parsed {
		uLower := strings.ToLower(p.Username)
		userMap[uLower] = p.Line
		uPlaceholders[i] = "?"
		uArgs[i] = uLower
	}

	uq := "SELECT username FROM users WHERE LOWER(username) IN (" + strings.Join(uPlaceholders, ",") + ")"
	uRows, err := s.deps.DB.QueryContext(r.Context(), db.Q(uq), uArgs...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db check existing usernames: "+err.Error())
		return
	}
	defer uRows.Close()

	for uRows.Next() {
		var u string
		if err := uRows.Scan(&u); err == nil {
			lineNum := userMap[strings.ToLower(u)]
			verrs = append(verrs, csvValidationErr{
				Line: lineNum,
				Msg:  fmt.Sprintf("username %q already taken", u),
			})
		}
	}

	// 3. Check for email collisions in this org
	emailMap := make(map[string]int, len(parsed))
	ePlaceholders := make([]string, len(parsed))
	eArgs := make([]any, len(parsed)+1)
	eArgs[0] = orgID
	for i, p := range parsed {
		emailMap[p.Email] = p.Line
		ePlaceholders[i] = "?"
		eArgs[i+1] = p.Email
	}

	eq := "SELECT email FROM users WHERE org_id = ? AND LOWER(email) IN (" + strings.Join(ePlaceholders, ",") + ")"
	eRows, err := s.deps.DB.QueryContext(r.Context(), db.Q(eq), eArgs...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db check existing emails: "+err.Error())
		return
	}
	defer eRows.Close()

	for eRows.Next() {
		var e string
		if err := eRows.Scan(&e); err == nil {
			lineNum := emailMap[strings.ToLower(e)]
			verrs = append(verrs, csvValidationErr{
				Line: lineNum,
				Msg:  fmt.Sprintf("email %q already registered in this organisation", e),
			})
		}
	}

	if len(verrs) > 0 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
			"validation_errors": verrs,
		})
		return
	}

	// 4. Resolve org's active subscribed exams
	type subExamInfo struct {
		ID               int64
		ExamCode         string
		VerificationFrom sql.NullString
		VerificationTo   sql.NullString
	}

	subExamsRows, err := s.deps.DB.QueryContext(r.Context(), db.Q(`
		SELECT e.id, UPPER(e.exam_code), e.verification_from, e.verification_to
		FROM exams e
		JOIN organization_exam_subscriptions s ON s.exam_id = e.id
		WHERE s.org_id = ? AND s.status = 'approved'`), orgID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db load subscriptions: "+err.Error())
		return
	}
	defer subExamsRows.Close()

	codeToExamMap := make(map[string]subExamInfo)
	idToExamMap := make(map[int64]subExamInfo)
	allSubExamIDs := make([]int64, 0)
	for subExamsRows.Next() {
		var ex subExamInfo
		if err := subExamsRows.Scan(&ex.ID, &ex.ExamCode, &ex.VerificationFrom, &ex.VerificationTo); err == nil {
			codeToExamMap[ex.ExamCode] = ex
			idToExamMap[ex.ID] = ex
			allSubExamIDs = append(allSubExamIDs, ex.ID)
		}
	}

	// Check default exam id passed in form field (if any)
	var defaultExamID *int64
	if defExamsStr := r.FormValue("default_exam_ids"); defExamsStr != "" {
		for _, part := range strings.Split(defExamsStr, ",") {
			if n, err := strconv.ParseInt(strings.TrimSpace(part), 10, 64); err == nil && n > 0 {
				defaultExamID = &n
				break
			}
		}
	}
	if defaultExamID == nil && len(allSubExamIDs) == 1 {
		defaultExamID = &allSubExamIDs[0]
	}

	// Validate exam assignments and dates for each operator (can be assigned to one or more exams, within each exam's window)
	for _, p := range parsed {
		if len(p.ExamCodes) > 0 {
			for _, c := range p.ExamCodes {
				if ex, ok := codeToExamMap[c]; ok {
					if err := validateOperatorWindowAgainstExam(p.ValidFrom, p.ValidTo, ex.VerificationFrom, ex.VerificationTo); err != nil {
						verrs = append(verrs, csvValidationErr{
							Line: p.Line,
							Msg:  fmt.Sprintf("for exam %s: %s", c, err.Error()),
						})
					}
				} else {
					verrs = append(verrs, csvValidationErr{
						Line: p.Line,
						Msg:  fmt.Sprintf("unknown or unsubscribed exam_code %q", c),
					})
				}
			}
		} else if defaultExamID != nil {
			if ex, ok := idToExamMap[*defaultExamID]; ok {
				if err := validateOperatorWindowAgainstExam(p.ValidFrom, p.ValidTo, ex.VerificationFrom, ex.VerificationTo); err != nil {
					verrs = append(verrs, csvValidationErr{
						Line: p.Line,
						Msg:  err.Error(),
					})
				}
			}
		} else if len(allSubExamIDs) == 1 {
			ex := idToExamMap[allSubExamIDs[0]]
			if err := validateOperatorWindowAgainstExam(p.ValidFrom, p.ValidTo, ex.VerificationFrom, ex.VerificationTo); err != nil {
				verrs = append(verrs, csvValidationErr{
					Line: p.Line,
					Msg:  err.Error(),
				})
			}
		} else {
			if len(allSubExamIDs) == 0 {
				verrs = append(verrs, csvValidationErr{
					Line: p.Line,
					Msg:  "your organisation has no approved exam subscriptions to assign agents to",
				})
			} else {
				verrs = append(verrs, csvValidationErr{
					Line: p.Line,
					Msg:  "no exam specified in row (please specify 'exam_codes' column or select a fallback exam)",
				})
			}
		}
	}
	if len(verrs) > 0 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
			"validation_errors": verrs,
		})
		return
	}

	tx, err := s.deps.DB.BeginTx(r.Context(), nil)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db begin: "+err.Error())
		return
	}
	defer tx.Rollback()

	type createdOpResult struct {
		ID          int64  `json:"id"`
		Username    string `json:"username"`
		DisplayName string `json:"display_name"`
		Email       string `json:"email"`
		Phone       string `json:"phone"`
	}

	var createdOps []createdOpResult

	for _, p := range parsed {
		hash, err := bcrypt.GenerateFromPassword([]byte(p.Password), bcrypt.DefaultCost)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, fmt.Sprintf("bcrypt on line %d: %v", p.Line, err))
			return
		}

		vFrom, vTo, _ := parseDateWindow(p.ValidFrom, p.ValidTo)

		var uid int64
		err = tx.QueryRowContext(r.Context(), db.Q(`
			INSERT INTO users(username, password_hash, role, org_id,
			                  display_name, email, phone, password_plaintext,
			                  spending_cap_paise, valid_from, valid_to)
			VALUES(?, ?, 'client', ?, ?, ?, ?, ?, ?, ?, ?)
			RETURNING id`),
			p.Username, string(hash), orgID, p.DisplayName,
			nullable(p.Email), nullable(p.Phone), p.Password,
			nullableInt64(p.SpendingCapPaise), vFrom, vTo).Scan(&uid)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, fmt.Sprintf("db insert line %d: %v", p.Line, err))
			return
		}

		// Determine assigned exams: explicit in CSV > default form value / single sub
		var targetExamIDs []int64
		if len(p.ExamCodes) > 0 {
			for _, c := range p.ExamCodes {
				if ex, ok := codeToExamMap[c]; ok {
					targetExamIDs = append(targetExamIDs, ex.ID)
				}
			}
		} else if defaultExamID != nil {
			targetExamIDs = []int64{*defaultExamID}
		} else if len(allSubExamIDs) == 1 {
			targetExamIDs = []int64{allSubExamIDs[0]}
		}

		// V27 restore: one agent = one exam. If a CSV row lists two or
		// more codes, keep just the first (matches the DB constraint,
		// gives the operator a predictable subset instead of failing
		// the whole row).
		if len(targetExamIDs) > 1 {
			targetExamIDs = targetExamIDs[:1]
		}

		if err := s.setOperatorExams(tx, orgID, uid, targetExamIDs); err != nil {
			writeErr(w, http.StatusInternalServerError, fmt.Sprintf("db link exams line %d: %v", p.Line, err))
			return
		}

		createdOps = append(createdOps, createdOpResult{
			ID:          uid,
			Username:    p.Username,
			DisplayName: p.DisplayName,
			Email:       p.Email,
			Phone:       p.Phone,
		})
	}

	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "db commit: "+err.Error())
		return
	}

	s.auditFromRequest(r, "operator.bulk_create", "org", orgID, map[string]any{
		"count": len(createdOps),
	})

	// Dispatch welcome emails in background
	if s.emailer != nil {
		loginURL := strings.TrimRight(s.deps.Cfg.PublicBaseURL, "/") + "/client/login"
		for _, p := range parsed {
			if p.Email != "" {
				to := p.Email
				body := buildOperatorWelcomeEmail(p.DisplayName, p.Username, p.Password, loginURL)
				go func(sender email.Sender, to, body string) {
					ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
					defer cancel()
					_ = sender.Send(ctx, email.Message{
						To:      to,
						Subject: "Your Verification Portal verification agent account",
						Body:    body,
					})
				}(s.emailer, to, body)
			}
		}
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"rows_created": len(createdOps),
		"operators":    createdOps,
	})
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
			db.Q(`SELECT id FROM users
			      WHERE org_id = ? AND email IS NOT NULL
			        AND LOWER(email) = LOWER(?) AND id != ?
			      LIMIT 1`),
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
			writeErr(w, http.StatusBadRequest, "phone number must be a valid 10-digit Indian mobile (starting 6/7/8/9, +91 optional)")
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

	// Validate date window against assigned exams if dates or exams changed
	if req.ValidFrom != nil || req.ValidTo != nil || req.ExamIDs != nil {
		var curFrom, curTo sql.NullString
		_ = tx.QueryRow(db.Q(`
			SELECT u.valid_from, u.valid_to
			FROM users u
			WHERE u.id = ? AND u.org_id = ?`), id, orgID).Scan(&curFrom, &curTo)

		effFrom := curFrom.String
		if req.ValidFrom != nil {
			effFrom = *req.ValidFrom
		}
		effTo := curTo.String
		if req.ValidTo != nil {
			effTo = *req.ValidTo
		}

		var checkExamIDs []int64
		if req.ExamIDs != nil {
			checkExamIDs = *req.ExamIDs
		} else {
			eRows, err := tx.Query(db.Q(`SELECT exam_id FROM operator_exams WHERE user_id = ?`), id)
			if err == nil {
				for eRows.Next() {
					var eid int64
					if err := eRows.Scan(&eid); err == nil {
						checkExamIDs = append(checkExamIDs, eid)
					}
				}
				eRows.Close()
			}
		}

		for _, eid := range checkExamIDs {
			var eFrom, eTo sql.NullString
			if err := tx.QueryRow(db.Q(`SELECT verification_from, verification_to FROM exams WHERE id = ?`), eid).Scan(&eFrom, &eTo); err == nil {
				if err := validateOperatorWindowAgainstExam(effFrom, effTo, eFrom, eTo); err != nil {
					writeErr(w, http.StatusBadRequest, err.Error())
					return
				}
			}
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
		if len(*req.ExamIDs) > 1 {
			writeErr(w, http.StatusBadRequest,
				"a verification agent can only be assigned to ONE exam — pick a single exam per agent")
			return
		}
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

	// Small tolerance so a form the admin filled in a couple of minutes
	// ago still submits after they wander back to it. Not for future-
	// dating tricks — the check is one-sided (past).
	const skew = 2 * time.Minute
	now := time.Now().UTC()

	if fromStr != "" {
		t, err := parseDateTimeWindow(fromStr, false)
		if err != nil {
			return nil, nil, errors.New("valid_from must be a valid date/time (YYYY-MM-DD or YYYY-MM-DDTHH:MM)")
		}
		fromT = t
		hasFrom = true
		vFrom = t.Format("2006-01-02T15:04:05Z07:00")
		// Reject back-dated activation. An agent whose window starts
		// yesterday is either a data-entry mistake or a compliance
		// question; either way it shouldn't slip through silently.
		if fromT.Add(skew).Before(now) {
			return nil, nil, errors.New("valid_from cannot be in the past")
		}
	}
	if toStr != "" {
		t, err := parseDateTimeWindow(toStr, true)
		if err != nil {
			return nil, nil, errors.New("valid_to must be a valid date/time (YYYY-MM-DD or YYYY-MM-DDTHH:MM)")
		}
		toT = t
		hasTo = true
		vTo = t.Format("2006-01-02T15:04:05Z07:00")
		// Reject already-expired operators. A window that ends before
		// now would create an agent who can never verify anything.
		if toT.Before(now) {
			return nil, nil, errors.New("valid_to cannot be in the past")
		}
	}
	if hasFrom && hasTo && !fromT.Before(toT) {
		return nil, nil, errors.New("valid_from must be strictly before valid_to")
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

// isPlausiblePhone accepts Indian mobile numbers only — the app is
// Indian-market-only and letting a US 15-digit slip through is more
// likely a typo than a legitimate contact. Canonical form is 10
// digits starting 6/7/8/9 (TRAI mobile block). Callers strip +91 /
// 91 prefixes via normalizePhone before this check.
func isPlausiblePhone(s string) bool {
	digits := s
	if strings.HasPrefix(digits, "+91") {
		digits = digits[3:]
	} else if strings.HasPrefix(digits, "+") {
		digits = digits[1:]
	}
	if len(digits) == 12 && strings.HasPrefix(digits, "91") {
		digits = digits[2:]
	}
	if len(digits) != 10 {
		return false
	}
	// TRAI mobile ranges: first digit must be 6/7/8/9. Landlines start
	// 2–5 and would fail this — that's intentional; we want an SMS-able
	// number, not a receptionist line.
	if digits[0] < '6' || digits[0] > '9' {
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

