import { useEffect, useMemo, useState } from 'react'
import ReviewerShell from '../../components/reviewer/ReviewerShell.jsx'
import { Button } from '../../components/ui/ui.jsx'
import { Icon, Skeleton } from '../../components/ui/extras.jsx'
import { listSubscriptionRequests } from '../../lib/reviewer/api.js'
import SubscriptionRequestsPanel from '../../components/reviewer/SubscriptionRequestsPanel.jsx'

// Reviewer > Exam approval (V16, overhauled 2026-09-14).
//
// Editorial layout that matches the rest of the reviewer surface —
// warm-surface cards with a gold rule, stone monogram tiles, the same
// filter language the Agents page uses, and a clean roster underneath.
// Two states: LIST (every institute with any exam request) and DRILL
// (one institute's requests, delegated to SubscriptionRequestsPanel).

function formatRelative(iso) {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (secs < 60) return 'just now'
  const m = Math.round(secs / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} hr ago`
  const d = Math.round(h / 24)
  return `${d} day${d === 1 ? '' : 's'} ago`
}

const STATUS_OPTIONS = [
  { value: 'all',     label: 'All institutes' },
  { value: 'pending', label: 'Has pending requests' },
  { value: 'clean',   label: 'All decided' },
]

export default function ReviewerExamApproval() {
  const [allItems, setAllItems] = useState(null) // null=first load
  const [err, setErr] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [selectedName, setSelectedName] = useState('')

  // Filter state — search + presence filter. Same pattern as Agents:
  // client-side, composes AND, header numbers stay pinned to the
  // full roster so the summary reads as a fair snapshot regardless
  // of what's on screen.
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')

  const load = async () => {
    setErr('')
    setRefreshing(true)
    try {
      const r = await listSubscriptionRequests({ status: 'all' })
      setAllItems(r?.items || [])
    } catch (e) {
      setAllItems((prev) => (prev == null ? [] : prev))
      setErr(e?.message || 'Could not load subscription requests')
    } finally {
      setRefreshing(false)
    }
  }
  useEffect(() => { load() }, [])

  // Group requests by institute; count per status; track latest
  // activity for stable ordering.
  const institutes = useMemo(() => {
    const byOrg = new Map()
    for (const r of allItems || []) {
      const key = r.org_name || `#${r.org_id}`
      if (!byOrg.has(key)) {
        byOrg.set(key, {
          name: key,
          orgId: r.org_id,
          pending: 0,
          approved: 0,
          rejected: 0,
          latestActivity: '',
        })
      }
      const g = byOrg.get(key)
      if (r.status === 'pending') g.pending++
      else if (r.status === 'approved') g.approved++
      else if (r.status === 'rejected') g.rejected++
      const t = r.reviewed_at || r.requested_at || ''
      if (t > g.latestActivity) g.latestActivity = t
    }
    const arr = [...byOrg.values()]
    arr.sort((a, b) => {
      if (b.pending !== a.pending) return b.pending - a.pending
      return (b.latestActivity || '').localeCompare(a.latestActivity || '')
    })
    return arr
  }, [allItems])

  // Header totals — always over the full unfiltered set.
  const totals = useMemo(() => ({
    institutes: institutes.length,
    pending:    institutes.reduce((n, i) => n + i.pending, 0),
    approved:   institutes.reduce((n, i) => n + i.approved, 0),
    rejected:   institutes.reduce((n, i) => n + i.rejected, 0),
    withPending: institutes.filter((i) => i.pending > 0).length,
  }), [institutes])

  // Filtered list for the roster below.
  const filteredInstitutes = useMemo(() => {
    const q = search.trim().toLowerCase()
    return institutes.filter((i) => {
      if (statusFilter === 'pending' && i.pending === 0) return false
      if (statusFilter === 'clean'   && i.pending  >  0) return false
      if (q && !i.name.toLowerCase().includes(q)) return false
      return true
    })
  }, [institutes, search, statusFilter])

  const filtersActive = !!search || statusFilter !== 'all'
  const clearFilters  = () => { setSearch(''); setStatusFilter('all') }

  // ─── DRILL view ────────────────────────────────────────────────────
  if (selectedName) {
    return (
      <ReviewerShell>
        <button
          type="button"
          onClick={() => { setSelectedName(''); load() }}
          className="mb-3 inline-flex items-center gap-1.5 text-[12px] font-semibold text-stone-700 hover:text-stone-900"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back to institutes
        </button>

        {/* Drill header — warm-surface + gold rule, monogram tile, a
            single-line breadcrumb-style subtitle. */}
        <div className="mb-6 rounded-xl bg-warm-surface ring-1 ring-warm overflow-hidden shadow-sm">
          <div className="h-[3px] rule-gold" />
          <div className="p-5 sm:p-6 flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-start gap-4 min-w-0">
              <div className="h-12 w-12 rounded-xl bg-stone-100 text-stone-800 flex items-center justify-center shrink-0">
                <Icon.Building className="h-6 w-6" />
              </div>
              <div className="min-w-0">
                <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">
                  Institute
                </p>
                <h1 className="mt-0.5 text-2xl font-semibold tracking-tight text-slate-900 truncate">
                  {selectedName}
                </h1>
                <p className="mt-1 text-sm text-slate-500">
                  Approve or reject exam subscription requests. Decisions
                  email the institute directly.
                </p>
              </div>
            </div>
          </div>
        </div>

        <SubscriptionRequestsPanel
          key={selectedName}
          institutionName={selectedName}
          onChange={() => load()}
        />
      </ReviewerShell>
    )
  }

  // ─── LIST view ─────────────────────────────────────────────────────
  return (
    <ReviewerShell>
      {/* Header — warm-surface card with monogram tile + stats strip.
          Same shape as KycInbox / Agents. */}
      <div className="mb-6 rounded-xl bg-warm-surface ring-1 ring-warm overflow-hidden shadow-sm">
        <div className="h-[3px] rule-gold" />
        <div className="p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-start gap-4 min-w-0">
              <div className="h-12 w-12 rounded-xl bg-stone-100 text-stone-800 flex items-center justify-center shrink-0">
                <Icon.FileText className="h-6 w-6" />
              </div>
              <div className="min-w-0">
                <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
                  Exam approval
                </h1>
                <p className="mt-1 text-sm text-slate-500 max-w-xl">
                  Institutes that have asked for access to your exams.
                  Open one to review every request and email the
                  institute a decision.
                </p>
              </div>
            </div>
            <Button variant="secondary" size="sm" onClick={load} disabled={refreshing}>
              <Icon.Refresh className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              <span className="ml-1.5">{refreshing ? 'Refreshing…' : 'Refresh'}</span>
            </Button>
          </div>

          {/* Stats strip — total institutes + pending + approved + rejected
              across the full response. Pinned; doesn't shift on filter. */}
          <div className="mt-5 pt-5 border-t border-slate-100 grid grid-cols-2 sm:grid-cols-4 gap-6 text-sm">
            <Stat label="Institutes"      value={totals.institutes} />
            <Stat label="Pending"          value={totals.pending}    tone="amber"
                  hint={totals.pending > 0 ? `across ${totals.withPending} institute${totals.withPending === 1 ? '' : 's'}` : ''} />
            <Stat label="Approved"         value={totals.approved}   tone="emerald" />
            <Stat label="Rejected"         value={totals.rejected}   tone="rose" />
          </div>
        </div>
      </div>

      {err && (
        <div role="alert" className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
          {err}
        </div>
      )}

      {/* Filter bar — search + presence filter. Same visual language as
          the Agents page filter row. */}
      {allItems !== null && institutes.length > 0 && (
        <div className="mb-4 rounded-xl bg-white ring-1 ring-warm shadow-sm">
          <div className="p-3 sm:p-4 grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3 items-center">
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">
                <Icon.Search className="h-4 w-4" />
              </span>
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search institutes…"
                className="w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 py-2 text-sm focus:border-stone-500 focus:outline-none focus:ring-2 focus:ring-stone-200"
              />
            </div>
            <FilterSelect
              value={statusFilter}
              onChange={setStatusFilter}
              options={STATUS_OPTIONS}
              ariaLabel="Filter by request state"
            />
          </div>
          {filtersActive && (
            <div className="px-4 py-2 border-t border-slate-100 flex items-center justify-between gap-3">
              <p className="text-xs text-slate-500 tabular-nums">
                Showing <span className="font-semibold text-slate-800">{filteredInstitutes.length}</span>
                {' '}of <span className="font-semibold text-slate-800">{institutes.length}</span> institutes
              </p>
              <button
                type="button"
                onClick={clearFilters}
                className="text-xs font-semibold text-stone-700 hover:text-stone-900 underline-offset-2 hover:underline"
              >
                Clear filters
              </button>
            </div>
          )}
        </div>
      )}

      {/* Loading / empty / roster */}
      {allItems === null ? (
        <div className="rounded-xl bg-white ring-1 ring-warm p-4 space-y-2">
          {[0, 1, 2, 3].map((k) => (
            <Skeleton key={k} className="h-10 w-full" />
          ))}
        </div>
      ) : institutes.length === 0 ? (
        <div className="rounded-xl bg-warm-surface ring-1 ring-warm p-10 text-center">
          <p className="text-sm font-semibold text-slate-700">No requests yet</p>
          <p className="text-xs text-slate-500 mt-1">
            Requests appear here when an institute clicks
            &ldquo;Request access&rdquo; on an exam in their catalog.
          </p>
        </div>
      ) : filteredInstitutes.length === 0 ? (
        <div className="rounded-xl bg-warm-surface ring-1 ring-warm p-10 text-center">
          <p className="text-sm font-semibold text-slate-700">No institutes match those filters</p>
          <p className="text-xs text-slate-500 mt-1">
            Try broadening the search or{' '}
            <button
              type="button"
              onClick={clearFilters}
              className="font-semibold text-stone-800 underline underline-offset-2 hover:text-stone-900"
            >
              clear all filters
            </button>.
          </p>
        </div>
      ) : (
        <div className="rounded-xl bg-white ring-1 ring-warm overflow-hidden shadow-sm">
          <div className="h-[2px] rule-gold" />
          <ul className="divide-y divide-slate-100">
            {filteredInstitutes.map((inst) => (
              <InstituteRow
                key={inst.name}
                inst={inst}
                onOpen={() => setSelectedName(inst.name)}
              />
            ))}
          </ul>
        </div>
      )}
    </ReviewerShell>
  )
}

// A single institute row — monogram tile, name, counts, and a real
// action button on the right (not a passive "All decided" label).
// Two states:
//   - hasPending  → amber "Review N" button that pulses gently until
//                   opened, so a queue of pending requests reads at a
//                   glance across the roster.
//   - clean       → quieter outline "Open" button so history is still
//                   reachable but never fights the pending rows.
// Whole row stays clickable as a large hit target; the button carries
// the animation + affordance.
function InstituteRow({ inst, onOpen }) {
  const hasPending = inst.pending > 0
  const initial = (inst.name.trim().charAt(0) || '?').toUpperCase()
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() }
        }}
        className={`group relative w-full px-4 py-3.5 flex items-center gap-4 cursor-pointer transition-colors ${
          hasPending ? 'hover:bg-amber-50/40' : 'hover:bg-stone-50'
        }`}
      >
        {/* Amber accent bar on the left of pending rows — sits inside
            the row so a quick scan finds the queue instantly. */}
        {hasPending && (
          <span
            aria-hidden="true"
            className="absolute left-0 top-1/2 -translate-y-1/2 h-8 w-[3px] rounded-r-full bg-amber-500"
          />
        )}

        <span
          aria-hidden="true"
          className={`h-10 w-10 shrink-0 rounded-lg flex items-center justify-center font-display font-bold text-[14px] transition-transform group-hover:scale-[1.04] ${
            hasPending ? 'bg-amber-100 text-amber-800' : 'bg-stone-100 text-stone-700'
          }`}
        >
          {initial}
        </span>

        <div className="min-w-0 flex-1">
          <p className="font-semibold text-slate-900 truncate">
            {inst.name}
          </p>
          <p className="mt-0.5 text-[12px] text-slate-500 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            {inst.approved > 0 && (
              <span>
                <span className="font-medium text-emerald-700 tabular-nums">
                  {inst.approved}
                </span>{' '}
                approved
              </span>
            )}
            {inst.rejected > 0 && (
              <span>
                <span className="font-medium text-rose-700 tabular-nums">
                  {inst.rejected}
                </span>{' '}
                rejected
              </span>
            )}
            {inst.latestActivity && (
              <span className="text-slate-400">
                · last activity {formatRelative(inst.latestActivity)}
              </span>
            )}
            {inst.approved === 0 && inst.rejected === 0 && !inst.latestActivity && (
              <span className="text-slate-400">No history yet</span>
            )}
          </p>
        </div>

        {/* Right-hand action. onClick stops propagation so the button
            can carry its own focus/hover state without the outer row
            also flashing — but both fire the same handler, so a click
            anywhere on the row opens the drill. */}
        {hasPending ? (
          <PendingActionButton
            count={inst.pending}
            onClick={(e) => { e.stopPropagation(); onOpen() }}
          />
        ) : (
          <CleanActionButton
            onClick={(e) => { e.stopPropagation(); onOpen() }}
          />
        )}
      </div>
    </li>
  )
}

// Amber-tinted primary action shown on institutes with pending
// requests. The dot pulses; the arrow slides right on hover; the
// whole button lifts a hair with a soft shadow.
function PendingActionButton({ count, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="
        shrink-0 inline-flex items-center gap-2 rounded-full
        bg-amber-500 text-white text-[12px] font-semibold tabular-nums
        pl-3 pr-3.5 py-1.5 shadow-sm
        transition-[transform,box-shadow,background-color] duration-150
        hover:bg-amber-600 hover:shadow-md hover:-translate-y-[1px]
        active:translate-y-0 active:shadow-sm
        focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500
      "
    >
      <span
        aria-hidden="true"
        className="relative flex h-2 w-2"
      >
        <span className="absolute inline-flex h-full w-full rounded-full bg-white/70 opacity-75 animate-ping" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-white" />
      </span>
      Review {count}
      <svg
        aria-hidden="true"
        xmlns="http://www.w3.org/2000/svg"
        width="14" height="14" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2.5"
        strokeLinecap="round" strokeLinejoin="round"
        className="transition-transform duration-150 group-hover:translate-x-0.5"
      >
        <polyline points="9 18 15 12 9 6" />
      </svg>
    </button>
  )
}

// Quiet outline button shown on institutes with no pending work.
// Same hover language as the amber one (lift, arrow slide, subtle
// tint) so both feel like one control family, not two visual worlds.
function CleanActionButton({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="
        shrink-0 inline-flex items-center gap-1.5 rounded-full
        bg-white text-stone-700 text-[12px] font-semibold
        border border-stone-200 pl-3 pr-3 py-1.5
        transition-[transform,box-shadow,background-color,border-color] duration-150
        hover:bg-stone-50 hover:border-stone-300 hover:-translate-y-[1px] hover:shadow-sm
        active:translate-y-0 active:shadow-none
        focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-400
      "
    >
      <svg
        aria-hidden="true"
        xmlns="http://www.w3.org/2000/svg"
        width="12" height="12" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2.5"
        strokeLinecap="round" strokeLinejoin="round"
        className="text-emerald-600"
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
      Open
      <svg
        aria-hidden="true"
        xmlns="http://www.w3.org/2000/svg"
        width="12" height="12" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2.5"
        strokeLinecap="round" strokeLinejoin="round"
        className="text-stone-400 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-stone-600"
      >
        <polyline points="9 18 15 12 9 6" />
      </svg>
    </button>
  )
}

// Small stat cell — same as Agents.jsx.
function Stat({ label, value, tone = 'slate', hint = '' }) {
  const toneCls = {
    slate:   'text-slate-900',
    emerald: 'text-emerald-700',
    amber:   'text-amber-700',
    rose:    'text-rose-700',
  }[tone] || 'text-slate-900'
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
        {label}
      </p>
      <p className={`text-lg font-semibold ${toneCls} mt-0.5 tabular-nums`}>
        {value}
      </p>
      {hint && (
        <p className="text-[11px] text-slate-500 mt-0.5">{hint}</p>
      )}
    </div>
  )
}

// Small styled <select> — same shell as Agents.jsx.
function FilterSelect({ value, onChange, options, ariaLabel }) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel}
        className="appearance-none rounded-lg border border-slate-200 bg-white pl-3 pr-9 py-2 text-sm text-slate-800 focus:border-stone-500 focus:outline-none focus:ring-2 focus:ring-stone-200 max-w-[240px] truncate"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span aria-hidden="true" className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </span>
    </div>
  )
}
