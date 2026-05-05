package api

import "net/http"

func (s *Server) superStats(w http.ResponseWriter, r *http.Request) {
	var orgs, centers, users, total, verified, denied int
	_ = s.deps.DB.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM organizations`).Scan(&orgs)
	_ = s.deps.DB.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM centers`).Scan(&centers)
	_ = s.deps.DB.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM users`).Scan(&users)
	_ = s.deps.DB.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM verifications`).Scan(&total)
	_ = s.deps.DB.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM verifications WHERE status='verified'`).Scan(&verified)
	_ = s.deps.DB.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM verifications WHERE status='denied'`).Scan(&denied)

	writeJSON(w, http.StatusOK, map[string]any{
		"organizations": orgs,
		"centers":       centers,
		"users":         users,
		"total":         total,
		"verified":      verified,
		"denied":        denied,
		"enrolled":      s.deps.Index.CandidateCount(),
	})
}

func (s *Server) superOrganizations(w http.ResponseWriter, r *http.Request) {
	rows, err := s.deps.DB.QueryContext(r.Context(),
		`SELECT o.id, o.code, o.name,
		        (SELECT COUNT(*) FROM centers c WHERE c.org_id=o.id) AS centers,
		        (SELECT COUNT(*) FROM verifications v WHERE v.org_id=o.id) AS total,
		        (SELECT COUNT(*) FROM verifications v WHERE v.org_id=o.id AND v.status='verified') AS verified,
		        (SELECT COUNT(*) FROM verifications v WHERE v.org_id=o.id AND v.status='denied')   AS denied
		 FROM organizations o ORDER BY total DESC`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()

	out := []map[string]any{}
	for rows.Next() {
		var id int64
		var code, name string
		var centers, total, verified, denied int
		if err := rows.Scan(&id, &code, &name, &centers, &total, &verified, &denied); err != nil {
			continue
		}
		out = append(out, map[string]any{
			"id": id, "code": code, "name": name,
			"centers": centers, "total": total,
			"verified": verified, "denied": denied,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) superTopCenters(w http.ResponseWriter, r *http.Request) {
	rows, err := s.deps.DB.QueryContext(r.Context(),
		`SELECT c.id, c.name, o.code,
		        COUNT(v.id) AS total,
		        SUM(CASE WHEN v.status='verified' THEN 1 ELSE 0 END) AS verified
		 FROM centers c
		 JOIN organizations o ON o.id = c.org_id
		 LEFT JOIN verifications v ON v.center_id = c.id
		 GROUP BY c.id, c.name, o.code
		 ORDER BY total DESC LIMIT 10`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()

	out := []map[string]any{}
	for rows.Next() {
		var id int64
		var name, org string
		var total, verified int
		if err := rows.Scan(&id, &name, &org, &total, &verified); err != nil {
			continue
		}
		out = append(out, map[string]any{
			"id": id, "name": name, "org_code": org,
			"total": total, "verified": verified,
		})
	}
	writeJSON(w, http.StatusOK, out)
}
