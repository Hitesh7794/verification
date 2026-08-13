// Promise/fetch client for the Marvis Auth Client Service running on
// localhost:8031 (the native Windows daemon shipped as
// MarvisAuthClientService.exe by Mantra, v1.4.0.0+).
//
// This replaces the earlier WSL2 + Java iris-service pipeline that
// worked around Mantra's broken Windows JNI DLLs in v1.0. The new
// Windows Web SDK runs natively as a service, so the browser talks to
// http://localhost:8031/marvisauth/* directly — no JVM, no WSL, no
// usbipd. See client-bootstrap/windows/README.md for install details.
//
// Wire shape mirrors the vendor sample (SDKSample/marvisauth.js in
// the SDK bundle). Error envelope: every response carries
//   { ErrorCode: "0", ErrorDescription: "..." , ...method-specific fields }
// ErrorCode "0" = success; anything else is an SDK / device error.

const DEFAULT_BASE =
  import.meta.env.VITE_IRIS_BASE || 'http://localhost:8031/marvisauth/'

let _base = DEFAULT_BASE
export function setIrisBase(url) {
  _base = url.endsWith('/') ? url : url + '/'
}

// ImgFormat enum values used by /getimage + /match + /verify. Verified
// against the vendor manual (Marvis_Auth_Windows_Web_SDK_1.4.0.0.pdf).
// Default is ISO — the interoperable choice, matches what SourceAFIS
// and other 1:1 matchers expect. Keeping the numeric map local so
// callers can pass a readable string.
export const IMG_FORMAT = {
  ISO: 0,     // ISO/IEC 19794-6 iris record
  ANSI: 1,    // ANSI/INCITS 379
  RAW: 2,     // Raw pixels
}

export class IrisError extends Error {
  constructor(kind, code, description) {
    super(description)
    this.name = 'IrisError'
    this.kind = kind // 'service' | 'device' | 'sdk' | 'http'
    this.code = code
    this.description = description
  }
}

async function call(method, body) {
  const url = _base + method
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Vendor's info + uninit methods don't need a body; sample passes
    // "" and skips `data` in jQuery. fetch doesn't need us to
    // discriminate — undefined body is fine.
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    throw new IrisError('http', res.status, `HTTP ${res.status}`)
  }
  return res.json()
}

function check(env) {
  if (env && String(env.ErrorCode) === '0') return null
  const code = String(env?.ErrorCode ?? '-9999')
  const desc = env?.ErrorDescription ?? 'unknown error'
  // The vendor SDK signals "no device connected" via a distinct code
  // in v1.4 — the exact number isn't documented in the sample, but
  // any non-zero from /info or /capture with no device attached maps
  // to 'device' so the UI can render a helpful "plug the scanner in"
  // banner instead of a generic error. Tune this after live testing.
  let kind = 'sdk'
  if (/device.*not.*(found|connected)/i.test(desc)) kind = 'device'
  return new IrisError(kind, code, desc)
}

async function safeCall(method, body) {
  let env
  try {
    env = await call(method, body)
  } catch (e) {
    if (e instanceof IrisError) throw e
    throw new IrisError('service', null, e.message || 'service unavailable')
  }
  const err = check(env)
  if (err) throw err
  return env
}

// Public API. Deliberately narrower than the old Java-service wrapper
// because the new SDK folds several ops together (capture+match in
// one call) and doesn't expose device enumeration — MarvisAuth
// v1.4 assumes one attached device and auto-inits on first use.
export const iris = {
  // GET service info — probes that the daemon is running + returns
  // vendor/version metadata. Returns the raw envelope.
  async getInfo() {
    return safeCall('info')
  },

  // Capture a single iris image. `quality` gates the min quality
  // score (1..100) the SDK will accept before returning. `timeoutMs`
  // is the wall-clock ceiling. Returns { BitmapData (base64 BMP),
  // Quality, ErrorCode }.
  //
  // Capture strategy (post multiple SDK-quirk iterations):
  //
  // The Marvis daemon accumulates internal state across /info + /uninit
  // calls -- even calling /info once per component mount was enough to
  // drift the SDK into a -2014 "Device Already Initialized" state
  // after ~5-10 verifications. Only a Windows service restart clears
  // it fully; from the API we can only retry with escalating hard
  // resets.
  //
  // The recovery ladder below is deliberately aggressive:
  //   1. Try /capture (fast path — device already in a good state)
  //   2. On -2014: uninit + wait + capture (skip /info; /capture
  //      auto-inits from DISCONNECTED so we avoid the double-init
  //      that pollutes SDK state)
  //   3. Still -2014: longer wait + uninit + info + capture
  //   4. Still -2014: give up with a clear "Restart Marvis service"
  //      message the operator can act on
  //   5. On -1309 "not initialized": /info + retry (rare — only
  //      happens if the device was disconnected mid-flow)
  async capture({ quality = 55, timeoutMs = 10000 } = {}) {
    const args = { TimeOut: timeoutMs, Quality: quality }
    // eslint-disable-next-line no-console
    const trace = (...m) => console.info('[iris]', ...m)
    trace('capture: attempt 1 (direct)')
    try {
      return await safeCall('capture', args)
    } catch (e) {
      if (!(e instanceof IrisError)) throw e
      const desc = e.description || ''
      trace('capture: attempt 1 failed', e.code, desc)
      if (/not.*initial/i.test(desc)) {
        trace('recover: info -> capture')
        try { await safeCall('info') } catch (x) { trace('info err', x?.description) }
        return await safeCall('capture', args)
      }
      if (/already.*initial/i.test(desc)) {
        // Attempt 2: uninit + short wait + retry (no /info -- let
        // /capture auto-init from a clean DISCONNECTED state).
        trace('recover: uninit -> wait 500ms -> capture (attempt 2)')
        try { await safeCall('uninit') } catch (x) { trace('uninit err', x?.description) }
        await new Promise((r) => setTimeout(r, 500))
        try {
          return await safeCall('capture', args)
        } catch (e2) {
          if (!(e2 instanceof IrisError) || !/already.*initial/i.test(e2.description || '')) {
            throw e2
          }
          trace('capture: attempt 2 failed', e2.code, e2.description)
        }
        // Attempt 3: longer wait + uninit + info + capture.
        trace('recover: uninit -> wait 1500ms -> info -> capture (attempt 3)')
        try { await safeCall('uninit') } catch (x) { trace('uninit err', x?.description) }
        await new Promise((r) => setTimeout(r, 1500))
        try { await safeCall('info') } catch (x) { trace('info err', x?.description) }
        try {
          return await safeCall('capture', args)
        } catch (e3) {
          throw new IrisError(
            'device',
            e3 instanceof IrisError ? e3.code : e.code,
            'Iris device is stuck. In an admin PowerShell run: Restart-Service *marvis* -- then try again.',
          )
        }
      }
      throw e
    }
  },

  // Manual escape hatch for the "Reset device" button. Forces a full
  // state cycle: uninit -> wait -> info. Same operations the retry
  // ladder does, but exposed as a button the operator can press
  // BEFORE they hit -2014 (proactive reset) or if the retry ladder
  // couldn't recover.
  async reset() {
    try { await safeCall('uninit') } catch { /* best-effort */ }
    await new Promise((r) => setTimeout(r, 500))
    return safeCall('info') // may throw -- caller handles
  },

  // Fetch the LAST captured image in a specific template format. Call
  // AFTER capture(). `format` is one of IMG_FORMAT.* — default ISO
  // because that's what our server-side matcher / gallery store
  // expects.
  async getImage(format = IMG_FORMAT.ISO) {
    return safeCall('getimage', { ImgFormat: format })
  },

  // Local 1:1 match methods retired with the TrustView migration.
  //
  // Before Aug 2026 the operator laptop's Marvis daemon did the compare
  // in-process, and the frontend called `iris.match({galleryTemplate})`
  // or `iris.verify({probeTemplate, galleryTemplate})`. Now the backend
  // owns comparison (POST /api/candidates/{roll}/iris-match), so the
  // daemon here is capture-only. See IrisCapture.jsx for the new flow.
  //
  // If a caller genuinely needs local 1:1 verification (e.g. an offline
  // kiosk mode), wire /marvisauth/verify directly here — the daemon
  // still exposes it.

  // Release the device — call from a page unmount when we don't
  // expect further captures for a while. Idempotent on the SDK side.
  async uninit() {
    return safeCall('uninit')
  },

  // Toggle the scanner's blue LED (some MIS100V2 units use it to
  // signal "look here"). value 0 = off, 1 = on.
  async setLed(value) {
    return safeCall('setblueled', { LedValue: value ? 1 : 0 })
  },
}
