package db

// migration021DropCenters retires the legacy `centers` table and the
// two `center_id` FK columns that hung off it. The concept was
// "one physical exam centre per organisation, every operator + every
// verification bound to a centre" — a Phase-0 model that stopped
// mapping to the product two migrations ago.
//
// Since migration 017 the NOT-NULL was already dropped, so
// post-Phase-2 operators + verifications have been written with
// center_id = NULL. Migration 019 introduced exam_centres (per-exam,
// keyed by (exam_id, centre_code) and populated from a CSV upload),
// which is the modern replacement. Every remaining reader has been
// pointed at exam_centres or dropped entirely in the same commit.
//
// SQLite 3.35+ supports plain `ALTER TABLE ... DROP COLUMN`, so the
// old rewrite-the-whole-table-to-drop-one-column dance from
// migrations 017/018 is unnecessary here. Prod is on 3.45.
var migration021DropCenters = migration{
	version: 21,
	name:    "drop_centers",
	stmts: []string{
		// SQLite refuses DROP COLUMN if any index still references
		// the column, so drop the indexes first. `idx_users_center`
		// never existed; only the verifications one did (see mig 001
		// + the partial-index re-create in mig 017).
		`DROP INDEX IF EXISTS idx_verifications_center_created`,
		`DROP INDEX IF EXISTS idx_centers_org`,

		`ALTER TABLE users         DROP COLUMN center_id`,
		`ALTER TABLE verifications DROP COLUMN center_id`,
		`DROP TABLE IF EXISTS centers`,
	},
}
