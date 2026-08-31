// Package config loads the Control Plane's runtime settings from env
// vars. Deliberately separate from the Data Plane's config package
// (backend/internal/config) — Control Plane has its own DB, its own
// JWT secret, and its own port, so mixing the two configs was more
// confusing than reusing anything.
//
// Env-var prefix convention: everything here starts with CP_ so a
// single .env can hold both Data Plane and Control Plane settings
// without collisions during dev.
package config

import (
	"os"
	"strconv"
	"strings"
)

type Config struct {
	// HTTPAddr is the listen address for the Control Plane API.
	// Defaults to :8090 to avoid the Data Plane's :8080 in dev.
	HTTPAddr string

	// DatabaseURL is the Control Plane's own Postgres. Separate DB
	// from any Data Plane — this holds platform_users,
	// clients_registry, and (from Phase 3) the central KYC queue.
	// Point at a different database name than the Data Plane in dev
	// so the two schemas don't overlap.
	DatabaseURL string

	// JWTSecret signs tokens for platform_users (superadmin logins).
	// Separate from the Data Plane's JWT_SECRET so a compromised Data
	// Plane can't mint tokens accepted by the Control Plane, and vice
	// versa. Phase 0 of the migration plan calls for moving to RS256
	// with an RSA keypair; this HS256 secret is the interim shape.
	JWTSecret string

	// AppEnv toggles dev-vs-prod strictness the same way the Data
	// Plane's config does. "production" refuses to boot with the
	// default JWT secret; "development" (default) is permissive.
	AppEnv string

	// AllowedOrigins is the CORS allowlist for the Control Plane's
	// own frontend. Comma-separated in the env var.
	AllowedOrigins []string

	// FederatedTimeoutMS bounds how long the federated dashboard
	// endpoint waits on a slow Data Plane before giving up on that
	// Data Plane and returning partial results. Keep it short so a
	// single sick Data Plane can't hang the whole dashboard.
	// Default 3000 (3s) — enough for a slow WAN hop, short enough
	// that the operator doesn't stare at a spinner.
	FederatedTimeoutMS int

	// PublicBaseURL is the CP's user-visible URL (for magic-link
	// composition in welcome / approval emails). If empty the CP
	// falls back to the request's Origin / Host — fine for dev,
	// prod should pin this explicitly.
	PublicBaseURL string

	// ─── Outbound email (registration + reviewer decision mails)
	// mirrors the Data Plane's SMTP config so a single .env can hold
	// both. Empty SMTPHost falls back to the console sender.
	SMTPHost string
	SMTPPort string
	SMTPUser string
	SMTPPass string
	SMTPFrom string

	// ─── Outbound SMS (registration OTP). Same shape + defaults as
	// the Data Plane so both binaries can read the same env vars.
	AuthKeySMSKey         string
	AuthKeySMSSID         string
	AuthKeySMSCompany     string
	AuthKeySMSCountryCode string
	AuthKeySMSURL         string

	// ─── S3 (KYC document storage). Docs uploaded during
	// registration land in this bucket keyed by
	// _kyc/applications/<app_id>/<doc_id>_<doc_kind>.<ext> — same key
	// layout the Data Plane uses today, so cross-linking with any
	// pre-existing KYC docs stays clean.
	S3Bucket string
	S3Region string
}

// DefaultDevJWTSecret is the dev-only fallback. main.go refuses to
// boot in production if the effective secret matches this value.
const DefaultDevJWTSecret = "cp-dev-only-secret-change-me"

func Load() Config {
	loadDotEnv()
	return Config{
		HTTPAddr:                   envOr("CP_HTTP_ADDR", ":8090"),
		DatabaseURL:                envOr("CP_DATABASE_URL", "postgres://portal:portal-dev@127.0.0.1:5434/verification_cp?sslmode=disable"),
		JWTSecret:                  envOr("CP_JWT_SECRET", DefaultDevJWTSecret),
		AppEnv:                     envOr("APP_ENV", "development"),
		AllowedOrigins:             envOrigins("CP_ALLOWED_ORIGINS"),
		FederatedTimeoutMS:         envInt("CP_FEDERATED_TIMEOUT_MS", 3000),
		PublicBaseURL:              strings.TrimRight(envOr("CP_PUBLIC_BASE_URL", ""), "/"),
		SMTPHost:                   envOr("SMTP_HOST", ""),
		SMTPPort:                   envOr("SMTP_PORT", "587"),
		SMTPUser:                   envOr("SMTP_USER", ""),
		SMTPPass:                   envOr("SMTP_PASS", ""),
		SMTPFrom:                   envOr("SMTP_FROM", "Verification Portal <noreply@example.com>"),
		AuthKeySMSKey:              envOr("AUTHKEY_SMS_KEY", ""),
		AuthKeySMSSID:              envOr("AUTHKEY_SMS_SID", ""),
		AuthKeySMSCompany:          envOr("AUTHKEY_SMS_COMPANY", ""),
		AuthKeySMSCountryCode:      envOr("AUTHKEY_SMS_COUNTRY_CODE", "91"),
		AuthKeySMSURL:              envOr("AUTHKEY_SMS_URL", "https://api.authkey.io/request"),
		S3Bucket:                   envOr("S3_BUCKET", ""),
		S3Region:                   envOr("S3_REGION", "ap-south-1"),
	}
}

// IsProduction mirrors the Data Plane's semantics — anything other
// than "" / "development" / "dev" counts as prod, so an operator typo
// on the env var fails closed (stricter checks apply).
func (c Config) IsProduction() bool {
	v := strings.ToLower(strings.TrimSpace(c.AppEnv))
	return v != "" && v != "development" && v != "dev"
}

// loadDotEnv reads .env files from a handful of candidate paths so
// `go run ./cmd/control-plane` from either the repo root or the
// backend dir picks them up in dev. Silently ignores missing files.
// Same pattern as the Data Plane's loader — kept as a copy rather
// than shared to avoid a cross-package dep for a 20-line helper.
func loadDotEnv() {
	candidates := []string{".env", "backend/.env", "../backend/.env", "../.env"}
	for _, path := range candidates {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			parts := strings.SplitN(line, "=", 2)
			if len(parts) != 2 {
				continue
			}
			key := strings.TrimSpace(parts[0])
			val := strings.Trim(strings.TrimSpace(parts[1]), `"'`)
			if os.Getenv(key) == "" {
				_ = os.Setenv(key, val)
			}
		}
		break
	}
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

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
