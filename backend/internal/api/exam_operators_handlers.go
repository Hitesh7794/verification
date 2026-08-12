package api

import (
	"database/sql"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"golang.org/x/crypto/bcrypt"
)

// Per-exam bulk operator upload. An admin points at one of their
// subscribed exams and uploads operators_sample_csu8.csv (or any CSV
// with the same headers); each row becomes a `client`-role user in
// the admin's org + one operator_exams row scoped to this exam.
//
//   POST /api/admin/exams/{id}/operators/upload
//
// Fields consumed from the CSV:
//   username    → users.username           (required)
//   password    → users.password_hash      (required, bcrypt)
//   first_name  ┐ combined into            (both required)
//   last_name   ┘ users.display_name
//   email       → users.email              (required)
//
// Fields recognised but currently dropped (no destination column):
//   phone            — no users.phone column yet
//   centre_code      — no operator↔centre link table yet
//   lab_code
//   config_name
//   max_sessions
//
// Password behaviour matches the single-operator flow: bcrypt hash
// stored on password_hash, plaintext echoed back on password_plaintext
// so the admin can hand the credential to the operator once. That's the
// same tradeoff the admin panel already makes.
//
// Idempotency: a re-uploaded CSV upserts. Existing username in the same
// org → operator_exams entry is added for this exam (no password change).
// Existing username in a different org → row rejected.

type parsedOperator struct {
	username    string
	password    string
	firstName   string
	lastName    string
	email       string
	displayName string // firstName + lastName, or firstName alone
}

type operatorUploadResp struct {
	ExamID       int64                `json:"exam_id"`
	RowsCreated  int                  `json:"rows_created"`
	RowsAssigned int                  `json:"rows_assigned"` // already-existing users re-linked
	RowsFailed   int                  `json:"rows_failed"`
	RowErrors    []csvValidationErr   `json:"row_errors,omitempty"`
	SkippedCols  []string             `json:"skipped_columns,omitempty"`
	Assignments  []operatorAssignment `json:"assignments,omitempty"`
}

type operatorAssignment struct {
	Username string `json:"username"`
	UserID   int64  `json:"user_id"`
	Status   string `json:"status"` // created | linked
}

// parseOperatorsCSV is strict on the required fields but tolerant of
// the extra NEET-ops columns (they get reported back in SkippedCols).
func parseOperatorsCSV(buf []byte) ([]parsedOperator, []string, []csvValidationErr) {
	rd := csv.NewReader(strings.NewReader(string(buf)))
	rd.FieldsPerRecord = -1

	header, err := rd.Read()
	if err != nil {
		return nil, nil, []csvValidationErr{{Line: 1, Msg: "could not read header: " + err.Error()}}
	}
	uIdx, pIdx, fIdx, lIdx, eIdx := -1, -1, -1, -1, -1
	// Columns we deliberately drop but report for visibility.
	seenExtras := []string{}
	for i, h := range header {
		key := strings.ToLower(strings.TrimSpace(h))
		switch key {
		case "username":
			uIdx = i
		case "password":
			pIdx = i
		case "first_name", "firstname":
			fIdx = i
		case "last_name", "lastname":
			lIdx = i
		case "email":
			eIdx = i
		case "phone", "mobile", "mobile_number",
			"centre_code", "center_code",
			"lab_code", "config_name", "max_sessions":
			seenExtras = append(seenExtras, key)
		}
	}
	if uIdx < 0 || pIdx < 0 || fIdx < 0 || lIdx < 0 || eIdx < 0 {
		return nil, nil, []csvValidationErr{{Line: 1,
			Msg: "header must contain username, password, first_name, last_name, email"}}
	}

	pick := func(row []string, i int) string {
		if i < 0 || i >= len(row) {
			return ""
		}
		return strings.TrimSpace(row[i])
	}

	var out []parsedOperator
	var verrs []csvValidationErr
	seen := map[string]int{}
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
		u := pick(row, uIdx)
		p := pick(row, pIdx)
		f := pick(row, fIdx)
		l := pick(row, lIdx)
		e := strings.ToLower(pick(row, eIdx))
		if u == "" || p == "" || f == "" || l == "" || e == "" {
			verrs = append(verrs, csvValidationErr{Line: line,
				Msg: "username, password, first_name, last_name and email are all required"})
			continue
		}
		if !isPlausibleEmail(e) {
			verrs = append(verrs, csvValidationErr{Line: line,
				Msg: fmt.Sprintf("email %q is not a valid address", e)})
			continue
		}
		if err := validatePassword(p); err != nil {
			verrs = append(verrs, csvValidationErr{Line: line,
				Msg: fmt.Sprintf("password: %s", err.Error())})
			continue
		}
		if prev, dup := seen[strings.ToLower(u)]; dup {
			verrs = append(verrs, csvValidationErr{Line: line,
				Msg: fmt.Sprintf("duplicate username %q (first at line %d)", u, prev)})
			continue
		}
		seen[strings.ToLower(u)] = line
		out = append(out, parsedOperator{
			username:    u,
			password:    p,
			firstName:   f,
			lastName:    l,
			email:       e,
			displayName: strings.TrimSpace(f + " " + l),
		})
	}
	return out, seenExtras, verrs
}

// uploadExamOperators bulk-creates client-role users under the admin's
// org and links each to the target exam via operator_exams. All
// side-effects happen inside one transaction — if one row breaks
// mid-way (e.g. bcrypt fails) the whole batch rolls back so the CSV
// stays the single source of truth.
func (s *Server) uploadExamOperators(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r)
	if claims == nil || claims.OrgID == nil {
		writeErr(w, http.StatusForbidden, "admin org context required")
		return
	}
	orgID := *claims.OrgID

	idStr := chi.URLParam(r, "id")
	examID, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || examID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid exam id")
		return
	}
	// Admin can only bulk-upload for exams their org has subscribed to.
	if err := s.assertOrgSubscribed(r.Context(), orgID, examID); err != nil {
		writeErr(w, http.StatusNotFound, "exam not found or not subscribed")
		return
	}

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
		writeErr(w, http.StatusBadRequest, "read: "+err.Error())
		return
	}
	parsed, skipped, verrs := parseOperatorsCSV(buf)
	if len(verrs) > 0 {
		writeJSON(w, http.StatusUnprocessableEntity, operatorUploadResp{
			ExamID:      examID,
			RowsFailed:  len(verrs),
			RowErrors:   verrs,
			SkippedCols: skipped,
		})
		return
	}
	if len(parsed) == 0 {
		writeErr(w, http.StatusBadRequest, "csv had no data rows")
		return
	}

	tx, err := s.deps.DB.BeginTx(r.Context(), nil)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db begin: "+err.Error())
		return
	}
	defer tx.Rollback()

	resp := operatorUploadResp{ExamID: examID, SkippedCols: skipped}
	// Wide-open valid_from/valid_to for CSV-created operators — admin can
	// tighten per-operator later via the operators UI. Matches the
	// "no date window" behaviour of the legacy shared-login flow.
	vFrom := time.Now().UTC().Format("2006-01-02")
	vTo := time.Now().UTC().AddDate(1, 0, 0).Format("2006-01-02")

	for _, op := range parsed {
		var (
			existingID    int64
			existingOrgID sql.NullInt64
		)
		lookupErr := tx.QueryRowContext(r.Context(),
			`SELECT id, org_id FROM users WHERE username = ?`, op.username,
		).Scan(&existingID, &existingOrgID)

		var userID int64
		var status string

		switch {
		case errors.Is(lookupErr, sql.ErrNoRows):
			// New operator: bcrypt + INSERT.
			hash, herr := bcrypt.GenerateFromPassword([]byte(op.password), bcrypt.DefaultCost)
			if herr != nil {
				writeErr(w, http.StatusInternalServerError, "bcrypt: "+herr.Error())
				return
			}
			res, ierr := tx.ExecContext(r.Context(), `
				INSERT INTO users(username, password_hash, role, org_id,
				                  display_name, email, password_plaintext,
				                  valid_from, valid_to)
				VALUES(?, ?, 'client', ?, ?, ?, ?, ?, ?)`,
				op.username, string(hash), orgID, op.displayName,
				nullable(op.email), op.password, vFrom, vTo)
			if ierr != nil {
				resp.RowsFailed++
				resp.RowErrors = append(resp.RowErrors, csvValidationErr{
					Line: 0, Msg: fmt.Sprintf("insert %q: %s", op.username, ierr.Error())})
				continue
			}
			userID, _ = res.LastInsertId()
			resp.RowsCreated++
			status = "created"

		case lookupErr != nil:
			resp.RowsFailed++
			resp.RowErrors = append(resp.RowErrors, csvValidationErr{
				Line: 0, Msg: fmt.Sprintf("lookup %q: %s", op.username, lookupErr.Error())})
			continue

		default:
			// Existing user — must belong to this admin's org.
			if !existingOrgID.Valid || existingOrgID.Int64 != orgID {
				resp.RowsFailed++
				resp.RowErrors = append(resp.RowErrors, csvValidationErr{
					Line: 0, Msg: fmt.Sprintf(
						"username %q already exists in a different org — skipped", op.username)})
				continue
			}
			userID = existingID
			resp.RowsAssigned++
			status = "linked"
		}

		// Link to the target exam via operator_exams (idempotent — INSERT OR IGNORE).
		if _, err := tx.ExecContext(r.Context(),
			`INSERT OR IGNORE INTO operator_exams(user_id, exam_id) VALUES(?, ?)`,
			userID, examID); err != nil {
			resp.RowsFailed++
			resp.RowErrors = append(resp.RowErrors, csvValidationErr{
				Line: 0, Msg: fmt.Sprintf("link %q → exam %d: %s", op.username, examID, err.Error())})
			continue
		}
		resp.Assignments = append(resp.Assignments, operatorAssignment{
			Username: op.username, UserID: userID, Status: status,
		})
	}

	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "db commit: "+err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, resp)
}
