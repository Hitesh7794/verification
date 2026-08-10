package db

// migration015ClientsExams introduces the superadmin's exam-catalog surface:
//
//   clients            — exam-conducting bodies (UP Govt, NTA, etc.).
//                        NOT customers, no login, no wallet — just a
//                        data record that owns a set of exams.
//   exams              — a single exam under a client, with a globally
//                        unique code and a verification date window.
//   exam_candidates    — one row per PASSED candidate from the CSV.
//                        Only these roll numbers will be searchable.
//   exam_csv_uploads   — audit trail of every raw CSV the superadmin
//                        uploaded per exam, kept on disk under
//                        ARTIFACT_DIR/exam_csvs/<exam_id>/.
//
// Both `clients` and `exams` carry two flags that the superadmin flips
// inline (no modal windows):
//   visible  — soft toggle. Later phases hide it from the college-
//              facing surface when false. Superadmin always sees it.
//   closed   — hard flag with an audit timestamp. Later phases refuse
//              new verifications against a closed exam. Reversible.
//
// Nothing existing is touched by this migration — organizations,
// institution_applications, users, wallets, verifications, the filesystem
// candidate index all continue to work exactly as before.
var migration015ClientsExams = migration{
	version: 15,
	name:    "clients_exams",
	stmts: []string{
		// ── clients ────────────────────────────────────────────────
		`CREATE TABLE clients (
			id           INTEGER PRIMARY KEY AUTOINCREMENT,
			name         TEXT NOT NULL,
			notes        TEXT,
			visible      INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0,1)),
			closed       INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0,1)),
			closed_at    DATETIME,
			created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE INDEX idx_clients_visible ON clients(visible, closed, created_at DESC)`,

		// ── exams ──────────────────────────────────────────────────
		// exam_code is globally UNIQUE: the superadmin manages the
		// codebook centrally, so two clients cannot both claim
		// EXAM-2026-01 by accident.
		`CREATE TABLE exams (
			id                 INTEGER PRIMARY KEY AUTOINCREMENT,
			client_id          INTEGER NOT NULL REFERENCES clients(id),
			name               TEXT NOT NULL,
			exam_code          TEXT NOT NULL,
			trustview_ref      TEXT,
			verification_from  DATE NOT NULL,
			verification_to    DATE NOT NULL,
			visible            INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0,1)),
			closed             INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0,1)),
			closed_at          DATETIME,
			created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			CHECK (verification_from <= verification_to)
		)`,
		`CREATE UNIQUE INDEX idx_exams_code ON exams(exam_code)`,
		`CREATE INDEX idx_exams_client ON exams(client_id, created_at DESC)`,

		// ── exam_candidates ────────────────────────────────────────
		// The same roll number can appear in different exams (a
		// student re-sits, or shares a number with someone else in
		// a different board's roster), so the UNIQUE is on the pair.
		// verification_date is per-candidate — some exams issue a
		// unique valid-through date per pass certificate.
		`CREATE TABLE exam_candidates (
			id                INTEGER PRIMARY KEY AUTOINCREMENT,
			exam_id           INTEGER NOT NULL
				REFERENCES exams(id) ON DELETE CASCADE,
			roll_no           TEXT NOT NULL,
			name              TEXT NOT NULL,
			verification_date DATE,
			created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			UNIQUE (exam_id, roll_no)
		)`,
		`CREATE INDEX idx_exam_candidates_exam ON exam_candidates(exam_id)`,
		// Cross-exam roll lookup at verification time (Phase 3):
		// operator scans a roll, we need "which exams is this roll in?".
		`CREATE INDEX idx_exam_candidates_roll ON exam_candidates(roll_no)`,

		// ── exam_csv_uploads ───────────────────────────────────────
		// One row per raw CSV file the superadmin uploaded. The file
		// bytes are on disk at storage_path; sha256 lets us detect
		// tampering. rows_seeded records what actually got inserted
		// so an audit can reconcile "the CSV had N rows, N-K were
		// duplicates already in the DB, K were new".
		`CREATE TABLE exam_csv_uploads (
			id             INTEGER PRIMARY KEY AUTOINCREMENT,
			exam_id        INTEGER NOT NULL
				REFERENCES exams(id) ON DELETE CASCADE,
			filename       TEXT NOT NULL,
			storage_path   TEXT NOT NULL,
			size_bytes     INTEGER NOT NULL,
			sha256         TEXT NOT NULL,
			uploaded_by    INTEGER NOT NULL REFERENCES users(id),
			uploaded_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			rows_seeded    INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE INDEX idx_exam_csv_uploads_exam ON exam_csv_uploads(exam_id, uploaded_at DESC)`,
	},
}
