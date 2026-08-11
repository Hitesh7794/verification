import { useCallback, useEffect, useState } from 'react'
import AppShell from '../../components/shell/AppShell.jsx'
import AdminTabs from '../../components/shell/AdminTabs.jsx'
import {
  Button,
  Card,
  CardBody,
  PageHeader,
} from '../../components/ui/ui.jsx'
import { Pill } from '../../components/ui/extras.jsx'
import { FadeIn } from '../../components/ui/motion.jsx'
import { getCatalog, subscribeExam, unsubscribeExam } from '../../lib/admin/examSubscriptions.js'
import { dateRange } from '../../lib/dates.js'

// Admin > Exam catalog — self-service. Browse every visible client and
// their open exams. [Subscribe] adds an exam to this college's
// portfolio; [Unsubscribe] removes it (and cascades operator_exams).
export default function Catalog() {
  const [clients, setClients] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(null) // exam_id currently being toggled

  const refresh = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      setClients(await getCatalog())
    } catch (e) {
      setErr(e.message || 'Could not load catalog')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  async function onToggle(examId, currentlySubscribed) {
    setBusy(examId)
    setErr('')
    try {
      if (currentlySubscribed) {
        await unsubscribeExam(examId)
      } else {
        await subscribeExam(examId)
      }
      await refresh()
    } catch (e) {
      const status = e.status ? ` (HTTP ${e.status})` : ''
      const backend = e.body?.error ? `: ${e.body.error}` : ''
      setErr(`${e.message || 'Failed'}${status}${backend}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <AppShell>
      <AdminTabs />
      <FadeIn>
        <PageHeader
          title="Exam catalog"
          subtitle="Every exam available on the platform. Subscribe to the ones your college needs."
        />
        {err && (
          <div role="alert" className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
            {err}
          </div>
        )}
        {loading ? (
          <div className="p-10 text-center text-sm text-slate-500">Loading…</div>
        ) : clients.length === 0 ? (
          <Card><CardBody>
            <div className="p-6 text-center">
              <p className="text-sm text-slate-500">Nothing in the catalog yet.</p>
              <p className="text-xs text-slate-400 mt-1">The platform team hasn't published any exams.</p>
            </div>
          </CardBody></Card>
        ) : (
          <div className="space-y-4">
            {clients.map((c) => (
              <Card key={c.id}>
                <CardBody className="p-0">
                  <div className="px-5 py-3 border-b border-slate-100 bg-slate-50/50">
                    <h3 className="text-sm font-semibold text-slate-900">{c.name}</h3>
                    {c.notes && <p className="text-xs text-slate-500 mt-0.5">{c.notes}</p>}
                  </div>
                  {c.exams.length === 0 ? (
                    <div className="px-5 py-4 text-xs text-slate-500">No open exams under this client.</div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wider text-slate-500">
                            <th className="px-5 py-2.5">Exam code</th>
                            <th className="px-5 py-2.5">Name</th>
                            <th className="px-5 py-2.5">Window</th>
                            <th className="px-5 py-2.5">Candidates</th>
                            <th className="px-5 py-2.5 text-right">Subscription</th>
                          </tr>
                        </thead>
                        <tbody>
                          {c.exams.map((e) => (
                            <tr key={e.id} className="border-b border-slate-100 last:border-none hover:bg-slate-50/40">
                              <td className="px-5 py-3 font-mono text-xs text-slate-700 tabular-nums">{e.exam_code}</td>
                              <td className="px-5 py-3 text-slate-900">{e.name}</td>
                              <td className="px-5 py-3 text-xs text-slate-600 tabular-nums">
                                {dateRange(e.verification_from, e.verification_to)}
                              </td>
                              <td className="px-5 py-3 text-slate-700 tabular-nums">{e.candidate_count}</td>
                              <td className="px-5 py-3 text-right">
                                {e.subscribed ? (
                                  <div className="inline-flex items-center gap-2">
                                    <Pill tone="emerald" dot>Subscribed</Pill>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      disabled={busy === e.id}
                                      onClick={() => onToggle(e.id, true)}
                                    >
                                      Unsubscribe
                                    </Button>
                                  </div>
                                ) : (
                                  <Button
                                    size="sm"
                                    disabled={busy === e.id}
                                    onClick={() => onToggle(e.id, false)}
                                  >
                                    {busy === e.id ? 'Adding…' : 'Subscribe'}
                                  </Button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardBody>
              </Card>
            ))}
          </div>
        )}
      </FadeIn>
    </AppShell>
  )
}
