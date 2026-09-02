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
  const [nextCursor, setNextCursor] = useState(0)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
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

  async function load(extra = {}, append = false) {
    setLoading(true)
    setErr('')
    try {
      const qs = buildQuery(extra)
      const res = await api('/client/verifications' + (qs ? '?' + qs : ''))
      setRows((prev) => append ? [...prev, ...(res.rows || [])] : (res.rows || []))
      setNextCursor(res.next_cursor || 0)
    } catch (e) {
      setErr(e.message || 'failed to load history')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load({}, false)
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

  function loadMore() {
    if (nextCursor) load({ before: nextCursor }, true)
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
      <ReviewerPageHead
        eyebrow="Audit"
        title="Verification history"
        subtitle="Every candidate verification run under the institutes you review. Wallet activity is intentionally not shown here."
      />
      <Card className="mb-6">
        <CardBody>
          <form onSubmit={applyFilters} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <div>
              <Label>Roll number</Label>
              <Input
                value={filters.roll}
                onChange={(e) => setFilters({ ...filters, roll: e.target.value })}
                placeholder="e.g. 10001"
              />
            </div>
            <div>
              <Label>Institute</Label>
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
              <Label>Exam</Label>
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
              <Label>Status</Label>
              <select
                value={filters.status}
                onChange={(e) => setFilters({ ...filters, status: e.target.value })}
                className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="">Any</option>
                <option value="verified">Verified</option>
                <option value="denied">Denied</option>
              </select>
            </div>
            <div>
              <Label>From</Label>
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
              <Label>To</Label>
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
              <Button type="submit">Apply</Button>
              <Button type="button" variant="secondary" onClick={clearFilters}>Clear</Button>
              <span className="ml-2 text-xs text-slate-500">Quick:</span>
              <button type="button" onClick={() => applyPreset(1)}  className="text-xs underline text-slate-600 hover:text-slate-900">Today</button>
              <button type="button" onClick={() => applyPreset(7)}  className="text-xs underline text-slate-600 hover:text-slate-900">Last 7 days</button>
              <button type="button" onClick={() => applyPreset(30)} className="text-xs underline text-slate-600 hover:text-slate-900">Last 30 days</button>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => downloadCsv('filtered')}
                  disabled={dlBusy !== ''}
                  title="Download the current filtered view as CSV"
                >
                  {dlBusy === 'filtered' ? 'Preparing…' : 'Download filtered CSV'}
                </Button>
                <Button
                  type="button"
                  onClick={() => downloadCsv('all')}
                  disabled={dlBusy !== ''}
                  title="Download every verification under your review scope"
                >
                  {dlBusy === 'all' ? 'Preparing…' : 'Download all'}
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
        <CardHeader>
          <CardTitle>Results</CardTitle>
        </CardHeader>
        <CardBody className="p-0">
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 uppercase text-xs">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">When</th>
                  <th className="text-left px-4 py-2 font-medium">Roll</th>
                  <th className="text-left px-4 py-2 font-medium">Status</th>
                  <th className="text-left px-4 py-2 font-medium">Via</th>
                  <th className="text-left px-4 py-2 font-medium">Institute</th>
                  <th className="text-left px-4 py-2 font-medium">Exam</th>
                  <th className="text-left px-4 py-2 font-medium">Verification Agent</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-slate-100">
                    <td className="px-4 py-2 text-slate-500 whitespace-nowrap">{fmtDateTime(r.created_at)}</td>
                    <td className="px-4 py-2 font-medium text-slate-900">{r.roll_no}</td>
                    <td className="px-4 py-2">
                      <Badge tone={r.status === 'verified' ? 'green' : 'red'}>{r.status}</Badge>
                    </td>
                    <td className="px-4 py-2 text-slate-600">{r.via || '—'}</td>
                    <td className="px-4 py-2 text-slate-600 truncate max-w-[180px]">{r.org_name || '—'}</td>
                    <td className="px-4 py-2 text-slate-600 truncate max-w-[180px]">{r.center_name || '—'}</td>
                    <td className="px-4 py-2 text-slate-600 truncate max-w-[200px]">{r.operator_name}</td>
                  </tr>
                ))}
                {rows.length === 0 && !loading && (
                  <tr>
                    <td colSpan={7} className="py-10">
                      <EmptyState
                        title="No verifications match"
                        body="Try widening the date range or clearing filters."
                      />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {(nextCursor > 0 || loading) && (
            <div className="border-t border-slate-100 px-4 py-3 text-center">
              {loading ? (
                <span className="text-sm text-slate-500">Loading…</span>
              ) : (
                <button
                  type="button"
                  onClick={loadMore}
                  className="text-sm font-medium text-indigo-600 hover:text-indigo-800"
                >
                  Load older
                </button>
              )}
            </div>
          )}
        </CardBody>
      </Card>
    </ReviewerShell>
  )
}
