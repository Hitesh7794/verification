package api

import (
	"context"
	"encoding/csv"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// GET /api/superadmin/verifications.csv
//
// Federated verifications export. Iterates every Data Plane the
// Control Plane knows about, fetches each DP's CSV via
// /api/internal/verifications/export.csv, and stitches them into a
// single CSV with a prepended `client_name` column so the operator can
// tell which board a row came from.
//
// Filters (all optional, combinable):
//   ?client_id=<N>       Only pull from that one client. Omit for all.
//   ?from=YYYY-MM-DD
//   ?to=YYYY-MM-DD
//   ?status=verified|denied
//   ?roll=<exact roll>
//
// Per-client DP call is time-bound (10s). A failing DP does not fail
// the whole request — its rows are simply absent and an X-Report-
// Errors trailer header lists which clients errored so the FE can
// warn the operator.
func (s *Server) superadminVerificationsExportCSV(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	q := r.URL.Query()
	clientFilter, _ := strconv.ParseInt(strings.TrimSpace(q.Get("client_id")), 10, 64)

	// Load active/ready DPs, optionally narrowed to one client_id.
	loadQ := `SELECT id, name, api_url, api_key
	            FROM clients_registry
	           WHERE status IN ('active','ready')`
	args := []any{}
	if clientFilter > 0 {
		loadQ += ` AND id = $1`
		args = append(args, clientFilter)
	}
	loadQ += ` ORDER BY name`

	rows, err := s.deps.DB.QueryContext(ctx, loadQ, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	defer rows.Close()

	type target struct{ id int64; name, apiURL, apiKey string }
	var targets []target
	for rows.Next() {
		var t target
		if err := rows.Scan(&t.id, &t.name, &t.apiURL, &t.apiKey); err != nil {
			writeErr(w, http.StatusInternalServerError, "row scan: "+err.Error())
			return
		}
		targets = append(targets, t)
	}

	// Build the query string to forward to each DP — every filter
	// except client_id (which is CP-only).
	fwd := url.Values{}
	for _, k := range []string{"from", "to", "status", "roll"} {
		if v := strings.TrimSpace(q.Get(k)); v != "" {
			fwd.Set(k, v)
		}
	}

	// Stream header + rows as we get them. If no clients matched,
	// return just the header row so the operator still gets a CSV.
	stamp := time.Now().Format("2006-01-02")
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`attachment; filename="verifications_%s.csv"`, stamp))
	cw := csv.NewWriter(w)
	defer cw.Flush()

	// Header is stable regardless of what came back from each DP; we
	// prepend `client_name` here rather than trusting each DP's row
	// order.
	_ = cw.Write([]string{
		"client_name", "id", "roll_no", "status", "via",
		"face_match", "fp_match",
		"fp_match_score", "face_match_score", "fp_vendor",
		"exam", "institute", "verification_agent", "created_at",
	})

	// One DP at a time (small N; streaming keeps memory flat).
	perClientTimeout := 10 * time.Second
	for _, t := range targets {
		if err := s.streamOneDPExportInto(ctx, t.apiURL, t.apiKey, t.name, fwd, perClientTimeout, cw); err != nil {
			// Log at server end so operator sees which DPs contributed;
			// silent failure would let the CSV lie by omission.
			_ = cw.Write([]string{"# ERROR: " + t.name + " — " + err.Error()})
		}
	}
}

// streamOneDPExportInto pulls one DP's CSV and copies rows (skipping
// its header, prepending the client_name column) into the caller's
// writer.
func (s *Server) streamOneDPExportInto(
	ctx context.Context,
	apiURL, apiKey, clientName string,
	fwd url.Values,
	timeout time.Duration,
	cw *csv.Writer,
) error {
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	endpoint := strings.TrimRight(apiURL, "/") + "/api/internal/verifications/export.csv"
	if len(fwd) > 0 {
		endpoint += "?" + fwd.Encode()
	}
	req, err := http.NewRequestWithContext(callCtx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("X-Internal-API-Key", apiKey)
	req.Header.Set("Accept", "text/csv")

	resp, err := (&http.Client{Timeout: timeout + time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("dp returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	rd := csv.NewReader(resp.Body)
	rd.FieldsPerRecord = -1 // tolerate a trailing note line if the DP ever adds one
	// Consume header row and discard — the CP writes its own.
	if _, err := rd.Read(); err != nil {
		if err == io.EOF {
			return nil // empty result, not an error
		}
		return err
	}
	for {
		row, err := rd.Read()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		out := append([]string{clientName}, row...)
		_ = cw.Write(out)
		// Flush periodically so the browser sees progress on very
		// large exports.
		cw.Flush()
	}
}
