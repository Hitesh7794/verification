package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/veni/neet-verification/internal/email"
)

var (
	// Rate limiter for OTP sending: max 15 requests per 10 minutes per IP
	otpSendLimiter = newRegisterLimiter(15, 10*time.Minute)
)

type sendEmailOTPReq struct {
	Email   string `json:"email"`
	Purpose string `json:"purpose"`
}

type verifyEmailOTPReq struct {
	Email   string `json:"email"`
	Code    string `json:"code"`
	Purpose string `json:"purpose"`
}

type sendSmsOTPReq struct {
	Mobile  string `json:"mobile"`
	Purpose string `json:"purpose"`
}

type verifySmsOTPReq struct {
	Mobile  string `json:"mobile"`
	Code    string `json:"code"`
	Purpose string `json:"purpose"`
}

type otpVerifyResp struct {
	Verified bool   `json:"verified"`
	Token    string `json:"token"`
}

// POST /api/otp/send-email
func (s *Server) sendEmailOTP(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if shouldRateLimit(ip) && !otpSendLimiter.allow(ip) {
		writeErr(w, http.StatusTooManyRequests, "Too many OTP requests. Please try again later.")
		return
	}

	var req sendEmailOTPReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}

	target := strings.ToLower(strings.TrimSpace(req.Email))
	if target == "" || !reEmail.MatchString(target) {
		writeErr(w, http.StatusBadRequest, "valid email address is required")
		return
	}

	purpose := strings.TrimSpace(req.Purpose)
	if purpose == "" {
		purpose = "registration"
	}

	code, err := s.otpStore.Generate(purpose, target)
	if err != nil {
		writeErr(w, http.StatusTooManyRequests, err.Error())
		return
	}

	// Send email via configured sender
	subject := fmt.Sprintf("Your Verification Code: %s", code)
	body := fmt.Sprintf("Hello,\n\nYour verification code is: %s\n\nThis code will expire in 10 minutes. If you did not request this code, please ignore this email.\n\n— Verification Portal", code)

	if err := s.emailer.Send(r.Context(), email.Message{
		To:      target,
		Subject: subject,
		Body:    body,
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "Failed to send email OTP: "+err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"message": "Verification code sent to your email",
	})
}

// POST /api/otp/verify-email
func (s *Server) verifyEmailOTP(w http.ResponseWriter, r *http.Request) {
	var req verifyEmailOTPReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}

	target := strings.ToLower(strings.TrimSpace(req.Email))
	code := strings.TrimSpace(req.Code)
	purpose := strings.TrimSpace(req.Purpose)
	if purpose == "" {
		purpose = "registration"
	}

	if target == "" || code == "" {
		writeErr(w, http.StatusBadRequest, "email and code are required")
		return
	}

	token, err := s.otpStore.Verify(purpose, target, code)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, otpVerifyResp{
		Verified: true,
		Token:    token,
	})
}

// POST /api/otp/send-sms
func (s *Server) sendSmsOTP(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if shouldRateLimit(ip) && !otpSendLimiter.allow(ip) {
		writeErr(w, http.StatusTooManyRequests, "Too many OTP requests. Please try again later.")
		return
	}

	var req sendSmsOTPReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}

	// Normalise mobile: strip country code and spaces
	mobile := strings.TrimSpace(req.Mobile)
	if strings.HasPrefix(mobile, "+91") {
		mobile = strings.TrimPrefix(mobile, "+91")
	} else if strings.HasPrefix(mobile, "91") && len(mobile) == 12 {
		mobile = mobile[2:]
	}
	mobile = strings.TrimSpace(mobile)

	if !reMobile.MatchString(mobile) {
		writeErr(w, http.StatusBadRequest, "enter a valid 10-digit Indian mobile number")
		return
	}

	purpose := strings.TrimSpace(req.Purpose)
	if purpose == "" {
		purpose = "registration"
	}

	code, err := s.otpStore.Generate(purpose, mobile)
	if err != nil {
		writeErr(w, http.StatusTooManyRequests, err.Error())
		return
	}

	if err := s.smsSender.Send(r.Context(), mobile, code); err != nil {
		writeErr(w, http.StatusInternalServerError, "Failed to send SMS OTP: "+err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"message": "Verification code sent via SMS",
	})
}

// POST /api/otp/verify-sms
func (s *Server) verifySmsOTP(w http.ResponseWriter, r *http.Request) {
	var req verifySmsOTPReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}

	mobile := strings.TrimSpace(req.Mobile)
	if strings.HasPrefix(mobile, "+91") {
		mobile = strings.TrimPrefix(mobile, "+91")
	} else if strings.HasPrefix(mobile, "91") && len(mobile) == 12 {
		mobile = mobile[2:]
	}
	mobile = strings.TrimSpace(mobile)

	code := strings.TrimSpace(req.Code)
	purpose := strings.TrimSpace(req.Purpose)
	if purpose == "" {
		purpose = "registration"
	}

	if mobile == "" || code == "" {
		writeErr(w, http.StatusBadRequest, "mobile and code are required")
		return
	}

	token, err := s.otpStore.Verify(purpose, mobile, code)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, otpVerifyResp{
		Verified: true,
		Token:    token,
	})
}
