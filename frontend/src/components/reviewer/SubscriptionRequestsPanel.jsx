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
//   - Tick pending rows → Approve selected, one request per exam.
//   - Blanket approve → clears every pending row for the institute
//     and adds them to this client's approved list, so they can see
//     the full exam catalogue. New requests still land here.
//   - Rejected row → read-only; the institute can re-request from
//     their own catalog and it'll come back through here.
//   - Approved row → read-only; use the regular reviewer flow (or
//     the org's unsubscribe button on the admin catalog) if you need
//     to revoke.
//
// Mass approval deliberately loops the SAME per-exam endpoint the
// single Approve button uses, rather than the /bulk-approve route.
// bulk-approve decides silently — it sends no email — so an institute
// mass-approved through it would never hear back, while the one-by-one
// path mails them per exam exactly as it does today. Blanket is a
// single call that mails once, which is why it's offered separately
// for institutes with a long list.
//
// Uses local optimistic update on decisions so the buttons feel
// immediate; a full reload happens right after to pick up server-
// side state (e.g. approval type reconciliation for blanket mode).

// orgId narrows the list to one organisation. Two institutions can
// register under the same name (different boards, or the same name in
// different states), and name matching is LOWER-TRIM, so without it a
// panel opened for "sms" also lists "SMS" — another organisation's
// requests, which mass approval must never touch. Callers that know
// the org_id pass it; the KYC detail page, which only has the CP's
// institution name, does not.
export default function SubscriptionRequestsPanel({ institutionName, orgId, onChange }) {
  const [items, setItems] = useState(null) // null=loading, []=none, [...]=some
  const [err, setErr] = useState('')
  const [busyKey, setBusyKey] = useState('') // "orgId:examId" during a request
  const [rejectingKey, setRejectingKey] = useState('') // which row's Reject panel is open
  const [rejectNote, setRejectNote] = useState('')
  const [selected, setSelected] = useState(() => new Set()) // ticked pending rows
  const [run, setRun] = useState(null)   // { done, total } while approving in bulk
  const [notice, setNotice] = useState('')
  const [confirmBlanket, setConfirmBlanket] = useState(false)

  const reload = () => {
    setErr('')
    listSubscriptionRequests({ status: 'all', institutionName, orgId: orgId || '' })
      .then((r) => {
        setItems(r?.items || [])
        // Anything just decided is no longer pending, so a stale tick
        // would offer to approve a row that has no Approve button.
        setSelected(new Set())
        setConfirmBlanket(false)
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
    setNotice('')
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [institutionName, orgId])

  async function onApprove(row) {
    const key = keyOf(row)
    setBusyKey(key)
    setErr('')
    setNotice('')
    try {
      await approveSubscriptionRequest(row.org_id, row.exam_id, { mode: 'per_exam', note: '' })
      reload()
    } catch (e) {
      setErr(e?.body?.error || e?.message || 'Approve failed')
    } finally {
      setBusyKey('')
    }
  }

  // Approve every ticked row, one request each, in the order shown.
  // Sequential rather than parallel: a reviewer approving eight exams
  // is not a throughput problem, and one failure mid-way must not
  // leave seven others in flight with nothing to report.
  async function onApproveSelected() {
    const rows = pendingRows.filter((r) => selected.has(keyOf(r)))
    if (rows.length === 0) return
    setErr('')
    setNotice('')
    setRun({ done: 0, total: rows.length })
    const failed = []
    let ok = 0
    for (const row of rows) {
      try {
        await approveSubscriptionRequest(row.org_id, row.exam_id, { mode: 'per_exam', note: '' })
        ok += 1
      } catch (e) {
        failed.push(`${row.exam_code || row.exam_name}: ${e?.body?.error || e?.message || 'failed'}`)
      }
      setRun({ done: ok + failed.length, total: rows.length })
    }
    setRun(null)
    if (failed.length) {
      // Say what got through as well as what didn't — the list below
      // reloads either way, and a bare failure would read as if
      // nothing had happened.
      setErr(`Approved ${ok} of ${rows.length}. Failed: ${failed.join('; ')}`)
    } else {
      setNotice(`Approved ${ok} exam${ok === 1 ? '' : 's'}. The institute has been emailed.`)
    }
    reload()
  }

  // One call: approves every pending row for this institute and adds
  // them to the client's approved list. The institute is emailed once,
  // about the exam this call names.
  async function onBlanketApprove() {
    const first = pendingRows[0]
    if (!first) return
    setErr('')
    setNotice('')
    setRun({ done: 0, total: pendingRows.length })
    try {
      await approveSubscriptionRequest(first.org_id, first.exam_id, {
        mode: 'blanket_client',
        note: '',
      })
      setNotice(
        `Blanket approved. All ${pendingRows.length} pending request${pendingRows.length === 1 ? '' : 's'} ` +
        'cleared, and this institute can now see your full exam catalogue.'
      )
      reload()
    } catch (e) {
      setErr(e?.body?.error || e?.message || 'Blanket approval failed')
    } finally {
      setRun(null)
      setConfirmBlanket(false)
    }
  }

  async function onReject(row) {
    if (!rejectNote.trim()) {
      setErr('Rejection note is required — the institute sees it in their email.')
      return
    }
    const key = keyOf(row)
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
  // The API joins institution details by name, so an institute whose
  // name matches more than one approved application comes back once
  // per match — the same request twice, with different city/head
  // columns. Two rows sharing a key would collide as React children,
  // tick together and be approved twice, so collapse them here: one
  // row per (org, exam), first occurrence wins.
  const uniqueItems = [...new Map((items || []).map((r) => [keyOf(r), r])).values()]

  const sortedItems = [...uniqueItems].sort((a, b) => {
    const rank = (s) => (s === 'pending' ? 0 : s === 'approved' ? 1 : 2)
    if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status)
    return (b.requested_at || '').localeCompare(a.requested_at || '')
  })

  const pendingRows  = sortedItems.filter((r) => r.status === 'pending')
  const selectedRows = pendingRows.filter((r) => selected.has(keyOf(r)))
  const allTicked    = pendingRows.length > 0 && selectedRows.length === pendingRows.length
  const someTicked   = selectedRows.length > 0 && !allTicked
  const working      = run !== null

  const toggleRow = (row) => {
    const k = keyOf(row)
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }
  const toggleAll = () => {
    setSelected(allTicked ? new Set() : new Set(pendingRows.map(keyOf)))
  }

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
        {notice && (
          <div role="status" className="mb-3 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-xs text-emerald-800">
            {notice}
          </div>
        )}

        {pendingRows.length > 0 && (
          <div className="mb-3 rounded-lg border border-warm bg-[#F8FAFC] px-3 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="flex items-center gap-2.5 text-xs text-slate-700 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={allTicked}
                  ref={(el) => { if (el) el.indeterminate = someTicked }}
                  onChange={toggleAll}
                  disabled={working}
                  className="h-4 w-4 rounded border-slate-300 accent-stone-800 cursor-pointer"
                  aria-label="Select all pending exams"
                />
                <span className="font-semibold">
                  {selectedRows.length > 0
                    ? `${selectedRows.length} of ${pendingRows.length} selected`
                    : `${pendingRows.length} pending exam${pendingRows.length === 1 ? '' : 's'}`}
                </span>
              </label>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="success"
                  size="sm"
                  disabled={working || selectedRows.length === 0}
                  onClick={onApproveSelected}
                >
                  {working && run?.total === selectedRows.length
                    ? `Approving ${run.done} of ${run.total}…`
                    : `Approve selected${selectedRows.length ? ` (${selectedRows.length})` : ''}`}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={working}
                  onClick={() => { setConfirmBlanket(true); setErr(''); setNotice('') }}
                  title="Approve every pending exam and let this institute see your full catalogue"
                >
                  Blanket approve
                </Button>
              </div>
            </div>

            {confirmBlanket && (
              <div className="mt-2.5 border-t border-warm pt-2.5 flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-slate-600 max-w-md">
                  Approve all {pendingRows.length} pending exam
                  {pendingRows.length === 1 ? '' : 's'} and add this institute to
                  your approved list — they'll see your full exam catalogue, and
                  any new request will still come back here.
                </p>
                <div className="flex items-center gap-2 shrink-0">
                  <Button variant="secondary" size="sm" disabled={working} onClick={() => setConfirmBlanket(false)}>
                    Cancel
                  </Button>
                  <Button variant="success" size="sm" disabled={working} onClick={onBlanketApprove}>
                    {working ? 'Approving…' : 'Confirm blanket approval'}
                  </Button>
                </div>
              </div>
            )}
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
                    {!isPending && pendingRows.length > 0 && (
                      <span aria-hidden="true" className="mt-1 h-4 w-4 shrink-0" />
                    )}
                    {isPending && (
                      <input
                        type="checkbox"
                        checked={selected.has(key)}
                        onChange={() => toggleRow(row)}
                        disabled={working || busy}
                        aria-label={`Select ${row.exam_name}`}
                        className="mt-1 h-4 w-4 shrink-0 rounded border-slate-300 accent-stone-800 cursor-pointer"
                      />
                    )}
                    <div className="min-w-0 flex-1">
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
                            disabled={busy || working}
                            onClick={() => { setRejectingKey(key); setRejectNote(''); setErr('') }}
                            className="!text-rose-700 !border-rose-200 hover:!bg-rose-50"
                          >
                            Reject
                          </Button>
                          <Button
                            variant="success"
                            size="sm"
                            disabled={busy || working}
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

// One row is one (org, exam) pair — the same key the decision
// endpoints take.
function keyOf(row) {
  return `${row.org_id}:${row.exam_id}`
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
