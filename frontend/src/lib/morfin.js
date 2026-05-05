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
function check(env) {
  if (env && env.ErrorCode === '0') return null
  const code = env?.ErrorCode ?? '-9999'
  const desc = env?.ErrorDescription ?? 'unknown error'
  let kind = 'sdk'
  if (code === '-2027') kind = 'device' // device disconnected
  return new MorfinError(kind, code, desc)
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
    const env = await safeCall('info', {
      ConnectedDvc: name,
      ClientKey: '',
      Liveness: 0,
    })
    return env.DeviceInfo
  },
  async init(name) {
    return safeCall('initdevice', { ConnectedDvc: name, ClientKey: '' })
  },
  async uninit() {
    return safeCall('uninitdevice')
  },
  async capture({ quality = 60, timeoutSec = 10 } = {}) {
    return safeCall('capture', { Quality: quality, TimeOut: timeoutSec })
  },
  async getTemplate(format = TmpFormat.FMR_V2005) {
    const env = await safeCall('gettemplate', { TmpFormat: format })
    return env.ImgData // base64
  },
  /** Verify two pre-existing templates (1:1). */
  async verify({ probe, gallery, format = TmpFormat.FMR_V2005 }) {
    return safeCall('verify', {
      ProbTemplate: probe,
      GalleryTemplate: gallery,
      TmpFormat: format,
    })
  },
  /** Capture from device + 1:1 verify against a gallery template in one call. */
  async match({ gallery, format = TmpFormat.FMR_V2005, quality = 60, timeoutSec = 10 }) {
    return safeCall('match', {
      Quality: quality,
      TimeOut: timeoutSec,
      GalleryTemplate: gallery,
      TmpFormat: format,
    })
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
