import { useCallback, useEffect, useState } from 'react'
import AdminShell, { PageHead } from '../../components/shell/AdminShell.jsx'
import { Card, CardBody } from '../../components/ui/ui.jsx'
import { Pill } from '../../components/ui/extras.jsx'
import { FadeIn } from '../../components/ui/motion.jsx'
import { getSubscriptions } from '../../lib/admin/examSubscriptions.js'
import { dateRange } from '../../lib/dates.js'

// Admin > Exams — read-only view of every exam this org has access to.
//
// Under the V15 flow exam access is minted automatically when the org's
// KYC is approved: the superadmin (or client reviewer, per mode) fires
// approveApplication, which fans out organization_exam_subscriptions
// rows for every visible + open exam under the destination client. The
// admin doesn't pick and doesn't unsubscribe — this page just tells
// them which exams their verification agents can be assigned to.
//
// Expired / closed exams are filtered out so the page reads as
// "what can my agents actually verify against right now"; the
// underlying rows still exist for audit + history views.
export default function MyExams() {
  const [subs, setSubs] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      setSubs(await getSubscriptions())
    } catch (e) {
      setErr(e.message || 'Could not load exams')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // Active = exam not closed AND today is within its verification window.
  // Uses verification_to as the past-cutoff so an archived exam whose
  // window ended yesterday drops off automatically without needing the
  // superadmin to also mark it closed=1.
  const isExamActive = (s) => {
    if (s.exam_closed) return false
    if (s.verification_to && new Date() > new Date(s.verification_to)) return false
    return true
  }

  const activeSubs = subs.filter(isExamActive)

  return (
    <AdminShell>
      <FadeIn>
        <PageHead
          eyebrow="Access"
          title="Exams"
          subtitle="Every exam under your assigned board that is currently open. Access is granted when your KYC is approved — assign these to your verification agents from the Agents tab."
        />
        {err && (
          <div role="alert" className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
            {err}
          </div>
        )}
        <Card>
          <CardBody className="p-0">
            {loading ? (
              <div className="p-10 text-center text-sm text-slate-500">Loading…</div>
            ) : activeSubs.length === 0 ? (
              <div className="p-10 text-center">
                <p className="text-sm text-slate-500">No active exams right now.</p>
                <p className="text-xs text-slate-400 mt-1">
                  Once your institution is routed to a board and approved, its open exams appear here automatically.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wider text-slate-500 bg-slate-50">
                      <th className="px-4 py-2.5">Exam code</th>
                      <th className="px-4 py-2.5">Name</th>
                      <th className="px-4 py-2.5">Board</th>
                      <th className="px-4 py-2.5">Window</th>
                      <th className="px-4 py-2.5">Candidates</th>
                      <th className="px-4 py-2.5">Verification Agents</th>
                      <th className="px-4 py-2.5">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeSubs.map((s) => (
                      <tr key={s.exam_id} className="border-b border-slate-100 last:border-none hover:bg-slate-50/60">
                        <td className="px-4 py-3 font-mono text-xs text-slate-700 tabular-nums">{s.exam_code}</td>
                        <td className="px-4 py-3 text-slate-900">{s.exam_name}</td>
                        <td className="px-4 py-3 text-xs text-slate-600">{s.client_name}</td>
                        <td className="px-4 py-3 text-xs text-slate-600 tabular-nums">{dateRange(s.verification_from, s.verification_to)}</td>
                        <td className="px-4 py-3 text-slate-700 tabular-nums">{s.candidate_count}</td>
                        <td className="px-4 py-3 text-slate-700 tabular-nums">{s.operator_count}</td>
                        <td className="px-4 py-3">
                          {s.exam_closed ? <Pill tone="amber" dot>Closed</Pill> : <Pill tone="emerald" dot>Active</Pill>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
      </FadeIn>
    </AdminShell>
  )
}
