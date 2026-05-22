package config

import (
	"os"
	"path/filepath"
	"strconv"
)

type Config struct {
	HTTPAddr  string
	DBPath    string
	DataDir   string
	JWTSecret string

	// Decision thresholds applied server-side as a sanity check on what
	// the operator's browser submits. Per-org overrides come later; for
	// now these are the global defaults.
	//
	// FPMatchThresholdDefault matches the vendor's own
	// `DEFAULT_MATCH_THRESHOLD = 140` constant, found in the MorFin
	// `MorfinAuthClientService` JAR. Earlier value (60) was a guess; 140
	// is the value the vendor's reference daemon hard-codes, so it's the
	// best signal we have until a hardware capture lets us look at the
	// actual score distribution and tune from there.
	FPMatchThresholdDefault   int     // MorFin MatchScore. Vendor default = 140.
	IrisMatchThresholdDefault float64 // Marvis MatchImage score per eye. Vendor TBD; placeholder.
	FaceMatchThresholdDefault float64 // Luxand similarity, when wired in. Placeholder.

	// ArtifactRetention controls whether the backend accepts and stores
	// captured face/fp/iris bytes alongside the verification row.
	//   "none"     — drop on receipt, no metadata kept
	//   "metadata" — record sha256/size/mime but discard bytes
	//   "full"     — store bytes under ArtifactDir
	ArtifactRetention string
	ArtifactDir       string

	// Luxand face-matching service. The portal backend forwards captured
	// webcam JPEGs to this service. Loopback-only by default; the service
	// only accepts traffic from the backend itself.
	LuxandBase      string // base URL, e.g. http://127.0.0.1:8040/face/
	FaceTemplateDir string // disk cache for extracted gallery face templates

	// fp-match-service (SourceAFIS) — server-side fingerprint matcher.
	// Forwards the operator's probe template plus the candidate's gallery
	// template; returns a similarity score. Same loopback-only deployment
	// model as luxand. Empty string disables the endpoint cleanly so the
	// backend still boots without the service running.
	FpMatchBase string // base URL, e.g. http://127.0.0.1:8050/fp/

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

	// Per-deployment wallet tuning. All amounts in paise (₹1 = 100 paise).
	WalletFeePerLookupPaise int    // default 500 = ₹5
	WalletMaxDepositPaise   int    // default 5_000_000 = ₹50,000 (single deposit cap)
	WalletSameRollCacheMin  int    // default 5 — same roll, same user, no re-charge for this many minutes
}

func Load() Config {
	return Config{
		HTTPAddr:                  envOr("HTTP_ADDR", ":8080"),
		DBPath:                    envOr("DB_PATH", "verification.db"),
		DataDir:                   envOr("DATA_DIR", defaultDataDir()),
		JWTSecret:                 envOr("JWT_SECRET", "dev-only-secret-change-me"),
		FPMatchThresholdDefault:   envInt("FP_MATCH_THRESHOLD", 140),
		IrisMatchThresholdDefault: envFloat("IRIS_MATCH_THRESHOLD", 0.6),
		FaceMatchThresholdDefault: envFloat("FACE_MATCH_THRESHOLD", 0.7),
		ArtifactRetention:         envOr("ARTIFACT_RETENTION", "none"),
		ArtifactDir:               envOr("ARTIFACT_DIR", "artifacts"),
		LuxandBase:                envOr("LUXAND_BASE", "http://127.0.0.1:8040/face/"),
		FaceTemplateDir:           envOr("FACE_TEMPLATE_DIR", "face_templates"),
		FpMatchBase:               envOr("FP_MATCH_BASE", "http://127.0.0.1:8050/fp/"),
		RazorpayKeyID:             envOr("RAZORPAY_KEY_ID", ""),
		RazorpayKeySecret:         envOr("RAZORPAY_KEY_SECRET", ""),
		WalletFeePerLookupPaise:   envInt("WALLET_FEE_PER_LOOKUP_PAISE", 500),
		WalletMaxDepositPaise:     envInt("WALLET_MAX_DEPOSIT_PAISE", 5_000_000),
		WalletSameRollCacheMin:    envInt("WALLET_SAME_ROLL_CACHE_MIN", 5),
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
