// Shared types + constants for the multi-vendor fingerprint layer.
//
// The portal supports two fingerprint vendors today: Mantra MorFin
// (cross-platform) and Startek/ACPL FM220U L1 (Windows-only for now).
// Both daemons can coexist on the same operator laptop, each on its
// own loopback port. The registry probes both in parallel; whichever
// reports a connected device wins the session.
//
// The vendor enum lives here (not inside each vendor client) so the
// registry, the React component, and the audit submit can agree on
// the wire value going into verifications.fp_vendor. Adding a third
// vendor later means adding one enum entry + one client module —
// no protocol-level changes.

export const Vendor = Object.freeze({
  Mantra: 'mantra',   // MorFin Auth (MELO041 / MFS500 / MARC10), localhost:8030
  Startek: 'startek', // ACPL Capture API (FM220U L1 / AST300), localhost:8090 or :4443
})

// Per-vendor default thresholds applied frontend-side. Vendors land into
// the same verifications.match_threshold column on submit but use
// incompatible score scales:
//
//   Both vendors      — SourceAFIS similarity score, ~0..600+ range.
//                       40 is SourceAFIS's documented threshold for
//                       1-in-1000 FMR (false-match rate). On observed
//                       templates self-match scores 300-500, different-
//                       finger cross-match scores 0-5 — enormous
//                       separation, 40 is the safest default.
//
// As of 2026-06-10 Mantra also runs through fp-match-service (SourceAFIS)
// — see CONTEXT.md §13. Both vendors share the same threshold because
// they share the same matcher; vendor branding only survives on the
// audit row's fp_vendor tag for per-vendor analytics.
//
// Tunable per-deployment: backend's FP_MATCH_THRESHOLD env (default 40)
// is the source of truth; the number here is the frontend-side fallback
// when the backend's response doesn't carry a threshold (e.g. dev-mode
// without fp-match-service running).
// Unified TrustView 0-100 scale after the 2026-08 migration. Backend
// decides pass/fail against 50; the frontend display just mirrors it
// so score/threshold reads consistently. Old SourceAFIS-native
// thresholds (40 for Mantra + Startek) are retired.
export const DefaultThresholds = Object.freeze({
  [Vendor.Mantra]: 50,
  [Vendor.Startek]: 50,
})

// Friendly labels for the device-status banner.
export const VendorLabel = Object.freeze({
  [Vendor.Mantra]: 'Mantra',
  [Vendor.Startek]: 'Startek',
})

// `Result` is the shape FingerprintCapture.jsx expects from any vendor's
// match() call. Each vendor client adapts its raw envelope into this
// shape so the React component is vendor-agnostic.
//
// Fields:
//   ok              — match score crossed the threshold (vendor-side decision)
//   score           — raw match score (vendor scale)
//   threshold       — threshold applied at decision time (for audit)
//   bitmapBase64    — captured fingerprint image preview, base64 BMP, or null
//                     if vendor doesn't expose one
//   quality         — capture quality 1..100, or null
//   nfiq            — NIST quality 1..5, or null (MorFin only — Startek
//                     doesn't expose this through the public API)
//   liveness        — -1 unknown / 0 spoof / 1 live, or null
//   deviceSerial    — device hardware serial
//   deviceModel     — device model identifier
//   templateFormat  — gallery template format used in the match
//                     (FMR_V2005 / FMR_V2011 / ANSI_V378)
//   vendor          — which vendor produced this result (Vendor enum)
//   rawSdkResponse  — original SDK envelope for debugging / audit
