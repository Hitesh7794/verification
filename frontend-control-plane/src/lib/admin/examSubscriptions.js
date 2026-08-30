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

export function downloadSampleOperatorCSV(subs = null) {
  const subList = Array.isArray(subs) ? subs : (subs ? [subs] : [])
  const now = new Date()
  const fmtDate = (d, timeStr) => {
    const yyyy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd} ${timeStr}`
  }

  const demoOperators = [
    { u: 'agent.rahul.demo', p: 'Pass@123456', n: 'Rahul Sharma', e: 'rahul.agent.demo@example.com', ph: '+919876543210' },
    { u: 'agent.priya.demo', p: 'Secure@2026', n: 'Priya Patel', e: 'priya.agent.demo@example.com', ph: '+919812345678' },
    { u: 'agent.amit.demo', p: 'Pass@Amit2026', n: 'Amit Kumar', e: 'amit.agent.demo@example.com', ph: '+919712345678' },
    { u: 'agent.sneha.demo', p: 'Sneha@123456', n: 'Sneha Gupta', e: 'sneha.agent.demo@example.com', ph: '+919612345678' },
  ]

  let rows = []
  if (subList.length > 0) {
    demoOperators.forEach((demo, idx) => {
      const sub = subList[idx % subList.length]
      let dFrom = new Date(now.getTime() + 1 * 86400000)
      let dTo = new Date(now.getTime() + 30 * 86400000)

      if (sub.verification_from) {
        const ef = new Date(sub.verification_from)
        if (!isNaN(ef.getTime())) {
          dFrom = ef > now ? ef : new Date(now.getTime() + 3600000)
        }
      }
      if (sub.verification_to) {
        const et = new Date(sub.verification_to)
        if (!isNaN(et.getTime())) {
          dTo = et
        }
      }
      const fromStr = fmtDate(dFrom, '09:00')
      const toStr = fmtDate(dTo, '18:00')
      const examCode = sub.exam_code || ''
      rows.push(`${demo.u},${demo.p},${demo.n},${demo.e},${demo.ph},,${fromStr},${toStr},${examCode}`)
    })
  } else {
    const fromStr = fmtDate(new Date(now.getTime() + 86400000), '09:00')
    const toStr = fmtDate(new Date(now.getTime() + 30 * 86400000), '18:00')
    rows.push(`agent.rahul.demo,Pass@123456,Rahul Sharma,rahul.agent.demo@example.com,+919876543210,,${fromStr},${toStr},EXAM_CODE`)
  }

  const content = `username,password,display_name,email,phone,cap_amount,valid_from,valid_to,exam_codes\n` + rows.join('\n') + '\n'
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

