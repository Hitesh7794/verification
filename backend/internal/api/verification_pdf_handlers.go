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
	pdf.SetMargins(15, 15, 15)
	pdf.SetAutoPageBreak(false, 15)
	// gofpdf ships built-in font descriptor files for the 14 standard
	// PDF fonts. An empty first arg picks the default (cp1252) one.
	pdfTR = pdf.UnicodeTranslatorFromDescriptor("")
	pdf.AddPage()

	drawHeaderBand(pdf, b)
	drawPhotosAndDetails(pdf, b, galleryPath, probePath)
	drawResultBlock(pdf, b)
	drawCentreAndFooter(pdf, b)

	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func drawHeaderBand(pdf *gofpdf.Fpdf, b *pdfBundle) {
	pdf.SetFillColor(30, 41, 82) // deep indigo
	pdf.Rect(0, 0, 210, 22, "F")

	pdf.SetTextColor(255, 255, 255)
	pdf.SetFont("Helvetica", "B", 14)
	pdf.SetXY(15, 6)
	title := strings.TrimSpace(b.ClientName)
	if b.ExamCode != "" {
		if title != "" {
			title += "  •  " + b.ExamCode
		} else {
			title = b.ExamCode
		}
	}
	if title == "" {
		title = "Verification"
	}
	pdf.CellFormat(120, 6, tr(title), "", 0, "L", false, 0, "")

	pdf.SetFont("Helvetica", "", 10)
	pdf.SetXY(15, 13)
	sub := strings.TrimSpace(b.ExamName)
	pdf.CellFormat(120, 5, tr(sub), "", 0, "L", false, 0, "")

	pdf.SetFont("Helvetica", "B", 11)
	pdf.SetXY(140, 9)
	pdf.CellFormat(55, 6, tr("VERIFICATION RECEIPT"), "", 0, "R", false, 0, "")

	pdf.SetTextColor(15, 23, 42)
	pdf.SetY(28)
}

func drawPhotosAndDetails(pdf *gofpdf.Fpdf, b *pdfBundle, galleryPath, probePath string) {
	// Two 40x40 mm photo slots on the left, details on the right.
	const (
		leftX     = 15.0
		photoY1   = 30.0
		photoY2   = 75.0
		photoSize = 40.0
		detailX   = 65.0
		detailW   = 130.0
	)

	drawPhotoSlot(pdf, leftX, photoY1, photoSize, "Gallery photo", galleryPath)
	drawPhotoSlot(pdf, leftX, photoY2, photoSize, "Captured (today)", probePath)

	pdf.SetTextColor(15, 23, 42)
	y := photoY1
	pdf.SetXY(detailX, y)
	pdf.SetFont("Helvetica", "B", 9)
	pdf.SetTextColor(100, 116, 139)
	pdf.CellFormat(detailW, 5, tr("CANDIDATE"), "", 2, "L", false, 0, "")

	pdf.SetTextColor(15, 23, 42)
	labelValue := []struct{ label, value string }{
		{"Name", b.CandName},
		{"Roll no.", b.RollNo},
		{"Registration ID", nullstr(b.RegistrationID)},
		{"Father's name", nullstr(b.FatherName)},
		{"DOB / Gender", strings.TrimSpace(dateOnly(nullstr(b.DOB)) + "  " + nullstr(b.Gender))},
		{"Shift", nullstr(b.ShiftName)},
	}
	for _, r := range labelValue {
		if strings.TrimSpace(r.value) == "" {
			r.value = "—"
		}
		pdf.SetX(detailX)
		pdf.SetFont("Helvetica", "", 9)
		pdf.SetTextColor(100, 116, 139)
		pdf.CellFormat(35, 6, tr(r.label), "", 0, "L", false, 0, "")
		pdf.SetTextColor(15, 23, 42)
		pdf.SetFont("Helvetica", "B", 10)
		pdf.CellFormat(detailW-35, 6, tr(r.value), "", 2, "L", false, 0, "")
	}
	pdf.SetY(photoY2 + photoSize + 6)
}

func drawPhotoSlot(pdf *gofpdf.Fpdf, x, y, size float64, caption, path string) {
	pdf.SetDrawColor(203, 213, 225)
	pdf.SetLineWidth(0.3)
	pdf.Rect(x, y, size, size, "D")

	if path != "" {
		tp := ""
		lower := strings.ToLower(path)
		switch {
		case strings.HasSuffix(lower, ".png"):
			tp = "PNG"
		default:
			tp = "JPG"
		}
		pdf.ImageOptions(path, x+0.5, y+0.5, size-1, size-1, false,
			gofpdf.ImageOptions{ImageType: tp, ReadDpi: false}, 0, "")
	} else {
		pdf.SetFont("Helvetica", "I", 8)
		pdf.SetTextColor(148, 163, 184)
		pdf.SetXY(x, y+size/2-2)
		pdf.CellFormat(size, 4, tr("(not available)"), "", 0, "C", false, 0, "")
	}

	pdf.SetFont("Helvetica", "", 7)
	pdf.SetTextColor(100, 116, 139)
	pdf.SetXY(x, y+size+1)
	pdf.CellFormat(size, 3, tr(caption), "", 0, "C", false, 0, "")
}

func drawResultBlock(pdf *gofpdf.Fpdf, b *pdfBundle) {
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

func drawCentreAndFooter(pdf *gofpdf.Fpdf, b *pdfBundle) {
	y := pdf.GetY() + 4
	pdf.SetDrawColor(226, 232, 240)
	pdf.Line(15, y, 195, y)
	pdf.SetY(y + 4)

	pdf.SetX(15)
	pdf.SetFont("Helvetica", "B", 9)
	pdf.SetTextColor(100, 116, 139)
	pdf.CellFormat(180, 5, tr("CENTRE"), "", 2, "L", false, 0, "")

	pdf.SetTextColor(15, 23, 42)
	pdf.SetFont("Helvetica", "B", 10)
	pdf.SetX(15)
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
	if line == "" {
		line = "—"
	}
	pdf.CellFormat(180, 5, tr(line), "", 2, "L", false, 0, "")

	// Address on next line.
	addr := strings.TrimSpace(nullstr(b.Address))
	locality := strings.TrimSpace(
		strings.TrimSpace(nullstr(b.City)) + " " + strings.TrimSpace(nullstr(b.State)) +
			" " + strings.TrimSpace(nullstr(b.Pincode)))
	pdf.SetFont("Helvetica", "", 9)
	pdf.SetTextColor(100, 116, 139)
	if addr != "" {
		pdf.SetX(15)
		pdf.CellFormat(180, 4.5, tr(addr), "", 2, "L", false, 0, "")
	}
	if locality != "" {
		pdf.SetX(15)
		pdf.CellFormat(180, 4.5, tr(locality), "", 2, "L", false, 0, "")
	}

	// Footer.
	pdf.SetY(275)
	pdf.SetX(15)
	pdf.SetFont("Helvetica", "", 8)
	pdf.SetTextColor(148, 163, 184)
	footer := fmt.Sprintf("Verification ID: %d    Generated %s IST",
		b.VerificationID, time.Now().In(indiaTZ).Format("2006-01-02 15:04:05"))
	pdf.CellFormat(180, 4, tr(footer), "", 0, "L", false, 0, "")
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
