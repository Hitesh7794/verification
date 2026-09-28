import BoardMark from '../../components/fv/BoardMark.jsx'
import CatalogScene from '../../components/fv/CatalogScene.jsx'
import { ArtExam, ArtBoard, ArtEnvelope, ArtStamp, ArtAssign, GlyphSheet, GlyphWindow, GlyphPeople } from '../../components/fv/FvArt.jsx'
import { useCallback, useEffect, useState } from 'react'
import AdminShell from '../../components/fv/FvAdminShell.jsx'
import { PageHead } from '../../components/shell/AdminShell.jsx'
import { Button, Card, CardBody } from '../../components/ui/ui.jsx'
import { Pill } from '../../components/ui/extras.jsx'
import { FadeIn } from '../../components/ui/motion.jsx'
import { getCatalog, subscribeExam, unsubscribeExam } from '../../lib/admin/examSubscriptions.js'
import { dateRange } from '../../lib/dates.js'

// Admin > Exam catalog.
//
// V16 flow (2026-09-10): KYC approval no longer auto-subscribes an
// institute to every exam under a client. The institute admin browses
// this catalog and clicks "Request access" per exam; the client's
// reviewer approves or rejects each request individually.
//
// Per-exam states rendered on this page:
//
//   • Subscribed        — green pill + Unsubscribe. Real
//                          organization_exam_subscriptions row with
//                          status='approved'. Includes both the new
//                          per-exam approvals and the grandfathered
//                          blanket_client rows from before V16.
//
//   • Pending approval  — amber pill. Row status='pending'. Reviewer
//                          got an email; nothing for the admin to do
//                          except wait.
//
//   • Rejected + note   — red banner with the reviewer's reason and
//                          a "Request again" button. Row status=
//                          'rejected'. Re-request overwrites the row
//                          back to 'pending' and re-emails the
//                          reviewer.
//
//   • Request access    — primary button. No row exists yet.
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
      {/* The catalog's living background: the answer sheet being filled in. */}
      <CatalogScene className="fixed bottom-[40px] right-[4%] z-0 h-[min(78vh,700px)] aspect-[360/440] opacity-[0.16]" />
      <div className="fv-bold relative z-[1]">
      <FadeIn>
        <PageHead
          eyebrow="Catalog"
          title="Exam catalog" art={ArtExam}
          subtitle="Exams you can ask to verify."
        />
        {err && (
          <div role="alert" className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
            {err}
          </div>
        )}
        {!initialLoading && <HowItWorks />}
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
                  <div className="flex items-center gap-4 px-5 py-4 border-b border-fv-line"
                       data-guide-title={c.name} data-guide="An exam board that approved you.">
                    <div className="min-w-0 flex-1">
                      <h3 className="fv-display text-[19px] font-bold tracking-[-0.015em] text-fv-ink">
                        <BoardMark name={c.name} size="lg" />
                      </h3>
                      {c.notes && <p className="text-[13px] text-fv-muted mt-1">{c.notes}</p>}
                    </div>
                    <span className="shrink-0 rounded-full bg-fv-card-focus px-3 py-1 text-[13px] font-semibold text-fv-accent-deep">
                      {c.exams.length} open {c.exams.length === 1 ? 'exam' : 'exams'}
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-fv-line text-left text-[13px] text-fv-muted">
                          <th className="px-5 py-2.5">Exam code</th>
                          <th className="px-5 py-2.5">Name</th>
                          <th className="px-5 py-2.5">Window</th>
                          <th className="px-5 py-2.5">Candidates</th>
                          <th className="px-5 py-2.5 text-right">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {c.exams.map((e) => {
                          // "Subscribed" means an actual sub row exists —
                          // NOT the blanket-coa flag from the client. If
                          // the admin unsubscribed from a blanket-approved
                          // exam, the row is gone and the button should
                          // read "Request access" so they can re-opt-in.
                          const isSubscribed = e.subscription_status === 'approved'
                          const isPending    = e.subscription_status === 'pending'
                          const isRejected   = e.subscription_status === 'rejected'
                          const rowBusy      = busyExamId === e.id
                          return (
                            <tr key={e.id} className="border-b border-fv-line last:border-none hover:bg-fv-page/60"
                                data-guide-title={e.name} data-guide="Request it, get approved, verify.">
                              <td className="px-5 py-3.5 text-[13px] font-semibold text-fv-muted tabular-nums">{e.exam_code || '—'}</td>
                              <td className="px-5 py-3.5">
                                <span className="flex items-center gap-3">
                                  <GlyphSheet className="h-8 w-8 shrink-0" />
                                  <span className="fv-display text-[16px] font-bold text-fv-ink">{e.name}</span>
                                </span>
                              </td>
                              <td className="px-5 py-3.5 text-[13.5px] text-fv-muted tabular-nums">
                                <span className="flex items-center gap-2">
                                  <GlyphWindow className="h-5 w-5 shrink-0" />
                                  {dateRange(e.verification_from, e.verification_to) || 'Window not set yet'}
                                </span>
                              </td>
                              <td className="px-5 py-3.5 text-[14px] font-semibold text-fv-ink tabular-nums">
                                <span className="flex items-center gap-2">
                                  <GlyphPeople className="h-5 w-5 shrink-0" />
                                  {e.candidate_count != null ? Number(e.candidate_count).toLocaleString('en-IN') : '—'}
                                </span>
                              </td>
                              <td className="px-5 py-3 text-right align-top">
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
                                  <Pill tone="amber" dot>Pending approval</Pill>
                                ) : isRejected ? (
                                  // Rejection panel — reviewer's note is
                                  // load-bearing UX: the whole point of
                                  // the reject flow is to tell the
                                  // institute why so they can fix and
                                  // re-request. Note goes above the
                                  // button, not tucked into a tooltip.
                                  <div className="inline-flex flex-col items-end gap-1.5 max-w-xs">
                                    <div className="inline-flex items-center gap-2">
                                      <Pill tone="rose" dot>Rejected</Pill>
                                      <Button
                                        size="sm"
                                        disabled={rowBusy}
                                        onClick={() => onSubscribe(e.id)}
                                      >
                                        {rowBusy ? 'Requesting…' : 'Request again'}
                                      </Button>
                                    </div>
                                    {e.review_note && (
                                      <p className="text-[11px] leading-snug text-rose-700 text-right">
                                        “{e.review_note}”
                                      </p>
                                    )}
                                  </div>
                                ) : (
                                  <Button
                                    size="sm"
                                    disabled={rowBusy}
                                    onClick={() => onSubscribe(e.id)}
                                  >
                                    <span className="inline-flex items-center gap-1.5">
                                      <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                        <path d="M2.5 5.5h15v10h-15z" /><path d="M2.5 5.5 10 11l7.5-5.5" />
                                      </svg>
                                      {rowBusy ? 'Requesting…' : 'Request access'}
                                    </span>
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
      </div>
    </AdminShell>
  )
}

// The three real steps from "I see an exam" to "my agents can verify it":
// big pictures, a few words each, arrows between them.
const STEPS = [
  { art: ArtEnvelope, title: 'Request', text: 'Tap Request access' },
  { art: ArtStamp, title: 'Approved', text: 'The board says yes' },
  { art: ArtAssign, title: 'Verify', text: 'Your agents get it' },
]
function HowItWorks() {
  return (
    <section className="mt-6" aria-label="How an exam becomes yours">
      <ol className="fv-stagger flex flex-col items-stretch gap-2 sm:flex-row">
        {STEPS.map(({ art: A, title, text }, i) => (
          <li key={title} className="contents">
            <div className="flex flex-1 flex-col items-center rounded-[12px] border border-fv-line bg-fv-card px-4 pt-5 pb-4 text-center"
                 data-guide-title={title} data-guide={text}>
              <A className="h-32 w-32" />
              <p className="fv-display mt-2 text-[20px] text-fv-ink">{title}</p>
              <p className="text-[14px] text-fv-muted">{text}</p>
            </div>
            {i < STEPS.length - 1 && (
              <svg viewBox="0 0 48 24" className="hidden w-12 shrink-0 self-center sm:block" aria-hidden="true">
                <path d="M2 12h38" stroke="#9A86D6" strokeWidth="3" strokeDasharray="5 5" strokeLinecap="round" />
                <path d="M34 5l9 7-9 7" fill="none" stroke="#5B3FA6" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </li>
        ))}
      </ol>
    </section>
  )
}
