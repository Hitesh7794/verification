package api

// Reverse-proxy shims — Phase 3 of the multi-tenant migration.
//
// When this Data Plane is configured to hand KYC off to the Control
// Plane (ServeKYCLocally=false in config), these handlers stand in
// for the legacy /api/register/* and /api/client/* handlers. Each
// one:
//
//   1. Adds two headers identifying this Data Plane to the Control
//      Plane (X-Data-Plane-Client-ID + X-Data-Plane-Api-Key).
//   2. Streams the request body forward to
//      Cfg.ControlPlaneURL + <same path> + <query string>.
//   3. Streams the response back to the browser, preserving status
//      + Content-Type.
//
// Deliberately transparent — the DP doesn't parse the payload, doesn't
// mutate JSON fields, doesn't validate anything. Any business logic
// still owned by the DP (OTP, doc upload to S3) is exercised by the
// existing routes that remain wired IN ADDITION to these proxies.
//
// Failure modes:
//   - CP unreachable / timeout / 5xx: return 502 to the browser with
//     a short message. The browser sees a hard failure rather than
//     "silently approved on the CP, not visible on the DP".
//   - CONTROL_PLANE_URL not configured: return 503 with a very
//     specific error so a misconfigured deployment is obvious in
//     logs.

import (
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
)

// proxyToCP forwards `r` to the Control Plane, preserving path +
// query + method + body + Content-Type. Attaches the two DP-auth
// headers before dispatch. Writes the CP's response verbatim to `w`.
//
// Called from the wrapper handlers below (proxyRegisterSubmit, etc.).
// A single shared helper keeps the auth attachment + header copy in
// one place — a bug in any of that would silently affect every
// proxied endpoint otherwise.
func (s *Server) proxyToCP(w http.ResponseWriter, r *http.Request, cpPath string) {
	cpBase := s.deps.Cfg.ControlPlaneURL
	if cpBase == "" {
		writeErr(w, http.StatusServiceUnavailable,
			"KYC is proxied to the Control Plane, but CONTROL_PLANE_URL is not set on this deployment")
		return
	}
	if s.deps.Cfg.DataPlaneClientID <= 0 {
		writeErr(w, http.StatusServiceUnavailable,
			"KYC proxy misconfigured: DATA_PLANE_CLIENT_ID is not set on this deployment")
		return
	}

	// Build outbound URL — preserve query string so ?status=pending
	// filters etc. survive the hop.
	outURL := cpBase + cpPath
	if r.URL.RawQuery != "" {
		outURL += "?" + r.URL.RawQuery
	}

	// Bound the round-trip: 30s is generous for slowest realistic
	// CP-side work (approve fires /internal/orgs/create with its
	// own 3s timeout, so worst-case the CP responds inside ~5s).
	// If it doesn't, we'd rather 502 the browser than keep it
	// spinning.
	client := &http.Client{Timeout: 30 * time.Second}

	// Stream the request body to the CP. For JSON payloads this is
	// a couple of KB; for multipart doc uploads (Phase 3 follow-up)
	// io.Copy handles the streaming without buffering everything
	// in memory.
	req, err := http.NewRequestWithContext(r.Context(), r.Method, outURL, r.Body)
	if err != nil {
		log.Printf("proxyToCP: build request %s %s: %v", r.Method, outURL, err)
		writeErr(w, http.StatusInternalServerError, "proxy build failed")
		return
	}

	// Forward the caller's Content-Type so the CP knows how to
	// decode the body. Everything else is dropped on the floor —
	// we do NOT forward Authorization (the CP has its own auth via
	// X-Data-Plane-Api-Key) or cookies (CP sessions are separate).
	if ct := r.Header.Get("Content-Type"); ct != "" {
		req.Header.Set("Content-Type", ct)
	}
	if ct := r.Header.Get("Accept"); ct != "" {
		req.Header.Set("Accept", ct)
	}

	// Attach the DP-auth headers the Control Plane's dpProxyAuth
	// middleware expects.
	req.Header.Set("X-Data-Plane-Client-ID", strconv.FormatInt(s.deps.Cfg.DataPlaneClientID, 10))
	req.Header.Set("X-Data-Plane-Api-Key", s.deps.Cfg.DataPlaneAPIKey)

	// Forward-For chain so CP audit rows carry the real applicant
	// IP, not just the DP's box IP.
	if callerIP := clientIP(r); callerIP != "" {
		req.Header.Set("X-Forwarded-For", callerIP)
	}

	resp, err := client.Do(req)
	if err != nil {
		// context.DeadlineExceeded shows up here as a wrapped
		// net.Error; keep the message short so it doesn't leak a
		// full URL to the browser.
		if errors.Is(err, io.EOF) || errors.Is(err, http.ErrHandlerTimeout) {
			log.Printf("proxyToCP: CP call to %s timed out: %v", outURL, err)
			writeErr(w, http.StatusBadGateway, "control plane timeout")
			return
		}
		log.Printf("proxyToCP: CP call to %s failed: %v", outURL, err)
		writeErr(w, http.StatusBadGateway, "control plane unreachable")
		return
	}
	defer resp.Body.Close()

	// Copy the response headers we care about, then stream body.
	// Deliberately NOT copying Set-Cookie or Authorization — CP
	// sessions are separate from DP sessions.
	if ct := resp.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.WriteHeader(resp.StatusCode)
	if _, err := io.Copy(w, resp.Body); err != nil {
		log.Printf("proxyToCP: response stream to caller failed: %v", err)
	}
}

// ── Per-endpoint wrappers ─────────────────────────────────────────
//
// Each of these delegates to proxyToCP with the CP-side path. Kept as
// individually-named handlers so server.go's route table reads
// naturally and so we can add per-endpoint pre/post work later
// (e.g. audit_log entries on the DP side for a decision that lands
// on CP) without an if-tree inside the shared proxy helper.

// POST /api/register/submit → CP owns institution_applications
func (s *Server) proxyRegisterSubmit(w http.ResponseWriter, r *http.Request) {
	s.proxyToCP(w, r, "/api/register/submit")
}

// GET /api/register/{id} — status readback for the applicant.
func (s *Server) proxyRegisterStatus(w http.ResponseWriter, r *http.Request) {
	// chi's URL params live in the outbound path already because we
	// preserve r.URL.Path via cpPath. But this endpoint takes {id}
	// which isn't in r.URL.Path when chi's mux invokes us — it IS,
	// actually. r.URL.Path retains the pattern-matched literal.
	// Belt-and-braces: build the CP path from the raw path so a
	// route change doesn't silently break the proxy.
	s.proxyToCP(w, r, r.URL.Path)
}

// GET /api/client/applications → GET /api/reviewer/applications on CP
// Note the path RENAME: DP legacy uses /client/, CP standardises on
// /reviewer/. Same shape.
func (s *Server) proxyReviewerList(w http.ResponseWriter, r *http.Request) {
	s.proxyToCP(w, r, "/api/reviewer/applications")
}

// GET /api/client/applications/{id} → CP /api/reviewer/applications/{id}
// Note the path RENAME: DP legacy uses /client/, CP standardises on
// /reviewer/. Same shape.
func (s *Server) proxyReviewerGet(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}
	s.proxyToCP(w, r, "/api/reviewer/applications/"+url.PathEscape(id))
}

func (s *Server) proxyReviewerApprove(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}
	s.proxyToCP(w, r, fmt.Sprintf("/api/reviewer/applications/%s/approve", url.PathEscape(id)))
}

func (s *Server) proxyReviewerReject(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}
	s.proxyToCP(w, r, fmt.Sprintf("/api/reviewer/applications/%s/reject", url.PathEscape(id)))
}
