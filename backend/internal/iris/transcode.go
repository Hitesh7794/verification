// Package iris holds format-detection + transcoding helpers for iris
// image payloads on the way to TrustView.
//
// Why this exists (2026-09-10):
//   TrustView's OpenIris engine only accepts iris probes/galleries as
//   raw grayscale BMP images. It cannot parse ISO/IEC 19794-6 IIR
//   compact records (the "K7" format produced by Mantra's Marvis SDK
//   on Android). Direct empirical proof:
//
//     • K7 self-match on TrustView → score 0, distance 1 (impossible).
//     • Same K7 transcoded to BMP → self-match 98.3, matched=true.
//     • Transcoded K7 vs enrolled BMP of same person → 85, matched=true.
//
//   So the fix runs on THIS side: when a probe/gallery arrives in K7
//   (IIR wrapper containing JPEG2000 image data), we extract the JP2
//   payload, decompress with opj_decompress from libopenjp2-tools,
//   and forward the resulting BMP. Anything that isn't IIR flows
//   through unchanged — that preserves the existing web-operator
//   flow which already sends BMP.
//
// Safety:
//   * Web operators send BMP → PassThrough (no shell, no allocation).
//   * Android sends K7 → transcode. If opj_decompress isn't installed
//     or fails, we return the original bytes and let TrustView reject
//     them (preserving the pre-fix behavior, not regressing).
//   * K3 (uncompressed IIR — no JP2 sub-file) → PassThrough. The
//     Mantra Android SDK currently uses K7 exclusively, so K3 doesn't
//     appear in traffic; if it ever does, we'll add a raw-extract
//     branch here.
package iris

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"time"
)

// Magic sniffing constants.
var (
	// IIR ISO/IEC 19794-6 compact record header: "IIR\0" then "020\0".
	// We only require the first four bytes — the version bytes vary.
	iirMagic = []byte{'I', 'I', 'R', 0x00}

	// JP2 file signature (SOI). Exactly 12 bytes long.
	jp2Magic = []byte{0x00, 0x00, 0x00, 0x0C, 'j', 'P', ' ', ' ', 0x0D, 0x0A, 0x87, 0x0A}
)

// TranscodeTimeout is the max time we let opj_decompress run for a
// single frame. Real captures decode in ~2-15ms; the 3s cap catches
// runaway subprocesses without punishing normal operation.
const TranscodeTimeout = 3 * time.Second

// MaybeToBMP inspects payload and, if it looks like an IIR K7 wrapper
// carrying JPEG2000 image data, returns the transcoded BMP bytes.
// For anything else (BMP, PNG, JPEG, raw K3, anything unrecognized)
// it returns the input unchanged. This lets callers apply it
// unconditionally to every probe and gallery on the iris compare
// path without a callsite-level format check.
//
// Never returns an error for "not IIR" — that's a normal pass-through.
// Only returns an error when we DETECTED an IIR-with-JP2 payload but
// the decompression subprocess failed. Callers may choose to log +
// pass through the original bytes in that case.
func MaybeToBMP(ctx context.Context, payload []byte) ([]byte, error) {
	if !isIIR(payload) {
		return payload, nil
	}
	jp2Off := bytes.Index(payload, jp2Magic)
	if jp2Off < 0 {
		// IIR wrapper without a JPEG2000 sub-file — probably a K3
		// (uncompressed) template. We don't have a raw-extract path
		// yet; forward as-is and let TrustView reject if it must.
		return payload, nil
	}
	bmp, err := opjDecompressToBMP(ctx, payload[jp2Off:])
	if err != nil {
		return payload, fmt.Errorf("iris transcode: %w", err)
	}
	return bmp, nil
}

// isIIR checks the ISO/IEC 19794-6 record header magic (first 4 bytes).
func isIIR(b []byte) bool {
	return len(b) >= 4 && bytes.Equal(b[:4], iirMagic)
}

// opjDecompressToBMP shells out to `opj_decompress` from OpenJPEG's
// libopenjp2-tools. Chosen over a Go-native decoder because Go has no
// mainstream JPEG2000 library — OpenJPEG is the widely-used reference,
// packaged in every Linux distro (Ubuntu: `libopenjp2-tools`), well
// hardened over ~20 years, and decodes iris frames in single-digit
// milliseconds.
//
// Input:  a valid JP2 byte slice.
// Output: 8-bit BMP bytes.
//
// Uses tmpfiles rather than stdio pipes because opj_decompress's
// stdio mode ships only in newer OpenJPEG (2.5+) and we can't
// guarantee that version on every prod host.
func opjDecompressToBMP(ctx context.Context, jp2 []byte) ([]byte, error) {
	inF, err := os.CreateTemp("", "iris-*.jp2")
	if err != nil {
		return nil, fmt.Errorf("mktemp input: %w", err)
	}
	inPath := inF.Name()
	defer os.Remove(inPath)
	if _, err := inF.Write(jp2); err != nil {
		inF.Close()
		return nil, fmt.Errorf("write jp2: %w", err)
	}
	if err := inF.Close(); err != nil {
		return nil, fmt.Errorf("close jp2 tmp: %w", err)
	}

	outPath := inPath + ".bmp"
	defer os.Remove(outPath)

	// Bound wall-time. opj_decompress on real iris frames finishes in
	// 2-15ms; anything past 3s means the subprocess is stuck.
	cctx, cancel := context.WithTimeout(ctx, TranscodeTimeout)
	defer cancel()

	// -i input.jp2 -o output.bmp — nothing fancy. opj_decompress picks
	// its output format from the extension.
	cmd := exec.CommandContext(cctx, "opj_decompress", "-i", inPath, "-o", outPath)
	// Capture stderr for diagnostics. stdout is mostly progress text.
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("opj_decompress: %w (stderr=%q)", err, stderr.String())
	}
	out, err := os.ReadFile(outPath)
	if err != nil {
		return nil, fmt.Errorf("read bmp out: %w", err)
	}
	if len(out) < 54 { // BMP file header + info header minimum
		return nil, fmt.Errorf("opj_decompress produced tiny output (%d bytes)", len(out))
	}
	return out, nil
}
