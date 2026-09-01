package api

import (
	"encoding/csv"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/veni/neet-verification/internal/db"
)

// GET /api/internal/verifications/export.csv
//
// Server-to-server variant of adminExportVerificationsCSV — gated by
// internalAuth (X-Internal-API-Key) instead of a user JWT. The
// Control Plane calls this to build a federated superadmin
// verifications report across every Data Plane it owns.
//
// Same filters as the admin CSV (from/to/status/roll), same 100k row
// safety cap. No org scoping — the caller (CP) is trusted to have
// already filtered by client at the federation layer.
func (s *Server) internalVerificationsExportCSV(w http.ResponseWriter, r *http.Request) {
	where := " WHERE 1=1"
	var args []any

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
		if t, err := time.Parse("2006-01-02", from); err == nil {
			where += " AND v.created_at >= ?"
			args = append(args, t)
		}
	}
	if to := q.Get("to"); to != "" {
		if t, err := time.Parse("2006-01-02", to); err == nil {
			where += " AND v.created_at < ?"
			args = append(args, t.Add(24*time.Hour))
		}
	}
	args = append(args, 100_000)

	rows, err := s.deps.DB.QueryContext(r.Context(),
		db.Q(`SELECT v.id, v.roll_no, v.status, v.face_match, v.fp_match,
		        COALESCE(v.via, ''),
		        COALESCE(e.name || ' (' || e.exam_code || ')', ''),
		        COALESCE(o.name, ''),
		        u.display_name, v.created_at,
		        COALESCE(v.fp_vendor, ''), v.fp_match_score, v.face_match_score
		 FROM verifications v
		 LEFT JOIN organizations o ON o.id = v.org_id
		 LEFT JOIN exam_candidates ec ON ec.roll_no = v.roll_no
		 LEFT JOIN exams e ON e.id = ec.exam_id
		 JOIN users u ON u.id = v.operator_id`+
			where+` ORDER BY v.id DESC LIMIT ?`), args...,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error: "+err.Error())
		return
	}
	defer rows.Close()

	stamp := time.Now().Format("2006-01-02")
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`attachment; filename="dp_verifications_%s.csv"`, stamp))
	cw := csv.NewWriter(w)
	defer cw.Flush()

	_ = cw.Write([]string{
		"id", "roll_no", "status", "via",
		"face_match", "fp_match",
		"fp_match_score", "face_match_score", "fp_vendor",
		"exam", "institute", "verification_agent", "created_at",
	})

	for rows.Next() {
		var (
			id                                             int64
			roll, status, via, exam, orgName, operatorName string
			fpVendor                                       string
			faceMatch, fpMatch                             bool
			fpScore                                        *int
			faceScore                                      *float64
			createdAt                                      time.Time
		)
		if err := rows.Scan(&id, &roll, &status, &faceMatch, &fpMatch,
			&via, &exam, &orgName, &operatorName, &createdAt,
			&fpVendor, &fpScore, &faceScore,
		); err != nil {
			return
		}
		_ = cw.Write([]string{
			fmt.Sprint(id), roll, status, via,
			fmt.Sprint(faceMatch), fmt.Sprint(fpMatch),
			intPtrToString(fpScore), floatPtrToString(faceScore),
			fpVendor,
			exam, orgName, operatorName,
			createdAt.UTC().Format(time.RFC3339),
		})
	}
}
