package api

import (
	"database/sql"
	"testing"
)

func TestParseBulkOperatorsCSV_Valid(t *testing.T) {
	csvData := `username,password,display_name,email,phone,cap_amount,valid_from,valid_to,exam_codes
agent.rahul,Pass@123456,Rahul Sharma,rahul.agent@college.edu,+919876543210,1000,2027-06-01 09:00,2027-06-15 18:00,"NEET-2026, JEE-2026"
agent.priya,Secure@2026,Priya Patel,priya.agent@college.edu,+919812345678,500,2027-06-01 09:00,2027-06-15 18:00,
agent.amit,Pass@Amit2026,Amit Kumar,amit.agent@college.edu,9712345678,,,
`
	parsed, verrs := parseBulkOperatorsCSV([]byte(csvData))
	if len(verrs) > 0 {
		t.Fatalf("expected 0 errors, got %v", verrs)
	}
	if len(parsed) != 3 {
		t.Fatalf("expected 3 parsed rows, got %d", len(parsed))
	}

	if parsed[0].Username != "agent.rahul" || parsed[0].DisplayName != "Rahul Sharma" {
		t.Errorf("row 0 mismatch: %+v", parsed[0])
	}
	if parsed[0].Phone != "+919876543210" || parsed[0].SpendingCapPaise == nil || *parsed[0].SpendingCapPaise != 100000 {
		t.Errorf("row 0 phone or cap mismatch: %+v", parsed[0])
	}
	if len(parsed[0].ExamCodes) != 2 || parsed[0].ExamCodes[0] != "NEET-2026" || parsed[0].ExamCodes[1] != "JEE-2026" {
		t.Errorf("row 0 exam codes mismatch: %+v", parsed[0].ExamCodes)
	}

	if parsed[1].SpendingCapPaise == nil || *parsed[1].SpendingCapPaise != 50000 {
		t.Errorf("row 1 cap mismatch: %+v", parsed[1])
	}

	if parsed[2].SpendingCapPaise != nil {
		t.Errorf("row 2 expected nil cap, got %+v", parsed[2].SpendingCapPaise)
	}
}

func TestParseBulkOperatorsCSV_ValidationErrors(t *testing.T) {
	// Missing required headers
	_, verrs := parseBulkOperatorsCSV([]byte("col1,col2\nval1,val2\n"))
	if len(verrs) == 0 {
		t.Fatalf("expected header error, got none")
	}

	// Bad phone (not Indian 10-digit mobile)
	csvBadPhone := `username,password,display_name,email,phone
agent.one,Pass@123456,Agent One,one@college.edu,12345
`
	_, verrs = parseBulkOperatorsCSV([]byte(csvBadPhone))
	if len(verrs) != 1 {
		t.Fatalf("expected 1 phone error, got %d: %v", len(verrs), verrs)
	}

	// Duplicate username in CSV
	csvDup := `username,password,display_name,email,phone
agent.dup,Pass@123456,Agent Dup 1,dup1@college.edu,+919876543210
agent.dup,Pass@123456,Agent Dup 2,dup2@college.edu,+919876543211
`
	_, verrs = parseBulkOperatorsCSV([]byte(csvDup))
	if len(verrs) != 1 {
		t.Fatalf("expected 1 duplicate error, got %d: %v", len(verrs), verrs)
	}

	// Bad password
	csvBadPass := `username,password,display_name,email,phone
agent.bad,123,Agent Bad,bad@college.edu,+919876543210
`
	_, verrs = parseBulkOperatorsCSV([]byte(csvBadPass))
	if len(verrs) != 1 {
		t.Fatalf("expected 1 password error, got %d: %v", len(verrs), verrs)
	}
}

func TestValidateOperatorWindowAgainstExam(t *testing.T) {
	examFrom := sqlNullStr("2026-06-01 09:00")
	examTo := sqlNullStr("2026-06-30 18:00")

	// Inside window -> PASS
	if err := validateOperatorWindowAgainstExam("2026-06-05 10:00", "2026-06-25 17:00", examFrom, examTo); err != nil {
		t.Fatalf("expected inside window to pass, got: %v", err)
	}

	// Exact bounds -> PASS
	if err := validateOperatorWindowAgainstExam("2026-06-01 09:00", "2026-06-30 18:00", examFrom, examTo); err != nil {
		t.Fatalf("expected exact window to pass, got: %v", err)
	}

	// Op start before Exam start -> FAIL
	if err := validateOperatorWindowAgainstExam("2026-05-30 10:00", "2026-06-25 17:00", examFrom, examTo); err == nil {
		t.Fatalf("expected error when op start is before exam start, got nil")
	}

	// Op end after Exam end -> FAIL
	if err := validateOperatorWindowAgainstExam("2026-06-05 10:00", "2026-07-05 17:00", examFrom, examTo); err == nil {
		t.Fatalf("expected error when op end is after exam end, got nil")
	}

	// Open exam window (NULL bounds) -> PASS
	if err := validateOperatorWindowAgainstExam("2026-01-01 10:00", "2030-01-01 17:00", sqlNullStr(""), sqlNullStr("")); err != nil {
		t.Fatalf("expected open window to pass, got: %v", err)
	}
}

func sqlNullStr(s string) sql.NullString {
	return sql.NullString{Valid: s != "", String: s}
}
