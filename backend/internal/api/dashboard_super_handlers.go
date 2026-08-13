package api

import "net/http"

// Superadmin dashboard. The legacy `centers` table (+ per-org centre
// count + per-centre top-verifications view) was removed by migration
// 021 — the "one centre per org" invariant it encoded is dead. In its
// place: exam_centres, which is per-exam and populated via CSV upload.
// If a per-exam-centre leaderboard is useful later, add it here.

func (s *Server) superStats(w http.ResponseWriter, r *http.Request) {
	var orgs, users, total, verified, denied int
	_ = s.deps.DB.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM organizations`).Scan(&orgs)
	// Exclude super + ops from the "Operators & Staff" count -- those
	// are system-baked accounts, not real tenant users, and their
	// presence made the widget read "2" on a freshly-wiped DB.
	_ = s.deps.DB.QueryRowContext(r.Context(),
		`SELECT COUNT(*) FROM users WHERE role NOT IN ('superadmin', 'ops_admin')`,
	).Scan(&users)
	_ = s.deps.DB.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM verifications`).Scan(&total)
	_ = s.deps.DB.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM verifications WHERE status='verified'`).Scan(&verified)
	_ = s.deps.DB.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM verifications WHERE status='denied'`).Scan(&denied)

	writeJSON(w, http.StatusOK, map[string]any{
		"organizations": orgs,
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
		var total, verified, denied int
		if err := rows.Scan(&id, &code, &name, &total, &verified, &denied); err != nil {
			continue
		}
		out = append(out, map[string]any{
			"id": id, "code": code, "name": name,
			"total": total, "verified": verified, "denied": denied,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// superTopCenters was removed with the legacy `centers` table. Its
// route (/api/superadmin/top-centers) still exists so old frontends
// don't 404 hard — it now returns an empty array. Delete the route
// entry in server.go once the last dashboard reference is confirmed
// gone from every published bundle.
func (s *Server) superTopCenters(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, []any{})
}
