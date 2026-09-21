import { useEffect, useMemo, useState } from 'react'
import ReviewerShell from '../../components/reviewer/ReviewerShell.jsx'
import { Button } from '../../components/ui/ui.jsx'
import { Icon, Skeleton, StatTile } from '../../components/ui/extras.jsx'
import { motion } from 'framer-motion'
import { FadeIn, StaggerItem, StaggerList } from '../../components/ui/motion.jsx'
import { Band, Rule } from '../../components/reviewer/BoardBand.jsx'
import { listSubscriptionRequests } from '../../lib/reviewer/api.js'
import SubscriptionRequestsPanel from '../../components/reviewer/SubscriptionRequestsPanel.jsx'

// Reviewer > Exam approval (V16, overhauled 2026-09-14; head rebuilt
// 2026-09-21).
//
// Two states: LIST (every institute with any exam request) and DRILL
// (one institute's requests, delegated to SubscriptionRequestsPanel).
//
// The page opens on the same figures-first head as the KYC desk — the
// shared StatTile row, each tile a filter, beside a Band. It used to
// open on four plain numbers under a paragraph, which said nothing a
// reviewer could act on: the figure that matters is not how many
// requests exist but which institute has been waiting longest, so the
// Band carries that and the rest of the queue.

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

// How long a request has been waiting, as a headline rather than a
// sentence: "8 days", not "8 days ago".
function formatWait(iso) {
  if (!iso) return '—'
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  const m = Math.round(secs / 60)
  if (m < 60) return `${Math.max(1, m)} min`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} hr`
  return `${Math.round(h / 24)} days`
}

const STATUS_OPTIONS = [
  { value: 'all',      label: 'All institutes' },
  { value: 'pending',  label: 'Has pending requests' },
  { value: 'approved', label: 'Has approvals' },
  { value: 'rejected', label: 'Has rejections' },
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
    // Same duplicate-by-name join as the panel: count each (org, exam)
    // request once, or an institute with four requests reads as eight.
    const seen = new Set()
    for (const r of allItems || []) {
      const rowKey = `${r.org_id}:${r.exam_id}`
      if (seen.has(rowKey)) continue
      seen.add(rowKey)
      const key = r.org_name || `#${r.org_id}`
      if (!byOrg.has(key)) {
        byOrg.set(key, {
          name: key,
          orgId: r.org_id,
          city: '',
          state: '',
          headName: '',
          headDesignation: '',
          pending: 0,
          approved: 0,
          rejected: 0,
          latestActivity: '',
        })
      }
      const g = byOrg.get(key)
      // First non-empty wins: every request for an institute carries the
      // same details, but a given row can have them blank when the org
      // predates the KYC fields.
      g.city = g.city || r.city || ''
      g.state = g.state || r.state || ''
      g.headName = g.headName || r.head_name || ''
      g.headDesignation = g.headDesignation || r.head_designation || ''
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
      if (statusFilter === 'pending'  && i.pending  === 0) return false
      if (statusFilter === 'approved' && i.approved === 0) return false
      if (statusFilter === 'rejected' && i.rejected === 0) return false
      if (statusFilter === 'clean'    && i.pending   >  0) return false
      if (q && ![i.name, i.city, i.state, i.headName]
        .some((v) => (v || '').toLowerCase().includes(q))) return false
      return true
    })
  }, [institutes, search, statusFilter])

  const filtersActive = !!search || statusFilter !== 'all'
  const clearFilters  = () => { setSearch(''); setStatusFilter('all') }

  // The single request that has waited longest, and the queue behind
  // it. This is the page's real subject: a count of pending requests
  // doesn't tell a reviewer where to start, and an institute that
  // asked eight days ago is the one to open first.
  const queue = useMemo(() => {
    const waiting = institutes.filter((i) => i.pending > 0)
    let oldest = null
    for (const r of allItems || []) {
      if (r.status !== 'pending') continue
      if (!oldest || (r.requested_at || '') < (oldest.requested_at || '')) oldest = r
    }
    return { waiting, oldest }
  }, [institutes, allItems])

  // ─── DRILL view ────────────────────────────────────────────────────
  const drillInst = institutes.find((i) => i.name === selectedName)
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
                {/* The facts the roster showed a click ago — where they
                    are and who signs for them — so the reviewer isn't
                    deciding against a bare name. */}
                {(drillInst?.city || drillInst?.state || drillInst?.headName) && (
                  <p className="mt-2 text-xs text-slate-500 flex flex-wrap items-center gap-x-2 gap-y-1">
                    {[drillInst.city, drillInst.state].filter(Boolean).length > 0 && (
                      <span className="inline-flex items-center gap-1.5">
                        <Icon.Building className="h-3.5 w-3.5 text-slate-400" />
                        {[drillInst.city, drillInst.state].filter(Boolean).join(', ')}
                      </span>
                    )}
                    {drillInst.headName && (
                      <>
                        <span aria-hidden="true" className="text-slate-300">·</span>
                        <span className="inline-flex items-center gap-1.5">
                          <Icon.User className="h-3.5 w-3.5 text-slate-400" />
                          {drillInst.headName}
                          {drillInst.headDesignation && (
                            <span className="text-slate-400">({drillInst.headDesignation})</span>
                          )}
                        </span>
                      </>
                    )}
                  </p>
                )}
              </div>
            </div>

            {drillInst && (
              <div className="flex items-center gap-2 shrink-0">
                {drillInst.pending > 0 && (
                  <span className="rounded-full bg-amber-50 border border-amber-200 px-2.5 py-1 text-[11px] font-semibold text-amber-800 tabular-nums">
                    {drillInst.pending} pending
                  </span>
                )}
                {drillInst.approved > 0 && (
                  <span className="rounded-full bg-emerald-50 border border-emerald-200 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 tabular-nums">
                    {drillInst.approved} approved
                  </span>
                )}
                {drillInst.rejected > 0 && (
                  <span className="rounded-full bg-rose-50 border border-rose-200 px-2.5 py-1 text-[11px] font-semibold text-rose-700 tabular-nums">
                    {drillInst.rejected} rejected
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        <SubscriptionRequestsPanel
          key={selectedName}
          institutionName={selectedName}
          orgId={drillInst?.orgId}
          onChange={() => load()}
        />
      </ReviewerShell>
    )
  }

  // ─── LIST view ─────────────────────────────────────────────────────
  return (
    <ReviewerShell>
      <FadeIn>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Exam approval
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Institutes asking for access to your exams. Every decision
            emails them.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={load} disabled={refreshing}>
          <Icon.Refresh className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          <span className="ml-1.5">{refreshing ? 'Refreshing…' : 'Refresh'}</span>
        </Button>
      </div>

      {/* Figures first, each one a filter — the KYC desk's tiles, so a
          reviewer slices two queues the same way. Counts are requests,
          the list underneath is institutes, which is why Pending reads
          "across N institutes". */}
      <div className="mb-6 grid gap-4 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-stretch">
        <StaggerList className="grid gap-4 grid-cols-2 lg:grid-cols-4">
          <StaggerItem>
            <StatTile label="Pending" value={totals.pending} accent="pending" icon={Icon.Clock}
                      hint={totals.pending > 0
                        ? `across ${totals.withPending} institute${totals.withPending === 1 ? '' : 's'}`
                        : 'Nothing waiting'}
                      onClick={() => setStatusFilter('pending')} active={statusFilter === 'pending'} />
          </StaggerItem>
          <StaggerItem>
            <StatTile label="Approved" value={totals.approved} accent="approved" icon={Icon.Check}
                      hint="Exams they can verify"
                      onClick={() => setStatusFilter('approved')} active={statusFilter === 'approved'} />
          </StaggerItem>
          <StaggerItem>
            <StatTile label="Rejected" value={totals.rejected} accent="rejected" icon={Icon.X}
                      hint="Turned down with a note"
                      onClick={() => setStatusFilter('rejected')} active={statusFilter === 'rejected'} />
          </StaggerItem>
          <StaggerItem>
            <StatTile label="Institutes" value={totals.institutes} accent="total" icon={Icon.Building}
                      hint="Asked at least once"
                      onClick={() => setStatusFilter('all')} active={false} />
          </StaggerItem>
        </StaggerList>

        <Band className="xl:w-[460px]">
          {queue.oldest ? (
            <>
              <button
                type="button"
                onClick={() => setSelectedName(queue.oldest.org_name)}
                className="group shrink-0 text-left cursor-pointer"
              >
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                  Longest wait
                </p>
                <p className="mt-1 text-[28px] leading-none font-semibold tracking-tight text-amber-700 tabular-nums">
                  {formatWait(queue.oldest.requested_at)}
                </p>
                <p className="mt-1.5 text-xs text-slate-600 max-w-[190px] truncate group-hover:text-slate-900 group-hover:underline underline-offset-2">
                  {queue.oldest.org_name}
                </p>
              </button>
              <Rule />
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                  Waiting on you
                </p>
                <ul className="mt-2 space-y-1.5">
                  {queue.waiting.slice(0, 3).map((i) => (
                    <li key={i.name}>
                      <button
                        type="button"
                        onClick={() => setSelectedName(i.name)}
                        className="w-full flex items-baseline justify-between gap-3 text-left cursor-pointer group"
                      >
                        <span className="text-xs text-slate-700 truncate group-hover:text-slate-900 group-hover:underline underline-offset-2">
                          {i.name}
                        </span>
                        <span className="text-xs font-semibold text-amber-700 tabular-nums shrink-0">
                          {i.pending}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                {queue.waiting.length > 3 && (
                  <p className="mt-2 text-[11px] text-slate-500">
                    +{queue.waiting.length - 3} more below
                  </p>
                )}
              </div>
            </>
          ) : (
            <div className="flex items-center gap-3">
              <span className="h-10 w-10 rounded-xl bg-emerald-50 text-emerald-600 grid place-items-center shrink-0">
                <Icon.Check className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-800">Queue clear</p>
                <p className="text-xs text-slate-500">
                  Every request has a decision. New ones land here.
                </p>
              </div>
            </div>
          )}
        </Band>
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
          <span className="mx-auto mb-3 h-11 w-11 rounded-xl bg-stone-100 text-stone-500 grid place-items-center">
            <Icon.Building className="h-5 w-5" />
          </span>
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
          <InstituteListHeader />
          <ul className="divide-y divide-slate-100">
            {filteredInstitutes.map((inst, i) => (
              <InstituteRow
                key={inst.name}
                inst={inst}
                index={i}
                onOpen={() => setSelectedName(inst.name)}
              />
            ))}
          </ul>
        </div>
      )}
      </FadeIn>
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
// One row per institute, laid out as columns on a desk monitor: who,
// where, who signs for them, when they were last active, and the
// action. The middle of the row used to be empty — the name and a
// one-line subtitle were the only content, so the eye had to travel the
// whole width to reach the button with nothing to read on the way.
//
// The column widths live here rather than in a table because the row is
// a single click target; RowColumns keeps the header strip above the
// list on exactly the same grid.
//
// The action column is a fixed 118px rather than `auto`. With `auto` the
// header's word and the row's button measured differently, the flexible
// columns divided what was left differently, and every heading sat a few
// pixels off its own column — the drift growing across the row.
const ROW_GRID =
  'lg:grid lg:grid-cols-[minmax(0,2.2fr)_minmax(0,1.5fr)_minmax(0,1.5fr)_minmax(0,0.9fr)_118px] lg:items-center'

function InstituteListHeader() {
  return (
    <div className={`hidden lg:block px-4 py-2 border-b border-warm bg-[#F6F8FA]
                     text-[11px] font-semibold uppercase tracking-wider text-slate-500`}>
      <div className={ROW_GRID + ' gap-4'}>
        <span className="pl-14">Institute</span>
        <span>Location</span>
        <span>Head of institution</span>
        <span>Last activity</span>
        <span className="text-right">Requests</span>
      </div>
    </div>
  )
}

function InstituteRow({ inst, index = 0, onOpen }) {
  const hasPending = inst.pending > 0
  const initial = (inst.name.trim().charAt(0) || '?').toUpperCase()
  const location = [inst.city, inst.state].filter(Boolean).join(', ')
  return (
    <motion.li
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, delay: Math.min(index, 7) * 0.035, ease: [0.22, 1, 0.36, 1] }}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() }
        }}
        className={`group relative w-full px-4 py-3.5 flex items-center gap-4 cursor-pointer transition-colors ${ROW_GRID} ${
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

        {/* Who */}
        <div className="flex items-center gap-4 min-w-0">
          <span
            aria-hidden="true"
            className={`h-10 w-10 shrink-0 rounded-lg flex items-center justify-center font-display font-bold text-[14px] transition-transform group-hover:scale-[1.04] ${
              hasPending ? 'bg-amber-100 text-amber-800' : 'bg-stone-100 text-stone-700'
            }`}
          >
            {initial}
          </span>
          <div className="min-w-0">
            <p className="font-semibold text-slate-900 truncate">{inst.name}</p>
            <p className="mt-0.5 text-[12px] text-slate-500 flex flex-wrap items-center gap-x-2">
              {/* Pending leads: it's the only count that asks for
                  something. It used to live only inside the button,
                  so a row with four waiting requests read "1
                  approved" — the least useful fact on the line. */}
              {inst.pending > 0 && (
                <span className="font-semibold text-amber-700 tabular-nums">
                  {inst.pending} pending
                </span>
              )}
              {inst.approved > 0 && (
                <span>
                  <span className="font-medium text-emerald-700 tabular-nums">{inst.approved}</span>{' '}
                  approved
                </span>
              )}
              {inst.rejected > 0 && (
                <span>
                  <span className="font-medium text-rose-700 tabular-nums">{inst.rejected}</span>{' '}
                  rejected
                </span>
              )}
              {inst.pending === 0 && inst.approved === 0 && inst.rejected === 0 && (
                <span className="text-slate-400">No decisions yet</span>
              )}
            </p>
          </div>
        </div>

        {/* Where */}
        <p className="hidden lg:block min-w-0 truncate text-[13px] text-slate-700" title={location}>
          {location || <span className="text-slate-300">—</span>}
        </p>

        {/* Who signs for them */}
        <div className="hidden lg:block min-w-0">
          <p className="truncate text-[13px] text-slate-700" title={inst.headName}>
            {inst.headName || <span className="text-slate-300">—</span>}
          </p>
          {inst.headDesignation && (
            <p className="truncate text-[11.5px] text-slate-400">{inst.headDesignation}</p>
          )}
        </div>

        {/* When */}
        <p className="hidden lg:block text-[12.5px] text-slate-500 tabular-nums">
          {inst.latestActivity ? formatRelative(inst.latestActivity) : <span className="text-slate-300">—</span>}
        </p>

        {/* Below lg the columns collapse, so the same three facts ride
            under the name instead of disappearing. */}
        <p className="lg:hidden -mt-1 text-[12px] text-slate-500 truncate">
          {[location, inst.headName, inst.latestActivity ? `last activity ${formatRelative(inst.latestActivity)}` : '']
            .filter(Boolean).join(' · ') || 'No details on file'}
        </p>

        {/* Right-hand action. onClick stops propagation so the button
            can carry its own focus/hover state without the outer row
            also flashing — but both fire the same handler, so a click
            anywhere on the row opens the drill. */}
        <div className="justify-self-end">
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
      </div>
    </motion.li>
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
