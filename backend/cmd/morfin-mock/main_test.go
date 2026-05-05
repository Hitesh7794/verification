package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// roundTrip is a helper that POSTs a JSON body to the mock's /morfinauth/
// surface using the same handler the live binary registers.
func roundTrip(t *testing.T, h http.Handler, method string, body any) map[string]any {
	t.Helper()
	var buf bytes.Buffer
	_ = json.NewEncoder(&buf).Encode(body)
	req := httptest.NewRequest("POST", "/morfinauth/"+method, &buf)
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

// build a handler the same way main() does (without listening). Lets us
// test endpoints without binding ports.
func newTestHandler() http.Handler {
	st := newState()
	st.captureDelay = 0 // tests should not wait
	mux := http.NewServeMux()
	mux.HandleFunc("/morfinauth/", func(w http.ResponseWriter, r *http.Request) {
		setCORS(w, r)
		method := strings.TrimPrefix(r.URL.Path, "/morfinauth/")
		method = strings.ToLower(method)
		body := map[string]any{}
		if r.ContentLength > 0 {
			_ = json.NewDecoder(r.Body).Decode(&body)
		}
		if st.consumeFailure() {
			writeJSON(w, map[string]any{"ErrorCode": "-1", "ErrorDescription": "injected"})
			return
		}
		switch method {
		case "supporteddevicelist":
			handleSupportedList(w)
		case "connecteddevicelist":
			handleConnectedList(w, st)
		case "checkdevice":
			handleCheckDevice(w, st)
		case "info":
			handleInfo(w, st)
		case "initdevice":
			handleInit(w, st)
		case "capture":
			handleCapture(w, st, body)
		case "verify":
			handleVerify(w, st, body)
		case "match":
			handleMatch(w, st, body)
		case "gettemplate":
			handleGetTemplate(w, body)
		}
	})
	mux.HandleFunc("/control", func(w http.ResponseWriter, r *http.Request) {
		var patch struct {
			DeviceConnected *bool `json:"deviceConnected"`
			MatchSucceeds   *bool `json:"matchSucceeds"`
			MatchScore      *int  `json:"matchScore"`
			FailNextN       *int  `json:"failNextN"`
		}
		_ = json.NewDecoder(r.Body).Decode(&patch)
		st.mu.Lock()
		if patch.DeviceConnected != nil {
			st.deviceConnected = *patch.DeviceConnected
		}
		if patch.MatchSucceeds != nil {
			st.matchSucceeds = *patch.MatchSucceeds
		}
		if patch.MatchScore != nil {
			st.matchScore = *patch.MatchScore
		}
		if patch.FailNextN != nil {
			st.failNextN = *patch.FailNextN
		}
		st.mu.Unlock()
		w.WriteHeader(204)
	})
	return mux
}

func setControl(t *testing.T, h http.Handler, body any) {
	t.Helper()
	var buf bytes.Buffer
	_ = json.NewEncoder(&buf).Encode(body)
	req := httptest.NewRequest("POST", "/control", &buf)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
}

func TestHappyPath_CaptureAndMatch(t *testing.T) {
	h := newTestHandler()

	got := roundTrip(t, h, "supporteddevicelist", nil)
	if !strings.Contains(got["ErrorDescription"].(string), "MFS500") {
		t.Errorf("supported list missing MFS500: %v", got)
	}

	got = roundTrip(t, h, "connecteddevicelist", nil)
	if !strings.Contains(got["ErrorDescription"].(string), "Found Devices:") {
		t.Errorf("connected list shape: %v", got)
	}

	got = roundTrip(t, h, "info", nil)
	if got["ErrorCode"] != "0" {
		t.Errorf("info: %v", got)
	}
	di, _ := got["DeviceInfo"].(map[string]any)
	if di["SerialNo"] == nil || di["Model"] == nil {
		t.Errorf("DeviceInfo incomplete: %v", di)
	}

	got = roundTrip(t, h, "capture", map[string]any{"Quality": 60, "TimeOut": 10})
	if got["ErrorCode"] != "0" {
		t.Errorf("capture: %v", got)
	}
	bd, _ := got["BitmapData"].(string)
	if _, err := base64.StdEncoding.DecodeString(bd); err != nil {
		t.Errorf("BitmapData not valid base64: %v", err)
	}

	tpl := roundTrip(t, h, "gettemplate", map[string]any{"TmpFormat": 0})
	galleryB64, _ := tpl["ImgData"].(string)
	got = roundTrip(t, h, "match", map[string]any{
		"Quality": 60, "TimeOut": 10, "GalleryTemplate": galleryB64, "TmpFormat": 0,
	})
	if got["Status"] != true {
		t.Errorf("match should succeed by default: %v", got)
	}
}

func TestDeviceDisconnectedReturns2027(t *testing.T) {
	h := newTestHandler()
	setControl(t, h, map[string]any{"deviceConnected": false})

	for _, m := range []string{"checkdevice", "info", "initdevice", "capture"} {
		got := roundTrip(t, h, m, nil)
		if got["ErrorCode"] != "-2027" {
			t.Errorf("%s should be -2027 when disconnected, got %v", m, got)
		}
	}
}

func TestMatchFailMode(t *testing.T) {
	h := newTestHandler()
	setControl(t, h, map[string]any{"matchSucceeds": false, "matchScore": 22})

	tpl := roundTrip(t, h, "gettemplate", nil)
	gallery, _ := tpl["ImgData"].(string)
	got := roundTrip(t, h, "match", map[string]any{"GalleryTemplate": gallery, "TmpFormat": 0})
	if got["Status"] != false {
		t.Errorf("expected match fail, got %v", got["Status"])
	}
	if got["MatchScore"].(float64) != 22 {
		t.Errorf("expected score 22, got %v", got["MatchScore"])
	}
}

func TestFailureInjection(t *testing.T) {
	h := newTestHandler()
	setControl(t, h, map[string]any{"failNextN": 2})

	for i := 0; i < 2; i++ {
		got := roundTrip(t, h, "capture", nil)
		if got["ErrorCode"] != "-1" {
			t.Errorf("call %d: expected injected error, got %v", i, got)
		}
	}
	// Third call should succeed.
	got := roundTrip(t, h, "capture", nil)
	if got["ErrorCode"] != "0" {
		t.Errorf("after fail-window: expected 0, got %v", got)
	}
}

// Sanity check that the response body is valid JSON when called via a
// fresh httptest.Server (catches any handler-level panics or premature
// connection close that wouldn't show up in the recorder-based tests).
func TestEndToEndOverHTTP(t *testing.T) {
	srv := httptest.NewServer(newTestHandler())
	defer srv.Close()
	resp, err := http.Post(srv.URL+"/morfinauth/supporteddevicelist", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	b, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(b), "MFS500") {
		t.Errorf("body unexpected: %s", b)
	}
}
