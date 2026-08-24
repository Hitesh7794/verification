// Client for the public institution-registration endpoints. Kept
// separate from lib/api.js because:
//   - These endpoints take no Authorization header (they're public)
//   - The doc-upload endpoint uses multipart/form-data, not JSON
//   - Error handling shows full body to the registrant (no role
//     scoping to obscure)
//
// All requests carry an idempotency hint via the application_id once
// init() succeeds, so a retried upload after a network blip just hits
// the same row's /docs endpoint again.

import { toFriendlyError } from '../errors.js'

const BASE = '/api'

// Wraps fetch with consistent error shape + automatic JSON parsing.
// The thrown Error carries a user-safe .message (existing register.jsx
// setErr(e.message) sites render friendly copy automatically) plus
// .status, .body, and .rawMessage for anything that needs the original.
async function call(path, opts = {}) {
  const res = await fetch(BASE + path, opts)
  let body = null
  try {
    body = await res.json()
  } catch {
    // Some endpoints (file downloads) don't return JSON; that's fine.
  }
  if (!res.ok) {
    const raw = body?.error || res.statusText || `HTTP ${res.status}`
    const err = new Error(raw)
    err.status = res.status
    err.body = body
    err.rawMessage = raw
    err.message = toFriendlyError(err)
    throw err
  }
  return body
}

// List of exam boards (clients) currently accepting KYC via their own
// review portal. Register form uses this to render the "Which exam
// board should review your application?" dropdown. Public — no auth.
// Filtered server-side to portal_enabled AND visible AND not closed.
export async function listPublicClients() {
  return call('/clients/public')
}

// Step 1+2: submit the form data.
export async function registerInit(formData) {
  return call('/register/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(formData),
  })
}

// Step 3: upload one document. Returns the doc row metadata.
// onProgress(pct) lets the UI render a progress bar from XHR's
// upload.onprogress event (fetch doesn't expose this).
export async function uploadDoc(applicationId, docKind, file, onProgress) {
  const appID = Number(applicationId)
  if (!applicationId || isNaN(appID) || appID <= 0) {
    throw new Error('Invalid or missing application ID. Please return to step 2 to re-confirm details.')
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${BASE}/register/${appID}/docs`)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100))
      }
    }
    xhr.onload = () => {
      let body
      try {
        body = JSON.parse(xhr.responseText)
      } catch {
        body = null
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body)
      } else {
        const raw = body?.error || `upload failed (HTTP ${xhr.status})`
        const err = new Error(raw)
        err.status = xhr.status
        err.body = body
        err.rawMessage = raw
        err.message = toFriendlyError(err)
        reject(err)
      }
    }
    xhr.onerror = () => reject(new Error('Cannot reach the server. Please check your internet connection and try again.'))
    xhr.ontimeout = () => reject(new Error('The upload took too long and was cancelled. Please try again.'))
    xhr.timeout = 5 * 60 * 1000 // 5 min absolute cap for a 10 MB upload
    const form = new FormData()
    form.append('doc_kind', docKind)
    form.append('file', file, file.name)
    xhr.send(form)
  })
}

export async function deleteDoc(applicationId, docId) {
  const appID = Number(applicationId)
  if (!applicationId || isNaN(appID) || appID <= 0) return
  return call(`/register/${appID}/docs/${docId}`, { method: 'DELETE' })
}

// Final step: lock the application so it lands in the superadmin queue.
export async function submitApplication(applicationId) {
  const appID = Number(applicationId)
  if (!applicationId || isNaN(appID) || appID <= 0) {
    throw new Error('Invalid or missing application ID. Please return to step 2 to re-confirm details.')
  }
  return call(`/register/${appID}/submit`, { method: 'POST' })
}

export async function getApplicationStatus(applicationId) {
  const appID = Number(applicationId)
  if (!applicationId || isNaN(appID) || appID <= 0) {
    throw new Error('Invalid or missing application ID.')
  }
  return call(`/register/${appID}`)
}

// ----- Set-password (magic-link landing) -----
export async function verifyMagicLink(token) {
  return call(`/set-password/verify?token=${encodeURIComponent(token)}`)
}

export async function setPassword(token, password) {
  return call('/set-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, password }),
  })
}

// ----- Local persistence -----
// Persist the wizard's in-flight state so a tab refresh / accidental
// navigation doesn't lose 5 minutes of typing.
//
// TTL (L10 fix, 2026-08-23): drafts silently expire after 7 days.
// Reasoning:
//   1. Stale `applicationId`s from server-side wipes carry a dead ID
//      that the submit path can't recover from cleanly.
//   2. Stale HMAC-signed OTP proof tokens (`emailOtpToken`,
//      `mobileOtpToken`) shouldn't sit in localStorage indefinitely
//      on shared / public terminals.
//   3. A registrar who genuinely needs >7 days to gather documents
//      is rare; a stale draft causing a wrong submission is worse
//      than making them re-enter fields.
// 7 days is generous enough that a busy admin coming back after a
// weekend + a couple of workdays still finds their form intact.
const STORAGE_KEY = 'institution_register_state_v1'
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export function loadDraft() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const d = JSON.parse(raw)
    // Pre-TTL drafts (no `savedAt`) are treated as expired — safer to
    // drop them than to load fields written before the timestamp
    // guard existed.
    if (!d?.savedAt || (Date.now() - d.savedAt) > DRAFT_TTL_MS) {
      localStorage.removeItem(STORAGE_KEY)
      return null
    }
    return d
  } catch {
    return null
  }
}

export function saveDraft(state) {
  try {
    // Stamp savedAt on every write so the freshness clock resets
    // with each keystroke — a form the user is actively touching
    // never ages out mid-session.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...state,
      savedAt: Date.now(),
    }))
  } catch {
    // localStorage full / disabled — silently ignore. Next save retries.
  }
}

export function clearDraft() {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {}
}
