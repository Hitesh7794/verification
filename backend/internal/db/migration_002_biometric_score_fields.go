package db

var migration002BiometricScoreFields = migration{
	version: 2,
	name:    "biometric_score_fields",
	stmts: []string{
		// Hardware identity captured at decision time.
		`ALTER TABLE verifications ADD COLUMN device_serial TEXT`,
		`ALTER TABLE verifications ADD COLUMN device_model TEXT`,

		// Fingerprint signals from MorFin: capture quality (1-100), NFIQ
		// (1-5, NIST quality), match score (vendor scale, threshold-tested
		// at decision time), liveness (-1 unknown / 0 spoof / 1 live),
		// and the template format used for the gallery side of the match.
		`ALTER TABLE verifications ADD COLUMN fp_template_format TEXT`,
		`ALTER TABLE verifications ADD COLUMN fp_quality INTEGER`,
		`ALTER TABLE verifications ADD COLUMN fp_nfiq INTEGER`,
		`ALTER TABLE verifications ADD COLUMN fp_match_score INTEGER`,
		`ALTER TABLE verifications ADD COLUMN fp_liveness INTEGER`,

		// Iris signals from Marvis MatchImage. Two scores (left/right eye)
		// plus per-eye quality from IrisAnatomy.
		`ALTER TABLE verifications ADD COLUMN iris_left_score REAL`,
		`ALTER TABLE verifications ADD COLUMN iris_right_score REAL`,
		`ALTER TABLE verifications ADD COLUMN iris_left_quality INTEGER`,
		`ALTER TABLE verifications ADD COLUMN iris_right_quality INTEGER`,

		// Face score reserved for Luxand integration (later). Single
		// similarity score (0..100 in vendor's scale).
		`ALTER TABLE verifications ADD COLUMN face_match_score REAL`,

		// Decision audit: which channel produced the verified/denied
		// result, what threshold was applied at that moment (thresholds
		// can change over time — log the value used), and how long the
		// whole verification took (UX/SLA telemetry).
		`ALTER TABLE verifications ADD COLUMN via TEXT`,
		`ALTER TABLE verifications ADD COLUMN match_threshold INTEGER`,
		`ALTER TABLE verifications ADD COLUMN decision_ms INTEGER`,
		`ALTER TABLE verifications ADD COLUMN client_app_version TEXT`,

		// Idempotency: client supplies a UUID; a retried POST returns
		// the original row instead of inserting a duplicate.
		`ALTER TABLE verifications ADD COLUMN idempotency_key TEXT`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_verifications_idempotency
			ON verifications(idempotency_key)
			WHERE idempotency_key IS NOT NULL`,
	},
}
