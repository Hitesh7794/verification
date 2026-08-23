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

// ── Exam Subscription Requests ─────────────────────────────────────────

// GET /api/client/subscription-requests
export async function listSubscriptionRequests({ status = 'pending', examId = '' } = {}) {
  const qs = new URLSearchParams()
  if (status) qs.set('status', status)
  if (examId && examId !== 'all') qs.set('exam_id', examId)
  return api(`/client/subscription-requests?${qs}`)
}

// POST /api/client/subscription-requests/{org_id}/{exam_id}/approve
// mode: "per_exam" | "blanket_client"
export async function approveSubscriptionRequest(orgId, examId, { mode = 'per_exam', note = '' } = {}) {
  return api(`/client/subscription-requests/${orgId}/${examId}/approve`, {
    method: 'POST',
    body: { mode, note },
  })
}

// POST /api/client/subscription-requests/{org_id}/{exam_id}/reject
export async function rejectSubscriptionRequest(orgId, examId, { note = '' } = {}) {
  return api(`/client/subscription-requests/${orgId}/${examId}/reject`, {
    method: 'POST',
    body: { note },
  })
}

// POST /api/client/subscription-requests/bulk-approve
// orgIds: number[], examIds: number[], mode: "per_exam" | "blanket_client", note: string
export async function bulkApproveSubscriptionRequests({ orgIds = [], examIds = [], mode = 'per_exam', note = '' } = {}) {
  return api('/client/subscription-requests/bulk-approve', {
    method: 'POST',
    body: { org_ids: orgIds, exam_ids: examIds, mode, note },
  })
}

// POST /api/client/subscription-requests/bulk-reject
// orgIds: number[], examIds: number[], note: string
export async function bulkRejectSubscriptionRequests({ orgIds = [], examIds = [], note = '' } = {}) {
  return api('/client/subscription-requests/bulk-reject', {
    method: 'POST',
    body: { org_ids: orgIds, exam_ids: examIds, note },
  })
}

// POST /api/client/subscription-requests/{org_id}/{exam_id}/reset-pending
export async function resetSubscriptionRequestToPending(orgId, examId) {
  return api(`/client/subscription-requests/${orgId}/${examId}/reset-pending`, {
    method: 'POST',
  })
}

// POST /api/client/subscription-requests/{org_id}/{exam_id}/revoke
// Flip a previously-approved subscription to 'revoked'. Note is
// required — surfaces to the college admin so they know why access
// was pulled. Also cascades operator_exams cleanup so operators can't
// verify against this exam any more. College admin can then hit
// "Resubscribe" from their catalog, which sends the row back to
// 'pending'.
export async function revokeSubscription(orgId, examId, { note = '' } = {}) {
  return api(`/client/subscription-requests/${orgId}/${examId}/revoke`, {
    method: 'POST',
    body: { note },
  })
}
