import { clearStoredSession, getRoleScope, getStoredToken } from './authStorage.js'

const BASE = '/api'

// Token used for an API call comes from the *current page's* portal
// scope — admin pages send the admin token, client pages send the
// operator token, superadmin pages send the superadmin token. This is
// what lets admin and operator coexist in separate tabs without
// overwriting each other's session.
function getToken() {
  return getStoredToken(getRoleScope())
}

// Bookkeeping so a flood of 401s from a polling page doesn't trigger
// repeated location.assign calls.
let redirectingToLogin = false

// onUnauthorized centralises the response to "your token is no longer
// valid". The backend's authMiddleware returns 401 for any of:
//   - signature failure (server JWT_SECRET rotated)
//   - account disabled by admin since the token was issued
//   - user row deleted
//   - role changed since the token was issued
//   - 12h token TTL elapsed
//
// In every case the right response is the same: clear the stored
// session for this portal scope and route the user to that scope's
// login page so they can re-authenticate.
function onUnauthorized() {
  if (redirectingToLogin) return
  redirectingToLogin = true
  const scope = getRoleScope()
  if (scope) {
    clearStoredSession(scope)
  }
  const loginPath = scope ? `/${scope}/login` : '/'
  // Use assign rather than React Router so any in-flight component
  // state (e.g. polling intervals) is hard-reset by the page reload —
  // safer than relying on every component to react cleanly.
  if (typeof window !== 'undefined' && window.location.pathname !== loginPath) {
    window.location.assign(loginPath + '?session_expired=1')
  }
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
    if (res.status === 401) {
      // Token invalid / expired / account disabled / role changed.
      // Clear scoped storage and redirect — see onUnauthorized.
      onUnauthorized()
    }
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
export async function postFaceMatch(roll, dataURLOrBase64, idempotencyKey) {
  // URL-scoped: the wallet middleware extracts {roll} from the path for
  // its same-roll cache. Also this is now the wallet-chargeable event
  // (face-first flow — Aug 2026). Backend charges ₹ on every hit
  // regardless of match outcome; the 5-min cache still applies for
  // retries of the same roll.
  //
  // idempotencyKey is stashed on the backend under
  // /data/probes/temp/<key>.jpg so createVerification can promote it
  // to the permanent probe path for the PDF receipt. Optional —
  // omitting it just skips probe persistence.
  return api(`/candidates/${encodeURIComponent(roll)}/face-match`, {
    method: 'POST',
    body: { image_b64: dataURLOrBase64, idempotency_key: idempotencyKey || '' },
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
  return api(`/candidates/${encodeURIComponent(roll)}/fp-match`, {
    method: 'POST',
    body: { probe_b64: probeBase64, fp_vendor: vendor || '' },
  })
}

// Phase 3c — attempt counter for the "Nth attempt on this roll" chip.
// Backend counts verifications for the caller's org over the past 30
// days. Returns { roll_no, count, since, last_at? }. Non-fatal on
// failure: the operator flow proceeds without the chip.
// Fetches the verification receipt PDF and triggers a download in the
// browser. Auth token is attached to the fetch (not just the URL),
// which is why we can't hand a naked <a href> to the user.
export async function downloadVerificationPDF(id) {
  if (!id) return
  const res = await fetch(`${BASE}/verifications/${id}/pdf`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  })
  if (!res.ok) {
    let msg = `PDF download failed (HTTP ${res.status})`
    try {
      const j = await res.json()
      if (j.error) msg = j.error
    } catch (_) { /* PDF errors usually aren't JSON */ }
    throw new Error(msg)
  }
  const blob = await res.blob()
  const objUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objUrl
  a.download = `verification-${id}.pdf`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Revoke on next tick so the anchor's navigation completes first.
  setTimeout(() => URL.revokeObjectURL(objUrl), 1000)
}

// Uploads a per-exam CSV. `kind` picks the endpoint:
//   'candidates' → POST /api/superadmin/exams/{id}/candidates
//   'centres'    → POST /api/superadmin/exams/{id}/centres/upload
//   'operators'  → POST /api/admin/exams/{id}/operators/upload
// Multipart body, single file field named 'file'. Returns the parsed
// JSON response as-is; caller handles validation-error shape.
export async function uploadExamCSV(examID, kind, file) {
  const path = {
    candidates: `/superadmin/exams/${examID}/candidates`,
    centres:    `/superadmin/exams/${examID}/centres/upload`,
    operators:  `/admin/exams/${examID}/operators/upload`,
  }[kind]
  if (!path) throw new Error(`unknown upload kind: ${kind}`)
  const fd = new FormData()
  fd.append('file', file)
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken()}` },
    body: fd,
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok && res.status !== 422) {
    throw new Error(j.error || `upload failed (HTTP ${res.status})`)
  }
  return { status: res.status, body: j }
}

export async function getCandidateAttempts(roll) {
  return api(`/candidates/${encodeURIComponent(roll)}/attempts`)
}
