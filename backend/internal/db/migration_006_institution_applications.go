package db

var migration006InstitutionApplications = migration{
	version: 6,
	name:    "institution_applications",
	stmts: []string{
		// Self-serve institution onboarding. A registrant fills the
		// form, uploads documents, and the row sits in 'pending' until
		// a superadmin reviews. On approval the row stays for audit
		// but its head_email + AISHE code get materialised into a
		// real organizations + users row (see superadmin_handlers.go).
		//
		// One row per AISHE code: on re-application after rejection,
		// the old row is DELETEd and a fresh one INSERTed in a single
		// transaction (see register_handlers.go). UNIQUE keeps spam
		// at bay even if the rate limiter is bypassed.
		`CREATE TABLE IF NOT EXISTS institution_applications (
			id                    INTEGER PRIMARY KEY AUTOINCREMENT,
			status                TEXT NOT NULL DEFAULT 'pending'
				CHECK (status IN ('draft','pending','approved','rejected')),

			institution_name      TEXT NOT NULL,
			institution_type      TEXT NOT NULL
				CHECK (institution_type IN ('school','college','university','coaching')),
			tier                  TEXT
				CHECK (tier IS NULL OR tier IN ('tier_1','tier_2','tier_3')),
			aishe_code            TEXT,
			pan                   TEXT,
			year_established      INTEGER,
			affiliation_body      TEXT,

			address_line1         TEXT NOT NULL,
			address_line2         TEXT,
			city                  TEXT NOT NULL,
			district              TEXT,
			state                 TEXT NOT NULL,
			pin_code              TEXT NOT NULL,

			approx_student_count  INTEGER,
			expected_centres      INTEGER NOT NULL DEFAULT 1,

			head_name             TEXT NOT NULL,
			head_designation      TEXT NOT NULL,
			head_email            TEXT NOT NULL,
			head_mobile           TEXT NOT NULL,

			reviewed_by_user_id   INTEGER REFERENCES users(id),
			reviewed_at           DATETIME,
			review_note           TEXT,
			submitter_ip          TEXT,

			created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE INDEX IF NOT EXISTS idx_inst_apps_status
			ON institution_applications(status, created_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_inst_apps_created
			ON institution_applications(created_at DESC)`,
		// Unique on aishe_code but only for non-draft rows so the same
		// AISHE code can move through draft → pending → rejected →
		// (replaced by) pending again as long as we DELETE old rows
		// during re-application. NULL aishe_code is allowed for
		// schools / coaching centres that don't have one.
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_inst_apps_aishe
			ON institution_applications(aishe_code)
			WHERE aishe_code IS NOT NULL`,
		`CREATE INDEX IF NOT EXISTS idx_inst_apps_head_email
			ON institution_applications(head_email)`,

		// Uploaded documents, one row per file. Files live on disk
		// under <ARTIFACT_DIR>/institution_docs/<bucket>/<app_id>/<id>_<sha8>.<ext>
		// where bucket = app_id / 100 so no single directory ever
		// holds more than ~100 institutions' subfolders. sha256 + size
		// recorded for tamper detection and bandwidth audit.
		`CREATE TABLE IF NOT EXISTS institution_application_documents (
			id              INTEGER PRIMARY KEY AUTOINCREMENT,
			application_id  INTEGER NOT NULL
				REFERENCES institution_applications(id) ON DELETE CASCADE,
			doc_kind        TEXT NOT NULL
				CHECK (doc_kind IN (
					'recognition_letter',
					'pan_card',
					'authorization_letter',
					'naac_certificate',
					'other'
				)),
			original_name   TEXT NOT NULL,
			storage_path    TEXT NOT NULL,
			mime            TEXT NOT NULL,
			size_bytes      INTEGER NOT NULL,
			sha256          TEXT NOT NULL,
			uploaded_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE INDEX IF NOT EXISTS idx_inst_app_docs_app
			ON institution_application_documents(application_id)`,

		// Magic links for the "set your password" flow after approval.
		// Token is never stored in plaintext — we store sha256(token)
		// and compare hashed-against-hashed at verify time. This way
		// a DB leak doesn't hand attackers usable links.
		//
		// Single-use: used_at is set when the link is consumed; further
		// verify attempts reject. expires_at gives a 7-day window.
		`CREATE TABLE IF NOT EXISTS magic_links (
			id           INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id      INTEGER NOT NULL
				REFERENCES users(id) ON DELETE CASCADE,
			token_hash   TEXT NOT NULL UNIQUE,
			purpose      TEXT NOT NULL
				CHECK (purpose IN ('set_password','reset_password')),
			expires_at   DATETIME NOT NULL,
			used_at      DATETIME,
			created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE INDEX IF NOT EXISTS idx_magic_links_user
			ON magic_links(user_id)`,
		`CREATE INDEX IF NOT EXISTS idx_magic_links_expires
			ON magic_links(expires_at) WHERE used_at IS NULL`,
	},
}
