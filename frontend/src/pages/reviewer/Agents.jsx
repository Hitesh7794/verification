import { RvTile, RvSeal, RvHead, RvPhoto } from '../../components/fv/FvReviewer.jsx'
import { AgentPortrait, ArtCollege, GlyphSheet } from '../../components/fv/FvArt.jsx'
import { hi } from '../../components/fv/hindi.jsx'
import { ArtAgent } from '../../components/fv/FvArt.jsx'
import FvEmpty from '../../components/fv/FvEmpty.jsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import ReviewerShell from '../../components/reviewer/ReviewerShell.jsx'
import { Button } from '../../components/ui/ui.jsx'
import { Icon, Pill, Skeleton } from '../../components/ui/extras.jsx'
import { listAgents, enableAgent, listAgentVerifications } from '../../lib/reviewer/api.js'

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

  // Opening a row swaps the roster for that one agent's work. Same
  // page, same shell — the roster answers "who verifies for us", the
  // open agent answers "what has this one actually done".
  const [openAgent, setOpenAgent] = useState(null)
  const [vRows, setVRows] = useState(null)   // null = first load
  const [vErr, setVErr] = useState('')
  const [vCursor, setVCursor] = useState(0)  // 0 = no further pages
  const [vMore, setVMore] = useState(false)  // a "load more" is in flight

  // Filters for the open agent's table. All three go to the server, so
  // they narrow the whole history rather than just the page already on
  // screen — a roll verified three weeks ago is still findable.
  const [vRoll, setVRoll] = useState('')
  const [vStatus, setVStatus] = useState('')
  const [vWhen, setVWhen] = useState('')

  // Rows arrive newest-first in pages; `before` is the cursor the last
  // page handed back. Appending rather than replacing keeps what the
  // reviewer has already scrolled past.
  // Presets rather than a date picker: "when did this happen" on an
  // agent's desk is answered in days, not calendar ranges.
  const sinceFor = (when) => {
    if (!when) return ''
    const days = when === 'today' ? 0 : Number(when)
    const d = new Date()
    d.setDate(d.getDate() - days)
    return d.toISOString().slice(0, 10)
  }

  const loadVerifications = async (agent, cursor = 0, filters = null) => {
    if (!agent) return
    const f = filters || { roll: vRoll, status: vStatus, when: vWhen }
    cursor ? setVMore(true) : setVRows(null)
    setVErr('')
    try {
      const r = await listAgentVerifications(agent.id, {
        limit: 50, before: cursor,
        roll: f.roll.trim(), status: f.status, from: sinceFor(f.when),
      })
      const page = r?.rows || []
      setVRows((prev) => (cursor && prev ? [...prev, ...page] : page))
      setVCursor(r?.next_cursor || 0)
    } catch (e) {
      if (!cursor) setVRows([])
      setVErr(e?.body?.error || e?.message || 'Could not load this agent\u2019s verifications')
    } finally {
      setVMore(false)
    }
  }

  function openAgentRow(a) {
    setOpenAgent(a)
    setVRows(null)
    setVCursor(0)
    setVRoll(''); setVStatus(''); setVWhen('')
    appliedRoll.current = ''
    loadVerifications(a, 0, { roll: '', status: '', when: '' })
  }

  // Search as the reviewer types, one request per pause rather than
  // per keystroke. appliedRoll remembers what the server last saw, so
  // a re-render can't fire a duplicate request for the same text.
  const appliedRoll = useRef('')
  useEffect(() => {
    if (!openAgent) return
    if (vRoll.trim() === appliedRoll.current) return
    const timer = setTimeout(() => {
      appliedRoll.current = vRoll.trim()
      setVCursor(0)
      loadVerifications(openAgent, 0, { roll: vRoll, status: vStatus, when: vWhen })
    }, 350)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vRoll, openAgent])

  // Changing a filter always restarts at the newest page: a cursor
  // from the previous filter set points into a different result.
  function applyVFilter(next) {
    const f = { roll: vRoll, status: vStatus, when: vWhen, ...next }
    setVRoll(f.roll); setVStatus(f.status); setVWhen(f.when)
    appliedRoll.current = f.roll.trim()
    setVCursor(0)
    loadVerifications(openAgent, 0, f)
  }

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

  // ─── one agent ───────────────────────────────────────────
  if (openAgent) {
    const a = openAgent
    const isAuto = a.status === 'disabled' && a.disable_reason === 'auto_streak'
    const isManual = a.status === 'disabled' && !isAuto
    const rows = vRows || []
    const verified = rows.filter((v) => v.status === 'verified').length
    const denied = rows.filter((v) => v.status === 'denied').length

    return (
      <ReviewerShell>
        <button
          type="button"
          onClick={() => { setOpenAgent(null); setVRows(null); setVErr('') }}
          className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-fv-line bg-fv-card px-3 py-1.5 text-[12.5px] font-semibold text-fv-ink hover:bg-fv-card-focus"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          All agents
          <span className="fv-hi text-[11px] text-fv-faint">{hi('Agent')}</span>
        </button>

        <div className="mb-6 rounded-xl bg-warm-surface ring-1 ring-warm overflow-hidden shadow-sm">
          <div className="h-[3px] rule-gold" />
          <div className="relative overflow-hidden p-5 sm:p-6">
            <RvPhoto name={a.org_name || a.institute_name} photo={a.org_photo_url || a.logo_url} width="26%" />
            <div className="relative flex flex-wrap items-start gap-4">
              <AgentPortrait seed={a.display_name || a.username} name={a.display_name || a.username}
                             className={`h-14 w-14 shrink-0 ${isAuto || isManual ? 'grayscale opacity-70' : ''}`} />
              <div className="min-w-0 flex-1">
                <h1 className="fv-display text-[24px] leading-tight tracking-[-0.02em] text-fv-ink truncate">
                  {a.display_name || a.username}
                </h1>
                <p className="text-[13px] text-fv-accent-deep">@{a.username}</p>
                <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-fv-muted">
                  <span className="inline-flex items-center gap-1.5">
                    <ArtCollege className="h-6 w-6 shrink-0" />
                    {a.org_name || a.institute_name || '\u2014'}
                  </span>
                  {a.email && (<><span className="text-fv-faint">·</span><span className="truncate">{a.email}</span></>)}
                </p>
              </div>
              <RvSeal status={isAuto ? 'locked' : isManual ? 'disabled' : 'active'} />
            </div>

            <div className="fv-stagger mt-5 grid grid-cols-2 gap-3 lg:grid-cols-3">
              <RvTile kind="agents" label="Verifications" value={vRows === null ? '\u2014' : rows.length}
                      hint={(vRoll || vStatus || vWhen) ? 'matching your filters' : (vCursor ? 'more on the next page' : '')} />
              <RvTile kind="approved" label="Verified" value={vRows === null ? '\u2014' : verified} />
              <RvTile kind="rejected" label="Denied" value={vRows === null ? '\u2014' : denied} />
            </div>
          </div>
        </div>

        {vErr && (
          <div role="alert" className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
            {vErr}
          </div>
        )}

        <div className="mb-4 rounded-xl bg-fv-card ring-1 ring-warm shadow-sm">
          <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-center sm:p-4">
            <form
              onSubmit={(e) => { e.preventDefault(); applyVFilter({ roll: vRoll }) }}
              className="relative"
            >
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fv-faint">
                <Icon.Search className="h-4 w-4" />
              </span>
              <input
                type="search"
                value={vRoll}
                onChange={(e) => setVRoll(e.target.value)}
                onBlur={() => applyVFilter({ roll: vRoll })}
                placeholder="Search roll number…"
                aria-label="Search by roll number"
                className="w-full rounded-lg border border-fv-line bg-white py-2 pl-9 pr-3 text-sm focus:border-fv-accent focus:outline-none focus:ring-2 focus:ring-fv-accent/20"
              />
            </form>

            <FilterSelect
              value={vStatus}
              onChange={(v) => applyVFilter({ status: v })}
              ariaLabel="Filter by result"
              options={[
                { value: '', label: 'All results' },
                { value: 'verified', label: 'Verified only' },
                { value: 'denied', label: 'Denied only' },
              ]}
            />

            <FilterSelect
              value={vWhen}
              onChange={(v) => applyVFilter({ when: v })}
              ariaLabel="Filter by time"
              options={[
                { value: '', label: 'Any time' },
                { value: 'today', label: 'Today' },
                { value: '7', label: 'Last 7 days' },
                { value: '30', label: 'Last 30 days' },
              ]}
            />

            {(vRoll || vStatus || vWhen) && (
              <button
                type="button"
                onClick={() => applyVFilter({ roll: '', status: '', when: '' })}
                className="justify-self-start text-[12.5px] font-semibold text-fv-accent-deep underline-offset-2 hover:underline sm:justify-self-auto"
              >
                Clear filters
              </button>
            )}
          </div>
        </div>

        {vRows === null ? (
          <div className="rounded-xl bg-white ring-1 ring-warm p-4 space-y-2">
            {[0, 1, 2, 3, 4].map((k) => <Skeleton key={k} className="h-8 w-full" />)}
          </div>
        ) : rows.length === 0 && (vRoll || vStatus || vWhen) ? (
          <FvEmpty
            title="Nothing matches those filters"
            body="Try a different roll number, result or period."
          />
        ) : rows.length === 0 ? (
          <FvEmpty
            title="No verifications yet"
            body={`${a.display_name || a.username} hasn\u2019t verified a candidate on your exams so far.`}
          />
        ) : (
          <div className="rounded-xl bg-white ring-1 ring-warm overflow-hidden shadow-sm">
            <div className="h-[2px] rule-gold" />
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-fv-page text-fv-muted text-[12.5px]">
                  <tr>
                    <th className="text-left px-4 py-2.5">When</th>
                    <th className="text-left px-4 py-2.5">Roll<span className="fv-hi ml-1.5 text-[11px] text-fv-faint">{hi('Roll')}</span></th>
                    {/* No institute column: every row here belongs to
                        this one agent, whose institute is named in
                        the card above. */}
                    <th className="text-left px-4 py-2.5">Exam<span className="fv-hi ml-1.5 text-[11px] text-fv-faint">{hi('Exam')}</span></th>
                    <th className="text-left px-4 py-2.5">Result<span className="fv-hi ml-1.5 text-[11px] text-fv-faint">{hi('Status')}</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((v) => (
                    <tr key={v.id} className="bg-white">
                      <td className="px-4 py-3 text-slate-600 tabular-nums text-xs whitespace-nowrap">
                        {formatRelative(v.created_at)}
                      </td>
                      <td className="px-4 py-3 font-mono text-[13px] text-fv-ink">{v.roll_no}</td>
                      <td className="px-4 py-3 text-slate-600 text-[13px]">{v.center_name || '\u2014'}</td>
                      <td className="px-4 py-3"><RvSeal status={v.status === 'verified' ? 'verified' : 'denied'} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {vCursor > 0 && (
              <div className="border-t border-slate-100 p-3 text-center">
                <Button variant="secondary" size="sm" disabled={vMore}
                        onClick={() => loadVerifications(a, vCursor)}>
                  {vMore ? 'Loading\u2026' : 'Load older'}
                </Button>
              </div>
            )}
          </div>
        )}
      </ReviewerShell>
    )
  }

  return (
    <ReviewerShell>
      {/* Header card — same idiom as KycInbox: warm-surface card, gold
          rule accent, monogram tile + title + stats strip. */}
      <div className="mb-6 rounded-xl bg-warm-surface ring-1 ring-warm overflow-hidden shadow-sm">
        <div className="h-[3px] rule-gold" />
        <div className="p-5 sm:p-6">
          <RvHead
            title="Agents"
            art={ArtAgent}
            subtitle="Everyone verifying for your exams. Three denies in a row locks an agent out; you lift it here."
            right={(
              <Button variant="secondary" onClick={load} disabled={refreshing}>
                <Icon.Refresh className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
                <span className="ml-1.5">{refreshing ? 'Refreshing…' : 'Refresh'}</span>
              </Button>
            )}
          />

          {/* Stats strip — same shape as the other reviewer pages so it
              reads as part of the same product. */}
          <div className="fv-stagger grid grid-cols-2 gap-3 lg:grid-cols-4">
            <RvTile kind="agents" label="Agents" value={total}
                    guide="Everyone with an agent login under your exams." />
            <RvTile kind="approved" label="Active" value={active.length}
                    guide="Agents who can sign in and verify right now." mood="typing" prop="stamp" />
            <RvTile kind="rejected" label="Locked" value={auto.length}
                    hint={auto.length ? 'needs your attention' : ''}
                    guide="Locked after three denies in a row. Only you can lift it." mood="typing" prop="no" />
            <RvTile kind="total" label="Disabled" value={manual.length}
                    guide="Switched off by their own institution." />
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
            <LockArt className="h-9 w-9" />
            <h2 id="attention-heading" className="fv-display text-[18px] tracking-[-0.015em] text-fv-ink">
              Locked out
              <span className="fv-hi ml-2 text-[13px] font-medium text-fv-faint">{hi('Locked')}</span>
            </h2>
          </div>
          <ul className="space-y-3">
            {sorted.filter((a) => a.status === 'disabled' && a.disable_reason === 'auto_streak').map((a) => (
              <li
                key={a.id}
                className="relative overflow-hidden rounded-[12px] border border-[#EDD9B8] bg-fv-card"
              >
                <div className="h-[3px] bg-[#A8711F]" />
                <RvPhoto name={a.org_name || a.institute_name} photo={a.org_photo_url || a.logo_url} width="34%" />
                <div className="relative p-4 sm:p-5 flex flex-wrap items-start gap-4">
                  <AgentPortrait seed={a.display_name || a.username} name={a.display_name || a.username}
                                 className="h-14 w-14 shrink-0 grayscale" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <p className="fv-display text-[18px] leading-tight tracking-[-0.015em] text-fv-ink truncate">
                        {a.display_name || a.username}
                      </p>
                      <span className="text-[13px] text-fv-accent-deep">@{a.username}</span>
                      <RvSeal status="locked" />
                    </div>
                    <p className="mt-1.5 text-[14px] text-fv-muted">
                      Locked after three denies in a row.
                      {a.disabled_at && (
                        <> Locked <span className="text-slate-500">{formatRelative(a.disabled_at)}</span>.</>
                      )}
                    </p>
                    <p className="mt-1.5 flex items-center gap-2 text-[13px] text-fv-ink">
                      <ArtCollege className="h-6 w-6 shrink-0" />{a.org_name || a.institute_name || '—'}
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
        <div className="rounded-xl bg-warm-surface ring-1 ring-warm">
          {filtersActive ? (
            <FvEmpty title="No agents match those filters" mood="detective">
              <p className="text-[14px] text-fv-muted">
                Try broadening the search or{' '}
                <button
                  type="button"
                  onClick={clearFilters}
                  className="font-semibold text-stone-800 underline underline-offset-2 hover:text-stone-900"
                >
                  clear all filters
                </button>.
              </p>
            </FvEmpty>
          ) : (
            <FvEmpty title="No agents yet" body="Verification agents appear here once your client’s approved institutes create them." />
          )}
        </div>
      ) : (
        <div className="rounded-xl bg-white ring-1 ring-warm overflow-hidden shadow-sm">
          <div className="h-[2px] rule-gold" />
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-fv-page text-fv-muted text-[12.5px]">
                <tr>
                  <th className="text-left px-4 py-2.5">Agent<span className="fv-hi ml-1.5 text-[11px] text-fv-faint">{hi('Agent')}</span></th>
                  <th className="text-left px-4 py-2.5">Institute<span className="fv-hi ml-1.5 text-[11px] text-fv-faint">{hi('Institute')}</span></th>
                  <th className="text-left px-4 py-2.5">Exam<span className="fv-hi ml-1.5 text-[11px] text-fv-faint">{hi('Exam')}</span></th>
                  <th className="text-left px-4 py-2.5">Status<span className="fv-hi ml-1.5 text-[11px] text-fv-faint">{hi('Status')}</span></th>
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
                    onOpen={() => openAgentRow(a)}
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
function AgentRow({ a, busy, onEnable, onOpen }) {
  const isAuto = a.status === 'disabled' && a.disable_reason === 'auto_streak'
  const isManual = a.status === 'disabled' && !isAuto

  // Row tint mirrors the status — soft rose for auto-lockout, soft
  // slate for a manual disable, plain white otherwise.
  const rowTint =
    isAuto ? 'bg-rose-50/40'
    : isManual ? 'bg-slate-50/60'
    : 'bg-white'

  return (
    <tr
      className={`${rowTint} cursor-pointer transition-colors hover:bg-fv-card-focus`}
      onClick={onOpen}
      tabIndex={0}
      role="button"
      aria-label={`Open ${a.display_name || a.username}'s verifications`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen?.() }
      }}
    >
      <td className="px-4 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <AgentPortrait seed={a.display_name || a.username} name={a.display_name || a.username}
                         className={`h-10 w-10 shrink-0 ${isAuto || isManual ? 'grayscale opacity-70' : ''}`} />
          <div className="min-w-0">
            <p className="fv-display text-[16px] leading-tight tracking-[-0.015em] text-fv-ink truncate">
              {a.display_name || a.username}
            </p>
            <p className="truncate text-[12.5px] text-fv-accent-deep">@{a.username}</p>
          </div>
        </div>
      </td>
      <td className="relative overflow-hidden px-4 py-3 text-fv-ink">
        <RvPhoto name={a.org_name || a.institute_name} photo={a.org_photo_url || a.logo_url} width="70%" />
        <span className="relative flex min-w-0 items-center gap-2">
          <ArtCollege className="h-7 w-7 shrink-0" />
          <span className="truncate">{a.org_name || a.institute_name || '—'}</span>
        </span>
      </td>
      <td className="px-4 py-3">
        {(a.assigned_exams || []).length === 0 && !(a.exam_names || []).length ? (
          <span className="text-[13px] text-fv-faint">No exam yet</span>
        ) : (a.assigned_exams || []).length === 0 ? (
          <div className="flex flex-col gap-0.5">
            {(a.exam_names || []).map((n) => (
              <span key={n} className="flex items-center gap-2 text-[13.5px] text-fv-ink">
                <GlyphSheet className="h-6 w-6 shrink-0" /><span className="truncate">{n}</span>
              </span>
            ))}
          </div>
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
        <RvSeal status={isAuto ? 'locked' : isManual ? 'disabled' : 'active'} />
      </td>
      <td className="px-4 py-3 text-slate-600 tabular-nums text-xs">
        {isAuto || isManual
          ? <>disabled <span className="text-slate-500">{formatRelative(a.disabled_at)}</span></>
          : formatRelative(a.created_at)}
      </td>
      <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
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

// The lock on a banner of agents who cannot sign in.
function LockArt({ className }) {
  return (
    <svg viewBox="0 0 40 40" className={className} aria-hidden="true">
      <rect x="8" y="17" width="24" height="18" rx="4" fill="#A8711F" />
      <path d="M13 17v-4a7 7 0 0 1 14 0v4" fill="none" stroke="#A8711F" strokeWidth="3.4" />
      <circle cx="20" cy="25" r="3" fill="#FFFFFF" />
      <rect x="18.6" y="26" width="2.8" height="5" rx="1.4" fill="#FFFFFF" />
    </svg>
  )
}
