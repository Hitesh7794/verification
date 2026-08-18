package api

// Superadmin biometric-upload endpoints.
//
// The current data-load story splits into two pipelines:
//
//   1. Roster metadata — CSV uploaded via /api/superadmin/exams/{id}/candidates
//      lands in the exam_candidates table (Postgres).
//
//   2. Biometrics (photo + FP image + FP template + iris) — historically
//      only reachable by SSH + rsync into DATA_DIR/<org>/<date>/<centre>/.
//      This file adds a proper superadmin upload path that writes to
//      DATA_DIR/uploaded/<exam_id>/{photo,fps,iso,iris}/<roll>.<ext> and
//      calls Index.Refresh() so the new file is queryable immediately —
//      no service restart needed.
//
// Endpoints:
//   POST /api/superadmin/exams/{id}/candidates/{roll}/biometric
//        multipart form: kind={photo|fp_image|fp_template|iris}, file=<blob>
//        → 201 { url }
//   GET  /api/superadmin/exams/{id}/completeness
//        → { total, with_photo, with_fp_image, with_fp_template, with_iris,
//            per_candidate: [{roll, name, has_photo, has_fp_image,
//                             has_fp_template, has_iris}] }
//   POST /api/superadmin/reindex
//        Force a full re-scan of DATA_DIR — safety net when disk state and
//        the in-memory index have drifted.

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/veni/neet-verification/internal/db"
)

// Bounds mirror the ones the operator-side capture handlers use.
const (
	maxBioUploadBytes = 5 << 20 // 5 MB per biometric
)

// biometricKind → (subdir, allowed extensions). The disk convention
// mirrors the legacy tree: photo/ = JPEG images, fps/ = fingerprint
// images (JPEG), iso/ = ISO 19794-2 fp templates, iris/ = iris bytes
// in ISO 19794-6 / K7 / raw BMP.
type biometricSpec struct {
	subdir  string
	allowed map[string]bool
	mime    map[string]string // extension → content-type for output
}

var biometricSpecs = map[string]biometricSpec{
	"photo":       {"photo", map[string]bool{".jpg": true, ".jpeg": true, ".png": true}, nil},
	"fp_image":    {"fps", map[string]bool{".jpg": true, ".jpeg": true, ".png": true, ".bmp": true}, nil},
	"fp_template": {"iso", map[string]bool{".iso": true, ".dat": true, ".bin": true}, nil},
	"iris":        {"iris", map[string]bool{".iso": true, ".k7": true, ".bmp": true}, nil},
}

// POST /api/superadmin/exams/{id}/candidates/{roll}/biometric
//
// Multipart body: kind=<one of biometricSpecs keys>, file=<blob>.
// Writes to DATA_DIR/uploaded/<exam_id>/<subdir>/<roll>.<ext>,
// preserving the uploader's extension so iris ISO vs K7 vs BMP stays
// distinguishable at query time.
func (s *Server) superadminUploadBiometric(w http.ResponseWriter, r *http.Request) {
	examID, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil || examID <= 0 {
		writeErr(w, http.StatusBadRequest, "bad exam id")
		return
	}
	roll := strings.TrimSpace(chi.URLParam(r, "roll"))
	if roll == "" || strings.ContainsAny(roll, `/\`) || roll == "." || roll == ".." {
		writeErr(w, http.StatusBadRequest, "bad roll number")
		return
	}

	// Verify the candidate actually belongs to this exam. Without this,
	// a superadmin could pollute an exam bucket with unrelated rolls.
	var candName string
	err = s.deps.DB.QueryRowContext(r.Context(),
		db.Q(`SELECT name FROM exam_candidates WHERE exam_id = ? AND roll_no = ?`),
		examID, roll,
	).Scan(&candName)
	if err != nil {
		writeErr(w, http.StatusNotFound, "candidate not enrolled in this exam")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxBioUploadBytes+64<<10)
	if err := r.ParseMultipartForm(maxBioUploadBytes + 64<<10); err != nil {
		writeErr(w, http.StatusBadRequest, "upload too large or malformed")
		return
	}
	kind := strings.TrimSpace(r.FormValue("kind"))
	spec, ok := biometricSpecs[kind]
	if !ok {
		writeErr(w, http.StatusBadRequest, "kind must be one of photo|fp_image|fp_template|iris")
		return
	}
	file, hdr, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "file is required")
		return
	}
	defer file.Close()

	ext := strings.ToLower(filepath.Ext(hdr.Filename))
	if !spec.allowed[ext] {
		writeErr(w, http.StatusBadRequest, fmt.Sprintf(
			"extension %q not accepted for kind=%s (allowed: %s)",
			ext, kind, joinKeys(spec.allowed)))
		return
	}

	// Build the target path. We atomic-rename from a .tmp so a
	// crashed write never leaves a half-file the index picks up.
	uploadedRoot := filepath.Join(s.deps.Cfg.DataDir, "uploaded", fmt.Sprintf("%d", examID), spec.subdir)
	if err := os.MkdirAll(uploadedRoot, 0o755); err != nil {
		writeErr(w, http.StatusInternalServerError, "mkdir: "+err.Error())
		return
	}
	// If a previous upload used a different extension for the same
	// candidate + kind (e.g. iris .iso → new upload is .k7), drop the
	// old one so the index doesn't see both.
	for oldExt := range spec.allowed {
		if oldExt == ext {
			continue
		}
		_ = os.Remove(filepath.Join(uploadedRoot, roll+oldExt))
	}
	finalPath := filepath.Join(uploadedRoot, roll+ext)
	tmpPath := finalPath + ".tmp"
	out, err := os.Create(tmpPath)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "create: "+err.Error())
		return
	}
	if _, err := io.Copy(out, file); err != nil {
		out.Close()
		_ = os.Remove(tmpPath)
		writeErr(w, http.StatusInternalServerError, "write: "+err.Error())
		return
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(tmpPath)
		writeErr(w, http.StatusInternalServerError, "close: "+err.Error())
		return
	}
	if err := os.Rename(tmpPath, finalPath); err != nil {
		_ = os.Remove(tmpPath)
		writeErr(w, http.StatusInternalServerError, "rename: "+err.Error())
		return
	}

	// Refresh the in-memory index so the file is visible without a
	// restart. Cheap — scans the whole DATA_DIR, but the operation is
	// once per upload and swap happens under a write lock.
	if err := s.deps.Index.Refresh(s.deps.Cfg.DataDir); err != nil {
		// Log-and-continue — the file is on disk regardless, and the
		// next successful upload (or a manual /reindex) will pick it up.
		fmt.Fprintf(os.Stderr, "biometric upload: reindex failed: %v\n", err)
	}

	s.auditFromRequest(r, "biometric.upload", "exam_candidate", examID, map[string]any{
		"roll": roll, "kind": kind, "bytes": hdr.Size,
	})

	writeJSON(w, http.StatusCreated, map[string]any{
		"kind":  kind,
		"roll":  roll,
		"exam":  examID,
		"bytes": hdr.Size,
		"path":  strings.TrimPrefix(finalPath, s.deps.Cfg.DataDir+"/"),
	})
}

func joinKeys(m map[string]bool) string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return strings.Join(out, ", ")
}

// GET /api/superadmin/exams/{id}/completeness
//
// Cross-checks the exam's roster (Postgres) against the biometric
// index (filesystem) and reports per-candidate status. The top-level
// counts drive the summary strip in the UI; per_candidate powers the
// per-row dots + upload widgets.
type completenessCandidate struct {
	Roll          string `json:"roll"`
	Name          string `json:"name"`
	HasPhoto      bool   `json:"has_photo"`
	HasFpImage    bool   `json:"has_fp_image"`
	HasFpTemplate bool   `json:"has_fp_template"`
	HasIris       bool   `json:"has_iris"`
}
type completenessResp struct {
	ExamID          int64                   `json:"exam_id"`
	Total           int                     `json:"total"`
	WithPhoto       int                     `json:"with_photo"`
	WithFpImage     int                     `json:"with_fp_image"`
	WithFpTemplate  int                     `json:"with_fp_template"`
	WithIris        int                     `json:"with_iris"`
	PerCandidate    []completenessCandidate `json:"per_candidate"`
}

func (s *Server) superadminExamCompleteness(w http.ResponseWriter, r *http.Request) {
	examID, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil || examID <= 0 {
		writeErr(w, http.StatusBadRequest, "bad exam id")
		return
	}
	rows, err := s.deps.DB.QueryContext(r.Context(),
		db.Q(`SELECT roll_no, name FROM exam_candidates WHERE exam_id = ? ORDER BY roll_no`),
		examID,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	defer rows.Close()
	resp := completenessResp{ExamID: examID, PerCandidate: []completenessCandidate{}}
	for rows.Next() {
		var roll, name string
		if err := rows.Scan(&roll, &name); err != nil {
			continue
		}
		item := completenessCandidate{Roll: roll, Name: name}
		if c, ok := s.deps.Index.Get(roll); ok {
			item.HasPhoto      = c.HasPhoto
			item.HasFpImage    = c.HasFpImage
			item.HasFpTemplate = c.HasIsoTpl
			item.HasIris       = c.HasIrisBytes
		}
		resp.Total++
		if item.HasPhoto      { resp.WithPhoto++      }
		if item.HasFpImage    { resp.WithFpImage++    }
		if item.HasFpTemplate { resp.WithFpTemplate++ }
		if item.HasIris       { resp.WithIris++       }
		resp.PerCandidate = append(resp.PerCandidate, item)
	}
	writeJSON(w, http.StatusOK, resp)
}

// POST /api/superadmin/reindex
//
// Manual re-scan of DATA_DIR. Emergency lever for when disk state has
// drifted from the in-memory index (e.g., someone rsync'd files
// directly onto the box the old way).
func (s *Server) superadminReindex(w http.ResponseWriter, r *http.Request) {
	if err := s.deps.Index.Refresh(s.deps.Cfg.DataDir); err != nil {
		writeErr(w, http.StatusInternalServerError, "reindex: "+err.Error())
		return
	}
	s.auditFromRequest(r, "index.reindex", "system", 0, nil)
	writeJSON(w, http.StatusOK, map[string]any{
		"candidates": s.deps.Index.CandidateCount(),
		"centers":    s.deps.Index.CenterCount(),
	})
}

// small util: kept private since the frontend uses fetch's JSON parse
func writeJSONRaw(w http.ResponseWriter, code int, v any) {
	buf, _ := json.Marshal(v)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_, _ = w.Write(buf)
}

// ─────────────────────────────────────────────────────────────────────
// Bulk biometric upload — one ZIP for a whole exam.
// ─────────────────────────────────────────────────────────────────────
//
// POST /api/superadmin/exams/{id}/biometrics/bulk
//   multipart body: file=<zip>
//
// Expected ZIP structure (paths relative to zip root):
//
//   photo/<roll>.jpg          — face photo
//   fps/<roll>.jpg            — fingerprint image
//   iso/<roll>.iso            — ISO 19794-2 fingerprint template
//   iris/<roll>.{iso|k7|bmp}  — iris bytes
//
// Nested folders are tolerated as long as the LAST two path segments
// match `<kind>/<file>`. Files whose kind/extension/roll don't match
// the rules are skipped with a per-file reason in the response — the
// operation never fails wholesale, so an operator can iterate on their
// archive with immediate feedback.

const (
	maxBulkZipBytes     = 500 << 20 // 500 MB per archive
	maxBulkPerFileBytes = 10  << 20 // 10 MB per file inside
	maxBulkFileCount    = 10_000    // guard against zip-bomb
)

// bulkEntryResult describes what happened to one entry in the archive.
type bulkEntryResult struct {
	Path   string `json:"path"`
	Kind   string `json:"kind,omitempty"`
	Roll   string `json:"roll,omitempty"`
	Status string `json:"status"` // "uploaded" | "skipped" | "error"
	Reason string `json:"reason,omitempty"`
}

type bulkUploadResp struct {
	ExamID       int64             `json:"exam_id"`
	Entries      int               `json:"entries_in_archive"`
	Uploaded     int               `json:"uploaded"`
	Skipped      int               `json:"skipped"`
	Errored      int               `json:"errored"`
	ByKind       map[string]int    `json:"uploaded_by_kind"`
	Results      []bulkEntryResult `json:"results"`
}

func (s *Server) superadminBulkBiometrics(w http.ResponseWriter, r *http.Request) {
	examID, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil || examID <= 0 {
		writeErr(w, http.StatusBadRequest, "bad exam id")
		return
	}

	// Preload the exam's enrolled rolls in one query so per-entry
	// validation is a cheap map lookup, not a round-trip per file.
	enrolled := map[string]bool{}
	rows, err := s.deps.DB.QueryContext(r.Context(),
		db.Q(`SELECT roll_no FROM exam_candidates WHERE exam_id = ?`), examID,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	for rows.Next() {
		var roll string
		if rows.Scan(&roll) == nil {
			enrolled[roll] = true
		}
	}
	rows.Close()
	if len(enrolled) == 0 {
		writeErr(w, http.StatusBadRequest, "exam has no enrolled candidates — upload the roster CSV first")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxBulkZipBytes+64<<10)
	if err := r.ParseMultipartForm(maxBulkZipBytes + 64<<10); err != nil {
		writeErr(w, http.StatusBadRequest, "upload too large or malformed")
		return
	}
	file, hdr, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "file is required")
		return
	}
	defer file.Close()

	// Buffer the ZIP to a temp file so we can seek and open it as an
	// archive.Reader. http.Request.FormFile may already be a
	// *os.File if the multipart parser spilled to disk, but the
	// interface doesn't expose that — a small copy keeps this simple.
	tmp, err := os.CreateTemp("", "bio-bulk-*.zip")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "tempfile: "+err.Error())
		return
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	written, err := io.Copy(tmp, file)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "spool: "+err.Error())
		return
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		writeErr(w, http.StatusInternalServerError, "seek: "+err.Error())
		return
	}
	zr, err := zip.NewReader(tmp, written)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "not a valid zip: "+err.Error())
		return
	}
	if len(zr.File) > maxBulkFileCount {
		writeErr(w, http.StatusBadRequest, fmt.Sprintf("archive has %d entries; max is %d", len(zr.File), maxBulkFileCount))
		return
	}

	// kind → subdir map (mirrors the single-file spec)
	kindSubdir := map[string]string{
		"photo":       "photo",
		"fps":         "fps",
		"iso":         "iso",
		"iris":        "iris",
		// aliases so the operator can name it either way
		"fp_image":    "fps",
		"fp_template": "iso",
	}
	kindAllowed := map[string]map[string]bool{
		"photo":       {".jpg": true, ".jpeg": true, ".png": true},
		"fps":         {".jpg": true, ".jpeg": true, ".png": true, ".bmp": true},
		"iso":         {".iso": true, ".dat": true, ".bin": true},
		"iris":        {".iso": true, ".k7": true, ".bmp": true},
		"fp_image":    {".jpg": true, ".jpeg": true, ".png": true, ".bmp": true},
		"fp_template": {".iso": true, ".dat": true, ".bin": true},
	}

	uploadedRoot := filepath.Join(s.deps.Cfg.DataDir, "uploaded", fmt.Sprintf("%d", examID))
	if err := os.MkdirAll(uploadedRoot, 0o755); err != nil {
		writeErr(w, http.StatusInternalServerError, "mkdir: "+err.Error())
		return
	}

	resp := bulkUploadResp{
		ExamID:  examID,
		Entries: len(zr.File),
		ByKind:  map[string]int{},
		Results: make([]bulkEntryResult, 0, len(zr.File)),
	}

	for _, ze := range zr.File {
		if ze.FileInfo().IsDir() {
			continue
		}
		if int64(ze.UncompressedSize64) > maxBulkPerFileBytes {
			resp.Errored++
			resp.Results = append(resp.Results, bulkEntryResult{
				Path: ze.Name, Status: "error",
				Reason: fmt.Sprintf("file exceeds %d MB", maxBulkPerFileBytes>>20),
			})
			continue
		}
		// Path shape: any prefix + <kind>/<file>. We take the last
		// two segments; anything else is a skip.
		parts := strings.Split(strings.ReplaceAll(ze.Name, `\`, `/`), "/")
		if len(parts) < 2 {
			resp.Skipped++
			resp.Results = append(resp.Results, bulkEntryResult{
				Path: ze.Name, Status: "skipped",
				Reason: "expected <kind>/<file>",
			})
			continue
		}
		kind := strings.ToLower(parts[len(parts)-2])
		fname := parts[len(parts)-1]
		subdir, kindOK := kindSubdir[kind]
		if !kindOK {
			resp.Skipped++
			resp.Results = append(resp.Results, bulkEntryResult{
				Path: ze.Name, Status: "skipped",
				Reason: fmt.Sprintf("unknown kind %q (want photo|fps|iso|iris)", kind),
			})
			continue
		}
		ext := strings.ToLower(filepath.Ext(fname))
		if !kindAllowed[kind][ext] {
			resp.Skipped++
			resp.Results = append(resp.Results, bulkEntryResult{
				Path: ze.Name, Kind: kind, Status: "skipped",
				Reason: fmt.Sprintf("extension %q not allowed for %s (want %s)", ext, kind, joinKeys(kindAllowed[kind])),
			})
			continue
		}
		roll := strings.TrimSuffix(fname, ext)
		if roll == "" || strings.ContainsAny(roll, `/\`) || roll == "." || roll == ".." {
			resp.Skipped++
			resp.Results = append(resp.Results, bulkEntryResult{
				Path: ze.Name, Kind: kind, Status: "skipped",
				Reason: "roll number could not be parsed from filename",
			})
			continue
		}
		if !enrolled[roll] {
			resp.Skipped++
			resp.Results = append(resp.Results, bulkEntryResult{
				Path: ze.Name, Kind: kind, Roll: roll, Status: "skipped",
				Reason: "roll not enrolled in this exam",
			})
			continue
		}

		// Open the entry, atomic-rename onto the target.
		rc, err := ze.Open()
		if err != nil {
			resp.Errored++
			resp.Results = append(resp.Results, bulkEntryResult{
				Path: ze.Name, Kind: kind, Roll: roll, Status: "error",
				Reason: "open: " + err.Error(),
			})
			continue
		}
		targetDir := filepath.Join(uploadedRoot, subdir)
		if err := os.MkdirAll(targetDir, 0o755); err != nil {
			rc.Close()
			resp.Errored++
			resp.Results = append(resp.Results, bulkEntryResult{
				Path: ze.Name, Kind: kind, Roll: roll, Status: "error",
				Reason: "mkdir: " + err.Error(),
			})
			continue
		}
		// Purge any older-extension duplicate before writing.
		for oldExt := range kindAllowed[kind] {
			if oldExt == ext {
				continue
			}
			_ = os.Remove(filepath.Join(targetDir, roll+oldExt))
		}
		final := filepath.Join(targetDir, roll+ext)
		tmpPath := final + ".tmp"
		out, err := os.Create(tmpPath)
		if err != nil {
			rc.Close()
			resp.Errored++
			resp.Results = append(resp.Results, bulkEntryResult{
				Path: ze.Name, Kind: kind, Roll: roll, Status: "error",
				Reason: "create: " + err.Error(),
			})
			continue
		}
		// Cap the copy so a lying uncompressed-size header can't blow past our limit.
		_, err = io.Copy(out, io.LimitReader(rc, maxBulkPerFileBytes+1))
		rc.Close()
		if cerr := out.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			_ = os.Remove(tmpPath)
			resp.Errored++
			resp.Results = append(resp.Results, bulkEntryResult{
				Path: ze.Name, Kind: kind, Roll: roll, Status: "error",
				Reason: "write: " + err.Error(),
			})
			continue
		}
		if err := os.Rename(tmpPath, final); err != nil {
			_ = os.Remove(tmpPath)
			resp.Errored++
			resp.Results = append(resp.Results, bulkEntryResult{
				Path: ze.Name, Kind: kind, Roll: roll, Status: "error",
				Reason: "rename: " + err.Error(),
			})
			continue
		}
		resp.Uploaded++
		resp.ByKind[kind]++
		resp.Results = append(resp.Results, bulkEntryResult{
			Path: ze.Name, Kind: kind, Roll: roll, Status: "uploaded",
		})
	}

	// One index refresh at the end (much cheaper than one-per-file).
	if err := s.deps.Index.Refresh(s.deps.Cfg.DataDir); err != nil {
		fmt.Fprintf(os.Stderr, "bulk biometric upload: reindex failed: %v\n", err)
	}

	s.auditFromRequest(r, "biometric.bulk_upload", "exam", examID, map[string]any{
		"archive":       hdr.Filename,
		"archive_bytes": written,
		"uploaded":      resp.Uploaded,
		"skipped":       resp.Skipped,
		"errored":       resp.Errored,
		"by_kind":       resp.ByKind,
	})

	writeJSON(w, http.StatusOK, resp)
}
