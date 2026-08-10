package db

var migration004FingerprintVendor = migration{
	version: 4,
	name:    "fingerprint_vendor",
	stmts: []string{
		// Records which fingerprint SDK produced the match. NULL on
		// rows that predate multi-vendor support and on rows where the
		// operator skipped the fingerprint step entirely. Allowed
		// values today: 'mantra' (MorFin) and 'startek' (ACPL Capture
		// API for FM220U L1). Open enum on purpose — new vendors
		// don't need a schema change, just a frontend client.
		`ALTER TABLE verifications ADD COLUMN fp_vendor TEXT`,
	},
}
