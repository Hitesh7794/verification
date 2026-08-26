import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import ReviewerShell, { ReviewerPageHead } from '../../components/reviewer/ReviewerShell.jsx'
import { Button, Card, CardBody, Input, Label } from '../../components/ui/ui.jsx'
import { Icon, Pill } from '../../components/ui/extras.jsx'
import { FadeIn } from '../../components/ui/motion.jsx'
import {
  listReviewerApplications,
  bulkApproveReviewerApplications,
  bulkRejectReviewerApplications,
  reviewerMe,
} from '../../lib/reviewer/api.js'

// Reviewer > KYC applications.
//
// Institutions registering under a client whose kyc_review_mode is
// 'client' (or 'both' after the superadmin's first approval) land
// here. Reviewer decides one-by-one via the Review button, or in bulk
// via the checkbox column + the mass-action bar that appears when at
// least one pending row is checked.

export default function ReviewerKycInbox() {
  const [status, setStatus] = useState('pending') // 'pending' | 'approved' | 'rejected'
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [client, setClient] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [search, setSearch] = useState('')

  // Selection state — only meaningful on the 'pending' tab. Cleared on
  // tab switch + on refresh so the count in the mass-action bar never
  // references rows that are no longer visible.
  const [selectedIds, setSelectedIds] = useState(() => new Set())

  // Mass-action modal state: {kind: 'approve'|'reject'} when open.
  const [modal, setModal] = useState(null)
  const [note, setNote] = useState('')
  const [actionBusy, setActionBusy] = useState(false)
  const [actionErr, setActionErr] = useState('')
  const [lastResult, setLastResult] = useState(null) // {requested, succeeded, failed, results}

  const load = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      const [appRes, meRes] = await Promise.all([
        listReviewerApplications({ status, limit: 100, offset: 0 }),
        reviewerMe(),
      ])
      setItems(appRes.items || [])
      setTotal(appRes.total || 0)
      setClient(meRes)
    } catch (e) {
      setErr(e?.body?.error || e?.message || 'Could not load applications')
    } finally {
      setLoading(false)
    }
  }, [status])

  useEffect(() => { load() }, [load])
  useEffect(() => { setSelectedIds(new Set()); setLastResult(null) }, [status])

  const stats = useMemo(() => {
    return {
      total: client?.stats?.total ?? total,
      pending: client?.stats?.pending ?? (status === 'pending' ? items.length : 0),
      approved: client?.stats?.approved ?? (status === 'approved' ? items.length : 0),
      rejected: client?.stats?.rejected ?? (status === 'rejected' ? items.length : 0),
      universities: client?.stats?.universities ?? (client?.stats?.approved ?? items.length),
    }
  }, [client, total, status, items.length])

  const isPendingTab = status === 'pending'
  const selectionCount = selectedIds.size

  const filteredItems = useMemo(() => {
    const s = search.trim().toLowerCase()
    if (!s) return items
    return items.filter((it) =>
      (it.institution_name || '').toLowerCase().includes(s) ||
      (it.head_name || '').toLowerCase().includes(s) ||
      (it.city || '').toLowerCase().includes(s) ||
      (it.state || '').toLowerCase().includes(s) ||
      (it.aishe_code || '').toLowerCase().includes(s)
    )
  }, [items, search])

  const allVisibleIds = useMemo(() => filteredItems.map((i) => i.id), [filteredItems])
  const allSelected = isPendingTab && filteredItems.length > 0 && filteredItems.every((i) => selectedIds.has(i.id))

  function toggleOne(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  function toggleAll() {
    setSelectedIds(allSelected ? new Set() : new Set(allVisibleIds))
  }

  function openMassAction(kind) {
    setModal({ kind })
    setNote('')
    setActionErr('')
  }
  function closeModal() {
    if (actionBusy) return
    setModal(null)
    setNote('')
    setActionErr('')
  }

  async function confirmMassAction() {
    if (!modal) return
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    if (modal.kind === 'reject' && !note.trim()) {
      setActionErr('A note is required — it will be sent to every rejected institution.')
      return
    }
    setActionBusy(true)
    setActionErr('')
    try {
      const fn = modal.kind === 'approve' ? bulkApproveReviewerApplications : bulkRejectReviewerApplications
      const res = await fn(ids, note.trim())
      setLastResult({ kind: modal.kind, ...res })
      setModal(null)
      setSelectedIds(new Set())
      await load()
    } catch (e) {
      setActionErr(e?.body?.error || e?.message || 'Action failed')
    } finally {
      setActionBusy(false)
    }
  }

  return (
    <ReviewerShell>
      <FadeIn>
        {/* Hero Card with Client Name, Status pills, and KYC stats strip */}
        <div className="mb-8 rounded-xl bg-warm-surface ring-1 ring-warm overflow-hidden shadow-sm">
          <div className="h-1 bg-stone-900" />
          <div className="p-5 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex items-start gap-4 min-w-0">
                <div className="h-12 w-12 rounded-xl bg-stone-100 text-stone-800 flex items-center justify-center shrink-0">
                  <Icon.Building className="h-6 w-6" />
                </div>
                <div className="min-w-0">
                  <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
                    {client?.name || 'Board KYC & Institutional Approvals'}
                  </h1>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    {client?.visible ? <Pill tone="emerald" dot>Visible</Pill> : <Pill tone="slate" dot>Hidden</Pill>}
                    {client?.closed && <Pill tone="amber" dot>Closed</Pill>}
                    <span className="text-slate-300">·</span>
                    <span className="text-slate-600">KYC & University Verification Portal</span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" onClick={load} disabled={loading}>
                  <Icon.RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                  <span className="ml-1.5">{loading ? 'Refreshing…' : 'Refresh'}</span>
                </Button>
              </div>
            </div>

            {/* Statistics strip matching the Exams tab */}
            <div className="mt-5 pt-5 border-t border-slate-100 grid grid-cols-2 sm:grid-cols-4 gap-6 text-sm">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Total Applications</p>
                <p className="text-lg font-semibold text-slate-900 mt-0.5 tabular-nums">{stats.total}</p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Requested / Pending</p>
                <p className="text-lg font-semibold text-amber-700 mt-0.5 tabular-nums">{stats.pending}</p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Approved</p>
                <p className="text-lg font-semibold text-emerald-700 mt-0.5 tabular-nums">{stats.approved}</p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Universities / Colleges</p>
                <p className="text-lg font-semibold text-slate-900 mt-0.5 tabular-nums">{stats.universities}</p>
              </div>
            </div>
          </div>
        </div>

        {err && (
          <div role="alert" className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
            {err}
          </div>
        )}

        {lastResult && (
          <div className={`mb-4 rounded-lg px-3 py-2 text-sm border ${
            lastResult.failed === 0
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-amber-50 border-amber-200 text-amber-800'
          }`}>
            <span className="font-semibold">
              {lastResult.kind === 'approve' ? 'Approved' : 'Rejected'} {lastResult.succeeded} of {lastResult.requested}.
            </span>
            {lastResult.failed > 0 && ' ' + lastResult.failed + ' skipped — see the results below.'}
            <button
              type="button"
              onClick={() => setLastResult(null)}
              className="ml-2 underline text-[12px] font-medium opacity-80 hover:opacity-100"
            >
              dismiss
            </button>
          </div>
        )}

        {/* Tab Controls and Search Bar */}
        <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
          <div className="inline-flex rounded-xl bg-slate-100 p-1 text-sm font-medium">
            <button
              type="button"
              onClick={() => setStatus('pending')}
              className={`flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold transition-all ${
                status === 'pending'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <span>Pending</span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] ${
                status === 'pending' ? 'bg-amber-100 text-amber-800' : 'bg-slate-200 text-slate-700'
              }`}>
                {stats.pending}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setStatus('approved')}
              className={`flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold transition-all ${
                status === 'approved'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <span>Approved</span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] ${
                status === 'approved' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-700'
              }`}>
                {stats.approved}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setStatus('rejected')}
              className={`flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold transition-all ${
                status === 'rejected'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <span>Rejected</span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] ${
                status === 'rejected' ? 'bg-rose-100 text-rose-800' : 'bg-slate-200 text-slate-700'
              }`}>
                {stats.rejected}
              </span>
            </button>
          </div>

          <div className="w-full sm:w-64">
            <Input
              type="search"
              placeholder="Search by university, city, head…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-white text-xs"
            />
          </div>
        </div>

        {/* Bulk action bar — only visible on the pending tab when at least one row is selected */}
        {isPendingTab && selectionCount > 0 && (
          <div className="mb-4 sticky top-14 z-30 flex flex-wrap items-center gap-3 rounded-lg border border-warm-strong bg-warm-surface/95 backdrop-blur px-4 py-2 shadow-sm">
            <span className="text-sm font-semibold text-stone-900">
              {selectionCount} selected
            </span>
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="text-[12px] text-stone-500 hover:text-stone-800"
            >
              clear
            </button>
            <div className="flex-1" />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => openMassAction('reject')}
              className="!text-rose-700 !border-rose-200 hover:!bg-rose-50 hover:!border-rose-300"
            >
              Reject {selectionCount}
            </Button>
            <Button size="sm" onClick={() => openMassAction('approve')}>
              Approve {selectionCount}
            </Button>
          </div>
        )}

        <Card>
          <CardBody className="p-0">
            {loading ? (
              <div className="p-10 text-center text-sm text-stone-500">Loading applications…</div>
            ) : filteredItems.length === 0 ? (
              <EmptyState status={status} />
            ) : (
              <>
                {isPendingTab && (
                  <div className="flex items-center gap-3 px-4 sm:px-5 py-2.5 border-b border-warm bg-[#FBF7F0] text-[12px] text-stone-600">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-stone-400 text-stone-900 focus:ring-stone-500"
                      checked={allSelected}
                      onChange={toggleAll}
                      aria-label="Select all visible pending applications"
                    />
                    <span className="font-medium">{allSelected ? 'All visible selected' : 'Select all visible'}</span>
                  </div>
                )}
                <ul className="divide-y divide-warm">
                  {filteredItems.map((it) => (
                    <Row
                      key={it.id}
                      it={it}
                      selectable={isPendingTab}
                      selected={selectedIds.has(it.id)}
                      onToggle={() => toggleOne(it.id)}
                    />
                  ))}
                </ul>
              </>
            )}
          </CardBody>
        </Card>

        {total > filteredItems.length && !search && (
          <p className="mt-3 text-[11px] text-stone-500 text-center">
            Showing {filteredItems.length} of {total} applications.
          </p>
        )}
      </FadeIn>

      {modal && (
        <MassActionModal
          kind={modal.kind}
          count={selectionCount}
          note={note}
          onNoteChange={setNote}
          busy={actionBusy}
          err={actionErr}
          onConfirm={confirmMassAction}
          onCancel={closeModal}
        />
      )}
    </ReviewerShell>
  )
}

function EmptyState({ status }) {
  const label =
    status === 'pending'
      ? 'No pending applications'
      : status === 'approved'
      ? 'No approved applications'
      : 'No rejected applications'
  const sub =
    status === 'pending'
      ? 'When institutions register and select your exam board, their applications will appear here for verification.'
      : status === 'approved'
      ? 'Applications you approve will be listed here with their assigned credentials.'
      : 'Applications you reject will be archived here.'
  return (
    <div className="p-12 text-center">
      <div className="mx-auto h-12 w-12 rounded-xl bg-stone-100 text-stone-800 flex items-center justify-center mb-3">
        <Icon.FileText className="h-6 w-6" />
      </div>
      <p className="text-sm font-semibold text-stone-900">{label}</p>
      <p className="mt-1 text-xs text-stone-500 max-w-sm mx-auto">{sub}</p>
    </div>
  )
}

function Row({ it, selectable, selected, onToggle }) {
  return (
    <li className="flex items-start gap-3 p-4 sm:p-5 hover:bg-stone-50/70 transition-colors">
      {selectable && (
        <div className="pt-1">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-stone-400 text-stone-900 focus:ring-stone-500"
            checked={selected}
            onChange={onToggle}
            aria-label={`Select application ${it.id} for ${it.institution_name}`}
          />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <h3 className="text-sm font-semibold text-ink-900 truncate">
            {it.institution_name}
          </h3>
          <span className="text-[11px] text-stone-400">·</span>
          <span className="text-xs text-stone-600 capitalize">
            {it.institution_type?.replace(/_/g, ' ') || 'institution'}
          </span>
          {it.tier && (
            <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-medium text-stone-700">
              Tier {it.tier}
            </span>
          )}
          {it.status === 'pending' && <Pill tone="amber" dot>Pending Review</Pill>}
          {it.status === 'approved' && <Pill tone="emerald" dot>Approved</Pill>}
          {it.status === 'rejected' && <Pill tone="rose" dot>Rejected</Pill>}
        </div>

        <p className="mt-1 text-xs text-stone-600">
          <span className="font-medium text-stone-800">{it.head_name}</span>
          {it.head_email && <span className="text-stone-400 font-mono text-[11px]"> · {it.head_email}</span>}
          {it.city && it.state && <span className="text-stone-500"> · {it.city}, {it.state}</span>}
          {it.aishe_code && <span className="text-stone-400 font-mono text-[11px]"> · AISHE: {it.aishe_code}</span>}
        </p>

        <div className="mt-2 flex items-center gap-3 text-[11px] text-stone-400">
          <span>Submitted {it.created_at ? new Date(it.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}</span>
          <span>·</span>
          <span>{it.doc_count || 0} supporting doc{(it.doc_count || 0) === 1 ? '' : 's'}</span>
        </div>
      </div>

      <div className="shrink-0 flex items-center gap-2 pt-0.5">
        <Link
          to={`/reviewer/applications/${it.id}`}
          className="inline-flex items-center px-3 py-1.5 text-xs font-semibold rounded-lg bg-stone-900 text-white hover:bg-stone-800 transition-colors"
        >
          Review
        </Link>
      </div>
    </li>
  )
}

function MassActionModal({ kind, count, note, onNoteChange, busy, err, onConfirm, onCancel }) {
  const isApprove = kind === 'approve'
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-900/40 backdrop-blur-xs">
      <div className="w-full max-w-md rounded-2xl bg-white border border-stone-200 shadow-2xl overflow-hidden">
        <div className="p-6">
          <h3 className="text-base font-semibold text-stone-900">
            {isApprove ? `Approve ${count} application${count === 1 ? '' : 's'}?` : `Reject ${count} application${count === 1 ? '' : 's'}?`}
          </h3>
          <p className="mt-1.5 text-xs text-stone-600 leading-relaxed">
            {isApprove
              ? `This will create active institution organizations and email welcome credentials to all ${count} selected applicants.`
              : `This will reject the ${count} selected applications. The review note below will be emailed to each applicant explaining the decision.`}
          </p>

          <div className="mt-4">
            <Label className="text-xs">
              {isApprove ? 'Internal approval note (optional)' : 'Rejection reason (required)'}
            </Label>
            <textarea
              rows={3}
              value={note}
              onChange={(e) => onNoteChange(e.target.value)}
              placeholder={isApprove ? 'e.g. Verified with state medical council list' : 'e.g. Incomplete AISHE accreditation documentation'}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-800 placeholder-slate-400 focus:border-stone-900 focus:outline-none focus:ring-1 focus:ring-stone-900"
            />
          </div>

          {err && (
            <div role="alert" className="mt-3 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-700">
              {err}
            </div>
          )}

          <div className="mt-6 flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={onConfirm}
              disabled={busy || (!isApprove && !note.trim())}
              className={!isApprove ? '!bg-rose-600 hover:!bg-rose-700 !text-white' : ''}
            >
              {busy ? 'Processing…' : (isApprove ? `Approve (${count})` : `Reject (${count})`)}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
