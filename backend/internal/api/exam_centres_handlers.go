package api

import (
	"context"
	"database/sql"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
)

// Per-exam centre catalog — mirrors the per-exam candidate CSV flow.
// Superadmin owns this (centres for an exam are set by the board that
// owns the exam; institutions subscribe to exams, they don't decide
// centre lists). One CSV per exam; re-uploading upserts by
// (exam_id, centre_code).
//
// Endpoints (see server.go for role gating):
//   POST /api/superadmin/exams/{id}/centres/upload   multipart 'file'
//   GET  /api/superadmin/exams/{id}/centres          list, JSON
//   GET  /api/admin/exams/{id}/centres               list for admin's org
//                                                    (needs a live subscription)

type centreRow struct {
	CentreCode string `json:"centre_code"`
	CentreName string `json:"centre_name"`
	Address    string `json:"address,omitempty"`
	City       string `json:"city,omitempty"`
	State      string `json:"state,omitempty"`
	Pincode    string `json:"pincode,omitempty"`
}

type parsedCentre struct {
	code    string
	name    string
	address string
	city    string
	state   string
	pincode string
}

// parseCentresCSV picks up the useful columns from centres_template.csv
// and ignores the internal-ops ones (merge_code, zone, latitude,
// longitude, device_allotted, is_centre_active, rm).
//
// Required columns: centre_code, centre_name.
// Optional: address, city, state, pincode.
// Any recognised header casing works. Duplicate centre_code inside one
// file is a hard error — the caller has to fix the CSV, not us.
func parseCentresCSV(buf []byte) ([]parsedCentre, []csvValidationErr) {
	rd := csv.NewReader(strings.NewReader(string(buf)))
	rd.FieldsPerRecord = -1

	header, err := rd.Read()
	if err != nil {
		return nil, []csvValidationErr{{Line: 1, Msg: "could not read header: " + err.Error()}}
	}
	codeIdx, nameIdx := -1, -1
	addrIdx, cityIdx, stateIdx, pinIdx := -1, -1, -1, -1
	for i, h := range header {
		switch strings.ToLower(strings.TrimSpace(h)) {
		case "centre_code", "center_code", "centercode", "centrecode":
			codeIdx = i
		case "centre_name", "center_name", "centername", "centrename", "name":
			nameIdx = i
		case "address":
			addrIdx = i
		case "city":
			cityIdx = i
		case "state":
			stateIdx = i
		case "pincode", "pin_code", "pin":
			pinIdx = i
		}
	}
	if codeIdx < 0 || nameIdx < 0 {
		return nil, []csvValidationErr{{Line: 1,
			Msg: "header must contain 'centre_code' and 'centre_name'"}}
	}

	pick := func(row []string, i int) string {
		if i < 0 || i >= len(row) {
			return ""
		}
		return strings.TrimSpace(row[i])
	}

	var out []parsedCentre
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
		code := pick(row, codeIdx)
		name := pick(row, nameIdx)
		if code == "" || name == "" {
			verrs = append(verrs, csvValidationErr{Line: line,
				Msg: "centre_code and centre_name are required"})
			continue
		}
		if prev, dup := seen[code]; dup {
			verrs = append(verrs, csvValidationErr{Line: line,
				Msg: fmt.Sprintf("duplicate centre_code %q (first at line %d)", code, prev)})
			continue
		}
		seen[code] = line
		out = append(out, parsedCentre{
			code:    code,
			name:    name,
			address: pick(row, addrIdx),
			city:    pick(row, cityIdx),
			state:   pick(row, stateIdx),
			pincode: pick(row, pinIdx),
		})
	}
	return out, verrs
}

// uploadExamCentres handles the multipart CSV → exam_centres upsert.
// Same shape as the candidate upload — parse-first, reject on any
// validation error, upsert inside a single transaction.
func (s *Server) uploadExamCentres(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	examID, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || examID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid exam id")
		return
	}
	// Confirm the exam exists so we don't accept centres for ghosts.
	var probe int64
	if err := s.deps.DB.QueryRowContext(r.Context(),
		`SELECT id FROM exams WHERE id = ?`, examID).Scan(&probe); err != nil {
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

	parsed, verrs := parseCentresCSV(buf)
	if len(verrs) > 0 {
		writeJSON(w, http.StatusUnprocessableEntity, csvUploadResp{ValidationErrors: verrs})
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

	stmt, err := tx.PrepareContext(r.Context(), `
		INSERT INTO exam_centres(exam_id, centre_code, centre_name,
		                          address, city, state, pincode)
		VALUES(?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(exam_id, centre_code) DO UPDATE SET
			centre_name = excluded.centre_name,
			address     = excluded.address,
			city        = excluded.city,
			state       = excluded.state,
			pincode     = excluded.pincode,
			updated_at  = CURRENT_TIMESTAMP`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db prepare: "+err.Error())
		return
	}
	defer stmt.Close()

	for _, c := range parsed {
		if _, err := stmt.ExecContext(r.Context(),
			examID, c.code, c.name,
			nullable(c.address), nullable(c.city), nullable(c.state), nullable(c.pincode),
		); err != nil {
			writeErr(w, http.StatusInternalServerError, "db insert row: "+err.Error())
			return
		}
	}
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "db commit: "+err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"exam_id":     examID,
		"rows_seeded": len(parsed),
	})
}

// listExamCentres returns the centre catalog for one exam. Same shape
// for superadmin and admin — the routes differ so we can enforce role
// scoping (admin needs to be subscribed to the exam).
func (s *Server) listExamCentres(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	examID, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || examID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid exam id")
		return
	}
	claims := claimsFrom(r)
	if claims == nil {
		writeErr(w, http.StatusUnauthorized, "missing token")
		return
	}
	// Admin role: only show if the org subscribes to this exam.
	if claims.Role == "admin" {
		if claims.OrgID == nil {
			writeErr(w, http.StatusForbidden, "org context required")
			return
		}
		if err := s.assertOrgSubscribed(r.Context(), *claims.OrgID, examID); err != nil {
			writeErr(w, http.StatusNotFound, "exam not found")
			return
		}
	}
	rows, err := s.deps.DB.QueryContext(r.Context(), `
		SELECT centre_code, centre_name,
		       COALESCE(address, ''), COALESCE(city, ''),
		       COALESCE(state, ''),   COALESCE(pincode, '')
		  FROM exam_centres
		 WHERE exam_id = ?
		 ORDER BY centre_code`, examID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	defer rows.Close()

	out := []centreRow{}
	for rows.Next() {
		var c centreRow
		if err := rows.Scan(&c.CentreCode, &c.CentreName,
			&c.Address, &c.City, &c.State, &c.Pincode); err != nil {
			writeErr(w, http.StatusInternalServerError, "scan: "+err.Error())
			return
		}
		out = append(out, c)
	}
	writeJSON(w, http.StatusOK, map[string]any{"centres": out})
}

// assertOrgSubscribed returns nil when the given org has an active
// subscription to the given exam. Used by admin-facing endpoints so an
// admin can't peek at centres for exams their org hasn't subscribed to.
func (s *Server) assertOrgSubscribed(ctx context.Context, orgID, examID int64) error {
	var one int
	err := s.deps.DB.QueryRowContext(ctx,
		`SELECT 1 FROM organization_exam_subscriptions
		  WHERE org_id = ? AND exam_id = ? LIMIT 1`,
		orgID, examID).Scan(&one)
	return err
}
