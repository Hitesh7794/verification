import { useCallback, useEffect, useState } from 'react'
import AdminShell, { PageHead } from '../../components/shell/AdminShell.jsx'
import { Button, Card, CardBody } from '../../components/ui/ui.jsx'
import { Pill } from '../../components/ui/extras.jsx'
import { FadeIn } from '../../components/ui/motion.jsx'
import { getCatalog, subscribeExam, unsubscribeExam } from '../../lib/admin/examSubscriptions.js'
import { dateRange } from '../../lib/dates.js'

// Admin > Exam catalog — read-only browse of every visible client and
// their open exams. Access to specific exams is granted automatically
// when the org's KYC is approved (V15 fan-out); the admin can't
// subscribe or unsubscribe from here. This page exists for context —
// "here's what the platform offers" — not as an action surface.
//
// Any exam the org already has an approved subscription for is tagged
// with a "Subscribed" pill; everything else reads as available.
export default function Catalog() {
  const [clients, setClients] = useState([])
  const [initialLoading, setInitialLoading] = useState(true)
  const [err, setErr] = useState('')
  // Track the exam being subscribed so the row's button can show a
  // loading state without disabling every other row's button too.
  const [busyExamId, setBusyExamId] = useState(null)

  const loadData = useCallback(async () => {
    setInitialLoading(true)
    setErr('')
    try {
      const data = await getCatalog()
      setClients(data || [])
    } catch (e) {
      setErr(e.message || 'Could not load catalog')
    } finally {
      setInitialLoading(false)
    }
  }, [])

  useEffect(() => { loadData() }, [loadData])

  // Optimistically flip the exam's status to 'approved' in the local
  // state — the backend adminSubscribe path either approves the row
  // outright (blanket-approved orgs) or leaves it pending. Either way
  // the row leaves 'Available' and reload reconciles anything stale.
  async function onSubscribe(examId) {
    setBusyExamId(examId)
    setErr('')
    try {
      await subscribeExam(examId)
      await loadData()
    } catch (e) {
      setErr(e?.body?.error || e?.message || 'Could not subscribe to this exam')
    } finally {
      setBusyExamId(null)
    }
  }

  async function onUnsubscribe(examId, examName) {
    if (!window.confirm(`Unsubscribe from "${examName}"? Any verification agents assigned to this exam will lose access.`)) return
    setBusyExamId(examId)
    setErr('')
    try {
      await unsubscribeExam(examId)
      await loadData()
    } catch (e) {
      setErr(e?.body?.error || e?.message || 'Could not unsubscribe from this exam')
    } finally {
      setBusyExamId(null)
    }
  }

  const isExamActive = (e) => {
    if (e.closed) return false
    if (e.verification_to && new Date() > new Date(e.verification_to)) return false
    return true
  }

  const visibleClients = clients
    .map((c) => ({ ...c, exams: (c.exams || []).filter(isExamActive) }))
    .filter((c) => c.exams.length > 0)

  return (
    <AdminShell>
      <FadeIn>
        <PageHead
          eyebrow="Catalog"
          title="Exam catalog"
          subtitle="Every open exam on the platform. Click Subscribe to add an exam your organisation isn't already granted access to. Exams from your approved KYC show as Subscribed automatically."
        />
        {err && (
          <div role="alert" className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
            {err}
          </div>
        )}
        {initialLoading ? (
          <div className="p-16 text-center text-sm text-slate-500">
            <div className="inline-block h-6 w-6 rounded-full border-2 border-slate-200 border-t-stone-900 animate-spin mb-3" />
            <p>Loading exam catalog…</p>
          </div>
        ) : visibleClients.length === 0 ? (
          <Card><CardBody>
            <div className="p-6 text-center">
              <p className="text-sm text-slate-500">No active exams in the catalog.</p>
              <p className="text-xs text-slate-400 mt-1">There are currently no active or upcoming examinations available.</p>
            </div>
          </CardBody></Card>
        ) : (
          <div className="space-y-4">
            {visibleClients.map((c) => (
              <Card key={c.id}>
                <CardBody className="p-0">
                  <div className="px-5 py-3 border-b border-slate-100 bg-slate-50/50">
                    <h3 className="text-sm font-semibold text-slate-900">{c.name}</h3>
                    {c.notes && <p className="text-xs text-slate-500 mt-0.5">{c.notes}</p>}
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wider text-slate-500">
                          <th className="px-5 py-2.5">Exam code</th>
                          <th className="px-5 py-2.5">Name</th>
                          <th className="px-5 py-2.5">Window</th>
                          <th className="px-5 py-2.5">Candidates</th>
                          <th className="px-5 py-2.5 text-right">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {c.exams.map((e) => {
                          const isSubscribed = e.subscription_status === 'approved' || e.subscribed
                          const isPending    = e.subscription_status === 'pending'
                          const rowBusy      = busyExamId === e.id
                          return (
                            <tr key={e.id} className="border-b border-slate-100 last:border-none hover:bg-slate-50/40">
                              <td className="px-5 py-3 font-mono text-xs text-slate-700 tabular-nums">{e.exam_code}</td>
                              <td className="px-5 py-3 text-slate-900 font-medium">{e.name}</td>
                              <td className="px-5 py-3 text-xs text-slate-600 tabular-nums">
                                {dateRange(e.verification_from, e.verification_to)}
                              </td>
                              <td className="px-5 py-3 text-slate-700 tabular-nums">{e.candidate_count}</td>
                              <td className="px-5 py-3 text-right">
                                {isSubscribed ? (
                                  <div className="inline-flex items-center gap-2">
                                    <Pill tone="emerald" dot>Subscribed</Pill>
                                    <Button
                                      variant="secondary"
                                      size="sm"
                                      disabled={rowBusy}
                                      onClick={() => onUnsubscribe(e.id, e.name)}
                                      className="!text-rose-700 !border-rose-200 hover:!bg-rose-50 hover:!border-rose-300"
                                    >
                                      {rowBusy ? 'Working…' : 'Unsubscribe'}
                                    </Button>
                                  </div>
                                ) : isPending ? (
                                  <Pill tone="amber" dot>Pending review</Pill>
                                ) : (
                                  <Button
                                    size="sm"
                                    disabled={rowBusy}
                                    onClick={() => onSubscribe(e.id)}
                                  >
                                    {rowBusy ? 'Subscribing…' : 'Subscribe'}
                                  </Button>
                                )}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </CardBody>
              </Card>
            ))}
          </div>
        )}
      </FadeIn>
    </AdminShell>
  )
}
