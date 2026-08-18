import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import AdminShell, { PageHead } from '../../components/shell/AdminShell.jsx'
import {
  Button,
  Card,
  CardBody,
} from '../../components/ui/ui.jsx'
import { Pill } from '../../components/ui/extras.jsx'
import { FadeIn } from '../../components/ui/motion.jsx'
import { getSubscriptions, unsubscribeExam } from '../../lib/admin/examSubscriptions.js'
import { dateRange } from '../../lib/dates.js'

// Admin > My exams — the exams this college has subscribed to. Read
// mostly; only action is Unsubscribe (which cascades operator_exams).
export default function MyExams() {
  const [subs, setSubs] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      setSubs(await getSubscriptions())
    } catch (e) {
      setErr(e.message || 'Could not load subscriptions')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  async function onUnsub(examId, opCount) {
    if (opCount > 0) {
      if (!confirm(`Unsubscribing will remove this exam from ${opCount} operator${opCount === 1 ? '' : 's'}. Continue?`)) return
    } else if (!confirm('Unsubscribe from this exam?')) return
    setBusy(examId)
    try {
      await unsubscribeExam(examId)
      await refresh()
    } catch (e) {
      setErr(e.message || 'Failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <AdminShell>
      <FadeIn>
        <PageHead
          eyebrow="Subscribed"
          title="My exams"
          right={<Link to="/admin/catalog" className="text-sm font-medium text-stone-900 hover:underline">Browse catalog →</Link>}
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
            ) : subs.length === 0 ? (
              <div className="p-10 text-center">
                <p className="text-sm text-slate-500">No exams subscribed yet.</p>
                <p className="text-xs text-slate-400 mt-1">
                  Go to the <Link to="/admin/catalog" className="text-indigo-600 hover:underline">Exam catalog</Link> and pick the exams your college needs.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wider text-slate-500 bg-slate-50">
                      <th className="px-4 py-2.5">Exam code</th>
                      <th className="px-4 py-2.5">Name</th>
                      <th className="px-4 py-2.5">Client</th>
                      <th className="px-4 py-2.5">Window</th>
                      <th className="px-4 py-2.5">Candidates</th>
                      <th className="px-4 py-2.5">Operators</th>
                      <th className="px-4 py-2.5">Status</th>
                      <th className="px-4 py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {subs.map((s) => (
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
                        <td className="px-4 py-3 text-right">
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={busy === s.exam_id}
                            onClick={() => onUnsub(s.exam_id, s.operator_count)}
                            className="!text-rose-700 !border-rose-200 hover:!bg-rose-50 hover:!border-rose-300"
                          >
                            {busy === s.exam_id ? 'Removing…' : 'Unsubscribe'}
                          </Button>
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
