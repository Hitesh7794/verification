package api

// pgx error mapper — turns raw Postgres constraint violations into
// operator-facing 4xx responses with a specific field / reason. The
// existing pattern of `writeErr(w, 500, "db insert: "+err.Error())`
// leaks constraint names + column names to the UI, gives the operator
// nothing actionable, and mis-classifies data-shape errors as server
// errors. This helper is called from the handlers where a raw
// constraint bounce is expected (INSERT of a user row hitting a
// username-taken index, an operator_exams row hitting the V27 index,
// etc.).
//
// Unknown pg codes fall through to the caller's fallback message so
// we never silently swallow an unclassified error.

import (
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
)

// friendlyPgError inspects err. If it is a pg constraint / data
// violation we can map to an operator-facing message, writes a 4xx
// with that message and returns true. Otherwise returns false and the
// caller falls back to its own error path (usually a 500 with
// fallbackContext).
//
// contextLabel is a short prefix ("create agent", "bulk import line 4",
// etc.) that gets included in the server log so a 4xx can still be
// grepped back to which handler emitted it. It is NOT included in the
// response body — end users see only the friendly message.
func friendlyPgError(w http.ResponseWriter, err error, contextLabel string) bool {
	if err == nil {
		return false
	}
	var pg *pgconn.PgError
	if !errors.As(err, &pg) {
		return false
	}

	// Constraint name is our best clue for a UNIQUE violation because
	// column name isn't populated for composite indexes. We match on
	// the known indexes; anything else falls through.
	cn := strings.ToLower(pg.ConstraintName)

	switch pg.Code {
	case "23505": // unique_violation
		switch {
		case strings.Contains(cn, "users_username"):
			log.Printf("%s: username taken (pg cn=%s)", contextLabel, cn)
			writeErr(w, http.StatusConflict, "That username is already taken. Pick a different one.")
			return true
		case strings.Contains(cn, "operator_exams_user") || strings.Contains(cn, "ux_operator_exams_user"):
			log.Printf("%s: operator already assigned to an exam (pg cn=%s)", contextLabel, cn)
			writeErr(w, http.StatusConflict,
				"This agent is already assigned to an exam. Create a new agent account for a different exam, or edit the existing assignment.")
			return true
		case strings.Contains(cn, "users_client_reviewer") || strings.Contains(cn, "ux_users_client_reviewer"):
			log.Printf("%s: client_reviewer already exists for this client (pg cn=%s)", contextLabel, cn)
			writeErr(w, http.StatusConflict,
				"This exam board already has a reviewer account. Only one reviewer per board is supported.")
			return true
		case strings.Contains(cn, "inst_apps_head_email") ||
			strings.Contains(cn, "cp_inst_apps_head_email"):
			log.Printf("%s: KYC application email collision (pg cn=%s)", contextLabel, cn)
			writeErr(w, http.StatusConflict,
				"An application with this head-of-institution email is already on file.")
			return true
		case strings.Contains(cn, "inst_apps_head_mobile") ||
			strings.Contains(cn, "cp_inst_apps_head_mobile"):
			log.Printf("%s: KYC application phone collision (pg cn=%s)", contextLabel, cn)
			writeErr(w, http.StatusConflict,
				"An application with this head-of-institution phone number is already on file.")
			return true
		case strings.Contains(cn, "inst_apps_pan") ||
			strings.Contains(cn, "cp_inst_apps_pan"):
			log.Printf("%s: KYC application PAN collision (pg cn=%s)", contextLabel, cn)
			writeErr(w, http.StatusConflict,
				"An application with this PAN is already on file.")
			return true
		case strings.Contains(cn, "inst_apps_aishe") ||
			strings.Contains(cn, "cp_inst_apps_aishe"):
			log.Printf("%s: KYC application AISHE collision (pg cn=%s)", contextLabel, cn)
			writeErr(w, http.StatusConflict,
				"An application with this AISHE code is already on file.")
			return true
		default:
			log.Printf("%s: unhandled unique_violation on cn=%q table=%q; falling through",
				contextLabel, pg.ConstraintName, pg.TableName)
			return false
		}

	case "23514": // check_violation
		log.Printf("%s: check_violation on cn=%q table=%q col=%q; treating as 400",
			contextLabel, pg.ConstraintName, pg.TableName, pg.ColumnName)
		// The most common check violations on this codebase are role /
		// status enum bounces. Give a generic 400 so we don't leak the
		// column but the operator knows it was their input.
		writeErr(w, http.StatusBadRequest,
			"That value isn't accepted here. Pick a valid option from the form and try again.")
		return true

	case "23503": // foreign_key_violation
		log.Printf("%s: foreign_key_violation on cn=%q table=%q; treating as 400",
			contextLabel, pg.ConstraintName, pg.TableName)
		writeErr(w, http.StatusBadRequest,
			"One of the linked records (exam, org, or client) is missing or has been removed. Reload and try again.")
		return true

	case "22001": // string_data_right_truncation
		log.Printf("%s: string too long, col=%q", contextLabel, pg.ColumnName)
		writeErr(w, http.StatusBadRequest,
			"One of the fields is too long. Shorten it and try again.")
		return true

	case "23502": // not_null_violation
		log.Printf("%s: not_null_violation col=%q", contextLabel, pg.ColumnName)
		writeErr(w, http.StatusBadRequest,
			"A required field is missing. Fill in every required field and try again.")
		return true
	}
	return false
}
