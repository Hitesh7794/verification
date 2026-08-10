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

const BASE = '/api'

// Wraps fetch with consistent error shape + automatic JSON parsing.
async function call(path, opts = {}) {
  const res = await fetch(BASE + path, opts)
  let body = null
  try {
    body = await res.json()
  } catch {
    // Some endpoints (file downloads) don't return JSON; that's fine.
  }
  if (!res.ok) {
    const msg = body?.error || res.statusText || `HTTP ${res.status}`
    const err = new Error(msg)
    err.status = res.status
    err.body = body
    throw err
  }
  return body
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
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${BASE}/register/${applicationId}/docs`)
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
        const err = new Error(body?.error || `upload failed (HTTP ${xhr.status})`)
        err.status = xhr.status
        err.body = body
        reject(err)
      }
    }
    xhr.onerror = () => reject(new Error('network error while uploading'))
    xhr.ontimeout = () => reject(new Error('upload timed out'))
    xhr.timeout = 5 * 60 * 1000 // 5 min absolute cap for a 10 MB upload
    const form = new FormData()
    form.append('doc_kind', docKind)
    form.append('file', file, file.name)
    xhr.send(form)
  })
}

export async function deleteDoc(applicationId, docId) {
  return call(`/register/${applicationId}/docs/${docId}`, { method: 'DELETE' })
}

// Final step: lock the application so it lands in the superadmin queue.
export async function submitApplication(applicationId) {
  return call(`/register/${applicationId}/submit`, { method: 'POST' })
}

export async function getApplicationStatus(applicationId) {
  return call(`/register/${applicationId}`)
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
const STORAGE_KEY = 'institution_register_state_v1'

export function loadDraft() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function saveDraft(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // localStorage full / disabled — silently ignore. Next save retries.
  }
}

export function clearDraft() {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {}
}
