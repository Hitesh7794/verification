import { useEffect, useMemo, useState } from 'react'
import ReviewerShell from '../../components/reviewer/ReviewerShell.jsx'
import { Button } from '../../components/ui/ui.jsx'
import { Icon, Pill, Skeleton } from '../../components/ui/extras.jsx'
import { listAgents, enableAgent } from '../../lib/reviewer/api.js'

// Reviewer > Agents (V30, 2026-09-14).
//
// Editorial roster of every verification agent the reviewer's client
// scope reaches. Styled to match the rest of the reviewer surface
// (KycInbox, History): warm-surface cards with a gold rule, stone
// monogram tiles, a compact stats strip, and a table body rather than
// hero-and-cards decoration.
//
// Two panels:
//   1. Header card with counts (Active / Auto-disabled / Manually
//      disabled / Total).
//   2. If any auto-disabled agents exist, a rose "Needs attention"
//      block above the roster with one card per agent and the Enable
//      action pushed to the primary spot.
//   3. A single roster table below — Agent · Institute · Status ·
//      Streak · Last activity · Action. Compact rows, no decorative
//      gradients, muted styling for active rows so the eye finds the
//      warm rows first.

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

function initialFor(a) {
  return (a.display_name || a.username || '?').trim().charAt(0).toUpperCase() || '?'
}

// Status filter values. 'all' is the default; the other values map
// 1:1 to how the roster row classifies itself so the filter code
// stays trivial.
const STATUS_OPTIONS = [
  { value: 'all',           label: 'All statuses' },
  { value: 'auto_disabled', label: 'Auto-disabled' },
  { value: 'manual',        label: 'Manually disabled' },
  { value: 'active',        label: 'Active' },
]

export default function ReviewerAgents() {
  const [items, setItems] = useState(null) // null=first load
  const [err, setErr] = useState('')
  const [busyId, setBusyId] = useState(0)
  // Separate from items===null so subsequent refreshes can flash the
  // spinner without wiping the roster underneath. Prevents the "did
  // it even do anything?" click that we hit before.
  const [refreshing, setRefreshing] = useState(false)

  // Filter state. All four filters compose (AND), and the counts up
  // in the header card stay pinned to the unfiltered totals so the
  // reviewer can see the whole roster from the numbers even while the
  // table below is narrowed. `search` is a substring, case-insensitive,
  // matched against name + username + email + institute + exam name.
  const [search, setSearch] = useState('')
  const [instFilter, setInstFilter] = useState('all')
  const [examFilter, setExamFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')

  const load = async () => {
    setErr('')
    setRefreshing(true)
    try {
      const r = await listAgents()
      setItems(r?.items || [])
    } catch (e) {
      setItems((prev) => (prev == null ? [] : prev))
      setErr(e?.message || 'Could not load agents')
    } finally {
      setRefreshing(false)
    }
  }
  useEffect(() => { load() }, [])

  async function onEnable(id) {
    setBusyId(id)
    setErr('')
    try {
      await enableAgent(id)
      load()
    } catch (e) {
      setErr(e?.body?.error || e?.message || 'Enable failed')
    } finally {
      setBusyId(0)
    }
  }

  // Header-card counts stay pinned to the FULL roster so the summary
  // strip always reads as a fair snapshot of scope, not "what's on
  // screen given my filter" — which was confusing at build time.
  const { auto, manual, active, total } = useMemo(() => {
    const rows = items || []
    return {
      auto:   rows.filter((r) => r.status === 'disabled' && r.disable_reason === 'auto_streak'),
      manual: rows.filter((r) => r.status === 'disabled' && r.disable_reason !== 'auto_streak'),
      active: rows.filter((r) => r.status === 'active'),
      total:  rows.length,
    }
  }, [items])

  // Institute and exam option lists — sorted, deduped. Feeds the two
  // <select> dropdowns; kept as derived state so an updated roster
  // (after a refresh) reshapes the options automatically.
  const { instituteOptions, examOptions } = useMemo(() => {
    const insts = new Map()
    const exams = new Map()
    for (const a of items || []) {
      if (a.org_name) insts.set(String(a.org_id), a.org_name)
      for (const e of a.assigned_exams || []) {
        exams.set(String(e.id), `${e.name} · ${e.exam_code}`)
      }
    }
    const toArr = (m) =>
      [...m.entries()]
        .map(([value, label]) => ({ value, label }))
        .sort((a, b) => a.label.localeCompare(b.label))
    return { instituteOptions: toArr(insts), examOptions: toArr(exams) }
  }, [items])

  // Apply filters + sort. Filter application is defensive: any filter
  // set to 'all' short-circuits, so a fresh page (no filters set) is
  // just the plain roster.
  const sorted = useMemo(() => {
    const rows = items || []
    const q = search.trim().toLowerCase()
    const filtered = rows.filter((a) => {
      if (instFilter !== 'all' && String(a.org_id) !== instFilter) return false
      if (examFilter !== 'all') {
        const has = (a.assigned_exams || []).some((e) => String(e.id) === examFilter)
        if (!has) return false
      }
      if (statusFilter !== 'all') {
        const isAuto   = a.status === 'disabled' && a.disable_reason === 'auto_streak'
        const isManual = a.status === 'disabled' && !isAuto
        const isActive = a.status === 'active'
        if (statusFilter === 'auto_disabled' && !isAuto)   return false
        if (statusFilter === 'manual'        && !isManual) return false
        if (statusFilter === 'active'        && !isActive) return false
      }
      if (q) {
        const hay = [
          a.display_name, a.username, a.email, a.org_name,
          ...(a.assigned_exams || []).flatMap((e) => [e.name, e.exam_code]),
        ].filter(Boolean).join(' ').toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })

    // Roster order: auto-disabled → manual disabled → active with a
    // running streak → active clean. Within a group, most recent
    // activity first (falls back to created_at).
    const rank = (r) => {
      if (r.status === 'disabled' && r.disable_reason === 'auto_streak') return 0
      if (r.status === 'disabled') return 1
      if (r.status === 'active' && (r.consecutive_denials || 0) > 0) return 2
      return 3
    }
    const key = (r) => r.disabled_at || r.created_at || ''
    return [...filtered].sort((a, b) => {
      const ra = rank(a), rb = rank(b)
      if (ra !== rb) return ra - rb
      return key(b).localeCompare(key(a))
    })
  }, [items, search, instFilter, examFilter, statusFilter])

  const filtersActive =
    !!search || instFilter !== 'all' || examFilter !== 'all' || statusFilter !== 'all'
  const clearFilters = () => {
    setSearch('')
    setInstFilter('all')
    setExamFilter('all')
    setStatusFilter('all')
  }

  return (
    <ReviewerShell>
      {/* Header card — same idiom as KycInbox: warm-surface card, gold
          rule accent, monogram tile + title + stats strip. */}
      <div className="mb-6 rounded-xl bg-warm-surface ring-1 ring-warm overflow-hidden shadow-sm">
        <div className="h-[3px] rule-gold" />
        <div className="p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-start gap-4 min-w-0">
              <div className="h-12 w-12 rounded-xl bg-stone-100 text-stone-800 flex items-center justify-center shrink-0">
                <Icon.ShieldCheck className="h-6 w-6" />
              </div>
              <div className="min-w-0">
                <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
                  Verification agents
                </h1>
                <p className="mt-1 text-sm text-slate-500 max-w-xl">
                  Every agent under your client scope. Three consecutive
                  denies auto-disables an agent — this is where you lift
                  the lockout once you&rsquo;ve confirmed the reason.
                </p>
              </div>
            </div>
            <Button variant="secondary" size="sm" onClick={load} disabled={refreshing}>
              <Icon.Refresh className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              <span className="ml-1.5">{refreshing ? 'Refreshing…' : 'Refresh'}</span>
            </Button>
          </div>

          {/* Stats strip — same shape as the other reviewer pages so it
              reads as part of the same product. */}
          <div className="mt-5 pt-5 border-t border-slate-100 grid grid-cols-2 sm:grid-cols-4 gap-6 text-sm">
            <Stat label="Total agents" value={total} />
            <Stat label="Active" value={active.length} tone="emerald" />
            <Stat
              label="Auto-disabled"
              value={auto.length}
              tone="rose"
              hint={auto.length ? 'needs your attention' : ''}
            />
            <Stat label="Manually disabled" value={manual.length} tone="slate" />
          </div>
        </div>
      </div>

      {err && (
        <div role="alert" className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
          {err}
        </div>
      )}

      {/* Filter bar. Composes AND across all four controls; every
          change re-runs the useMemo above and re-renders the callout +
          table below. Reset link appears only when at least one
          filter is active, so the ordinary "just look" case has no
          extraneous chrome. */}
      {items !== null && items.length > 0 && (
        <div className="mb-4 rounded-xl bg-white ring-1 ring-warm shadow-sm">
          <div className="p-3 sm:p-4 grid grid-cols-1 sm:grid-cols-[1fr_auto_auto_auto] gap-3 items-center">
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">
                <Icon.Search className="h-4 w-4" />
              </span>
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name, username, email, exam…"
                className="w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 py-2 text-sm focus:border-stone-500 focus:outline-none focus:ring-2 focus:ring-stone-200"
              />
            </div>
            <FilterSelect
              value={instFilter}
              onChange={setInstFilter}
              options={[{ value: 'all', label: 'All institutes' }, ...instituteOptions]}
              ariaLabel="Filter by institute"
            />
            <FilterSelect
              value={examFilter}
              onChange={setExamFilter}
              options={[{ value: 'all', label: 'All exams' }, ...examOptions]}
              ariaLabel="Filter by exam"
            />
            <FilterSelect
              value={statusFilter}
              onChange={setStatusFilter}
              options={STATUS_OPTIONS}
              ariaLabel="Filter by status"
            />
          </div>
          {filtersActive && (
            <div className="px-4 py-2 border-t border-slate-100 flex items-center justify-between gap-3">
              <p className="text-xs text-slate-500 tabular-nums">
                Showing <span className="font-semibold text-slate-800">{sorted.length}</span>
                {' '}of <span className="font-semibold text-slate-800">{total}</span> agents
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

      {/* Needs-attention block. Only rendered when at least one
          auto-disabled agent matches the current filter set —
          otherwise the callout would duplicate rows the reviewer just
          filtered away, which felt inconsistent at build time. */}
      {sorted.some((a) => a.status === 'disabled' && a.disable_reason === 'auto_streak') && (
        <section className="mb-8" aria-labelledby="attention-heading">
          <div className="mb-3 flex items-center gap-2">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 rounded-full bg-rose-500"
            />
            <h2
              id="attention-heading"
              className="text-[11px] font-bold uppercase tracking-[0.14em] text-rose-800"
            >
              Needs attention · {sorted.filter((a) => a.status === 'disabled' && a.disable_reason === 'auto_streak').length} agent{sorted.filter((a) => a.status === 'disabled' && a.disable_reason === 'auto_streak').length === 1 ? '' : 's'}
            </h2>
          </div>
          <ul className="space-y-3">
            {sorted.filter((a) => a.status === 'disabled' && a.disable_reason === 'auto_streak').map((a) => (
              <li
                key={a.id}
                className="rounded-xl bg-white ring-1 ring-rose-200/70 shadow-sm overflow-hidden"
              >
                <div className="h-[3px] bg-rose-500/80" />
                <div className="p-4 sm:p-5 flex flex-wrap items-start gap-4">
                  <span
                    aria-hidden="true"
                    className="h-11 w-11 shrink-0 rounded-lg bg-rose-100 text-rose-700 font-display font-extrabold text-[16px] flex items-center justify-center"
                  >
                    {initialFor(a)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <p className="text-[15px] font-semibold text-slate-900 truncate">
                        {a.display_name || a.username}
                      </p>
                      <span className="font-mono text-[11px] text-slate-400">
                        {a.username}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-slate-600">
                      Auto-disabled after 3 consecutive denies.
                      {a.disabled_at && (
                        <> Locked <span className="text-slate-500">{formatRelative(a.disabled_at)}</span>.</>
                      )}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      <span className="font-medium text-slate-600">{a.org_name}</span>
                      {a.email && <> · {a.email}</>}
                    </p>
                    {(a.assigned_exams || []).length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {a.assigned_exams.map((e) => (
                          <span
                            key={e.id}
                            className="inline-flex items-center gap-1 rounded-md bg-rose-100/70 text-rose-800 px-1.5 py-0.5 text-[11px] font-medium"
                          >
                            {e.name}
                            <span className="font-mono text-rose-600/70">{e.exam_code}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busyId === a.id}
                    onClick={() => onEnable(a.id)}
                    className="shrink-0"
                  >
                    {busyId === a.id ? 'Enabling…' : 'Enable agent'}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Roster — everyone. A simple table so a reviewer scanning 40
          agents can see them all at once without any decoration in the
          way. Row status is a Pill; only actionable rows carry a
          button. */}
      {items === null ? (
        <div className="rounded-xl bg-white ring-1 ring-warm p-4 space-y-2">
          {[0, 1, 2, 3].map((k) => (
            <Skeleton key={k} className="h-8 w-full" />
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <div className="rounded-xl bg-warm-surface ring-1 ring-warm p-10 text-center">
          {filtersActive ? (
            <>
              <p className="text-sm font-semibold text-slate-700">No agents match those filters</p>
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
            </>
          ) : (
            <>
              <p className="text-sm font-semibold text-slate-700">No agents yet</p>
              <p className="text-xs text-slate-500 mt-1">
                Verification agents appear here once your client&rsquo;s
                approved institutes create them.
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="rounded-xl bg-white ring-1 ring-warm overflow-hidden shadow-sm">
          <div className="h-[2px] rule-gold" />
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-warm-surface text-slate-500 uppercase text-[11px]">
                <tr>
                  <th className="text-left px-4 py-2.5 font-semibold tracking-wider">Agent</th>
                  <th className="text-left px-4 py-2.5 font-semibold tracking-wider">Institute</th>
                  <th className="text-left px-4 py-2.5 font-semibold tracking-wider">Exam</th>
                  <th className="text-left px-4 py-2.5 font-semibold tracking-wider">Status</th>
                  <th className="text-left px-4 py-2.5 font-semibold tracking-wider">Last activity</th>
                  <th className="text-right px-4 py-2.5 font-semibold tracking-wider">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sorted.map((a) => (
                  <AgentRow
                    key={a.id}
                    a={a}
                    busy={busyId === a.id}
                    onEnable={() => onEnable(a.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </ReviewerShell>
  )
}

// A single row in the roster table. Broken out so the status
// decision tree stays legible.
function AgentRow({ a, busy, onEnable }) {
  const isAuto = a.status === 'disabled' && a.disable_reason === 'auto_streak'
  const isManual = a.status === 'disabled' && !isAuto

  // Row tint mirrors the status — soft rose for auto-lockout, soft
  // slate for a manual disable, plain white otherwise.
  const rowTint =
    isAuto ? 'bg-rose-50/40'
    : isManual ? 'bg-slate-50/60'
    : 'bg-white'

  return (
    <tr className={rowTint}>
      <td className="px-4 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <span
            aria-hidden="true"
            className={`h-8 w-8 shrink-0 rounded-md flex items-center justify-center font-display font-bold text-[13px] ${
              isAuto ? 'bg-rose-100 text-rose-700'
              : isManual ? 'bg-slate-100 text-slate-500'
              : 'bg-stone-100 text-stone-700'
            }`}
          >
            {initialFor(a)}
          </span>
          <div className="min-w-0">
            <p className="font-semibold text-slate-900 truncate">
              {a.display_name || a.username}
            </p>
            <p className="font-mono text-[11px] text-slate-400 truncate">
              {a.username}
              {a.email && <span className="ml-2 font-sans text-slate-500">{a.email}</span>}
            </p>
          </div>
        </div>
      </td>
      <td className="px-4 py-3 text-slate-700">
        {a.org_name || <span className="text-slate-400">—</span>}
      </td>
      <td className="px-4 py-3">
        {(a.assigned_exams || []).length === 0 ? (
          <span className="text-slate-400 text-xs">Unassigned</span>
        ) : (
          <div className="flex flex-col gap-0.5 min-w-0">
            {a.assigned_exams.map((e) => (
              <span key={e.id} className="text-xs truncate">
                <span className="text-slate-700">{e.name}</span>
                <span className="ml-1.5 font-mono text-[10px] text-slate-400">{e.exam_code}</span>
              </span>
            ))}
          </div>
        )}
      </td>
      <td className="px-4 py-3">
        {isAuto ? (
          <Pill tone="rose" dot>Auto-disabled</Pill>
        ) : isManual ? (
          <Pill tone="slate" dot>Disabled</Pill>
        ) : (
          <Pill tone="emerald" dot>Active</Pill>
        )}
      </td>
      <td className="px-4 py-3 text-slate-600 tabular-nums text-xs">
        {isAuto || isManual
          ? <>disabled <span className="text-slate-500">{formatRelative(a.disabled_at)}</span></>
          : formatRelative(a.created_at)}
      </td>
      <td className="px-4 py-3 text-right">
        {isAuto || isManual ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={onEnable}
            className={isAuto ? '!text-rose-800 !border-rose-200 hover:!bg-rose-50' : ''}
          >
            {busy ? 'Enabling…' : 'Enable'}
          </Button>
        ) : (
          <span className="text-slate-300 text-xs">—</span>
        )}
      </td>
    </tr>
  )
}

// Small stat cell used inside the header card. Same visual weight as
// the KycInbox stat strip so both pages read as siblings.
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
        <p className="text-[11px] text-rose-700/80 mt-0.5">{hint}</p>
      )}
    </div>
  )
}

// Compact native <select> styled to sit inline in the filter row.
// Native rather than a custom popover so keyboard users, screen
// readers, and mobile pickers all work out of the box.
function FilterSelect({ value, onChange, options, ariaLabel }) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel}
        className="appearance-none rounded-lg border border-slate-200 bg-white pl-3 pr-9 py-2 text-sm text-slate-800 focus:border-stone-500 focus:outline-none focus:ring-2 focus:ring-stone-200 max-w-[220px] truncate"
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
