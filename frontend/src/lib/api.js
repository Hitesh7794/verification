import { clearStoredSession, getRoleScope, getStoredToken, loginPathForScope } from './authStorage.js'

const BASE = '/api'

// Token used for an API call comes from the *current page's* portal
// scope — admin pages send the admin token, client pages send the
// operator token, superadmin pages send the superadmin token. This is
// what lets admin and operator coexist in separate tabs without
// overwriting each other's session.
function getToken() {
  return getStoredToken(getRoleScope())
}

// localStorage key for the operator's currently-selected exam. Set by
// the picker on client/Dashboard, read here so every operator request
// carries the X-Exam-Id header. Backend uses it to scope candidate
// lookups / photo fetches / face-match so a multi-exam operator can't
// accidentally mix data between exams. Storage is per-tab-scope
// (operator = client role) — the whole nv_ family is scoped to
// getRoleScope() to keep parallel admin/operator tabs isolated.
const CURRENT_EXAM_STORAGE_KEY = 'nv_current_exam_id'

export function getCurrentExamId() {
  if (typeof window === 'undefined') return null
  try {
    const v = window.localStorage.getItem(CURRENT_EXAM_STORAGE_KEY)
    return v || null
  } catch {
    return null
  }
}

export function setCurrentExamId(examId) {
  if (typeof window === 'undefined') return
  try {
    if (examId === null || examId === undefined || examId === '') {
      window.localStorage.removeItem(CURRENT_EXAM_STORAGE_KEY)
    } else {
      window.localStorage.setItem(CURRENT_EXAM_STORAGE_KEY, String(examId))
    }
    // Broadcast so any listener (dashboard tabs, other components) can
    // refetch what depends on the current exam.
    window.dispatchEvent(new CustomEvent('exam:changed', { detail: { examId } }))
  } catch {}
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
  const loginPath = loginPathForScope(scope)
  // Use assign rather than React Router so any in-flight component
  // state (e.g. polling intervals) is hard-reset by the page reload —
  // safer than relying on every component to react cleanly.
  if (typeof window !== 'undefined' && window.location.pathname !== loginPath) {
    window.location.assign(loginPath + '?session_expired=1')
  }
}

import { toFriendlyError } from './errors.js'

// ApiError carries the HTTP status code and parsed body alongside the
// error message — callers that need to branch on status code (e.g. the
// candidate-lookup handler needs to detect 402 to open the deposit
// modal) can do `e instanceof ApiError && e.status === 402`.
//
// .message is the friendly, user-safe string (so existing setErr(e.message)
// call sites get non-technical copy automatically). .rawMessage is the
// original server/network string for dev debugging.
export class ApiError extends Error {
  constructor(message, { status, body, headers } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body       // the parsed JSON body (or null)
    this.headers = headers // the response Headers object (or null)
    this.rawMessage = message
    // Compute the friendly version once at throw time.
    this.message = toFriendlyError(this)
  }
}

export async function api(path, { method = 'GET', body, auth = true } = {}) {
  // FormData bodies (file uploads) skip the JSON content-type so the
  // browser can set its own multipart boundary. Plain-object bodies
  // get JSON.stringify + application/json as before.
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData
  const headers = {}
  if (!isFormData) headers['Content-Type'] = 'application/json'
  if (auth) {
    const t = getToken()
    if (t) headers.Authorization = `Bearer ${t}`
  }
  // Attach the operator's currently-selected exam on every request.
  // Only meaningful for client-role callers — other scopes ignore it
  // server-side. The header is what pins candidate/photo/face-match
  // lookups to one exam for multi-exam operators, so data can't leak
  // across exams (backend refuses ambiguous requests with a 400).
  if (auth && getRoleScope() === 'client') {
    const examId = getCurrentExamId()
    if (examId) headers['X-Exam-Id'] = examId
  }
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: isFormData ? body : (body ? JSON.stringify(body) : undefined),
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
// postLivenessCheck runs the active-liveness gate against luxand-service
// via our backend proxy. `frames` is an ordered array of base64 JPEG
// data URLs captured during the challenge; `sessionId` is the same
// idempotency key that will be handed to postFaceMatch — the backend
// pairs the two calls by that key. On pass, backend writes a
// liveness_checks row that lets the follow-up /face-match through.
//
// Returns {session_id, pass, passive_mean, passive_passed,
// blinks_detected, challenges_passed, faces_found, expires_in_seconds}.
// pass=false is not an exception — the caller retries as many times as
// needed (per product spec, no cap).
export async function postLivenessCheck(roll, frames, sessionId, challenges) {
  return api(`/candidates/${encodeURIComponent(roll)}/liveness-check`, {
    method: 'POST',
    body: {
      session_id: sessionId,
      frames,
      challenges: challenges && challenges.length ? challenges : ['blink'],
    },
  })
}

// postLivenessClientVerified — MediaPipe-decided liveness path. Client
// ran blink detection locally; server just records the gate row. No
// frames are uploaded; the wallet charge still fires (billing model is
// engine-agnostic — the payable event is "gate passed"). Same response
// shape as postLivenessCheck.
export async function postLivenessClientVerified(roll, sessionId) {
  return api(`/candidates/${encodeURIComponent(roll)}/liveness-client-verified`, {
    method: 'POST',
    body: { session_id: sessionId },
  })
}

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

// Posts a captured iris probe (whatever the Marvis daemon returned via
// AutoCapture — usually a base64 BMP) to the backend, which forwards it
// to the TrustView hosted compare API. Replaces the previous local
// /marvisauth/match call on the operator laptop (Aug 2026 migration).
//
// Returns {roll_no, matched, score?, threshold, engine?, gallery_missing,
// device_serial?, device_model?}. When gallery_missing=true the operator
// UI records the capture as audit-only — iris was never enrolled
// server-side (see IRIS_NOTES.md).
export async function postIrisMatch(roll, probeBase64, deviceMeta) {
  return api(`/candidates/${encodeURIComponent(roll)}/iris-match`, {
    method: 'POST',
    body: {
      probe_b64: probeBase64,
      device_serial: deviceMeta?.serial || '',
      device_model:  deviceMeta?.model  || '',
    },
  })
}

// Reviewer verification report — CSV. `filters` is any subset of
// { from, to, org, status, roll }; pass {} for the full unscoped
// export (bounded by the backend's 100k-row cap). Auth token is
// attached to the fetch, so we build a Blob URL and click a hidden
// anchor rather than handing a naked <a> to the user.
export async function downloadReviewerVerificationsCSV(filters = {}) {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(filters)) {
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      qs.append(k, String(v).trim())
    }
  }
  const url = `${BASE}/client/verifications.csv${qs.toString() ? '?' + qs.toString() : ''}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${getToken()}` },
  })
  if (!res.ok) {
    let raw = `CSV download failed (HTTP ${res.status})`
    try { const body = await res.json(); if (body?.error) raw = body.error } catch (_) {}
    const err = new Error(raw)
    err.status = res.status
    err.rawMessage = raw
    throw err
  }
  const blob = await res.blob()
  const objUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objUrl
  const stamp = new Date().toISOString().slice(0, 10)
  a.download = `reviewer_verifications_${stamp}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(objUrl), 1000)
}

// Phase 3c — attempt counter for the "Nth attempt on this roll" chip.
// Backend counts verifications for the caller's org over the past 30
// days. Returns { roll_no, count, since, last_at? }. Non-fatal on
// failure: the operator flow proceeds without the chip.
// Fetches the verification receipt PDF and triggers a download in the
// browser. Auth token is attached to the fetch (not just the URL),
// which is why we can't hand a naked <a href> to the user.
// previewVerificationPDF fetches the PDF and opens it in a new tab so
// the operator can inspect it before printing / handing to the
// candidate. Uses a blob URL because the fetch carries the auth token
// (a naked <a href> can't).
export async function previewVerificationPDF(id) {
  if (!id) return
  const res = await fetch(`${BASE}/verifications/${id}/pdf`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  })
  if (!res.ok) {
    let raw = `PDF preview failed (HTTP ${res.status})`
    try { const body = await res.json(); if (body?.error) raw = body.error } catch (_) {}
    const err = new Error(raw); err.status = res.status; err.rawMessage = raw
    err.message = toFriendlyError(err)
    throw err
  }
  const blob = await res.blob()
  const objUrl = URL.createObjectURL(blob)
  const w = window.open(objUrl, '_blank', 'noopener')
  if (!w) {
    // Pop-up blocker — fall back to same-tab navigation so the operator
    // still sees the PDF (they can Back to return).
    window.location.href = objUrl
  }
  // Don't revoke — the new tab needs the URL alive. Browser cleans up
  // when the page unloads.
}

// printVerificationPDF opens the PDF in a NEW tab and asks the
// browser to print it. Works reliably in Chromium browsers; Firefox
// opens the print dialog after the PDF viewer loads.
//
// The window.open call MUST happen synchronously with the user's
// click. Browsers only count window.open as user-initiated when it
// runs inside the click event's synchronous callback — the moment
// we `await fetch(...)`, we've left the gesture context and pop-up
// blockers kick in. The old version opened AFTER the await, so the
// pop-up got blocked and the fallback `window.location.href = objUrl`
// loaded the PDF in the SAME tab. Now we open a blank tab up-front
// and swap its location to the PDF once the fetch resolves.
export async function printVerificationPDF(id) {
  if (!id) return
  // Open the tab RIGHT NOW, while we're still in the click gesture.
  // 'about:blank' is a placeholder; we'll swap in the object URL below.
  const w = window.open('', '_blank')
  try {
    const res = await fetch(`${BASE}/verifications/${id}/pdf`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    })
    if (!res.ok) {
      if (w) w.close()
      let raw = `PDF print failed (HTTP ${res.status})`
      try { const body = await res.json(); if (body?.error) raw = body.error } catch (_) {}
      const err = new Error(raw); err.status = res.status; err.rawMessage = raw
      err.message = toFriendlyError(err)
      throw err
    }
    const blob = await res.blob()
    const objUrl = URL.createObjectURL(blob)
    if (w && !w.closed) {
      w.location.href = objUrl
      // Give the PDF viewer time to render before invoking print. Chrome
      // renders inline PDFs in ~600 ms on a warm cache; use 1.5 s so
      // cold-cache renders complete before the dialog pops.
      setTimeout(() => { try { w.focus(); w.print() } catch (_) {} }, 1500)
    } else {
      // Pop-up blocker refused the up-front open call. Rather than
      // hijack the CURRENT tab (the original bug), fall back to a
      // download so the current tab isn't disrupted.
      const a = document.createElement('a')
      a.href = objUrl
      a.download = `verification_${id}.pdf`
      document.body.appendChild(a)
      a.click()
      a.remove()
    }
  } catch (e) {
    if (w && !w.closed) w.close()
    throw e
  }
}

export async function downloadVerificationPDF(id) {
  if (!id) return
  const res = await fetch(`${BASE}/verifications/${id}/pdf`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  })
  if (!res.ok) {
    let raw = `PDF download failed (HTTP ${res.status})`
    let body = null
    try {
      body = await res.json()
      if (body?.error) raw = body.error
    } catch (_) { /* PDF errors usually aren't JSON */ }
    const err = new Error(raw)
    err.status = res.status
    err.body = body
    err.rawMessage = raw
    err.message = toFriendlyError(err)
    throw err
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
    const raw = j.error || `upload failed (HTTP ${res.status})`
    const err = new Error(raw)
    err.status = res.status
    err.body = j
    err.rawMessage = raw
    err.message = toFriendlyError(err)
    throw err
  }
  return { status: res.status, body: j }
}

export async function getCandidateAttempts(roll) {
  return api(`/candidates/${encodeURIComponent(roll)}/attempts`)
}
