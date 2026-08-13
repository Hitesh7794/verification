package db

// migration022OperatorScopeAndExamModalities lands two independent
// changes in one shot because both are landing together in the same
// deploy and neither is worth its own migration slot:
//
//   1. Enforce one-exam-per-operator via a UNIQUE index on
//      operator_exams.user_id. The join table shape stays (one exam
//      can still have many operators); only the reverse direction
//      collapses to 1:1. Reversible by dropping the index.
//
//   2. Per-exam biometric requirements on the exams table. Every exam
//      declares which of {face, fp, iris} it wants. Face-only,
//      fp-only, fp+iris, everything -- any combo is allowed as long
//      as at least one is on (validated at the API layer). Defaults
//      preserve the pre-migration behaviour (face + fp on, iris off)
//      for any exam created before the superadmin explicitly picks.
//      NEET1 + NEET2 get iris=1 as a data-only bootstrap so today's
//      demo (iris enrolled for 10002 + 20001) doesn't regress.
var migration022OperatorScopeAndExamModalities = migration{
	version: 22,
	name:    "operator_scope_and_exam_modalities",
	stmts: []string{
		// 1. One exam per operator. If any user_id has more than one
		// row in operator_exams, this fails -- we cleaned that up in
		// the demo wipe (only single-exam operators remain).
		`CREATE UNIQUE INDEX IF NOT EXISTS ux_operator_exams_user
		     ON operator_exams(user_id)`,

		// 2. Per-exam modality flags. Defaults match pre-migration
		// behaviour: face + fp on, iris off. Superadmin toggles via
		// the exam edit UI going forward.
		`ALTER TABLE exams ADD COLUMN requires_face INTEGER NOT NULL DEFAULT 1
		     CHECK (requires_face IN (0,1))`,
		`ALTER TABLE exams ADD COLUMN requires_fp   INTEGER NOT NULL DEFAULT 1
		     CHECK (requires_fp   IN (0,1))`,
		`ALTER TABLE exams ADD COLUMN requires_iris INTEGER NOT NULL DEFAULT 0
		     CHECK (requires_iris IN (0,1))`,

		// 3. Bootstrap for the seeded NEET1 + NEET2 demo exams. If
		// those exam_codes don't exist on this database (e.g. fresh
		// install), these UPDATEs are no-ops. Any real deployment
		// that never seeded NEET1/2 stays on the safe defaults.
		`UPDATE exams SET requires_iris = 1
		    WHERE exam_code IN ('NEET1', 'NEET2')`,
	},
}
