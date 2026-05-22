const BASE = '/api'

function getToken() {
  return localStorage.getItem('nv_token') || ''
}

// ApiError carries the HTTP status code and parsed body alongside the
// error message — callers that need to branch on status code (e.g. the
// candidate-lookup handler needs to detect 402 to open the deposit
// modal) can do `e instanceof ApiError && e.status === 402`.
export class ApiError extends Error {
  constructor(message, { status, body, headers } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body       // the parsed JSON body (or null)
    this.headers = headers // the response Headers object (or null)
  }
}

export async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (auth) {
    const t = getToken()
    if (t) headers.Authorization = `Bearer ${t}`
  }
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let msg = res.statusText
    let parsedBody = null
    try {
      parsedBody = await res.json()
      if (parsedBody?.error) msg = parsedBody.error
    } catch {}
    throw new ApiError(msg, {
      status: res.status,
      body: parsedBody,
      headers: res.headers,
    })
  }
  if (res.status === 204) return null
  return res.json()
}

// True when the error is an HTTP 402 from the wallet middleware. The
// body contains { error, balance_paise, fee_paise }.
export function isWalletEmptyError(err) {
  return err instanceof ApiError && err.status === 402
}

export function photoUrl(roll) {
  // Token isn't included in <img>, so use a separate fetch + blob URL helper.
  return `${BASE}/candidates/${encodeURIComponent(roll)}/photo`
}

export async function fetchPhotoBlob(roll) {
  const res = await fetch(photoUrl(roll), {
    headers: { Authorization: `Bearer ${getToken()}` },
  })
  if (!res.ok) throw new Error('photo not found')
  const blob = await res.blob()
  return URL.createObjectURL(blob)
}

// Fetches the candidate's enrolled fingerprint template ready to be passed
// straight to morfin.match() as GalleryTemplate. Returns {template_b64,
// format, size_bytes}. The format string ("FMR_V2005" etc.) maps to the
// daemon's TmpFormat enum via tmpFormatFromString().
export async function fetchFPTemplate(roll) {
  return api(`/candidates/${encodeURIComponent(roll)}/fp-template`)
}

// Posts a captured webcam JPEG (data URL or raw base64) to the backend's
// face-match orchestrator. Backend looks up the gallery template,
// forwards both to luxand-service, returns the score.
//
// Returns {face_found, score, threshold, status, roll_no} or throws on
// transport / SDK error. The caller surfaces the error in the UI.
export async function postFaceMatch(roll, dataURLOrBase64) {
  return api('/face-match', {
    method: 'POST',
    body: { roll_no: roll, image_b64: dataURLOrBase64 },
  })
}

// Posts a captured fingerprint probe template (base64 FMR/ANSI bytes from
// any vendor's operator-laptop daemon) to the backend's fp-match orchestrator.
// Backend looks up the gallery template for the roll, forwards probe + gallery
// to fp-match-service (SourceAFIS), returns the score.
//
// Used by vendor clients that can't do stored-gallery 1:1 matching on the
// operator laptop — today that's Startek/ACPL. Mantra MorFin keeps doing
// its match locally via the vendor daemon (faster + battle-tested).
//
// Returns {roll_no, score, threshold, status, vendor} or throws on
// transport / SDK error. The caller surfaces the error in the UI.
export async function postFpMatch(roll, probeBase64, vendor) {
  return api('/fp-match', {
    method: 'POST',
    body: { roll_no: roll, probe_b64: probeBase64, fp_vendor: vendor || '' },
  })
}
