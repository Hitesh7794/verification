package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/veni/neet-verification/internal/luxand"
)

// livenessCheckReq is what the operator's browser posts after running
// the challenge sequence. Frames are base64 JPEGs in temporal order.
//
// SessionID is the same idempotency key that will be handed to the
// subsequent /face-match call so the server-side gate can pair the two
// events with a single lookup.
type livenessCheckReq struct {
	SessionID  string   `json:"session_id"`
	Frames     []string `json:"frames"`
	Challenges []string `json:"challenges"`
}

type livenessCheckResp struct {
	SessionID        string   `json:"session_id"`
	Pass             bool     `json:"pass"`
	PassiveMean      float64  `json:"passive_mean"`
	PassivePassed    bool     `json:"passive_passed"`
	BlinksDetected   int      `json:"blinks_detected"`
	ChallengesPassed []string `json:"challenges_passed"`
	FacesFound       int      `json:"faces_found"`
	// ExpiresIn tells the operator's UI how long it has to complete
	// the face capture before the gate expires and it must redo
	// liveness. Zero when Pass=false.
	ExpiresIn int `json:"expires_in_seconds,omitempty"`
}

// livenessCheck POST /api/candidates/{roll}/liveness-check
//
// Role: client (operator). NOT charged by the wallet middleware —
// liveness is a gate, the payable event is /face-match.
//
// Flow:
//  1. Decode + validate the frames + session_id (must be non-empty,
//     unique enough to key the gate row on).
//  2. Ask luxand-service to score the sequence.
//  3. On pass: insert a row into liveness_checks with an expiry
//     (LivenessMaxAgeSeconds, default 90s). On fail: return the raw
//     signals so the operator UI can render a helpful message
//     ("no face detected", "blink not registered", etc.) and let the
//     operator retry — no cap, per the product spec.
func (s *Server) livenessCheck(w http.ResponseWriter, r *http.Request) {
	roll := strings.TrimSpace(chi.URLParam(r, "roll"))
	if roll == "" {
		writeErr(w, http.StatusBadRequest, "roll required")
		return
	}
	// Cap the body — 30 frames × ~50 KB = ~1.5 MB is the target payload
	// size; give it 4 MB of headroom for larger cameras / operator
	// laptops that emit higher-res JPEGs.
	r.Body = http.MaxBytesReader(w, r.Body, 4<<20)
	var req livenessCheckReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body: "+err.Error())
		return
	}
	req.SessionID = strings.TrimSpace(req.SessionID)
	if req.SessionID == "" {
		writeErr(w, http.StatusBadRequest, "session_id required")
		return
	}
	if len(req.SessionID) > 128 {
		writeErr(w, http.StatusBadRequest, "session_id too long")
		return
	}
	if len(req.Frames) == 0 {
		writeErr(w, http.StatusBadRequest, "frames required")
		return
	}

	// Decode frames server-side so we can:
	//   (a) validate the base64 up front (better error than a 400 from
	//       Java after 1.5 MB traveled the second hop), and
	//   (b) hand luxand-service a clean []byte per frame — the client
	//       does the base64 encoding for the second hop.
	frames := make([][]byte, 0, len(req.Frames))
	for i, f := range req.Frames {
		b, err := decodeDataURL(f)
		if err != nil || len(b) == 0 {
			writeErr(w, http.StatusBadRequest,
				fmt.Sprintf("frame %d invalid base64", i))
			return
		}
		frames = append(frames, b)
	}

	// Ask Luxand.
	res, err := s.luxand.LivenessCheck(r.Context(), frames, req.Challenges)
	if err != nil {
		if errors.Is(err, luxand.ErrDisabled) {
			writeErr(w, http.StatusServiceUnavailable,
				"liveness engine is not configured on this deployment")
			return
		}
		writeErr(w, http.StatusBadGateway, "liveness engine error: "+err.Error())
		return
	}
	if res.ErrorCode != "0" {
		// The service already returned a friendly message ("no face
		// found", "too few frames"). Pass it straight through so the
		// operator sees actionable text without the JS layer inventing
		// its own translations.
		// X-Wallet-Skip tells the walletCharge middleware wrapping this
		// endpoint NOT to debit — a failed challenge is retryable and
		// the wallet only pays for a passing liveness gate. Header is
		// stripped by the middleware before the response leaves.
		w.Header().Set("X-Wallet-Skip", "1")
		writeJSON(w, http.StatusOK, livenessCheckResp{
			SessionID:        req.SessionID,
			Pass:             false,
			PassiveMean:      res.PassiveMean,
			PassivePassed:    res.PassivePassed,
			BlinksDetected:   res.BlinksDetected,
			ChallengesPassed: res.ChallengesPassed,
			FacesFound:       res.FacesFound,
		})
		return
	}

	// The row only lands on a pass — a failed attempt shouldn't count
	// against the operator's next face-match. Duplicate session_id is
	// possible if the browser retries a passing check; we intentionally
	// UPSERT the passive_mean + challenges_passed + expires_at so a
	// retry keeps the gate fresh instead of failing on the UNIQUE index.
	if res.AllPassed {
		claims := claimsFrom(r)
		if claims == nil || claims.OrgID == nil {
			writeErr(w, http.StatusUnauthorized, "org context required")
			return
		}
		orgID := *claims.OrgID
		challengesJSON, _ := json.Marshal(res.ChallengesPassed)
		maxAge := s.deps.Cfg.LivenessMaxAgeSeconds
		if maxAge <= 0 {
			maxAge = 90
		}
		if _, err := s.deps.DB.ExecContext(r.Context(),
			`INSERT INTO liveness_checks(
			     org_id, roll_no, session_id, passive_mean,
			     challenges_passed, expires_at)
			 VALUES ($1, $2, $3, $4, $5::jsonb, NOW() + ($6 || ' seconds')::interval)
			 ON CONFLICT (session_id) DO UPDATE
			     SET passive_mean      = EXCLUDED.passive_mean,
			         challenges_passed = EXCLUDED.challenges_passed,
			         expires_at        = EXCLUDED.expires_at`,
			orgID, roll, req.SessionID,
			res.PassiveMean, string(challengesJSON),
			fmt.Sprintf("%d", maxAge),
		); err != nil {
			writeErr(w, http.StatusInternalServerError,
				"could not record liveness pass: "+err.Error())
			return
		}
		s.audit(r.Context(), claims, "candidate.liveness.pass",
			"candidate", 0, clientIP(r), map[string]any{
				"roll_no":      roll,
				"session_id":   req.SessionID,
				"passive_mean": res.PassiveMean,
				"challenges":   res.ChallengesPassed,
			})
	}

	resp := livenessCheckResp{
		SessionID:        req.SessionID,
		Pass:             res.AllPassed,
		PassiveMean:      res.PassiveMean,
		PassivePassed:    res.PassivePassed,
		BlinksDetected:   res.BlinksDetected,
		ChallengesPassed: res.ChallengesPassed,
		FacesFound:       res.FacesFound,
	}
	if resp.Pass {
		resp.ExpiresIn = s.deps.Cfg.LivenessMaxAgeSeconds
		if resp.ExpiresIn <= 0 {
			resp.ExpiresIn = 90
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

// livenessClientVerifiedReq is the payload posted by a MediaPipe-based
// client after it has run its own blink challenge locally. No frames —
// the client already scored the sequence in the browser or on-device
// and just needs the server to record the gate pass.
type livenessClientVerifiedReq struct {
	SessionID string `json:"session_id"`
}

// livenessClientVerified POST /api/candidates/{roll}/liveness-client-verified
//
// Client-decided liveness gate. Skips Luxand entirely: the operator's
// browser (or mobile app) ran MediaPipe FaceLandmarker + blink-detection
// locally and is telling the server "I saw a valid blink, record the
// gate row". Wallet middleware still charges on this endpoint — the
// gate pass is the payable event regardless of which engine decided it.
//
// Rationale: MediaPipe on-device eliminates the 30-frame upload +
// Luxand round-trip that dominates operator-perceived latency on the
// liveness step. Same downstream: the row keyed by (org, roll,
// session_id) unlocks the next /face-match POST exactly as before.
//
// The endpoint is a thin write path — no scoring, no frame decode. If
// you want server-side second-check for anti-spoof, use /liveness-check
// (the Luxand path); this one is opt-in per client build.
func (s *Server) livenessClientVerified(w http.ResponseWriter, r *http.Request) {
	roll := strings.TrimSpace(chi.URLParam(r, "roll"))
	if roll == "" {
		writeErr(w, http.StatusBadRequest, "roll required")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	var req livenessClientVerifiedReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body: "+err.Error())
		return
	}
	req.SessionID = strings.TrimSpace(req.SessionID)
	if req.SessionID == "" {
		writeErr(w, http.StatusBadRequest, "session_id required")
		return
	}
	if len(req.SessionID) > 128 {
		writeErr(w, http.StatusBadRequest, "session_id too long")
		return
	}

	claims := claimsFrom(r)
	if claims == nil || claims.OrgID == nil {
		writeErr(w, http.StatusUnauthorized, "org context required")
		return
	}
	orgID := *claims.OrgID

	// Same UPSERT the Luxand path uses. challenges_passed always
	// contains ["blink"] since MediaPipe only runs the blink challenge
	// today; adding new challenges is a co-ordinated change with the
	// client detector. passive_mean is left at 0 — no passive score is
	// computed client-side (Luxand-only signal).
	challengesJSON := `["blink"]`
	maxAge := s.deps.Cfg.LivenessMaxAgeSeconds
	if maxAge <= 0 {
		maxAge = 90
	}
	if _, err := s.deps.DB.ExecContext(r.Context(),
		`INSERT INTO liveness_checks(
		     org_id, roll_no, session_id, passive_mean,
		     challenges_passed, expires_at)
		 VALUES ($1, $2, $3, 0, $4::jsonb, NOW() + ($5 || ' seconds')::interval)
		 ON CONFLICT (session_id) DO UPDATE
		     SET passive_mean      = EXCLUDED.passive_mean,
		         challenges_passed = EXCLUDED.challenges_passed,
		         expires_at        = EXCLUDED.expires_at`,
		orgID, roll, req.SessionID, challengesJSON,
		fmt.Sprintf("%d", maxAge),
	); err != nil {
		writeErr(w, http.StatusInternalServerError,
			"could not record liveness pass: "+err.Error())
		return
	}
	s.audit(r.Context(), claims, "candidate.liveness.pass",
		"candidate", 0, clientIP(r), map[string]any{
			"roll_no":    roll,
			"session_id": req.SessionID,
			"engine":     "mediapipe-client",
		})

	writeJSON(w, http.StatusOK, livenessCheckResp{
		SessionID:        req.SessionID,
		Pass:             true,
		ChallengesPassed: []string{"blink"},
		FacesFound:       1,
		ExpiresIn:        maxAge,
	})
}

// livenessGatePassed returns true when a passing liveness_checks row
// exists for the given (org, roll, session_id) tuple and hasn't
// expired. Used by /face-match as a defense-in-depth check so a
// scripted client can't skip the browser flow.
//
// The gate deliberately uses the session_id as the third predicate:
// a passing check for session A can't unlock a face-match posted with
// session B, even inside the same org for the same roll. This makes
// each verification attempt independent of any prior liveness pass
// the same operator might have racked up on the same candidate.
func (s *Server) livenessGatePassed(
	ctx context.Context,
	orgID int64,
	rollNo string,
	sessionID string,
) (bool, error) {
	if sessionID == "" || rollNo == "" {
		return false, nil
	}
	var one int
	err := s.deps.DB.QueryRowContext(ctx,
		`SELECT 1 FROM liveness_checks
		  WHERE org_id     = $1
		    AND roll_no    = $2
		    AND session_id = $3
		    AND expires_at > NOW()
		  LIMIT 1`,
		orgID, rollNo, sessionID,
	).Scan(&one)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return false, err
}
