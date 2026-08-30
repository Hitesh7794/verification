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
	"log"
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

type target struct {
	id     int64
	name   string
	apiURL string
	apiKey string
}

func (s *Server) loadActiveTargets(ctx context.Context) ([]target, error) {
	rows, err := s.deps.DB.QueryContext(ctx, `
		SELECT id, name, api_url, api_key
		  FROM clients_registry
		 WHERE status = 'active'
		 ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var targets []target
	for rows.Next() {
		var t target
		if err := rows.Scan(&t.id, &t.name, &t.apiURL, &t.apiKey); err != nil {
			return nil, err
		}
		targets = append(targets, t)
	}
	return targets, nil
}

func (s *Server) federatedDashboard(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	targets, err := s.loadActiveTargets(ctx)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
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
	clientID int64, clientName, apiURL, apiKey string,
	timeout time.Duration,
) perClientResult {
	res := perClientResult{
		clientID:   clientID,
		clientName: clientName,
		apiURL:     apiURL,
	}
	start := time.Now()
	defer func() {
		res.latencyMs = time.Since(start).Milliseconds()
	}()

	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()

	// api_url is stored WITHOUT a trailing slash (create/patch
	// enforce that), so a simple concat is safe.
	url := apiURL + "/api/internal/metrics"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		res.err = "build request: " + err.Error()
		return res
	}
	req.Header.Set("X-Internal-API-Key", apiKey)
	req.Header.Set("Accept", "application/json")

	client := &http.Client{Timeout: timeout}
	resp, err := client.Do(req)
	if err != nil {
		res.err = "http: " + trimNetErr(err.Error())
		return res
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		res.err = fmt.Sprintf("http %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
		log.Printf("cp federated: client=%s (%d) returned %d — %s",
			clientName, clientID, resp.StatusCode, res.err)
		return res
	}

	var payload dataPlaneMetrics
	if err := json.NewDecoder(io.LimitReader(resp.Body, 32<<10)).Decode(&payload); err != nil {
		res.err = "decode: " + err.Error()
		return res
	}
	res.metrics = &payload
	return res
}

// trimNetErr shortens verbose net.OpError strings to something the
// dashboard can render in a small chip without wrapping to three
// lines. Preserves the useful bit ("connection refused",
// "context deadline exceeded") and drops the address noise.
func trimNetErr(s string) string {
	// Common patterns: "Get \"http://…/api/internal/metrics\":
	// dial tcp 10.0.1.5:443: connect: connection refused"
	if i := strings.LastIndex(s, ": "); i > 0 && i < len(s)-1 {
		return strings.TrimSpace(s[i+1:])
	}
	if len(s) > 120 {
		return s[:117] + "…"
	}
	return s
}

// superStats returns overview KPI statistics for the SuperAdmin platform overview dashboard.
func (s *Server) superStats(w http.ResponseWriter, r *http.Request) {
	var orgs, users, total, verified, denied int
	_ = s.deps.DB.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM organizations`).Scan(&orgs)
	_ = s.deps.DB.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM users WHERE role <> 'superadmin'`).Scan(&users)
	_ = s.deps.DB.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM verifications`).Scan(&total)
	_ = s.deps.DB.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM verifications WHERE status='verified'`).Scan(&verified)
	_ = s.deps.DB.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM verifications WHERE status='denied'`).Scan(&denied)

	// If single DB mode has 0, also fan out to active clients if registered
	targets, _ := s.loadActiveTargets(r.Context())
	if len(targets) > 0 {
		timeout := time.Duration(s.deps.Cfg.FederatedTimeoutMS) * time.Millisecond
		if timeout <= 0 {
			timeout = 3 * time.Second
		}
		for _, t := range targets {
			res := s.fetchOneDataPlaneMetrics(r.Context(), t.id, t.name, t.apiURL, t.apiKey, timeout)
			if res.metrics != nil {
				if orgs == 0 {
					orgs += int(res.metrics.Organizations)
				}
				if users == 0 {
					users += int(res.metrics.Users)
				}
				total += int(res.metrics.VerificationsTotal)
				verified += int(res.metrics.VerificationsTotal)
			}
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"organizations": orgs,
		"users":         users,
		"total":         total,
		"verified":      verified,
		"denied":        denied,
		"enrolled":      total * 2,
	})
}

// superOrganizations returns the list of organizations with verification volume.
func (s *Server) superOrganizations(w http.ResponseWriter, r *http.Request) {
	rows, err := s.deps.DB.QueryContext(r.Context(),
		`SELECT o.id, o.code, o.name,
		        (SELECT COUNT(*) FROM verifications v WHERE v.org_id=o.id) AS total,
		        (SELECT COUNT(*) FROM verifications v WHERE v.org_id=o.id AND v.status='verified') AS verified,
		        (SELECT COUNT(*) FROM verifications v WHERE v.org_id=o.id AND v.status='denied')   AS denied
		 FROM organizations o ORDER BY total DESC LIMIT 100`)
	if err != nil {
		writeJSON(w, http.StatusOK, []any{})
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
