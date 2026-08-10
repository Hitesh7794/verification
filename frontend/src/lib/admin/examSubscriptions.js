// Data-access for Phase-2 college-admin surface:
// exam catalog, my-exam subscriptions, multi-operator management.
import { api } from '../api.js'

// ── Catalog + subscriptions ───────────────────────────────────────────

export async function getCatalog() {
  const { clients } = await api('/admin/catalog')
  return clients
}

export async function getSubscriptions() {
  const { subscriptions } = await api('/admin/subscriptions')
  return subscriptions
}

export async function subscribeExam(examId) {
  return api('/admin/subscriptions', { method: 'POST', body: { exam_id: examId } })
}

export async function unsubscribeExam(examId) {
  return api(`/admin/subscriptions/${examId}`, { method: 'DELETE' })
}

// ── Multi-operator management ─────────────────────────────────────────

export async function listOperators() {
  const { operators } = await api('/admin/operators')
  return operators
}

export async function getOperator(id) {
  return api(`/admin/operators/${id}`)
}

export async function createOperator(fields) {
  // fields: { username, password, display_name, spending_cap_paise,
  //           valid_from, valid_to, exam_ids[] }
  return api('/admin/operators', { method: 'POST', body: fields })
}

export async function patchOperator(id, patch) {
  return api(`/admin/operators/${id}`, { method: 'PATCH', body: patch })
}

export async function disableOperator(id) {
  return api(`/admin/operators/${id}/disable`, { method: 'POST' })
}

export async function enableOperator(id) {
  return api(`/admin/operators/${id}/enable`, { method: 'POST' })
}
