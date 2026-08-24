import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import ReviewerShell, { ReviewerPageHead } from '../../components/reviewer/ReviewerShell.jsx'
import { Button, Card, CardBody } from '../../components/ui/ui.jsx'
import { Icon, Pill } from '../../components/ui/extras.jsx'
import { FadeIn } from '../../components/ui/motion.jsx'
import { listReviewerApplications } from '../../lib/reviewer/api.js'

// Reviewer > KYC applications.
//
// This is the surface introduced by the 2026-08-24 KYC-routing rebuild:
// institutions registering under a client whose `kyc_review_mode` is
// 'client' (or 'both' after the superadmin's first approval) land here
// for the client reviewer to inspect and decide on. Uses the existing
// scoped list endpoint at /api/client/applications, which now filters
// pending rows down to `pending_reviewer = 'client'` server-side.

const TABS = [
  { key: 'pending',  label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
]

export default function ReviewerKycInbox() {
  const [status, setStatus] = useState('pending')
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      const res = await listReviewerApplications({ status, limit: 50, offset: 0 })
      setItems(res.items || [])
      setTotal(res.total || 0)
    } catch (e) {
      setErr(e?.body?.error || e?.message || 'Could not load applications')
    } finally {
      setLoading(false)
    }
  }, [status])

  useEffect(() => { load() }, [load])

  return (
    <ReviewerShell>
      <FadeIn>
        <ReviewerPageHead
          eyebrow="Applications"
          title="KYC applications"
          subtitle="Institutions registering for this client. Approve or reject after reviewing their KYC documents."
          right={
            <Button variant="secondary" size="sm" onClick={load} disabled={loading}>
              <Icon.RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span className="ml-1.5">{loading ? 'Refreshing…' : 'Refresh'}</span>
            </Button>
          }
        />

        {/* Tab strip — pending / approved / rejected. Compact, so the list
            below sits right under the tabs without competing headers. */}
        <div className="mb-5 flex items-center gap-1 border-b border-warm">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setStatus(t.key)}
              className={`relative px-3 py-2 text-[13px] font-semibold transition-colors ${
                status === t.key
                  ? 'text-stone-900'
                  : 'text-stone-500 hover:text-stone-800'
              }`}
            >
              {t.label}
              {status === t.key && (
                <span className="absolute inset-x-2 bottom-[-1px] h-0.5 rounded-full bg-stone-900" />
              )}
            </button>
          ))}
        </div>

        {err && (
          <div role="alert" className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
            {err}
          </div>
        )}

        <Card>
          <CardBody className="p-0">
            {loading ? (
              <div className="p-10 text-center text-sm text-stone-500">Loading…</div>
            ) : items.length === 0 ? (
              <EmptyState status={status} />
            ) : (
              <ul className="divide-y divide-warm">
                {items.map((it) => <Row key={it.id} it={it} />)}
              </ul>
            )}
          </CardBody>
        </Card>

        {total > items.length && (
          <p className="mt-3 text-[11px] text-stone-500 text-center">
            Showing {items.length} of {total}. Older rows aren't loaded yet.
          </p>
        )}
      </FadeIn>
    </ReviewerShell>
  )
}

function Row({ it }) {
  return (
    <li className="p-4 sm:p-5 hover:bg-[#FBF7F0] transition-colors">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-stone-900 truncate">{it.institution_name}</h3>
            <StatusPill status={it.status} />
          </div>
          <p className="text-[11px] text-stone-500 mt-1">
            {it.institution_type}
            {it.tier ? ` · ${it.tier}` : ''}
            {it.aishe_code ? ` · AISHE ${it.aishe_code}` : ''}
          </p>
          <p className="text-[11px] text-stone-500 mt-0.5">
            {it.city}{it.state ? ', ' + it.state : ''} · Head: {it.head_name} ({it.head_email})
          </p>
          <p className="text-[10px] text-stone-400 mt-1 tabular-nums">
            Submitted {new Date(it.created_at).toLocaleString('en-IN')} · {it.doc_count} document{it.doc_count === 1 ? '' : 's'}
          </p>
        </div>
        <div className="shrink-0">
          <Link
            to={`/reviewer/applications/${it.id}`}
            className="inline-flex items-center px-3 py-1.5 text-[12px] font-semibold rounded-md bg-stone-900 text-white hover:bg-stone-800 transition-colors"
          >
            Review
            <Icon.ChevronRight className="h-3.5 w-3.5 ml-0.5" />
          </Link>
        </div>
      </div>
    </li>
  )
}

function StatusPill({ status }) {
  const map = {
    pending:  { tone: 'amber',   label: 'Pending' },
    approved: { tone: 'emerald', label: 'Approved' },
    rejected: { tone: 'rose',    label: 'Rejected' },
    draft:    { tone: 'slate',   label: 'Draft' },
  }
  const s = map[status] || map.pending
  return <Pill tone={s.tone} dot>{s.label}</Pill>
}

function EmptyState({ status }) {
  const msg = status === 'pending'
    ? 'No KYC applications pending your review.'
    : status === 'approved'
      ? 'No approved applications yet.'
      : 'No rejected applications.'
  return (
    <div className="p-12 text-center">
      <div className="mx-auto h-12 w-12 rounded-xl bg-stone-100 text-stone-400 flex items-center justify-center mb-3">
        <Icon.Inbox className="h-6 w-6" />
      </div>
      <p className="text-sm text-stone-600">{msg}</p>
      <p className="text-[11px] text-stone-400 mt-1">Institutions routed to this client show up here.</p>
    </div>
  )
}
