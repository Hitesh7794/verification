// Command morfin-mock impersonates the MorfinAuth client service that
// would normally be installed via the vendor's .deb on an operator's
// laptop. It listens on localhost:8030 and responds with the same JSON
// envelopes the real daemon does, so the frontend can be developed and
// tested end-to-end without USB hardware in hand.
//
// A small /control endpoint flips the mock between failure modes (device
// disconnected, low-quality capture, match fail, etc.) so the frontend's
// state machine and auto-recovery can be exercised against realistic
// adversarial conditions.
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
// Keeping it tiny and mutex-protected lets the frontend test harness
// flip modes mid-session without restarting the mock.
type state struct {
	mu sync.RWMutex

	deviceConnected bool   // toggle the USB device's presence
	deviceModel     string // which model "is plugged in"
	deviceSerial    string

	captureQuality int // 1..100 reported on capture
	captureNfiq    int // 1..5 NFIQ score
	liveness       int // -1 unknown, 0 spoof, 1 live
	matchScore     int // returned by verify/match
	matchSucceeds  bool

	captureDelay time.Duration // simulate slow capture (e.g. 1500 ms)
	failNextN    int           // next N calls return generic error -1; auto-decrements
}

func newState() *state {
	return &state{
		deviceConnected: true,
		deviceModel:     "MFS500",
		deviceSerial:    "MOCK-SN-0001",
		captureQuality:  78,
		captureNfiq:     2,
		liveness:        1,
		matchScore:      74,
		matchSucceeds:   true,
		captureDelay:    900 * time.Millisecond,
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

// envelope is the response shape every MorFin endpoint returns. Note
// ErrorCode is a *string* in the real API, not an int — the JS client
// compares it with `==` against string literals like "0" and "-2027".
type envelope struct {
	ErrorCode        string `json:"ErrorCode"`
	ErrorDescription string `json:"ErrorDescription"`
}

// One pixel white BMP, base64-encoded. Stand-in for the captured fingerprint
// image so the frontend's <img src="data:image/bmp;base64,..."> renders.
const onePixelBMPb64 = "Qk1aAAAAAAAAAHYAAAAoAAAAAQAAAAEAAAABAAQAAAAAAAQAAAATCwAAEwsAABAAAAAAAAAAAAAAAAAAgAAAgAAAAICAAIAAAACAAIAAgIAAAMDAwACAgIAAAAD/AAD/AAAA//8A/wAAAP8A/wD//wAA////APAAAAA="

func main() {
	addr := flag.String("addr", ":8030", "listen address (default :8030 to mirror real daemon)")
	flag.Parse()

	st := newState()
	mux := http.NewServeMux()

	// Health/status (not a MorFin endpoint, just for human inspection).
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		fmt.Fprintf(w, "morfin-mock\n\nendpoints under /morfinauth/ — see vendor docs.\nflip state via POST /control with JSON like {\"deviceConnected\":false}.\n")
	})

	// Operator-facing endpoints: every MorFin call goes through here.
	mux.HandleFunc("/morfinauth/", func(w http.ResponseWriter, r *http.Request) {
		setCORS(w, r)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		method := strings.TrimPrefix(r.URL.Path, "/morfinauth/")
		method = strings.TrimSuffix(method, "/")
		method = strings.ToLower(method)

		// Read the JSON body; tolerate empty bodies (the spec allows
		// some endpoints to be called with no body).
		body := map[string]any{}
		if r.ContentLength > 0 {
			_ = json.NewDecoder(r.Body).Decode(&body)
		}
		log.Printf("morfinauth/%s body=%v", method, body)

		// One-shot fault injection: ensure we always claim an error before
		// any per-method logic executes.
		if st.consumeFailure() {
			writeJSON(w, map[string]any{
				"ErrorCode":        "-1",
				"ErrorDescription": "injected failure (mock /control failNextN)",
			})
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
		case "uninitdevice":
			handleUninit(w)
		case "capture":
			handleCapture(w, st, body)
		case "getimage":
			handleGetImage(w, body)
		case "gettemplate":
			handleGetTemplate(w, body)
		case "verify":
			handleVerify(w, st, body)
		case "match":
			handleMatch(w, st, body)
		default:
			writeJSON(w, envelope{
				ErrorCode:        "-9999",
				ErrorDescription: "unknown method: " + method,
			})
		}
	})

	// /control flips state knobs at runtime. Test harness uses this.
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
			CaptureQuality  *int    `json:"captureQuality"`
			CaptureNfiq     *int    `json:"captureNfiq"`
			Liveness        *int    `json:"liveness"`
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
		if patch.CaptureQuality != nil {
			st.captureQuality = *patch.CaptureQuality
		}
		if patch.CaptureNfiq != nil {
			st.captureNfiq = *patch.CaptureNfiq
		}
		if patch.Liveness != nil {
			st.liveness = *patch.Liveness
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

	log.Printf("morfin-mock listening on %s", *addr)
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

func handleSupportedList(w http.ResponseWriter) {
	writeJSON(w, envelope{
		ErrorCode:        "0",
		ErrorDescription: "Supported Devices: MELO041,MFS500,MARC10",
	})
}

func handleConnectedList(w http.ResponseWriter, st *state) {
	s := st.snapshot()
	if !s.deviceConnected {
		// Real daemon returns ErrorCode 0 with empty description when
		// nothing is plugged in. The HTML sample's parsing handles this.
		writeJSON(w, envelope{
			ErrorCode:        "0",
			ErrorDescription: "",
		})
		return
	}
	writeJSON(w, envelope{
		ErrorCode:        "0",
		ErrorDescription: "Found Devices: " + s.deviceModel,
	})
}

func handleCheckDevice(w http.ResponseWriter, st *state) {
	s := st.snapshot()
	if !s.deviceConnected {
		writeJSON(w, envelope{ErrorCode: "-2027", ErrorDescription: "device not connected"})
		return
	}
	writeJSON(w, envelope{ErrorCode: "0", ErrorDescription: "device present"})
}

type deviceInfo struct {
	SerialNo string `json:"SerialNo"`
	Make     string `json:"Make"`
	Model    string `json:"Model"`
	Width    int    `json:"Width"`
	Height   int    `json:"Height"`
}

func handleInfo(w http.ResponseWriter, st *state) {
	s := st.snapshot()
	if !s.deviceConnected {
		writeJSON(w, envelope{ErrorCode: "-2027", ErrorDescription: "device not connected"})
		return
	}
	writeJSON(w, struct {
		envelope
		DeviceInfo deviceInfo `json:"DeviceInfo"`
	}{
		envelope: envelope{ErrorCode: "0", ErrorDescription: "OK"},
		DeviceInfo: deviceInfo{
			SerialNo: s.deviceSerial,
			Make:     "Mantra",
			Model:    s.deviceModel,
			Width:    320,
			Height:   480,
		},
	})
}

func handleInit(w http.ResponseWriter, st *state) {
	s := st.snapshot()
	if !s.deviceConnected {
		writeJSON(w, envelope{ErrorCode: "-2027", ErrorDescription: "device not connected"})
		return
	}
	writeJSON(w, envelope{ErrorCode: "0", ErrorDescription: "init OK"})
}

func handleUninit(w http.ResponseWriter) {
	writeJSON(w, envelope{ErrorCode: "0", ErrorDescription: "uninit OK"})
}

func handleCapture(w http.ResponseWriter, st *state, body map[string]any) {
	s := st.snapshot()
	if !s.deviceConnected {
		writeJSON(w, envelope{ErrorCode: "-2027", ErrorDescription: "device not connected"})
		return
	}
	if s.captureDelay > 0 {
		time.Sleep(s.captureDelay)
	}
	resp := map[string]any{
		"ErrorCode":        "0",
		"ErrorDescription": "Capture Success",
		"BitmapData":       onePixelBMPb64,
		"Quality":          s.captureQuality,
		"Nfiq":             s.captureNfiq,
		"LiveNess_Result":  s.liveness,
	}
	_ = body // quality/timeout from body are honoured implicitly via state
	writeJSON(w, resp)
}

func handleGetImage(w http.ResponseWriter, body map[string]any) {
	writeJSON(w, map[string]any{
		"ErrorCode":        "0",
		"ErrorDescription": "OK",
		"ImgData":          base64.StdEncoding.EncodeToString([]byte("mock-image-bytes")),
	})
	_ = body
}

func handleGetTemplate(w http.ResponseWriter, body map[string]any) {
	// Return an FMR_V2005-shaped 24-byte template so frontend code that
	// inspects the magic bytes still works on the mock.
	tpl := []byte{'F', 'M', 'R', 0, ' ', '2', '0', 0,
		0, 0, 0, 24, // record length
		0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	}
	writeJSON(w, map[string]any{
		"ErrorCode":        "0",
		"ErrorDescription": "OK",
		"ImgData":          base64.StdEncoding.EncodeToString(tpl),
	})
	_ = body
}

func handleVerify(w http.ResponseWriter, st *state, body map[string]any) {
	probe, _ := body["ProbTemplate"].(string)
	gallery, _ := body["GalleryTemplate"].(string)
	if probe == "" || gallery == "" {
		writeJSON(w, envelope{ErrorCode: "-1", ErrorDescription: "templates required"})
		return
	}
	s := st.snapshot()
	writeJSON(w, map[string]any{
		"ErrorCode":        "0",
		"ErrorDescription": "OK",
		"Status":           s.matchSucceeds,
		"MatchScore":       s.matchScore,
	})
}

func handleMatch(w http.ResponseWriter, st *state, body map[string]any) {
	s := st.snapshot()
	if !s.deviceConnected {
		writeJSON(w, envelope{ErrorCode: "-2027", ErrorDescription: "device not connected"})
		return
	}
	if _, ok := body["GalleryTemplate"].(string); !ok {
		writeJSON(w, envelope{ErrorCode: "-1", ErrorDescription: "GalleryTemplate required"})
		return
	}
	if s.captureDelay > 0 {
		time.Sleep(s.captureDelay)
	}
	writeJSON(w, map[string]any{
		"ErrorCode":        "0",
		"ErrorDescription": "OK",
		"Status":           s.matchSucceeds,
		"MatchScore":       s.matchScore,
		"BitmapData":       onePixelBMPb64,
		"Quality":          s.captureQuality,
		"Nfiq":             s.captureNfiq,
		"LiveNess_Result":  s.liveness,
	})
}

// -- helpers --

func setCORS(w http.ResponseWriter, r *http.Request) {
	// The real MorFin daemon uses a permissive CORS policy because the
	// browser origin (the portal) is always different from localhost:8030.
	// We mirror that.
	origin := r.Header.Get("Origin")
	if origin == "" {
		origin = "*"
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Vary", "Origin")
	w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(v)
}
