package api

// InternalAuth — auth middleware for the /internal/* API surface that
// the Control Plane calls server-to-server. Enforces two independent
// gates:
//
//   1. Shared secret in the X-Internal-API-Key request header.
//      Constant-time compare against Cfg.InternalAPIKey. If the config
//      value is empty (dev default), every /internal/* call is refused
//      — fail-closed so an unconfigured deployment can't accidentally
//      expose the surface.
//
//   2. Optional IP allowlist. When Cfg.ControlPlaneAllowedIPs is
//      non-empty, the caller's IP (resolved via clientIP() which
//      honours X-Forwarded-For behind our nginx layer) must match at
//      least one entry. Entries can be bare IPs ("10.0.1.5") or CIDR
//      blocks ("10.0.2.0/24"). Empty allowlist skips this check and
//      relies purely on the shared secret + upstream firewall.
//
// Failures return 401 with a generic message. We deliberately do NOT
// distinguish "missing header" from "wrong secret" from "wrong IP" —
// a curious probe reads the same as an actively-hostile one, no info
// leak. Real diagnostics land in the server log.

import (
	"crypto/subtle"
	"log"
	"net"
	"net/http"
)

// internalAuth wraps a handler so only Control Plane calls can reach
// it. Returned as an http.Handler so it composes cleanly with the
// chi.Router.Use(...) idiom used elsewhere in server.go.
func (s *Server) internalAuth(next http.Handler) http.Handler {
	// Snapshot config values into locals so the closure doesn't chase
	// pointers on every request. The middleware is registered once at
	// boot; config doesn't hot-reload.
	expectedKey := s.deps.Cfg.InternalAPIKey
	allowedIPs := s.deps.Cfg.ControlPlaneAllowedIPs

	// Pre-parse the allowlist once so per-request cost is O(N)
	// comparisons, not O(N) parses. Invalid entries are logged at
	// startup and dropped rather than crashing boot.
	type acl struct {
		single net.IP // set iff CIDR is nil
		cidr   *net.IPNet
	}
	var parsedACL []acl
	for _, raw := range allowedIPs {
		if _, cidr, err := net.ParseCIDR(raw); err == nil {
			parsedACL = append(parsedACL, acl{cidr: cidr})
			continue
		}
		if ip := net.ParseIP(raw); ip != nil {
			parsedACL = append(parsedACL, acl{single: ip})
			continue
		}
		log.Printf("internalAuth: ignoring un-parseable CONTROL_PLANE_ALLOWED_IPS entry %q", raw)
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Gate 1: shared secret must be configured on the server AND
		// match on the request. Empty server-side = fail-closed.
		if expectedKey == "" {
			log.Printf("internalAuth: refused /internal call to %s — INTERNAL_API_KEY not set on this deployment", r.URL.Path)
			writeErr(w, http.StatusUnauthorized, "internal API not configured")
			return
		}
		got := r.Header.Get("X-Internal-API-Key")
		if subtle.ConstantTimeCompare([]byte(got), []byte(expectedKey)) != 1 {
			log.Printf("internalAuth: bad or missing X-Internal-API-Key on %s from %s", r.URL.Path, clientIP(r))
			writeErr(w, http.StatusUnauthorized, "unauthorised")
			return
		}

		// Gate 2: optional IP allowlist. Only enforced when configured.
		if len(parsedACL) > 0 {
			caller := clientIP(r)
			callerIP := net.ParseIP(caller)
			if callerIP == nil {
				log.Printf("internalAuth: could not parse caller IP %q on %s", caller, r.URL.Path)
				writeErr(w, http.StatusUnauthorized, "unauthorised")
				return
			}
			ok := false
			for _, entry := range parsedACL {
				if entry.cidr != nil {
					if entry.cidr.Contains(callerIP) {
						ok = true
						break
					}
					continue
				}
				if entry.single.Equal(callerIP) {
					ok = true
					break
				}
			}
			if !ok {
				log.Printf("internalAuth: caller %s not in CONTROL_PLANE_ALLOWED_IPS for %s", caller, r.URL.Path)
				writeErr(w, http.StatusUnauthorized, "unauthorised")
				return
			}
		}

		next.ServeHTTP(w, r)
	})
}
