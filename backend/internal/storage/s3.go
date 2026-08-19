// Package storage wraps the S3 bucket that holds candidate photos +
// KYC documents. Backed by aws-sdk-go-v2; credentials come from the
// default chain (EC2 instance role in prod, ~/.aws in dev).
//
// Two content classes with distinct key layouts:
//
//	<EXAM_CODE>/photos/<roll>.jpg           — enrolled gallery photo
//	<EXAM_CODE>/probes/<verif_id>.jpg       — captured probe (per verification)
//	_kyc/applications/<app_id>/<doc_id>_<doc_kind>.<ext>  — KYC document
//
// The exam-code prefix (NEET1, NEET2, …) is what makes the bucket
// browsable per-exam in the AWS console. `_kyc/` sorts under all
// exam folders so onboarding data lives in its own visual block.
//
// This package deliberately does NOT touch the DB. Callers pass the
// exam_code / roll_no / app_id they already have from their own query.
// Keeps the storage layer swappable if we ever move to a different
// object store.
package storage

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"

	awsv2 "github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	smithy "github.com/aws/smithy-go"
)

// Client is the entrypoint. Nil-safe on read paths — a nil client
// returns ErrDisabled so handlers can 503 gracefully when S3 isn't
// configured (e.g. a dev machine without AWS creds).
type Client struct {
	bucket    string
	region    string
	s3c       *s3.Client
	presigner *s3.PresignClient
}

// Config carries the little we need to construct the client.
type Config struct {
	Bucket string
	Region string // e.g. "ap-south-1"
}

// Sentinel errors — handlers switch on these rather than string match.
var (
	ErrDisabled = errors.New("s3 storage is not configured (S3_BUCKET empty)")
	ErrNotFound = errors.New("object not found in bucket")
)

// New builds a client from the default AWS credential chain (EC2
// instance role, env vars, ~/.aws/credentials, ~/.aws/config). Returns
// nil-with-nil-error when the config is empty — that's the intended
// "storage disabled" state for local dev, and every read/write method
// on Client is nil-receiver safe (returns ErrDisabled).
func New(ctx context.Context, cfg Config) (*Client, error) {
	if strings.TrimSpace(cfg.Bucket) == "" {
		return nil, nil
	}
	region := strings.TrimSpace(cfg.Region)
	if region == "" {
		region = "ap-south-1"
	}
	awsCfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
	if err != nil {
		return nil, fmt.Errorf("aws config: %w", err)
	}
	s3c := s3.NewFromConfig(awsCfg)
	return &Client{
		bucket:    cfg.Bucket,
		region:    region,
		s3c:       s3c,
		presigner: s3.NewPresignClient(s3c),
	}, nil
}

// Bucket returns the configured bucket name (or "" when disabled).
// Handy for boot-time logs so a misconfigured deploy is loud.
func (c *Client) Bucket() string {
	if c == nil {
		return ""
	}
	return c.bucket
}

// Enabled reports whether S3 is configured. Handlers gate their s3
// path on this so the disk fallback still fires in dev.
func (c *Client) Enabled() bool { return c != nil && c.bucket != "" }

// URI builds the s3:// URI for a key, used when we want to store the
// full opaque locator in a DB column (as we do for
// institution_application_documents.storage_path).
func (c *Client) URI(key string) string {
	if c == nil {
		return ""
	}
	return "s3://" + c.bucket + "/" + strings.TrimLeft(key, "/")
}

// ParseURI splits an "s3://bucket/key" string back into components.
// Callers pass either an s3:// URI (S3-backed row) or a filesystem
// path (legacy disk row) — s3:// prefix is the discriminator.
func ParseURI(uri string) (bucket, key string, ok bool) {
	if !strings.HasPrefix(uri, "s3://") {
		return "", "", false
	}
	rest := uri[len("s3://"):]
	i := strings.IndexByte(rest, '/')
	if i <= 0 || i == len(rest)-1 {
		return "", "", false
	}
	return rest[:i], rest[i+1:], true
}

// ---------- Key helpers ----------

// PhotoKey is the S3 key for an enrolled candidate photo. Extension
// defaults to jpg — we've only ever accepted jpg gallery photos and
// keeping the extension stable makes migration scripts trivial.
func PhotoKey(examCode, roll string) string {
	return fmt.Sprintf("%s/photos/%s.jpg",
		safeSegment(examCode), safeSegment(roll))
}

// ProbeKey is the S3 key for a captured probe image kept for the PDF
// receipt. Not currently written by this package — reserved for a
// later migration of ArtifactDir/probes/.
func ProbeKey(examCode string, verifID int64) string {
	return fmt.Sprintf("%s/probes/%d.jpg", safeSegment(examCode), verifID)
}

// Biometric key layout mirrors the disk tree we've had since the CSV
// upload feature landed — one subdir per modality under the exam.
// Extensions are preserved as-is (an iris file might be .iso, .k7, or
// .bmp depending on the operator device, and we've historically kept
// that distinction so downstream tools can pick a decoder).

// FpImageKey is the S3 key for a fingerprint capture image (raw scan,
// pre-template-extraction). Example: NEET2/fingerprints/images/20002.bmp
func FpImageKey(examCode, roll, ext string) string {
	return fmt.Sprintf("%s/fingerprints/images/%s%s",
		safeSegment(examCode), safeSegment(roll), normExt(ext))
}

// FpTemplateKey is the S3 key for an extracted fingerprint template
// (FMR / ANSI / vendor-specific bytes). Example:
// NEET2/fingerprints/templates/20002.iso
func FpTemplateKey(examCode, roll, ext string) string {
	return fmt.Sprintf("%s/fingerprints/templates/%s%s",
		safeSegment(examCode), safeSegment(roll), normExt(ext))
}

// IrisKey is the S3 key for an iris capture. Example:
// NEET2/iris/20002.k7
func IrisKey(examCode, roll, ext string) string {
	return fmt.Sprintf("%s/iris/%s%s",
		safeSegment(examCode), safeSegment(roll), normExt(ext))
}

// normExt normalises an incoming extension: lowercase, leading-dot
// preserved (or added). Empty maps to ".bin" so a caller that lost the
// extension still gets a valid key.
func normExt(ext string) string {
	ext = strings.TrimSpace(strings.ToLower(ext))
	if ext == "" {
		return ".bin"
	}
	if !strings.HasPrefix(ext, ".") {
		ext = "." + ext
	}
	return ext
}

// PutBiometric uploads bytes at an already-composed key. Used by the
// bulk-import handler which computes the key via one of the *Key
// helpers above based on the request path. Overwrites silently.
func (c *Client) PutBiometric(ctx context.Context, key string, body []byte, mime string) error {
	if !c.Enabled() {
		return ErrDisabled
	}
	if mime == "" {
		mime = "application/octet-stream"
	}
	_, err := c.s3c.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      awsv2.String(c.bucket),
		Key:         awsv2.String(key),
		Body:        bytes.NewReader(body),
		ContentType: awsv2.String(mime),
	})
	return err
}

// DocKey is the S3 key for a KYC document uploaded via the register
// form. Uses application_id for tenant isolation + doc_id in the
// filename so re-uploads never collide.
func DocKey(appID, docID int64, docKind, ext string) string {
	ext = strings.TrimPrefix(strings.ToLower(strings.TrimSpace(ext)), ".")
	if ext == "" {
		ext = "bin"
	}
	return fmt.Sprintf("_kyc/applications/%d/%d_%s.%s",
		appID, docID, safeSegment(docKind), ext)
}

// safeSegment normalises a path segment so we can't produce keys that
// escape their prefix. The catalog UI already validates exam codes to
// [A-Z0-9-] but rolls come from CSVs.
func safeSegment(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "_"
	}
	s = strings.ReplaceAll(s, "/", "_")
	s = strings.ReplaceAll(s, "..", "_")
	return s
}

// ---------- Photo I/O ----------

// PutPhoto uploads bytes to <exam>/photos/<roll>.jpg with the given
// MIME. Overwrites silently.
func (c *Client) PutPhoto(ctx context.Context, examCode, roll string, body []byte, mime string) error {
	if !c.Enabled() {
		return ErrDisabled
	}
	if mime == "" {
		mime = "image/jpeg"
	}
	_, err := c.s3c.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      awsv2.String(c.bucket),
		Key:         awsv2.String(PhotoKey(examCode, roll)),
		Body:        bytes.NewReader(body),
		ContentType: awsv2.String(mime),
	})
	return err
}

// GetPhotoBytes fetches the enrolled gallery photo. Returns ErrNotFound
// when the object doesn't exist, so the face-match handler can 404
// with the same "candidate has no enrolled photo" message it uses on
// the disk path.
func (c *Client) GetPhotoBytes(ctx context.Context, examCode, roll string) ([]byte, error) {
	if !c.Enabled() {
		return nil, ErrDisabled
	}
	out, err := c.s3c.GetObject(ctx, &s3.GetObjectInput{
		Bucket: awsv2.String(c.bucket),
		Key:    awsv2.String(PhotoKey(examCode, roll)),
	})
	if err != nil {
		if isNotFound(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	defer out.Body.Close()
	// Cap at 8 MB — same ceiling MaxBytesReader gives us on the
	// operator's probe upload. A 200 KB gallery photo is typical.
	return io.ReadAll(io.LimitReader(out.Body, 8<<20))
}

// PhotoExists is a HeadObject probe used at CSV-upload time to flip
// exam_candidates.has_photo without paying the GET body cost.
func (c *Client) PhotoExists(ctx context.Context, examCode, roll string) (bool, error) {
	if !c.Enabled() {
		return false, ErrDisabled
	}
	_, err := c.s3c.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: awsv2.String(c.bucket),
		Key:    awsv2.String(PhotoKey(examCode, roll)),
	})
	if err != nil {
		if isNotFound(err) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

// PresignPhotoURL mints a short-lived signed URL the operator's
// browser can hit directly. Auth is enforced before the redirect
// upstream (in the getCandidatePhoto handler) — the signed URL is
// what lets the browser skip our EC2 for the actual bytes.
func (c *Client) PresignPhotoURL(ctx context.Context, examCode, roll string, ttl time.Duration) (string, error) {
	if !c.Enabled() {
		return "", ErrDisabled
	}
	if ttl <= 0 {
		ttl = 5 * time.Minute
	}
	req, err := c.presigner.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: awsv2.String(c.bucket),
		Key:    awsv2.String(PhotoKey(examCode, roll)),
	}, s3.WithPresignExpires(ttl))
	if err != nil {
		return "", err
	}
	return req.URL, nil
}

// ---------- Doc I/O ----------

// PutDoc uploads a KYC document. Returns the s3:// URI so the caller
// can write it straight into institution_application_documents.storage_path.
func (c *Client) PutDoc(ctx context.Context, appID, docID int64, docKind, ext string, body []byte, mime string) (string, error) {
	if !c.Enabled() {
		return "", ErrDisabled
	}
	key := DocKey(appID, docID, docKind, ext)
	if mime == "" {
		mime = "application/octet-stream"
	}
	_, err := c.s3c.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      awsv2.String(c.bucket),
		Key:         awsv2.String(key),
		Body:        bytes.NewReader(body),
		ContentType: awsv2.String(mime),
	})
	if err != nil {
		return "", err
	}
	return c.URI(key), nil
}

// GetDocBytes reads a document by its s3:// URI. Streams up to 20 MB
// (docs are capped at 10 MB by the upload handler; 20 is headroom).
func (c *Client) GetDocBytes(ctx context.Context, uri string) ([]byte, error) {
	if !c.Enabled() {
		return nil, ErrDisabled
	}
	b, key, ok := ParseURI(uri)
	if !ok {
		return nil, fmt.Errorf("not an s3 uri: %q", uri)
	}
	if b != c.bucket {
		// Cross-bucket reads aren't allowed — every URI we mint uses
		// our own bucket, so a foreign one is either a config drift
		// or an injection attempt.
		return nil, fmt.Errorf("bucket mismatch: uri=%s configured=%s", b, c.bucket)
	}
	out, err := c.s3c.GetObject(ctx, &s3.GetObjectInput{
		Bucket: awsv2.String(c.bucket),
		Key:    awsv2.String(key),
	})
	if err != nil {
		if isNotFound(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	defer out.Body.Close()
	return io.ReadAll(io.LimitReader(out.Body, 20<<20))
}

// DeleteDoc removes an object by s3:// URI. Idempotent — a not-found
// isn't an error. Used by registerDeleteDoc when the applicant swaps
// out an uploaded doc before submitting.
func (c *Client) DeleteDoc(ctx context.Context, uri string) error {
	if !c.Enabled() {
		return ErrDisabled
	}
	b, key, ok := ParseURI(uri)
	if !ok {
		return fmt.Errorf("not an s3 uri: %q", uri)
	}
	if b != c.bucket {
		return fmt.Errorf("bucket mismatch: uri=%s configured=%s", b, c.bucket)
	}
	_, err := c.s3c.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: awsv2.String(c.bucket),
		Key:    awsv2.String(key),
	})
	// DeleteObject silently succeeds on missing keys; the not-found
	// check is defensive in case the SDK ever changes that behavior.
	if err != nil && isNotFound(err) {
		return nil
	}
	return err
}

// ---------- Health ----------

// Probe checks that the configured bucket is reachable + we have at
// least list permission. Called once at server boot so a misconfigured
// role fails loudly in the log, not silently on the first face-match.
func (c *Client) Probe(ctx context.Context) error {
	if !c.Enabled() {
		return ErrDisabled
	}
	_, err := c.s3c.HeadBucket(ctx, &s3.HeadBucketInput{
		Bucket: awsv2.String(c.bucket),
	})
	return err
}

// ---------- Internals ----------

// isNotFound matches both the typed NoSuchKey/NotFound errors and the
// 404s that come back from HeadObject on missing keys.
func isNotFound(err error) bool {
	if err == nil {
		return false
	}
	var nsk *types.NoSuchKey
	if errors.As(err, &nsk) {
		return true
	}
	var nf *types.NotFound
	if errors.As(err, &nf) {
		return true
	}
	var ae smithy.APIError
	if errors.As(err, &ae) {
		code := ae.ErrorCode()
		if code == "NoSuchKey" || code == "NotFound" || code == "404" {
			return true
		}
	}
	return false
}

// Prevent goimports from stripping url in a future refactor — the
// presigner call above returns a URL string, but we may add a URL
// parser here later.
var _ = url.URL{}
