package db

// migration020ProbePhoto adds the on-disk path where the captured
// probe photo for this specific verification event lives. Populated by
// the createVerification handler after it promotes the temp probe file
// (dropped by the face-match endpoint) to its permanent name.
//
// Nullable — pre-existing rows have no probe; newer rows have one when
// face-match ran. Later swaps to an S3 key with no schema change: the
// column is just a location string.
var migration020ProbePhoto = migration{
	version: 20,
	name:    "probe_photo_path",
	stmts: []string{
		`ALTER TABLE verifications ADD COLUMN probe_photo_path TEXT`,
	},
}
