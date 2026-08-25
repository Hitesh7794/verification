import { useCallback, useEffect, useState } from 'react'
import AdminShell, { PageHead } from '../../components/shell/AdminShell.jsx'
import {
  Button,
  Card,
  CardBody,
} from '../../components/ui/ui.jsx'
import { Pill } from '../../components/ui/extras.jsx'
import { FadeIn } from '../../components/ui/motion.jsx'
import { getCatalog, subscribeExam, unsubscribeExam } from '../../lib/admin/examSubscriptions.js'
import { dateRange } from '../../lib/dates.js'

// Admin > Exam catalog — self-service. Browse every visible client and
// their open exams. [Request Subscription] requests an exam for this college's
// portfolio; [Unsubscribe] removes it (and cascades operator_exams).
export default function Catalog() {
  const [clients, setClients] = useState([])
  const [initialLoading, setInitialLoading] = useState(true)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(null) // exam_id currently being toggled

  const loadData = useCallback(async (silent = false) => {
    if (!silent) setInitialLoading(true)
    setErr('')
    try {
      const data = await getCatalog()
      setClients(data || [])
    } catch (e) {
      setErr(e.message || 'Could not load catalog')
    } finally {
      if (!silent) setInitialLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData(false)
  }, [loadData])

  async function onToggle(ev, examId, currentlySubscribed, isBlanketApproved) {
    if (ev) {
      ev.preventDefault()
      ev.stopPropagation()
    }
    setBusy(examId)
    setErr('')

    // Optimistic local state update to prevent any jumping or flickering
    setClients((prevClients) =>
      prevClients.map((client) => ({
        ...client,
        exams: client.exams.map((exam) => {
          if (exam.id !== examId) return exam
          if (currentlySubscribed) {
            return {
              ...exam,
              subscribed: false,
              subscription_status: null,
            }
          }
          return {
            ...exam,
            subscribed: isBlanketApproved,
            subscription_status: isBlanketApproved ? 'approved' : 'pending',
          }
        }),
      }))
    )

    try {
      if (currentlySubscribed) {
        await unsubscribeExam(examId)
      } else {
        await subscribeExam(examId)
      }
      // Silent background refresh to reconcile server timestamps and IDs
      await loadData(true)
    } catch (e) {
      const status = e.status ? ` (HTTP ${e.status})` : ''
      const backend = e.body?.error ? `: ${e.body.error}` : ''
      setErr(`${e.message || 'Failed'}${status}${backend}`)
      // Rollback on error
      await loadData(true)
    } finally {
      setBusy(null)
    }
  }

  const isExamActive = (e) => {
    if (e.closed) return false
    if (e.verification_to && new Date() > new Date(e.verification_to)) return false
    return true
  }

  const visibleClients = clients
    .map((c) => ({
      ...c,
      exams: (c.exams || []).filter(isExamActive),
    }))
    .filter((c) => c.exams.length > 0 || c.client_blanket_approved)

  return (
    <AdminShell>
      <FadeIn>
        <PageHead
          eyebrow="Catalog"
          title="Exam catalog"
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
              <p className="text-xs text-slate-400 mt-1">There are currently no active or upcoming examinations available for subscription.</p>
            </div>
          </CardBody></Card>
        ) : (
          <div className="space-y-4">
            {visibleClients.map((c) => (
              <Card key={c.id}>
                <CardBody className="p-0">
                  <div className="px-5 py-3 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold text-slate-900">{c.name}</h3>
                        {c.client_blanket_approved && (
                          <Pill tone="emerald" size="sm">
                            Blanket Approved
                          </Pill>
                        )}
                      </div>
                      {c.notes && <p className="text-xs text-slate-500 mt-0.5">{c.notes}</p>}
                    </div>
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
                            <th className="px-5 py-2.5 text-right">Subscription Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {c.exams.map((e) => {
                            const isApproved = e.subscription_status === 'approved' || e.subscribed
                            const isPending = e.subscription_status === 'pending'
                            const isRejected = e.subscription_status === 'rejected'
                            const isRevoked = e.subscription_status === 'revoked'

                            return (
                              <tr key={e.id} className="border-b border-slate-100 last:border-none hover:bg-slate-50/40">
                                <td className="px-5 py-3 font-mono text-xs text-slate-700 tabular-nums">{e.exam_code}</td>
                                <td className="px-5 py-3 text-slate-900">
                                  <div className="font-medium">{e.name}</div>
                                  {isRejected && e.review_note && (
                                    <p className="text-xs text-rose-600 mt-0.5">Note: {e.review_note}</p>
                                  )}
                                  {isRevoked && e.review_note && (
                                    <p className="text-xs text-orange-700 mt-0.5">
                                      Access revoked — reason: {e.review_note}
                                    </p>
                                  )}
                                </td>
                                <td className="px-5 py-3 text-xs text-slate-600 tabular-nums">
                                  {dateRange(e.verification_from, e.verification_to)}
                                </td>
                                <td className="px-5 py-3 text-slate-700 tabular-nums">{e.candidate_count}</td>
                                <td className="px-5 py-3 text-right">
                                  {isApproved ? (
                                    <div className="inline-flex items-center gap-2">
                                      <Pill tone="emerald" dot>Subscribed</Pill>
                                      <Button
                                        type="button"
                                        variant="secondary"
                                        size="sm"
                                        disabled={busy === e.id}
                                        onClick={(ev) => onToggle(ev, e.id, true, c.client_blanket_approved)}
                                        className="!text-rose-700 !border-rose-200 hover:!bg-rose-50 hover:!border-rose-300"
                                      >
                                        Unsubscribe
                                      </Button>
                                    </div>
                                  ) : isPending ? (
                                    <div className="inline-flex items-center gap-2">
                                      <Pill tone="amber" dot>Pending Review</Pill>
                                      <Button
                                        type="button"
                                        variant="secondary"
                                        size="sm"
                                        disabled={busy === e.id}
                                        onClick={(ev) => onToggle(ev, e.id, true, c.client_blanket_approved)}
                                        className="!text-slate-600 hover:!text-slate-900"
                                      >
                                        Cancel
                                      </Button>
                                    </div>
                                  ) : isRejected ? (
                                    <div className="inline-flex items-center gap-2">
                                      <Pill tone="rose" dot>Rejected</Pill>
                                      <Button
                                        type="button"
                                        size="sm"
                                        disabled={busy === e.id}
                                        onClick={(ev) => onToggle(ev, e.id, false, c.client_blanket_approved)}
                                      >
                                        {busy === e.id ? 'Requesting…' : 'Re-Request'}
                                      </Button>
                                    </div>
                                  ) : isRevoked ? (
                                    <div className="inline-flex items-center gap-2">
                                      <Pill tone="amber" dot>Access Revoked</Pill>
                                      <Button
                                        type="button"
                                        size="sm"
                                        disabled={busy === e.id}
                                        onClick={(ev) => onToggle(ev, e.id, false, c.client_blanket_approved)}
                                      >
                                        {busy === e.id ? 'Requesting…' : 'Resubscribe'}
                                      </Button>
                                    </div>
                                  ) : (
                                    <Button
                                      type="button"
                                      size="sm"
                                      disabled={busy === e.id}
                                      onClick={(ev) => onToggle(ev, e.id, false, c.client_blanket_approved)}
                                    >
                                      {busy === e.id
                                        ? 'Submitting…'
                                        : c.client_blanket_approved
                                        ? 'Subscribe'
                                        : 'Request Subscription'}
                                    </Button>
                                  )}
                                </td>
                              </tr>
                            )
                          })}
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
    </AdminShell>
  )
}
