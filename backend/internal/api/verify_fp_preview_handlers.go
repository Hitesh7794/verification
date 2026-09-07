package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// fpPreview accepts a base64 ISO/IEC 19794-4 fingerprint image record
// (Startek FM220U L1's `isoImgBase64`), shells to the fp_preview.py
// script inside the fp-preview venv, and streams back a PNG for the
// operator UI to render inline.
//
// This endpoint is a pure UX helper: it never records anything, never
// touches the DB, never influences match verdicts. Failures return an
// HTTP error and the frontend falls back to the "Fingerprint captured"
// placeholder — the rest of the verification flow is unaffected.
//
// Env overrides (both optional):
//
//	FP_PREVIEW_PYTHON — absolute path to the venv Python (default:
//	                    /opt/verificationportal/fp-preview-venv/bin/python3)
//	FP_PREVIEW_SCRIPT — absolute path to fp_preview.py (default:
//	                    /opt/verificationportal/pdf-template/fp_preview.py)
type fpPreviewReq struct {
	IsoImgB64 string `json:"iso_img_b64"`
}

var (
	fpPreviewPython = envOr("FP_PREVIEW_PYTHON",
		"/opt/verificationportal/fp-preview-venv/bin/python3")
	fpPreviewScript = envOr("FP_PREVIEW_SCRIPT",
		"/opt/verificationportal/pdf-template/fp_preview.py")
	fpPreviewTimeout = 10 * time.Second
	// Cap the base64 payload so a rogue client can't force a giant
	// subprocess. 8 MB base64 → ~6 MB decoded, far more than any real
	// fingerprint image.
	fpPreviewMaxBytes int64 = 8 << 20
)

func (s *Server) fpPreview(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, fpPreviewMaxBytes)
	var req fpPreviewReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body: "+err.Error())
		return
	}
	iso := strings.TrimSpace(req.IsoImgB64)
	if iso == "" {
		writeErr(w, http.StatusBadRequest, "iso_img_b64 required")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), fpPreviewTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, fpPreviewPython, fpPreviewScript)
	cmd.Stdin = strings.NewReader(iso)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		writeErr(w, http.StatusUnprocessableEntity,
			fmt.Sprintf("fp preview decode failed: %v (stderr: %s)",
				err, strings.TrimSpace(stderr.String())))
		return
	}
	png := stdout.Bytes()
	if len(png) == 0 {
		writeErr(w, http.StatusUnprocessableEntity, "fp preview produced no output")
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Content-Length", strconv.Itoa(len(png)))
	// No caching — same operator laptop can capture different fingers
	// under the same idempotency key over the course of a session.
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(png)
}
