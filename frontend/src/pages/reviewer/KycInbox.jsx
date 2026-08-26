import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import ReviewerShell, { ReviewerPageHead } from '../../components/reviewer/ReviewerShell.jsx'
import { Button, Card, CardBody, Label } from '../../components/ui/ui.jsx'
import { Icon, Pill } from '../../components/ui/extras.jsx'
import { FadeIn } from '../../components/ui/motion.jsx'
import {
  listReviewerApplications,
  bulkApproveReviewerApplications,
  bulkRejectReviewerApplications,
  reviewerStats,
} from '../../lib/reviewer/api.js'

// Reviewer > KYC applications.
//
// Institutions registering under a client whose kyc_review_mode is
// 'client' (or 'both' after the superadmin's first approval) land
// here. Reviewer decides one-by-one via the Review button, or in bulk
// via the checkbox column + the mass-action bar that appears when at
// least one pending row is checked.

const TABS = [
  { key: 'pending',  label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
]

export default function ReviewerKycInbox() {
  const [status, setStatus] = useState('pending')
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  // Stats-tile row: fetched once on mount + refetched after every bulk
  // action so the numbers stay in sync with the operator's own edits
  // without a manual refresh. Failure is silent — the tiles are a
  // nice-to-have; the inbox itself remains fully functional if the
  // stats endpoint hiccups.
  const [stats, setStats] = useState(null)
  const loadStats = useCallback(async () => {
    try { setStats(await reviewerStats()) } catch { /* silent */ }
  }, [])
  useEffect(() => { loadStats() }, [loadStats])

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
      const res = await listReviewerApplications({ status, limit: 50, offset: 0 })
      setItems(res.items || [])
      setTotal(res.total || 0)
    } catch (e) {
      setErr(e?.body?.error || e?.message || 'Could not load applications')
    } finally {
      setLoading(false)
    }
  }, [status])

  useEffect(() => { load() }, [load])
  useEffect(() => { setSelectedIds(new Set()); setLastResult(null) }, [status])

  const isPendingTab = status === 'pending'
  const selectionCount = selectedIds.size
  const allVisibleIds = useMemo(() => items.map((i) => i.id), [items])
  const allSelected = isPendingTab && items.length > 0 && items.every((i) => selectedIds.has(i.id))

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
      loadStats()
    } catch (e) {
      setActionErr(e?.body?.error || e?.message || 'Action failed')
    } finally {
      setActionBusy(false)
    }
  }

  return (
    <ReviewerShell>
      <FadeIn>
        <ReviewerPageHead
          eyebrow="Applications"
          title="KYC applications"
          subtitle="Institutions registering for this client. Approve or reject individually, or check multiple to act in bulk."
          right={
            <Button variant="secondary" size="sm" onClick={() => { load(); loadStats() }} disabled={loading}>
              <Icon.RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span className="ml-1.5">{loading ? 'Refreshing…' : 'Refresh'}</span>
            </Button>
          }
        />

        <StatsRow
          stats={stats}
          activeTab={status}
          onTileClick={(k) => setStatus(k)}
        />

        <div className="mb-5 flex items-center gap-1 border-b border-warm">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setStatus(t.key)}
              className={`relative px-3 py-2 text-[13px] font-semibold transition-colors ${
                status === t.key ? 'text-stone-900' : 'text-stone-500 hover:text-stone-800'
              }`}
            >
              {t.label}
              {status === t.key && (
                <span className="absolute inset-x-2 bottom-[-1px] h-0.5 rounded-full bg-stone-900" />
              )}
            </button>
          ))}
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

        {/* Bulk action bar — only visible on the pending tab and only
            when at least one row is selected. Sticky at the top so a
            long list doesn't hide it during scroll. */}
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
              <div className="p-10 text-center text-sm text-stone-500">Loading…</div>
            ) : items.length === 0 ? (
              <EmptyState status={status} />
            ) : (
              <>
                {isPendingTab && (
                  <div className="flex items-center gap-3 px-4 sm:px-5 py-2 border-b border-warm bg-[#FBF7F0] text-[12px] text-stone-600">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-stone-400 text-stone-900 focus:ring-stone-500"
                      checked={allSelected}
                      onChange={toggleAll}
                      aria-label="Select all visible pending applications"
                    />
                    <span>{allSelected ? 'All visible selected' : 'Select all visible'}</span>
                  </div>
                )}
                <ul className="divide-y divide-warm">
                  {items.map((it) => (
                    <Row
                      key={it.id}
                      it={it}
                      selectable={isPendingTab}
                      selected={selectedIds.has(it.id)}
                      onToggle={() => toggleOne(it.id)}
                    />
                  ))}
                </ul>
              </>
            )}
          </CardBody>
        </Card>

        {total > items.length && (
          <p className="mt-3 text-[11px] text-stone-500 text-center">
            Showing {items.length} of {total}. Older rows aren't loaded yet.
          </p>
        )}
      </FadeIn>

      {modal && (
        <MassActionModal
          kind={modal.kind}
          count={selectionCount}
          note={note}
          setNote={setNote}
          onClose={closeModal}
          onConfirm={confirmMassAction}
          busy={actionBusy}
          err={actionErr}
        />
      )}
    </ReviewerShell>
  )
}

function Row({ it, selectable, selected, onToggle }) {
  return (
    <li className={`p-4 sm:p-5 hover:bg-[#FBF7F0] transition-colors ${selected ? 'bg-[#F5EEDF]' : ''}`}>
      <div className="flex items-start gap-3">
        {selectable && (
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 rounded border-stone-400 text-stone-900 focus:ring-stone-500 shrink-0"
            checked={selected}
            onChange={onToggle}
            aria-label={`Select ${it.institution_name}`}
          />
        )}
        <div className="flex-1 flex items-start justify-between gap-4 min-w-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-sm font-semibold text-stone-900 truncate">{it.institution_name}</h3>
              <StatusPill status={it.status} />
            </div>
            <p className="text-[11px] text-stone-500 mt-1">
              {it.institution_type}
              {it.aishe_code ? ` · AISHE ${it.aishe_code}` : ''}
            </p>
            <p className="text-[11px] text-stone-500 mt-0.5">
              {it.city}{it.state ? ', ' + it.state : ''} · Head: {it.head_name} ({it.head_email})
            </p>
            <p className="text-[10px] text-stone-400 mt-1 tabular-nums">
              Submitted {new Date(it.created_at).toLocaleString('en-IN')} · {it.doc_count} document{it.doc_count === 1 ? '' : 's'}
            </p>
          </div>
          <div className="shrink-0">
            <Link
              to={`/reviewer/applications/${it.id}`}
              className="inline-flex items-center px-3 py-1.5 text-[12px] font-semibold rounded-md bg-stone-900 text-white hover:bg-stone-800 transition-colors"
            >
              Review
              <Icon.ChevronRight className="h-3.5 w-3.5 ml-0.5" />
            </Link>
          </div>
        </div>
      </div>
    </li>
  )
}

function StatusPill({ status }) {
  const map = {
    pending:  { tone: 'amber',   label: 'Pending' },
    approved: { tone: 'emerald', label: 'Approved' },
    rejected: { tone: 'rose',    label: 'Rejected' },
    draft:    { tone: 'slate',   label: 'Draft' },
  }
  const s = map[status] || map.pending
  return <Pill tone={s.tone} dot>{s.label}</Pill>
}

function EmptyState({ status }) {
  const msg = status === 'pending'
    ? 'No KYC applications pending your review.'
    : status === 'approved'
      ? 'No approved applications yet.'
      : 'No rejected applications.'
  return (
    <div className="p-12 text-center">
      <div className="mx-auto h-12 w-12 rounded-xl bg-stone-100 text-stone-400 flex items-center justify-center mb-3">
        <Icon.Inbox className="h-6 w-6" />
      </div>
      <p className="text-sm text-stone-600">{msg}</p>
      <p className="text-[11px] text-stone-400 mt-1">Institutions routed to this client show up here.</p>
    </div>
  )
}

// MassActionModal — confirmation + optional note capture for the
// bulk-approve / bulk-reject actions. Rendered here instead of via a
// shared ConfirmDialog because the note textarea makes it more than
// a plain yes/no.
function MassActionModal({ kind, count, note, setNote, onClose, onConfirm, busy, err }) {
  const isApprove = kind === 'approve'
  const title = isApprove ? `Approve ${count} application${count === 1 ? '' : 's'}?` : `Reject ${count} application${count === 1 ? '' : 's'}?`
  const noteRequired = !isApprove
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4">
      <div
        className="w-full max-w-md rounded-xl bg-white shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`h-1 ${isApprove ? 'bg-emerald-600' : 'bg-rose-600'}`} />
        <div className="p-5 sm:p-6">
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          <p className="mt-1 text-sm text-slate-600">
            {isApprove
              ? 'Each institution will be unlocked and receive an approval email. Fan-out grants exam access under this client.'
              : 'Each institution stays locked out and receives a rejection email with the note below. Their identity remains locked to this outcome — they can re-submit from their own dashboard once they log in.'}
          </p>
          <div className="mt-4">
            <Label>Note {noteRequired && <span className="text-rose-500">*</span>}</Label>
            <textarea
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-stone-700 focus:outline-none focus:ring-2 focus:ring-stone-300 resize-y min-h-[80px]"
              placeholder={noteRequired ? 'One reason applied to every rejection…' : 'Optional — attached to the audit log.'}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={busy}
            />
          </div>
          {err && (
            <p className="mt-2 text-xs text-rose-600">{err}</p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button
              onClick={onConfirm}
              disabled={busy || (noteRequired && !note.trim())}
              className={isApprove ? '' : '!bg-rose-700 hover:!bg-rose-800 !text-white'}
            >
              {busy
                ? 'Working…'
                : isApprove
                  ? `Approve ${count}`
                  : `Reject ${count}`}
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

const TILE_TAB_MAP = {
  pending:  'pending',
  approved: 'approved',
  rejected: 'rejected',
  // 'active' has no matching tab — it's a portfolio-size stat, not a
  // slice of the inbox — so its tile is rendered as an inert card.
}

function StatsRow({ stats, activeTab, onTileClick }) {
  // Oldest-pending chip on the Pending tile — turns a raw count into
  // an SLA signal. A "3 pending" all from today is fine; a "3
  // pending" with one 6 days old is what needs attention. Days come
  // back as a float from the backend (fractional 0.3 = ~7h old); we
  // round + label for the chip. Threshold for the "warn" colour is
  // 2 days — anything older reads as risk. Null hides the chip.
  const oldestDays = stats?.oldest_pending_days
  let pendingBadge = null
  if (typeof oldestDays === 'number' && oldestDays >= 1) {
    const d = Math.round(oldestDays)
    pendingBadge = { label: `oldest ${d}d`, warn: d >= 2 }
  }

  const tiles = [
    { key: 'active',    label: 'Active institutes', hint: 'KYC-approved orgs', value: stats?.active_institutes,        tone: 'slate',   icon: <Icon.ShieldCheck className="h-4 w-4" /> },
    { key: 'pending',   label: 'Pending KYC',       hint: 'in your queue',     value: stats?.pending_review,           tone: 'amber',   icon: <Icon.Clock className="h-4 w-4" />,        badge: pendingBadge },
    { key: 'approved',  label: 'Approved · 7d',     hint: 'this week',         value: stats?.approved_this_week,       tone: 'emerald', icon: <Icon.Check className="h-4 w-4" /> },
    { key: 'rejected',  label: 'Rejected · 7d',     hint: 'this week',         value: stats?.rejected_this_week,       tone: 'rose',    icon: <Icon.X className="h-4 w-4" /> },
    { key: 'verifs',    label: 'Verifications · 7d',hint: 'by your institutes',value: stats?.verifications_this_week,  tone: 'indigo',  icon: <Icon.ShieldCheck className="h-4 w-4" /> },
  ]
  return (
    <>
      <div className="mb-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
        {tiles.map((t) => {
          const targetTab = TILE_TAB_MAP[t.key]
          const isClickable = !!targetTab
          const isActive = isClickable && targetTab === activeTab
          return (
            <StatTile
              key={t.key}
              {...t}
              isClickable={isClickable}
              isActive={isActive}
              onClick={isClickable ? () => onTileClick(targetTab) : undefined}
            />
          )
        })}
      </div>
    </>
  )
}

function StatTile({ label, hint, value, tone, icon, isClickable, isActive, onClick, badge }) {
  const toneStyles = {
    slate:   { text: 'text-slate-900',   ring: 'ring-slate-900/10',   dot: 'bg-slate-400',   activeBorder: 'border-slate-900' },
    amber:   { text: 'text-amber-800',   ring: 'ring-amber-900/10',   dot: 'bg-amber-500',   activeBorder: 'border-amber-600' },
    emerald: { text: 'text-emerald-800', ring: 'ring-emerald-900/10', dot: 'bg-emerald-500', activeBorder: 'border-emerald-600' },
    rose:    { text: 'text-rose-800',    ring: 'ring-rose-900/10',    dot: 'bg-rose-500',    activeBorder: 'border-rose-600' },
    indigo:  { text: 'text-indigo-800',  ring: 'ring-indigo-900/10',  dot: 'bg-indigo-500',  activeBorder: 'border-indigo-600' },
  }[tone] || {}
  const Wrapper = isClickable ? 'button' : 'div'
  const wrapperProps = isClickable
    ? { type: 'button', onClick, 'aria-pressed': isActive }
    : {}
  return (
    <Wrapper
      {...wrapperProps}
      className={[
        'group text-left rounded-xl border bg-white px-3.5 py-3 transition-all',
        isActive
          ? `${toneStyles.activeBorder} ring-2 ${toneStyles.ring} -translate-y-0.5 shadow-sm`
          : 'border-warm hover:border-warm-strong hover:-translate-y-0.5 hover:shadow-sm',
        isClickable ? 'cursor-pointer' : 'cursor-default',
      ].join(' ')}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-wide font-semibold text-stone-500 flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${toneStyles.dot}`} />
            {label}
          </p>
          <p className={`mt-1 text-2xl font-bold tabular-nums leading-none ${toneStyles.text}`}>
            <CountUp value={value} />
          </p>
          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-stone-500">
            <span>{hint}</span>
            {badge && (
              <span
                className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                  badge.warn
                    ? 'bg-rose-100 text-rose-700 border border-rose-200'
                    : 'bg-amber-100 text-amber-800 border border-amber-200'
                }`}
                title={badge.warn ? 'SLA warning — oldest waiting >2 days' : 'oldest submitted 1 day ago'}
              >
                {badge.label}
              </span>
            )}
          </div>
        </div>
        <div className={`shrink-0 opacity-40 group-hover:opacity-70 transition-opacity ${toneStyles.text}`}>
          {icon}
        </div>
      </div>
    </Wrapper>
  )
}

// CountUp — cheap requestAnimationFrame ramp from 0 → value on first
// paint (and re-ramps whenever the value changes). No easing lib; a
// short linear ramp reads as "live" without being fiddly. Falls back
// to '—' while the stats endpoint hasn't resolved yet.
function CountUp({ value, durationMs = 500 }) {
  const [display, setDisplay] = useState(0)
  useEffect(() => {
    if (typeof value !== 'number') return
    let raf
    const start = performance.now()
    const from = 0
    const to = value
    const step = (now) => {
      const t = Math.min(1, (now - start) / durationMs)
      setDisplay(Math.round(from + (to - from) * t))
      if (t < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [value, durationMs])
  if (typeof value !== 'number') return <>—</>
  return <>{display.toLocaleString()}</>
}
