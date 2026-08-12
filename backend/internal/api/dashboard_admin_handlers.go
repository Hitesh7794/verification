package api

import (
	"net/http"
	"time"
)

// scopeArgs returns a SQL fragment + args restricting verifications to the
// caller's organization (admin) or letting the superadmin see everything.
func (s *Server) scopeArgs(r *http.Request) (string, []any) {
	c := claimsFrom(r)
	if c.Role == "admin" && c.OrgID != nil {
		return " WHERE v.org_id = ? ", []any{*c.OrgID}
	}
	return " WHERE 1=1 ", nil
}

func (s *Server) adminStats(w http.ResponseWriter, r *http.Request) {
	where, args := s.scopeArgs(r)

	var total, verified, denied, today int
	_ = s.deps.DB.QueryRowContext(r.Context(),
		`SELECT COUNT(*) FROM verifications v`+where, args...).Scan(&total)
	_ = s.deps.DB.QueryRowContext(r.Context(),
		`SELECT COUNT(*) FROM verifications v`+where+` AND v.status='verified'`, args...).Scan(&verified)
	_ = s.deps.DB.QueryRowContext(r.Context(),
		`SELECT COUNT(*) FROM verifications v`+where+` AND v.status='denied'`, args...).Scan(&denied)

	startOfDay := time.Now().Truncate(24 * time.Hour)
	args2 := append([]any{}, args...)
	args2 = append(args2, startOfDay)
	_ = s.deps.DB.QueryRowContext(r.Context(),
		`SELECT COUNT(*) FROM verifications v`+where+` AND v.created_at >= ?`, args2...).Scan(&today)

	// Enrolled candidates count = distinct exam_candidates rows in
	// exams the caller's org has subscribed to (admin) or all rows
	// (superadmin). Replaces the old filesystem-index count that
	// wasn't org-scoped.
	var enrolled int
	if c := claimsFrom(r); c.Role == "admin" && c.OrgID != nil {
		_ = s.deps.DB.QueryRowContext(r.Context(),
			`SELECT COUNT(DISTINCT ec.id)
			   FROM exam_candidates ec
			   JOIN organization_exam_subscriptions s ON s.exam_id = ec.exam_id
			  WHERE s.org_id = ?`, *c.OrgID).Scan(&enrolled)
	} else {
		_ = s.deps.DB.QueryRowContext(r.Context(),
			`SELECT COUNT(*) FROM exam_candidates`).Scan(&enrolled)
	}

	// Number of exams the caller can see — replaces the legacy
	// "centres" count now that the centres table is gone.
	var examCount int
	if c := claimsFrom(r); c.Role == "admin" && c.OrgID != nil {
		_ = s.deps.DB.QueryRowContext(r.Context(),
			`SELECT COUNT(*) FROM organization_exam_subscriptions WHERE org_id=?`,
			*c.OrgID).Scan(&examCount)
	} else {
		_ = s.deps.DB.QueryRowContext(r.Context(),
			`SELECT COUNT(*) FROM exams`).Scan(&examCount)
	}

	successRate := 0.0
	if total > 0 {
		successRate = float64(verified) * 100.0 / float64(total)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"total":        total,
		"verified":     verified,
		"denied":       denied,
		"today":        today,
		"exams":        examCount,
		"enrolled":     enrolled,
		"success_rate": successRate,
	})
}

func (s *Server) adminRecent(w http.ResponseWriter, r *http.Request) {
	where, args := s.scopeArgs(r)
	rows, err := s.deps.DB.QueryContext(r.Context(),
		`SELECT v.id, v.roll_no, v.status, v.face_match, v.fp_match, v.created_at,
		        u.display_name
		 FROM verifications v
		 JOIN users u ON u.id = v.operator_id`+
			where+` ORDER BY v.created_at DESC LIMIT 25`, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()

	out := []map[string]any{}
	for rows.Next() {
		var (
			id        int64
			roll      string
			status    string
			face, fp  int
			createdAt time.Time
			operator  string
		)
		if err := rows.Scan(&id, &roll, &status, &face, &fp, &createdAt, &operator); err != nil {
			continue
		}
		out = append(out, map[string]any{
			"id":         id,
			"roll_no":    roll,
			"status":     status,
			"face_match": face == 1,
			"fp_match":   fp == 1,
			"created_at": createdAt,
			"operator":   operator,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// adminByCenter used to group by centers.id. With centers gone, it
// now groups by the candidate's exam (JOINed via exam_candidates
// on roll_no) — a meaningful "breakdown" for the admin who now
// subscribes to exams instead of running centres. Route path
// kept for backward compat until the frontend chart migrates.
func (s *Server) adminByCenter(w http.ResponseWriter, r *http.Request) {
	where, args := s.scopeArgs(r)
	rows, err := s.deps.DB.QueryContext(r.Context(),
		`SELECT e.id, e.name || ' (' || e.exam_code || ')',
		        SUM(CASE WHEN v.status='verified' THEN 1 ELSE 0 END) AS verified,
		        SUM(CASE WHEN v.status='denied'   THEN 1 ELSE 0 END) AS denied,
		        COUNT(*) AS total
		 FROM verifications v
		 JOIN exam_candidates ec ON ec.roll_no = v.roll_no
		 JOIN exams e ON e.id = ec.exam_id`+
			where+` GROUP BY e.id ORDER BY total DESC`, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()

	out := []map[string]any{}
	for rows.Next() {
		var id int64
		var name string
		var v, d, t int
		if err := rows.Scan(&id, &name, &v, &d, &t); err != nil {
			continue
		}
		out = append(out, map[string]any{
			"id": id, "name": name, "verified": v, "denied": d, "total": t,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) adminTimeline(w http.ResponseWriter, r *http.Request) {
	where, args := s.scopeArgs(r)
	rows, err := s.deps.DB.QueryContext(r.Context(),
		`SELECT date(v.created_at) AS d,
		        SUM(CASE WHEN v.status='verified' THEN 1 ELSE 0 END),
		        SUM(CASE WHEN v.status='denied'   THEN 1 ELSE 0 END)
		 FROM verifications v`+where+`
		 AND v.created_at >= date('now','-13 days')
		 GROUP BY d ORDER BY d ASC`, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()

	out := []map[string]any{}
	for rows.Next() {
		var d string
		var v, dn int
		if err := rows.Scan(&d, &v, &dn); err != nil {
			continue
		}
		out = append(out, map[string]any{"date": d, "verified": v, "denied": dn})
	}
	writeJSON(w, http.StatusOK, out)
}
