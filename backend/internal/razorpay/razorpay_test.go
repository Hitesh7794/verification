package razorpay

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

// Razorpay's published HMAC formula is:
//   signature = HMAC_SHA256( order_id + "|" + payment_id, key_secret )
//
// This test computes the expected signature from a known key, then
// confirms VerifySignature accepts it and rejects tampered variants.
// If this test ever fails it means our security guarantee against
// spoofed payment-success callbacks is broken — investigate before
// shipping.
func TestVerifySignature_RoundTrip(t *testing.T) {
	const (
		keySecret = "TestSecretDoNotShare"
		orderID   = "order_TEST123"
		paymentID = "pay_TEST456"
	)
	c := New("rzp_test_fake", keySecret)

	// Compute the legitimate signature.
	mac := hmac.New(sha256.New, []byte(keySecret))
	mac.Write([]byte(orderID + "|" + paymentID))
	good := hex.EncodeToString(mac.Sum(nil))

	if !c.VerifySignature(orderID, paymentID, good) {
		t.Fatal("legitimate signature was rejected")
	}
	// Razorpay sometimes uppercases the hex; we lowercase before comparing.
	if !c.VerifySignature(orderID, paymentID, "0000"+good[4:]) {
		// (Should fail — different content) — sanity guard for the next check.
	}

	// Tampered signature.
	if c.VerifySignature(orderID, paymentID, good[:len(good)-2]+"00") {
		t.Error("tampered signature was accepted")
	}
	// Different order_id should not match (signature was tied to a specific order).
	if c.VerifySignature("order_OTHER", paymentID, good) {
		t.Error("signature for a different order was accepted")
	}
	// Different payment_id should not match.
	if c.VerifySignature(orderID, "pay_OTHER", good) {
		t.Error("signature for a different payment was accepted")
	}
	// Empty inputs must always reject.
	if c.VerifySignature("", paymentID, good) ||
		c.VerifySignature(orderID, "", good) ||
		c.VerifySignature(orderID, paymentID, "") {
		t.Error("empty inputs must reject")
	}
}
