package db

// migration014UniquePanEmail adds partial UNIQUE indexes so a PAN or head
// email can only be tied to one *active* institution application at a time.
// "Active" = status in ('approved','pending'). Draft and rejected rows do
// NOT contend, so an operator who abandoned a draft or was rejected can
// still re-register with the same PAN/email without a manual DB cleanup.
//
// This mirrors the AISHE code protection (idx_inst_apps_aishe) except:
//   - AISHE is unique across ALL statuses because the handler auto-cleans
//     rejected/draft rows before inserting a new one (see registerInit).
//   - PAN and email are unique only among live/pending rows because we
//     don't want to silently delete some other tenant's draft just because
//     they used the same PAN, and we don't want to punish a returning
//     user for their own previously-rejected attempt.
var migration014UniquePanEmail = migration{
	version: 14,
	name:    "unique_pan_email",
	stmts: []string{
		`CREATE UNIQUE INDEX idx_inst_apps_pan_active
			ON institution_applications(pan)
			WHERE pan IS NOT NULL AND status IN ('approved','pending')`,
		`CREATE UNIQUE INDEX idx_inst_apps_head_email_active
			ON institution_applications(head_email)
			WHERE status IN ('approved','pending')`,
	},
}
