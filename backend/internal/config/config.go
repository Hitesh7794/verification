package config

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type Config struct {
	HTTPAddr  string
	// DatabaseURL is a standard Postgres DSN:
	//   postgres://user:pass@host:port/dbname?sslmode=disable
	// Dev + single-host prod run Postgres on loopback (sslmode=disable
	// is fine). Point at RDS with sslmode=require when we go multi-host.
	DatabaseURL string
	DataDir   string
	JWTSecret string

	// AppEnv switches deployment-aware behaviour. "production" (or anything
	// non-empty other than "development"/"dev") enables strict checks that
	// would be annoying in local dev: refusing to boot with the default
	// JWT secret, requiring AllowedOrigins, etc. Empty / "development" /
	// "dev" all behave like dev. Set APP_ENV=production in prod.
	AppEnv string

	// AllowedOrigins is the CORS allowlist. Comma-separated env var:
	// "https://portal.example.com,https://signup.portal.example.com".
	// In dev, defaults to the Vite dev server URLs so localhost development
	// keeps working with no env vars set.
	AllowedOrigins []string

	// PublicBaseURL is the user-visible base URL the portal lives at —
	// where magic links should send recipients. In dev this is empty
	// and the link is composed from the incoming request's Origin or
	// Host header (so localhost stays localhost). In production set it
	// to the frontend URL, e.g. "https://portal.example.com". The
	// backend itself may sit behind a different host (api.portal.*),
	// but emails MUST point at the public frontend.
	PublicBaseURL string

	// Decision thresholds applied server-side as a sanity check on what
	// the operator's browser submits. Per-org overrides come later; for
	// now these are the global defaults.
	//
	// Iris score threshold — Marvis MatchImage 0..1 per eye. Placeholder
	// until we have enough hardware captures to tune it against real
	// distributions. Face + fingerprint thresholds are TrustView-managed
	// (unified 0..100 scale, 50 = accept) so no config value is needed
	// on the server side for those anymore.
	IrisMatchThresholdDefault float64

	// ArtifactRetention controls whether the backend accepts and stores
	// captured face/fp/iris bytes alongside the verification row.
	//   "none"     — drop on receipt, no metadata kept
	//   "metadata" — record sha256/size/mime but discard bytes
	//   "full"     — store bytes under ArtifactDir
	ArtifactRetention string
	ArtifactDir       string

	// TrustView hosted compare API (v1.trustview.in). Single endpoint
	// replaces the on-prem face + fingerprint matchers and the operator-
	// laptop iris matcher. Token is per-deployment, expires — rotate via
	// TRUSTVIEW_TOKEN. Empty token → the biometric compare handlers
	// return 503 loudly instead of silently proxying broken calls.
	TrustViewBaseURL string // default https://v1.trustview.in
	TrustViewToken   string // Bearer token; empty = compare disabled

	// Razorpay test-mode integration for the per-client wallet feature.
	// Keys come from the Razorpay dashboard → Settings → API Keys (test
	// mode); they look like rzp_test_<14 chars>. The KEY_ID is sent to
	// the browser to init Razorpay Checkout (public); the KEY_SECRET
	// stays server-side for order creation + HMAC signature verification.
	//
	// Both empty = wallet endpoints return 503 and the candidate-lookup
	// charge middleware is bypassed (i.e. the portal runs unchanged for
	// any deployment that doesn't want the wallet flow). That makes
	// onboarding the keys an explicit opt-in instead of a silent crash
	// vector.
	RazorpayKeyID     string
	RazorpayKeySecret string

	// Razorpay webhook secret. Set per-endpoint in the Razorpay dashboard
	// (Settings → Webhooks → click your URL → Secret). Razorpay HMAC-signs
	// each webhook POST body with this secret and puts the hex in the
	// X-Razorpay-Signature header — our handler refuses any POST whose
	// signature doesn't verify. Different from RazorpayKeySecret on purpose
	// so a compromised API key doesn't immediately let an attacker forge
	// webhooks (and vice versa).
	//
	// Empty = webhook endpoint returns 503 (intentional: no webhook
	// configured means we don't accept webhook traffic).
	RazorpayWebhookSecret string

	// Per-deployment wallet tuning. All amounts in paise (₹1 = 100 paise).
	WalletFeePerLookupPaise int    // default 500 = ₹5
	WalletMaxDepositPaise   int    // default 5_000_000 = ₹50,000 (single deposit cap)
	WalletSameRollCacheMin  int    // default 1440 (24h) — same roll, same org, no re-charge inside this window

	// DownloadsDir is where the operator-laptop install bundle (the
	// Windows .zip today, the signed .exe later) lives on disk. The
	// admin Downloads page lists whatever the backend finds here and
	// streams it to the requesting admin's browser. Production deploy
	// sets DOWNLOADS_DIR to an absolute path like /opt/portal/downloads
	// outside the source tree; dev defaults to "./downloads/" so a
	// developer can drop the build artefact in place and iterate.
	DownloadsDir string

	// Outbound email via SMTP. SMTPHost == "" → falls back to the
	// console sender (dev default). Any provider with STARTTLS on a
	// numeric port works: Gmail (smtp.gmail.com:587), Zoho, Office
	// 365, AWS SES SMTP, Resend, etc.
	SMTPHost string
	SMTPPort string // default 587
	SMTPUser string
	SMTPPass string // Gmail App Password / SES SMTP secret / etc — NOT a regular login password
	SMTPFrom string // RFC-5322 From header, e.g. `Verification Portal <noreply@example.com>`

	// Outbound SMS via AuthKey.io
	AuthKeySMSKey         string
	AuthKeySMSSID         string
	AuthKeySMSCompany     string
	AuthKeySMSCountryCode string
	AuthKeySMSURL         string
}

func Load() Config {
	return Config{
		HTTPAddr:                  envOr("HTTP_ADDR", ":8080"),
		DatabaseURL:               envOr("DATABASE_URL", "postgres://portal:portal-dev@127.0.0.1:5434/verification?sslmode=disable"),
		DataDir:                   envOr("DATA_DIR", defaultDataDir()),
		JWTSecret:                 envOr("JWT_SECRET", DefaultDevJWTSecret),
		AppEnv:                    envOr("APP_ENV", "development"),
		AllowedOrigins:            envOrigins("ALLOWED_ORIGINS"),
		PublicBaseURL:             strings.TrimRight(envOr("PUBLIC_BASE_URL", ""), "/"),
		IrisMatchThresholdDefault: envFloat("IRIS_MATCH_THRESHOLD", 0.6),
		ArtifactRetention:         envOr("ARTIFACT_RETENTION", "none"),
		ArtifactDir:               envOr("ARTIFACT_DIR", "artifacts"),
		TrustViewBaseURL:          envOr("TRUSTVIEW_BASE_URL", "https://v1.trustview.in"),
		TrustViewToken:            envOr("TRUSTVIEW_TOKEN", ""),
		RazorpayKeyID:             envOr("RAZORPAY_KEY_ID", ""),
		RazorpayKeySecret:         envOr("RAZORPAY_KEY_SECRET", ""),
		RazorpayWebhookSecret:     envOr("RAZORPAY_WEBHOOK_SECRET", ""),
		WalletFeePerLookupPaise:   envInt("WALLET_FEE_PER_LOOKUP_PAISE", 500),
		WalletMaxDepositPaise:     envInt("WALLET_MAX_DEPOSIT_PAISE", 5_000_000),
		WalletSameRollCacheMin:    envInt("WALLET_SAME_ROLL_CACHE_MIN", 1440),
		DownloadsDir:              envOr("DOWNLOADS_DIR", "downloads"),
		SMTPHost:                  envOr("SMTP_HOST", ""),
		SMTPPort:                  envOr("SMTP_PORT", "587"),
		SMTPUser:                  envOr("SMTP_USER", ""),
		SMTPPass:                  envOr("SMTP_PASS", ""),
		SMTPFrom:                  envOr("SMTP_FROM", ""),
		AuthKeySMSKey:             envOr("AUTHKEY_SMS_KEY", "877f65eb773cee5d"),
		AuthKeySMSSID:             envOr("AUTHKEY_SMS_SID", "44529"),
		AuthKeySMSCompany:         envOr("AUTHKEY_SMS_COMPANY", "seQRview"),
		AuthKeySMSCountryCode:     envOr("AUTHKEY_SMS_COUNTRY_CODE", "91"),
		AuthKeySMSURL:             envOr("AUTHKEY_SMS_URL", "https://api.authkey.io/request"),
	}
}

// DefaultDevJWTSecret is the dev-only fallback JWT_SECRET. main.go checks
// against this constant to refuse boot in production with the default.
const DefaultDevJWTSecret = "dev-only-secret-change-me"

// IsProduction reports whether the server is running in production mode.
// Anything other than "" / "development" / "dev" counts as prod, so an
// operator typo on the env var fails closed (stricter checks apply).
func (c Config) IsProduction() bool {
	v := strings.ToLower(strings.TrimSpace(c.AppEnv))
	return v != "" && v != "development" && v != "dev"
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// envOrigins parses a comma-separated origin allowlist out of the env.
// Trims whitespace + drops empties. Returns nil if unset; main.go decides
// the appropriate dev fallback.
func envOrigins(k string) []string {
	raw := strings.TrimSpace(os.Getenv(k))
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func envFloat(k string, def float64) float64 {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.ParseFloat(v, 64); err == nil {
			return n
		}
	}
	return def
}

// defaultDataDir resolves the bundled sample data folder regardless of
// where the binary is launched from. A candidate path is only accepted if
// it contains *at least one* enrolled center (a directory with the
// {photo,fps,iso} triplet underneath it) — that prevents a parent
// directory containing unrelated subfolders from being picked as the root.
//
// Override with DATA_DIR in production where the data lives under
// /var/lib or similar.
func defaultDataDir() string {
	candidates := []string{
		"../gndu27_enrollments_data_2026-04-08 11_38_23.492595",
		"../../gndu27_enrollments_data_2026-04-08 11_38_23.492595",
		"./gndu27_enrollments_data_2026-04-08 11_38_23.492595",
		"..",    // sample data lives alongside the project root
		"../..", // ditto, one level higher
	}
	for _, c := range candidates {
		abs, err := filepath.Abs(c)
		if err != nil {
			continue
		}
		if _, err := os.Stat(abs); err != nil {
			continue
		}
		if hasEnrolledLayout(abs) {
			return abs
		}
	}
	// Fall back to the historical default. The server tolerates a missing
	// data tree and starts with an empty index.
	if abs, err := filepath.Abs(candidates[0]); err == nil {
		return abs
	}
	return candidates[0]
}

// hasEnrolledLayout reports whether the directory rooted at path contains
// at least one path matching <root>/<org>/<date>/<center>/photo. Bounded:
// reads at most a few entries at each level so it stays fast even on large
// filesystems.
func hasEnrolledLayout(path string) bool {
	orgs, err := os.ReadDir(path)
	if err != nil {
		return false
	}
	for _, org := range orgs {
		if !org.IsDir() {
			continue
		}
		dates, err := os.ReadDir(filepath.Join(path, org.Name()))
		if err != nil {
			continue
		}
		for _, date := range dates {
			if !date.IsDir() {
				continue
			}
			centers, err := os.ReadDir(filepath.Join(path, org.Name(), date.Name()))
			if err != nil {
				continue
			}
			for _, ctr := range centers {
				if !ctr.IsDir() {
					continue
				}
				if _, err := os.Stat(filepath.Join(path, org.Name(), date.Name(), ctr.Name(), "photo")); err == nil {
					return true
				}
			}
		}
	}
	return false
}
