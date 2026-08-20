package api

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Downloads backend — surfaces the operator-laptop install bundle to
// the admin portal AND the client (operator) portal. Open to admin,
// client, and superadmin roles per server.go; org-scoped audit so an
// operator's self-serve download lands in the same org bucket as an
// admin's. The artefact is the same regardless of who downloads it.
//
// One artefact today — the Windows install bundle — and the code is
// designed so future artefacts (Linux bundle, iris add-on, etc.) drop
// in with a one-line tweak to the pattern list.
//
// Selection rule: scan DOWNLOADS_DIR for filenames matching any of the
// well-known operator-client patterns. Among matches, prefer .exe over
// .msi over .zip (the .exe wrapper is the polished signed installer
// when it exists; .zip is the interim hand-roll-your-own bundle). Within
// the same kind, newest mtime wins. This lets a deployment drop a new
// build in place and the page picks it up without a restart.
//
// SHA256 is computed on demand and cached against (path, mtime, size)
// because the file is 200+ MB — hashing it on every list call would be
// silly. Cache is in-memory; restart re-hashes once.

// ----- response shapes -----

type downloadItem struct {
	ID          string `json:"id"`
	Filename    string `json:"filename"`
	Version     string `json:"version,omitempty"`
	SizeBytes   int64  `json:"size_bytes"`
	SHA256      string `json:"sha256"`
	UpdatedAt   string `json:"updated_at"`
	DownloadURL string `json:"download_url"`
}

type downloadsLastEntry struct {
	At       string `json:"at"`
	Username string `json:"username,omitempty"`
}

type downloadsListResp struct {
	Items        []downloadItem      `json:"items"`
	LastDownload *downloadsLastEntry `json:"last_download,omitempty"`
}

// ----- SHA256 cache -----

type sha256CacheEntry struct {
	mtime time.Time
	size  int64
	hex   string
}

var (
	sha256CacheMu sync.Mutex
	sha256Cache   = map[string]sha256CacheEntry{}
)

func cachedSHA256(path string, fi os.FileInfo) (string, error) {
	sha256CacheMu.Lock()
	e, ok := sha256Cache[path]
	sha256CacheMu.Unlock()
	if ok && e.size == fi.Size() && e.mtime.Equal(fi.ModTime()) {
		return e.hex, nil
	}
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	sum := hex.EncodeToString(h.Sum(nil))
	sha256CacheMu.Lock()
	sha256Cache[path] = sha256CacheEntry{mtime: fi.ModTime(), size: fi.Size(), hex: sum}
	sha256CacheMu.Unlock()
	return sum, nil
}

// ----- selection -----

// operatorClientPatterns lists filename globs that count as "the
// operator-laptop install bundle". Ordered by preference: a signed .exe
// beats an .msi beats a .zip. We scan all and return the first match
// found at the highest preference tier (so a stale .zip lying next to a
// fresh .exe never gets served).
var operatorClientPatterns = []string{
	"OperatorPortalSetup-*.exe",
	"OperatorPortalSetup-*.msi",
	"VerificationPortalClient-*.zip",
	"VerificationPortalClient-*-windows.zip",
}

// agentAndroidPatterns is the mobile-app counterpart. The verification-
// agent Android app ships as a signed .apk that a centre agent installs
// on their handset. Same DOWNLOADS_DIR, same selection rule (newest mtime
// among matches wins). Kept as a slice for the same "future variants
// drop in without code change" reason.
var agentAndroidPatterns = []string{
	"VerificationAgent-*.apk",
	"verification-agent-*.apk",
}

// findOperatorClient walks DOWNLOADS_DIR for the best operator-client
// artefact. Returns errNoOperatorClient if nothing matches — handler
// surfaces that as 404 so the admin sees "no bundle published yet"
// instead of a stack trace.
var errNoOperatorClient = errors.New("no operator client bundle found")

func (s *Server) findOperatorClient() (*downloadItem, string, error) {
	dir := s.deps.Cfg.DownloadsDir
	if dir == "" {
		return nil, "", errNoOperatorClient
	}
	// Walk patterns in priority order; the first tier that yields a
	// match wins. Within a tier, pick the newest mtime.
	for _, pattern := range operatorClientPatterns {
		matches, _ := filepath.Glob(filepath.Join(dir, pattern))
		if len(matches) == 0 {
			continue
		}
		var (
			bestPath string
			bestInfo os.FileInfo
		)
		for _, m := range matches {
			fi, err := os.Stat(m)
			if err != nil || fi.IsDir() {
				continue
			}
			if bestInfo == nil || fi.ModTime().After(bestInfo.ModTime()) {
				bestPath = m
				bestInfo = fi
			}
		}
		if bestInfo == nil {
			continue
		}
		sum, err := cachedSHA256(bestPath, bestInfo)
		if err != nil {
			return nil, "", fmt.Errorf("sha256: %w", err)
		}
		return &downloadItem{
			ID:          "operator-client",
			Filename:    filepath.Base(bestPath),
			Version:     parseVersionFromFilename(filepath.Base(bestPath)),
			SizeBytes:   bestInfo.Size(),
			SHA256:      sum,
			UpdatedAt:   bestInfo.ModTime().UTC().Format(time.RFC3339),
			DownloadURL: "/api/downloads/operator-client",
		}, bestPath, nil
	}
	return nil, "", errNoOperatorClient
}

// parseVersionFromFilename pulls "1.0.0" out of names like
// "VerificationPortalClient-1.0.0-windows.zip" or
// "OperatorPortalSetup-1.0.0.exe". Returns "" if no version-shaped
// token is present — that's fine, the UI just hides the version line.
func parseVersionFromFilename(name string) string {
	for _, sep := range []string{"-", "_"} {
		for _, part := range strings.Split(name, sep) {
			if len(part) >= 3 && part[0] >= '0' && part[0] <= '9' && strings.ContainsRune(part, '.') {
				// Trim a trailing extension if the version is the last
				// segment, e.g. "1.0.0.exe" → "1.0.0".
				if i := strings.IndexByte(part, ' '); i >= 0 {
					part = part[:i]
				}
				if dot := strings.LastIndexByte(part, '.'); dot > 0 {
					tail := part[dot+1:]
					if isAlpha(tail) {
						part = part[:dot]
					}
				}
				return part
			}
		}
	}
	return ""
}

func isAlpha(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')) {
			return false
		}
	}
	return true
}

// ----- handlers -----

// GET /api/admin/downloads
//
// Returns the manifest of available downloads (today: just the operator-
// client bundle) plus the timestamp of this org's last download, used by
// the UI to show "Last downloaded ... by ...". Org-scoped: each admin
// sees their own org's history, never another org's.
func (s *Server) adminListDownloads(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r)
	if claims.OrgID == nil {
		writeErr(w, http.StatusForbidden, "admin without org context")
		return
	}
	resp := downloadsListResp{Items: []downloadItem{}}
	if item, _, err := s.findOperatorClient(); err == nil {
		resp.Items = append(resp.Items, *item)
	}
	if item, _, err := s.findAgentAndroid(); err == nil {
		resp.Items = append(resp.Items, *item)
	}
	// Best-effort last-download lookup. Empty result = first time;
	// we just omit the field.
	var at, who string
	_ = s.deps.DB.QueryRowContext(r.Context(),
		`SELECT created_at, COALESCE(actor_username,'')
		 FROM audit_log
		 WHERE org_id = $1 AND action = 'downloads.operator_client.get'
		 ORDER BY id DESC LIMIT 1`,
		*claims.OrgID,
	).Scan(&at, &who)
	if at != "" {
		resp.LastDownload = &downloadsLastEntry{At: at, Username: who}
	}
	writeJSON(w, http.StatusOK, resp)
}

// GET /api/admin/downloads/operator-client
//
// Streams the bundle. http.ServeContent handles Range requests
// (resumability on flaky networks), conditional GET (If-Modified-Since),
// and ETag, so a partial transfer can resume from the last byte. Audit
// row is written regardless of whether the transfer completes — what
// we're tracking is "an admin asked for this", not "a complete byte
// stream landed somewhere".
func (s *Server) adminDownloadOperatorClient(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r)
	if claims.OrgID == nil {
		writeErr(w, http.StatusForbidden, "admin without org context")
		return
	}
	item, path, err := s.findOperatorClient()
	if errors.Is(err, errNoOperatorClient) {
		writeErr(w, http.StatusNotFound, "no verification agent client bundle published yet")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "lookup: "+err.Error())
		return
	}
	f, err := os.Open(path)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "open: "+err.Error())
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "stat: "+err.Error())
		return
	}

	contentType := "application/octet-stream"
	switch strings.ToLower(filepath.Ext(item.Filename)) {
	case ".zip":
		contentType = "application/zip"
	case ".msi":
		contentType = "application/x-msi"
	case ".exe":
		contentType = "application/vnd.microsoft.portable-executable"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`attachment; filename="%s"`, safeFilename(item.Filename)))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// Explicit X-SHA256 so the client can verify the bytes after save.
	// Cheap header; the UI shows it under the button.
	w.Header().Set("X-SHA256", item.SHA256)

	// Audit BEFORE the (potentially long) transfer — if the connection
	// drops mid-stream we still know the admin requested the file. The
	// audit insert is best-effort.
	//
	// Suppress audit for *resumed* Range requests so a flaky-network
	// download that gets paused and resumed mid-stream registers as ONE
	// admin intent, not as N partial chunks. A Range request that starts
	// at byte 0 still counts (some download managers always use Range
	// even on first fetch). Empty Range header = full GET = audit.
	rng := r.Header.Get("Range")
	if rng == "" || strings.HasPrefix(strings.TrimSpace(rng), "bytes=0-") {
		s.auditFromRequest(r, "downloads.operator_client.get", "download", 0, map[string]any{
			"filename":   item.Filename,
			"size_bytes": fi.Size(),
			"sha256":     item.SHA256,
		})
	}

	http.ServeContent(w, r, item.Filename, fi.ModTime(), f)
}

// ----- Android agent APK -----

var errNoAgentAndroid = errors.New("no verification-agent android apk found")

// findAgentAndroid mirrors findOperatorClient but for the mobile app.
func (s *Server) findAgentAndroid() (*downloadItem, string, error) {
	dir := s.deps.Cfg.DownloadsDir
	if dir == "" {
		return nil, "", errNoAgentAndroid
	}
	for _, pattern := range agentAndroidPatterns {
		matches, _ := filepath.Glob(filepath.Join(dir, pattern))
		if len(matches) == 0 {
			continue
		}
		var (
			bestPath string
			bestInfo os.FileInfo
		)
		for _, m := range matches {
			fi, err := os.Stat(m)
			if err != nil || fi.IsDir() {
				continue
			}
			if bestInfo == nil || fi.ModTime().After(bestInfo.ModTime()) {
				bestPath = m
				bestInfo = fi
			}
		}
		if bestInfo == nil {
			continue
		}
		sum, err := cachedSHA256(bestPath, bestInfo)
		if err != nil {
			return nil, "", fmt.Errorf("sha256: %w", err)
		}
		return &downloadItem{
			ID:          "agent-android",
			Filename:    filepath.Base(bestPath),
			Version:     parseVersionFromFilename(filepath.Base(bestPath)),
			SizeBytes:   bestInfo.Size(),
			SHA256:      sum,
			UpdatedAt:   bestInfo.ModTime().UTC().Format(time.RFC3339),
			DownloadURL: "/api/downloads/agent-android",
		}, bestPath, nil
	}
	return nil, "", errNoAgentAndroid
}

// GET /api/downloads/agent-android
//
// Streams the verification-agent Android APK. Auth: client (agent
// self-reinstall on a new handset) OR admin (hand it to a new agent).
// Same audit + Range-request handling as the desktop bundle.
func (s *Server) downloadAgentAndroid(w http.ResponseWriter, r *http.Request) {
	item, path, err := s.findAgentAndroid()
	if errors.Is(err, errNoAgentAndroid) {
		writeErr(w, http.StatusNotFound, "no verification agent APK published yet")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "lookup: "+err.Error())
		return
	}
	f, err := os.Open(path)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "open: "+err.Error())
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "stat: "+err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/vnd.android.package-archive")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`attachment; filename="%s"`, safeFilename(item.Filename)))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-SHA256", item.SHA256)

	rng := r.Header.Get("Range")
	if rng == "" || strings.HasPrefix(strings.TrimSpace(rng), "bytes=0-") {
		s.auditFromRequest(r, "downloads.agent_android.get", "download", 0, map[string]any{
			"filename":   item.Filename,
			"size_bytes": fi.Size(),
			"sha256":     item.SHA256,
		})
	}

	http.ServeContent(w, r, item.Filename, fi.ModTime(), f)
}
