package db

// migration019DynamicCatalog extends the per-exam catalog so a CSV upload
// carries more than just (roll_no, name, verification_date) — the extra
// candidate fields land on the PDF receipt at verification time, and
// centres get a first-class table keyed by (exam_id, centre_code).
//
// Per-exam scoping (both here and on the CSV upload endpoints) means:
//   - Each exam has its own candidate + centre catalog. Same centre_code
//     in NEET1 and NEET2 is two rows, not one.
//   - Uploading a new CSV upserts by the natural key
//     (exam_id, roll_no) or (exam_id, centre_code); no data leaks across.
//
// Columns on exam_candidates are all nullable so old 3-column CSVs
// (roll_no, name, verification_date) keep working unchanged.
var migration019DynamicCatalog = migration{
	version: 19,
	name:    "dynamic_catalog",
	stmts: []string{
		// PDF-receipt-friendly fields on the candidate row.
		`ALTER TABLE exam_candidates ADD COLUMN registration_id TEXT`,
		`ALTER TABLE exam_candidates ADD COLUMN father_name     TEXT`,
		`ALTER TABLE exam_candidates ADD COLUMN dob             DATE`,
		`ALTER TABLE exam_candidates ADD COLUMN gender          TEXT`,
		`ALTER TABLE exam_candidates ADD COLUMN shift_name      TEXT`,
		`ALTER TABLE exam_candidates ADD COLUMN centre_code     TEXT`,
		`CREATE INDEX IF NOT EXISTS idx_exam_candidates_centre
		     ON exam_candidates(centre_code)`,
		`CREATE INDEX IF NOT EXISTS idx_exam_candidates_regid
		     ON exam_candidates(registration_id)`,

		// Per-exam centre catalog. Same centre_code can exist in
		// multiple exams — the (exam_id, centre_code) unique key
		// makes each exam's centre list independent.
		`CREATE TABLE IF NOT EXISTS exam_centres (
			id           INTEGER PRIMARY KEY AUTOINCREMENT,
			exam_id      INTEGER NOT NULL
				REFERENCES exams(id) ON DELETE CASCADE,
			centre_code  TEXT NOT NULL,
			centre_name  TEXT NOT NULL,
			address      TEXT,
			city         TEXT,
			state        TEXT,
			pincode      TEXT,
			created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			UNIQUE (exam_id, centre_code)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_exam_centres_exam
		     ON exam_centres(exam_id)`,
	},
}
