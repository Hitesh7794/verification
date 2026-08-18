import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import ReviewerShell, { ReviewerPageHead } from '../../components/reviewer/ReviewerShell.jsx'
import { Button, Card, CardBody } from '../../components/ui/ui.jsx'
import { Icon, Pill, StatTile } from '../../components/ui/extras.jsx'
import { StaggerList, StaggerItem } from '../../components/ui/motion.jsx'
import { reviewerMe, listReviewerApplications } from '../../lib/reviewer/api.js'
import { usePolling } from '../../lib/usePolling.js'

// Reviewer inbox — the client's per-tenant KYC queue.
//
// Trimmed variant of the superadmin PendingApplications page:
//   - No cross-client search box (reviewers only ever see their own).
//   - Four filter tiles (Pending / Approved / Rejected / All).
//   - Rows link to /reviewer/applications/:id.
//
// The header shows the client name via ReviewerShell which fetches
// /api/client/me itself; we still call it here to (a) surface a
// helpful "portal disabled" banner if the superadmin has flipped it
// off since login, and (b) share the me payload back to the shell so
// it doesn't need its own round-trip.

const STATUS_TABS = [
  { value: 'pending',  label: 'Pending',  tone: 'amber',   icon: Icon.Clock },
  { value: 'approved', label: 'Approved', tone: 'emerald', icon: Icon.Check },
  { value: 'rejected', label: 'Rejected', tone: 'rose',    icon: Icon.X },
  { value: '',         label: 'All',      tone: 'slate',   icon: Icon.File },
]
const PAGE_SIZE = 25

export default function ReviewerDashboard() {
  const [me, setMe] = useState(null)
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [counts, setCounts] = useState({ pending: 0, approved: 0, rejected: 0 })
  const [offset, setOffset] = useState(0)
  const [status, setStatus] = useState('pending')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => { setOffset(0) }, [status])

  useEffect(() => {
    let alive = true
    reviewerMe().then((r) => { if (alive) setMe(r) }).catch(() => {})
    return () => { alive = false }
  }, [])

  const load = useCallback(async () => {
    try {
      const res = await listReviewerApplications({ status, limit: PAGE_SIZE, offset })
      setItems(res.items || [])
      setTotal(res.total || 0)
      setErr('')

      // Cheap fan-out for the tile counts. Same trick the superadmin
      // page uses; safe up to ~10k rows and gets an /counts endpoint
      // if the volume ever crosses that.
      const [p, a, r] = await Promise.all([
        listReviewerApplications({ status: 'pending', limit: 1, offset: 0 }).catch(() => ({ total: 0 })),
        listReviewerApplications({ status: 'approved', limit: 1, offset: 0 }).catch(() => ({ total: 0 })),
        listReviewerApplications({ status: 'rejected', limit: 1, offset: 0 }).catch(() => ({ total: 0 })),
      ])
      setCounts({ pending: p.total || 0, approved: a.total || 0, rejected: r.total || 0 })
    } catch (e) {
      setErr(e.message)
    } finally {
      setLoading(false)
    }
  }, [status, offset])

  usePolling(load, 8000)

  const showingFrom = items.length > 0 ? offset + 1 : 0
  const showingTo = Math.min(offset + PAGE_SIZE, total)

  // Two overlapping "we're closed" signals from the platform:
  //   portal_enabled=false  → superadmin turned the whole reviewer
  //     surface off. Existing reviewers should stop acting. Login is
  //     already blocked; this banner exists because a JWT minted just
  //     before the flip stays valid for up to 12h.
  //   visible=false / closed=true → the client itself is hidden from
  //     institutions on the register form (see [[project-snapshot]] for
  //     the visible/closed semantics). Reviewing still works.
  const portalOff  = me && me.portal_enabled === false
  const hidden     = me && me.visible === false
  const closed     = me && me.closed === true

  return (
    <ReviewerShell meOverride={me}>
      <ReviewerPageHead
        eyebrow="Applications"
        title="Institution KYC"
        subtitle={me?.name
          ? `Review, approve, or reject institutions applying to onboard through ${me.name}.`
          : 'Review, approve, or reject institutions applying to onboard through this board.'}
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

      {portalOff && (
        <div className="mb-6 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 flex items-start gap-3">
          <span className="mt-0.5 h-8 w-8 rounded-lg bg-white text-rose-700 flex items-center justify-center shrink-0 ring-1 ring-rose-200">
            <Icon.AlertTriangle className="h-4 w-4" />
          </span>
          <div className="text-sm text-rose-900">
            <p className="font-semibold">Review portal disabled by the platform team.</p>
            <p className="mt-0.5 text-rose-800 text-xs">
              You can still browse existing applications, but approving or rejecting
              is blocked until the portal is re-enabled. New sign-ins are refused
              at the login screen.
            </p>
          </div>
        </div>
      )}
      {!portalOff && (hidden || closed) && (
        <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-3">
          <span className="mt-0.5 h-8 w-8 rounded-lg bg-white text-amber-700 flex items-center justify-center shrink-0 ring-1 ring-amber-200">
            <Icon.AlertTriangle className="h-4 w-4" />
          </span>
          <div className="text-sm text-amber-900">
            <p className="font-semibold">
              {closed
                ? 'This board is currently closed on the platform.'
                : 'This board is hidden from institutions right now.'}
            </p>
            <p className="mt-0.5 text-amber-800 text-xs">
              Existing applications stay reviewable, but new registrations won't be
              routed here until the platform team re-enables it.
            </p>
          </div>
        </div>
      )}

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
          </div>
        </CardBody>
      </Card>

      {err && (
        <div className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-800">{err}</div>
      )}

      <Card className="overflow-hidden">
        {loading && items.length === 0 ? (
          <div className="py-16 text-center">
            <div className="inline-block h-7 w-7 rounded-full border-2 border-slate-200 border-t-stone-900 animate-spin" />
            <p className="mt-3 text-sm text-slate-500">Loading applications…</p>
          </div>
        ) : items.length === 0 ? (
          <EmptyState status={status} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 sticky top-0 z-10">
                <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-6 py-3">Institution</th>
                  <th className="px-6 py-3">Type</th>
                  <th className="px-6 py-3">Location</th>
                  <th className="px-6 py-3">Head</th>
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
                        window.location.href = `/reviewer/applications/${it.id}`
                      }}
                    >
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <span className="h-9 w-9 rounded-lg bg-stone-900 text-white flex items-center justify-center font-semibold text-sm shrink-0">
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
                          to={`/reviewer/applications/${it.id}`}
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 text-sm font-medium text-stone-800 hover:text-stone-900"
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
    </ReviewerShell>
  )
}

function EmptyState({ status }) {
  return (
    <div className="py-20 text-center">
      <div className="mx-auto h-14 w-14 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center mb-4">
        <Icon.Search className="h-6 w-6" />
      </div>
      <p className="text-base font-medium text-slate-700">
        {status === 'pending' ? 'Nothing awaiting your review'
          : status === 'approved' ? 'No approved institutions yet'
          : status === 'rejected' ? 'No rejected applications'
          : 'No applications yet'}
      </p>
      <p className="mt-1 text-sm text-slate-500 max-w-md mx-auto">
        {status === 'pending'
          ? 'New registrations picking your board will appear here within a few seconds.'
          : 'Switch tabs above to see applications in other states.'}
      </p>
    </div>
  )
}

function tierLabel(t) { return t ? t.replace('tier_', 'Tier ') : '' }
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : '' }
function pillTone(tone) {
  return {
    amber:   'bg-amber-100 text-amber-800',
    emerald: 'bg-emerald-100 text-emerald-800',
    rose:    'bg-rose-100 text-rose-800',
    slate:   'bg-slate-200 text-slate-800',
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
