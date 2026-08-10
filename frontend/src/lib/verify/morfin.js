// Promise-wrapped client for the MorfinAuth daemon (real or mock).
//
// The vendor's reference JS bundles jQuery and uses synchronous AJAX, which
// is brittle and blocks the UI thread. We use fetch() with the same JSON
// envelopes the real daemon returns, so the only thing that swaps when
// hardware arrives is what process is bound to localhost:8030.
//
// Every call resolves with the parsed JSON body. The caller checks
// `ErrorCode === '0'` (string) for success — note that the real daemon
// returns ErrorCode as a string, not an int. Network errors throw.

import { postFpMatch } from '../api.js'
import { Vendor } from './fingerprint/types.js'

// Real daemon ships with a self-signed cert and the .deb installs it into
// the browser trust store. Dev defaults to plain HTTP since the mock has
// no cert. Override via VITE_MORFIN_BASE for prod.
const DEFAULT_BASE =
  import.meta.env.VITE_MORFIN_BASE || 'http://localhost:8030/morfinauth/'

// Template format codes accepted by `verify` and `match`. The wire value
// the daemon expects is the array index (0..2). The vendor's HTML uses
// 1-based dropdown values and subtracts 1 before sending — we expose
// 0-based constants that match the daemon directly.
export const TmpFormat = {
  FMR_V2005: 0,
  FMR_V2011: 1,
  ANSI_V378: 2,
}

// Image format codes for getimage. Operators rarely need this directly;
// `match` and `capture` already return BitmapData base64.
export const ImgFormat = {
  BMP: 0,
  JPEG2000: 1,
  WSQ: 2,
  RAW: 3,
}

// Map our backend's string format identifier (returned by /api/candidates)
// to the daemon's numeric TmpFormat enum.
export function tmpFormatFromString(name) {
  switch (name) {
    case 'FMR_V2005':
      return TmpFormat.FMR_V2005
    case 'FMR_V2011':
      return TmpFormat.FMR_V2011
    case 'ANSI_V378':
      return TmpFormat.ANSI_V378
    default:
      return null
  }
}

let _base = DEFAULT_BASE
export function setBase(url) {
  _base = url.endsWith('/') ? url : url + '/'
}

async function call(method, body) {
  const url = _base + method
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    throw new MorfinError('http', res.status, `HTTP ${res.status}`)
  }
  return res.json()
}

export class MorfinError extends Error {
  constructor(kind, code, description) {
    super(description)
    this.name = 'MorfinError'
    this.kind = kind // 'service' | 'device' | 'sdk' | 'http'
    this.code = code
    this.description = description
  }
}

// Translate an envelope's ErrorCode into a typed error or null on success.
//
// The daemon's response shape isn't uniform across endpoints: some
// responses come back with ErrorCode as a JSON string ("0"), others
// as a JSON number (0). Different handlers serialize differently
// even though Mantra's BaseResponse model declares it String. We
// normalize to a string and compare that — accepts both shapes.
function check(env) {
  if (!env) return new MorfinError('sdk', '-9999', 'empty response')
  const codeStr = String(env.ErrorCode ?? '-9999')
  if (codeStr === '0') return null
  const desc = env.ErrorDescription ?? 'unknown error'
  let kind = 'sdk'
  if (codeStr === '-2027') kind = 'device' // device disconnected
  return new MorfinError(kind, codeStr, desc)
}

// Wrap a call with classification: network errors → 'service' (daemon
// not reachable), envelope errors → typed by code.
async function safeCall(method, body) {
  let env
  try {
    env = await call(method, body)
  } catch (e) {
    if (e instanceof MorfinError) throw e
    // fetch() throws on network failure (CORS, daemon down, refused, etc).
    throw new MorfinError('service', null, e.message || 'service unavailable')
  }
  const err = check(env)
  if (err) throw err
  return env
}

// -- API surface --

export const morfin = {
  /** Returns the device names the daemon supports (parsed from ErrorDescription). */
  async getSupportedDevices() {
    const env = await safeCall('supporteddevicelist')
    return parseDeviceList(env.ErrorDescription, 'Supported Devices:')
  },
  /** Returns the device names currently plugged in. Empty array = none. */
  async getConnectedDevices() {
    const env = await safeCall('connecteddevicelist')
    return parseDeviceList(env.ErrorDescription, 'Found Devices:')
  },
  async checkDevice(name) {
    return safeCall('checkdevice', { ConnectedDvc: name })
  },
  async getInfo(name) {
    // info on this daemon build requires checkdevice to have run first
    // (sets the internal isDeviceInit flag — confirmed by reading the
    // bytecode of com.mantra.morfinauth.MorfinAuthClientService). The
    // env shape carries DeviceInfo as a sub-object when ErrorCode==0.
    const env = await safeCall('info', {
      ConnectedDvc: name,
      ClientKey: '',
    })
    return env.DeviceInfo || env
  },
  // init is the abstract "ready the device" call the rest of the
  // codebase (useDeviceStatus, FingerprintCapture) talks to. On this
  // daemon build there is no /initdevice endpoint — checkdevice is
  // what flips the internal init flag. We map the abstract init() to
  // the concrete checkdevice route so the surrounding state machine
  // doesn't need to know the difference.
  async init(name) {
    return safeCall('checkdevice', { ConnectedDvc: name })
  },
  async uninit() {
    return safeCall('uninitdevice')
  },
  // Capture body fields per the daemon's runtime parser (JsonObject.get
  // by literal key — not the CaptureRequest POJO; that class is dead
  // code from a different build). Both fields are parsed as strings.
  // Quality is the NFIQ minimum threshold (1-5 NIST scale, daemon
  // returns it under "Nfiq" in the response). TimeOut is in seconds.
  async capture({ quality = 60, timeoutSec = 10 } = {}) {
    return safeCall('capture', {
      Quality: String(quality),
      TimeOut: String(timeoutSec),
    })
  },
  async getTemplate(format = TmpFormat.FMR_V2005) {
    const env = await safeCall('gettemplate', { TmpFormat: format })
    return env.ImgData // base64
  },
  /** Verify two pre-existing templates (1:1). The daemon parses
   *  ProbTemplate/GalleryTemplate as base64 byte strings and TmpFormat
   *  as a string in "0"/"1"/"2" (FMR_V2005/FMR_V2011/ANSI_V378). */
  async verify({ probe, gallery, format = TmpFormat.FMR_V2005 }) {
    return safeCall('verify', {
      ProbTemplate: probe,
      GalleryTemplate: gallery,
      TmpFormat: String(format),
    })
  },
  /** 1:1 verification — Mantra path.
   *
   *  Originally a single `/morfinauth/match` call (capture+match on the
   *  operator laptop). Switched 2026-06-10 to the same two-step server-
   *  side path Startek uses, so both vendors land into the same
   *  SourceAFIS-scored audit row and we get one canonical algorithm
   *  + threshold across the fleet. See CONTEXT.md §13 for the rationale.
   *
   *  Flow:
   *    1. /morfinauth/capture (local) — captures from the USB device,
   *       returns BitmapData + Quality + Nfiq + LiveNess_Result. This
   *       still happens on the operator laptop because that's where
   *       the device is; only the matching moves to the server.
   *    2. /morfinauth/gettemplate (local) — extracts a probe FMR
   *       template from the capture the daemon is holding in memory.
   *       TmpFormat="0" = FMR_V2005, which is what fp-match-service
   *       and the gallery .iso files use.
   *    3. POST /api/fp-match (server) — backend reads the gallery
   *       template for `rollNo` from disk, forwards both to
   *       fp-match-service (SourceAFIS), returns score/threshold/status.
   *
   *  Returns a canonical envelope shaped like the previous local-match
   *  output so FingerprintCapture.jsx doesn't have to branch on which
   *  path produced the score. `gallery` and `format` are accepted for
   *  API symmetry with the previous signature but unused — server-side
   *  match looks up the gallery from rollNo, and the template extractor
   *  is pinned to FMR_V2005 to match what fp-match-service ingests. */
  async match({ rollNo, gallery: _gallery, format: _format, quality = 60, timeoutSec = 10 }) {
    if (!rollNo) {
      throw new MorfinError('sdk', '-1', 'rollNo required for Mantra server-side match')
    }

    // Step 1: capture from the USB device. Daemon stores the capture
    // in memory until the next capture or uninit; gettemplate reads
    // from that buffer.
    const cap = await safeCall('capture', {
      Quality: String(quality),
      TimeOut: String(timeoutSec),
    })

    // Step 2: extract the probe as FMR_V2005 (TmpFormat "0").
    //
    // On the daemon build we tested (2026-06-10, live MFS500/MARC10)
    // the template lands in a field called `ImgData` — which is
    // confusingly named because it's actually the FMR minutiae
    // template, not an image. See CONTEXT.md §12.3 for the disassembly
    // notes.
    //
    // Mantra may rename this field in a future SDK update (a more
    // sensible name like `Template` would be welcome but breaking),
    // so we probe a small set of plausible names instead of pinning
    // to ImgData. If none match, the error message dumps the actual
    // response keys so the next maintainer can diff against a fresh
    // vendor JAR without re-disassembling bytecode.
    const tpl = await safeCall('gettemplate', { TmpFormat: '0' })
    const probeB64 =
      tpl?.ImgData ||
      tpl?.Template ||
      tpl?.TemplateData ||
      tpl?.IsoTemplate ||
      tpl?.ISOTemplate ||
      null
    if (!probeB64 || typeof probeB64 !== 'string') {
      const keys = tpl && typeof tpl === 'object' ? Object.keys(tpl) : []
      throw new MorfinError('sdk', '-1',
        'gettemplate returned no recognised template field. ' +
        'Expected one of ImgData/Template/TemplateData/IsoTemplate/ISOTemplate. ' +
        'Response keys: ' + (keys.length ? keys.join(', ') : '(empty body)'))
    }

    // Step 3: forward to the backend's fp-match endpoint. Same code
    // path as Startek; backend tags the audit hint with fp_vendor=
    // mantra so per-vendor analytics still work even though both
    // share the matcher. postFpMatch already throws on transport
    // failure; rewrap into MorfinError so FingerprintCapture's
    // existing typed-error rendering stays uniform.
    let res
    try {
      res = await postFpMatch(rollNo, probeB64, Vendor.Mantra)
    } catch (e) {
      throw new MorfinError('sdk', '-1',
        'fp-match failed: ' + (e?.message || String(e)))
    }

    // Canonical envelope shape FingerprintCapture.jsx expects.
    // BitmapData survives from the local capture so the bitmap
    // preview still renders unchanged.
    return {
      ErrorCode: '0',
      ErrorDescription: 'OK',
      Status: !!res.status,
      MatchScore: typeof res.score === 'number' ? res.score : 0,
      BitmapData: cap?.BitmapData || null,
      Quality: typeof cap?.Quality === 'number' ? cap.Quality : null,
      Nfiq: typeof cap?.Nfiq === 'number' ? cap.Nfiq : null,
      LiveNess_Result: typeof cap?.LiveNess_Result === 'number'
        ? cap.LiveNess_Result : null,
      DeviceSerial: cap?.DeviceSerial || '',
      DeviceModel: cap?.DeviceModel || '',
    }
  },
}

// The daemon packs the device list inside ErrorDescription as
//    "Found Devices: MFS500,MARC10"
// or "Supported Devices: MELO041,MFS500,MARC10". Parse defensively.
function parseDeviceList(desc, prefix) {
  if (!desc) return []
  const idx = desc.indexOf(':')
  if (idx < 0) return []
  return desc
    .slice(idx + 1)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}
