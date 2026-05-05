// Command iris-mock impersonates the mantra-iris-service we'll ship as
// a .deb to operator laptops. It listens on localhost:8031 and answers
// the same JSON shapes the real Java service will return, so the
// frontend's iris fallback can be developed and tested without USB
// hardware.
//
// The endpoint convention mirrors morfin-mock: every method lives under
// /iris/<method>, returns {"ErrorCode": "0|<code>", "ErrorDescription":
// "...", ...data}. Strings for ErrorCode (not ints) so the frontend
// can compare with === '0' identically across both daemons.
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

// state captures every knob /control can flip. Keeping it tiny and
// mutex-protected lets a test harness change behaviour mid-session
// without restarting the mock.
type state struct {
	mu sync.RWMutex

	deviceConnected bool
	deviceModel     string // only "MIS100V2" is real, but we mirror the pattern
	deviceSerial    string

	leftQuality  int     // IrisAnatomy.quality for the left eye, 1-100
	rightQuality int     // ditto right
	leftScore    float64 // MatchImage output[0]
	rightScore   float64 // MatchImage output[1]
	matchSucceeds bool   // overall pass/fail

	captureDelay time.Duration
	failNextN    int
}

func newState() *state {
	return &state{
		deviceConnected: true,
		deviceModel:     "MIS100V2",
		deviceSerial:    "MOCK-IRIS-0001",
		leftQuality:     78,
		rightQuality:    81,
		leftScore:       0.78,
		rightScore:      0.82,
		matchSucceeds:   true,
		captureDelay:    1500 * time.Millisecond, // iris is slower than fingerprint
	}
}

func (s *state) snapshot() state {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return *s //nolint:govet
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

// Tiny 2x2 BMP base64. Stand-in for a captured iris image so the
// frontend can render <img src="data:image/bmp;base64,...">.
const placeholderBMPb64 = "Qk1aAAAAAAAAAHYAAAAoAAAAAQAAAAEAAAABAAQAAAAAAAQAAAATCwAAEwsAABAAAAAAAAAAAAAAAAAAgAAAgAAAAICAAIAAAACAAIAAgIAAAMDAwACAgIAAAAD/AAD/AAAA//8A/wAAAP8A/wD//wAA////APAAAAA="

type envelope struct {
	ErrorCode        string `json:"ErrorCode"`
	ErrorDescription string `json:"ErrorDescription"`
}

// MARVIS_AUTH_E_NO_DEVICE-ish — Marvis publishes its own error codes.
// We pick representative ones; the real service will emit Marvis's actual
// error numbers via GetErrorMessage().
const (
	errOK       = "0"
	errNoDevice = "-2027" // borrowed from MorFin convention so frontend can share state-machine code
	errBad      = "-1"
)

func main() {
	addr := flag.String("addr", ":8031", "listen address (default :8031, mirrors mantra-iris-service)")
	flag.Parse()

	st := newState()
	mux := http.NewServeMux()

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		fmt.Fprintf(w, "iris-mock\n\nendpoints under /iris/ — see docs/iris-api.md.\nflip state via POST /control.\n")
	})

	mux.HandleFunc("/iris/", func(w http.ResponseWriter, r *http.Request) {
		setCORS(w, r)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		method := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/iris/"), "/")
		method = strings.ToLower(method)

		body := map[string]any{}
		if r.ContentLength > 0 {
			_ = json.NewDecoder(r.Body).Decode(&body)
		}
		log.Printf("iris/%s body-keys=%v", method, mapKeys(body))

		if st.consumeFailure() {
			writeJSON(w, envelope{ErrorCode: errBad, ErrorDescription: "injected failure"})
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
		case "uninitdevice":
			handleUninit(w)
		case "capture":
			handleCapture(w, st, body)
		case "match":
			handleMatch(w, st, body)
		default:
			writeJSON(w, envelope{ErrorCode: "-9999", ErrorDescription: "unknown method: " + method})
		}
	})

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
			DeviceConnected *bool    `json:"deviceConnected"`
			DeviceModel     *string  `json:"deviceModel"`
			DeviceSerial    *string  `json:"deviceSerial"`
			LeftQuality     *int     `json:"leftQuality"`
			RightQuality    *int     `json:"rightQuality"`
			LeftScore       *float64 `json:"leftScore"`
			RightScore      *float64 `json:"rightScore"`
			MatchSucceeds   *bool    `json:"matchSucceeds"`
			CaptureDelayMs  *int     `json:"captureDelayMs"`
			FailNextN       *int     `json:"failNextN"`
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
		if patch.LeftQuality != nil {
			st.leftQuality = *patch.LeftQuality
		}
		if patch.RightQuality != nil {
			st.rightQuality = *patch.RightQuality
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

	log.Printf("iris-mock listening on %s", *addr)
	srv := &http.Server{Addr: *addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	if err := srv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}

// -- per-method handlers --

func handleSupported(w http.ResponseWriter) {
	writeJSON(w, envelope{ErrorCode: errOK, ErrorDescription: "Supported Devices: MIS100V2"})
}

func handleConnected(w http.ResponseWriter, st *state) {
	s := st.snapshot()
	if !s.deviceConnected {
		writeJSON(w, envelope{ErrorCode: errOK, ErrorDescription: ""})
		return
	}
	writeJSON(w, envelope{ErrorCode: errOK, ErrorDescription: "Found Devices: " + s.deviceModel})
}

func handleCheck(w http.ResponseWriter, st *state) {
	s := st.snapshot()
	if !s.deviceConnected {
		writeJSON(w, envelope{ErrorCode: errNoDevice, ErrorDescription: "device not connected"})
		return
	}
	writeJSON(w, envelope{ErrorCode: errOK, ErrorDescription: "device present"})
}

type irisDeviceInfo struct {
	SerialNo string `json:"SerialNo"`
	Make     string `json:"Make"`
	Model    string `json:"Model"`
	Width    int    `json:"Width"`
	Height   int    `json:"Height"`
	Firmware string `json:"Firmware"`
}

func handleInfo(w http.ResponseWriter, st *state) {
	s := st.snapshot()
	if !s.deviceConnected {
		writeJSON(w, envelope{ErrorCode: errNoDevice, ErrorDescription: "device not connected"})
		return
	}
	writeJSON(w, struct {
		envelope
		DeviceInfo irisDeviceInfo `json:"DeviceInfo"`
	}{
		envelope: envelope{ErrorCode: errOK, ErrorDescription: "OK"},
		DeviceInfo: irisDeviceInfo{
			SerialNo: s.deviceSerial,
			Make:     "Mantra",
			Model:    s.deviceModel,
			Width:    640,
			Height:   480,
			Firmware: "1.0.0-mock",
		},
	})
}

func handleInit(w http.ResponseWriter, st *state) {
	s := st.snapshot()
	if !s.deviceConnected {
		writeJSON(w, envelope{ErrorCode: errNoDevice, ErrorDescription: "device not connected"})
		return
	}
	writeJSON(w, envelope{ErrorCode: errOK, ErrorDescription: "init OK"})
}

func handleUninit(w http.ResponseWriter) {
	writeJSON(w, envelope{ErrorCode: errOK, ErrorDescription: "uninit OK"})
}

// handleCapture answers AutoCapture: synchronous, returns image bytes
// for both eyes plus per-eye quality (Marvis IrisAnatomy). The real
// service will return left+right images; we return one placeholder
// shared between them.
func handleCapture(w http.ResponseWriter, st *state, body map[string]any) {
	s := st.snapshot()
	if !s.deviceConnected {
		writeJSON(w, envelope{ErrorCode: errNoDevice, ErrorDescription: "device not connected"})
		return
	}
	if s.captureDelay > 0 {
		time.Sleep(s.captureDelay)
	}
	_ = body // minQuality / upperQuality / timeOut from body would tune capture; mock ignores
	writeJSON(w, map[string]any{
		"ErrorCode":        errOK,
		"ErrorDescription": "Capture Success",
		"Left":             eyeData(s.leftQuality),
		"Right":            eyeData(s.rightQuality),
	})
}

func eyeData(q int) map[string]any {
	return map[string]any{
		"Quality":   q,
		"BitmapB64": placeholderBMPb64,
		"IrisX":     320,
		"IrisY":     240,
		"IrisR":     90,
	}
}

// handleMatch wraps MarvisAuth.MatchImage. Body:
//
//	{
//	  "ProbLeft":  base64,    // probe (live) left iris bytes
//	  "ProbRight": base64,    // probe right
//	  "GalleryLeft":  base64, // enrolled left
//	  "GalleryRight": base64, // enrolled right
//	  "Format": "K7"          // RAW|BMP|JPEG2000|K3|K7
//	}
//
// At least one eye-pair must be supplied. Response is a per-eye score
// plus an aggregate Status (true if either eye passes the vendor's
// internal threshold).
func handleMatch(w http.ResponseWriter, st *state, body map[string]any) {
	s := st.snapshot()
	if !s.deviceConnected {
		writeJSON(w, envelope{ErrorCode: errNoDevice, ErrorDescription: "device not connected"})
		return
	}
	hasLeft := isB64(body["ProbLeft"]) && isB64(body["GalleryLeft"])
	hasRight := isB64(body["ProbRight"]) && isB64(body["GalleryRight"])
	if !hasLeft && !hasRight {
		writeJSON(w, envelope{ErrorCode: errBad, ErrorDescription: "at least one prob+gallery pair required"})
		return
	}
	out := map[string]any{
		"ErrorCode":        errOK,
		"ErrorDescription": "OK",
		"Status":           s.matchSucceeds,
	}
	if hasLeft {
		out["LeftScore"] = s.leftScore
	}
	if hasRight {
		out["RightScore"] = s.rightScore
	}
	writeJSON(w, out)
}

// -- helpers --

func setCORS(w http.ResponseWriter, r *http.Request) {
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

func mapKeys(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func isB64(v any) bool {
	s, ok := v.(string)
	if !ok || s == "" {
		return false
	}
	_, err := base64.StdEncoding.DecodeString(s)
	return err == nil
}
