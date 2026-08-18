import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import SuperShell, { PageHead } from '../../components/shell/SuperShell.jsx'
import { StatCard as XStatCard } from '../../components/shell/SuperUI.jsx'
import {
  Button,
  Card,
  CardBody,
  Input,
} from '../../components/ui/ui.jsx'
import { Icon, Pill, StatTile } from '../../components/ui/extras.jsx'
import { FadeIn, StaggerList, StaggerItem } from '../../components/ui/motion.jsx'
import { api } from '../../lib/api.js'
import { usePolling } from '../../lib/usePolling.js'

// Reviewer-first redesign with stat tiles, polished search, segmented
// filter, hover row, and a clear empty state per filter.
//
// Counts come from three parallel page-1 queries — at ~10k-row scale
// this is cheap. If/when the volume grows past 100k, we'd add a
// dedicated /counts endpoint.

const STATUS_TABS = [
  { value: 'pending', label: 'Pending', tone: 'amber', icon: Icon.Clock },
  { value: 'approved', label: 'Approved', tone: 'emerald', icon: Icon.Check },
  { value: 'rejected', label: 'Rejected', tone: 'rose', icon: Icon.X },
  { value: '', label: 'All', tone: 'slate', icon: Icon.File },
]
const PAGE_SIZE = 25

export default function PendingApplications() {
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [counts, setCounts] = useState({ pending: 0, approved: 0, rejected: 0 })
  const [offset, setOffset] = useState(0)
  const [status, setStatus] = useState('pending')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(t)
  }, [search])

  useEffect(() => {
    setOffset(0)
  }, [status, debouncedSearch])

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams()
      if (status) qs.set('status', status)
      if (debouncedSearch) qs.set('q', debouncedSearch)
      qs.set('limit', String(PAGE_SIZE))
      qs.set('offset', String(offset))
      const res = await api(`/superadmin/applications?${qs}`)
      setItems(res.items || [])
      setTotal(res.total || 0)
      setErr('')

      const countQs = new URLSearchParams()
      if (debouncedSearch) countQs.set('q', debouncedSearch)
      countQs.set('limit', '1')
      const [p, a, r] = await Promise.all(
        ['pending', 'approved', 'rejected'].map((st) =>
          api(`/superadmin/applications?${countQs}&status=${st}`).catch(() => ({ total: 0 })),
        ),
      )
      setCounts({ pending: p.total || 0, approved: a.total || 0, rejected: r.total || 0 })
    } catch (e) {
      setErr(e.message)
    } finally {
      setLoading(false)
    }
  }, [status, debouncedSearch, offset])

  // Visibility-aware polling — load runs immediately, then every 8s
  // while the tab is visible; paused entirely while hidden, with an
  // immediate catch-up fire on re-show.
  usePolling(load, 8000)

  const showingFrom = items.length > 0 ? offset + 1 : 0
  const showingTo = Math.min(offset + PAGE_SIZE, total)

  return (
    <SuperShell>
      <PageHead
        eyebrow="Applications"
        title="Institution registrations"
        subtitle="Review, approve, or reject institutions applying to onboard onto the platform."
        right={
          <button
            onClick={() => { setLoading(true); load() }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
          >
            <Icon.Refresh className="h-4 w-4" />
            Refresh
          </button>
        }
      />

      {/* Stat tiles — clickable filters. Stagger-in on mount; the
          currently-selected tile gets a stronger border so it reads
          as the active filter without needing a separate tab strip. */}
      <StaggerList className="grid gap-4 grid-cols-2 lg:grid-cols-4 mb-6">
        <StaggerItem>
          <StatTile
            label="Pending"
            value={counts.pending}
            accent="pending"
            icon={Icon.Clock}
            hint="Awaiting your review"
            onClick={() => setStatus('pending')}
            active={status === 'pending'}
          />
        </StaggerItem>
        <StaggerItem>
          <StatTile
            label="Approved"
            value={counts.approved}
            accent="approved"
            icon={Icon.Check}
            hint="Active institutions"
            onClick={() => setStatus('approved')}
            active={status === 'approved'}
          />
        </StaggerItem>
        <StaggerItem>
          <StatTile
            label="Rejected"
            value={counts.rejected}
            accent="rejected"
            icon={Icon.X}
            hint="Returned for changes"
            onClick={() => setStatus('rejected')}
            active={status === 'rejected'}
          />
        </StaggerItem>
        <StaggerItem>
          <StatTile
            label="Total"
            value={counts.pending + counts.approved + counts.rejected}
            accent="total"
            icon={Icon.File}
            hint="All submissions"
            onClick={() => setStatus('')}
            active={status === ''}
          />
        </StaggerItem>
      </StaggerList>

      {/* Filter + search */}
      <Card className="mb-6">
        <CardBody>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
              {STATUS_TABS.map((t) => {
                const active = status === t.value
                const c =
                  t.value === 'pending' ? counts.pending :
                  t.value === 'approved' ? counts.approved :
                  t.value === 'rejected' ? counts.rejected :
                  counts.pending + counts.approved + counts.rejected
                return (
                  <button
                    key={t.value || 'all'}
                    onClick={() => setStatus(t.value)}
                    className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                      active
                        ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {t.label}
                    <span
                      className={`inline-flex items-center justify-center rounded-full px-1.5 min-w-[20px] text-xs font-semibold tabular-nums ${
                        active ? pillTone(t.tone) : 'bg-slate-200 text-slate-700'
                      }`}
                    >
                      {c}
                    </span>
                  </button>
                )
              })}
            </div>
            <div className="flex-1 min-w-[200px] relative">
              <Icon.Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name, AISHE code, PAN, or email…"
                className="!pl-9"
              />
            </div>
          </div>
        </CardBody>
      </Card>

      {err && (
        <div className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-800">
          {err}
        </div>
      )}

      <Card className="overflow-hidden">
        {loading && items.length === 0 ? (
          <div className="py-16 text-center">
            <div className="inline-block h-7 w-7 rounded-full border-2 border-slate-200 border-t-indigo-600 animate-spin" />
            <p className="mt-3 text-sm text-slate-500">Loading applications…</p>
          </div>
        ) : items.length === 0 ? (
          <EmptyQueueState status={status} hasSearch={!!debouncedSearch} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 sticky top-0 z-10">
                <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-6 py-3">Institution</th>
                  <th className="px-6 py-3">Type / Tier</th>
                  <th className="px-6 py-3">Location</th>
                  <th className="px-6 py-3">Head of institution</th>
                  <th className="px-6 py-3 text-center">Docs</th>
                  <th className="px-6 py-3">Submitted</th>
                  <th className="px-6 py-3">Status</th>
                  <th className="px-6 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => {
                  const tone = it.status === 'pending' ? 'amber'
                    : it.status === 'approved' ? 'emerald'
                    : it.status === 'rejected' ? 'rose'
                    : 'slate'
                  return (
                    <motion.tr
                      key={it.id}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.22, delay: Math.min(i * 0.025, 0.4), ease: [0.22, 1, 0.36, 1] }}
                      className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer transition-colors"
                      onClick={(e) => {
                        if (e.target.tagName === 'A') return
                        window.location.href = `/superadmin/applications/${it.id}`
                      }}
                    >
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <span className="h-9 w-9 rounded-lg bg-slate-900 text-white flex items-center justify-center font-semibold text-sm shrink-0">
                            {(it.institution_name || '?').slice(0, 1).toUpperCase()}
                          </span>
                          <div className="min-w-0">
                            <div className="font-medium text-slate-900 truncate">{it.institution_name}</div>
                            {it.aishe_code && (
                              <div className="text-xs text-slate-500 mt-0.5 font-mono">{it.aishe_code}</div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="text-slate-700 capitalize">{it.institution_type}</div>
                        {it.tier && (
                          <div className="text-xs text-slate-500 mt-0.5">{tierLabel(it.tier)}</div>
                        )}
                      </td>
                      <td className="px-6 py-4 text-slate-700">
                        <div className="flex items-center gap-1.5">
                          <Icon.MapPin className="h-3.5 w-3.5 text-slate-400" />
                          <span>{it.city}</span>
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5 ml-5">{it.state}</div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="text-slate-900">{it.head_name}</div>
                        <div className="text-xs text-slate-500 mt-0.5 truncate max-w-[200px]">{it.head_email}</div>
                      </td>
                      <td className="px-6 py-4 text-center">
                        <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                          <Icon.FileText className="h-3 w-3" />
                          {it.doc_count}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <span title={new Date(it.created_at).toLocaleString()} className="text-xs text-slate-500">
                          {formatRelative(it.created_at)}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <Pill tone={tone} dot>{cap(it.status)}</Pill>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <Link
                          to={`/superadmin/applications/${it.id}`}
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 text-sm font-medium text-indigo-600 hover:text-indigo-700"
                        >
                          Review
                          <Icon.ChevronRight className="h-4 w-4" />
                        </Link>
                      </td>
                    </motion.tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {total > PAGE_SIZE && (
        <div className="mt-4 flex items-center justify-between text-sm text-slate-600">
          <span>Showing {showingFrom.toLocaleString()} – {showingTo.toLocaleString()} of {total.toLocaleString()}</span>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
              <Icon.ChevronLeft className="h-4 w-4 mr-1" />
              Prev
            </Button>
            <Button variant="secondary" size="sm" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>
              Next
              <Icon.ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </div>
      )}
    </SuperShell>
  )
}

function EmptyQueueState({ status, hasSearch }) {
  return (
    <div className="py-20 text-center">
      <div className="mx-auto h-14 w-14 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center mb-4">
        <Icon.Search className="h-6 w-6" />
      </div>
      <p className="text-base font-medium text-slate-700">
        {hasSearch
          ? 'No applications match your search'
          : status === 'pending' ? 'Nothing awaiting review'
          : status === 'approved' ? 'No approved institutions yet'
          : status === 'rejected' ? 'No rejected applications'
          : 'No applications yet'}
      </p>
      <p className="mt-1 text-sm text-slate-500 max-w-md mx-auto">
        {hasSearch
          ? 'Try searching by AISHE code, PAN, or part of the institution name.'
          : status === 'pending'
          ? 'New registrations from the public form will appear here within a few seconds.'
          : 'Switch tabs above to see applications in other states.'}
      </p>
    </div>
  )
}

function tierLabel(t) {
  if (!t) return ''
  return t.replace('tier_', 'Tier ')
}
function cap(s) {
  if (!s) return ''
  return s.charAt(0).toUpperCase() + s.slice(1)
}
function pillTone(tone) {
  return {
    amber: 'bg-amber-100 text-amber-800',
    emerald: 'bg-emerald-100 text-emerald-800',
    rose: 'bg-rose-100 text-rose-800',
    slate: 'bg-slate-200 text-slate-800',
    indigo: 'bg-indigo-100 text-indigo-800',
  }[tone] || 'bg-slate-100 text-slate-700'
}
function formatRelative(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const diffMin = (now - d) / 60000
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${Math.round(diffMin)}m ago`
  if (diffMin < 60 * 24) return `${Math.round(diffMin / 60)}h ago`
  return d.toLocaleDateString()
}
