import { hi } from '../../components/fv/hindi.jsx'
import { RvHead, RvSeal } from '../../components/fv/FvReviewer.jsx'
import { AgentPortrait, GlyphSheet, GlyphWindow, ArtCollege } from '../../components/fv/FvArt.jsx'
import { ArtRecords } from '../../components/fv/FvArt.jsx'
import { useEffect, useState } from 'react'
import ReviewerShell, { ReviewerPageHead } from '../../components/reviewer/ReviewerShell.jsx'
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
import { api, downloadReviewerVerificationsCSV } from '../../lib/api.js'

// /reviewer/history — verification audit for every org approved under
// this reviewer's exam board. Direct parallel to the institute admin's
// /admin/history, wired to /api/client/verifications instead. Wallet
// history is deliberately NOT surfaced here — reviewers don't handle
// billing.

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

export default function ReviewerHistory() {
  const [filters, setFilters] = useState({
    roll: '',
    status: '',
    org: '',
    exam_id: '',
    from: '',
    to: '',
  })
  const [appliedFilters, setAppliedFilters] = useState({})
  const [rows, setRows] = useState([])
  const [pendingRows, setPendingRows] = useState([])   // abandoned liveness-charged flows scoped to this reviewer's board
  const [nextCursor, setNextCursor] = useState(0)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  // Prev/Next pagination — same pattern as admin/History. The list
  // endpoint is cursor-only (`before=<id>`); we track the cursor that
  // fetched each page so Prev can re-run the previous request. `null`
  // at the bottom = page 1 (no `before` param, newest rows). Resets
  // whenever filters change.
  const [pageStack, setPageStack] = useState([null])
  const pageIdx = pageStack.length
  const [institutes, setInstitutes] = useState([])
  // Flat exam list for the dropdown — every exam under this reviewer's
  // exam board. Fetched once from /client/exams, alpha-sorted.
  const [exams, setExams] = useState([])
  const [dlBusy, setDlBusy] = useState('') // '' | 'filtered' | 'all'
  const [dlErr, setDlErr] = useState('')

  useEffect(() => {
    let alive = true
    api('/client/institutes')
      .then((res) => { if (alive) setInstitutes(res.institutes || []) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  useEffect(() => {
    let alive = true
    api('/client/exams')
      .then((res) => {
        if (!alive) return
        const list = (res.exams || [])
          .filter((e) => e && e.id)
          .map((e) => ({
            id: e.id,
            label: e.name ? `${e.name}${e.exam_code ? ' — ' + e.exam_code : ''}` : (e.exam_code || `Exam ${e.id}`),
          }))
          .sort((a, b) => a.label.localeCompare(b.label))
        setExams(list)
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])

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
      // Fetch verified/denied and abandoned in parallel, per the same
      // logic on the admin History page:
      //   Status "" (Any)   → both endpoints, merged chronologically
      //   verified / denied → completed only, no pending
      //   pending           → pending only (abandoned flows)
      const wantCompleted = appliedFilters.status !== 'pending'
      const wantPending   = withPending && (!appliedFilters.status || appliedFilters.status === 'pending')
      const compP = wantCompleted
        ? api('/client/verifications' + (qs ? '?' + qs : ''))
        : Promise.resolve({ rows: [], next_cursor: 0 })
      const pendingQs = new URLSearchParams()
      for (const [k, v] of Object.entries({ ...appliedFilters, ...extra })) {
        if (v && k !== 'status') pendingQs.append(k, v)
      }
      const pendP = wantPending
        ? api('/client/verifications/pending' + (pendingQs.toString() ? '?' + pendingQs.toString() : ''))
            .catch(() => ({ rows: [] }))
        : Promise.resolve({ rows: [] })
      const [res, pRes] = await Promise.all([compP, pendP])
      setRows(res.rows || [])
      setNextCursor(res.next_cursor || 0)
      // Pending rows render only on page 1 — otherwise the abandoned
      // flows would repeat every time the reviewer paged older.
      if (withPending) setPendingRows(pRes.rows || [])
      else             setPendingRows([])
    } catch (e) {
      setErr(e.message || 'failed to load history')
    } finally {
      setLoading(false)
    }
  }

  // Reload on applied-filter change and jump back to page 1 — showing a
  // deep page of a fresh filter set would read as "your filter did
  // nothing" until they clicked Prev enough times.
  useEffect(() => {
    setPageStack([null])
    load({}, { withPending: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedFilters])

  function applyFilters(e) {
    e?.preventDefault()
    setAppliedFilters({
      roll: filters.roll.trim(),
      status: filters.status,
      org: filters.org.trim(),
      exam_id: filters.exam_id,
      from: filters.from,
      to: filters.to,
    })
  }

  function clearFilters() {
    setFilters({ roll: '', status: '', org: '', exam_id: '', from: '', to: '' })
    setAppliedFilters({})
  }

  // After a page change we jump the window back to the top so the
  // reviewer lands on row 1 of the new page rather than the bottom of
  // the previous one — otherwise the fresh rows scroll in below the
  // fold, unnoticed.
  function scrollToTop() {
    try { window.scrollTo({ top: 0, behavior: 'smooth' }) } catch { window.scrollTo(0, 0) }
  }

  // Prev / Next handlers. Pages 2+ skip the pending fetch so the
  // abandoned flows don't repeat every page.
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

  async function downloadCsv(scope /* 'filtered' | 'all' */) {
    setDlBusy(scope)
    setDlErr('')
    try {
      const payload = scope === 'all' ? {} : {
        roll: filters.roll.trim(),
        status: filters.status,
        org: filters.org.trim(),
        exam_id: filters.exam_id,
        from: filters.from,
        to: filters.to,
      }
      await downloadReviewerVerificationsCSV(payload)
    } catch (e) {
      setDlErr(e?.rawMessage || e?.message || 'CSV download failed')
    } finally {
      setDlBusy('')
    }
  }

  function applyPreset(days) {
    const next = {
      roll: filters.roll,
      status: filters.status,
      org: filters.org,
      exam_id: filters.exam_id,
      from: daysAgoISO(days - 1),
      to: todayISO(),
    }
    setFilters(next)
    setAppliedFilters(next)
  }

  return (
    <ReviewerShell>
      <RvHead
        title="Verification history" art={ArtRecords}
        subtitle="Every candidate checked under the institutes you review."
      />
      <Card className="mb-6">
        <CardBody>
          <form onSubmit={applyFilters} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <div>
              <Label><span className="inline-flex items-center gap-1.5"><HIcon name="id" />Roll number</span></Label>
              <Input
                value={filters.roll}
                onChange={(e) => setFilters({ ...filters, roll: e.target.value })}
                placeholder="e.g. 10001"
              />
            </div>
            <div>
              <Label><span className="inline-flex items-center gap-1.5"><ArtCollege className="h-4 w-4" />Institute</span></Label>
              <select
                value={filters.org}
                onChange={(e) => setFilters({ ...filters, org: e.target.value })}
                className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="">All institutes</option>
                {institutes.map((i) => (
                  <option key={i.id} value={i.name}>{i.name}</option>
                ))}
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
              <Label><span className="inline-flex items-center gap-1.5"><HIcon name="seal" />Status</span></Label>
              <select
                value={filters.status}
                onChange={(e) => setFilters({ ...filters, status: e.target.value })}
                className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="">Any</option>
                <option value="verified">Verified</option>
                <option value="denied">Denied</option>
                <option value="pending">Abandoned</option>
              </select>
            </div>
            <div>
              <Label><span className="inline-flex items-center gap-1.5"><GlyphWindow className="h-4 w-4" />From</span></Label>
              <Input
                type="date"
                value={filters.from}
                // Cap at To (or today when To empty) so From can't
                // land after To — blocks the inverted range that
                // returns zero rows and reads as broken.
                max={filters.to || todayISO()}
                onChange={(e) => setFilters({ ...filters, from: e.target.value })}
              />
            </div>
            <div>
              <Label><span className="inline-flex items-center gap-1.5"><GlyphWindow className="h-4 w-4" />To</span></Label>
              <Input
                type="date"
                value={filters.to}
                // Floor at From, ceiling at today.
                min={filters.from || undefined}
                max={todayISO()}
                onChange={(e) => setFilters({ ...filters, to: e.target.value })}
              />
            </div>
            <div className="sm:col-span-2 lg:col-span-6 flex flex-wrap items-center gap-2 pt-1">
              <Button type="submit">
                <span className="inline-flex items-center gap-2"><HIcon name="search" />Apply</span>
              </Button>
              <Button type="button" variant="secondary" onClick={clearFilters}>
                <span className="inline-flex items-center gap-2"><HIcon name="clear" />Clear</span>
              </Button>
              <span className="mx-1 h-6 w-px bg-fv-line" aria-hidden="true" />
              {[[1, 'Today'], [7, '7 days'], [30, '30 days']].map(([d, label]) => (
                <button key={d} type="button" onClick={() => applyPreset(d)}
                        className="inline-flex items-center gap-1.5 rounded-full border border-fv-line bg-fv-card px-3.5 py-2 text-[13.5px] text-fv-accent-deep transition-colors hover:bg-fv-card-focus">
                  <GlyphWindow className="h-4 w-4" />{label}
                </button>
              ))}
              <div className="ml-auto flex items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => downloadCsv('filtered')}
                  disabled={dlBusy !== ''}
                  title="Download the current filtered view as CSV"
                >
                  <span className="inline-flex items-center gap-2">
                    <HIcon name="csv" />{dlBusy === 'filtered' ? 'Preparing…' : 'This view'}
                  </span>
                </Button>
                <Button
                  type="button"
                  onClick={() => downloadCsv('all')}
                  disabled={dlBusy !== ''}
                  title="Download every verification under your review scope"
                >
                  <span className="inline-flex items-center gap-2">
                    <HIcon name="csv" />{dlBusy === 'all' ? 'Preparing…' : 'Everything'}
                  </span>
                </Button>
              </div>
            </div>
            {dlErr && (
              <div className="sm:col-span-2 lg:col-span-6 text-xs text-rose-700">{dlErr}</div>
            )}
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
          <span className="fv-hi text-[13px] text-fv-faint">{hi('Results')}</span>
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
                  body={filtersActive ? 'Try a wider date range.' : 'Checks land here as your institutes run them.'}
                />
              )
            }
            return (
              <>
              {/* what each column is */}
              <div className="grid grid-cols-[96px_32px_minmax(0,1.1fr)_minmax(0,1.1fr)_minmax(0,1fr)] items-end gap-3 border-b border-fv-line bg-fv-page/60 px-4 py-2.5">
                {[['When', 'text-right'], ['', ''], ['Candidate', ''], ['Institute', ''], ['Agent', '']].map(([label], i) => (
                  <div key={i} className={i === 0 ? 'text-right' : ''}>
                    {label && <>
                      <p className="text-[12.5px] leading-tight text-fv-muted">{label}</p>
                      <p className="fv-hi text-[11px] leading-tight text-fv-faint">{hi(label)}</p>
                    </>}
                  </div>
                ))}
              </div>
              <ol className="fv-stagger relative">
                <span aria-hidden="true" className="absolute top-0 bottom-0 left-[112px] w-[2px] bg-fv-card-focus" />
                {merged.map((r) => <HistoryRow key={(r._kind === 'pending' ? 'p-' : '') + r.id} r={r} />)}
              </ol>
              </>
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
    </ReviewerShell>
  )
}

// One check on the timeline: when it happened, how it went, who was
// checked, at which institute and exam, by which agent.
function HistoryRow({ r }) {
  const abandoned = r._kind === 'pending' || r.status === 'pending'
  const status = abandoned ? 'abandoned' : r.status === 'verified' ? 'verified' : 'denied'
  const d = r.created_at ? new Date(r.created_at) : null
  const via = (r.via || '').toLowerCase()
  return (
    <li className="relative grid grid-cols-[96px_32px_minmax(0,1.1fr)_minmax(0,1.1fr)_minmax(0,1fr)] items-center gap-3 border-b border-fv-line px-4 py-3 last:border-0 transition-colors hover:bg-fv-page/70"
        data-guide-title={`Roll ${r.roll_no}`}
        data-guide={abandoned ? 'Started but never finished at the desk.' : status === 'verified' ? 'The candidate was verified.' : 'The candidate was denied at the desk.'}
        data-guide-mood="typing" data-guide-prop={status === 'denied' ? 'no' : 'file'}>
      <div className="text-right leading-tight">
        <p className="text-[14px] text-fv-ink tabular-nums">{d ? d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—'}</p>
        <p className="text-[12px] text-fv-faint tabular-nums">{d ? d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : ''}</p>
      </div>
      <span className="relative z-[1] justify-self-center rounded-full bg-white ring-4 ring-white">
        <RvSeal status={status} className="[&>span]:hidden" />
      </span>
      <div className="min-w-0">
        <p className="fv-display text-[16px] leading-tight text-fv-ink tabular-nums">Roll {r.roll_no}</p>
        <p className="mt-1 flex items-center gap-1.5">
          {abandoned
            ? <span className="text-[12.5px] text-[#7A4F12]">Not finished</span>
            : <>
                <ViaDot on={via.includes('face') || !via} kind="face" />
                <ViaDot on={via.includes('finger')} kind="finger" />
                <ViaDot on={via.includes('iris')} kind="iris" />
              </>}
        </p>
      </div>
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-[14px] text-fv-ink">
          <ArtCollege className="h-7 w-7 shrink-0" /><span className="truncate">{r.org_name || '—'}</span>
        </p>
        <p className="mt-0.5 truncate pl-9 text-[12.5px] text-fv-muted">{r.exam_name || r.center_name || ''}</p>
      </div>
      <p className="flex min-w-0 items-center gap-2 text-[14px] text-fv-ink">
        {r.operator_name && <AgentPortrait seed={r.operator_name} name={r.operator_name} className="h-8 w-8 shrink-0" />}
        <span className="truncate">{r.operator_name || 'Not recorded'}</span>
      </p>
    </li>
  )
}
function ViaDot({ on, kind }) {
  const paths = {
    face: <><circle cx="12" cy="10" r="4.2" /><path d="M5 20c1.2-3.6 3.8-5.4 7-5.4s5.8 1.8 7 5.4" /><path d="M3 7V4h3M21 7V4h-3" /></>,
    finger: <><path d="M8 18a4 5 0 0 1 8 0" /><path d="M6 15a6 7 0 0 1 12 0" /><path d="M4.5 12a7.5 8.5 0 0 1 15 0" /></>,
    iris: <><path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z" /><circle cx="12" cy="12" r="2.8" /></>,
  }
  return (
    <span title={on ? { face: 'Face', finger: 'Fingerprint', iris: 'Iris' }[kind] : undefined}
          className={`grid h-6 w-6 place-items-center rounded-full ${on ? 'bg-fv-card-focus text-fv-accent' : 'text-fv-disabled'}`}>
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>
    </span>
  )
}
function HIcon({ name }) {
  const d = {
    id: <><rect x="3" y="5" width="18" height="14" rx="2.5" /><circle cx="9" cy="11" r="2.2" /><path d="M6 16c.6-1.6 1.7-2.4 3-2.4s2.4.8 3 2.4M14.5 10h4M14.5 13.5h3" /></>,
    seal: <><circle cx="12" cy="12" r="8.5" /><path d="M8.5 12.3l2.4 2.4 4.6-5" /></>,
    search: <><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></>,
    clear: <><path d="M6 6l12 12M18 6L6 18" /></>,
    csv: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M12 11v6M9.5 14.5 12 17l2.5-2.5" /></>,
  }[name]
  return <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
}
