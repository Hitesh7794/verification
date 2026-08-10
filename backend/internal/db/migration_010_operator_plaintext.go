package db

// migration010OperatorPlaintext supports the "shared operator credential
// visible to the admin" model. Each org has exactly one client-role
// user that every operator machine at that institution logs in with;
// the admin needs to see that user's password in cleartext so they
// can hand it out, change it, and re-distribute on demand.
//
// password_plaintext is populated ONLY for shared operator users. For
// every other role (admin, superadmin, ops_admin) it stays NULL — those
// accounts go through bcrypt-only and the password is genuinely
// unrecoverable. Storing the plaintext for the shared operator is a
// deliberate security trade-off chosen with the customer: a leaked
// admin session leaks the operator credential immediately. We accept
// that in exchange for not having to email-onboard every operator.
//
// Threat model implications:
//   - A DB dump exposes operator passwords directly. Mitigate at the
//     infra layer (encrypted backups, restricted DB access). NOT
//     mitigated at the column level — encrypt-at-rest column would
//     just push the key into config where DB-dump attackers also reach.
//   - The bcrypt hash in password_hash stays the source of truth for
//     authentication. plaintext is for *display* only. /api/auth/login
//     does not read this column.
//   - For admin-role users we deliberately do NOT populate this column.
//     A future audit grepping `WHERE password_plaintext IS NOT NULL`
//     should only ever turn up shared operator rows.
var migration010OperatorPlaintext = migration{
	version: 10,
	name:    "operator_plaintext",
	stmts: []string{
		`ALTER TABLE users ADD COLUMN password_plaintext TEXT`,
	},
}
