// Command startek-mock impersonates the ACPL Capture API Windows service
// that would normally be installed via L1_API_Setup_30072025.msi on an
// operator laptop. It listens on localhost:8090 (HTTP — matches the dev
// test page in Setup_ACPL_L1_API/TestPages/) and responds with the same
// JSON envelopes the real service does, so the frontend can be developed
// and tested end-to-end on macOS / Linux without USB hardware in hand.
//
// The real ACPL API uses GET requests with query-string params and emits
// JSON. Documented endpoints we exercise:
//
//   GET /FM220/getserial                         - device info
//   GET /FM220/gettmpl                           - capture + return template
//   GET /FM220/GetMatchResult?MatchTmpl=<base64> - capture probe + 1:1 match
//                                                  against the supplied gallery
//
// A small /control endpoint flips the mock between failure modes (device
// disconnected, low match score, fail next N calls, etc.) so the frontend's
// state machine and auto-recovery can be exercised against realistic
// adversarial conditions. The /control surface mirrors morfin-mock's so
// the test harness is symmetric across vendors.
package main

import (
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

// state is the single mutable knob set the /control endpoint twiddles.
// Mirrors morfin-mock's state struct deliberately — the test harness can
// drive both mocks with the same control vocabulary.
type state struct {
	mu sync.RWMutex

	deviceConnected bool   // toggle the USB device's presence
	deviceModel     string // model identifier ("mi" field in real envelopes)
	deviceSerial    string // hardware serial returned by getserial
	deviceCode      string // "dc" field — vendor device-code certificate ID

	matchScore     int  // score returned by GetMatchResult
	matchSucceeds  bool // matchSuccess flag

	captureDelay time.Duration // simulate slow capture (e.g. 800 ms)
	failNextN    int           // next N calls return error envelope; auto-decrements
}

func newState() *state {
	return &state{
		deviceConnected: true,
		deviceModel:     "FM220U",
		deviceSerial:    "STK-MOCK-0001",
		deviceCode:      "00000000-0000-0000-0000-000000000000",
		matchScore:      72,
		matchSucceeds:   true,
		captureDelay:    800 * time.Millisecond,
	}
}

func (s *state) snapshot() state {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return *s //nolint:govet // copying with mutex; we discard the copy's lock state
}

func (s *state) consumeFailure() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failNextN > 0 {
		s.failNextN--
		return true
	}
	return false
}

// envelope is the response shape every ACPL Capture API endpoint returns.
// Field names match the real service exactly so the frontend client (which
// reads `errorCode`, `status`, `serialNumber`, etc.) doesn't need a
// special mock-vs-real switch.
//
// Note: errorCode is an int here (matches real service), whereas MorFin
// uses a string-typed ErrorCode. The frontend's startek.js handles this
// integer form natively.
type envelope struct {
	ErrorCode      int    `json:"errorCode"`
	Status         string `json:"status"`         // human-readable description
	SerialNumber   string `json:"serialNumber,omitempty"`
	DC             string `json:"dc,omitempty"`             // device code
	MI             string `json:"mi,omitempty"`             // model identifier
	TemplateBase64 string `json:"templateBase64,omitempty"` // ISO 19794-2 FMR probe template
	IsoImgBase64   string `json:"isoImgBase64,omitempty"`   // captured image bytes
	MatchSuccess   bool   `json:"matchSuccess,omitempty"`
	MatchScore     int    `json:"matchScore,omitempty"`
}

// A trivial 1x1 BMP byte string, base64-encoded. The real service returns
// a captured-image-shaped payload; this placeholder is just to keep the
// envelope shape complete during dev. The frontend never decodes
// isoImgBase64 — it's reserved for audit / artifacts.
const onePixelBMPb64 = "Qk0+AAAAAAAAADYAAAAoAAAAAQAAAAEAAAABABgAAAAAAAgAAAATCwAAEwsAAAAAAAAAAAAA/wAAAAAA"

// A tiny ISO 19794-2 FMR template stub. First 4 bytes are the FMR magic
// "FMR\0". We return a fixed sample on every gettmpl call (the mock has
// no real device to capture from); FingerprintCapture only treats it as
// opaque base64 to forward to the match endpoint.
var mockProbeTemplate = func() string {
	// FMR header magic + version stub + payload — enough that the
	// existing backend FMR auto-detector (in backend/internal/data/)
	// classifies it as FMR_V2005 if it ever inspects the bytes.
	buf := []byte{
		'F', 'M', 'R', 0x00, // magic
		' ', '2', '0', 0x00, // version (FMR V2005 wire = " 20\0")
	}
	// Pad to 64 bytes so it looks like a non-empty template.
	for len(buf) < 64 {
		buf = append(buf, 0)
	}
	return base64.StdEncoding.EncodeToString(buf)
}()

func main() {
	addr := flag.String("addr", ":8090", "listen address (default :8090 to mirror real ACPL service in HTTP mode)")
	flag.Parse()

	st := newState()
	mux := http.NewServeMux()

	// Health/status (not an ACPL endpoint, just for human inspection).
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			// Defer all /FM220/* + /control routing to the handlers below.
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/plain")
		fmt.Fprintf(w, "startek-mock (ACPL Capture API mock)\n\nendpoints under /FM220/ — see ACPL test page for the protocol.\nflip state via POST /control with JSON like {\"deviceConnected\":false}.\n")
	})

	// Operator-facing endpoints: every ACPL Capture API call goes here.
	mux.HandleFunc("/FM220/", func(w http.ResponseWriter, r *http.Request) {
		setCORS(w, r)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		method := strings.TrimPrefix(r.URL.Path, "/FM220/")
		method = strings.TrimSuffix(method, "/")
		log.Printf("FM220/%s query=%v", method, r.URL.Query())

		// One-shot fault injection: ensure we always claim an error before
		// any per-method logic executes.
		if st.consumeFailure() {
			writeJSON(w, envelope{
				ErrorCode: -1,
				Status:    "injected failure (mock /control failNextN)",
			})
			return
		}

		switch method {
		case "getserial":
			handleGetSerial(w, st)
		case "gettmpl":
			handleGetTmpl(w, st)
		case "GetMatchResult":
			handleGetMatchResult(w, st, r)
		default:
			writeJSON(w, envelope{
				ErrorCode: -9999,
				Status:    "unknown method: " + method,
			})
		}
	})

	// /control flips state knobs at runtime. Same vocabulary as
	// morfin-mock's /control for symmetry — only the supported keys differ
	// (Startek doesn't expose Quality / NFIQ / Liveness).
	mux.HandleFunc("/control", func(w http.ResponseWriter, r *http.Request) {
		setCORS(w, r)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method == http.MethodGet {
			writeJSON(w, st.snapshot())
			return
		}
		var patch struct {
			DeviceConnected *bool   `json:"deviceConnected"`
			DeviceModel     *string `json:"deviceModel"`
			DeviceSerial    *string `json:"deviceSerial"`
			DeviceCode      *string `json:"deviceCode"`
			MatchScore      *int    `json:"matchScore"`
			MatchSucceeds   *bool   `json:"matchSucceeds"`
			CaptureDelayMs  *int    `json:"captureDelayMs"`
			FailNextN       *int    `json:"failNextN"`
		}
		if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		st.mu.Lock()
		if patch.DeviceConnected != nil {
			st.deviceConnected = *patch.DeviceConnected
		}
		if patch.DeviceModel != nil {
			st.deviceModel = *patch.DeviceModel
		}
		if patch.DeviceSerial != nil {
			st.deviceSerial = *patch.DeviceSerial
		}
		if patch.DeviceCode != nil {
			st.deviceCode = *patch.DeviceCode
		}
		if patch.MatchScore != nil {
			st.matchScore = *patch.MatchScore
		}
		if patch.MatchSucceeds != nil {
			st.matchSucceeds = *patch.MatchSucceeds
		}
		if patch.CaptureDelayMs != nil {
			st.captureDelay = time.Duration(*patch.CaptureDelayMs) * time.Millisecond
		}
		if patch.FailNextN != nil {
			st.failNextN = *patch.FailNextN
		}
		now := *st //nolint:govet
		st.mu.Unlock()
		writeJSON(w, now)
	})

	log.Printf("startek-mock listening on %s", *addr)
	srv := &http.Server{
		Addr:              *addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	if err := srv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}

// -- per-method handlers --

func handleGetSerial(w http.ResponseWriter, st *state) {
	s := st.snapshot()
	if !s.deviceConnected {
		// Real ACPL returns errorCode != 0 when no device. Use -2 (a
		// commonly seen "device not found" code in their docs); kind
		// is detected by startek.js client based on the description
		// substring "no device".
		writeJSON(w, envelope{
			ErrorCode: -2,
			Status:    "no device connected",
		})
		return
	}
	writeJSON(w, envelope{
		ErrorCode:    0,
		Status:       "OK",
		SerialNumber: s.deviceSerial,
		DC:           s.deviceCode,
		MI:           s.deviceModel,
	})
}

func handleGetTmpl(w http.ResponseWriter, st *state) {
	s := st.snapshot()
	if !s.deviceConnected {
		writeJSON(w, envelope{
			ErrorCode: -2,
			Status:    "no device connected",
		})
		return
	}
	if s.captureDelay > 0 {
		time.Sleep(s.captureDelay)
	}
	writeJSON(w, envelope{
		ErrorCode:      0,
		Status:         "OK",
		SerialNumber:   s.deviceSerial,
		DC:             s.deviceCode,
		MI:             s.deviceModel,
		TemplateBase64: mockProbeTemplate,
		IsoImgBase64:   onePixelBMPb64,
	})
}

func handleGetMatchResult(w http.ResponseWriter, st *state, r *http.Request) {
	s := st.snapshot()
	if !s.deviceConnected {
		writeJSON(w, envelope{
			ErrorCode: -2,
			Status:    "no device connected",
		})
		return
	}
	gallery := r.URL.Query().Get("MatchTmpl")
	if gallery == "" {
		writeJSON(w, envelope{
			ErrorCode: -1,
			Status:    "MatchTmpl required",
		})
		return
	}
	// Simulate capture latency (the real service captures a probe before
	// matching against the supplied gallery).
	if s.captureDelay > 0 {
		time.Sleep(s.captureDelay)
	}
	writeJSON(w, envelope{
		ErrorCode:    0,
		Status:       "OK",
		SerialNumber: s.deviceSerial,
		MI:           s.deviceModel,
		MatchSuccess: s.matchSucceeds,
		MatchScore:   s.matchScore,
	})
}

// -- helpers --

func setCORS(w http.ResponseWriter, r *http.Request) {
	// The real ACPL service is reached from any portal origin; mirror its
	// permissive CORS policy so dev-time fetches from localhost:5173 work.
	origin := r.Header.Get("Origin")
	if origin == "" {
		origin = "*"
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Vary", "Origin")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(v)
}
