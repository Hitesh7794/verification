package sms

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestConsoleSender(t *testing.T) {
	sender := NewConsoleSender()
	err := sender.Send(context.Background(), "9876543210", "123456")
	if err != nil {
		t.Fatalf("ConsoleSender failed: %v", err)
	}
}

func TestAuthKeySender(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("authkey") != "testkey" {
			http.Error(w, "invalid authkey", http.StatusUnauthorized)
			return
		}
		if q.Get("mobile") != "9876543210" {
			http.Error(w, "invalid mobile", http.StatusBadRequest)
			return
		}
		if q.Get("var") != "654321" {
			http.Error(w, "invalid var", http.StatusBadRequest)
			return
		}
		if q.Get("company") != "seQRview" {
			http.Error(w, "invalid company", http.StatusBadRequest)
			return
		}
		if q.Get("sid") != "44529" {
			http.Error(w, "invalid sid", http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"success","message":"OTP Sent Successfully"}`))
	}))
	defer ts.Close()

	sender := NewAuthKeySender(AuthKeyConfig{
		BaseURL:     ts.URL,
		AuthKey:     "testkey",
		SID:         "44529",
		Company:     "seQRview",
		CountryCode: "91",
	})

	err := sender.Send(context.Background(), "+919876543210", "654321")
	if err != nil {
		t.Fatalf("AuthKeySender Send failed: %v", err)
	}
}
