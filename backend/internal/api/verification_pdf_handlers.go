package api

import (
	"bytes"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jung-kurt/gofpdf"
)

// verificationPDF assembles a one-page A4 verification receipt and
// streams it as application/pdf.
//
//   GET /api/verifications/{id}/pdf
//
// Role scoping mirrors the history/list handlers:
//   client (operator)  → only verifications they themselves recorded
//   admin              → only rows in their org
//   superadmin / ops   → any row
//
// The captured (probe) photo is pulled from verifications.probe_photo_path
// — 1:1 with the verification event, so retakes on different days show
// their own day's photo and never leak yesterday's capture.

type pdfBundle struct {
	// verifications
	VerificationID   int64
	Status           string
	Via              string
	FaceMatch        bool
	FpMatch          bool
	FaceMatchScore   sql.NullFloat64
	FpMatchScore     sql.NullInt64
	IrisScore        sql.NullFloat64
	MatchThreshold   sql.NullInt64
	// Per-exam biometric requirements (migration 022). Drive which
	// modality rows appear in the PDF result block + which modalities
	// count toward the "verified by" list.
	RequiresFace bool
	RequiresFP   bool
	RequiresIris bool
	DeviceSerial     sql.NullString
	DeviceModel      sql.NullString
	FpVendor         sql.NullString
	CreatedAt        time.Time
	ProbePhotoPath   sql.NullString
	// candidate
	RollNo         string
	CandName       string
	RegistrationID sql.NullString
	FatherName     sql.NullString
	DOB            sql.NullString
	Gender         sql.NullString
	ShiftName      sql.NullString
	CentreCode     sql.NullString
	// exam / client
	ExamCode   string
	ExamName   string
	ClientName string
	// centre (may be absent if centre_code doesn't match)
	CentreName sql.NullString
	Address    sql.NullString
	City       sql.NullString
	State      sql.NullString
	Pincode    sql.NullString
	// operator
	OperatorName sql.NullString
}

func (s *Server) verificationPDF(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid verification id")
		return
	}
	claims := claimsFrom(r)
	if claims == nil {
		writeErr(w, http.StatusUnauthorized, "missing token")
		return
	}

	// One big JOIN that pulls everything the PDF needs. LEFT JOINs on
	// the optional bits (exam_centres via centre_code, exam_candidates
	// via roll_no) so a verification with a stale/missing centre_code
	// still renders — just without the address block.
	query := `
		SELECT v.id, v.status, COALESCE(v.via, ''), v.face_match, v.fp_match,
		       v.face_match_score, v.fp_match_score, v.iris_left_score,
		       v.match_threshold,
		       v.device_serial, v.device_model, v.fp_vendor, v.created_at,
		       v.probe_photo_path,
		       v.roll_no,
		       COALESCE(ec.name, v.roll_no),
		       ec.registration_id, ec.father_name, ec.dob, ec.gender,
		       ec.shift_name,      ec.centre_code,
		       COALESCE(e.exam_code, ''), COALESCE(e.name, ''),
		       COALESCE(c.name, ''),
		       ectr.centre_name, ectr.address, ectr.city, ectr.state, ectr.pincode,
		       u.display_name,
		       COALESCE(e.requires_face, 1), COALESCE(e.requires_fp, 1),
		       COALESCE(e.requires_iris, 0)
		  FROM verifications v
		  LEFT JOIN exam_candidates ec ON ec.roll_no    = v.roll_no
		  LEFT JOIN exams           e  ON e.id          = ec.exam_id
		  LEFT JOIN clients         c  ON c.id          = e.client_id
		  LEFT JOIN exam_centres    ectr
		         ON ectr.exam_id     = ec.exam_id
		        AND ectr.centre_code = ec.centre_code
		  LEFT JOIN users           u  ON u.id          = v.operator_id
		 WHERE v.id = ?`
	args := []any{id}
	// Role gate — attach a scope predicate.
	switch claims.Role {
	case "client":
		query += ` AND v.operator_id = ?`
		args = append(args, claims.UserID)
	case "admin":
		if claims.OrgID == nil {
			writeErr(w, http.StatusForbidden, "org context required")
			return
		}
		query += ` AND v.org_id = ?`
		args = append(args, *claims.OrgID)
	case "superadmin", "ops_admin":
		// no additional filter
	default:
		writeErr(w, http.StatusForbidden, "role not allowed")
		return
	}

	var b pdfBundle
	err = s.deps.DB.QueryRowContext(r.Context(), query, args...).Scan(
		&b.VerificationID, &b.Status, &b.Via, &b.FaceMatch, &b.FpMatch,
		&b.FaceMatchScore, &b.FpMatchScore, &b.IrisScore, &b.MatchThreshold,
		&b.DeviceSerial, &b.DeviceModel, &b.FpVendor, &b.CreatedAt,
		&b.ProbePhotoPath,
		&b.RollNo, &b.CandName,
		&b.RegistrationID, &b.FatherName, &b.DOB, &b.Gender,
		&b.ShiftName, &b.CentreCode,
		&b.ExamCode, &b.ExamName, &b.ClientName,
		&b.CentreName, &b.Address, &b.City, &b.State, &b.Pincode,
		&b.OperatorName,
		&b.RequiresFace, &b.RequiresFP, &b.RequiresIris,
	)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "verification not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}

	// Resolve the gallery photo the same way the operator endpoint
	// does — through the filesystem indexer keyed by roll_no.
	galleryPath := ""
	if row, ok := s.deps.Index.Get(b.RollNo); ok && row.HasPhoto {
		galleryPath = row.PhotoPath
	}
	probePath := ""
	if b.ProbePhotoPath.Valid {
		if _, err := os.Stat(b.ProbePhotoPath.String); err == nil {
			probePath = b.ProbePhotoPath.String
		}
	}

	pdfBytes, err := renderVerificationPDF(&b, galleryPath, probePath)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "pdf render: "+err.Error())
		return
	}

	stamp := b.CreatedAt.Format("20060102-150405")
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`attachment; filename="verification-%d-%s.pdf"`, b.VerificationID, stamp))
	w.Header().Set("Content-Length", strconv.Itoa(len(pdfBytes)))
	_, _ = w.Write(pdfBytes)
}

// renderVerificationPDF builds the actual PDF. Kept as a pure function
// so it's easy to unit-test the layout against a golden fixture later.
//
// Layout (A4 portrait, 20 mm margins):
//
//	┌─── header band ──────────────────────────────────────────────┐
//	│ CLIENT • EXAM_CODE                       Verification Receipt│
//	├──────────────────────────────────────────────────────────────┤
//	│ [gallery]    Name       : Amogh Sharma                       │
//	│ [ photo ]    Roll       : 10001                              │
//	│              Reg ID     : REG001                             │
//	│ [captured]   Father     : Amogh Sr                           │
//	│ [ photo  ]   DOB / Sex  : 1990-01-01 / M                     │
//	│              Shift      : SHIFT1                             │
//	├──────────────────────────────────────────────────────────────┤
//	│  RESULT   [ VERIFIED ]                                       │
//	│  Face   : 0.99 (thr 0.80) PASS                               │
//	│  Fp     : 173  (thr 40)   PASS                               │
//	│  Time   : 2026-08-11 15:42 UTC                               │
//	│  Op     : sample_44_op                                        │
//	│  Device : Mantra MFS100 • SN xyz                             │
//	├──────────────────────────────────────────────────────────────┤
//	│  Centre : Sample Centre 1 (CENTRE001)                        │
//	│           123 Sample Address, New Delhi 110001               │
//	│  Verification ID: 42     Generated 2026-08-11 15:45 UTC      │
//	└──────────────────────────────────────────────────────────────┘
// pdfTR is set once per renderVerificationPDF call — it wraps the
// gofpdf UnicodeTranslator for the built-in Helvetica font (cp1252 /
// WinAnsi). Every user-visible string passes through it so UTF-8
// punctuation like "•" / "—" / smart quotes doesn't render as "â€¢"
// on Adobe Reader. Package-level so the tiny draw helpers can call
// it without threading it as an argument.
var pdfTR func(string) string

// indiaTZ is the display timezone for every timestamp on the receipt.
// Deliberately IST rather than UTC: the receipt hits an operator or
// candidate's hand, and "15:42 IST" is unambiguous to that reader
// whereas "10:12 UTC" invites confusion or a wrong mental conversion.
// Falls back to a fixed +05:30 offset if the OS tzdata isn't shipped
// (rare on Ubuntu; belt-and-braces).
var indiaTZ = func() *time.Location {
	if loc, err := time.LoadLocation("Asia/Kolkata"); err == nil {
		return loc
	}
	return time.FixedZone("IST", 5*3600+30*60)
}()

// tr is the short form used throughout drawing helpers. Guarded so
// unit tests that don't call renderVerificationPDF still compile.
func tr(s string) string {
	if pdfTR == nil {
		return s
	}
	return pdfTR(s)
}

func renderVerificationPDF(b *pdfBundle, galleryPath, probePath string) ([]byte, error) {
	pdf := gofpdf.New("P", "mm", "A4", "")
	pdf.SetMargins(10, 10, 10)
	pdf.SetAutoPageBreak(false, 10)
	pdfTR = pdf.UnicodeTranslatorFromDescriptor("")
	pdf.AddPage()

	// Admit-card style but softer: single thin outer frame, more
	// breathing room between sections, restrained typography weight.
	drawOuterFrame(pdf)
	drawHeaderBand(pdf, b)
	drawTitleStrip(pdf, b)
	drawCandidateAndPhotoBlock(pdf, b, galleryPath, probePath)
	drawExamCentreBlock(pdf, b)
	drawVerificationResultBlock(pdf, b)
	drawBiometricsTable(pdf, b)
	drawRecordedByBlock(pdf, b)
	drawFooter(pdf, b)

	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// drawOuterFrame — a single hairline in slate-300 so the page reads
// as "framed document" without the heavy double-border admit-card
// look. Restrained.
func drawOuterFrame(pdf *gofpdf.Fpdf) {
	pdf.SetDrawColor(203, 213, 225) // slate-300
	pdf.SetLineWidth(0.2)
	pdf.Rect(8, 8, 194, 281, "D")
}

// drawCandidateAndPhotoBlock — admit-card style boxed table on the
// left with the enrolled photo on the top-right (with signature-line
// caption below), the captured "today" photo on the bottom-right.
// Every row of the candidate table has a border for that formal
// government-form feel.
func drawCandidateAndPhotoBlock(pdf *gofpdf.Fpdf, b *pdfBundle, galleryPath, probePath string) {
	const (
		topY    = 38.0
		leftX   = 10.0
		leftW   = 130.0
		rightX  = 140.0
		rightW  = 60.0
		photoH  = 40.0
		rowH    = 7.0
	)

	// Section title strip -- light bg, small caps.
	pdf.SetFillColor(241, 245, 249)
	pdf.Rect(leftX, topY, 190, 5, "F")
	pdf.SetTextColor(71, 85, 105)
	pdf.SetFont("Helvetica", "B", 7.5)
	pdf.SetXY(leftX+2, topY+0.5)
	pdf.CellFormat(190, 4, tr("CANDIDATE DETAILS"), "", 0, "L", false, 0, "")

	// Photo box on the right (gallery = enrolled).
	drawPhotoBox(pdf, rightX, topY+5, rightW, photoH, "ENROLLED PHOTO", galleryPath)

	// Table body: label:value rows with hairline dividers.
	pdf.SetTextColor(15, 23, 42)
	fields := []struct{ label, value string }{
		{"Candidate name",   b.CandName},
		{"Roll number",      b.RollNo},
		{"Registration no.", nullstr(b.RegistrationID)},
		{"Father's name",    nullstr(b.FatherName)},
		{"Date of birth",    formatDOB(nullstr(b.DOB))},
		{"Gender",           formatGender(nullstr(b.Gender))},
		{"Shift",            nullstr(b.ShiftName)},
		{"Exam code",        b.ExamCode},
	}

	pdf.SetDrawColor(226, 232, 240) // slate-400
	pdf.SetLineWidth(0.15)
	pdf.Rect(leftX, topY+5, leftW, float64(len(fields))*rowH, "D")

	// Vertical separator between label and value.
	const labelW = 42.0
	pdf.Line(leftX+labelW, topY+5, leftX+labelW, topY+5+float64(len(fields))*rowH)

	y := topY + 5
	for i, f := range fields {
		val := strings.TrimSpace(f.value)
		if val == "" {
			val = "—"
		}
		// Row divider (skip last row's bottom — outer Rect handles it).
		if i > 0 {
			pdf.Line(leftX, y, leftX+leftW, y)
		}
		// Label cell
		pdf.SetFillColor(241, 245, 249) // slate-100 label bg
		pdf.Rect(leftX, y, labelW, rowH, "F")
		pdf.SetXY(leftX+1.5, y+1.4)
		pdf.SetFont("Helvetica", "", 8.5)
		pdf.SetTextColor(71, 85, 105)
		pdf.CellFormat(labelW-2, 4, tr(f.label), "", 0, "L", false, 0, "")

		// Value cell
		pdf.SetXY(leftX+labelW+2, y+1.4)
		pdf.SetFont("Helvetica", "B", 10)
		pdf.SetTextColor(15, 23, 42)
		pdf.CellFormat(leftW-labelW-3, 4, tr(val), "", 0, "L", false, 0, "")
		y += rowH
	}

	// Captured photo (bottom-right, below enrolled photo).
	drawPhotoBox(pdf, rightX, topY+5+photoH+4, rightW, photoH, "CAPTURED AT VERIFICATION", probePath)

	// Advance Y to below both columns (whichever is taller).
	leftBottom := topY + 5 + float64(len(fields))*rowH
	rightBottom := topY + 5 + 2*photoH + 4 + 4
	if rightBottom > leftBottom {
		pdf.SetY(rightBottom + 3)
	} else {
		pdf.SetY(leftBottom + 3)
	}
}

// drawPhotoBox is the passport-photo card used for both the enrolled
// gallery photo and the captured probe photo. Border + caption strip
// underneath, filled placeholder if the photo is missing.
func drawPhotoBox(pdf *gofpdf.Fpdf, x, y, w, h float64, caption, path string) {
	// Hairline slate-300 border, no fill.
	pdf.SetDrawColor(203, 213, 225)
	pdf.SetLineWidth(0.2)
	pdf.Rect(x, y, w, h, "D")

	if path != "" {
		tp := "JPG"
		if strings.HasSuffix(strings.ToLower(path), ".png") {
			tp = "PNG"
		}
		pdf.ImageOptions(path, x+0.6, y+0.6, w-1.2, h-1.2, false,
			gofpdf.ImageOptions{ImageType: tp, ReadDpi: false}, 0, "")
	} else {
		pdf.SetFillColor(248, 250, 252)
		pdf.Rect(x+0.4, y+0.4, w-0.8, h-0.8, "F")
		pdf.SetFont("Helvetica", "I", 8)
		pdf.SetTextColor(148, 163, 184)
		pdf.SetXY(x, y+h/2-2)
		pdf.CellFormat(w, 4, tr("photo unavailable"), "", 0, "C", false, 0, "")
	}

	// Caption below the photo (no filled strip — just small centred label).
	pdf.SetFont("Helvetica", "B", 7)
	pdf.SetTextColor(100, 116, 139)
	pdf.SetXY(x, y+h+1.2)
	pdf.CellFormat(w, 3, tr(caption), "", 0, "C", false, 0, "")
	pdf.SetTextColor(15, 23, 42)
}

func drawVerdictCard_deprecated(pdf *gofpdf.Fpdf, b *pdfBundle) {
	const (
		x = 15.0
		y = 28.0
		w = 180.0
		h = 24.0
	)
	verified := strings.EqualFold(b.Status, "verified")
	if verified {
		pdf.SetFillColor(240, 253, 244) // emerald-50
		pdf.SetDrawColor(134, 239, 172)  // emerald-300
	} else {
		pdf.SetFillColor(254, 242, 242) // rose-50
		pdf.SetDrawColor(252, 165, 165)  // rose-300
	}
	pdf.SetLineWidth(0.4)
	pdf.RoundedRect(x, y, w, h, 2.5, "1234", "FD")

	// Left icon + verdict text.
	if verified {
		pdf.SetTextColor(21, 128, 61) // emerald-700
	} else {
		pdf.SetTextColor(153, 27, 27) // red-800
	}
	pdf.SetFont("Helvetica", "B", 18)
	pdf.SetXY(x+6, y+5)
	mark := "OK"
	label := "VERIFIED"
	if !verified {
		mark = "X"
		label = "NOT VERIFIED"
	}
	pdf.CellFormat(9, 8, tr(mark), "", 0, "L", false, 0, "")
	pdf.SetXY(x+14, y+4.5)
	pdf.CellFormat(70, 9, tr(label), "", 0, "L", false, 0, "")

	// Modality summary on the right — the "via" list computed the same
	// way as before (only PASSING required modalities count).
	irisPass := b.IrisScore.Valid && b.IrisScore.Float64 >= 50
	var via string
	if verified {
		passed := []string{}
		if b.RequiresFace && b.FaceMatch { passed = append(passed, "Face") }
		if b.RequiresFP   && b.FpMatch   { passed = append(passed, "Fingerprint") }
		if b.RequiresIris && irisPass    { passed = append(passed, "Iris") }
		if len(passed) > 0 {
			via = "via " + strings.Join(passed, " + ")
		} else {
			via = "manually recorded"
		}
	} else {
		via = "biometric match failed"
	}

	pdf.SetFont("Helvetica", "", 9)
	pdf.SetTextColor(71, 85, 105) // slate-600
	pdf.SetXY(x+14, y+14)
	pdf.CellFormat(w-20, 5, tr(via), "", 0, "L", false, 0, "")

	// Time on the right side of the card.
	pdf.SetFont("Helvetica", "B", 9)
	pdf.SetTextColor(51, 65, 85) // slate-700
	pdf.SetXY(x, y+4.5)
	pdf.CellFormat(w-6, 5, tr(b.CreatedAt.In(indiaTZ).Format("02 Jan 2006  15:04 IST")), "", 0, "R", false, 0, "")

	// Verification ID pill on the right, below the time.
	pdf.SetFont("Helvetica", "", 8)
	pdf.SetTextColor(100, 116, 139)
	pdf.SetXY(x, y+14)
	pdf.CellFormat(w-6, 5, tr(fmt.Sprintf("Verification #%d", b.VerificationID)), "", 0, "R", false, 0, "")

	pdf.SetTextColor(15, 23, 42)
	pdf.SetY(y + h + 8)
}

func drawHeaderBand(pdf *gofpdf.Fpdf, b *pdfBundle) {
	// Formal admit-card header: dark navy band tucked inside the outer
	// frame, all-caps centred client name. The classic exam-body look.
	pdf.SetFillColor(15, 23, 42) // slate-900
	pdf.Rect(10, 10, 190, 16, "F")

	// Centred client name in the band.
	pdf.SetTextColor(255, 255, 255)
	pdf.SetFont("Helvetica", "B", 15)
	client := strings.ToUpper(strings.TrimSpace(b.ClientName))
	if client == "" {
		client = "VERIFICATION AUTHORITY"
	}
	pdf.SetXY(10, 13)
	pdf.CellFormat(190, 6, tr(client), "", 0, "C", false, 0, "")

	// Subline in the band -- exam code + full exam name if present.
	pdf.SetFont("Helvetica", "", 9)
	pdf.SetTextColor(203, 213, 225) // slate-300
	pdf.SetXY(10, 20)
	sub := ""
	code := strings.TrimSpace(b.ExamCode)
	name := strings.TrimSpace(b.ExamName)
	if code != "" && name != "" && !strings.EqualFold(code, name) {
		sub = name + "  ·  Code: " + code
	} else if name != "" {
		sub = name
	} else if code != "" {
		sub = "Code: " + code
	}
	pdf.CellFormat(190, 4, tr(sub), "", 0, "C", false, 0, "")

	// Accent stripe below the band.
	pdf.SetFillColor(220, 38, 38) // red-600 for a classic official-form accent
	pdf.Rect(10, 26, 190, 1, "F")

	pdf.SetTextColor(15, 23, 42)
}

// drawTitleStrip is the "BIOMETRIC VERIFICATION SLIP" title just below
// the header band. Small caps, letter-spaced feel. Balances the header
// so the eye lands on it before dropping into the details.
func drawTitleStrip(pdf *gofpdf.Fpdf, b *pdfBundle) {
	pdf.SetFillColor(248, 250, 252) // slate-50
	pdf.Rect(10, 27, 190, 8, "F")

	pdf.SetTextColor(15, 23, 42)
	pdf.SetFont("Helvetica", "B", 12)
	pdf.SetXY(10, 29)
	pdf.CellFormat(190, 5, tr("BIOMETRIC   VERIFICATION   SLIP"), "", 0, "C", false, 0, "")
}

func drawPhotosAndDetails(pdf *gofpdf.Fpdf, b *pdfBundle, galleryPath, probePath string) {
	// Two 42x50 mm photo slots on the left (passport-photo aspect),
	// candidate details in a clean grid on the right, biometrics
	// results below the details.
	const (
		leftX      = 15.0
		photoY1    = 62.0
		photoY2    = 122.0
		photoW     = 42.0
		photoH     = 52.0
		detailX    = 65.0
		detailW    = 130.0
		labelW     = 34.0
	)

	drawPhotoSlot(pdf, leftX, photoY1, photoW, photoH, "GALLERY PHOTO", galleryPath)
	drawPhotoSlot(pdf, leftX, photoY2, photoW, photoH, "CAPTURED TODAY", probePath)

	// CANDIDATE section header.
	pdf.SetXY(detailX, photoY1-0.5)
	pdf.SetFont("Helvetica", "B", 8)
	pdf.SetTextColor(100, 116, 139) // slate-500
	pdf.CellFormat(detailW, 4, tr("CANDIDATE"), "", 2, "L", false, 0, "")

	// Divider under section header.
	pdf.SetDrawColor(226, 232, 240)
	pdf.SetLineWidth(0.2)
	pdf.Line(detailX, photoY1+4, detailX+detailW, photoY1+4)

	// Candidate detail rows.
	labelValue := []struct{ label, value string }{
		{"Name",            b.CandName},
		{"Roll number",     b.RollNo},
		{"Registration",    nullstr(b.RegistrationID)},
		{"Father's name",   nullstr(b.FatherName)},
		{"DOB / Gender",    prettyDOBGender(nullstr(b.DOB), nullstr(b.Gender))},
		{"Shift",           nullstr(b.ShiftName)},
	}
	rowY := photoY1 + 7
	for _, r := range labelValue {
		if strings.TrimSpace(r.value) == "" {
			r.value = "—"
		}
		pdf.SetXY(detailX, rowY)
		pdf.SetFont("Helvetica", "", 8.5)
		pdf.SetTextColor(100, 116, 139) // slate-500 label
		pdf.CellFormat(labelW, 6, tr(r.label), "", 0, "L", false, 0, "")
		pdf.SetTextColor(15, 23, 42) // slate-900 value
		pdf.SetFont("Helvetica", "B", 10.5)
		pdf.CellFormat(detailW-labelW, 6, tr(r.value), "", 2, "L", false, 0, "")
		rowY += 7
	}

	// BIOMETRICS section header.
	bioY := rowY + 4
	pdf.SetXY(detailX, bioY)
	pdf.SetFont("Helvetica", "B", 8)
	pdf.SetTextColor(100, 116, 139)
	pdf.CellFormat(detailW, 4, tr("BIOMETRICS"), "", 2, "L", false, 0, "")
	pdf.Line(detailX, bioY+4, detailX+detailW, bioY+4)

	// Biometric outcome rows — no scores, no thresholds, just Passed
	// or Not passed with a leading tick / cross and a coloured bar on
	// the left of each row.
	drawBiometricRow := func(y float64, label string, required, passed bool) {
		if !required {
			return
		}
		pdf.SetXY(detailX, y)
		// Left color bar
		if passed {
			pdf.SetFillColor(34, 197, 94) // emerald-500
		} else {
			pdf.SetFillColor(239, 68, 68) // red-500
		}
		pdf.Rect(detailX, y+1.2, 1.2, 5.5, "F")

		// Tick / cross glyph
		if passed {
			pdf.SetTextColor(21, 128, 61) // emerald-700
		} else {
			pdf.SetTextColor(153, 27, 27) // red-800
		}
		pdf.SetFont("Helvetica", "B", 10)
		pdf.SetXY(detailX+3.5, y)
		mark := "OK"
		if !passed {
			mark = "X"
		}
		pdf.CellFormat(6, 7, tr(mark), "", 0, "L", false, 0, "")

		// Label
		pdf.SetTextColor(15, 23, 42)
		pdf.SetFont("Helvetica", "B", 10)
		pdf.SetXY(detailX+10, y)
		pdf.CellFormat(labelW+6, 7, tr(label), "", 0, "L", false, 0, "")

		// Verdict word
		if passed {
			pdf.SetTextColor(21, 128, 61)
		} else {
			pdf.SetTextColor(153, 27, 27)
		}
		pdf.SetFont("Helvetica", "B", 10)
		pdf.SetXY(detailX+52, y)
		verdict := "PASSED"
		if !passed {
			verdict = "NOT PASSED"
		}
		pdf.CellFormat(40, 7, tr(verdict), "", 0, "L", false, 0, "")
	}

	rowY = bioY + 8
	irisPass := b.IrisScore.Valid && b.IrisScore.Float64 >= 50
	if b.RequiresFace {
		drawBiometricRow(rowY, "Face",        true, b.FaceMatch)
		rowY += 8
	}
	if b.RequiresFP {
		drawBiometricRow(rowY, "Fingerprint", true, b.FpMatch)
		rowY += 8
	}
	if b.RequiresIris {
		drawBiometricRow(rowY, "Iris",        true, irisPass)
		rowY += 8
	}

	// Anchor Y to whichever column extended lower.
	afterPhotos := photoY2 + photoH + 6
	if rowY+4 > afterPhotos {
		pdf.SetY(rowY + 4)
	} else {
		pdf.SetY(afterPhotos)
	}
}

func drawPhotoSlot(pdf *gofpdf.Fpdf, x, y, w, h float64, caption, path string) {
	// Subtle grey card with a hairline border. 1mm inset so the image
	// doesn't touch the border and look cramped.
	pdf.SetFillColor(248, 250, 252) // slate-50
	pdf.SetDrawColor(203, 213, 225)  // slate-300
	pdf.SetLineWidth(0.3)
	pdf.RoundedRect(x, y, w, h, 1.5, "1234", "FD")

	if path != "" {
		tp := "JPG"
		lower := strings.ToLower(path)
		if strings.HasSuffix(lower, ".png") {
			tp = "PNG"
		}
		pdf.ImageOptions(path, x+1, y+1, w-2, h-2, false,
			gofpdf.ImageOptions{ImageType: tp, ReadDpi: false}, 0, "")
	} else {
		pdf.SetFont("Helvetica", "I", 8)
		pdf.SetTextColor(148, 163, 184)
		pdf.SetXY(x, y+h/2-2)
		pdf.CellFormat(w, 4, tr("not available"), "", 0, "C", false, 0, "")
	}

	// Caption below the card, uppercase small text.
	pdf.SetFont("Helvetica", "B", 7)
	pdf.SetTextColor(100, 116, 139)
	pdf.SetXY(x, y+h+1.5)
	pdf.CellFormat(w, 3, tr(caption), "", 0, "C", false, 0, "")
}

// prettyDOBGender formats "2005-06-20" + "M" as "20 Jun 2005 · Male",
// gracefully degrades on empty inputs. Better on a printed receipt
// than the raw ISO date.
func prettyDOBGender(dob, gender string) string {
	dob = dateOnly(dob)
	out := ""
	if dob != "" {
		if t, err := time.Parse("2006-01-02", dob); err == nil {
			out = t.Format("02 Jan 2006")
		} else {
			out = dob
		}
	}
	g := ""
	switch strings.ToUpper(strings.TrimSpace(gender)) {
	case "M":
		g = "Male"
	case "F":
		g = "Female"
	case "":
		g = ""
	default:
		g = gender
	}
	if out != "" && g != "" {
		return out + "  ·  " + g
	}
	if out != "" {
		return out
	}
	return g
}

// drawResultBlock retained for reference but no longer called from
// renderVerificationPDF -- the result is now the top-of-page verdict
// card + per-modality PASSED rows in drawPhotosAndDetails. Kept to
// avoid touching an unrelated test surface if one exists.
func drawResultBlock_deprecated(pdf *gofpdf.Fpdf, b *pdfBundle) {
	y := pdf.GetY() + 2
	pdf.SetDrawColor(226, 232, 240)
	pdf.SetLineWidth(0.3)
	pdf.Line(15, y, 195, y)
	pdf.SetY(y + 4)

	pdf.SetX(15)
	pdf.SetFont("Helvetica", "B", 9)
	pdf.SetTextColor(100, 116, 139)
	pdf.CellFormat(180, 5, tr("RESULT"), "", 2, "L", false, 0, "")

	statusUpper := strings.ToUpper(b.Status)
	badgeW := 45.0
	badgeH := 10.0
	if b.Status == "verified" {
		pdf.SetFillColor(220, 252, 231) // emerald-100
		pdf.SetTextColor(20, 83, 45)     // emerald-900
	} else {
		pdf.SetFillColor(254, 226, 226) // rose-100
		pdf.SetTextColor(136, 19, 55)    // rose-900
	}
	pdf.Rect(15, pdf.GetY(), badgeW, badgeH, "F")
	pdf.SetFont("Helvetica", "B", 12)
	pdf.SetXY(15, pdf.GetY()+1.6)
	pdf.CellFormat(badgeW, 6.5, tr(statusUpper), "", 0, "C", false, 0, "")

	pdf.SetY(pdf.GetY() + badgeH + 4)
	pdf.SetTextColor(15, 23, 42)
	pdf.SetFont("Helvetica", "", 9)

	// Build the "Via" field dynamically:
	//   - verified + at least one required biometric passed → join the
	//     names of every required modality that PASSED (e.g. "Face +
	//     Fingerprint + Iris"). This tells the reader exactly which
	//     modalities produced the verified verdict.
	//   - verified + no biometric passed → operator marked verified
	//     manually (edge case; possible via the manual-override path).
	//     Show "Manual".
	//   - denied → "Verification failed" so the reader isn't left
	//     wondering what the top-priority modality was.
	irisPass := b.IrisScore.Valid && b.IrisScore.Float64 >= 50
	var via string
	if strings.EqualFold(b.Status, "verified") {
		passed := []string{}
		if b.RequiresFace && b.FaceMatch { passed = append(passed, "Face") }
		if b.RequiresFP   && b.FpMatch   { passed = append(passed, "Fingerprint") }
		if b.RequiresIris && irisPass    { passed = append(passed, "Iris") }
		if len(passed) > 0 {
			via = strings.Join(passed, " + ")
		} else {
			via = "Manual"
		}
	} else {
		via = "Verification failed"
	}

	// Rows: Via always, then one row per REQUIRED modality only. An
	// exam that doesn't require iris no longer shows an "Iris —" row.
	// Same for face-only or fp-only exams.
	rows := []struct{ k, v string }{{"Via", via}}
	if b.RequiresFace {
		rows = append(rows, struct{ k, v string }{
			"Face match",
			fmt.Sprintf("%s   (threshold %s)   %s",
				fmtFloat(b.FaceMatchScore), fmtIntThreshold(b.MatchThreshold, true),
				passFail(b.FaceMatch)),
		})
	}
	if b.RequiresFP {
		rows = append(rows, struct{ k, v string }{
			"Fingerprint",
			fmt.Sprintf("%s   (threshold %s)   %s",
				fmtInt(b.FpMatchScore), fmtIntThreshold(b.MatchThreshold, false),
				passFail(b.FpMatch)),
		})
	}
	if b.RequiresIris && b.IrisScore.Valid {
		rows = append(rows, struct{ k, v string }{
			"Iris",
			fmt.Sprintf("%.0f   (threshold 50)   %s",
				b.IrisScore.Float64, passFail(irisPass)),
		})
	}
	rows = append(rows,
		struct{ k, v string }{"Time", b.CreatedAt.In(indiaTZ).Format("2006-01-02 15:04:05 IST")},
		struct{ k, v string }{"Operator", nullstr(b.OperatorName)},
		struct{ k, v string }{"Device", strings.TrimSpace(
			nullstr(b.FpVendor) + "  " + nullstr(b.DeviceModel) + "  " + nullstr(b.DeviceSerial))},
	)
	for _, r := range rows {
		if strings.TrimSpace(r.v) == "" {
			r.v = "—"
		}
		pdf.SetX(15)
		pdf.SetFont("Helvetica", "", 9)
		pdf.SetTextColor(100, 116, 139)
		pdf.CellFormat(40, 6, tr(r.k), "", 0, "L", false, 0, "")
		pdf.SetTextColor(15, 23, 42)
		pdf.SetFont("Helvetica", "B", 10)
		pdf.CellFormat(140, 6, tr(r.v), "", 2, "L", false, 0, "")
	}
}

// drawCentreAndOperator renders the two admin blocks side by side at
// the bottom of the page: WHERE (centre + address) on the left, WHO
// (operator + device) on the right. Both are equally-weighted so the
// eye reads them together as "recorded at X by Y".
func drawCentreAndOperator(pdf *gofpdf.Fpdf, b *pdfBundle) {
	y := pdf.GetY() + 4
	if y < 235 { y = 235 }

	// Divider above the two blocks.
	pdf.SetDrawColor(226, 232, 240)
	pdf.SetLineWidth(0.3)
	pdf.Line(15, y, 195, y)
	y += 5

	const (
		leftX  = 15.0
		rightX = 108.0
		colW   = 85.0
	)

	// Left column — CENTRE.
	pdf.SetXY(leftX, y)
	pdf.SetFont("Helvetica", "B", 8)
	pdf.SetTextColor(100, 116, 139)
	pdf.CellFormat(colW, 4, tr("CENTRE"), "", 2, "L", false, 0, "")

	pdf.SetTextColor(15, 23, 42)
	pdf.SetFont("Helvetica", "B", 10.5)
	pdf.SetXY(leftX, y+5)
	name := nullstr(b.CentreName)
	code := nullstr(b.CentreCode)
	line := name
	if code != "" {
		if line != "" {
			line += "  (" + code + ")"
		} else {
			line = code
		}
	}
	if line == "" { line = "—" }
	pdf.CellFormat(colW, 5, tr(line), "", 2, "L", false, 0, "")

	pdf.SetFont("Helvetica", "", 9)
	pdf.SetTextColor(71, 85, 105)
	addr := strings.TrimSpace(nullstr(b.Address))
	if addr != "" {
		pdf.SetXY(leftX, pdf.GetY())
		pdf.CellFormat(colW, 4.5, tr(addr), "", 2, "L", false, 0, "")
	}
	locality := strings.TrimSpace(
		strings.TrimSpace(nullstr(b.City)) + "  " + strings.TrimSpace(nullstr(b.State)) +
			"  " + strings.TrimSpace(nullstr(b.Pincode)))
	if locality != "" {
		pdf.SetXY(leftX, pdf.GetY())
		pdf.CellFormat(colW, 4.5, tr(locality), "", 2, "L", false, 0, "")
	}

	// Right column — RECORDED BY.
	pdf.SetXY(rightX, y)
	pdf.SetFont("Helvetica", "B", 8)
	pdf.SetTextColor(100, 116, 139)
	pdf.CellFormat(colW, 4, tr("RECORDED BY"), "", 2, "L", false, 0, "")

	pdf.SetTextColor(15, 23, 42)
	pdf.SetFont("Helvetica", "B", 10.5)
	pdf.SetXY(rightX, y+5)
	op := nullstr(b.OperatorName)
	if op == "" { op = "—" }
	pdf.CellFormat(colW, 5, tr(op), "", 2, "L", false, 0, "")

	pdf.SetFont("Helvetica", "", 9)
	pdf.SetTextColor(71, 85, 105)
	device := strings.TrimSpace(strings.Join(filterEmpty(
		nullstr(b.FpVendor), nullstr(b.DeviceModel), nullstr(b.DeviceSerial),
	), "  ·  "))
	if device == "" { device = "no device metadata" }
	pdf.SetXY(rightX, pdf.GetY())
	pdf.CellFormat(colW, 4.5, tr(device), "", 2, "L", false, 0, "")
}

// drawFooter is the small print at the very bottom, inside the outer
// frame. Left = verification ID, right = generated timestamp.
func drawFooter(pdf *gofpdf.Fpdf, b *pdfBundle) {
	pdf.SetDrawColor(226, 232, 240)
	pdf.SetLineWidth(0.15)
	pdf.Line(10, 283, 200, 283)

	pdf.SetXY(10, 284)
	pdf.SetFont("Helvetica", "", 7.5)
	pdf.SetTextColor(100, 116, 139)
	pdf.CellFormat(95, 4, tr(fmt.Sprintf("Verification ID  #%d", b.VerificationID)), "", 0, "L", false, 0, "")
	pdf.SetXY(105, 284)
	pdf.CellFormat(95, 4, tr("Generated  "+time.Now().In(indiaTZ).Format("02 Jan 2006, 15:04 IST")+"  ·  This is an electronically generated document"), "", 0, "R", false, 0, "")
}

// drawExamCentreBlock — bordered section with the centre name, code,
// and full address. Immediately below the candidate block.
func drawExamCentreBlock(pdf *gofpdf.Fpdf, b *pdfBundle) {
	y := pdf.GetY()

	// Section title strip -- light bg, small caps, restrained.
	pdf.SetFillColor(241, 245, 249) // slate-100
	pdf.Rect(10, y, 190, 5, "F")
	pdf.SetTextColor(71, 85, 105) // slate-600
	pdf.SetFont("Helvetica", "B", 7.5)
	pdf.SetXY(12, y+0.5)
	pdf.CellFormat(190, 4, tr("EXAMINATION CENTRE"), "", 0, "L", false, 0, "")

	// Body.
	bodyY := y + 5
	bodyH := 16.0
	pdf.SetDrawColor(226, 232, 240)
	pdf.SetLineWidth(0.15)
	pdf.Rect(10, bodyY, 190, bodyH, "D")

	pdf.SetTextColor(15, 23, 42)
	pdf.SetFont("Helvetica", "B", 11)
	pdf.SetXY(13, bodyY+2)
	name := nullstr(b.CentreName)
	code := nullstr(b.CentreCode)
	line := name
	if code != "" {
		if line != "" {
			line += "   (Code: " + code + ")"
		} else {
			line = "Code: " + code
		}
	}
	if line == "" {
		line = "—"
	}
	pdf.CellFormat(184, 5, tr(line), "", 0, "L", false, 0, "")

	// Address line.
	addr := strings.TrimSpace(nullstr(b.Address))
	locality := strings.TrimSpace(nullstr(b.City) + ",  " + nullstr(b.State) + "  " + nullstr(b.Pincode))
	fullAddr := addr
	if locality != "" && strings.TrimSpace(strings.Trim(locality, " ,")) != "" {
		if fullAddr != "" {
			fullAddr += "  ·  " + locality
		} else {
			fullAddr = locality
		}
	}
	if fullAddr == "" {
		fullAddr = "address on record"
	}
	pdf.SetFont("Helvetica", "", 9)
	pdf.SetTextColor(71, 85, 105)
	pdf.SetXY(13, bodyY+8)
	pdf.CellFormat(184, 4.5, tr(fullAddr), "", 0, "L", false, 0, "")

	pdf.SetY(bodyY + bodyH + 3)
}

// drawVerificationResultBlock — the big stamp-style verdict. Left is
// the tilted VERIFIED / NOT VERIFIED stamp (double-ring border for
// the classic official-stamp look). Right is a two-line summary:
// "via Face + Fingerprint + Iris" and the timestamp.
func drawVerificationResultBlock(pdf *gofpdf.Fpdf, b *pdfBundle) {
	y := pdf.GetY()

	// Section title strip -- light bg, small caps, restrained.
	pdf.SetFillColor(241, 245, 249) // slate-100
	pdf.Rect(10, y, 190, 5, "F")
	pdf.SetTextColor(71, 85, 105) // slate-600
	pdf.SetFont("Helvetica", "B", 7.5)
	pdf.SetXY(12, y+0.5)
	pdf.CellFormat(190, 4, tr("VERIFICATION RESULT"), "", 0, "L", false, 0, "")

	// Body.
	bodyY := y + 5
	bodyH := 28.0
	pdf.SetDrawColor(226, 232, 240)
	pdf.SetLineWidth(0.15)
	pdf.Rect(10, bodyY, 190, bodyH, "D")

	verified := strings.EqualFold(b.Status, "verified")
	if verified {
		drawStamp(pdf, 15, bodyY+4, 55, 20, "VERIFIED", 22, 163, 74)
	} else {
		drawStamp(pdf, 15, bodyY+4, 65, 20, "NOT VERIFIED", 220, 38, 38)
	}

	// Right side — "via" summary + timestamp.
	irisPass := b.IrisScore.Valid && b.IrisScore.Float64 >= 50
	via := ""
	if verified {
		passed := []string{}
		if b.RequiresFace && b.FaceMatch { passed = append(passed, "Face") }
		if b.RequiresFP   && b.FpMatch   { passed = append(passed, "Fingerprint") }
		if b.RequiresIris && irisPass    { passed = append(passed, "Iris") }
		if len(passed) > 0 {
			via = strings.Join(passed, "  +  ")
		} else {
			via = "manually recorded"
		}
	} else {
		via = "biometric mismatch"
	}

	rightX := 90.0
	pdf.SetTextColor(100, 116, 139)
	pdf.SetFont("Helvetica", "", 8)
	pdf.SetXY(rightX, bodyY+6)
	pdf.CellFormat(60, 4, tr("Verified via"), "", 0, "L", false, 0, "")

	pdf.SetTextColor(15, 23, 42)
	pdf.SetFont("Helvetica", "B", 12)
	pdf.SetXY(rightX, bodyY+10)
	pdf.CellFormat(115, 5, tr(via), "", 0, "L", false, 0, "")

	pdf.SetTextColor(100, 116, 139)
	pdf.SetFont("Helvetica", "", 8)
	pdf.SetXY(rightX, bodyY+18)
	pdf.CellFormat(60, 4, tr("Recorded at"), "", 0, "L", false, 0, "")

	pdf.SetTextColor(15, 23, 42)
	pdf.SetFont("Helvetica", "B", 10)
	pdf.SetXY(rightX, bodyY+22)
	pdf.CellFormat(115, 5, tr(b.CreatedAt.In(indiaTZ).Format("02 Jan 2006  ·  15:04:05 IST")), "", 0, "L", false, 0, "")

	pdf.SetY(bodyY + bodyH + 3)
}

// drawStamp — tilted circular/oval double-border stamp. Not truly
// rotated (gofpdf's TransformRotate would work but is fragile with
// text placement) but visually communicates "stamp" via the
// double-ring + coloured text.
func drawStamp(pdf *gofpdf.Fpdf, x, y, w, h float64, text string, r, g, b int) {
	pdf.SetDrawColor(r, g, b)
	pdf.SetLineWidth(0.8)
	pdf.RoundedRect(x, y, w, h, 3, "1234", "D")
	pdf.SetLineWidth(0.3)
	pdf.RoundedRect(x+1.5, y+1.5, w-3, h-3, 2, "1234", "D")

	pdf.SetTextColor(r, g, b)
	pdf.SetFont("Helvetica", "B", 15)
	// Centre the text vertically + horizontally in the stamp box.
	pdf.SetXY(x, y+h/2-3)
	pdf.CellFormat(w, 6, tr(text), "", 0, "C", false, 0, "")
	pdf.SetTextColor(15, 23, 42)
}

// drawBiometricsTable — three-row table for the modality outcomes.
// Just PASSED / NOT PASSED per required modality, no scores, no
// thresholds. If the exam doesn't require a modality, its row is
// omitted (empty exams get a compact table).
func drawBiometricsTable(pdf *gofpdf.Fpdf, b *pdfBundle) {
	y := pdf.GetY()

	pdf.SetFillColor(248, 250, 252)
	pdf.Rect(10, y, 190, 5, "F")
	pdf.SetFillColor(220, 38, 38)
	pdf.Rect(10, y, 1.2, 5, "F")
	pdf.SetTextColor(51, 65, 85)
	pdf.SetFont("Helvetica", "B", 8)
	pdf.SetXY(13, y+0.5)
	pdf.CellFormat(190, 4, tr("BIOMETRIC VERIFICATION"), "", 0, "L", false, 0, "")

	// Collect rows dynamically.
	irisPass := b.IrisScore.Valid && b.IrisScore.Float64 >= 50
	rows := []struct{ label string; passed bool }{}
	if b.RequiresFace { rows = append(rows, struct{ label string; passed bool }{"Face recognition", b.FaceMatch}) }
	if b.RequiresFP   { rows = append(rows, struct{ label string; passed bool }{"Fingerprint match", b.FpMatch}) }
	if b.RequiresIris { rows = append(rows, struct{ label string; passed bool }{"Iris match", irisPass}) }

	bodyY := y + 5
	rowH := 7.0
	nRows := len(rows)
	if nRows == 0 {
		nRows = 1 // draw an empty note row so the box has structure
	}
	bodyH := float64(nRows) * rowH

	pdf.SetDrawColor(226, 232, 240)
	pdf.SetLineWidth(0.15)
	pdf.Rect(10, bodyY, 190, bodyH, "D")

	if len(rows) == 0 {
		pdf.SetFont("Helvetica", "I", 9)
		pdf.SetTextColor(100, 116, 139)
		pdf.SetXY(13, bodyY+2)
		pdf.CellFormat(184, 3, tr("no biometrics required for this exam"), "", 0, "L", false, 0, "")
		pdf.SetY(bodyY + bodyH + 3)
		return
	}

	// Column separator.
	pdf.Line(60, bodyY, 60, bodyY+bodyH)
	pdf.Line(150, bodyY, 150, bodyY+bodyH)

	// Column headers (bold, in the row-height space of a shadow row).
	// Instead of a separate header row, we put label + status + swatch.
	for i, r := range rows {
		ry := bodyY + float64(i)*rowH
		if i > 0 {
			pdf.Line(10, ry, 200, ry)
		}
		// Label
		pdf.SetXY(13, ry+1.6)
		pdf.SetFont("Helvetica", "B", 10)
		pdf.SetTextColor(15, 23, 42)
		pdf.CellFormat(45, 4, tr(r.label), "", 0, "L", false, 0, "")

		// Verdict word
		verdict := "NOT PASSED"
		vr, vg, vb := 220, 38, 38
		swatch := 220
		swG, swBl := 38, 38
		if r.passed {
			verdict = "PASSED"
			vr, vg, vb = 22, 163, 74
			swatch, swG, swBl = 22, 163, 74
		}
		pdf.SetTextColor(vr, vg, vb)
		pdf.SetFont("Helvetica", "B", 11)
		pdf.SetXY(63, ry+1.4)
		pdf.CellFormat(45, 4, tr(verdict), "", 0, "L", false, 0, "")

		// Coloured swatch on the right side of the row for visual scan.
		pdf.SetFillColor(swatch, swG, swBl)
		pdf.Rect(153, ry+2, 4, 3, "F")
		pdf.SetXY(160, ry+1.4)
		pdf.SetFont("Helvetica", "", 9)
		pdf.SetTextColor(71, 85, 105)
		note := "match confirmed"
		if !r.passed {
			note = "match failed"
		}
		pdf.CellFormat(40, 4, tr(note), "", 0, "L", false, 0, "")
	}

	pdf.SetTextColor(15, 23, 42)
	pdf.SetY(bodyY + bodyH + 3)
}

// drawRecordedByBlock — operator + device metadata in a slim strip.
func drawRecordedByBlock(pdf *gofpdf.Fpdf, b *pdfBundle) {
	y := pdf.GetY()
	pdf.SetFillColor(248, 250, 252)
	pdf.Rect(10, y, 190, 5, "F")
	pdf.SetFillColor(220, 38, 38)
	pdf.Rect(10, y, 1.2, 5, "F")
	pdf.SetTextColor(51, 65, 85)
	pdf.SetFont("Helvetica", "B", 8)
	pdf.SetXY(13, y+0.5)
	pdf.CellFormat(190, 4, tr("RECORDED BY"), "", 0, "L", false, 0, "")

	bodyY := y + 5
	bodyH := 10.0
	pdf.SetDrawColor(226, 232, 240)
	pdf.SetLineWidth(0.15)
	pdf.Rect(10, bodyY, 190, bodyH, "D")

	op := nullstr(b.OperatorName)
	if op == "" {
		op = "—"
	}
	device := strings.TrimSpace(strings.Join(filterEmpty(
		nullstr(b.FpVendor), nullstr(b.DeviceModel), nullstr(b.DeviceSerial),
	), "  ·  "))
	if device == "" {
		device = "no device metadata"
	}
	pdf.SetTextColor(100, 116, 139)
	pdf.SetFont("Helvetica", "", 8)
	pdf.SetXY(13, bodyY+1.5)
	pdf.CellFormat(90, 4, tr("Operator"), "", 0, "L", false, 0, "")
	pdf.SetXY(105, bodyY+1.5)
	pdf.CellFormat(90, 4, tr("Capture device"), "", 0, "L", false, 0, "")

	pdf.SetTextColor(15, 23, 42)
	pdf.SetFont("Helvetica", "B", 10)
	pdf.SetXY(13, bodyY+5)
	pdf.CellFormat(90, 4, tr(op), "", 0, "L", false, 0, "")
	pdf.SetXY(105, bodyY+5)
	pdf.CellFormat(90, 4, tr(device), "", 0, "L", false, 0, "")

	pdf.SetY(bodyY + bodyH + 4)
}

// drawSignatureBlock — the two/three signature lines at the bottom
// that finalise the admit-card feel. Empty lines the invigilator +
// candidate can wet-sign if the receipt is printed.
func drawSignatureBlock(pdf *gofpdf.Fpdf) {
	// Position 8mm above the footer so the block sits at the bottom.
	y := 265.0

	pdf.SetDrawColor(15, 23, 42)
	pdf.SetLineWidth(0.3)

	// Three signature lines: candidate, invigilator, superintendent.
	const gap = 62.0
	xs := []float64{15.0, 15 + gap, 15 + 2*gap}
	labels := []string{"Signature of candidate", "Signature of invigilator", "Signature of centre superintendent"}
	for i, x := range xs {
		pdf.Line(x, y, x+55, y)
		pdf.SetXY(x, y+1)
		pdf.SetFont("Helvetica", "", 7)
		pdf.SetTextColor(71, 85, 105)
		pdf.CellFormat(55, 3, tr(labels[i]), "", 0, "C", false, 0, "")
	}
	pdf.SetTextColor(15, 23, 42)
}

// formatDOB — "20 Jun 2005" from "2005-06-20" (or fall through).
func formatDOB(s string) string {
	s = dateOnly(s)
	if s == "" {
		return ""
	}
	if t, err := time.Parse("2006-01-02", s); err == nil {
		return t.Format("02 Jan 2006")
	}
	return s
}

// formatGender — expand single-letter codes.
func formatGender(s string) string {
	switch strings.ToUpper(strings.TrimSpace(s)) {
	case "M":
		return "Male"
	case "F":
		return "Female"
	case "O":
		return "Other"
	default:
		return s
	}
}

// filterEmpty drops empty / whitespace-only strings from the list.
func filterEmpty(items ...string) []string {
	out := make([]string, 0, len(items))
	for _, s := range items {
		if strings.TrimSpace(s) != "" {
			out = append(out, s)
		}
	}
	return out
}

// ── small helpers ─────────────────────────────────────────────────────

func nullstr(n sql.NullString) string {
	if !n.Valid {
		return ""
	}
	return n.String
}

// dateOnly trims SQLite's ISO-8601 suffix off a DATE-typed value.
// SQLite returns "2005-04-12T00:00:00Z" for a column declared DATE
// when it was written via time.Time, but "2005-04-12" when written
// as a bare string. We handle both by clipping at "T" if present.
func dateOnly(s string) string {
	if i := strings.IndexByte(s, 'T'); i >= 0 {
		return s[:i]
	}
	return s
}
func fmtFloat(n sql.NullFloat64) string {
	if !n.Valid {
		return "—"
	}
	return fmt.Sprintf("%.4f", n.Float64)
}
func fmtInt(n sql.NullInt64) string {
	if !n.Valid {
		return "—"
	}
	return strconv.FormatInt(n.Int64, 10)
}

// The match_threshold column is used by both face and fp on different
// numeric scales. isFace=true → interpret as 0..1 float (face is
// typically 0.80 or so). Otherwise render as an integer (SourceAFIS
// threshold 40, Mantra 60 etc.).
func fmtIntThreshold(n sql.NullInt64, isFace bool) string {
	if !n.Valid {
		return "—"
	}
	if isFace {
		// Face thresholds land on the row as integer basis-points
		// historically; if you ever store 80 for 0.80 this shows 0.80.
		v := float64(n.Int64)
		if v > 1 {
			v = v / 100.0
		}
		return fmt.Sprintf("%.2f", v)
	}
	return strconv.FormatInt(n.Int64, 10)
}
func passFail(b bool) string {
	if b {
		return "PASS"
	}
	return "FAIL"
}
func capitalise(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "—"
	}
	return strings.ToUpper(s[:1]) + s[1:]
}
