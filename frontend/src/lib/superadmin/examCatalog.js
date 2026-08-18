// Data-access layer for the superadmin exam catalog surface (clients,
// exams, candidate CSV upload). One thin wrapper per endpoint so the
// pages stay UI-only.
import { api, ApiError } from '../api.js'
import { getStoredToken } from '../authStorage.js'

// ── Clients ───────────────────────────────────────────────────────────

export async function listClients() {
  const { clients } = await api('/superadmin/clients')
  return clients
}

export async function createClient({ name, notes = '' }) {
  return api('/superadmin/clients', {
    method: 'POST',
    body: { name, notes },
  })
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
  const token = getStoredToken('superadmin')
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
  const token = getStoredToken('superadmin')
  const res = await fetch(`/api/superadmin/uploads/${uploadId}/raw`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new Error(`download failed: ${res.status}`)
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
