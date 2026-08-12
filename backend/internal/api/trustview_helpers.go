package api

import (
	"errors"
	"net/http"

	"github.com/veni/neet-verification/internal/trustview"
)

// writeTrustViewErr maps a trustview.Error (or any error returned from
// trustview.Client.Compare) to the HTTP status + message the frontend
// expects. Shared across face / fp / iris handlers so their error
// shapes stay in lockstep.
//
// The mapping favours operator-friendly copy over vendor-verbatim
// messages — "No face detected in the captured image" beats
// "trustview: HTTP 422 no_face (no_face): No face detected in image1".
// The frontend surfaces this as an inline banner so verbosity hurts.
//
// Never emits the TrustView token or the raw request body; both are
// server-side secrets.
func writeTrustViewErr(w http.ResponseWriter, err error) {
	var e *trustview.Error
	if !errors.As(err, &e) {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	switch e.Kind {
	case trustview.KindNoToken:
		writeErr(w, http.StatusServiceUnavailable,
			"biometric compare is not configured on the server (TRUSTVIEW_TOKEN missing)")
	case trustview.KindTokenExpired:
		writeErr(w, http.StatusServiceUnavailable,
			"biometric compare token has expired; ask the admin to rotate TRUSTVIEW_TOKEN")
	case trustview.KindTokenDisabled, trustview.KindUnauthorized:
		writeErr(w, http.StatusServiceUnavailable,
			"biometric compare token is not accepted by the provider")
	case trustview.KindNotAllowed:
		writeErr(w, http.StatusForbidden,
			"biometric compare provider is not enabled for this modality on this token")
	case trustview.KindNoFace:
		writeErr(w, http.StatusUnprocessableEntity,
			"no face detected in the captured image; ask the candidate to recapture")
	case trustview.KindNoQuality:
		writeErr(w, http.StatusUnprocessableEntity,
			"the captured image could not be processed; recapture with better focus/lighting")
	case trustview.KindPayloadTooBig:
		writeErr(w, http.StatusRequestEntityTooLarge, "captured image is too large")
	case trustview.KindRateLimit, trustview.KindTooMany:
		writeErr(w, http.StatusTooManyRequests,
			"biometric compare provider is rate-limiting the server; retry in a few seconds")
	case trustview.KindEngineBusy, trustview.KindUnavail:
		writeErr(w, http.StatusBadGateway,
			"biometric compare provider is temporarily unavailable; retry in a few seconds")
	case trustview.KindTransport:
		writeErr(w, http.StatusBadGateway,
			"could not reach the biometric compare provider")
	default:
		writeErr(w, http.StatusBadGateway, "biometric compare: "+e.Message)
	}
}
