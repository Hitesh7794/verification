package api

// Bulk zip upload for candidate biometrics. Superadmin picks one
// modality at a time (photos.zip, fp-templates.zip, iris.zip) and every
// entry inside the zip lands directly in S3 under the exam's
// per-modality prefix. No local-disk hop, no reindex.
//
// Raw fingerprint IMAGES (BMP/WSQ) used to be a fourth modality but
// were removed 2026-08-22 — the runtime only ever consumes the
// pre-extracted templates (fp-templates), so raw images were dead
// storage. Kept a note here so anyone finding "fp-images" in old logs
// knows why the modality vanished.
//
// Filename convention is STRICT: each entry must be exactly
//   <roll_no>.<ext>
// with the extension in the modality's allowlist. Anything else lands
// in the response's `skipped` list with a reason — we never guess a
// roll from a compound filename like "20002_L_thumb.iso".
//
// Errors don't fail the batch. The response always returns 200 with a
// per-file summary; the caller iterates the summary to render green /
// amber / red rows in the operator UI.

import (
	"archive/zip"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/veni/neet-verification/internal/db"
)

// modality is the flat enum the handlers switch on. One card in the UI
// maps to exactly one modality here.
type modality struct {
	name       string          // "photos" | "fp-templates" | "iris"
	dbFlag     string          // exam_candidates column to flip on success
	allowedExt map[string]bool // lowercase, dot-prefixed (".jpg", ".iso")
	mime       func(ext string) string
	keyFor     func(examCode, roll, ext string) string
}

// mimeFromExt is the default mime picker; each modality can override.
func mimeFromExt(ext string) string {
	switch strings.ToLower(ext) {
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".png":
		return "image/png"
	case ".bmp":
		return "image/bmp"
	default:
		return "application/octet-stream"
	}
}

var bulkModalities = map[string]modality{
	"photos": {
		name:       "photos",
		dbFlag:     "has_photo",
		allowedExt: map[string]bool{".jpg": true, ".jpeg": true, ".png": true},
		mime:       mimeFromExt,
		keyFor: func(examCode, roll, ext string) string {
			// Photos always land as .jpg — the runtime looks up
			// <exam>/photos/<roll>.jpg on face-match. Normalising
			// on the way in avoids operators wondering why 20002.png
			// isn't found when they uploaded 20002.png.
			return fmt.Sprintf("%s/photos/%s.jpg", safeSegmentForBulk(examCode), safeSegmentForBulk(roll))
		},
	},
	"fp-templates": {
		name:       "fp-templates",
		dbFlag:     "has_fp_template",
		allowedExt: map[string]bool{".iso": true, ".fmr": true, ".ansi": true, ".bin": true},
		mime:       mimeFromExt,
		keyFor: func(examCode, roll, ext string) string {
			return fmt.Sprintf("%s/fingerprints/templates/%s%s",
				safeSegmentForBulk(examCode), safeSegmentForBulk(roll), ext)
		},
	},
	"iris": {
		name:       "iris",
		dbFlag:     "has_iris",
		allowedExt: map[string]bool{".iso": true, ".k7": true, ".bmp": true, ".bin": true},
		mime:       mimeFromExt,
		keyFor: func(examCode, roll, ext string) string {
			return fmt.Sprintf("%s/iris/%s%s",
				safeSegmentForBulk(examCode), safeSegmentForBulk(roll), ext)
		},
	},
}

// bioBulkPerFileResult is one row of the per-file summary the UI
// paints as a green/amber/red table.
type bioBulkPerFileResult struct {
	Filename string `json:"filename"`
	Roll     string `json:"roll,omitempty"`
	Status   string `json:"status"` // "ok" | "skipped" | "error"
	Reason   string `json:"reason,omitempty"`
	Bytes    int64  `json:"bytes,omitempty"`
}

type bioBulkUploadResp struct {
	Modality string                    `json:"modality"`
	ExamCode string                    `json:"exam_code"`
	Total    int                       `json:"total"`
	Uploaded int                       `json:"uploaded"`
	Skipped  int                       `json:"skipped"`
	Errors   int                       `json:"errors"`
	PerFile  []bioBulkPerFileResult `json:"per_file"`
}

// Hard cap on the whole multipart body. 2 GB fits ~10,000 photos or
// ~1,000,000 fingerprint templates in one shot — well above any
// realistic single-exam volume. Above 2 GB the operator should split
// the zip; Caddy's request_body cap on this path is set to match.
//
// Ceilings to keep aligned when this changes:
//   1. Caddy: request_body @bulk_upload max_size in /etc/caddy/Caddyfile
//   2. Go:    this constant
//   3. chi:   the bulk path is exempted from the 30s Timeout middleware
//   4. XHR:   frontend timeout in lib/superadmin/examCatalog.js
const bulkUploadMaxBytes = 2 << 30 // 2 GB

// superadminBulkUpload handles POST /api/superadmin/exams/{id}/bulk/{modality}.
// Read-your-zip stream, no full extraction — we only ever hold one
// file's bytes in memory at a time.
func (s *Server) superadminBulkUpload(w http.ResponseWriter, r *http.Request) {
	if s.storage == nil || !s.storage.Enabled() {
		writeErr(w, http.StatusServiceUnavailable,
			"storage is not configured — set S3_BUCKET on this deployment")
		return
	}
	examID, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil || examID <= 0 {
		writeErr(w, http.StatusBadRequest, "bad exam id")
		return
	}
	modalityName := chi.URLParam(r, "modality")
	m, ok := bulkModalities[modalityName]
	if !ok {
		writeErr(w, http.StatusBadRequest,
			"unknown modality — must be one of photos, fp-templates, iris")
		return
	}

	// Exam scope + code lookup. We reject early if the exam doesn't
	// require the modality being uploaded so the operator doesn't
	// accidentally seed data the runtime won't use.
	var (
		examCode                       string
		reqFace, reqFp, reqIris        bool
	)
	err = s.deps.DB.QueryRowContext(r.Context(),
		db.Q(`SELECT exam_code, requires_face, requires_fp, requires_iris
		        FROM exams WHERE id = ?`),
		examID,
	).Scan(&examCode, &reqFace, &reqFp, &reqIris)
	if err != nil {
		writeErr(w, http.StatusNotFound, "exam not found")
		return
	}
	if err := bulkModalityAllowedForExam(m.name, reqFace, reqFp, reqIris); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	// Multipart parse. maxRequestSize on our upstream reverse-proxy is
	// already the outer ceiling; the ParseMultipartForm cap here
	// protects the process if that ever changes.
	r.Body = http.MaxBytesReader(w, r.Body, bulkUploadMaxBytes+1<<20)
	if err := r.ParseMultipartForm(64 << 20); err != nil {
		fmt.Fprintf(os.Stderr,
			"bulk upload: multipart parse failed modality=%s exam=%d: %v\n",
			modalityName, examID, err)
		writeErr(w, http.StatusBadRequest, "upload too large or malformed: "+err.Error())
		return
	}
	file, hdr, err := r.FormFile("file")
	if err != nil {
		fmt.Fprintf(os.Stderr,
			"bulk upload: file field missing modality=%s exam=%d: %v\n",
			modalityName, examID, err)
		writeErr(w, http.StatusBadRequest, "'file' field is required")
		return
	}
	defer file.Close()
	fmt.Fprintf(os.Stderr,
		"bulk upload: received modality=%s exam=%d filename=%q size=%d\n",
		modalityName, examID, hdr.Filename, hdr.Size)
	if !strings.HasSuffix(strings.ToLower(hdr.Filename), ".zip") {
		writeErr(w, http.StatusBadRequest,
			"expected a .zip archive; got "+hdr.Filename)
		return
	}

	// zip.NewReader needs an io.ReaderAt. multipart.File is an
	// io.ReaderAt only when the body was buffered to disk (over ~32
	// MB) — for smaller bodies it's in-memory and ReaderAt works too.
	// Both cases are handled by the io.ReaderAt interface below.
	ra, ok := file.(io.ReaderAt)
	if !ok {
		writeErr(w, http.StatusInternalServerError,
			"unexpected multipart file type (want io.ReaderAt)")
		return
	}
	zr, err := zip.NewReader(ra, hdr.Size)
	if err != nil {
		fmt.Fprintf(os.Stderr,
			"bulk upload: zip.NewReader failed modality=%s exam=%d filename=%q size=%d: %v\n",
			modalityName, examID, hdr.Filename, hdr.Size, err)
		writeErr(w, http.StatusBadRequest,
			"could not read zip archive: "+err.Error())
		return
	}

	// Pull the roll set for this exam into memory. Bulk operations
	// against 100k rolls: a set-membership check per file is O(1)
	// versus an SQL round-trip per file which would be tens of
	// seconds per 100 files.
	enrolled, err := s.loadEnrolledRolls(r.Context(), examID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError,
			"could not read enrolled rolls: "+err.Error())
		return
	}

	resp := bioBulkUploadResp{
		Modality: m.name,
		ExamCode: examCode,
		PerFile:  make([]bioBulkPerFileResult, 0, len(zr.File)),
	}

	// Files we actually flipped in DB — batch the UPDATE at the end
	// so we don't do a round-trip per entry.
	successfulRolls := make([]string, 0, len(zr.File))

	for _, ze := range zr.File {
		res := bioBulkPerFileResult{Filename: ze.Name}

		if ze.FileInfo().IsDir() {
			// Silently skip directory entries — some archivers add
			// them, but they're not meaningful data.
			continue
		}
		resp.Total++

		base := filepath.Base(ze.Name)
		roll, ext, ok := parseRollFilename(base)
		if !ok {
			res.Status = "skipped"
			res.Reason = "filename must be <roll>.<ext> — got " + base
			resp.Skipped++
			resp.PerFile = append(resp.PerFile, res)
			continue
		}
		res.Roll = roll

		if !m.allowedExt[ext] {
			res.Status = "skipped"
			res.Reason = "extension " + ext + " not allowed for " + m.name +
				" (allowed: " + joinSortedExt(m.allowedExt) + ")"
			resp.Skipped++
			resp.PerFile = append(resp.PerFile, res)
			continue
		}

		if !enrolled[roll] {
			res.Status = "skipped"
			res.Reason = "not enrolled in this exam — upload the CSV first"
			resp.Skipped++
			resp.PerFile = append(resp.PerFile, res)
			continue
		}

		// Read the entry — capped at 20 MB per file so a malicious
		// zip can't force us to allocate a gig for one entry. Real
		// photos + templates + iris frames are all comfortably under.
		rc, err := ze.Open()
		if err != nil {
			res.Status = "error"
			res.Reason = "zip open: " + err.Error()
			resp.Errors++
			resp.PerFile = append(resp.PerFile, res)
			continue
		}
		body, err := io.ReadAll(io.LimitReader(rc, 20<<20))
		rc.Close()
		if err != nil {
			res.Status = "error"
			res.Reason = "read: " + err.Error()
			resp.Errors++
			resp.PerFile = append(resp.PerFile, res)
			continue
		}
		if int64(len(body)) == 20<<20 {
			// We hit the cap — probably a truncated read. Refuse
			// rather than upload something that could crash the
			// downstream face-match / template loader.
			res.Status = "error"
			res.Reason = "entry exceeds 20 MB per-file limit"
			resp.Errors++
			resp.PerFile = append(resp.PerFile, res)
			continue
		}

		key := m.keyFor(examCode, roll, ext)
		putCtx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		err = s.storage.PutBiometric(putCtx, key, body, m.mime(ext))
		cancel()
		if err != nil {
			res.Status = "error"
			res.Reason = "s3 put: " + err.Error()
			resp.Errors++
			resp.PerFile = append(resp.PerFile, res)
			continue
		}

		res.Status = "ok"
		res.Bytes = int64(len(body))
		resp.Uploaded++
		successfulRolls = append(successfulRolls, roll)
		resp.PerFile = append(resp.PerFile, res)
	}

	// Update the in-memory Index so the very next operator lookup
	// sees the new flag without waiting for a restart. Skipping this
	// would cause the operator UI to say "no photo on file" for a
	// candidate we JUST uploaded — confusing and easy to miss.
	if len(successfulRolls) > 0 && s.deps.Index != nil {
		for _, roll := range successfulRolls {
			// Second positional arg (has_fp_image) is left false —
			// the fp-images modality was removed 2026-08-22.
			s.deps.Index.Upsert(roll,
				m.name == "photos",
				false,
				m.name == "fp-templates",
				m.name == "iris",
			)
		}
	}

	// Flip the DB flag for every roll we uploaded. Uses a single tx
	// so a mid-batch failure doesn't leave the flags half-set. Per-row
	// UPDATE is portable across drivers (no array param quirks) and
	// still fast: even 5,000 rolls run in a few hundred ms on the
	// loopback-latency Postgres we co-locate with the backend.
	if len(successfulRolls) > 0 {
		if err := s.flipCandidateFlag(r.Context(), examID, m.dbFlag, successfulRolls); err != nil {
			// Log-and-continue: the S3 objects exist, so the runtime
			// will fetch them on the next request even if the flag
			// stays stale. A subsequent upload for the same roll will
			// re-run the UPDATE.
			s.auditFromRequest(r, "bulk.upload.flag_update_failed",
				"exam", examID, map[string]any{
					"modality": m.name,
					"rolls":    len(successfulRolls),
					"error":    err.Error(),
				})
		}
	}

	s.auditFromRequest(r, "bulk.upload."+m.name,
		"exam", examID, map[string]any{
			"total":    resp.Total,
			"uploaded": resp.Uploaded,
			"skipped":  resp.Skipped,
			"errors":   resp.Errors,
		})

	writeJSON(w, http.StatusOK, resp)
}

// HydrateIndexFromDB overlays exam_candidates.has_* flags on top of
// the disk-scanned Index. Called once at server boot from cmd/server.
// After it runs, a candidate whose photo lives only in S3 (bulk
// upload path) will still report HasPhoto=true to the operator UI.
//
// Disk-scanned candidates that also have DB flags set: both stay true.
// Disk-only candidates whose DB flags default to false: disk wins
// (we only OR the DB row in, never AND).
func (s *Server) HydrateIndexFromDB(ctx context.Context) error {
	if s.deps.DB == nil || s.deps.Index == nil {
		return nil
	}
	rows, err := s.deps.DB.QueryContext(ctx,
		`SELECT roll_no, has_photo, has_fp_image, has_fp_template, has_iris
		   FROM exam_candidates
		  WHERE has_photo OR has_fp_image OR has_fp_template OR has_iris`)
	if err != nil {
		return err
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var (
			roll                              string
			hasPhoto, hasFpImg, hasFpTpl, hasIris bool
		)
		if err := rows.Scan(&roll, &hasPhoto, &hasFpImg, &hasFpTpl, &hasIris); err != nil {
			continue
		}
		s.deps.Index.Upsert(roll, hasPhoto, hasFpImg, hasFpTpl, hasIris)
		n++
	}
	return rows.Err()
}

// flipCandidateFlag sets the given boolean column to true for every
// (exam_id, roll_no) pair in the batch, inside one transaction. The
// column name is one of has_photo / has_fp_image / has_fp_template /
// has_iris — validated as a member of bulkModalities before we get
// here, so no SQL injection surface.
func (s *Server) flipCandidateFlag(ctx context.Context, examID int64, col string, rolls []string) error {
	tx, err := s.deps.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stmt, err := tx.PrepareContext(ctx,
		db.Q(`UPDATE exam_candidates SET `+col+` = true
		       WHERE exam_id = ? AND roll_no = ?`))
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, r := range rolls {
		if _, err := stmt.ExecContext(ctx, examID, r); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// loadEnrolledRolls returns a set of rolls currently in the
// exam_candidates table for this exam. Used by bulk upload to reject
// files whose roll isn't on the roster.
func (s *Server) loadEnrolledRolls(ctx context.Context, examID int64) (map[string]bool, error) {
	rows, err := s.deps.DB.QueryContext(ctx,
		db.Q(`SELECT roll_no FROM exam_candidates WHERE exam_id = ?`), examID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]bool, 4096)
	for rows.Next() {
		var r string
		if err := rows.Scan(&r); err != nil {
			continue
		}
		out[r] = true
	}
	return out, rows.Err()
}

// parseRollFilename splits "20002.jpg" into ("20002", ".jpg", true).
// Rejects filenames with no extension, all-extension (".hidden"), or
// any path separator (someone shipped "docs/20002.jpg" inside the
// zip — we take the basename above, so this is mostly defensive).
func parseRollFilename(base string) (roll, ext string, ok bool) {
	base = strings.TrimSpace(base)
	if base == "" || strings.ContainsAny(base, `/\`) {
		return "", "", false
	}
	ext = strings.ToLower(filepath.Ext(base))
	if ext == "" || ext == "." {
		return "", "", false
	}
	roll = strings.TrimSuffix(base, filepath.Ext(base)) // preserve original case for roll
	if roll == "" || roll == "." || roll == ".." {
		return "", "", false
	}
	return roll, ext, true
}

// joinSortedExt formats an allowlist map for human error messages.
// Sorted so the message is stable across runs.
func joinSortedExt(m map[string]bool) string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	// small allowlist, insertion-sort inline
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j-1] > out[j]; j-- {
			out[j-1], out[j] = out[j], out[j-1]
		}
	}
	return strings.Join(out, ", ")
}

// bulkModalityAllowedForExam refuses uploads for a modality the exam
// doesn't require. Photos are the only always-required modality.
func bulkModalityAllowedForExam(mod string, reqFace, reqFp, reqIris bool) error {
	switch mod {
	case "photos":
		if !reqFace {
			return fmt.Errorf(
				"this exam has requires_face=false; enable it in exam settings before uploading photos")
		}
	case "fp-templates":
		if !reqFp {
			return fmt.Errorf(
				"this exam has requires_fp=false; enable it in exam settings before uploading fingerprints")
		}
	case "iris":
		if !reqIris {
			return fmt.Errorf(
				"this exam has requires_iris=false; enable it in exam settings before uploading iris data")
		}
	}
	return nil
}

// safeSegmentForBulk mirrors storage.safeSegment. Duplicated here so
// this file compiles even before the storage package is imported —
// a small copy is safer than an import cycle if the layout of the
// key builder ever changes shape.
func safeSegmentForBulk(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "_"
	}
	s = strings.ReplaceAll(s, "/", "_")
	s = strings.ReplaceAll(s, "..", "_")
	return s
}

