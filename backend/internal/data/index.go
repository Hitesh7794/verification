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
	HasPhoto    bool   `json:"has_photo"`
	HasFpImage  bool   `json:"has_fp_image"`
	HasIsoTpl   bool   `json:"has_iso_template"`
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

func (i *Index) CandidateCount() int { return len(i.byRoll) }
func (i *Index) CenterCount() int    { return len(i.centers) }

func (i *Index) Get(roll string) (*Candidate, bool) {
	i.mu.RLock()
	defer i.mu.RUnlock()
	c, ok := i.byRoll[roll]
	return c, ok
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
	return idx, nil
}

func scanCenter(idx *Index, base, orgCode, centerCode, centerName, examDate string) {
	photoDir := filepath.Join(base, "photo")
	fpDir := filepath.Join(base, "fps")
	isoDir := filepath.Join(base, "iso")

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
		idx.byRoll[roll] = c
	}
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
