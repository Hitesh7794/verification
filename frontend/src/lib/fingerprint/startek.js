// Client for the ACPL Capture API service that wraps Startek FM220U L1
// fingerprint devices. The MSI installs a Windows service that listens on
// localhost (HTTP :8090 in dev / HTTPS :4443 in prod) and exposes:
//
//   GET /FM220/getserial                  - device info (acts as our
//                                           "is a device connected?" probe)
//   GET /FM220/gettmpl                    - one-shot capture, returns
//                                           templateBase64 + isoImgBase64
//   GET /FM220/GetMatchResult?MatchTmpl=  - capture + match in one call,
//                                           but ONLY works for same-session
//                                           templates — rejects arbitrary
//                                           stored gallery templates with
//                                           errorCode 104. Verified
//                                           empirically 2026-05-15.
//
// Because GetMatchResult can't be used for our 1:1 verification flow
// (matching a fresh capture against a pre-enrolled gallery template), we
// use ACPL's gettmpl for capture-only and forward the resulting FMR
// template to our own server-side matcher (fp-match-service / SourceAFIS)
// via /api/fp-match. Vendor-neutral by design — same backend endpoint will
// later also handle Mantra-captured probes if we want unified scoring.
//
// See STARTEK_INTEGRATION.md for the full investigation and fp-match-service/
// for the matcher itself.

import { postFpMatch } from '../api.js'
import { Vendor } from './types.js'

const DEFAULT_BASE =
  import.meta.env.VITE_STARTEK_BASE || 'http://localhost:8090/FM220/'
const RD_RELEASE_URL =
  import.meta.env.VITE_STARTEK_RD_RELEASE_URL || 'http://localhost:11080/rd/releasefm220'

let _base = DEFAULT_BASE
export function setBase(url) {
  _base = url.endsWith('/') ? url : url + '/'
}

// Same typed-error shape as MorfinError so FingerprintCapture.jsx can
// handle them uniformly. The `kind` field carries the same taxonomy.
export class StartekError extends Error {
  constructor(kind, code, description) {
    super(description)
    this.name = 'StartekError'
    this.kind = kind // 'service' | 'device' | 'sdk' | 'http'
    this.code = code
    this.description = description
  }
}

// ACPL returns errorCode as an int. Treat 0 as success; everything else
// is an SDK error. The `status` field carries the human-readable
// description. Some error codes (e.g. -1 with "no device") map to the
// "device" kind so the polling hook can route them through the
// no-device UI path instead of treating them as terminal.
function checkEnvelope(env) {
  if (!env || typeof env !== 'object') {
    return new StartekError('sdk', -9999, 'malformed response from Capture API')
  }
  if (env.errorCode === 0) return null
  const code = env.errorCode ?? -9999
  const desc = env.status ?? 'unknown error'
  // Heuristic kind classification: anything mentioning device / not
  // connected / not found gets the 'device' kind so the UI shows
  // "plug in the device" instead of a terminal error.
  let kind = 'sdk'
  const haystack = String(desc).toLowerCase()
  if (
    haystack.includes('device') ||
    haystack.includes('not connect') ||
    haystack.includes('not found') ||
    haystack.includes('no fingerprint')
  ) {
    kind = 'device'
  }
  return new StartekError(kind, code, desc)
}

async function call(method, params = null) {
  let url = _base + method
  if (params && typeof params === 'object') {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) qs.set(k, v)
    }
    const q = qs.toString()
    if (q) url += '?' + q
  }
  let res
  try {
    res = await fetch(url, {
      method: 'GET',
      // Mode 'cors' is the default for cross-origin fetches; explicit
      // here to make the intent obvious — the daemon advertises a
      // permissive ACAO header.
      mode: 'cors',
    })
  } catch (e) {
    // Network-level failure (connection refused, DNS, CORS): the
    // service isn't reachable. This is the only fetch() failure mode
    // since browsers don't surface HTTP error codes as fetch
    // rejections.
    throw new StartekError('service', null, e.message || 'service unavailable')
  }
  if (!res.ok) {
    throw new StartekError('http', res.status, `HTTP ${res.status}`)
  }
  let body
  try {
    body = await res.json()
  } catch (e) {
    throw new StartekError('sdk', -9998, 'invalid JSON: ' + e.message)
  }
  const err = checkEnvelope(body)
  if (err) throw err
  return body
}

// L1 RD release sequence — DISABLED in our flow. ACPL's demo HTML has a
// "Release from RDService" button, but that's intended for users who've
// run a UIDAI Aadhaar capture via L1 RD first and now want to hand the
// device back to the Capture API. In our 1:1 verification workflow we
// never invoke L1 RD — the Capture API has the device from boot. Calling
// RELEASEFM220 in this state puts the Capture API into a "Pl wait for
// closing of earlier process" cooldown (verified 2026-05-15 on real
// hardware: a standalone /gettmpl succeeds, but the same call after a
// RELEASEFM220 returns errorCode 1 with that status string).
//
// Kept as a documented no-op so a future Aadhaar path can re-enable it
// without re-discovering this lesson.
async function releaseFromRD() {
  // intentionally empty — see explanation above
}

// Public surface. Shape mirrors what useDeviceStatus + FingerprintCapture
// already call on the morfin module, so swapping clients via the
// registry is a near-trivial dispatch.
export const startek = {
  /**
   * Returns the connected device list. Startek has no native "list
   * devices" call; getserial succeeds only when an FM220 is plugged
   * in. Treat as one-or-none.
   */
  async getConnectedDevices() {
    try {
      const env = await call('getserial')
      const model = env.mi || 'FM220U'
      return [model]
    } catch (e) {
      // 'service' = daemon not running; let the polling hook route to
      // service-down. 'device' = no device plugged in; return empty.
      // Anything else: re-throw so terminal errors surface.
      if (e instanceof StartekError && e.kind === 'service') throw e
      if (e instanceof StartekError && e.kind === 'device') return []
      throw e
    }
  },

  /**
   * Device info — uses the same /getserial endpoint as getConnectedDevices.
   * The model param is ignored (Startek's API doesn't take a device
   * name; there's only ever one FM220 connected).
   */
  async getInfo(_name) {
    const env = await call('getserial')
    return {
      SerialNo: env.serialNumber || '',
      Model: env.mi || 'FM220U',
      // ACPL exposes a `dc` (device code) field; expose under a vendor-
      // neutral key for the audit row.
      DeviceCode: env.dc || '',
    }
  },

  /**
   * No-op init: ACPL has no Init endpoint analogous to MorFin's. We
   * use this slot to issue the L1 RD release call so the Capture API
   * gets exclusive access to the device. Tolerant of L1 RD being absent.
   */
  async init(_name) {
    await releaseFromRD()
  },

  /**
   * No-op uninit. The Capture API stays bound until the operator
   * unplugs or another process re-grabs the device. Kept for parity
   * with morfin.uninit().
   */
  async uninit() {
    return { ErrorCode: '0', ErrorDescription: 'OK' }
  },

  /**
   * 1:1 verification. Two-step:
   *
   *   1. gettmpl on the local ACPL Capture API — captures a probe from the
   *      FM220U USB device and returns its FMR_V2005 template.
   *   2. POST /api/fp-match to the portal backend — backend looks up the
   *      gallery template for `rollNo` from the candidate index and forwards
   *      probe+gallery to fp-match-service (SourceAFIS) for true 1:1
   *      matching against pre-enrolled gallery templates.
   *
   * The `gallery` argument is accepted for parity with morfin.match() but
   * ignored — Startek can't match against arbitrary stored templates
   * locally (ACPL's GetMatchResult only accepts same-session templates,
   * see STARTEK_INTEGRATION.md). The gallery lookup happens server-side
   * from rollNo, which is the source of truth anyway.
   *
   * Returns a normalized envelope shaped like MorFin's so the React
   * component doesn't have to branch on vendor.
   */
  async match({ rollNo /* , gallery — unused, see comment above */ }) {
    if (!rollNo) {
      throw new StartekError('sdk', -1, 'rollNo required for Startek match')
    }

    // Step 1: capture probe from the device.
    const cap = await call('gettmpl')
    const probeB64 = cap && typeof cap.templateBase64 === 'string'
      ? cap.templateBase64
      : ''
    if (!probeB64) {
      // ACPL returns errorCode:0 with empty templateBase64 in some edge
      // cases (e.g. capture timed out, low quality rejected). Surface as
      // an SDK error so the component shows a real message instead of
      // pretending we have a probe.
      throw new StartekError('sdk', -1,
        'Capture API returned no template — try placing finger firmly')
    }

    // Step 2: forward probe to backend → fp-match-service → SourceAFIS.
    // The backend looks up the gallery via the candidate index and returns
    // the match score + threshold + status. Errors from postFpMatch are
    // already typed (Error with message); we rewrap into StartekError so
    // FingerprintCapture's error rendering stays uniform.
    let res
    try {
      res = await postFpMatch(rollNo, probeB64, Vendor.Startek)
    } catch (e) {
      throw new StartekError('sdk', -1,
        'fp-match failed: ' + (e.message || String(e)))
    }

    return {
      ErrorCode: '0',
      ErrorDescription: 'OK',
      // Backend has already computed score >= threshold server-side, but
      // FingerprintCapture re-evaluates with the effectiveThreshold it
      // calculated. We pass both so the component decides.
      Status: !!res.status,
      MatchScore: typeof res.score === 'number' ? res.score : 0,
      // No preview bitmap — gettmpl returns isoImgBase64 but it's a raw
      // FM220 image, not a Windows-renderable BMP. FingerprintCapture
      // gracefully falls through to "Match · score N / threshold N"
      // when bitmapBase64 is null.
      BitmapData: null,
      // NFIQ comes back on the gettmpl envelope (real fingerprint quality
      // 1-5, NIST scale). Map onto our Nfiq field for audit consistency
      // with what Mantra MorFin returns.
      Quality: null,
      Nfiq: typeof cap.NFIQ === 'number' ? cap.NFIQ : null,
      LiveNess_Result: null,
      // Vendor identity carried back for the audit submit.
      DeviceSerial: cap.serialNumber || '',
      DeviceModel: cap.mi || 'FM220U',
    }
  },
}
