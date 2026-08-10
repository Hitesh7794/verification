// Promise/fetch client for the mantra-iris-service running on
// localhost:8031 (or the iris-mock during dev). Mirrors the morfin.js
// shape so the operator's experience is symmetric across channels.

const DEFAULT_BASE =
  import.meta.env.VITE_IRIS_BASE || 'http://localhost:8031/iris/'

let _base = DEFAULT_BASE
export function setIrisBase(url) {
  _base = url.endsWith('/') ? url : url + '/'
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
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    throw new IrisError('http', res.status, `HTTP ${res.status}`)
  }
  return res.json()
}

function check(env) {
  if (env && env.ErrorCode === '0') return null
  const code = env?.ErrorCode ?? '-9999'
  const desc = env?.ErrorDescription ?? 'unknown error'
  let kind = 'sdk'
  if (code === '-2027') kind = 'device'
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

function parseDeviceList(desc) {
  if (!desc) return []
  const idx = desc.indexOf(':')
  if (idx < 0) return []
  return desc
    .slice(idx + 1)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export const iris = {
  async getSupportedDevices() {
    const env = await safeCall('supporteddevicelist')
    return parseDeviceList(env.ErrorDescription)
  },
  async getConnectedDevices() {
    const env = await safeCall('connecteddevicelist')
    return parseDeviceList(env.ErrorDescription)
  },
  async checkDevice(name) {
    return safeCall('checkdevice', { ConnectedDvc: name })
  },
  async getInfo(name) {
    const env = await safeCall('info', { ConnectedDvc: name })
    return env.DeviceInfo
  },
  async init(name) {
    return safeCall('initdevice', { ConnectedDvc: name })
  },
  async uninit() {
    return safeCall('uninitdevice')
  },
  async capture({ minQuality = 50, upperQuality = 95, timeoutMs = 10000 } = {}) {
    return safeCall('capture', {
      MinQuality: minQuality,
      UpperQuality: upperQuality,
      TimeOut: timeoutMs,
    })
  },
  // `format` is one of the vendor's ImageFormat enum values:
  //   BMP | RAW | K7 | IIR_K7 | K1
  // (verified against the Marvis JAR; "K3" / "JPEG2000" mentioned in
  // earlier docs are not present in the SDK.)
  async match({ probeLeft, probeRight, galleryLeft, galleryRight, format = 'K7' }) {
    const body = { Format: format }
    if (probeLeft && galleryLeft) {
      body.ProbLeft = probeLeft
      body.GalleryLeft = galleryLeft
    }
    if (probeRight && galleryRight) {
      body.ProbRight = probeRight
      body.GalleryRight = galleryRight
    }
    return safeCall('match', body)
  },
}
