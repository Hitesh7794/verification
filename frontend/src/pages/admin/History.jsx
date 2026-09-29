import HistoryScene from '../../components/fv/HistoryScene.jsx'
import { AgentPortrait, GlyphSheet, GlyphWindow } from '../../components/fv/FvArt.jsx'
import { ArtRecords } from '../../components/fv/FvArt.jsx'
import { useEffect, useState } from 'react'
import AdminShell from '../../components/fv/FvAdminShell.jsx'
import { PageHead } from '../../components/shell/AdminShell.jsx'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Label,
} from '../../components/ui/ui.jsx'
import { api, downloadVerificationPDF } from '../../lib/api.js'
import { getRoleScope, getStoredToken } from '../../lib/authStorage.js'

// /admin/history — paginated verification audit with roll/status/date
// filters and a CSV export button. The list endpoint is cursor-paginated
// at 50 rows; "Load older" extends the visible set. CSV downloads up
// to 100k rows in one shot (the backend caps it).

function fmtDateTime(s) {
  if (!s) return '—'
  try {
    return new Date(s).toLocaleString()
  } catch {
    return s
  }
}

function todayISO() {
  const d = new Date()
  return d.toISOString().slice(0, 10)
}
function daysAgoISO(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

export default function AdminHistory() {
  const [filters, setFilters] = useState({
    roll: '',
    status: '',
    exam_id: '',
    from: '',
    to: '',
  })
  // Flat exam list for the dropdown. Populated once from /admin/catalog
  // (reuses the endpoint the Verify page already hits). Every exam this
  // org has approved access to appears here, tagged with its client so
  // an admin subscribed to multiple boards can disambiguate.
  const [exams, setExams] = useState([])
  // appliedFilters is what the table actually shows; we keep the form
  // state separate so typing in the input doesn't refire requests on
  // every keystroke.
  const [appliedFilters, setAppliedFilters] = useState({})
  const [rows, setRows] = useState([])
  const [pendingRows, setPendingRows] = useState([])   // abandoned liveness-charged flows
  const [nextCursor, setNextCursor] = useState(0)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  // Prev/Next pagination. The backend list endpoint is cursor-paginated
  // (`before=<id>` returns rows older than that id), which is a one-way
  // API on its own — you can go older but not back. We keep a stack of
  // the `before` cursor that FETCHED each page so a "Prev" click re-runs
  // the request that produced the previous page. `null` at the bottom
  // is page 1 (no `before` param → newest). Page number is the stack
  // length. The stack resets whenever filters change.
  const [pageStack, setPageStack] = useState([null])
  const pageIdx = pageStack.length

  function buildQuery(extra = {}) {
    const p = new URLSearchParams()
    const f = { ...appliedFilters, ...extra }
    for (const [k, v] of Object.entries(f)) {
      if (v) p.append(k, v)
    }
    return p.toString()
  }

  async function load(extra = {}, { withPending = true } = {}) {
    setLoading(true)
    setErr('')
    try {
      const qs = buildQuery(extra)
      // What we fetch depends on the applied Status filter:
      //   ""         (Any)      → both endpoints, interleave chronologically
      //   "verified" / "denied" → completed only, skip pending (irrelevant)
      //   "pending"             → pending only, skip completed
      // The backend's /admin/verifications only accepts verified|denied
      // for `status`, so when we're in pending-only mode we DON'T
      // forward that value to the completed endpoint (it would 400 or
      // silently drop).
      const wantCompleted = appliedFilters.status !== 'pending'
      const wantPending   = withPending && (!appliedFilters.status || appliedFilters.status === 'pending')

      const compP = wantCompleted
        ? api('/admin/verifications' + (qs ? '?' + qs : ''))
        : Promise.resolve({ rows: [], next_cursor: 0 })
      // Strip the 'status=pending' out of the query going to /pending
      // (endpoint doesn't accept it, would 400) — pending is implicit.
      const pendingQs = new URLSearchParams()
      for (const [k, v] of Object.entries({ ...appliedFilters, ...extra })) {
        if (v && k !== 'status') pendingQs.append(k, v)
      }
      const pendP = wantPending
        ? api('/admin/verifications/pending' + (pendingQs.toString() ? '?' + pendingQs.toString() : ''))
            .catch(() => ({ rows: [] }))
        : Promise.resolve({ rows: [] })

      const [res, pRes] = await Promise.all([compP, pendP])
      setRows(res.rows || [])
      setNextCursor(res.next_cursor || 0)
      // Pending rows only render on page 1 — otherwise flipping through
      // older pages would keep re-showing the same abandoned flows.
      if (withPending) setPendingRows(pRes.rows || [])
      else             setPendingRows([])
    } catch (e) {
      setErr(e.message || 'failed to load history')
    } finally {
      setLoading(false)
    }
  }

  // Reload whenever the *applied* filters change (not on every keystroke).
  // Filter change also resets us back to page 1 — showing page N of a new
  // filter set would read as "your filter did nothing" until they clicked
  // Prev enough times.
  useEffect(() => {
    setPageStack([null])
    load({}, { withPending: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedFilters])

  // One-shot catalog fetch for the exam dropdown. Failures are silent —
  // the filter just stays limited to Roll / Status / Date until the
  // catalog call recovers on next reload. No point blocking the whole
  // history view on it.
  useEffect(() => {
    (async () => {
      try {
        const cat = await api('/admin/catalog')
        const flat = []
        for (const c of (cat.clients || [])) {
          for (const e of (c.exams || [])) {
            if (!e || !e.id) continue
            flat.push({
              id: e.id,
              label: `${e.name || e.exam_code} — ${c.name}`,
            })
          }
        }
        // Alpha sort so a long list of exams reads left to right by
        // exam name, not creation order.
        flat.sort((a, b) => a.label.localeCompare(b.label))
        setExams(flat)
      } catch {
        // silent — dropdown just stays empty
      }
    })()
  }, [])

  function applyFilters(e) {
    e?.preventDefault()
    setAppliedFilters({
      roll: filters.roll.trim(),
      status: filters.status,
      exam_id: filters.exam_id,
      from: filters.from,
      to: filters.to,
    })
  }

  function clearFilters() {
    setFilters({ roll: '', status: '', exam_id: '', from: '', to: '' })
    setAppliedFilters({})
  }

  // After a page change we jump the window back to the top so the
  // operator lands on row 1 of the new page instead of the bottom of
  // the previous one — otherwise the pagination controls stay in view
  // and the fresh rows scroll in below the fold, unnoticed.
  function scrollToTop() {
    try { window.scrollTo({ top: 0, behavior: 'smooth' }) } catch { window.scrollTo(0, 0) }
  }

  // Prev / Next handlers. Each page-2+ fetch skips the pending list so
  // abandoned flows don't repeat once you've moved past page 1.
  function nextPage() {
    if (!nextCursor || loading) return
    setPageStack((s) => [...s, nextCursor])
    load({ before: nextCursor }, { withPending: false })
    scrollToTop()
  }
  function prevPage() {
    if (pageStack.length <= 1 || loading) return
    const trimmed = pageStack.slice(0, -1)
    const cursor = trimmed[trimmed.length - 1]
    setPageStack(trimmed)
    load(cursor ? { before: cursor } : {}, { withPending: cursor === null })
    scrollToTop()
  }

  // Quick range presets — they apply immediately, no Apply click needed.
  function applyPreset(days) {
    const next = {
      roll: filters.roll,
      status: filters.status,
      exam_id: filters.exam_id,
      from: daysAgoISO(days - 1),
      to: todayISO(),
    }
    setFilters(next)
    setAppliedFilters(next)
  }

  // CSV download via authed fetch (browsers can't put an
  // Authorization header on a plain <a href> click; we fetch +
  // blob-URL the response and trigger the download programmatically).
  async function downloadCSV() {
    const qs = buildQuery()
    const token = getStoredToken(getRoleScope())
    try {
      const res = await fetch('/api/admin/verifications.csv' + (qs ? '?' + qs : ''), {
        headers: { Authorization: 'Bearer ' + token },
      })
      if (!res.ok) {
        const body = await res.text()
        throw new Error(body || `HTTP ${res.status}`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `verifications_${todayISO()}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) {
      setErr(e.message || 'CSV export failed')
    }
  }

  return (
    <AdminShell>
      {/* The page's living background: the archive. */}
      <HistoryScene className="fixed bottom-[30px] right-[2%] z-0 h-[min(56vh,500px)] aspect-[480/300] opacity-[0.17]" />
      <div className="fv-bold relative z-[1]">
      <PageHead
        eyebrow="Audit"
        title="Verification history" art={ArtRecords}
        subtitle="Every check, newest first."
        right={
          <Button onClick={downloadCSV} variant="secondary">
            <span className="inline-flex items-center gap-2"><FIcon name="csv" />Export CSV</span>
          </Button>
        }
      />
      <Card className="mb-6">
        <CardBody>
          <form onSubmit={applyFilters} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div>
              <Label><span className="inline-flex items-center gap-1.5"><FIcon name="id" />Roll number</span></Label>
              <Input
                value={filters.roll}
                onChange={(e) => setFilters({ ...filters, roll: e.target.value })}
                placeholder="e.g. 10001"
              />
            </div>
            <div>
              <Label><span className="inline-flex items-center gap-1.5"><FIcon name="seal" />Status</span></Label>
              <select
                value={filters.status}
                onChange={(e) => setFilters({ ...filters, status: e.target.value })}
                aria-label="Status filter"
                className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="">Any</option>
                <option value="verified">Verified</option>
                <option value="denied">Denied</option>
                <option value="pending">Abandoned</option>
              </select>
            </div>
            <div>
              <Label><span className="inline-flex items-center gap-1.5"><GlyphSheet className="h-4 w-4" />Exam</span></Label>
              <select
                value={filters.exam_id}
                onChange={(e) => setFilters({ ...filters, exam_id: e.target.value })}
                className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="">All exams</option>
                {exams.map((ex) => (
                  <option key={ex.id} value={ex.id}>{ex.label}</option>
                ))}
              </select>
            </div>
            <div>
              <Label><span className="inline-flex items-center gap-1.5"><GlyphWindow className="h-4 w-4" />From</span></Label>
              <Input
                type="date"
                value={filters.from}
                // Cap at To (or today if To not set) so the picker
                // never lets From land after To. Prevents the inverted
                // range that returns zero rows and looks like a bug.
                max={filters.to || todayISO()}
                onChange={(e) => setFilters({ ...filters, from: e.target.value })}
              />
            </div>
            <div>
              <Label><span className="inline-flex items-center gap-1.5"><GlyphWindow className="h-4 w-4" />To</span></Label>
              <Input
                type="date"
                value={filters.to}
                // Floor at From so To can never be earlier. Ceiling at
                // today — future dates always return zero rows.
                min={filters.from || undefined}
                max={todayISO()}
                onChange={(e) => setFilters({ ...filters, to: e.target.value })}
              />
            </div>
            <div className="sm:col-span-2 lg:col-span-5 flex flex-wrap items-center gap-2 pt-1">
              <Button type="submit">Apply</Button>
              <Button type="button" variant="secondary" onClick={clearFilters}>Clear</Button>
              <span className="ml-3 h-6 w-px bg-fv-line" aria-hidden="true" />
              {[[1, 'Today'], [7, '7 days'], [30, '30 days']].map(([d, label]) => (
                <button key={d} type="button" onClick={() => applyPreset(d)}
                        className="inline-flex items-center gap-1.5 rounded-full border border-fv-line bg-fv-card px-3 py-1.5 text-[13px] text-fv-accent-deep hover:bg-fv-card-focus transition-colors">
                  <GlyphWindow className="h-4 w-4" />{label}
                </button>
              ))}
            </div>
          </form>
        </CardBody>
      </Card>

      {err && (
        <div className="mb-6 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
          {err}
        </div>
      )}

      <Card>
        <div className="flex items-center gap-3 border-b border-fv-line px-5 py-4">
          <ArtRecords className="h-10 w-10" />
          <h2 className="fv-display text-[19px] tracking-[-0.015em] text-fv-ink">Results</h2>
          {!loading && (
            <span className="rounded-full bg-fv-card-focus px-2.5 py-0.5 text-[13px] text-fv-accent-deep tabular-nums">
              {rows.length + pendingRows.length}
            </span>
          )}
        </div>
        <CardBody className="p-0">
          {(() => {
            const merged = [
              ...rows.map((r) => ({ ...r, _kind: 'completed' })),
              ...pendingRows.map((r) => ({ ...r, _kind: 'pending' })),
            ]
            merged.sort((a, b) => {
              const ta = a.created_at ? new Date(a.created_at).getTime() : 0
              const tb = b.created_at ? new Date(b.created_at).getTime() : 0
              return tb - ta
            })
            if (merged.length === 0 && !loading) {
              const filtersActive = Object.values(appliedFilters).some((v) => v)
              return (
                <EmptyState
                  title={filtersActive ? 'No verifications match' : 'No verification history yet'}
                  body={filtersActive ? 'Try a wider date range.' : 'Checks land here as they happen.'}
                />
              )
            }
            return (
              <ol className="relative">
                {/* the timeline */}
                <span aria-hidden="true" className="absolute top-0 bottom-0 left-[112px] w-[2px] bg-fv-card-focus" />
                {merged.map((r) => <HistoryRow key={(r._kind === 'pending' ? 'p-' : '') + r.id} r={r} onPdf={() => downloadVerificationPDF(r.id).catch((e) => setErr(e.message))} />)}
              </ol>
            )
          })()}
          {(pageIdx > 1 || nextCursor > 0 || loading) && (
            <div className="flex items-center justify-between gap-3 border-t border-fv-line bg-fv-page/40 px-4 py-2.5">
              <button
                type="button"
                onClick={prevPage}
                disabled={pageIdx <= 1 || loading}
                className="inline-flex items-center gap-1.5 rounded-[10px] border border-fv-line bg-fv-card px-3 py-1.5 text-[13px] font-semibold text-fv-ink transition-colors hover:border-fv-accent-soft hover:bg-fv-page disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-fv-card disabled:hover:border-fv-line"
              >
                <span aria-hidden="true">←</span>
                Prev
              </button>
              <span className="text-[12.5px] font-semibold tabular-nums text-fv-muted">
                {loading ? 'Loading…' : `Page ${pageIdx}`}
              </span>
              <button
                type="button"
                onClick={nextPage}
                disabled={!nextCursor || loading}
                className="inline-flex items-center gap-1.5 rounded-[10px] bg-fv-accent px-3 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-fv-accent-deep disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-fv-accent"
              >
                Next
                <span aria-hidden="true">→</span>
              </button>
            </div>
          )}
        </CardBody>
      </Card>
      </div>
    </AdminShell>
  )
}

// One check on the timeline: when, the report (roll + how it was checked),
// where, who, its seal, and the receipt.
function HistoryRow({ r, onPdf }) {
  const abandoned = r._kind === 'pending'
  const ok = r.status === 'verified'
  const d = r.created_at ? new Date(r.created_at) : null
  const via = (r.via || '').toLowerCase()
  return (
    <li className="relative grid grid-cols-[96px_32px_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-3 border-b border-fv-line px-4 py-3 last:border-0 hover:bg-fv-page/70 transition-colors"
        data-guide-title={`Roll ${r.roll_no}`}
        data-guide={abandoned ? 'Started but not finished. The fee was charged at the face check.' : ok ? 'Verified. Download the receipt on the right.' : 'Denied at the desk. The receipt shows why.'}
        data-guide-mood={abandoned ? 'confused' : ok ? 'thumbsUp' : 'detective'}>
      <div className="text-right leading-tight">
        <p className="text-[14px] text-fv-ink tabular-nums">{d ? d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—'}</p>
        <p className="text-[12px] text-fv-faint tabular-nums">{d ? d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : ''}</p>
      </div>
      <span className="relative z-[1] justify-self-center rounded-full ring-4 ring-white">
        <Seal kind={abandoned ? 'abandoned' : ok ? 'ok' : 'denied'} />
      </span>
      <div className="flex min-w-0 items-center gap-3">
        <MiniReport />
        <div className="min-w-0">
          <p className="fv-display text-[16px] leading-tight text-fv-ink tabular-nums">Roll {r.roll_no}</p>
          <p className="mt-1 flex items-center gap-1.5">
            {abandoned
              ? <span className="text-[12.5px] text-[#7A4F12]">Not finished</span>
              : <>
                  <Via on={via.includes('face') || !via} kind="face" />
                  <Via on={via.includes('finger')} kind="finger" />
                  <Via on={via.includes('iris')} kind="iris" />
                </>}
          </p>
        </div>
      </div>
      <p className="flex min-w-0 items-center gap-2 text-[13.5px] text-fv-muted">
        <FIcon name="pin" /><span className="truncate">{r.center_name || '—'}</span>
      </p>
      <p className="flex min-w-0 items-center gap-2 text-[13.5px] text-fv-ink">
        {r.operator_name ? <AgentPortrait seed={r.operator_name} name={r.operator_name} gender={r.operator_gender} className="h-8 w-8 shrink-0" /> : null}
        <span className="truncate">{r.operator_name || 'Not recorded'}</span>
      </p>
      {abandoned ? <span className="w-[108px]" /> : (
        <button type="button" onClick={onPdf} title={`Download receipt for verification ${r.id}`}
                className="inline-flex w-[108px] items-center justify-center gap-1.5 rounded-[10px] border border-fv-line bg-fv-card px-3 py-2 text-[13px] text-fv-accent-deep hover:bg-fv-card-focus transition-colors">
          <FIcon name="pdf" />Receipt
        </button>
      )}
    </li>
  )
}
function Seal({ kind }) {
  const c = kind === 'ok' ? '#5B3FA6' : kind === 'denied' ? '#A8711F' : '#A29EB3'
  return (
    <svg viewBox="0 0 24 24" className="h-7 w-7" aria-label={kind === 'ok' ? 'Verified' : kind === 'denied' ? 'Denied' : 'Abandoned'}>
      <circle cx="12" cy="12" r="11" fill={c} />
      {kind === 'ok' && <path d="M7 12.3l3.2 3.2 6.6-7" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />}
      {kind === 'denied' && <path d="M8 8l8 8M16 8l-8 8" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />}
      {kind === 'abandoned' && <path d="M7.5 12h9" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />}
    </svg>
  )
}
function MiniReport() {
  return (
    <svg viewBox="0 0 28 34" className="h-10 w-8 shrink-0" aria-hidden="true">
      <rect x="1" y="1" width="26" height="32" rx="3" fill="#fff" stroke="#DDD5F2" strokeWidth="1.4" />
      <rect x="1" y="1" width="26" height="5" rx="2.5" fill="#5B3FA6" />
      <rect x="4.5" y="9" width="8" height="10" rx="1.5" fill="#EFEBF9" />
      <circle cx="8.5" cy="13" r="2.2" fill="#D9A47C" />
      <rect x="15" y="10" width="9" height="2" rx="1" fill="#DDD5F2" />
      <rect x="15" y="14" width="7" height="2" rx="1" fill="#EFEBF9" />
      <path d="M6 28a3 3.4 0 1 1 6 0M4.5 29.5a4.5 5 0 1 1 9 -.5" fill="none" stroke="#9A86D6" strokeWidth="1" strokeLinecap="round" />
    </svg>
  )
}
function Via({ on, kind }) {
  const paths = {
    face: <><circle cx="12" cy="10" r="4.2" /><path d="M5 20c1.2-3.6 3.8-5.4 7-5.4s5.8 1.8 7 5.4" /><path d="M3 7V4h3M21 7V4h-3" /></>,
    finger: <><path d="M8 18a4 5 0 0 1 8 0" /><path d="M6 15a6 7 0 0 1 12 0" /><path d="M4.5 12a7.5 8.5 0 0 1 15 0" /></>,
    iris: <><path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z" /><circle cx="12" cy="12" r="2.8" /></>,
  }
  return (
    <span title={on ? { face: 'Face', finger: 'Fingerprint', iris: 'Iris' }[kind] : undefined}
          className={`grid h-6 w-6 place-items-center rounded-full ${on ? 'bg-fv-card-focus text-fv-accent' : 'bg-transparent text-fv-disabled'}`}>
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>
    </span>
  )
}
function FIcon({ name }) {
  const d = {
    csv: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M12 11v6M9.5 14.5 12 17l2.5-2.5" /></>,
    pdf: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></>,
    id: <><rect x="3" y="5" width="18" height="14" rx="2.5" /><circle cx="9" cy="11" r="2.2" /><path d="M6 16c.6-1.6 1.7-2.4 3-2.4s2.4.8 3 2.4M14.5 10h4M14.5 13.5h3" /></>,
    seal: <><circle cx="12" cy="12" r="8.5" /><path d="M8.5 12.3l2.4 2.4 4.6-5" /></>,
    pin: <><path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.4" /></>,
  }[name]
  return <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-fv-accent" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
}
