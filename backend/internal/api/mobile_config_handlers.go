package api

import (
	"net/http"
)

// GET /api/mobile/config
//
// Runtime knobs the Android verification-agent app reads on launch and
// then periodically after that. Everything here is derived from server
// state or config so the app never has to be rebuilt to tweak these.
//
// Fields intentionally kept small:
//   - min_supported_app_version — hard floor. If the app's own version
//     is below this, the app shows "please update" and blocks the flow.
//     Bump this after a security fix ships to force update.
//   - latest_app_version — informational. UI shows "update available"
//     when the app is behind but still ≥ min_supported.
//   - liveness_frame_count — how many frames the app captures for the
//     Luxand blink challenge. Matches the web SPA's default of 30.
//   - liveness_max_age_seconds — how fresh the /liveness-check row must
//     be at /face-match time. Backend already enforces this via
//     Cfg.LivenessMaxAgeSeconds; surfacing it lets the app decide when
//     to reissue vs when to trust the last pass.
//   - wallet_fee_per_lookup_paise — display-only; wallet debit still
//     happens server-side. Lets the login screen say "₹1 per lookup".
//   - photos_backend — "disk" or "s3". Lets the app know whether to
//     expect a 302 to a presigned URL (S3) vs. a direct byte stream.
//
// Unauthenticated on purpose — the app hits this before it has a token
// (to decide whether to allow login at all if a hard-update is
// required). None of the fields leak anything sensitive.
func (s *Server) mobileConfig(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"min_supported_app_version":   "1.0.0",
		"latest_app_version":          "1.0.0",
		"liveness_frame_count":        30,
		"liveness_max_age_seconds":    s.deps.Cfg.LivenessMaxAgeSeconds,
		"wallet_fee_per_lookup_paise": s.deps.Cfg.WalletFeePerLookupPaise,
		"photos_backend":              s.deps.Cfg.PhotosBackend,
	})
}
