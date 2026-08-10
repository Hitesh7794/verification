package db

// migration016SubscriptionsOperatorScoping wires the Phase-2 college side
// of the exam catalog:
//
//   organization_exam_subscriptions   — the college↔exam self-service
//                                       subscription. A college admin
//                                       browses the catalog and picks
//                                       which exams the college wants
//                                       to verify against; no superadmin
//                                       approval required.
//
//   operator_exams                    — the operator↔exam subset. A
//                                       college with 3 subscribed exams
//                                       can create operator A limited
//                                       to exam 1 and operator B limited
//                                       to exams 2+3. Verification-time
//                                       gate; empty list => no access.
//
// Plus four columns on `users` (only meaningful for role='client') so
// each operator can run inside a spending cap and a date window:
//
//   spending_cap_paise INTEGER      running-total cap; NULL = unlimited
//   spent_paise        INTEGER      running total; bumped atomically
//                                    inside the wallet middleware on
//                                    every successful charge
//   valid_from         DATE         NULL = no lower bound
//   valid_to           DATE         NULL = no upper bound
//
// The cap is a running total on purpose: "spent ₹10 lifetime" is the
// hardest guarantee for a college worried about a single operator
// blowing the whole wallet. Admin can bump the cap any time; the next
// verify request re-reads the row and unblocks.
var migration016SubscriptionsOperatorScoping = migration{
	version: 16,
	name:    "subscriptions_operator_scoping",
	stmts: []string{
		`CREATE TABLE organization_exam_subscriptions (
			org_id         INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
			exam_id        INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
			subscribed_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			subscribed_by  INTEGER REFERENCES users(id),
			PRIMARY KEY (org_id, exam_id)
		)`,
		`CREATE INDEX idx_org_exam_subs_exam ON organization_exam_subscriptions(exam_id)`,

		`CREATE TABLE operator_exams (
			user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			exam_id  INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
			PRIMARY KEY (user_id, exam_id)
		)`,
		`CREATE INDEX idx_operator_exams_exam ON operator_exams(exam_id)`,

		`ALTER TABLE users ADD COLUMN spending_cap_paise INTEGER`,
		`ALTER TABLE users ADD COLUMN spent_paise INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE users ADD COLUMN valid_from DATE`,
		`ALTER TABLE users ADD COLUMN valid_to DATE`,
	},
}
