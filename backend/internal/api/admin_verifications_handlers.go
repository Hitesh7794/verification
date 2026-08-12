package api

import (
	"encoding/csv"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Admin verification-history endpoints — paginated read + CSV export.
// Admins see only their own org's rows (enforced by scopeArgs);
// superadmins see all, optionally filtered by ?org_id=N.
//
// Filters (all optional, combinable):
//
//	?roll=12345        exact roll-number match
//	?status=verified   "verified" | "denied"
//	?from=YYYY-MM-DD   inclusive lower bound on created_at
//	?to=YYYY-MM-DD     inclusive upper bound on created_at (whole day)
//	?before=<id>       cursor pagination (smallest id from prev page)
//
// Response is paginated at 50 rows by default, max 200, with
// next_cursor for the older page. Same shape as adminRecent so the UI
// can pivot easily.

// buildVerificationFilters returns the WHERE clause + args for the
// filter set, prefixed with " WHERE ". Used by both the JSON list and
// the CSV export so they stay in lockstep.
func (s *Server) buildVerificationFilters(r *http.Request) (string, []any) {
	c := claimsFrom(r)
	where := " WHERE 1=1"
	var args []any
	if c.Role == "admin" && c.OrgID != nil {
		where += " AND v.org_id = ?"
		args = append(args, *c.OrgID)
	}
	q := r.URL.Query()
	if roll := strings.TrimSpace(q.Get("roll")); roll != "" {
		where += " AND v.roll_no = ?"
		args = append(args, roll)
	}
	if status := q.Get("status"); status == "verified" || status == "denied" {
		where += " AND v.status = ?"
		args = append(args, status)
	}
	if from := q.Get("from"); from != "" {
		// Parse as YYYY-MM-DD; reject anything else silently so a
		// malformed query doesn't crash the page.
		if t, err := time.Parse("2006-01-02", from); err == nil {
			where += " AND v.created_at >= ?"
			args = append(args, t)
		}
	}
	if to := q.Get("to"); to != "" {
		if t, err := time.Parse("2006-01-02", to); err == nil {
			// Inclusive: include the whole `to` day.
			where += " AND v.created_at < ?"
			args = append(args, t.Add(24*time.Hour))
		}
	}
	return where, args
}

type verificationRow struct {
	ID           int64    `json:"id"`
	RollNo       string   `json:"roll_no"`
	Status       string   `json:"status"`
	FaceMatch    bool     `json:"face_match"`
	FpMatch      bool     `json:"fp_match"`
	Via          string   `json:"via,omitempty"`
	// JSON key is still "center_name" for FE backward-compat; the
	// value is now the exam name || " (" || exam_code || ")" so the
	// history column stays meaningful after the centres table died.
	CenterName   string   `json:"center_name"`
	OperatorName string   `json:"operator_name"`
	CreatedAt    string   `json:"created_at"`
	FpVendor     string   `json:"fp_vendor,omitempty"`
	FpScore      *int     `json:"fp_match_score,omitempty"`
	FaceScore    *float64 `json:"face_match_score,omitempty"`
}

// GET /api/admin/verifications
func (s *Server) adminListVerifications(w http.ResponseWriter, r *http.Request) {
	where, args := s.buildVerificationFilters(r)

	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	if before := r.URL.Query().Get("before"); before != "" {
		if n, err := strconv.ParseInt(before, 10, 64); err == nil && n > 0 {
			where += " AND v.id < ?"
			args = append(args, n)
		}
	}
	args = append(args, limit)

	rows, err := s.deps.DB.QueryContext(r.Context(),
		`SELECT v.id, v.roll_no, v.status, v.face_match, v.fp_match,
		        COALESCE(v.via, ''),
		        COALESCE(e.name || ' (' || e.exam_code || ')', ''),
		        u.display_name, v.created_at,
		        COALESCE(v.fp_vendor, ''), v.fp_match_score, v.face_match_score
		 FROM verifications v
		 LEFT JOIN exam_candidates ec ON ec.roll_no = v.roll_no
		 LEFT JOIN exams e ON e.id = ec.exam_id
		 JOIN users u ON u.id = v.operator_id`+
			where+` ORDER BY v.id DESC LIMIT ?`, args...,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error: "+err.Error())
		return
	}
	defer rows.Close()

	out := make([]verificationRow, 0, limit)
	for rows.Next() {
		var row verificationRow
		var fpScore *int
		var faceScore *float64
		if err := rows.Scan(
			&row.ID, &row.RollNo, &row.Status, &row.FaceMatch, &row.FpMatch,
			&row.Via, &row.CenterName, &row.OperatorName, &row.CreatedAt,
			&row.FpVendor, &fpScore, &faceScore,
		); err != nil {
			writeErr(w, http.StatusInternalServerError, "scan: "+err.Error())
			return
		}
		row.FpScore = fpScore
		row.FaceScore = faceScore
		out = append(out, row)
	}

	var nextCursor int64
	if len(out) == limit {
		nextCursor = out[len(out)-1].ID
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"rows":        out,
		"next_cursor": nextCursor,
	})
}

// GET /api/admin/verifications.csv
//
// Same filters as the JSON endpoint; streams a CSV download. No
// pagination — exports up to 100k rows (a hard cap to prevent
// memory blowup on misconfigured queries). Past 100k rows the admin
// should narrow the date range.
func (s *Server) adminExportVerificationsCSV(w http.ResponseWriter, r *http.Request) {
	where, args := s.buildVerificationFilters(r)
	args = append(args, 100_000)

	rows, err := s.deps.DB.QueryContext(r.Context(),
		`SELECT v.id, v.roll_no, v.status, v.face_match, v.fp_match,
		        COALESCE(v.via, ''),
		        COALESCE(e.name || ' (' || e.exam_code || ')', ''),
		        u.display_name, v.created_at,
		        COALESCE(v.fp_vendor, ''), v.fp_match_score, v.face_match_score,
		        COALESCE(v.device_serial, ''), COALESCE(v.device_model, ''),
		        v.decision_ms
		 FROM verifications v
		 LEFT JOIN exam_candidates ec ON ec.roll_no = v.roll_no
		 LEFT JOIN exams e ON e.id = ec.exam_id
		 JOIN users u ON u.id = v.operator_id`+
			where+` ORDER BY v.id DESC LIMIT ?`, args...,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error: "+err.Error())
		return
	}
	defer rows.Close()

	stamp := time.Now().Format("2006-01-02")
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`attachment; filename="verifications_%s.csv"`, stamp))
	cw := csv.NewWriter(w)
	defer cw.Flush()

	_ = cw.Write([]string{
		"id", "roll_no", "status", "via", "face_match", "fp_match",
		"fp_match_score", "face_match_score", "fp_vendor",
		"center_name", "operator_name", "device_serial", "device_model",
		"decision_ms", "created_at",
	})

	for rows.Next() {
		var (
			id            int64
			roll, status, via, centerName, operatorName,
			fpVendor, deviceSerial, deviceModel string
			faceMatch, fpMatch bool
			fpScore            *int
			faceScore          *float64
			decisionMs         *int
			createdAt          string
		)
		if err := rows.Scan(
			&id, &roll, &status, &faceMatch, &fpMatch,
			&via, &centerName, &operatorName, &createdAt,
			&fpVendor, &fpScore, &faceScore,
			&deviceSerial, &deviceModel, &decisionMs,
		); err != nil {
			// Mid-stream errors: best we can do is stop. The
			// browser will see a truncated CSV but that's the
			// least-bad outcome.
			return
		}
		_ = cw.Write([]string{
			fmt.Sprint(id), roll, status, via,
			fmt.Sprint(faceMatch), fmt.Sprint(fpMatch),
			intPtrToString(fpScore), floatPtrToString(faceScore),
			fpVendor, centerName, operatorName,
			deviceSerial, deviceModel,
			intPtrToString(decisionMs), createdAt,
		})
	}
}

func intPtrToString(p *int) string {
	if p == nil {
		return ""
	}
	return strconv.Itoa(*p)
}
func floatPtrToString(p *float64) string {
	if p == nil {
		return ""
	}
	return strconv.FormatFloat(*p, 'f', -1, 64)
}
