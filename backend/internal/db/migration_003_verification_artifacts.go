package db

var migration003VerificationArtifacts = migration{
	version: 3,
	name:    "verification_artifacts",
	stmts: []string{
		`CREATE TABLE IF NOT EXISTS verification_artifacts (
			id              INTEGER PRIMARY KEY AUTOINCREMENT,
			verification_id INTEGER NOT NULL REFERENCES verifications(id) ON DELETE CASCADE,
			kind            TEXT NOT NULL CHECK (kind IN (
				'captured_face',
				'captured_fp_image',
				'captured_fp_template',
				'captured_iris_left',
				'captured_iris_right'
			)),
			mime            TEXT NOT NULL,
			sha256          TEXT NOT NULL,
			size_bytes      INTEGER NOT NULL,
			storage_path    TEXT,
			created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE INDEX IF NOT EXISTS idx_artifacts_verification ON verification_artifacts(verification_id)`,
		`CREATE INDEX IF NOT EXISTS idx_artifacts_kind ON verification_artifacts(kind)`,
	},
}
