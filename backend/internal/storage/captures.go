package storage

import (
	"bytes"
	"context"
	"fmt"
	"time"

	awsv2 "github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// Capture-blob storage (V10).
//
// Each successful verification produces raw biometric probes — the
// face frame the camera saw, the fingerprint template the RD service
// emitted, the iris payload from the Iritech RD service. These are
// distinct from the ENROLLMENT bytes (which live at
// <exam>/photos/<roll>.jpg etc. and are the source-of-truth reference
// from the exam board).
//
// Captures are stored under an INSTITUTE-scoped prefix so a regulator
// asking "show me every capture institute X ever did" is a single
// prefix scan:
//
//	<ORG_CODE>/<EXAM_CODE>/captures/YYYY-MM/<verification_id>/
//	    face.jpg          — the operator's camera frame
//	    fp.<ext>          — the FP template that went to TrustView
//	    iris.<ext>        — the iris PidData payload from RD Service
//	    meta.json         — device_serial, model, operator, scores, ts
//
// Two-stage write:
//
//  1. During /X-match the server has the probe bytes + an
//     idempotency_key but NOT a verification_id yet (the row is
//     created on /verifications submit). It writes each probe to a
//     temp key `_captures_temp/<idem_key>/<modality>.<ext>`.
//  2. During /verifications submit the server COPIES the temp objects
//     to their final institute-scoped location using the freshly
//     assigned verification_id, then DELETEs the temp objects. On
//     partial failure the temp objects survive as a poor-man's DLQ.

// CaptureTempKey is the temp-slot key used by /X-match handlers before
// the verification_id exists.
func CaptureTempKey(idemKey, modality, ext string) string {
	ext = normExt(ext)
	return fmt.Sprintf("_captures_temp/%s/%s.%s",
		safeSegment(idemKey), safeSegment(modality), ext)
}

// CaptureFinalKey is the institute-scoped audit key promoted to on
// /verifications submit.
func CaptureFinalKey(orgCode, examCode string, verifID int64, modality, ext string, when time.Time) string {
	ext = normExt(ext)
	return fmt.Sprintf("%s/%s/captures/%s/%d/%s.%s",
		safeSegment(orgCode), safeSegment(examCode),
		when.UTC().Format("2006-01"),
		verifID,
		safeSegment(modality), ext)
}

// CaptureMetaKey is the per-verification meta.json key that sits
// alongside the raw blobs.
func CaptureMetaKey(orgCode, examCode string, verifID int64, when time.Time) string {
	return fmt.Sprintf("%s/%s/captures/%s/%d/meta.json",
		safeSegment(orgCode), safeSegment(examCode),
		when.UTC().Format("2006-01"),
		verifID)
}

// CopyObject copies within the same bucket. Used by the promotion
// step: temp key → institute-scoped final key.
func (c *Client) CopyObject(ctx context.Context, srcKey, dstKey string) error {
	if !c.Enabled() {
		return ErrDisabled
	}
	// S3 CopySource wants "bucket/key" (URL-encoded, but the SDK
	// handles that when we pass the raw form via awsv2.String).
	src := c.bucket + "/" + srcKey
	_, err := c.s3c.CopyObject(ctx, &s3.CopyObjectInput{
		Bucket:     awsv2.String(c.bucket),
		Key:        awsv2.String(dstKey),
		CopySource: awsv2.String(src),
	})
	return err
}

// DeleteObject removes a single key. Best-effort — callers log and
// continue if this fails so a temp-cleanup miss doesn't cascade into
// a verification failure.
func (c *Client) DeleteObject(ctx context.Context, key string) error {
	if !c.Enabled() {
		return ErrDisabled
	}
	_, err := c.s3c.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: awsv2.String(c.bucket),
		Key:    awsv2.String(key),
	})
	return err
}

// PutJSON is a tiny convenience for writing the meta.json alongside
// the promoted blobs.
func (c *Client) PutJSON(ctx context.Context, key string, jsonBody []byte) error {
	if !c.Enabled() {
		return ErrDisabled
	}
	_, err := c.s3c.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      awsv2.String(c.bucket),
		Key:         awsv2.String(key),
		Body:        bytes.NewReader(jsonBody),
		ContentType: awsv2.String("application/json"),
	})
	return err
}
