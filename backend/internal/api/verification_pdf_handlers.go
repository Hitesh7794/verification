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
		 WHERE v.id = $1`
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
	pdf.SetMargins(0, 0, 0)
	pdf.SetAutoPageBreak(false, 0)
	pdfTR = pdf.UnicodeTranslatorFromDescriptor("")
	pdf.AddPage()

	// Admit-card layout: outer page border, clean centered header,
	// title strip, boxed grid with photo panel on the right, per-
	// modality biometric pass/fail rows, verdict summary strip, and
	// a "biometrically verified by" footer.
	drawPageBorder(pdf)
	drawAdmitHeader(pdf, b)
	drawAdmitTitleStrip(pdf, b)
	bottomY := drawAdmitBody(pdf, b, galleryPath, probePath)
	drawAdmitFooter(pdf, b, bottomY+4)

	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// drawPageBorder — a single thick slate frame around the whole A4
// page. One bold line, no inner hairline. Gives the slip a solid
// framed-certificate presence without doubling.
func drawPageBorder(pdf *gofpdf.Fpdf) {
	pdf.SetDrawColor(15, 23, 42)
	pdf.SetLineWidth(1.2)
	pdf.Rect(6, 6, 198, 285, "D")
}

// ── v3 renderer (UPTET-style admit card, English-only) ───────────────

// drawAdmitTopBar — thin red-bordered notice band. UPTET reference uses
// this for "e-KYC required at exam centre"; we use it for the verified /
// failed outcome (green tint for pass, red tint for fail).
func drawAdmitHeader(pdf *gofpdf.Fpdf, b *pdfBundle) {
	const (
		y = 10.0
		h = 24.0
	)
	// Outer border only
	pdf.SetDrawColor(15, 23, 42)
	pdf.SetLineWidth(0.4)
	pdf.Rect(8, y, 194, h, "D")

	client := strings.ToUpper(strings.TrimSpace(b.ClientName))
	if client == "" {
		client = "PORTAL"
	}

	// Client name centered -- Times Bold for a formal official-document feel.
	pdf.SetFont("Times", "B", 22)
	pdf.SetTextColor(15, 23, 42)
	pdf.SetXY(8, y+4)
	pdf.CellFormat(194, 8, tr(client), "", 0, "C", false, 0, "")

	// Subtitle centered underneath.
	pdf.SetFont("Times", "", 12)
	pdf.SetTextColor(71, 85, 105)
	pdf.SetXY(8, y+14)
	pdf.CellFormat(194, 6, tr("Biometric Verification Authority"), "", 0, "C", false, 0, "")

	pdf.SetTextColor(15, 23, 42)
}

// drawAdmitTitleStrip — bold centred title + subtitle underneath. Times
// serif for gravitas.
func drawAdmitTitleStrip(pdf *gofpdf.Fpdf, b *pdfBundle) {
	const y = 38.0
	pdf.SetTextColor(15, 23, 42)
	pdf.SetFont("Times", "B", 16)
	pdf.SetXY(8, y)
	title := fmt.Sprintf("Biometric Verification Slip - %s", strings.TrimSpace(b.ExamCode))
	pdf.CellFormat(194, 7, tr(title), "", 0, "C", false, 0, "")

	pdf.SetFont("Times", "", 12)
	pdf.SetTextColor(71, 85, 105)
	pdf.SetXY(8, y+8)
	sub := strings.TrimSpace(b.ExamName)
	if sub == "" {
		sub = "Post-verification receipt"
	}
	pdf.CellFormat(194, 6, tr(sub), "", 0, "C", false, 0, "")
	pdf.SetTextColor(15, 23, 42)
}

// drawAdmitBody — the boxed grid. Two sections stacked: Candidate
// Personal Details + Examination/Centre Details. Right panel spans both
// for the two photo slots + operator signature. Returns bottom Y.
func drawAdmitBody(pdf *gofpdf.Fpdf, b *pdfBundle, galleryPath, probePath string) float64 {
	top := 56.0
	// Grid geometry: outer rect 194 wide split at 148 (left cells) and
	// 46 (right photo column). Cells inside the left area are 74 wide
	// paired horizontally. Cell height bumped so bigger fonts fit
	// without cramping label + value.
	const (
		x0       = 8.0
		width    = 194.0
		leftW    = 148.0
		leftCol  = 74.0
		cellH    = 14.0
	)

	// Section 1 title strip.
	drawSectionStrip(pdf, x0, top, width, "Candidate's Personal Details")
	rowY := top + 8

	fields1 := [][2]string{
		{"Registration ID", nullstr(b.RegistrationID)},
		{"Roll Number",     b.RollNo},
		{"Candidate's Name", b.CandName},
		{"Date of Birth",   formatDOB(nullstr(b.DOB))},
		{"Father's Name",   nullstr(b.FatherName)},
		{"Gender",          formatGender(nullstr(b.Gender))},
	}
	rowY = drawGridPairs(pdf, x0, rowY, leftW, cellH, fields1)

	// Section 2 title strip.
	drawSectionStrip(pdf, x0, rowY, width, "Examination Centre Details")
	rowY += 8

	centreLine := nullstr(b.CentreName)
	code := nullstr(b.CentreCode)
	addr := strings.TrimSpace(nullstr(b.Address))
	locality := strings.TrimSpace(nullstr(b.City) + ", " + nullstr(b.State) + " " + nullstr(b.Pincode))
	locality = strings.TrimSpace(strings.Trim(locality, ", "))
	fields2 := [][2]string{
		{"Centre Code",   code},
		{"Exam Code",     b.ExamCode},
		{"Centre Name",   centreLine},
		{"Exam Name",     b.ExamName},
		{"Centre Address", addr + ifNonEmpty(", ", locality)},
		{"Verified At",   b.CreatedAt.In(indiaTZ).Format("02 Jan 2006 · 15:04 IST")},
	}
	rowY = drawGridPairs(pdf, x0, rowY, leftW, cellH, fields2)

	// Right-side photo panel spans the whole body. Header strip on top,
	// then two photo slots stacked.
	rightX := x0 + leftW
	rightW := width - leftW
	panelBottom := rowY
	drawRightPhotoPanel(pdf, rightX, top, rightW, panelBottom-top, galleryPath, probePath)

	// Per-modality biometric result section (only for required modalities).
	rowY += 3
	rowY = drawBiometricDetailsSection(pdf, b, x0, rowY, width)

	// Overall verdict banner.
	rowY += 3
	rowY = drawBiometricSummaryStrip(pdf, b, x0, rowY, width)

	return rowY
}

// drawBiometricDetailsSection — the per-modality PASSED / NOT PASSED
// rows. One row per required modality, coloured verdict on the right,
// small caps label on the left.
func drawBiometricDetailsSection(pdf *gofpdf.Fpdf, b *pdfBundle, x, y, w float64) float64 {
	drawSectionStrip(pdf, x, y, w, "Biometric Modality Results")
	y += 8

	irisPass := b.IrisScore.Valid && b.IrisScore.Float64 >= 50
	rows := []struct {
		label   string
		passed  bool
		present bool
	}{
		{"Face Recognition",  b.FaceMatch, b.RequiresFace},
		{"Fingerprint Match", b.FpMatch,   b.RequiresFP},
		{"Iris Match",        irisPass,    b.RequiresIris},
	}

	rowH := 10.0
	visibleRows := 0
	for _, r := range rows {
		if r.present {
			visibleRows++
		}
	}
	if visibleRows == 0 {
		visibleRows = 1
	}

	// Outer border for the whole details block.
	pdf.SetDrawColor(15, 23, 42)
	pdf.SetLineWidth(0.3)
	pdf.Rect(x, y, w, rowH*float64(visibleRows), "D")

	cur := y
	first := true
	for _, r := range rows {
		if !r.present {
			continue
		}
		if !first {
			// Row divider
			pdf.SetDrawColor(203, 213, 225)
			pdf.SetLineWidth(0.2)
			pdf.Line(x, cur, x+w, cur)
		}
		first = false

		// Left: label
		pdf.SetTextColor(15, 23, 42)
		pdf.SetFont("Helvetica", "B", 12)
		pdf.SetXY(x+4, cur+2.5)
		pdf.CellFormat(w-60, 5, tr(r.label), "", 0, "L", false, 0, "")

		// Right: coloured verdict pill area
		verdict := "PASSED"
		fillR, fillG, fillB := 220, 252, 231 // emerald-100
		textR, textG, textB := 21, 128, 61   // emerald-700
		borderR, borderG, borderB := 34, 197, 94 // emerald-500
		if !r.passed {
			verdict = "NOT PASSED"
			fillR, fillG, fillB = 254, 226, 226 // red-100
			textR, textG, textB = 153, 27, 27   // red-800
			borderR, borderG, borderB = 239, 68, 68 // red-500
		}
		pillW := 40.0
		pillH := 6.5
		pillX := x + w - pillW - 4
		pillY := cur + (rowH-pillH)/2
		pdf.SetFillColor(fillR, fillG, fillB)
		pdf.SetDrawColor(borderR, borderG, borderB)
		pdf.SetLineWidth(0.3)
		pdf.RoundedRect(pillX, pillY, pillW, pillH, 1.5, "1234", "FD")
		pdf.SetTextColor(textR, textG, textB)
		pdf.SetFont("Helvetica", "B", 11)
		pdf.SetXY(pillX, pillY+0.9)
		pdf.CellFormat(pillW, 5, tr(verdict), "", 0, "C", false, 0, "")

		cur += rowH
	}

	if visibleRows == 1 && rows[0].present == false && rows[1].present == false && rows[2].present == false {
		// Empty state (no required modalities -- edge case).
		pdf.SetFont("Helvetica", "I", 10)
		pdf.SetTextColor(148, 163, 184)
		pdf.SetXY(x+4, y+2.5)
		pdf.CellFormat(w-8, 5, tr("No biometric modalities required for this exam."), "", 0, "L", false, 0, "")
	}

	pdf.SetTextColor(15, 23, 42)
	return y + rowH*float64(visibleRows)
}

func ifNonEmpty(sep, s string) string {
	if s == "" { return "" }
	return sep + s
}

func drawSectionStrip(pdf *gofpdf.Fpdf, x, y, w float64, title string) {
	pdf.SetFillColor(226, 232, 240)  // slate-200
	pdf.SetDrawColor(15, 23, 42)
	pdf.SetLineWidth(0.3)
	pdf.Rect(x, y, w, 8, "FD")
	pdf.SetTextColor(15, 23, 42)
	pdf.SetFont("Times", "B", 12)
	pdf.SetXY(x+3, y+1.8)
	pdf.CellFormat(w-6, 5, tr(title), "", 0, "L", false, 0, "")
}

// drawGridPairs renders a 2-column grid of label/value pairs, each in
// its own bordered cell (label bold top, value below). Returns bottom Y.
func drawGridPairs(pdf *gofpdf.Fpdf, x, y, w, cellH float64, pairs [][2]string) float64 {
	colW := w / 2
	pdf.SetDrawColor(15, 23, 42)
	pdf.SetLineWidth(0.3)
	for i := 0; i < len(pairs); i += 2 {
		// Left cell
		drawGridCell(pdf, x, y, colW, cellH, pairs[i][0], pairs[i][1])
		// Right cell (if exists)
		if i+1 < len(pairs) {
			drawGridCell(pdf, x+colW, y, colW, cellH, pairs[i+1][0], pairs[i+1][1])
		}
		y += cellH
	}
	return y
}

func drawGridCell(pdf *gofpdf.Fpdf, x, y, w, h float64, label, value string) {
	pdf.SetDrawColor(15, 23, 42)
	pdf.SetLineWidth(0.3)
	pdf.Rect(x, y, w, h, "D")

	// Label (bold small caps look) -- slate-500 muted grey.
	pdf.SetTextColor(100, 116, 139)
	pdf.SetFont("Helvetica", "B", 9.5)
	pdf.SetXY(x+2, y+1.6)
	pdf.CellFormat(w-4, 4, tr(label), "", 0, "L", false, 0, "")

	// Value (bold, bigger, dark) -- the emphasis.
	val := strings.TrimSpace(value)
	if val == "" { val = "-" }
	// Char budget approx: (w-4) mm / (12pt * 0.20 mm/char).
	maxChars := int((w - 4) / (12.0 * 0.19))
	if maxChars < 6 { maxChars = 6 }
	if len(val) > maxChars {
		val = val[:maxChars-1] + "-"
	}
	pdf.SetTextColor(15, 23, 42)
	pdf.SetFont("Helvetica", "B", 12)
	pdf.SetXY(x+2, y+7)
	pdf.CellFormat(w-4, 6, tr(val), "", 0, "L", false, 0, "")
}

// drawRightPhotoPanel — right column, spans the full body height,
// holds enrolled + captured photos stacked with a shared header.
// Slots share their internal border edge (single hairline separator
// between them) so there's no dead gap. Photos use center-crop fill
// so passport-style portraits fill their slot completely.
func drawRightPhotoPanel(pdf *gofpdf.Fpdf, x, y, w, h float64, galleryPath, probePath string) {
	const headerH = 7.0

	// Outer panel border.
	pdf.SetDrawColor(15, 23, 42)
	pdf.SetLineWidth(0.3)
	pdf.Rect(x, y, w, h, "D")

	// Header strip (filled slate).
	pdf.SetFillColor(226, 232, 240)
	pdf.Rect(x, y, w, headerH, "F")
	pdf.Line(x, y+headerH, x+w, y+headerH)
	pdf.SetTextColor(15, 23, 42)
	pdf.SetFont("Helvetica", "B", 11)
	pdf.SetXY(x, y+1.8)
	pdf.CellFormat(w, 4, tr("Photo & Capture"), "", 0, "C", false, 0, "")

	// Divide remaining vertical space in half exactly. No inset --
	// slots share the panel's outer border on their outer edges, and
	// the horizontal divider between them is the panel's own line.
	slotH := (h - headerH) / 2
	slot1Y := y + headerH
	slot2Y := slot1Y + slotH

	// Single-line divider between the two slots.
	drawInsetPhoto(pdf, x, slot1Y, w, slotH, "ENROLLED", galleryPath)
	drawInsetPhoto(pdf, x, slot2Y, w, slotH, "CAPTURED", probePath)

	// Redraw the horizontal divider crisply between the slots
	// (drawInsetPhoto's own bottom border for slot 1 already handles it).
}

// drawInsetPhoto renders one photo slot: bordered box + image
// (center-crop fill, clipped to the photo area) + a labeled caption
// strip at the bottom. Center-crop = the image is scaled UP so it
// covers the whole photo area, then any overflow is clipped by the
// PDF clip path. This is what web `object-fit: cover` does; it means
// portrait photos in a landscape slot show a portrait-oriented crop
// with no empty side margins.
func drawInsetPhoto(pdf *gofpdf.Fpdf, x, y, w, h float64, caption, path string) {
	const captionH = 5.5

	// Outer border of the whole slot.
	pdf.SetDrawColor(15, 23, 42)
	pdf.SetLineWidth(0.3)
	pdf.Rect(x, y, w, h, "D")

	// Photo area = slot minus the caption strip.
	imgAreaX := x
	imgAreaY := y
	imgAreaW := w
	imgAreaH := h - captionH

	if path != "" {
		tp := "JPG"
		if strings.HasSuffix(strings.ToLower(path), ".png") {
			tp = "PNG"
		}
		info := pdf.RegisterImageOptions(path,
			gofpdf.ImageOptions{ImageType: tp, ReadDpi: false})
		if info != nil {
			natW := info.Width()
			natH := info.Height()
			// Center-crop fill: pick the LARGER scale so the image
			// covers the whole area, and let the clip rect chop the
			// overflow. This eliminates letterbox bars.
			scale := imgAreaW / natW
			if natH*scale < imgAreaH {
				scale = imgAreaH / natH
			}
			drawW := natW * scale
			drawH := natH * scale
			// Center the (potentially larger) image inside the slot.
			drawX := imgAreaX + (imgAreaW-drawW)/2
			drawY := imgAreaY + (imgAreaH-drawH)/2
			// Clip to the photo area so overflow doesn't spill out.
			pdf.ClipRect(imgAreaX, imgAreaY, imgAreaW, imgAreaH, false)
			pdf.ImageOptions(path, drawX, drawY, drawW, drawH, false,
				gofpdf.ImageOptions{ImageType: tp, ReadDpi: false}, 0, "")
			pdf.ClipEnd()
		}
	} else {
		pdf.SetFont("Helvetica", "I", 10)
		pdf.SetTextColor(148, 163, 184)
		pdf.SetXY(x, imgAreaY+imgAreaH/2-2)
		pdf.CellFormat(w, 4, tr("[no photo]"), "", 0, "C", false, 0, "")
	}

	// Caption strip at the bottom of the slot.
	pdf.SetFillColor(226, 232, 240)
	pdf.Rect(x, y+h-captionH, w, captionH, "F")
	pdf.SetTextColor(15, 23, 42)
	pdf.SetFont("Helvetica", "B", 9)
	pdf.SetXY(x, y+h-captionH+0.9)
	pdf.CellFormat(w, 3, tr(caption), "", 0, "C", false, 0, "")
}

// drawBiometricSummaryStrip — bordered box replacing the reference's
// bilingual "instructions" paragraph. Reads:
//   "Biometric verification recorded via Face + Fingerprint + Iris on <TS>.
//    Match confirmed. This is an official electronically-generated slip."
func drawBiometricSummaryStrip(pdf *gofpdf.Fpdf, b *pdfBundle, x, y, w float64) float64 {
	verified := strings.EqualFold(b.Status, "verified")
	irisPass := b.IrisScore.Valid && b.IrisScore.Float64 >= 50
	passed := []string{}
	if b.RequiresFace && b.FaceMatch { passed = append(passed, "Face") }
	if b.RequiresFP   && b.FpMatch   { passed = append(passed, "Fingerprint") }
	if b.RequiresIris && irisPass    { passed = append(passed, "Iris") }
	via := "manual override"
	if len(passed) > 0 {
		via = strings.Join(passed, " + ")
	}
	ts := b.CreatedAt.In(indiaTZ).Format("02 Jan 2006 at 15:04 IST")

	h := 22.0

	// Full-width light-green (or light-red) background fill instead of
	// a side stripe. Border in the same darker tone so the box has an
	// unambiguous identity as pass/fail.
	if verified {
		pdf.SetFillColor(220, 252, 231) // emerald-100 background
		pdf.SetDrawColor(22, 163, 74)   // emerald-600 border
	} else {
		pdf.SetFillColor(254, 226, 226) // red-100 background
		pdf.SetDrawColor(220, 38, 38)   // red-600 border
	}
	pdf.SetLineWidth(0.3)
	pdf.Rect(x, y, w, h, "FD")

	// Heading (Times bold for gravitas).
	if verified {
		pdf.SetTextColor(21, 128, 61) // emerald-700
	} else {
		pdf.SetTextColor(153, 27, 27) // red-800
	}
	pdf.SetFont("Times", "B", 14)
	pdf.SetXY(x+3, y+2.5)
	head := "BIOMETRIC MATCH CONFIRMED"
	if !verified {
		head = "BIOMETRIC MATCH FAILED"
	}
	pdf.CellFormat(w-6, 6, tr(head), "", 0, "L", false, 0, "")

	// Sentence.
	pdf.SetTextColor(15, 23, 42)
	pdf.SetFont("Helvetica", "B", 11)
	pdf.SetXY(x+3, y+10)
	verb := "recorded"
	if verified {
		verb = "successfully recorded"
	} else {
		verb = "attempted"
	}
	sentence := fmt.Sprintf("Verification %s via %s on %s.", verb, via, ts)
	pdf.CellFormat(w-6, 5, tr(sentence), "", 0, "L", false, 0, "")

	// Small subtitle.
	pdf.SetTextColor(71, 85, 105)
	pdf.SetFont("Helvetica", "I", 9.5)
	pdf.SetXY(x+3, y+16)
	pdf.CellFormat(w-6, 4, tr("This is an official electronically-generated biometric verification slip."), "", 0, "L", false, 0, "")

	pdf.SetTextColor(15, 23, 42)
	return y + h
}

// drawAdmitFooter — instead of wet-signature boxes: one strip that
// names the operator + device + generation timestamp.
func drawAdmitFooter(pdf *gofpdf.Fpdf, b *pdfBundle, y float64) {
	x := 8.0
	w := 194.0
	h := 22.0
	pdf.SetDrawColor(15, 23, 42)
	pdf.SetLineWidth(0.3)
	pdf.Rect(x, y, w, h, "D")

	// Divider into 2 columns
	pdf.Line(x+w/2, y, x+w/2, y+h)

	// Left cell -- "Biometrically verified by"
	pdf.SetTextColor(100, 116, 139)
	pdf.SetFont("Times", "B", 10)
	pdf.SetXY(x+3, y+2)
	pdf.CellFormat(w/2-6, 5, tr("BIOMETRICALLY VERIFIED BY"), "", 0, "L", false, 0, "")
	op := nullstr(b.OperatorName)
	if op == "" { op = "-" }
	pdf.SetTextColor(15, 23, 42)
	pdf.SetFont("Helvetica", "B", 13)
	pdf.SetXY(x+3, y+9)
	pdf.CellFormat(w/2-6, 6, tr(op), "", 0, "L", false, 0, "")
	device := strings.TrimSpace(strings.Join(filterEmpty(
		nullstr(b.FpVendor), nullstr(b.DeviceModel), nullstr(b.DeviceSerial),
	), " - "))
	if device == "" { device = "no device metadata" }
	pdf.SetFont("Helvetica", "B", 10)
	pdf.SetTextColor(71, 85, 105)
	pdf.SetXY(x+3, y+16)
	pdf.CellFormat(w/2-6, 4, tr("Device: "+device), "", 0, "L", false, 0, "")

	// Right cell -- "Generated"
	pdf.SetTextColor(100, 116, 139)
	pdf.SetFont("Times", "B", 10)
	pdf.SetXY(x+w/2+3, y+2)
	pdf.CellFormat(w/2-6, 5, tr("DOCUMENT GENERATED"), "", 0, "L", false, 0, "")
	pdf.SetTextColor(15, 23, 42)
	pdf.SetFont("Helvetica", "B", 13)
	pdf.SetXY(x+w/2+3, y+9)
	pdf.CellFormat(w/2-6, 6, tr(time.Now().In(indiaTZ).Format("02 Jan 2006, 15:04 IST")), "", 0, "L", false, 0, "")
	pdf.SetFont("Helvetica", "B", 10)
	pdf.SetTextColor(71, 85, 105)
	pdf.SetXY(x+w/2+3, y+16)
	pdf.CellFormat(w/2-6, 4, tr(fmt.Sprintf("Verification ID: #%d", b.VerificationID)), "", 0, "L", false, 0, "")

	pdf.SetTextColor(15, 23, 42)
}

// ── v2 renderer (matches biometric_verification_slip_v2.pdf) ──────────

// drawHeaderBandV2 — navy band across the top edge with a rounded
// white pill on the left holding the client name abbreviation, the
// full client name in caps + exam-name subline centred over the band,
// and a "BIOMETRIC SLIP" rounded pill on the far right. Bottom of
// the band is a subtle indigo accent stripe.
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
