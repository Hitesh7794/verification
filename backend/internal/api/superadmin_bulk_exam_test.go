package api

import (
	"testing"
)

func TestParseBulkExamsCSV_Valid(t *testing.T) {
	csvData := `exam_name,exam_code,verification_from,verification_to,requires_face,requires_fp,requires_iris
National Eligibility Test Session 1,NET-2026-S1,2026-06-01 09:00,2026-06-15 18:00,yes,yes,no
Combined Entrance Examination 2026,CEE-2026-MAIN,2026-07-10 08:30,2026-07-20 17:30,1,1,1
Graduate Aptitude Verification 2026,GAV-2026-01,2026-08-01,2026-08-05,true,false,false
`
	parsed, verrs := parseBulkExamsCSV([]byte(csvData))
	if len(verrs) > 0 {
		t.Fatalf("expected 0 errors, got %v", verrs)
	}
	if len(parsed) != 3 {
		t.Fatalf("expected 3 parsed rows, got %d", len(parsed))
	}

	if parsed[0].Name != "National Eligibility Test Session 1" || parsed[0].ExamCode != "NET-2026-S1" {
		t.Errorf("row 0 mismatch: %+v", parsed[0])
	}
	if !parsed[0].RequiresFace || !parsed[0].RequiresFP || parsed[0].RequiresIris {
		t.Errorf("row 0 modality flags mismatch: %+v", parsed[0])
	}

	if !parsed[1].RequiresFace || !parsed[1].RequiresFP || !parsed[1].RequiresIris {
		t.Errorf("row 1 modality flags mismatch: %+v", parsed[1])
	}

	if !parsed[2].RequiresFace || parsed[2].RequiresFP || parsed[2].RequiresIris {
		t.Errorf("row 2 modality flags mismatch: %+v", parsed[2])
	}
}

func TestParseBulkExamsCSV_ValidationErrors(t *testing.T) {
	// Missing required headers
	_, verrs := parseBulkExamsCSV([]byte("col1,col2\nval1,val2\n"))
	if len(verrs) == 0 {
		t.Fatalf("expected header error, got none")
	}

	// Duplicate exam code in CSV
	csvDup := `exam_name,exam_code,verification_from,verification_to
Exam One,DUP-01,2026-06-01,2026-06-05
Exam Two,DUP-01,2026-07-01,2026-07-05
`
	_, verrs = parseBulkExamsCSV([]byte(csvDup))
	if len(verrs) != 1 {
		t.Fatalf("expected 1 duplicate error, got %d: %v", len(verrs), verrs)
	}

	// Window from > to
	csvBadWindow := `exam_name,exam_code,verification_from,verification_to
Exam One,CODE-01,2026-06-10,2026-06-05
`
	_, verrs = parseBulkExamsCSV([]byte(csvBadWindow))
	if len(verrs) != 1 {
		t.Fatalf("expected 1 window error, got %d: %v", len(verrs), verrs)
	}

	// All biometrics false
	csvNoBio := `exam_name,exam_code,verification_from,verification_to,requires_face,requires_fp,requires_iris
Exam One,CODE-01,2026-06-01,2026-06-05,no,no,no
`
	_, verrs = parseBulkExamsCSV([]byte(csvNoBio))
	if len(verrs) != 1 {
		t.Fatalf("expected 1 biometric error, got %d: %v", len(verrs), verrs)
	}
}
