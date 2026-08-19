import { useEffect, useState } from 'react'
import AdminShell, { PageHead } from '../../components/shell/AdminShell.jsx'
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
    from: '',
    to: '',
  })
  // appliedFilters is what the table actually shows; we keep the form
  // state separate so typing in the input doesn't refire requests on
  // every keystroke.
  const [appliedFilters, setAppliedFilters] = useState({})
  const [rows, setRows] = useState([])
  const [nextCursor, setNextCursor] = useState(0)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

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
      const res = await api('/admin/verifications' + (qs ? '?' + qs : ''))
      setRows((prev) => append ? [...prev, ...(res.rows || [])] : (res.rows || []))
      setNextCursor(res.next_cursor || 0)
    } catch (e) {
      setErr(e.message || 'failed to load history')
    } finally {
      setLoading(false)
    }
  }

  // Reload whenever the *applied* filters change (not on every keystroke).
  useEffect(() => {
    load({}, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedFilters])

  function applyFilters(e) {
    e?.preventDefault()
    setAppliedFilters({
      roll: filters.roll.trim(),
      status: filters.status,
      from: filters.from,
      to: filters.to,
    })
  }

  function clearFilters() {
    setFilters({ roll: '', status: '', from: '', to: '' })
    setAppliedFilters({})
  }

  function loadMore() {
    if (nextCursor) load({ before: nextCursor }, true)
  }

  // Quick range presets — they apply immediately, no Apply click needed.
  function applyPreset(days) {
    const next = {
      roll: filters.roll,
      status: filters.status,
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
      <PageHead
        eyebrow="Audit"
        title="Verification history"
        right={
          <Button onClick={downloadCSV} variant="secondary">
            Export CSV
          </Button>
        }
      />
      <Card className="mb-6">
        <CardBody>
          <form onSubmit={applyFilters} className="grid gap-3 sm:grid-cols-4">
            <div>
              <Label>Roll number</Label>
              <Input
                value={filters.roll}
                onChange={(e) => setFilters({ ...filters, roll: e.target.value })}
                placeholder="e.g. 10001"
              />
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
                onChange={(e) => setFilters({ ...filters, from: e.target.value })}
              />
            </div>
            <div>
              <Label>To</Label>
              <Input
                type="date"
                value={filters.to}
                onChange={(e) => setFilters({ ...filters, to: e.target.value })}
              />
            </div>
            <div className="sm:col-span-4 flex flex-wrap items-center gap-2 pt-1">
              <Button type="submit">Apply</Button>
              <Button type="button" variant="secondary" onClick={clearFilters}>Clear</Button>
              <span className="ml-2 text-xs text-slate-500">Quick:</span>
              <button type="button" onClick={() => applyPreset(1)}  className="text-xs underline text-slate-600 hover:text-slate-900">Today</button>
              <button type="button" onClick={() => applyPreset(7)}  className="text-xs underline text-slate-600 hover:text-slate-900">Last 7 days</button>
              <button type="button" onClick={() => applyPreset(30)} className="text-xs underline text-slate-600 hover:text-slate-900">Last 30 days</button>
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
                  <th className="text-left px-4 py-2 font-medium">Centre</th>
                  <th className="text-left px-4 py-2 font-medium">Verification Agent</th>
                  <th className="text-right px-4 py-2 font-medium">PDF</th>
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
                    <td className="px-4 py-2 text-slate-600 truncate max-w-[160px]">{r.center_name}</td>
                    <td className="px-4 py-2 text-slate-600 truncate max-w-[200px]">{r.operator_name}</td>
                    <td className="px-4 py-2 text-right">
                      <button
                        type="button"
                        onClick={() =>
                          downloadVerificationPDF(r.id).catch((e) => setErr(e.message))
                        }
                        className="text-sm font-medium text-indigo-600 hover:text-indigo-800"
                        title={`Download receipt for verification ${r.id}`}
                      >
                        Download
                      </button>
                    </td>
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
    </AdminShell>
  )
}
