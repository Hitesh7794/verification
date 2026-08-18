// Data-access layer for the client-reviewer portal.
//
// A client_reviewer's JWT carries a client_id, and every endpoint
// below is scoped to that id server-side. Cross-client access
// returns 404 with the same shape as "unknown application", so a
// reviewer can't probe for other clients' applications.
import { api } from '../api.js'

// GET /api/client/me
// Small header payload — client's display name + visibility flags.
// Called once on dashboard mount so the shell can render the board
// name in the header.
export async function reviewerMe() {
  return api('/client/me')
}

// GET /api/client/applications
// Same shape as the superadmin list, minus cross-client rows.
export async function listReviewerApplications({ status = 'pending', limit = 25, offset = 0 } = {}) {
  const qs = new URLSearchParams()
  if (status) qs.set('status', status)
  qs.set('limit', String(limit))
  qs.set('offset', String(offset))
  return api(`/client/applications?${qs}`)
}

// GET /api/client/applications/{id}
export async function getReviewerApplication(id) {
  return api(`/client/applications/${id}`)
}

// POST /api/client/applications/{id}/approve
// Body: { note }
// Returns { application_id, org_id, admin_username, magic_link_url,
// operator_username, operator_password }.
export async function approveReviewerApplication(id, note) {
  return api(`/client/applications/${id}/approve`, {
    method: 'POST',
    body: { note: note || '' },
  })
}

// POST /api/client/applications/{id}/reject
// Body: { note }  — note is required, backend rejects with 400 otherwise.
export async function rejectReviewerApplication(id, note) {
  return api(`/client/applications/${id}/reject`, {
    method: 'POST',
    body: { note: note || '' },
  })
}
