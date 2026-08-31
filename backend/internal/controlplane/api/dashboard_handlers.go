package api

// Federated dashboard — the Control Plane's centerpiece.
//
// GET /api/superadmin/dashboard reads clients_registry, fires
// parallel HTTP GETs to every active client's api_url +
// /api/internal/metrics (with that client's api_key in
// X-Internal-API-Key), aggregates the sums into one payload, and
// returns it. This is the entire "platform-wide view" the
// implementation plan calls for.
//
// Failure model:
//   - Per-client failures are recorded but never fail the whole
//     response. A slow / down / misauthed Data Plane shows up as a
//     row in the `errors` array with a short reason, and its
//     contribution to every SUM is zero for that call. That way
//     the superadmin's dashboard stays functional in a degraded
//     state — you can SEE something is broken instead of the whole
//     page 500ing.
//   - Per-client timeout is CP_FEDERATED_TIMEOUT_MS (default 3s).
//     Chosen short so a single stuck Data Plane can't hang the
//     whole page — the aggregate wall-clock is bounded by that
//     timeout, not by the number of clients.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// dataPlaneMetrics is the shape the Data Plane's /internal/metrics
// returns. Kept as an unexported mirror rather than importing the
// Data Plane's api package to avoid a cross-package coupling that
// would drag half the Data Plane into the Control Plane binary.
// The JSON tags MUST match internal_handlers.go on the Data Plane;
// if the Data Plane extends the shape, add fields here to pick them
// up in the aggregate.
type dataPlaneMetrics struct {
	Users                  int64 `json:"users"`
	Organizations          int64 `json:"organizations"`
	Exams                  int64 `json:"exams"`
	Candidates             int64 `json:"candidates"`
	VerificationsTotal     int64 `json:"verifications_total"`
	VerificationsToday     int64 `json:"verifications_today"`
	WalletCreditPaiseToday int64 `json:"wallet_credit_paise_today"`
	WalletChargePaiseToday int64 `json:"wallet_charge_paise_today"`
	ActiveOrgs24h          int64 `json:"active_orgs_24h"`
}

// perClientResult is what one goroutine writes back for its Data
// Plane. `metrics` is nil when the call failed; `err` carries a
// short human-readable reason for the dashboard's errors[] list.
type perClientResult struct {
	clientID   int64
	clientName string
	apiURL     string
	metrics    *dataPlaneMetrics
	err        string
	// latencyMs is per-client fan-out latency, exposed on the
	// dashboard so a superadmin can spot a slow Data Plane before
	// it becomes a timeout.
	latencyMs int64
}

// federatedDashboardResp is the aggregate payload. Every count is
// the sum across successfully-responding Data Planes. `per_client`
// carries the raw contribution + status per client so the FE can
// render a "which one is broken?" table alongside the totals.
type federatedDashboardResp struct {
	// Aggregate — SUM across successful fan-outs.
	Aggregate dataPlaneMetrics `json:"aggregate"`
	// PerClient is one entry per active client, whether the call
	// succeeded or failed. Ordered by client name for stable render.
	PerClient []federatedPerClientRow `json:"per_client"`
	// Errors mirrors the failed subset of PerClient so the FE can
	// pop a banner without walking the whole array.
	Errors []federatedErrorRow `json:"errors"`
	// FetchedAt lets the FE decide whether to auto-refresh.
	FetchedAt time.Time `json:"fetched_at"`
}

type federatedPerClientRow struct {
	ClientID   int64            `json:"client_id"`
	ClientName string           `json:"client_name"`
	APIURL     string           `json:"api_url"`
	OK         bool             `json:"ok"`
	LatencyMS  int64            `json:"latency_ms"`
	Metrics    *dataPlaneMetrics `json:"metrics,omitempty"`
	Error      string           `json:"error,omitempty"`
}

type federatedErrorRow struct {
	ClientID   int64  `json:"client_id"`
	ClientName string `json:"client_name"`
	Reason     string `json:"reason"`
}

func (s *Server) federatedDashboard(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	// Pull the target list once. 'active' + 'ready' contribute — both
	// mean the DP is reachable. 'infra_pending' skipped (no DP up yet,
	// would only add timeouts). 'suspended' and 'deleted' never
	// contribute.
	rows, err := s.deps.DB.QueryContext(ctx, `
		SELECT id, name, api_url, api_key
		  FROM clients_registry
		 WHERE status IN ('active','ready')
		 ORDER BY name`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	defer rows.Close()

	type target struct {
		id     int64
		name   string
		apiURL string
		apiKey string
	}
	var targets []target
	for rows.Next() {
		var t target
		if err := rows.Scan(&t.id, &t.name, &t.apiURL, &t.apiKey); err != nil {
			writeErr(w, http.StatusInternalServerError, "row scan: "+err.Error())
			return
		}
		targets = append(targets, t)
	}

	// Zero clients registered → return an empty aggregate. The FE
	// renders a "no clients yet — add one to get started" empty
	// state; this response shape is stable across the transition
	// from zero to N clients.
	if len(targets) == 0 {
		writeJSON(w, http.StatusOK, federatedDashboardResp{
			PerClient: []federatedPerClientRow{},
			Errors:    []federatedErrorRow{},
			FetchedAt: time.Now().UTC(),
		})
		return
	}

	// Per-client HTTP timeout. Config-driven so we can tune from
	// env without a redeploy; falls back to 3s if unset.
	timeout := time.Duration(s.deps.Cfg.FederatedTimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = 3 * time.Second
	}

	// Fan out. One goroutine per target, all writing into the
	// results slice at a pre-allocated index so no mutex is needed
	// on the write path.
	results := make([]perClientResult, len(targets))
	var wg sync.WaitGroup
	for i, t := range targets {
		wg.Add(1)
		go func(i int, t target) {
			defer wg.Done()
			results[i] = s.fetchOneDataPlaneMetrics(ctx, t.id, t.name, t.apiURL, t.apiKey, timeout)
		}(i, t)
	}
	wg.Wait()

	// Reduce.
	var agg dataPlaneMetrics
	perClient := make([]federatedPerClientRow, 0, len(results))
	var errs []federatedErrorRow
	for _, res := range results {
		row := federatedPerClientRow{
			ClientID:   res.clientID,
			ClientName: res.clientName,
			APIURL:     res.apiURL,
			LatencyMS:  res.latencyMs,
			OK:         res.metrics != nil,
			Metrics:    res.metrics,
			Error:      res.err,
		}
		perClient = append(perClient, row)

		if res.metrics == nil {
			errs = append(errs, federatedErrorRow{
				ClientID:   res.clientID,
				ClientName: res.clientName,
				Reason:     res.err,
			})
			continue
		}
		agg.Users += res.metrics.Users
		agg.Organizations += res.metrics.Organizations
		agg.Exams += res.metrics.Exams
		agg.Candidates += res.metrics.Candidates
		agg.VerificationsTotal += res.metrics.VerificationsTotal
		agg.VerificationsToday += res.metrics.VerificationsToday
		agg.WalletCreditPaiseToday += res.metrics.WalletCreditPaiseToday
		agg.WalletChargePaiseToday += res.metrics.WalletChargePaiseToday
		agg.ActiveOrgs24h += res.metrics.ActiveOrgs24h
	}

	var cpApprovedOrgs int64
	_ = s.deps.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM institution_applications WHERE status = 'approved'`).Scan(&cpApprovedOrgs)
	if cpApprovedOrgs > 0 || agg.Organizations == 0 {
		agg.Organizations = cpApprovedOrgs
	}

	writeJSON(w, http.StatusOK, federatedDashboardResp{
		Aggregate: agg,
		PerClient: perClient,
		Errors:    errs,
		FetchedAt: time.Now().UTC(),
	})
}

// fetchOneDataPlaneMetrics performs the one HTTP GET this goroutine
// owns. Any error along the way becomes a `.err` string and a nil
// metrics pointer — the caller aggregates over `.metrics == nil` to
// decide contribution.
func (s *Server) fetchOneDataPlaneMetrics(
	parent context.Context,
	clientID int64,
	clientName, apiURL, apiKey string,
	timeout time.Duration,
) perClientResult {
	start := time.Now()
	res := perClientResult{
		clientID:   clientID,
		clientName: clientName,
		apiURL:     apiURL,
	}

	u := strings.TrimRight(apiURL, "/") + "/api/internal/metrics"
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		res.err = "bad url: " + err.Error()
		res.latencyMs = time.Since(start).Milliseconds()
		return res
	}
	req.Header.Set("X-Internal-API-Key", apiKey)
	req.Header.Set("User-Agent", "verification-control-plane/1.0")

	client := &http.Client{Timeout: timeout}
	resp, err := client.Do(req)
	res.latencyMs = time.Since(start).Milliseconds()
	if err != nil {
		res.err = humanizeFetchError(err, timeout)
		return res
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		res.err = fmt.Sprintf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
		return res
	}

	var m dataPlaneMetrics
	if err := json.NewDecoder(resp.Body).Decode(&m); err != nil {
		res.err = "bad json: " + err.Error()
		return res
	}
	res.metrics = &m
	return res
}

// humanizeFetchError translates standard Go net/http errors into
// short, readable strings the superadmin can understand.
func humanizeFetchError(err error, timeout time.Duration) string {
	if strings.Contains(err.Error(), "context deadline exceeded") {
		return fmt.Sprintf("timeout (>%v)", timeout)
	}
	if strings.Contains(err.Error(), "connection refused") {
		return "connection refused"
	}
	if strings.Contains(err.Error(), "no such host") {
		return "dns lookup failed"
	}
	if strings.Contains(err.Error(), "certificate") {
		return "tls error"
	}
	return err.Error()
}

// ── Superadmin dashboard compatibility endpoints ─────────────────────
//
// Rahul's Frontend (Dashboard.jsx) historically polled:
//   - GET /api/super/stats
//   - GET /api/super/organizations
//
// Under the single-tenant Data Plane, those read from local SQLite.
// Under the multi-tenant Control Plane, those tables are gone —
// verification_cp doesn't have those tables. So we implement the same
// route names here but back them with the correct federated fan-out:
// aggregate metrics across every active DP via /internal/metrics.

// superStatsResp mirrors the shape Rahul's Dashboard.jsx expects.
type superStatsResp struct {
	Organizations      int64 `json:"organizations"`
	Users              int64 `json:"users"`
	VerificationsTotal int64 `json:"total"`
	VerificationsToday int64 `json:"verified"`
	Denied             int64 `json:"denied"`
	Exams              int64 `json:"exams"`
	Candidates         int64 `json:"candidates"`
}

// superStatsCompat fans out to every ready/active DP and sums the
// counters. Uses the same per-DP fetcher as the canonical federated
// dashboard so any DP going down degrades this endpoint the same way
// (partial totals, no 500).
func (s *Server) superStatsCompat(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	// Inline target loader — same query the main federated dashboard
	// uses, kept local so this handler has no other-function dep.
	rows, err := s.deps.DB.QueryContext(ctx, `
		SELECT id, name, api_url, api_key
		  FROM clients_registry
		 WHERE status IN ('active','ready')
		 ORDER BY name`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	defer rows.Close()
	type target struct{ id int64; name, apiURL, apiKey string }
	var targets []target
	for rows.Next() {
		var t target
		if err := rows.Scan(&t.id, &t.name, &t.apiURL, &t.apiKey); err == nil {
			targets = append(targets, t)
		}
	}

	timeout := time.Duration(s.deps.Cfg.FederatedTimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = 3 * time.Second
	}

	var out superStatsResp
	for _, t := range targets {
		res := s.fetchOneDataPlaneMetrics(ctx, t.id, t.name, t.apiURL, t.apiKey, timeout)
		if res.metrics == nil {
			// DP unreachable — just skip its contribution.
			continue
		}
		out.Organizations += res.metrics.Organizations
		out.Users += res.metrics.Users
		out.VerificationsTotal += res.metrics.VerificationsTotal
		out.VerificationsToday += res.metrics.VerificationsToday
		out.Exams += res.metrics.Exams
		out.Candidates += res.metrics.Candidates
	}

	var cpApprovedOrgs int64
	_ = s.deps.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM institution_applications WHERE status = 'approved'`).Scan(&cpApprovedOrgs)
	if cpApprovedOrgs > 0 || out.Organizations == 0 {
		out.Organizations = cpApprovedOrgs
	}

	writeJSON(w, http.StatusOK, out)
}

// superOrganizationsCompat returns approved organizations through registration.
type superOrgRow struct {
	ID       int64  `json:"id"`
	Code     string `json:"code"`
	Name     string `json:"name"`
	Total    int64  `json:"total"`
	Verified int64  `json:"verified"`
	Denied   int64  `json:"denied"`
	// Extra fields carried through for the fleet-view UI.
	APIURL string `json:"api_url,omitempty"`
	Status string `json:"status"`
}

func (s *Server) superOrganizationsCompat(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	rows, err := s.deps.DB.QueryContext(ctx, `
		SELECT a.id,
		       COALESCE(NULLIF(a.aishe_code, ''), 'APP_' || a.id::text) AS code,
		       a.institution_name AS name,
		       a.status
		  FROM institution_applications a
		 WHERE a.status = 'approved'
		 ORDER BY a.reviewed_at DESC NULLS LAST, a.id DESC`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	defer rows.Close()

	out := []superOrgRow{}
	for rows.Next() {
		var id int64
		var code, name, status string
		if err := rows.Scan(&id, &code, &name, &status); err != nil {
			continue
		}
		out = append(out, superOrgRow{
			ID:     id,
			Code:   code,
			Name:   name,
			Status: status,
		})
	}
	writeJSON(w, http.StatusOK, out)
}
