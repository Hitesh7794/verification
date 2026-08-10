package api

import (
	"crypto/rand"
	"math/big"
)

// passwordAlphabet excludes visually ambiguous glyphs so an admin can
// read the password aloud over a phone call or copy it from a printed
// page without 0/O or 1/l/I confusion. 49 chars * 12 positions ≈ 67
// bits of entropy, well above guessing thresholds even for a
// stationary credential.
const passwordAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"

// generateOperatorPassword returns a 12-character random password drawn
// from passwordAlphabet using crypto/rand. Used for the shared operator
// credential at org-approval time and on admin-triggered resets.
//
// Panics on rand failure — the only realistic cause is a broken
// /dev/urandom, in which case the server has bigger problems than this
// call and surfacing the error up the stack would just produce a
// confusing 500 from a code path that's logically infallible.
func generateOperatorPassword() string {
	const n = 12
	out := make([]byte, n)
	max := big.NewInt(int64(len(passwordAlphabet)))
	for i := 0; i < n; i++ {
		v, err := rand.Int(rand.Reader, max)
		if err != nil {
			panic("crypto/rand failed: " + err.Error())
		}
		out[i] = passwordAlphabet[v.Int64()]
	}
	return string(out)
}
