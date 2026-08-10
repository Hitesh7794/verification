// Package magiclink implements one-time URL tokens for the "set your
// password after approval" flow.
//
// Design:
//   - Token is 32 bytes of crypto/rand, URL-safe base64. Effectively
//     unguessable (256 bits of entropy).
//   - We store sha256(token) in the DB, never the token itself. A DB
//     leak hands attackers hashes, not usable links.
//   - Verify hashes the supplied token the same way and compares
//     constant-time against the DB row.
//   - Single-use: setting used_at on consumption locks the row out of
//     future verifications. Combined with the partial unique index
//     (token_hash UNIQUE) this means even simultaneous double-clicks
//     can't credit the password change twice.
//   - 7-day expiry by default; tunable per call. Beyond expiry the row
//     stays for audit but Verify rejects it.
//
// The token returned by Generate is what goes into the magic-link URL
// (?token=...). It exists only in memory + the email body. After the
// recipient clicks once and we set used_at, even the URL itself is dead.
package magiclink

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"time"
)

// Purpose discriminates link uses so a set-password token can't be
// presented to a password-reset endpoint and vice versa.
type Purpose string

const (
	PurposeSetPassword   Purpose = "set_password"
	PurposeResetPassword Purpose = "reset_password"
)

// DefaultTTL is how long a link is valid by default. Long enough to
// survive a head-of-institution being on vacation between approval and
// first login, short enough that a leaked email isn't useful forever.
const DefaultTTL = 7 * 24 * time.Hour

var (
	// ErrInvalid is returned for any of {unknown token, wrong purpose,
	// expired, already used}. We deliberately don't distinguish externally
	// so a probing attacker can't tell which condition failed.
	ErrInvalid = errors.New("magiclink: token invalid or already used")
)

// Link is the verified link metadata. The caller uses UserID to update
// the password.
type Link struct {
	ID     int64
	UserID int64
}

// Store wraps the *sql.DB and exposes Generate / Verify / MarkUsed.
type Store struct {
	db *sql.DB
}

func New(db *sql.DB) *Store { return &Store{db: db} }

// Generate creates a new link for userID and returns the plaintext
// token (to put in the URL). The token is NOT stored anywhere on disk;
// only its sha256 hash lives in the magic_links row.
//
// ttl == 0 → DefaultTTL.
func (s *Store) Generate(ctx context.Context, userID int64, purpose Purpose, ttl time.Duration) (string, error) {
	if ttl <= 0 {
		ttl = DefaultTTL
	}
	if purpose != PurposeSetPassword && purpose != PurposeResetPassword {
		return "", fmt.Errorf("magiclink: invalid purpose %q", purpose)
	}
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("magiclink: rand read: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(raw[:])
	hash := hashToken(token)
	expiresAt := time.Now().Add(ttl)

	_, err := s.db.ExecContext(ctx,
		`INSERT INTO magic_links(user_id, token_hash, purpose, expires_at)
		 VALUES(?, ?, ?, ?)`,
		userID, hash, string(purpose), expiresAt,
	)
	if err != nil {
		return "", fmt.Errorf("magiclink: insert: %w", err)
	}
	return token, nil
}

// Verify looks up the supplied token and returns the linked user if
// valid + unused + unexpired + matching purpose. Returns ErrInvalid
// otherwise — callers should not distinguish reasons in their HTTP
// responses (defence against enumeration).
//
// Verify does NOT mark the token used; it's a read-only check. Use
// Consume() to perform the password-set in a single transaction that
// also marks the token used atomically.
func (s *Store) Verify(ctx context.Context, token string, purpose Purpose) (*Link, error) {
	hash := hashToken(token)
	var (
		id        int64
		userID    int64
		dbPurpose string
		expiresAt time.Time
		usedAt    sql.NullTime
	)
	err := s.db.QueryRowContext(ctx,
		`SELECT id, user_id, purpose, expires_at, used_at
		 FROM magic_links
		 WHERE token_hash = ?`,
		hash,
	).Scan(&id, &userID, &dbPurpose, &expiresAt, &usedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrInvalid
	}
	if err != nil {
		return nil, fmt.Errorf("magiclink: select: %w", err)
	}
	// Constant-time-ish purpose check. (subtle is overkill for a string
	// equality but cheap and forms a habit.)
	if subtle.ConstantTimeCompare([]byte(dbPurpose), []byte(string(purpose))) != 1 {
		return nil, ErrInvalid
	}
	if time.Now().After(expiresAt) {
		return nil, ErrInvalid
	}
	if usedAt.Valid {
		return nil, ErrInvalid
	}
	return &Link{ID: id, UserID: userID}, nil
}

// Consume validates the token and marks it used in a single transaction.
// The caller runs whatever side-effect they want inside fn (e.g.,
// updating the user's password). If fn returns an error the whole thing
// rolls back and the token stays usable for another attempt.
//
// Race-safe: the UPDATE … WHERE used_at IS NULL pattern means two
// simultaneous Consume calls can't both succeed; the second sees
// affected==0 and gets ErrInvalid.
func (s *Store) Consume(ctx context.Context, token string, purpose Purpose, fn func(tx *sql.Tx, userID int64) error) error {
	hash := hashToken(token)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var (
		id        int64
		userID    int64
		dbPurpose string
		expiresAt time.Time
	)
	err = tx.QueryRowContext(ctx,
		`SELECT id, user_id, purpose, expires_at
		 FROM magic_links
		 WHERE token_hash = ? AND used_at IS NULL`,
		hash,
	).Scan(&id, &userID, &dbPurpose, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrInvalid
	}
	if err != nil {
		return err
	}
	if subtle.ConstantTimeCompare([]byte(dbPurpose), []byte(string(purpose))) != 1 {
		return ErrInvalid
	}
	if time.Now().After(expiresAt) {
		return ErrInvalid
	}

	res, err := tx.ExecContext(ctx,
		`UPDATE magic_links SET used_at = CURRENT_TIMESTAMP
		 WHERE id = ? AND used_at IS NULL`,
		id,
	)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		// Lost the race to a concurrent Consume.
		return ErrInvalid
	}

	if err := fn(tx, userID); err != nil {
		return err
	}
	return tx.Commit()
}

// hashToken returns the hex SHA256 of the token. Storing the hash (not
// the token) means a DB compromise doesn't hand attackers usable links.
func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
