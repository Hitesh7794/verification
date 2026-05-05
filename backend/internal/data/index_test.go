package data

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDetectTemplateFormat(t *testing.T) {
	dir := t.TempDir()

	cases := []struct {
		name string
		hdr  []byte
		want string
	}{
		// "FMR\0 20\0" — ISO/IEC 19794-2:2005
		{"fmr_v2005", []byte{0x46, 0x4D, 0x52, 0x00, 0x20, 0x32, 0x30, 0x00, 0x00, 0x00}, TplFormatFMRV2005},
		// "FMR\0 30\0" — ISO/IEC 19794-2:2011 update
		{"fmr_v2011", []byte{0x46, 0x4D, 0x52, 0x00, 0x20, 0x33, 0x30, 0x00, 0x00, 0x00}, TplFormatFMRV2011},
		// "FMC\0..." — ANSI INCITS 378
		{"ansi_378", []byte{0x46, 0x4D, 0x43, 0x00, 0x20, 0x32, 0x30, 0x00, 0x00, 0x00}, TplFormatANSI378},
		// random garbage
		{"garbage", []byte{0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00}, TplFormatUnknown},
		// truncated
		{"too_short", []byte{0x46, 0x4D}, TplFormatUnknown},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := filepath.Join(dir, c.name+".iso")
			if err := os.WriteFile(p, c.hdr, 0o644); err != nil {
				t.Fatal(err)
			}
			if got := detectTemplateFormat(p); got != c.want {
				t.Errorf("got %q want %q", got, c.want)
			}
		})
	}

	t.Run("missing_file", func(t *testing.T) {
		if got := detectTemplateFormat(filepath.Join(dir, "nope.iso")); got != TplFormatUnknown {
			t.Errorf("missing file should be unknown, got %q", got)
		}
	})
}

// TestDetectAgainstSampleData runs the detector against the real bundled
// gndu27 .iso files (if present) and confirms every one of them is a known
// format. Skips quietly if the sample tree isn't on disk.
func TestDetectAgainstSampleData(t *testing.T) {
	candidates := []string{
		"../../../gndu27_enrollments_data_2026-04-08 11_38_23.492595",
		"../../../../gndu27/22 Mar'26",
	}
	var root string
	for _, c := range candidates {
		if abs, err := filepath.Abs(c); err == nil {
			if _, err := os.Stat(abs); err == nil {
				root = abs
				break
			}
		}
	}
	if root == "" {
		t.Skip("sample data tree not available locally")
	}

	checked := 0
	unknown := 0
	_ = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		if filepath.Ext(path) != ".iso" {
			return nil
		}
		checked++
		if detectTemplateFormat(path) == TplFormatUnknown {
			unknown++
			if unknown <= 3 {
				t.Logf("unknown format: %s", path)
			}
		}
		return nil
	})
	if checked == 0 {
		t.Skip("no .iso files found in sample tree")
	}
	t.Logf("checked %d .iso files, %d unknown", checked, unknown)
	if unknown > 0 {
		t.Errorf("%d/%d sample templates have an unknown format", unknown, checked)
	}
}
