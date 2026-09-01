package api

import (
	"context"
	"database/sql"
	"os"
	"testing"
	"time"
)

// TestRenderPDFFixtures builds two sample PDFs — one MATCHED, one
// MISMATCH — from synthetic pdfBundle records so the layout can be
// eyeballed without needing a real verification in the DB. Run with:
//   go test -run TestRenderPDFFixtures ./internal/api
// Outputs to /tmp/verify-matched.pdf and /tmp/verify-mismatch.pdf.
func TestRenderPDFFixtures(t *testing.T) {
	// Point the renderer at the local checked-in template so this test
	// works from a fresh clone without needing the prod install path.
	t.Setenv("VERIFY_PDF_BUILDER",
		"/Users/veni/Downloads/portal/Portal-main/backend/pdf-template/build_report.py")
	// Refresh the module-level var since it captured os.Getenv at init.
	pdfBuilderScript = os.Getenv("VERIFY_PDF_BUILDER")

	base := pdfBundle{
		VerificationID: 68,
		Via:            "face+fingerprint",
		FaceMatchScore: sql.NullFloat64{Float64: 98.4, Valid: true},
		FpMatchScore:   sql.NullInt64{Int64: 172, Valid: true},
		IrisScore:      sql.NullFloat64{Float64: 84.0, Valid: true},
		RequiresFace:   true,
		RequiresFP:     true,
		RequiresIris:   true,
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
		out  string
	}{
		{"matched", matched, "/tmp/verify-matched.pdf"},
		{"mismatch", mismatch, "/tmp/verify-mismatch.pdf"},
	} {
		const demoPhoto = "/Users/veni/.claude/projects/-Users-veni-Downloads-portal-Portal-main/memory/seed_demo_10001/photo.jpg"
		bytes, err := renderVerificationPDF(context.Background(), &tc.b, demoPhoto, demoPhoto)
		if err != nil {
			t.Fatalf("%s render: %v", tc.name, err)
		}
		if err := os.WriteFile(tc.out, bytes, 0o644); err != nil {
			t.Fatalf("%s write: %v", tc.name, err)
		}
		t.Logf("%s → %s (%d bytes)", tc.name, tc.out, len(bytes))
	}
}
