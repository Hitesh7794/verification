package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/veni/neet-verification/internal/auth"
)

type ctxKey string

const claimsKey ctxKey = "claims"

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func (s *Server) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := r.Header.Get("Authorization")
		if !strings.HasPrefix(h, "Bearer ") {
			writeErr(w, http.StatusUnauthorized, "missing token")
			return
		}
		tok := strings.TrimPrefix(h, "Bearer ")
		c, err := s.deps.JWT.Parse(tok)
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "invalid token")
			return
		}
		ctx := context.WithValue(r.Context(), claimsKey, c)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func claimsFrom(r *http.Request) *auth.Claims {
	c, _ := r.Context().Value(claimsKey).(*auth.Claims)
	return c
}

func (s *Server) requireRole(roles ...string) func(http.HandlerFunc) http.HandlerFunc {
	allowed := map[string]bool{}
	for _, r := range roles {
		allowed[r] = true
	}
	return func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			c := claimsFrom(r)
			if c == nil || !allowed[c.Role] {
				writeErr(w, http.StatusForbidden, "forbidden")
				return
			}
			next(w, r)
		}
	}
}
