// Data-access layer for the superadmin exam catalog surface (clients,
// exams, candidate CSV upload). One thin wrapper per endpoint so the
// pages stay UI-only.
import { api, ApiError } from '../api.js'
import { getStoredToken } from '../authStorage.js'
import { toFriendlyError } from '../errors.js'

// ── Clients ───────────────────────────────────────────────────────────

export async function listClients() {
  const { clients } = await api('/superadmin/clients')
  return clients
}

// kyc_review_mode is picked in the create-client form (Innovatiview /
// client / both) and MUST reach the backend on this POST, else the row
// is created with the default 'admin' and the operator has to visit the
// detail page to correct it — reads as "my choice reverted to
// Innovatiview". Pass name + notes + kyc_review_mode through explicitly.
export async function createClient({ name, notes = '', kyc_review_mode, api_url }) {
  const body = { name, notes, api_url: api_url || '' }
  if (kyc_review_mode) body.kyc_review_mode = kyc_review_mode
  return api('/superadmin/clients', { method: 'POST', body })
}

export async function getClient(id) {
  return api(`/superadmin/clients/${id}`)
}

export async function patchClient(id, patch) {
  return api(`/superadmin/clients/${id}`, { method: 'PATCH', body: patch })
}

export async function toggleClientVisibility(id) {
  return api(`/superadmin/clients/${id}/visibility`, { method: 'POST' })
}

export async function closeClient(id) {
  return api(`/superadmin/clients/${id}/close`, { method: 'POST' })
}

export async function reopenClient(id) {
  return api(`/superadmin/clients/${id}/reopen`, { method: 'POST' })
}

export async function deleteClient(id) {
  return api(`/superadmin/clients/${id}`, { method: 'DELETE' })
}

// ── Per-client review portal (portal_enabled + reviewer users) ───────
//
// Flip portal_enabled to surface the client in /api/clients/public,
// which is what the register form's dropdown reads. Reviewer users are
// role='client_reviewer' — they log in through the same /api/auth/login,
// and their JWT carries this client_id so every application scoped
// endpoint filters to it server-side.

export async function setClientPortal(id, enabled) {
  return api(`/superadmin/clients/${id}/portal`, {
    method: 'POST',
    body: { enabled },
  })
}

export async function listClientReviewers(id) {
  const { reviewers } = await api(`/superadmin/clients/${id}/reviewers`)
  return reviewers
}

// Returns the created reviewer row. The `password` field is echoed
// ONCE in this response — surface it in the UI immediately with a
// "copy" affordance because no endpoint re-reads it later.
export async function createClientReviewer(id, payload) {
  return api(`/superadmin/clients/${id}/reviewers`, {
    method: 'POST',
    body: payload, // { username, password, display_name, email }
  })
}

export async function deleteClientReviewer(id, uid) {
  return api(`/superadmin/clients/${id}/reviewers/${uid}`, { method: 'DELETE' })
}

// ── Exams ─────────────────────────────────────────────────────────────

export async function createExam(clientId, exam) {
  return api(`/superadmin/clients/${clientId}/exams`, {
    method: 'POST',
    body: exam, // { name, exam_code, verification_from, verification_to }
  })
}

// Bulk create exams via CSV upload.
// On 422 the body has { validation_errors: [{ line, msg }] }
export async function bulkCreateExamsCSV(clientId, file) {
  const fd = new FormData()
  fd.append('file', file)
  return api(`/superadmin/clients/${clientId}/exams/csv`, {
    method: 'POST',
    body: fd,
  })
}

// Download a formatted sample CSV template for bulk exam creation
export function downloadSampleExamCSV() {
  const now = new Date()
  const fmtDate = (d, timeStr) => {
    const yyyy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd} ${timeStr}`
  }

  const d1From = new Date(now.getTime() + 7 * 86400000)
  const d1To = new Date(now.getTime() + 30 * 86400000)

  const d2From = new Date(now.getTime() + 14 * 86400000)
  const d2To = new Date(now.getTime() + 45 * 86400000)

  const d3From = new Date(now.getTime() + 21 * 86400000)
  const d3To = new Date(now.getTime() + 60 * 86400000)

  const y = now.getFullYear()
  const content = `exam_name,exam_code,verification_from,verification_to,requires_face,requires_fp,requires_iris
National Eligibility Test Session 1,NET-${y}-S1,${fmtDate(d1From, '09:00')},${fmtDate(d1To, '18:00')},yes,yes,no
Combined Entrance Examination,CEE-${y}-MAIN,${fmtDate(d2From, '08:30')},${fmtDate(d2To, '17:30')},yes,yes,yes
Graduate Aptitude Verification,GAV-${y}-01,${fmtDate(d3From, '10:00')},${fmtDate(d3To, '16:00')},yes,no,no
`
  const blob = new Blob(['\ufeff' + content], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'sample_exams.csv'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export async function getExam(examId) {
  return api(`/superadmin/exams/${examId}`)
}

export async function patchExam(examId, patch) {
  return api(`/superadmin/exams/${examId}`, { method: 'PATCH', body: patch })
}

export async function toggleExamVisibility(id) {
  return api(`/superadmin/exams/${id}/visibility`, { method: 'POST' })
}

export async function closeExam(id) {
  return api(`/superadmin/exams/${id}/close`, { method: 'POST' })
}

export async function reopenExam(id) {
  return api(`/superadmin/exams/${id}/reopen`, { method: 'POST' })
}

export async function deleteExam(id) {
  return api(`/superadmin/exams/${id}`, { method: 'DELETE' })
}

// ── Biometrics — per-exam completeness + per-candidate upload ───────

// Completeness cross-check between the exam's Postgres roster and
// the on-disk biometric index. Returns totals + a per-candidate list
// so the UI can render both the summary strip and the per-row dots.
export async function getExamCompleteness(examId) {
  return api(`/superadmin/exams/${examId}/completeness`)
}

// bulkUploadBiometrics ships a .zip of biometric files for one
// modality (photos | fp-images | fp-templates | iris) in one request.
// Backend streams entries into S3 keyed by <exam_code>/<modality>/<roll>.<ext>
// and flips exam_candidates.has_<modality>=true for each successful roll.
//
// Uses XMLHttpRequest instead of fetch because we want upload-progress
// events for the operator's progress bar. fetch's ReadableStream
// progress upload isn't broadly supported yet.
//
// Returns { promise, cancel } — cancel() aborts the in-flight XHR;
// the promise rejects with a CanceledError so the caller can silently
// swallow it without a red banner.
export function bulkUploadBiometrics(examId, modality, zipFile, onProgress) {
  const xhr = new XMLHttpRequest()
  let canceled = false
  const promise = new Promise((resolve, reject) => {
    const fd = new FormData()
    fd.append('file', zipFile)
    xhr.open('POST', `/api/superadmin/exams/${examId}/bulk/${modality}`)
    const token = getStoredToken(getRoleScope() || 'superadmin')
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100))
      }
    }
    xhr.onload = () => {
      let body
      try { body = JSON.parse(xhr.responseText) } catch { body = null }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body)
      } else {
        const raw = body?.error || `HTTP ${xhr.status}`
        const err = new Error(raw)
        err.status = xhr.status
        err.body = body
        err.rawMessage = raw
        err.message = toFriendlyError(err)
        reject(err)
      }
    }
    xhr.onerror = () => {
      if (canceled) {
        const err = new Error('canceled')
        err.canceled = true
        reject(err)
        return
      }
      reject(new Error('Cannot reach the server. Please check your internet connection and try again.'))
    }
    xhr.onabort = () => {
      const err = new Error('canceled')
      err.canceled = true
      reject(err)
    }
    xhr.ontimeout = () => reject(new Error('The upload took too long and was cancelled. Please try again.'))
    // Big zips (up to 2 GB) can legitimately take a long time on a
    // typical centre uplink — a 2 GB upload at ~4 MB/s is ~8 min, at
    // ~1 MB/s (a slower line) is ~35 min. 60-min ceiling so a slow
    // but real upload completes, but a genuinely stuck one eventually
    // gives up rather than hanging the tab forever.
    // Ceilings to keep aligned: see bulkUploadMaxBytes in the Go
    // handler and nginx @bulk_upload client_max_body_size.
    xhr.timeout = 60 * 60 * 1000
    xhr.send(fd)
  })
  return {
    promise,
    cancel: () => { canceled = true; try { xhr.abort() } catch {} },
  }
}

// Upload one biometric file (photo / fp_image / fp_template / iris)
// for one candidate. Backend writes to DATA_DIR/uploaded/<exam>/… and
// refreshes the in-memory index so the file is queryable immediately.
export async function uploadBiometric(examId, roll, kind, file) {
  const fd = new FormData()
  fd.append('kind', kind)
  fd.append('file', file)
  return api(`/superadmin/exams/${examId}/candidates/${encodeURIComponent(roll)}/biometric`, {
    method: 'POST',
    body: fd,
  })
}

// ── Candidates + CSV upload ───────────────────────────────────────────

export async function listCandidates(examId, { limit = 100, offset = 0 } = {}) {
  return api(`/superadmin/exams/${examId}/candidates?limit=${limit}&offset=${offset}`)
}

export async function listUploads(examId) {
  const { uploads } = await api(`/superadmin/exams/${examId}/uploads`)
  return uploads
}

// Upload a raw CSV file. Uses fetch directly since api() only handles JSON.
// On 422 the body has { validation_errors: [{ line, msg }] } — surface
// those so the page can show what to fix.
export async function uploadCandidateCSV(examId, file) {
  const fd = new FormData()
  fd.append('file', file)
  const token = getStoredToken(getRoleScope() || 'superadmin')
  const res = await fetch(`/api/superadmin/exams/${examId}/candidates`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new ApiError(json.error || res.statusText, {
      status: res.status,
      body: json,
    })
  }
  return json
}

// Raw-CSV download URL — used in a plain <a href> on the uploads table.
// (Signed download would be nicer but the endpoint requires the Bearer
// token, so we open it in a new tab via a fetch → blob → objectURL.)
export async function downloadRawCSV(uploadId, filename) {
  const token = getStoredToken(getRoleScope() || 'superadmin')
  const res = await fetch(`/api/superadmin/uploads/${uploadId}/raw`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new Error(res.status === 404 ? 'That file could not be found.' : 'Download failed. Please try again.')
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename || 'candidates.csv'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
