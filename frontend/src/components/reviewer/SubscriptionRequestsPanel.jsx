import { useEffect, useState } from 'react'
import { Button, Card, CardBody, Label } from '../ui/ui.jsx'
import {
  listSubscriptionRequests,
  approveSubscriptionRequest,
  rejectSubscriptionRequest,
} from '../../lib/reviewer/api.js'

// SubscriptionRequestsPanel — V16 (2026-09-10) shared component.
//
// Renders one institute's exam-subscription requests as a stacked
// list, with Approve / Reject controls on pending rows. Used from
// two surfaces:
//
//   1. The reviewer's KYC application detail page — inline block
//      below the head-of-institution card, so an in-flight KYC
//      review can see which exams that institute has asked for.
//   2. The dedicated Exam Approval page — same component, hosted in
//      the right pane when the reviewer clicks an institute on the
//      left list.
//
// Keyed on institution_name because the reviewer's KYC data is
// proxied from the CP and doesn't carry the DP's numeric org_id.
// The DP subscription endpoint accepts institution_name and resolves
// via the same LOWER-TRIM match used by the KYC ↔ org join.
//
// Reviewer actions:
//   - Pending row → Approve / Reject (Reject requires a note).
//   - Rejected row → read-only; the institute can re-request from
//     their own catalog and it'll come back through here.
//   - Approved row → read-only; use the regular reviewer flow (or
//     the org's unsubscribe button on the admin catalog) if you need
//     to revoke.
//
// Uses local optimistic update on decisions so the buttons feel
// immediate; a full reload happens right after to pick up server-
// side state (e.g. approval type reconciliation for blanket mode).

export default function SubscriptionRequestsPanel({ institutionName, onChange }) {
  const [items, setItems] = useState(null) // null=loading, []=none, [...]=some
  const [err, setErr] = useState('')
  const [busyKey, setBusyKey] = useState('') // "orgId:examId" during a request
  const [rejectingKey, setRejectingKey] = useState('') // which row's Reject panel is open
  const [rejectNote, setRejectNote] = useState('')

  const reload = () => {
    setErr('')
    listSubscriptionRequests({ status: 'all', institutionName })
      .then((r) => {
        setItems(r?.items || [])
        onChange?.(r?.items || [])
      })
      .catch((e) => {
        setItems([])
        setErr(e?.message || 'Could not load subscription requests')
      })
  }

  useEffect(() => {
    if (!institutionName) return
    setItems(null)
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [institutionName])

  async function onApprove(row) {
    const key = `${row.org_id}:${row.exam_id}`
    setBusyKey(key)
    setErr('')
    try {
      await approveSubscriptionRequest(row.org_id, row.exam_id, { mode: 'per_exam', note: '' })
      reload()
    } catch (e) {
      setErr(e?.body?.error || e?.message || 'Approve failed')
    } finally {
      setBusyKey('')
    }
  }

  async function onReject(row) {
    if (!rejectNote.trim()) {
      setErr('Rejection note is required — the institute sees it in their email.')
      return
    }
    const key = `${row.org_id}:${row.exam_id}`
    setBusyKey(key)
    setErr('')
    try {
      await rejectSubscriptionRequest(row.org_id, row.exam_id, { note: rejectNote.trim() })
      setRejectingKey('')
      setRejectNote('')
      reload()
    } catch (e) {
      setErr(e?.body?.error || e?.message || 'Reject failed')
    } finally {
      setBusyKey('')
    }
  }

  // Sort: pending first (needs action), then approved (context),
  // then rejected (history). Within a group, most recent first.
  const sortedItems = [...(items || [])].sort((a, b) => {
    const rank = (s) => (s === 'pending' ? 0 : s === 'approved' ? 1 : 2)
    if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status)
    return (b.requested_at || '').localeCompare(a.requested_at || '')
  })

  if (items === null) {
    return (
      <Card>
        <CardBody>
          <p className="text-xs text-slate-500">Loading requests…</p>
        </CardBody>
      </Card>
    )
  }

  return (
    <Card>
      <CardBody>
        {err && (
          <div role="alert" className="mb-3 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-700">
            {err}
          </div>
        )}
        {sortedItems.length === 0 ? (
          <p className="text-xs text-slate-500">
            No exam subscription requests yet. When this institute clicks
            &ldquo;Request access&rdquo; on an exam in their catalog, the
            request will appear here for you to approve or reject.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {sortedItems.map((row) => {
              const key = `${row.org_id}:${row.exam_id}`
              const busy = busyKey === key
              const isPending  = row.status === 'pending'
              const isApproved = row.status === 'approved'
              const isRejected = row.status === 'rejected'
              const rejectingHere = rejectingKey === key
              return (
                <li key={key} className="py-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-900">
                        {row.exam_name}
                        <span className="ml-2 font-mono text-xs font-normal text-slate-500">
                          {row.exam_code}
                        </span>
                      </p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        Requested {formatRelative(row.requested_at)}
                        {row.candidate_count > 0 && (
                          <span> · {row.candidate_count.toLocaleString()} candidates</span>
                        )}
                      </p>
                      {row.review_note && !isPending && !isSystemNote(row.review_note) && (
                        <p className="text-xs text-slate-600 mt-1.5 whitespace-pre-wrap">
                          <span className="font-medium">Note:</span> {row.review_note}
                        </p>
                      )}
                    </div>
                    <div className="shrink-0">
                      {isApproved && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 border border-emerald-200 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                          Approved
                        </span>
                      )}
                      {isRejected && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 border border-rose-200 px-2 py-0.5 text-[11px] font-semibold text-rose-700">
                          Rejected
                        </span>
                      )}
                      {isPending && !rejectingHere && (
                        <div className="flex items-center gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={busy}
                            onClick={() => { setRejectingKey(key); setRejectNote(''); setErr('') }}
                            className="!text-rose-700 !border-rose-200 hover:!bg-rose-50"
                          >
                            Reject
                          </Button>
                          <Button
                            variant="success"
                            size="sm"
                            disabled={busy}
                            onClick={() => onApprove(row)}
                          >
                            {busy ? 'Working…' : 'Approve'}
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                  {isPending && rejectingHere && (
                    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <Label className="!mb-1 !text-xs">
                        Rejection note
                        <span className="ml-1.5 text-slate-400 font-normal">
                          (required — emailed to the institute)
                        </span>
                      </Label>
                      <textarea
                        value={rejectNote}
                        onChange={(e) => setRejectNote(e.target.value)}
                        rows={2}
                        placeholder="Explain why this request is being rejected so the institute knows what to fix before requesting again."
                        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-stone-500 focus:outline-none focus:ring-2 focus:ring-stone-200 resize-y"
                      />
                      <div className="mt-2 flex justify-end gap-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy}
                          onClick={() => { setRejectingKey(''); setRejectNote(''); setErr('') }}
                        >
                          Cancel
                        </Button>
                        <Button
                          variant="danger"
                          size="sm"
                          disabled={busy || !rejectNote.trim()}
                          onClick={() => onReject(row)}
                        >
                          {busy ? 'Working…' : 'Send rejection'}
                        </Button>
                      </div>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  )
}

// Seed notes written by V15-and-earlier code paths (grandfathered
// blanket-client subscriptions, admin self-subscribe under V15).
// They're internal markers, not reviewer feedback, so hide them
// from the panel.
const SYSTEM_NOTE_PREFIXES = [
  'Auto-subscribed on exam create',
  'Admin self-subscribe',
]
function isSystemNote(note) {
  const t = String(note || '').trim()
  return SYSTEM_NOTE_PREFIXES.some((p) => t.startsWith(p))
}

// Local relative-time helper, copied from ApplicationDetail so this
// component has zero cross-page deps. Trivially small; not worth
// pulling into a shared helper library.
function formatRelative(iso) {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  const now = Date.now()
  const secs = Math.max(0, Math.round((now - then) / 1000))
  if (secs < 60) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 48) return `${hrs} hr ago`
  const days = Math.round(hrs / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}
