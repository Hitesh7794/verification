package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestRenderPDFFixtures builds two sample receipts - one MATCHED, one
// MISMATCH - from synthetic pdfBundle records, so the layout can be
// exercised end to end without a real verification in the database.
//
// It drives the real renderer, which shells out to the Python builder and
// then to headless Chrome. Every path it needs used to be hardcoded to one
// developer's laptop (the builder script, the demo photo and the output
// directory all lived under /Users/veni), which is why it could only ever
// pass there. They now come from the repository and from t.TempDir, and the
// test skips rather than fails when the Python or Chrome it needs is not
// installed - a fresh clone has to be able to run `go test ./...`.
func TestRenderPDFFixtures(t *testing.T) {
	builder := repoPDFBuilder(t)
	python := workingPython(t)

	t.Setenv("VERIFY_PDF_BUILDER", builder)
	t.Setenv("VERIFY_PDF_PYTHON", python)
	// Both are read into package vars at init, so refresh them.
	pdfBuilderScript = builder
	pdfPythonBin = python

	photo := writeTestJPEG(t)
	outDir := t.TempDir()

	base := pdfBundle{
		VerificationID: 68,
		Via:            "face+fingerprint",
		FaceMatchScore: sql.NullFloat64{Float64: 98.4, Valid: true},
		FpMatchScore:   sql.NullInt64{Int64: 172, Valid: true},
		IrisScore:      sql.NullFloat64{Float64: 84.0, Valid: true},
		HasPhoto:       true,
		HasFP:          true,
		HasIris:        true,
		DeviceSerial:   sql.NullString{String: "AB12345", Valid: true},
		DeviceModel:    sql.NullString{String: "Mantra MFS100", Valid: true},
		FpVendor:       sql.NullString{String: "Mantra", Valid: true},
		CreatedAt:      time.Date(2026, 8, 13, 16, 6, 0, 0, time.UTC),
		RollNo:         "20002",
		CandName:       "Ankur Sir",
		RegistrationID: sql.NullString{String: "NEET2-2026-0002", Valid: true},
		FatherName:     sql.NullString{String: "Rajesh Sharma", Valid: true},
		DOB:            sql.NullString{String: "2004-05-15", Valid: true},
		Gender:         sql.NullString{String: "M", Valid: true},
		ShiftName:      sql.NullString{String: "Morning Shift (09:00 AM – 12:00 PM)", Valid: true},
		CentreCode:     sql.NullString{String: "DL-0402", Valid: true},
		ExamCode:       "NEET2",
		ExamName:       "National Eligibility cum Entrance Test (UG) 2026",
		ClientName:     "National Testing Agency",
		CentreName:     sql.NullString{String: "Govt Sarvodaya Vidyalaya, Sector 4", Valid: true},
		Address:        sql.NullString{String: "Plot No. 12, Institutional Area", Valid: true},
		City:           sql.NullString{String: "New Delhi", Valid: true},
		State:          sql.NullString{String: "Delhi", Valid: true},
		Pincode:        sql.NullString{String: "110001", Valid: true},
		OperatorName:   sql.NullString{String: "Amogh Sharma", Valid: true},
	}

	// MATCHED variant — all three modalities pass
	matched := base
	matched.Status = "verified"
	matched.FaceMatch = true
	matched.FpMatch = true

	// MISMATCH variant — fingerprint fails; other two pass but result
	// is overall denied
	mismatch := base
	mismatch.Status = "denied"
	mismatch.FaceMatch = true
	mismatch.FpMatch = false
	mismatch.IrisScore = sql.NullFloat64{Float64: 84.0, Valid: true}

	for _, tc := range []struct {
		name string
		b    pdfBundle
	}{
		{"matched", matched},
		{"mismatch", mismatch},
	} {
		pdf, err := renderVerificationPDF(context.Background(), &tc.b, photo, photo)
		if err != nil {
			if isMissingPDFBackend(err) {
				t.Skipf("skipping: PDF backend unavailable: %v", err)
			}
			t.Fatalf("%s render: %v", tc.name, err)
		}
		if !bytes.HasPrefix(pdf, []byte("%PDF")) {
			t.Errorf("%s: output is not a PDF (first bytes %q)", tc.name, pdf[:min(8, len(pdf))])
		}
		out := filepath.Join(outDir, tc.name+".pdf")
		if err := os.WriteFile(out, pdf, 0o644); err != nil {
			t.Fatalf("%s write: %v", tc.name, err)
		}
		t.Logf("%s -> %s (%d bytes)", tc.name, out, len(pdf))
	}
}

// repoPDFBuilder returns the checked-in builder script. `go test` runs with
// the package directory as its working directory, so the script sits two
// levels up from internal/api.
func repoPDFBuilder(t *testing.T) string {
	t.Helper()
	p, err := filepath.Abs(filepath.Join("..", "..", "pdf-template", "build_report.py"))
	if err != nil {
		t.Fatalf("resolve builder path: %v", err)
	}
	if _, err := os.Stat(p); err != nil {
		t.Skipf("skipping: builder script not found at %s", p)
	}
	return p
}

// workingPython returns an interpreter that actually runs. On Windows
// "python3" normally resolves to the Microsoft Store alias stub, which
// prints an install prompt and exits instead of running anything, so each
// candidate is probed rather than trusted.
func workingPython(t *testing.T) string {
	t.Helper()
	for _, cand := range []string{"python3", "python", "py"} {
		p, err := exec.LookPath(cand)
		if err != nil {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		out, err := exec.CommandContext(ctx, p, "-c", "print(1)").CombinedOutput()
		cancel()
		if err == nil && strings.TrimSpace(string(out)) == "1" {
			return p
		}
	}
	t.Skip("skipping: no working Python interpreter on PATH")
	return ""
}

// writeTestJPEG drops a tiny but structurally valid JPEG for the builder to
// embed. A truncated file would fail the render for a reason that has
// nothing to do with the layout under test.
func writeTestJPEG(t *testing.T) string {
	t.Helper()
	const onePixel = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U" +
		"HRofGh0dHCQeJSAmJiEiIyEhIyEhISEhISEhISEhISEhISEhIf/bAEMBCQkJDAsMGA0NGBoSERIa" +
		"ISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISH/wAARCAABAAED" +
		"ASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUF" +
		"BAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0" +
		"NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKj" +
		"pKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oA" +
		"CAEBAAA/APn+gD//2Q=="
	raw, err := base64.StdEncoding.DecodeString(onePixel)
	if err != nil {
		t.Fatalf("decode test jpeg: %v", err)
	}
	p := filepath.Join(t.TempDir(), "photo.jpg")
	if err := os.WriteFile(p, raw, 0o644); err != nil {
		t.Fatalf("write test jpeg: %v", err)
	}
	return p
}

// isMissingPDFBackend reports whether a render failed because the headless
// browser the builder prints through is not installed, as opposed to a
// genuine layout or data error.
func isMissingPDFBackend(err error) bool {
	s := strings.ToLower(err.Error())
	for _, marker := range []string{"chrome", "chromium", "no pdf backend", "executable file not found"} {
		if strings.Contains(s, marker) {
			return true
		}
	}
	return false
}
