package db

// migration023UniqueUserEmail enforces case-insensitive uniqueness on
// users.email so an admin can't accidentally create two operators
// (or an operator + an admin) with the same email.
//
// Two steps in order:
//
//   1. Deduplicate existing rows. Same admin might have re-used the
//      same email across N test operators during onboarding; the
//      migration keeps the OLDEST row's email (the admin or first
//      real user) and nulls out the email on the newer duplicates.
//      No accounts are deleted -- operators still work, they just
//      have no email on file until re-set via the Operators UI.
//
//   2. Drop the old non-unique lookup index (idx_users_email) and
//      add a unique index scoped to LOWER(email) so 'Foo@Bar.com'
//      and 'foo@bar.com' can't both exist. Partial (WHERE email IS
//      NOT NULL AND email != '') so empty emails stay allowed.
var migration023UniqueUserEmail = migration{
	version: 23,
	name:    "unique_user_email",
	stmts: []string{
		// Step 1 -- keep the oldest row per email, null the rest.
		// COALESCE(email, '') to keep the predicate safe on NULLs.
		// Group by LOWER(email) so case variants collapse together.
		`UPDATE users
		    SET email = NULL
		  WHERE email IS NOT NULL
		    AND email != ''
		    AND id NOT IN (
		        SELECT MIN(id)
		          FROM users
		         WHERE email IS NOT NULL AND email != ''
		         GROUP BY LOWER(email)
		    )`,

		// Step 2 -- swap the lookup index for the unique one.
		`DROP INDEX IF EXISTS idx_users_email`,

		`CREATE UNIQUE INDEX ux_users_email_ci
		    ON users(LOWER(email))
		 WHERE email IS NOT NULL AND email != ''`,
	},
}
