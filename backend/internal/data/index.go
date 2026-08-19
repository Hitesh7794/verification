package data

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// Candidate is a single enrolled student record discovered on disk.
type Candidate struct {
	RollNo      string `json:"roll_no"`
	OrgCode     string `json:"org_code"`
	CenterCode  string `json:"center_code"`
	CenterName  string `json:"center_name"`
	ExamDate    string `json:"exam_date"`
	PhotoPath   string `json:"-"`
	FpImagePath string `json:"-"`
	IsoTplPath  string `json:"-"`
	// IrisBytesPath is the on-disk file with enrolled iris bytes for
	// this roll. Format is whatever the enrollment tool captured —
	// ISO/IEC 19794-6, K7, or raw BMP; TrustView's iris engine sniffs
	// the format so we don't need to record it. HasIrisBytes is true
	// iff a file was found under <center>/iris/<roll>.<ext>.
	IrisBytesPath string `json:"-"`
	HasPhoto      bool   `json:"has_photo"`
	HasFpImage    bool   `json:"has_fp_image"`
	HasIsoTpl     bool   `json:"has_iso_template"`
	HasIrisBytes  bool   `json:"has_iris_bytes"`
	// FpTemplateFormat is the wire format of the gallery template file
	// (one of FMR_V2005, FMR_V2011, ANSI_V378, or unknown). Detected by
	// peeking at the first bytes of the .iso file at index time so the
	// MorFin SDK can be told the right TmpFormat at match time.
	FpTemplateFormat string `json:"fp_template_format,omitempty"`
}

// Fingerprint template wire formats accepted by the MorFin verify/match API.
const (
	TplFormatFMRV2005 = "FMR_V2005"
	TplFormatFMRV2011 = "FMR_V2011"
	TplFormatANSI378  = "ANSI_V378"
	TplFormatUnknown  = "unknown"
)

// CenterInfo describes one examination center as discovered on disk.
type CenterInfo struct {
	OrgCode string
	Code    string
	Name    string
}

// Index is the in-memory store of every enrolled candidate scanned from
// the bundled sample data tree. Reads are lock-free after construction.
type Index struct {
	mu      sync.RWMutex
	byRoll  map[string]*Candidate
	centers map[string]CenterInfo // key: orgCode + "/" + centerCode
}

func NewEmptyIndex() *Index {
	return &Index{byRoll: map[string]*Candidate{}, centers: map[string]CenterInfo{}}
}

func (i *Index) CandidateCount() int {
	i.mu.RLock()
	defer i.mu.RUnlock()
	return len(i.byRoll)
}

func (i *Index) CenterCount() int {
	i.mu.RLock()
	defer i.mu.RUnlock()
	return len(i.centers)
}

func (i *Index) Get(roll string) (*Candidate, bool) {
	i.mu.RLock()
	defer i.mu.RUnlock()
	c, ok := i.byRoll[roll]
	return c, ok
}

// Upsert overlays a candidate that came from the DB (S3-backed uploads
// that never touched disk). Merges into any existing row from the disk
// scan — TRUE flag values only, so a stale disk file still marking
// HasPhoto=true isn't clobbered to false by a DB row with the default
// flag values. Callers pass a shell Candidate with just RollNo + the
// has_* flags they want to flip on.
//
// Held under a write lock; safe to call from Server.hydrateIndexFromDB
// after a disk Refresh().
func (i *Index) Upsert(roll string, hasPhoto, hasFpImage, hasFpTemplate, hasIris bool) {
	i.mu.Lock()
	defer i.mu.Unlock()
	c := i.byRoll[roll]
	if c == nil {
		c = &Candidate{RollNo: roll, OrgCode: "s3", CenterCode: "s3"}
		i.byRoll[roll] = c
	}
	if hasPhoto {
		c.HasPhoto = true
	}
	if hasFpImage {
		c.HasFpImage = true
	}
	if hasFpTemplate {
		c.HasIsoTpl = true
	}
	if hasIris {
		c.HasIrisBytes = true
	}
}

// Refresh rebuilds the index from disk and atomically swaps the
// internal maps. Called from the biometric-upload handler so newly-
// uploaded files become visible without a service restart, and
// exposed on POST /api/superadmin/reindex for a manual full re-scan.
//
// Safe to call concurrently with reads — Get() holds an RLock; this
// method builds a fresh index off to the side, then swaps under a
// Write lock in one shot so no query ever sees a half-built state.
func (i *Index) Refresh(root string) error {
	fresh, err := LoadIndex(root)
	if err != nil {
		return err
	}
	i.mu.Lock()
	i.byRoll = fresh.byRoll
	i.centers = fresh.centers
	i.mu.Unlock()
	return nil
}

// Centers returns the list of all centers discovered on disk, sorted by
// org and center code.
func (i *Index) Centers() []CenterInfo {
	i.mu.RLock()
	defer i.mu.RUnlock()
	out := make([]CenterInfo, 0, len(i.centers))
	for _, c := range i.centers {
		out = append(out, c)
	}
	sort.Slice(out, func(a, b int) bool {
		if out[a].OrgCode != out[b].OrgCode {
			return out[a].OrgCode < out[b].OrgCode
		}
		return out[a].Code < out[b].Code
	})
	return out
}

// CandidatesByCenter returns the number of enrolled candidates per center,
// keyed by orgCode + "/" + centerCode.
func (i *Index) CandidatesByCenter() map[string]int {
	i.mu.RLock()
	defer i.mu.RUnlock()
	out := map[string]int{}
	for _, c := range i.byRoll {
		out[c.OrgCode+"/"+c.CenterCode]++
	}
	return out
}

// LoadIndex walks the sample data tree:
//
//	<root>/<orgCode>/<examDate>/<centerCode>__<centerName>/{photo,fps,iso}/<roll>.{jpg,iso}
//
// It tolerates a missing root directory and returns an empty index if so.
func LoadIndex(root string) (*Index, error) {
	idx := NewEmptyIndex()
	info, err := os.Stat(root)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return idx, nil
		}
		return nil, err
	}
	if !info.IsDir() {
		return idx, nil
	}

	orgs, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	for _, org := range orgs {
		if !org.IsDir() {
			continue
		}
		orgCode := org.Name()
		// Skip our own reserved bucket for superadmin-uploaded
		// biometrics — those are keyed by exam_id, not org_code, and
		// get scanned by scanUploaded() below.
		if orgCode == "uploaded" {
			continue
		}
		dates, err := os.ReadDir(filepath.Join(root, orgCode))
		if err != nil {
			continue
		}
		for _, date := range dates {
			if !date.IsDir() {
				continue
			}
			centers, err := os.ReadDir(filepath.Join(root, orgCode, date.Name()))
			if err != nil {
				continue
			}
			for _, ctr := range centers {
				if !ctr.IsDir() {
					continue
				}
				code, name := splitCenter(ctr.Name())
				base := filepath.Join(root, orgCode, date.Name(), ctr.Name())
				// Only record the center if scanCenter actually found
				// candidates underneath it. Without this, walking a
				// directory tree that contains unrelated subfolders (the
				// SDK directories alongside gndu27, for instance) pollutes
				// the index with empty "centers".
				before := len(idx.byRoll)
				scanCenter(idx, base, orgCode, code, name, date.Name())
				if len(idx.byRoll) > before {
					idx.centers[orgCode+"/"+code] = CenterInfo{
						OrgCode: orgCode,
						Code:    code,
						Name:    name,
					}
				}
			}
		}
	}
	// Second pass — superadmin-uploaded biometrics live under
	// <root>/uploaded/<exam_id>/{photo,fps,iso,iris}/<roll>.<ext>.
	// These don't fit the org/date/center hierarchy (they're keyed by
	// exam_id) so they're scanned separately and merged into byRoll
	// without registering a synthetic "center" entry.
	scanUploaded(idx, filepath.Join(root, "uploaded"))
	return idx, nil
}

// scanUploaded walks <uploadedRoot>/<exam_id>/{photo,fps,iso,iris}/
// and adds entries to the index keyed by roll number. An uploaded
// candidate that already exists in the legacy tree is OVERWRITTEN
// (uploaded is more recent by definition), preserving the legacy
// center context if present.
func scanUploaded(idx *Index, uploadedRoot string) {
	entries, err := os.ReadDir(uploadedRoot)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		examID := e.Name()
		base := filepath.Join(uploadedRoot, examID)
		photoDir := filepath.Join(base, "photo")
		fpDir := filepath.Join(base, "fps")
		isoDir := filepath.Join(base, "iso")
		irisDir := filepath.Join(base, "iris")

		// Photos drive candidate discovery — same shape as scanCenter.
		photos, err := os.ReadDir(photoDir)
		if err == nil {
			for _, p := range photos {
				if p.IsDir() {
					continue
				}
				roll := strings.TrimSuffix(p.Name(), filepath.Ext(p.Name()))
				c := idx.byRoll[roll]
				if c == nil {
					c = &Candidate{RollNo: roll, OrgCode: "uploaded", CenterCode: examID}
					idx.byRoll[roll] = c
				}
				c.PhotoPath = filepath.Join(photoDir, p.Name())
				c.HasPhoto = true
			}
		}
		// FP + iris — these can also be uploaded independently for a
		// candidate whose photo was seeded from the legacy tree.
		// Iterate directory entries so we find whatever's on disk
		// regardless of extension.
		if fps, err := os.ReadDir(fpDir); err == nil {
			for _, p := range fps {
				if p.IsDir() {
					continue
				}
				roll := strings.TrimSuffix(p.Name(), filepath.Ext(p.Name()))
				c := idx.byRoll[roll]
				if c == nil {
					c = &Candidate{RollNo: roll, OrgCode: "uploaded", CenterCode: examID}
					idx.byRoll[roll] = c
				}
				c.FpImagePath = filepath.Join(fpDir, p.Name())
				c.HasFpImage = true
			}
		}
		if isos, err := os.ReadDir(isoDir); err == nil {
			for _, p := range isos {
				if p.IsDir() {
					continue
				}
				roll := strings.TrimSuffix(p.Name(), filepath.Ext(p.Name()))
				c := idx.byRoll[roll]
				if c == nil {
					c = &Candidate{RollNo: roll, OrgCode: "uploaded", CenterCode: examID}
					idx.byRoll[roll] = c
				}
				c.IsoTplPath = filepath.Join(isoDir, p.Name())
				c.HasIsoTpl = true
				c.FpTemplateFormat = detectTemplateFormat(c.IsoTplPath)
			}
		}
		if iriss, err := os.ReadDir(irisDir); err == nil {
			for _, p := range iriss {
				if p.IsDir() {
					continue
				}
				roll := strings.TrimSuffix(p.Name(), filepath.Ext(p.Name()))
				c := idx.byRoll[roll]
				if c == nil {
					c = &Candidate{RollNo: roll, OrgCode: "uploaded", CenterCode: examID}
					idx.byRoll[roll] = c
				}
				c.IrisBytesPath = filepath.Join(irisDir, p.Name())
				c.HasIrisBytes = true
			}
		}
	}
}

func scanCenter(idx *Index, base, orgCode, centerCode, centerName, examDate string) {
	photoDir := filepath.Join(base, "photo")
	fpDir := filepath.Join(base, "fps")
	isoDir := filepath.Join(base, "iso")
	irisDir := filepath.Join(base, "iris")

	entries, err := os.ReadDir(photoDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		roll := strings.TrimSuffix(e.Name(), filepath.Ext(e.Name()))
		c := &Candidate{
			RollNo:     roll,
			OrgCode:    orgCode,
			CenterCode: centerCode,
			CenterName: centerName,
			ExamDate:   examDate,
			PhotoPath:  filepath.Join(photoDir, e.Name()),
			HasPhoto:   true,
		}
		fpPath := filepath.Join(fpDir, roll+".jpg")
		if _, err := os.Stat(fpPath); err == nil {
			c.FpImagePath = fpPath
			c.HasFpImage = true
		}
		isoPath := filepath.Join(isoDir, roll+".iso")
		if _, err := os.Stat(isoPath); err == nil {
			c.IsoTplPath = isoPath
			c.HasIsoTpl = true
			c.FpTemplateFormat = detectTemplateFormat(isoPath)
		}
		// Iris — accept any of the vendor formats the Marvis daemon
		// can emit via /marvisauth/getimage: ISO/IEC 19794-6 (.iso),
		// Mantra's K7 (.k7), or raw BMP (.bmp). Whichever is found
		// first wins; TrustView's iris engine sniffs the format so we
		// don't need to record it. Enrollment tools should pick one
		// format per exam to keep the on-disk tree clean.
		if p := firstExisting(irisDir, roll, []string{".iso", ".k7", ".bmp"}); p != "" {
			c.IrisBytesPath = p
			c.HasIrisBytes = true
		}
		idx.byRoll[roll] = c
	}
}

// firstExisting returns the first "<dir>/<roll><ext>" that exists on
// disk, or "" if none of the candidate extensions match. Used to pick
// up whichever iris format the enrollment tool happened to write out.
func firstExisting(dir, base string, exts []string) string {
	for _, ext := range exts {
		p := filepath.Join(dir, base+ext)
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

// detectTemplateFormat inspects the magic bytes of a fingerprint template
// file and identifies the standard it conforms to. Sniffing happens once at
// index time; the result is cached on the Candidate so the match path stays
// fast. Returns TplFormatUnknown for files that don't match any known header
// — those candidates won't be matchable but won't break the verification flow.
func detectTemplateFormat(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return TplFormatUnknown
	}
	defer f.Close()
	var hdr [8]byte
	n, _ := f.Read(hdr[:])
	if n < 8 {
		return TplFormatUnknown
	}
	// ISO/IEC 19794-2 (FMR): "FMR\0" + a 4-byte version field. The version
	// field is ASCII " 20\0" (space-2-0-NUL) for the 2005 spec and " 30\0"
	// for the 2011 update.
	if hdr[0] == 'F' && hdr[1] == 'M' && hdr[2] == 'R' && hdr[3] == 0 {
		switch {
		case hdr[4] == ' ' && hdr[5] == '2' && hdr[6] == '0' && hdr[7] == 0:
			return TplFormatFMRV2005
		case hdr[4] == ' ' && hdr[5] == '3' && hdr[6] == '0' && hdr[7] == 0:
			return TplFormatFMRV2011
		}
	}
	// ANSI INCITS 378 / NIST SP 500-271 records start with "FMC\0".
	if hdr[0] == 'F' && hdr[1] == 'M' && hdr[2] == 'C' && hdr[3] == 0 {
		return TplFormatANSI378
	}
	return TplFormatUnknown
}

func splitCenter(name string) (code, label string) {
	if i := strings.Index(name, "__"); i > 0 {
		return name[:i], name[i+2:]
	}
	return name, name
}
