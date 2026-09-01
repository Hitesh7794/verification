package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/veni/neet-verification/internal/db"
)

// verificationPDF assembles a one-page A4 verification report and
// streams it as application/pdf.
//
//   GET /api/verifications/{id}/pdf
//
// Role scoping mirrors the history/list handlers:
//   client (operator)  → only verifications they themselves recorded
//   admin              → only rows in their org
//   superadmin / ops   → any row
//
// Rendering path: the record is serialized to JSON and handed to
// `backend/pdf-template/build_report.py` on disk (installed to
// /opt/verificationportal/pdf-template/ on prod). That Python
// script writes an HTML file, then invokes headless Chrome to print
// it to A4 PDF. Chrome + Python must be present on the host —
// see docs/deploy for the one-time install steps. The old in-process
// gofpdf renderer was replaced 2026-09-01 so the shipped design
// matches the reference sheet (slipfinalyash2.pdf) pixel-for-pixel.

// Locations of the Python builder + interpreter can be overridden via
// env for dev boxes; the defaults match the prod install path.
var (
	pdfBuilderScript = envOr("VERIFY_PDF_BUILDER",
		"/opt/verificationportal/pdf-template/build_report.py")
	pdfPythonBin = envOr("VERIFY_PDF_PYTHON", "python3")
	// PDF build takes 1.5–3s (Chrome cold start dominates); 15s is a
	// safety ceiling — an actual render never approaches it.
	pdfRenderTimeout = 15 * time.Second
)

func envOr(k, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return fallback
}

type pdfBundle struct {
	// verifications
	VerificationID int64
	Status         string
	Via            string
	FaceMatch      bool
	FpMatch        bool
	FaceMatchScore sql.NullFloat64
	FpMatchScore   sql.NullInt64
	IrisScore      sql.NullFloat64
	MatchThreshold sql.NullInt64
	// Per-exam biometric requirements (migration 022) — drive which
	// modality tiles appear in the biometric-summary block.
	RequiresFace   bool
	RequiresFP     bool
	RequiresIris   bool
	DeviceSerial   sql.NullString
	DeviceModel    sql.NullString
	FpVendor       sql.NullString
	CreatedAt      time.Time
	ProbePhotoPath sql.NullString
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
	case "superadmin":
		// no additional filter
	default:
		writeErr(w, http.StatusForbidden, "role not allowed")
		return
	}

	var b pdfBundle
	err = s.deps.DB.QueryRowContext(r.Context(), db.Q(query), args...).Scan(
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

	pdfBytes, err := renderVerificationPDF(r.Context(), &b, galleryPath, probePath)
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

// ── Renderer ─────────────────────────────────────────────────────────
//
// Shells out to the Python + Chrome pipeline. The Python builder reads
// the record from a JSON file, produces an HTML file with all assets
// inlined as data-URIs, then invokes headless Chrome with
// `--print-to-pdf`. We tempdir the whole run so concurrent requests
// don't collide on file names, and clean up on the way out.

var indiaTZ = func() *time.Location {
	if loc, err := time.LoadLocation("Asia/Kolkata"); err == nil {
		return loc
	}
	return time.FixedZone("IST", 5*3600+30*60)
}()

func renderVerificationPDF(ctx context.Context, b *pdfBundle, galleryPath, probePath string) ([]byte, error) {
	payload, err := json.Marshal(buildPDFPayload(b))
	if err != nil {
		return nil, fmt.Errorf("marshal payload: %w", err)
	}

	tmpDir, err := os.MkdirTemp("", "verify-pdf-*")
	if err != nil {
		return nil, fmt.Errorf("tempdir: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	dataFile := filepath.Join(tmpDir, "record.json")
	if err := os.WriteFile(dataFile, payload, 0o644); err != nil {
		return nil, fmt.Errorf("write payload: %w", err)
	}

	args := []string{pdfBuilderScript, "--pdf", "--data", dataFile, "--out", tmpDir}
	if galleryPath != "" {
		args = append(args, "--enrolled-photo", galleryPath)
	}
	if probePath != "" {
		args = append(args, "--probe-photo", probePath)
	}

	renderCtx, cancel := context.WithTimeout(ctx, pdfRenderTimeout)
	defer cancel()
	cmd := exec.CommandContext(renderCtx, pdfPythonBin, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("pdf builder: %v (stderr: %s)", err, strings.TrimSpace(stderr.String()))
	}

	// The builder names the file after the record's roll number, so
	// pick up whichever .pdf appeared in the tempdir.
	matches, _ := filepath.Glob(filepath.Join(tmpDir, "*.pdf"))
	if len(matches) == 0 {
		return nil, fmt.Errorf("pdf not produced (builder stderr: %s)", strings.TrimSpace(stderr.String()))
	}
	return os.ReadFile(matches[0])
}

// buildPDFPayload maps the DB-side pdfBundle into the constants the
// Python template expects (see the top block of build_report.py).
// Field names are the module-level constants there; list-of-lists
// stand in for Python's list-of-tuples. HTML entities are used in
// display strings the template already flows through unchanged.
func buildPDFPayload(b *pdfBundle) map[string]any {
	istT := b.CreatedAt.In(indiaTZ)
	verificationID := fmt.Sprintf("VER-%d", b.VerificationID)
	client := strings.TrimSpace(b.ClientName)
	if client == "" {
		client = "National Testing Agency"
	}
	exam := strings.TrimSpace(b.ExamName)
	if code := strings.TrimSpace(b.ExamCode); code != "" {
		if exam != "" {
			exam = exam + " (" + code + ")"
		} else {
			exam = code
		}
	}
	centreCode := strings.TrimSpace(nullstr(b.CentreCode))

	// META block (top-right on the masthead).
	meta := [][]any{
		{"Centre Code", firstNonEmpty(centreCode, "—")},
		{"Reference",   verificationID},
		{"Date",        istT.Format("02 January 2006")},
		{"Time",        istT.Format("15:04 IST")},
	}

	// ID block under the candidate name.
	genderDOB := formatGender(nullstr(b.Gender))
	dob := formatDOB(nullstr(b.DOB))
	switch {
	case genderDOB == "" && dob == "":
		genderDOB = "—"
	case genderDOB == "":
		genderDOB = dob
	case dob == "":
		// leave genderDOB alone
	default:
		genderDOB = genderDOB + "&ensp;|&ensp;" + dob
	}
	idFields := [][]any{
		{"Roll Number",                 firstNonEmpty(b.RollNo, "—")},
		{"Registration ID",             firstNonEmpty(nullstr(b.RegistrationID), "—")},
		{"Father&rsquo;s Name",         firstNonEmpty(nullstr(b.FatherName), "—")},
		{"Gender &amp; Date of Birth",  genderDOB},
	}

	// Address block below the two-column split.
	addr := strings.Join(filterEmpty(
		strings.TrimSpace(nullstr(b.Address)),
		strings.TrimSpace(nullstr(b.City)),
		strings.TrimSpace(nullstr(b.State)),
		strings.TrimSpace(nullstr(b.Pincode)),
	), ", ")
	placeFields := [][]any{
		{"Shift / Session",   firstNonEmpty(nullstr(b.ShiftName), "—")},
		{"Centre Name",       firstNonEmpty(nullstr(b.CentreName), "—")},
		{"Venue Address",     firstNonEmpty(addr, "—")},
		{"Verification Time", istT.Format("02 Jan 2006 at 15:04 IST")},
	}

	// Modality tiles — only include modalities the exam requires,
	// each carrying its own pass/fail flag.
	irisPass := b.IrisScore.Valid && b.IrisScore.Float64 >= 50
	device := strings.TrimSpace(strings.Join(filterEmpty(
		nullstr(b.FpVendor), nullstr(b.DeviceModel),
	), " "))
	if device == "" {
		device = "on-device capture"
	}
	modalities := [][]any{}
	if b.RequiresFace {
		modalities = append(modalities, []any{"Face", "—", "—", "TrustView Vision", b.FaceMatch})
	}
	if b.RequiresFP {
		modalities = append(modalities, []any{"Fingerprint", "—", "—", device, b.FpMatch})
	}
	if b.RequiresIris {
		modalities = append(modalities, []any{"Iris", "—", "—", "Mantra MIS100V2", irisPass})
	}

	// Verdict text — Matched for a verified row, Mismatch otherwise.
	verdict := "Matched"
	if !strings.EqualFold(b.Status, "verified") {
		verdict = "Mismatch"
	}

	sigs := [][]any{
		{"Candidate Signature", strings.TrimSpace(b.CandName),           "Signature of Candidate"},
		{"Biometric Operator",  strings.TrimSpace(nullstr(b.OperatorName)), "Operator Sign &amp; Stamp"},
		{"Centre Superintendent / Observer", "",                          "Official Seal &amp; Signature"},
	}

	footer := "Ref. " + verificationID
	if centreCode != "" {
		footer = "Centre " + centreCode + "&ensp;&middot;&ensp;" + footer
	}

	return map[string]any{
		"AUTHORITY":    client,
		"SYSTEM":       "Central Candidate Biometric Verification System",
		"DOCTITLE":     "Biometric Verification Report",
		"EXAM_NAME":    firstNonEmpty(exam, "—"),
		"META":         meta,
		"CAND_NAME":    firstNonEmpty(strings.TrimSpace(b.CandName), "—"),
		"ID_FIELDS":    idFields,
		"PLACE_FIELDS": placeFields,
		"MODALITIES":   modalities,
		"RESULT_LEAD":  "Final status: Biometric verification",
		"RESULT_WORD":  verdict,
		"SIGNATURES":   sigs,
		"FOOTER":       footer,
	}
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// ── small helpers ─────────────────────────────────────────────────────

func nullstr(n sql.NullString) string {
	if !n.Valid {
		return ""
	}
	return n.String
}

func dateOnly(s string) string {
	if i := strings.IndexByte(s, 'T'); i >= 0 {
		return s[:i]
	}
	return s
}

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

func filterEmpty(items ...string) []string {
	out := make([]string, 0, len(items))
	for _, s := range items {
		if strings.TrimSpace(s) != "" {
			out = append(out, s)
		}
	}
	return out
}
