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

export async function bulkCreateOperatorsCSV(file, defaultExamIds = []) {
  const fd = new FormData()
  fd.append('file', file)
  if (defaultExamIds && defaultExamIds.length > 0) {
    fd.append('default_exam_ids', defaultExamIds.join(','))
  }
  return api('/admin/operators/csv', {
    method: 'POST',
    body: fd,
  })
}

export function downloadSampleOperatorCSV(selectedSub = null) {
  const now = new Date()
  const fmtDate = (d, timeStr) => {
    const yyyy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd} ${timeStr}`
  }

  let dFrom = new Date(now.getTime() + 1 * 86400000) // tomorrow default
  let dTo = new Date(now.getTime() + 60 * 86400000) // 60 days default
  let examCode = ''

  if (selectedSub) {
    if (selectedSub.exam_code) {
      examCode = selectedSub.exam_code
    }
    if (selectedSub.verification_from) {
      const ef = new Date(selectedSub.verification_from)
      if (!isNaN(ef.getTime())) {
        dFrom = ef > now ? ef : new Date(now.getTime() + 3600000)
      }
    }
    if (selectedSub.verification_to) {
      const et = new Date(selectedSub.verification_to)
      if (!isNaN(et.getTime())) {
        dTo = et
      }
    }
  }

  const fromStr = fmtDate(dFrom, '09:00')
  const toStr = fmtDate(dTo, '18:00')

  const content = `username,password,display_name,email,phone,cap_amount,valid_from,valid_to,exam_codes
agent.rahul.demo,Pass@123456,Rahul Sharma,rahul.agent.demo@example.com,+919876543210,,${fromStr},${toStr},${examCode}
agent.priya.demo,Secure@2026,Priya Patel,priya.agent.demo@example.com,+919812345678,,${fromStr},${toStr},${examCode}
agent.amit.demo,Pass@Amit2026,Amit Kumar,amit.agent.demo@example.com,+919712345678,,${fromStr},${toStr},${examCode}
`
  const blob = new Blob(['\ufeff' + content], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'sample_verification_agents.csv'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
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

