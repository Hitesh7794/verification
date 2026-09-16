import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import ReviewerShell, { ReviewerPageHead } from '../../components/reviewer/ReviewerShell.jsx'
import { Button, Card, CardBody, Input, Label } from '../../components/ui/ui.jsx'
import { Icon, Pill, Skeleton, StatTile } from '../../components/ui/extras.jsx'
import { FadeIn, StaggerItem, StaggerList } from '../../components/ui/motion.jsx'
import { CountUp } from '../../components/shell/SuperUI.jsx'
import { Band, Rule } from '../../components/reviewer/BoardBand.jsx'
import {
  listReviewerApplications,
  listReviewerExams,
  bulkApproveReviewerApplications,
  bulkRejectReviewerApplications,
  revokeReviewerApplication,
  reviewerMe,
} from '../../lib/reviewer/api.js'

// The three slices of the inbox. Held as data so the tab row can be a
// single map — which is what lets one shared pill slide between tabs.
const TABS = [
  { key: 'all',      label: 'All',      badge: 'bg-slate-200 text-slate-800' },
  { key: 'pending',  label: 'Pending',  badge: 'bg-amber-100 text-amber-800' },
  { key: 'approved', label: 'Approved', badge: 'bg-emerald-100 text-emerald-800' },
  { key: 'rejected', label: 'Rejected', badge: 'bg-rose-100 text-rose-800' },
]

// Reviewer > KYC applications.
//
// Institutions registering under a client whose kyc_review_mode is
// 'client' (or 'both' after the superadmin's first approval) land
// here. Reviewer decides one-by-one via the Review button, or in bulk
// via the checkbox column + the mass-action bar that appears when at
// least one pending row is checked.

export default function ReviewerKycInbox() {
  const [status, setStatus] = useState('pending') // 'all' | 'pending' | 'approved' | 'rejected'
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [counts, setCounts] = useState(null)
  const [client, setClient] = useState(null)
  const [exams, setExams] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [search, setSearch] = useState('')
  const [revokingId, setRevokingId] = useState(null)

  // Tab counts ride along with the list response (`counts`), so there
  // is no separate stats fetch here. See the useMemo(...) block a few
  // lines down.

  // Selection state — only meaningful on the 'pending' tab. Cleared on
  // tab switch + on refresh so the count in the mass-action bar never
  // references rows that are no longer visible.
  const [selectedIds, setSelectedIds] = useState(() => new Set())

  // Mass-action modal state: {kind: 'approve'|'reject'} when open.
  const [modal, setModal] = useState(null)
  const [note, setNote] = useState('')
  const [actionBusy, setActionBusy] = useState(false)
  const [actionErr, setActionErr] = useState('')
  const [lastResult, setLastResult] = useState(null) // {requested, succeeded, failed, results}

  const load = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      // Exams ride along with the queue: the windows panel is part of
      // the same card, and a second spinner for it would make the head
      // of the page flicker in two stages.
      // "All" has no status of its own on the server — each list is
      // scoped to this desk differently (pending by whose queue it is in,
      // approved and rejected by which desk decided). Asking for the
      // three and merging keeps those rules exactly as the individual
      // tabs apply them, rather than inventing a fourth on the server.
      const statuses = status === 'all' ? ['pending', 'approved', 'rejected'] : [status]
      const [appResults, meRes, examRes] = await Promise.all([
        Promise.all(statuses.map((st) => listReviewerApplications({ status: st, limit: 100, offset: 0 }))),
        reviewerMe(),
        listReviewerExams().catch(() => []),
      ])
      const merged = appResults
        .flatMap((r) => r.items || [])
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      setItems(merged)
      setTotal(appResults.reduce((n, r) => n + (r.total || 0), 0))
      setCounts(appResults[0]?.counts || null)
      setClient(meRes)
      setExams(Array.isArray(examRes) ? examRes : (examRes?.items || []))
    } catch (e) {
      setErr(e?.body?.error || e?.message || 'Could not load applications')
    } finally {
      setLoading(false)
    }
  }, [status])

  useEffect(() => { load() }, [load])
  useEffect(() => { setSelectedIds(new Set()); setLastResult(null) }, [status])

  // Tab badges come from the SAME response as the list (counts are
  // computed on the CP over the rows this reviewer can actually see).
  // They previously read client.stats, which the DP derives from its
  // own institution_applications table -- a different table from the
  // one the list reads, so the badges disagreed with the rows on
  // screen and never moved after an approve/reject/revoke. The old
  // `??` fallbacks could not save it either: the DP returns a real 0
  // rather than undefined, so `??` kept the 0.
  //
  // load() re-runs after every action and on tab switch, so these
  // refresh with the list.
  const stats = useMemo(() => {
    const pending = counts?.pending ?? (status === 'pending' ? total : 0)
    const approved = counts?.approved ?? (status === 'approved' ? total : 0)
    const rejected = counts?.rejected ?? (status === 'rejected' ? total : 0)
    return {
      total: counts ? pending + approved + rejected : total,
      pending,
      approved,
      rejected,
      universities: approved,
    }
  }, [counts, total, status])

  // Null until /me lands, so the generic icon never flashes under a
  // board that has its own artwork.

  // Windows that are open right now, soonest to close first. A
  // reviewer's day is governed by these: an exam whose window shuts
  // tonight is the reason the queue has to be cleared today.
  const liveExams = useMemo(() => {
    const now = Date.now()
    return (exams || [])
      .filter((e) => !e.closed && e.verification_from && e.verification_to)
      .map((e) => ({
        ...e,
        from: new Date(e.verification_from).getTime(),
        to: new Date(e.verification_to).getTime(),
      }))
      .filter((e) => e.from <= now && now <= e.to)
      .sort((a, b) => a.to - b.to)
  }, [exams])

  const outcome = useMemo(() => {
    const total = client?.stats?.verifications_total ?? 0
    const passed = client?.stats?.verified_total ?? 0
    const denied = client?.stats?.denied_total ?? 0
    return { total, passed, denied, rate: total > 0 ? (passed / total) * 100 : 0 }
  }, [client])

  // A tile click switches the list to that slice and brings the list
  // into view — the same move the superadmin tile makes to its table.
  //
  // The scroll waits for the new slice to finish loading. Scrolling at
  // the moment of the click measured the page while it still held the
  // previous slice (or the loading placeholders), so on a short list
  // the scroll ran out of page and stopped halfway.
  //
  // Two steps, because the render straight after the click still has
  // loading === false — the fetch starts in an effect a moment later. A
  // single flag scrolled in that render, against the old list. So the
  // click arms the scroll, the fetch starting moves it on, and only the
  // fetch finishing fires it.
  const listRef = useRef(null)
  const scrollPhase = useRef('idle') // 'idle' | 'armed' | 'loading'
  function openSlice(next) {
    if (next === status) {
      listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }
    scrollPhase.current = 'armed'
    setStatus(next)
  }
  useEffect(() => {
    if (loading && scrollPhase.current === 'armed') {
      scrollPhase.current = 'loading'
      return
    }
    if (!loading && scrollPhase.current === 'loading') {
      scrollPhase.current = 'idle'
      // One frame for the rows to be laid out before measuring.
      requestAnimationFrame(() =>
        listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    }
  }, [loading])

  const isPendingTab = status === 'pending'
  const selectionCount = selectedIds.size

  const filteredItems = useMemo(() => {
    const s = search.trim().toLowerCase()
    if (!s) return items
    return items.filter((it) =>
      (it.institution_name || '').toLowerCase().includes(s) ||
      (it.head_name || '').toLowerCase().includes(s) ||
      (it.city || '').toLowerCase().includes(s) ||
      (it.state || '').toLowerCase().includes(s) ||
      (it.aishe_code || '').toLowerCase().includes(s)
    )
  }, [items, search])

  const allVisibleIds = useMemo(() => filteredItems.map((i) => i.id), [filteredItems])
  const allSelected = isPendingTab && filteredItems.length > 0 && filteredItems.every((i) => selectedIds.has(i.id))

  function toggleOne(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  function toggleAll() {
    setSelectedIds(allSelected ? new Set() : new Set(allVisibleIds))
  }

  function openMassAction(kind) {
    setModal({ kind })
    setNote('')
    setActionErr('')
  }
  function closeModal() {
    if (actionBusy) return
    setModal(null)
    setNote('')
    setActionErr('')
  }

  async function confirmMassAction() {
    if (!modal) return
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    if (modal.kind === 'reject' && !note.trim()) {
      setActionErr('A note is required — it will be sent to every rejected institution.')
      return
    }
    setActionBusy(true)
    setActionErr('')
    try {
      const fn = modal.kind === 'approve' ? bulkApproveReviewerApplications : bulkRejectReviewerApplications
      const res = await fn(ids, note.trim())
      setLastResult({ kind: modal.kind, ...res })
      setModal(null)
      setSelectedIds(new Set())
      await load()
    } catch (e) {
      setActionErr(e?.body?.error || e?.message || 'Action failed')
    } finally {
      setActionBusy(false)
    }
  }

  async function handleRevoke(id) {
    if (!confirm('Revoke this rejected application back to Pending review?')) return
    setRevokingId(id)
    try {
      await revokeReviewerApplication(id)
      await load()
    } catch (e) {
      setErr(e?.body?.error || e?.message || 'Could not revoke application')
    } finally {
      setRevokingId(null)
    }
  }

  return (
    <ReviewerShell>
      <FadeIn>
        {/* The board's identity lives in the chrome, so the page opens
            straight on the numbers. */}
        <h1 className="sr-only">{client?.name || 'Board KYC & Institutional Approvals'}</h1>

        {/* The superadmin Applications page's own tiles — the same
            StatTile component, same order, accents, icons and captions —
            so a reviewer and the platform team filter an application
            queue the same way. Each tile switches the list below to its
            slice and brings the list into view; the active one takes its
            accent border. */}
        <div className="mb-6 grid gap-4 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-stretch">
        <StaggerList className="grid gap-4 grid-cols-2 lg:grid-cols-4">
          <StaggerItem>
            <StatTile label="Pending" value={stats.pending} accent="pending" icon={Icon.Clock}
                      hint="Awaiting your review"
                      onClick={() => openSlice('pending')} active={status === 'pending'} />
          </StaggerItem>
          <StaggerItem>
            <StatTile label="Approved" value={stats.approved} accent="approved" icon={Icon.Check}
                      hint="Active institutions"
                      onClick={() => openSlice('approved')} active={status === 'approved'} />
          </StaggerItem>
          <StaggerItem>
            <StatTile label="Rejected" value={stats.rejected} accent="rejected" icon={Icon.X}
                      hint="Returned for changes"
                      onClick={() => openSlice('rejected')} active={status === 'rejected'} />
          </StaggerItem>
          <StaggerItem>
            <StatTile label="Total" value={stats.total} accent="total" icon={Icon.File}
                      hint="All submissions"
                      onClick={() => openSlice('all')} active={status === 'all'} />
          </StaggerItem>
        </StaggerList>

        <Band>
          <div className="shrink-0">
            <OutcomeDial {...outcome} />
          </div>
          <Rule />
          <div className="shrink-0 xl:w-[220px]">
            <LiveWindows exams={liveExams} />
          </div>
        </Band>
        </div>

        {err && (
          <div role="alert" className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
            {err}
          </div>
        )}

        {lastResult && (
          <div className={`mb-4 rounded-lg px-3 py-2 text-sm border ${
            lastResult.failed === 0
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-amber-50 border-amber-200 text-amber-800'
          }`}>
            <span className="font-semibold">
              {lastResult.kind === 'approve' ? 'Approved' : 'Rejected'} {lastResult.succeeded} of {lastResult.requested}.
            </span>
            {lastResult.failed > 0 && ' ' + lastResult.failed + ' skipped — see the results below.'}
            <button
              type="button"
              onClick={() => setLastResult(null)}
              className="ml-2 underline text-[12px] font-medium opacity-80 hover:opacity-100"
            >
              dismiss
            </button>
          </div>
        )}

        {/* Tab Controls and Search Bar */}
        <div ref={listRef} className="scroll-mt-28 flex flex-wrap items-center justify-between gap-4 mb-4">
          <div className="inline-flex rounded-xl bg-slate-100 p-1 text-sm font-medium">
            {TABS.map((t) => {
              const active = status === t.key
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setStatus(t.key)}
                  aria-pressed={active}
                  className="relative flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold"
                >
                  {/* The white pill is one element shared by all three
                      tabs — framer moves it to whichever tab is active
                      rather than fading one out and another in. */}
                  {active && (
                    <motion.span
                      layoutId="reviewer-tab-pill"
                      className="absolute inset-0 rounded-lg bg-white shadow-sm"
                      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                    />
                  )}
                  <span className={`relative transition-colors ${
                    active ? 'text-slate-900' : 'text-slate-600 hover:text-slate-900'}`}>
                    {t.label}
                  </span>
                  <span className={`relative rounded-full px-2 py-0.5 text-[10px] tabular-nums transition-colors ${
                    active ? t.badge : 'bg-slate-200 text-slate-700'}`}>
                    {t.key === 'all' ? stats.total : stats[t.key]}
                  </span>
                </button>
              )
            })}
          </div>

          <div className="flex items-center gap-3 w-full sm:w-auto">
            <Button variant="secondary" size="sm" onClick={load} disabled={loading}>
              <Icon.RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span className="ml-1.5">{loading ? 'Refreshing…' : 'Refresh'}</span>
            </Button>
            <div className="flex-1 sm:w-64">
              <Input
                type="search"
                placeholder="Search by university, city, head…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="bg-white text-xs"
              />
            </div>
          </div>
        </div>

        {/* Bulk action bar — only visible on the pending tab when at least one row is selected */}
        {isPendingTab && selectionCount > 0 && (
          <div className="mb-4 sticky top-14 z-30 flex flex-wrap items-center gap-3 rounded-lg border border-warm-strong bg-warm-surface/95 backdrop-blur px-4 py-2 shadow-sm">
            <span className="text-sm font-semibold text-stone-900">
              {selectionCount} selected
            </span>
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="text-[12px] text-stone-500 hover:text-stone-800"
            >
              clear
            </button>
            <div className="flex-1" />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => openMassAction('reject')}
              className="!text-rose-700 !border-rose-200 hover:!bg-rose-50 hover:!border-rose-300"
            >
              Reject {selectionCount}
            </Button>
            <Button size="sm" onClick={() => openMassAction('approve')}>
              Approve {selectionCount}
            </Button>
          </div>
        )}

        <Card>
          <CardBody className="p-0">
            {loading ? (
              <RowSkeletons />
            ) : filteredItems.length === 0 ? (
              <EmptyState status={status} />
            ) : (
              <>
                {isPendingTab && (
                  <div className="flex items-center gap-3 px-4 sm:px-5 py-2.5 border-b border-warm bg-[#F6F8FA] text-[12px] text-stone-600">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                      checked={allSelected}
                      onChange={toggleAll}
                      aria-label="Select all visible pending applications"
                    />
                    <span className="font-medium">{allSelected ? 'All visible selected' : 'Select all visible'}</span>
                  </div>
                )}
                {/* Keyed on the tab so switching tabs replays the
                    entrance. Only the first rows are staggered — past
                    the fold nobody sees it, and a 100-row cascade
                    would just delay the list. */}
                <ul key={status} className="divide-y divide-warm">
                  {filteredItems.map((it, i) => (
                    <Row
                      key={it.id}
                      it={it}
                      index={i}
                      selectable={isPendingTab}
                      selected={selectedIds.has(it.id)}
                      onToggle={() => toggleOne(it.id)}
                      onRevoke={() => handleRevoke(it.id)}
                      revoking={revokingId === it.id}
                    />
                  ))}
                </ul>
              </>
            )}
          </CardBody>
        </Card>

        {total > filteredItems.length && !search && (
          <p className="mt-3 text-[11px] text-stone-500 text-center">
            Showing {filteredItems.length} of {total} applications.
          </p>
        )}
      </FadeIn>

      {modal && (
        <MassActionModal
          kind={modal.kind}
          count={selectionCount}
          note={note}
          onNoteChange={setNote}
          busy={actionBusy}
          err={actionErr}
          onConfirm={confirmMassAction}
          onCancel={closeModal}
        />
      )}
    </ReviewerShell>
  )
}



// OutcomeDial — the pass rate as a ring, because it is the number the
// board is judged on and it was previously the smallest text on the
// page. The ring is drawn from one scale: the emerald arc is the pass
// share of the whole, the rose remainder is the denials, and the figure
// in the middle names the same quantity. Both counts are printed beside
// it, so nothing has to be read off the geometry.
function OutcomeDial({ total, passed, denied, rate }) {
  const R = 30
  const C = 2 * Math.PI * R
  const share = total > 0 ? passed / total : 0
  return (
    <div className="flex items-center gap-4">
      <div className="relative shrink-0">
        <svg width="76" height="76" viewBox="0 0 76 76" aria-hidden="true" className="-rotate-90">
          <circle cx="38" cy="38" r={R} fill="none" stroke="#FECDD3" strokeWidth="8" />
          <motion.circle
            cx="38" cy="38" r={R} fill="none"
            stroke="#059669" strokeWidth="8" strokeLinecap="round"
            strokeDasharray={C}
            initial={{ strokeDashoffset: C }}
            animate={{ strokeDashoffset: C * (1 - share) }}
            transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[15px] font-semibold text-slate-900 tabular-nums leading-none">
            <CountUp value={rate} format="pct" />
          </span>
          <span className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-slate-400 mt-1">
            Pass
          </span>
        </div>
      </div>
      <dl className="min-w-0 space-y-1.5 text-[12.5px]">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="h-2 w-2 rounded-full bg-emerald-600 shrink-0" />
          <dt className="text-slate-500">Passed</dt>
          <dd className="font-semibold text-slate-900 tabular-nums ml-auto">{passed}</dd>
        </div>
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="h-2 w-2 rounded-full bg-rose-300 shrink-0" />
          <dt className="text-slate-500">Denied</dt>
          <dd className="font-semibold text-slate-900 tabular-nums ml-auto">{denied}</dd>
        </div>
        <div className="flex items-center gap-2 pt-1.5 border-t border-slate-100">
          <dt className="text-slate-500">Verifications</dt>
          <dd className="font-semibold text-slate-900 tabular-nums ml-auto">{total}</dd>
        </div>
      </dl>
    </div>
  )
}

// LiveWindows — the exams whose verification window is open right now.
// The bar is elapsed time, not progress through the candidates: what a
// reviewer needs to see is how much of the window is left, because an
// institution approved after it shuts cannot verify anyone for that
// exam. Soonest to close sits first; two is enough for the card.
function LiveWindows({ exams }) {
  const now = Date.now()
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
        Verification windows open
      </p>
      {exams.length === 0 ? (
        <p className="mt-2 text-[12.5px] text-slate-400">None open right now.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {exams.slice(0, 2).map((e) => {
            const span = Math.max(1, e.to - e.from)
            const elapsed = Math.min(1, Math.max(0, (now - e.from) / span))
            const daysLeft = Math.ceil((e.to - now) / 86400000)
            const closing = daysLeft <= 2
            return (
              <li key={e.id}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-[12.5px] font-semibold text-slate-800"
                        title={`${e.exam_code || e.name} · ${e.candidate_count ?? 0} candidates`}>
                    {e.exam_code || e.name}
                    <span className="ml-1.5 font-normal text-slate-400 tabular-nums">{e.candidate_count ?? 0}</span>
                  </span>
                  <span className={`text-[11.5px] font-semibold tabular-nums shrink-0 ${
                    closing ? 'text-amber-700' : 'text-slate-500'}`}>
                    {daysLeft <= 1 ? 'closes today' : `${daysLeft} days left`}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${elapsed * 100}%` }}
                    transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
                    className={`h-full rounded-full ${closing ? 'bg-amber-500' : 'bg-brand-500'}`}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// RowSkeletons — what the list shows while a fetch is in flight.
// Shaped like the rows that replace them, so the card doesn't collapse
// to a single line of text and then jump back open.
function RowSkeletons({ rows = 4 }) {
  return (
    <ul className="divide-y divide-warm">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="flex items-start gap-3 p-4 sm:p-5">
          <div className="min-w-0 flex-1 space-y-2.5">
            <Skeleton className="h-4 w-56 max-w-[70%]" />
            <Skeleton className="h-3 w-80 max-w-[90%]" />
            <Skeleton className="h-3 w-40" />
          </div>
          <Skeleton className="h-8 w-20 rounded-lg shrink-0" />
        </li>
      ))}
    </ul>
  )
}

function EmptyState({ status }) {
  const label =
    status === 'all'
      ? 'No applications yet'
      : status === 'pending'
      ? 'No pending applications'
      : status === 'approved'
      ? 'No approved applications'
      : 'No rejected applications'
  const sub =
    status === 'all' || status === 'pending'
      ? 'When institutions register and select your exam board, their applications will appear here for verification.'
      : status === 'approved'
      ? 'Applications you approve will be listed here with their assigned credentials.'
      : 'Applications you reject will be archived here.'
  return (
    <div className="p-12 text-center">
      <div className="mx-auto h-12 w-12 rounded-xl bg-stone-100 text-stone-800 flex items-center justify-center mb-3">
        <Icon.FileText className="h-6 w-6" />
      </div>
      <p className="text-sm font-semibold text-stone-900">{label}</p>
      <p className="mt-1 text-xs text-stone-500 max-w-sm mx-auto">{sub}</p>
    </div>
  )
}

// Register.jsx replaces institution_type 'other' with the free-text body
// name on submit, so a govt commission arrives as e.g. "Staff Selection
// Commission". Anything that is not a college or university is one, and
// its identifier is a gazette / CIN reference rather than an AISHE code.
const ACADEMIC_TYPES = ['college', 'university']

function isRecruiterType(t) {
  return !ACADEMIC_TYPES.includes(String(t || '').trim().toLowerCase())
}

function Row({ it, index = 0, selectable, selected, onToggle, onRevoke, revoking }) {
  return (
    <motion.li
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, delay: Math.min(index, 7) * 0.035, ease: [0.22, 1, 0.36, 1] }}
      className="flex items-start gap-3 p-4 sm:p-5 hover:bg-stone-50/70 transition-colors">
      {selectable && (
        <div className="pt-1">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            checked={selected}
            onChange={onToggle}
            aria-label={`Select application ${it.id} for ${it.institution_name}`}
          />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <h3 className="text-sm font-semibold text-ink-900 truncate">
            {it.institution_name}
          </h3>
          <span className="text-[11px] text-stone-400">·</span>
          <span className="text-xs text-stone-600 capitalize">
            {it.institution_type?.replace(/_/g, ' ') || 'institution'}
          </span>
          {it.tier && (
            <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-medium text-stone-700">
              Tier {it.tier}
            </span>
          )}
          {it.status === 'pending' && <Pill tone="amber" dot>Pending Review</Pill>}
          {it.status === 'approved' && <Pill tone="emerald" dot>Approved</Pill>}
          {it.status === 'rejected' && <Pill tone="rose" dot>Rejected</Pill>}
        </div>

        <p className="mt-1 text-xs text-stone-600">
          <span className="font-medium text-stone-800">{it.head_name}</span>
          {it.head_email && <span className="text-stone-400 font-mono text-[11px]"> · {it.head_email}</span>}
          {it.city && it.state && <span className="text-stone-500"> · {it.city}, {it.state}</span>}
          {it.aishe_code && <span className="text-stone-400 font-mono text-[11px]"> · {isRecruiterType(it.institution_type) ? 'Govt / CIN Ref' : 'AISHE'}: {it.aishe_code}</span>}
        </p>

        <div className="mt-2 flex items-center gap-3 text-[11px] text-stone-400">
          <span>Submitted {it.created_at ? new Date(it.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}</span>
          <span>·</span>
          <span>{it.doc_count || 0} supporting doc{(it.doc_count || 0) === 1 ? '' : 's'}</span>
        </div>
      </div>

      <div className="shrink-0 flex items-center gap-2 pt-0.5">
        {it.status === 'rejected' && (
          <Button
            variant="secondary"
            size="sm"
            onClick={onRevoke}
            disabled={revoking}
            className="!text-amber-700 !border-amber-300 hover:!bg-amber-50 hover:!border-amber-400 !text-xs font-semibold"
          >
            <Icon.RefreshCw className={`h-3 w-3 mr-1 ${revoking ? 'animate-spin' : ''}`} />
            {revoking ? 'Revoking…' : 'Revoke'}
          </Button>
        )}
        <Link
          to={`/reviewer/applications/${it.id}`}
          className="inline-flex items-center px-3 py-1.5 text-xs font-semibold rounded-lg bg-brand-600 text-white hover:bg-brand-700 transition-colors"
        >
          Review
        </Link>
      </div>
    </motion.li>
  )
}


function MassActionModal({ kind, count, note, onNoteChange, busy, err, onConfirm, onCancel }) {
  const isApprove = kind === 'approve'
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-900/40 backdrop-blur-xs">
      <div className="w-full max-w-md rounded-2xl bg-white border border-stone-200 shadow-2xl overflow-hidden">
        <div className="p-6">
          <h3 className="text-base font-semibold text-stone-900">
            {isApprove ? `Approve ${count} application${count === 1 ? '' : 's'}?` : `Reject ${count} application${count === 1 ? '' : 's'}?`}
          </h3>
          <p className="mt-1.5 text-xs text-stone-600 leading-relaxed">
            {isApprove
              ? `This will create active institution organizations and email welcome credentials to all ${count} selected applicants.`
              : `This will reject the ${count} selected applications. The review note below will be emailed to each applicant explaining the decision.`}
          </p>

          <div className="mt-4">
            <Label className="text-xs">
              {isApprove ? 'Internal approval note (optional)' : 'Rejection reason (required)'}
            </Label>
            <textarea
              rows={3}
              value={note}
              onChange={(e) => onNoteChange(e.target.value)}
              placeholder={isApprove ? 'e.g. Verified with state medical council list' : 'e.g. Incomplete AISHE accreditation documentation'}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-800 placeholder-slate-400 focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-500/12"
            />
          </div>

          {err && (
            <div role="alert" className="mt-3 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-700">
              {err}
            </div>
          )}

          <div className="mt-6 flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={onConfirm}
              disabled={busy || (!isApprove && !note.trim())}
              className={!isApprove ? '!bg-rose-600 hover:!bg-rose-700 !text-white' : ''}
            >
              {busy ? 'Processing…' : (isApprove ? `Approve (${count})` : `Reject (${count})`)}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Stats row ─────────────────────────────────────────────────────────
//
// Four tiles above the tab strip. Each tile that maps to a tab is a
// button that switches the inbox to that tab on click; the "Active
// institutes" tile is inert (no matching tab to jump to). The active
// tab's tile gets a lifted / ringed look so the reviewer sees which
// slice they're looking at.
//
// Numbers animate up from 0 the first time they land (CountUp) so a
// screen refresh feels alive; that's the "interactive" hint — beyond
// that we intentionally kept motion cheap so a reviewer scrolling
// through the inbox isn't distracted by numbers popping constantly.

// StatsRow / StatTile / CountUp removed — the reviewer stats surface
// is now the hero card at the top of KycInbox (from rahul-FE) which
// reads a different response shape (stats.total / .pending / .approved
// / .universities). Keep this comment as a breadcrumb: if the click-
// to-filter interactive tiles are wanted back, they lived here and
// consumed the older stats.pending_review / .approved_this_week fields
// on the reviewerStats endpoint.
