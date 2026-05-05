package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newTestHandler() http.Handler {
	st := newState()
	st.captureDelay = 0
	mux := http.NewServeMux()
	mux.HandleFunc("/iris/", func(w http.ResponseWriter, r *http.Request) {
		setCORS(w, r)
		method := strings.ToLower(strings.TrimPrefix(r.URL.Path, "/iris/"))
		body := map[string]any{}
		if r.ContentLength > 0 {
			_ = json.NewDecoder(r.Body).Decode(&body)
		}
		if st.consumeFailure() {
			writeJSON(w, envelope{ErrorCode: errBad, ErrorDescription: "injected"})
			return
		}
		switch method {
		case "supporteddevicelist":
			handleSupported(w)
		case "connecteddevicelist":
			handleConnected(w, st)
		case "checkdevice":
			handleCheck(w, st)
		case "info":
			handleInfo(w, st)
		case "initdevice":
			handleInit(w, st)
		case "capture":
			handleCapture(w, st, body)
		case "match":
			handleMatch(w, st, body)
		}
	})
	mux.HandleFunc("/control", func(w http.ResponseWriter, r *http.Request) {
		var patch struct {
			DeviceConnected *bool    `json:"deviceConnected"`
			LeftScore       *float64 `json:"leftScore"`
			RightScore      *float64 `json:"rightScore"`
			MatchSucceeds   *bool    `json:"matchSucceeds"`
			FailNextN       *int     `json:"failNextN"`
		}
		_ = json.NewDecoder(r.Body).Decode(&patch)
		st.mu.Lock()
		if patch.DeviceConnected != nil {
			st.deviceConnected = *patch.DeviceConnected
		}
		if patch.LeftScore != nil {
			st.leftScore = *patch.LeftScore
		}
		if patch.RightScore != nil {
			st.rightScore = *patch.RightScore
		}
		if patch.MatchSucceeds != nil {
			st.matchSucceeds = *patch.MatchSucceeds
		}
		if patch.FailNextN != nil {
			st.failNextN = *patch.FailNextN
		}
		st.mu.Unlock()
		w.WriteHeader(204)
	})
	return mux
}

func roundTrip(t *testing.T, h http.Handler, method string, body any) map[string]any {
	t.Helper()
	var buf bytes.Buffer
	_ = json.NewEncoder(&buf).Encode(body)
	req := httptest.NewRequest("POST", "/iris/"+method, &buf)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 200 {
		t.Fatalf("%s status %d: %s", method, rr.Code, rr.Body)
	}
	out := map[string]any{}
	if err := json.NewDecoder(rr.Body).Decode(&out); err != nil {
		t.Fatalf("decode %s: %v", method, err)
	}
	return out
}

func setControl(t *testing.T, h http.Handler, body any) {
	t.Helper()
	var buf bytes.Buffer
	_ = json.NewEncoder(&buf).Encode(body)
	req := httptest.NewRequest("POST", "/control", &buf)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
}

func TestCaptureReturnsBothEyes(t *testing.T) {
	h := newTestHandler()
	got := roundTrip(t, h, "capture",
		map[string]any{"MinQuality": 50, "UpperQuality": 95, "TimeOut": 10000})
	if got["ErrorCode"] != "0" {
		t.Fatalf("capture: %v", got)
	}
	for _, eye := range []string{"Left", "Right"} {
		e, ok := got[eye].(map[string]any)
		if !ok {
			t.Fatalf("%s missing", eye)
		}
		if _, ok := e["BitmapB64"].(string); !ok {
			t.Errorf("%s.BitmapB64 missing", eye)
		}
		if _, ok := e["Quality"]; !ok {
			t.Errorf("%s.Quality missing", eye)
		}
	}
}

func TestMatchHappyPath(t *testing.T) {
	h := newTestHandler()
	probe := base64.StdEncoding.EncodeToString([]byte("probe-bytes"))
	gallery := base64.StdEncoding.EncodeToString([]byte("gallery-bytes"))
	got := roundTrip(t, h, "match", map[string]any{
		"ProbLeft": probe, "GalleryLeft": gallery,
		"ProbRight": probe, "GalleryRight": gallery,
		"Format": "K7",
	})
	if got["Status"] != true {
		t.Errorf("expected status=true, got %v", got)
	}
	if got["LeftScore"] == nil || got["RightScore"] == nil {
		t.Errorf("missing per-eye score: %v", got)
	}
}

func TestMatchRejectsEmptyTemplates(t *testing.T) {
	h := newTestHandler()
	got := roundTrip(t, h, "match", map[string]any{})
	if got["ErrorCode"] != "-1" {
		t.Errorf("expected -1, got %v", got)
	}
}

func TestDeviceDisconnect(t *testing.T) {
	h := newTestHandler()
	setControl(t, h, map[string]any{"deviceConnected": false})
	for _, m := range []string{"checkdevice", "info", "capture", "match"} {
		got := roundTrip(t, h, m, nil)
		if got["ErrorCode"] != "-2027" {
			t.Errorf("%s: expected -2027, got %v", m, got)
		}
	}
}

func TestMatchFailMode(t *testing.T) {
	h := newTestHandler()
	setControl(t, h, map[string]any{"matchSucceeds": false, "leftScore": 0.21, "rightScore": 0.18})
	probe := base64.StdEncoding.EncodeToString([]byte("p"))
	gallery := base64.StdEncoding.EncodeToString([]byte("g"))
	got := roundTrip(t, h, "match", map[string]any{
		"ProbLeft": probe, "GalleryLeft": gallery,
	})
	if got["Status"] != false {
		t.Errorf("expected fail, got %v", got)
	}
	if got["LeftScore"].(float64) > 0.5 {
		t.Errorf("expected low left score, got %v", got["LeftScore"])
	}
}
