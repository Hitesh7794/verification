import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import SuperShell, { PageHead } from '../../components/shell/SuperShell.jsx'
import ConfirmDialog from '../../components/shell/ConfirmDialog.jsx'
import {
  Button,
  Card,
  CardBody,
  Input,
  Label,
} from '../../components/ui/ui.jsx'
import { Icon, Pill } from '../../components/ui/extras.jsx'
import { FadeIn } from '../../components/ui/motion.jsx'
import {
  getClient,
  createExam,
  toggleExamVisibility,
  closeExam,
  reopenExam,
  deleteClient,
  deleteExam,
  setClientPortal,
  listClientReviewers,
  createClientReviewer,
  deleteClientReviewer,
  patchClient,
} from '../../lib/superadmin/examCatalog.js'
import { KYCReviewModePicker, KYCReviewModePill } from './Clients.jsx'
import { dateRange } from '../../lib/dates.js'

// Superadmin > Client detail — client hero + list of its exams inline.
// Every row: exam code, name, window, status chips, inline
// visibility/close buttons, [Open →] link.
export default function ClientDetail() {
  const { id } = useParams()
  const nav = useNavigate()
  const [client, setClient] = useState(null)
  const [exams, setExams] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [creating, setCreating] = useState(false)
  const [tab, setTab] = useState('active') // 'active' | 'archived'

  // Confirm-dialog state. `dlg` is null when closed, or an object
  // { kind, title, body, confirmLabel, tone, onConfirm } when open.
  const [dlg, setDlg] = useState(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      const { client, exams } = await getClient(id)
      setClient(client)
      setExams(exams || [])
    } catch (e) {
      setErr(e.message || 'Could not load client')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { refresh() }, [refresh])

  async function onToggleVisibility(examId) {
    await toggleExamVisibility(examId)
    await refresh()
  }
  function askClose(examId, examName) {
    setDlg({
      title:        `End "${examName}"?`,
      body:         'New verifications against this exam will be blocked.\nExisting data is preserved — you can reopen it later.',
      confirmLabel: 'End exam',
      tone:         'warn',
      onConfirm:    async () => { await closeExam(examId); await refresh(); setDlg(null) },
    })
  }
  async function onReopen(examId) {
    await reopenExam(examId)
    await refresh()
  }
  function askDeleteExam(examId, examName) {
    setDlg({
      title:        `Delete "${examName}"?`,
      body:         'This is permanent. Only allowed if no verifications reference candidates in this exam.\n\nUse "End" instead if you want to close the exam while preserving its data.',
      confirmLabel: 'Delete exam',
      tone:         'danger',
      onConfirm:    async () => { await deleteExam(examId); await refresh(); setDlg(null) },
    })
  }
  function askDeleteClient() {
    setDlg({
      title:        `Delete "${client?.name || 'Client'}"?`,
      body:         'This is permanent. Only allowed if the client has no exams.\n\nUse "End" instead if you want to close the client while preserving its data.',
      confirmLabel: 'Delete client',
      tone:         'danger',
      onConfirm:    async () => { await deleteClient(id); nav('/superadmin/clients') },
    })
  }

  function isExamOngoing(e) {
    if (!e || e.closed) return false
    const now = new Date()
    const from = e.verification_from ? new Date(e.verification_from) : null
    const to = e.verification_to ? new Date(e.verification_to) : null
    if (from && !isNaN(from.getTime()) && now < from) return false
    if (to && !isNaN(to.getTime()) && now > to) return false
    return true
  }

  function isExamArchived(e) {
    if (!e) return false
    if (e.closed) return true
    if (e.verification_to) {
      const to = new Date(e.verification_to)
      if (!isNaN(to.getTime()) && new Date() > to) return true
    }
    return false
  }

  if (loading) {
    return <SuperShell><div className="p-12 text-center text-sm text-slate-500">Loading…</div></SuperShell>
  }
  if (!client) {
    return (
      <SuperShell>
        <PageHead eyebrow="Client" title="Client not found" />
        <Link to="/superadmin/clients" className="text-indigo-600 hover:underline text-sm">← Back to clients</Link>
      </SuperShell>
    )
  }

  const totalCandidates = exams.reduce((s, e) => s + (e.candidate_count || 0), 0)
  const openExams = exams.filter(isExamOngoing).length

  const activeExams = exams.filter(e => !isExamArchived(e))
  const archivedExams = exams.filter(isExamArchived)
  const displayedExams = tab === 'active' ? activeExams : archivedExams

  return (
    <SuperShell>
      <FadeIn>
        <div className="mb-3">
          <Link to="/superadmin/clients" className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-800 transition-colors">
            <Icon.ChevronLeft className="h-3.5 w-3.5" />
            All clients
          </Link>
        </div>

        {/* Client hero — avatar chip + name + status chips + a small
            stat strip. More visual weight than a bare PageHeader row,
            so the page has a clear "you're inside this client" anchor. */}
        <div className="mb-8 rounded-xl bg-warm-surface ring-1 ring-warm overflow-hidden">
          <div className="h-1 bg-stone-900" />
          <div className="p-5 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex items-start gap-4 min-w-0">
                <div className="h-12 w-12 rounded-xl bg-stone-100 text-stone-800 flex items-center justify-center shrink-0">
                  <Icon.Building className="h-6 w-6" />
                </div>
                <div className="min-w-0">
                  <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{client.name}</h1>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    {client.visible ? <Pill tone="emerald" dot>Visible</Pill> : <Pill tone="slate" dot>Hidden</Pill>}
                    {client.closed && <Pill tone="amber" dot>Closed</Pill>}
                    {client.notes && (
                      <>
                        <span className="text-slate-300">·</span>
                        <span className="text-slate-600">{client.notes}</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="danger" onClick={askDeleteClient}>
                  <Icon.Trash className="h-4 w-4 mr-1.5" />
                  Delete
                </Button>
                <Button onClick={() => setCreating(v => !v)}>
                  <Icon.Plus className="h-4 w-4 mr-1.5" />
                  {creating ? 'Cancel' : 'New exam'}
                </Button>
              </div>
            </div>

            <div className="mt-5 pt-5 border-t border-slate-100 grid grid-cols-3 gap-6 text-sm">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Exams</p>
                <p className="text-lg font-semibold text-slate-900 mt-0.5 tabular-nums">{exams.length}</p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Open</p>
                <p className="text-lg font-semibold text-emerald-700 mt-0.5 tabular-nums">{openExams}</p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Candidates</p>
                <p className="text-lg font-semibold text-slate-900 mt-0.5 tabular-nums">{totalCandidates.toLocaleString()}</p>
              </div>
            </div>
          </div>
        </div>

        {err && (
          <div role="alert" className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
            {err}
          </div>
        )}

        <KYCReviewModePanel client={client} onChanged={refresh} />

        <ReviewPortalPanel client={client} onChanged={refresh} />

        <AnimatePresence initial={false}>
          {creating && (
            <motion.div
              initial={{ opacity: 0, y: -8, height: 0 }}
              animate={{ opacity: 1, y: 0, height: 'auto' }}
              exit={{ opacity: 0, y: -8, height: 0 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
              className="overflow-hidden"
            >
              <NewExamForm
                clientId={client.id}
                onCancel={() => setCreating(false)}
                onCreated={async (examId) => {
                  setCreating(false)
                  await refresh()
                  nav(`/superadmin/exams/${examId}`)
                }}
              />
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex flex-wrap items-center justify-between gap-4 mb-3">
          <div className="inline-flex rounded-xl bg-slate-100 p-1 text-sm font-medium">
            <button
              type="button"
              onClick={() => setTab('active')}
              className={`flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold transition-all ${
                tab === 'active'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <span>Active & Upcoming</span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] ${
                tab === 'active' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-700'
              }`}>
                {activeExams.length}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setTab('archived')}
              className={`flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold transition-all ${
                tab === 'archived'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <span>Archived</span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] ${
                tab === 'archived' ? 'bg-amber-100 text-amber-800' : 'bg-slate-200 text-slate-700'
              }`}>
                {archivedExams.length}
              </span>
            </button>
          </div>
          {tab === 'archived' && (
            <p className="text-xs text-slate-500">
              Exams with expired verification windows or ended status. Extending an exam's window to a future date will automatically unarchive it.
            </p>
          )}
        </div>

        <Card>
          <CardBody className="p-0">
            {displayedExams.length === 0 ? (
              tab === 'active' ? (
                exams.length === 0 ? (
                  <EmptyExams onCreate={() => setCreating(true)} />
                ) : (
                  <div className="p-10 text-center">
                    <p className="text-sm text-slate-600 font-medium">No active or upcoming exams.</p>
                    <p className="text-xs text-slate-400 mt-1">
                      All exams under this client are archived ({archivedExams.length}). You can create a new exam or extend an archived exam's verification window.
                    </p>
                  </div>
                )
              ) : (
                <div className="p-10 text-center">
                  <p className="text-sm text-slate-600 font-medium">No archived exams.</p>
                  <p className="text-xs text-slate-400 mt-1">
                    Exams whose verification window has passed or that are closed will automatically appear here.
                  </p>
                </div>
              )
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wider text-slate-500 bg-slate-50/70">
                      <th className="px-5 py-3">Exam code</th>
                      <th className="px-5 py-3">Name</th>
                      <th className="px-5 py-3">Window</th>
                      <th className="px-5 py-3">Candidates</th>
                      <th className="px-5 py-3">Status</th>
                      <th className="px-5 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayedExams.map((e) => {
                      const ongoing = isExamOngoing(e)
                      const isExpired = e.verification_to && new Date() > new Date(e.verification_to)
                      return (
                        <tr key={e.id} className="border-b border-slate-100 last:border-none hover:bg-slate-50/60 transition-colors">
                          <td className="px-5 py-3.5">
                            <Link
                              to={`/superadmin/exams/${e.id}`}
                              className="font-mono text-xs text-indigo-700 hover:underline tabular-nums"
                            >
                              {e.exam_code}
                            </Link>
                          </td>
                          <td className="px-5 py-3.5 font-medium text-slate-900">{e.name}</td>
                          <td className="px-5 py-3.5 text-xs text-slate-600 tabular-nums whitespace-nowrap">
                            {dateRange(e.verification_from, e.verification_to)}
                          </td>
                          <td className="px-5 py-3.5 text-slate-700 tabular-nums">{e.candidate_count}</td>
                          <td className="px-5 py-3.5">
                            <div className="flex gap-1.5 flex-wrap">
                              {tab === 'archived' ? (
                                <>
                                  {e.closed && <Pill tone="amber" dot>Ended</Pill>}
                                  {isExpired && !e.closed && <Pill tone="amber" dot>Window Expired</Pill>}
                                  {e.visible ? <Pill tone="slate" dot>Listed</Pill> : <Pill tone="slate" dot>Unlisted</Pill>}
                                </>
                              ) : (
                                <>
                                  {ongoing && <Pill tone="emerald" dot>Live</Pill>}
                                  {!ongoing && !e.closed && <Pill tone="blue" dot>Upcoming</Pill>}
                                  {e.visible ? <Pill tone="emerald" dot>Listed</Pill> : <Pill tone="slate" dot>Unlisted</Pill>}
                                </>
                              )}
                            </div>
                          </td>
                          <td className="px-5 py-3.5">
                            <div className="flex justify-end gap-1.5">
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => onToggleVisibility(e.id)}
                                title={e.visible
                                  ? 'Remove from the catalog admins subscribe from (reversible)'
                                  : 'Add back to the catalog admins subscribe from'}
                              >
                                {e.visible ? 'Unlist' : 'List'}
                              </Button>
                              {e.closed ? (
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  onClick={() => onReopen(e.id)}
                                  title="Allow new verifications against this exam again"
                                >
                                  Reopen
                                </Button>
                              ) : (
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  onClick={() => askClose(e.id, e.name)}
                                  title="Stop accepting new verifications (existing data preserved, reversible)"
                                >
                                  End
                                </Button>
                              )}
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => askDeleteExam(e.id, e.name)}
                                title="Permanently delete — only allowed if no verifications reference this exam's candidates"
                                className="!text-rose-700 !border-rose-200 hover:!bg-rose-50 hover:!border-rose-300"
                              >
                                Delete
                              </Button>
                              <Link
                                to={`/superadmin/exams/${e.id}`}
                                className="inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-lg bg-stone-900 text-white hover:bg-stone-800 transition-colors"
                                title="Open this exam's detail page to upload CSVs, edit fields, and see verifications"
                              >
                                Manage
                                <Icon.ChevronRight className="h-3.5 w-3.5 ml-0.5" />
                              </Link>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
      </FadeIn>

      <ConfirmDialog
        open={!!dlg}
        onCancel={() => setDlg(null)}
        onConfirm={dlg?.onConfirm || (() => {})}
        title={dlg?.title}
        body={dlg?.body}
        confirmLabel={dlg?.confirmLabel}
        tone={dlg?.tone}
      />
    </SuperShell>
  )
}

// ── Reviewer portal panel ───────────────────────────────────────────
//
// Two responsibilities in one card:
//   1. Toggle whether this client shows up in the register form's
//      public dropdown (portal_enabled on the clients row).
//   2. Manage the reviewer users who log into /client/* to approve
//      or reject applications routed here.
//
// The plaintext password for a newly-created reviewer is echoed ONCE
// by the API and shown here with an obvious copy affordance — this
// account isn't in the operator plaintext table, so if the superadmin
// misses it, the only remedy is to delete + recreate the reviewer.

// KYCReviewModePanel — inline editor for who reviews KYC applications
// routed to this client. Lives above the reviewer-portal panel because
// its setting decides whether a client reviewer will EVER see an app;
// having reviewers configured while mode='admin' is a valid but
// intentional state (the reviewer just won't receive routed apps).
function KYCReviewModePanel({ client, onChanged }) {
  const initial = client.kyc_review_mode || 'admin'
  const [mode, setMode] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [editing, setEditing] = useState(false)
  useEffect(() => { setMode(client.kyc_review_mode || 'admin') }, [client.kyc_review_mode])

  async function onSave() {
    setSaving(true)
    setErr('')
    try {
      await patchClient(client.id, { kyc_review_mode: mode })
      await onChanged?.()
      setEditing(false)
    } catch (e) {
      setErr(e?.body?.error || e?.message || 'Could not update')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mb-6 rounded-xl bg-warm-surface ring-1 ring-warm overflow-hidden">
      <div className="p-5 sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-900">KYC review routing</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Who approves new institution registrations tied to <span className="font-medium text-slate-700">{client.name}</span>.
            </p>
          </div>
          {!editing && (
            <div className="flex items-center gap-2 shrink-0">
              <KYCReviewModePill mode={initial} />
              <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>Change</Button>
            </div>
          )}
        </div>
        {editing && (
          <div className="mt-4 space-y-3">
            <KYCReviewModePicker value={mode} onChange={setMode} />
            {err && (
              <p className="text-xs text-rose-600">{err}</p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => { setMode(initial); setEditing(false); setErr('') }}>
                Cancel
              </Button>
              <Button size="sm" onClick={onSave} disabled={saving || mode === initial}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ReviewPortalPanel({ client, onChanged }) {
  const [portalOn, setPortalOn] = useState(!!client.portal_enabled)
  const [toggling, setToggling] = useState(false)
  const [reviewers, setReviewers] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  // Plaintext echo for the reviewer just created — cleared on the next
  // action so it never lingers past the moment the superadmin needs it.
  const [freshCred, setFreshCred] = useState(null)
  const [confirm, setConfirm] = useState(null)

  useEffect(() => { setPortalOn(!!client.portal_enabled) }, [client.portal_enabled])

  const load = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      const rows = await listClientReviewers(client.id)
      setReviewers(rows || [])
    } catch (e) {
      setErr(e.message || 'Could not load reviewers')
    } finally {
      setLoading(false)
    }
  }, [client.id])

  useEffect(() => { load() }, [load])

  async function onToggle() {
    setToggling(true)
    setErr('')
    const next = !portalOn
    // Optimistic — flip immediately so the switch feels tactile; roll
    // back on failure. Skipping this made the click read as "did the
    // click even land?" during the network round-trip.
    setPortalOn(next)
    try {
      await setClientPortal(client.id, next)
      await onChanged?.()
    } catch (e) {
      setPortalOn(!next)
      setErr(e.message || 'Could not update portal setting')
    } finally {
      setToggling(false)
    }
  }

  async function onCreated(row) {
    setFreshCred({ username: row.username, password: row.password })
    setShowAdd(false)
    await load()
  }

  function askDelete(row) {
    setConfirm({
      title:        `Remove reviewer "${row.username}"?`,
      body:         `${row.display_name} will no longer be able to sign in and review applications for ${client.name}. Existing decisions they made are preserved.`,
      confirmLabel: 'Remove reviewer',
      tone:         'danger',
      onConfirm:    async () => {
        try {
          await deleteClientReviewer(client.id, row.id)
          setConfirm(null)
          await load()
        } catch (e) {
          setErr(e.message || 'Could not remove reviewer')
          setConfirm(null)
        }
      },
    })
  }

  return (
    <>
      <div className="mb-8 rounded-xl bg-white ring-1 ring-warm overflow-hidden">
        {/* Header row — inline toggle so the primary decision is visible
            before you scroll into reviewer details. */}
        <div className="px-5 sm:px-6 py-4 flex items-start justify-between gap-4 border-b border-slate-100">
          <div className="flex items-start gap-3 min-w-0">
            <div className="h-10 w-10 rounded-xl bg-stone-100 text-stone-800 flex items-center justify-center shrink-0">
              <Icon.ShieldCheck className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-slate-900">Review portal</h2>
              <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                Off by default — the platform's onboarding team reviews every KYC.
                Turn it <span className="font-semibold text-stone-900">on</span> to
                let <span className="font-semibold text-stone-900">{client.name}</span> appear
                in the register form's exam-board dropdown, route new applications
                to reviewer accounts you create below, and let those reviewers sign
                in at <a href="/reviewer/login" className="font-mono text-stone-800 underline">/reviewer/login</a> to
                approve or reject KYC without needing superadmin access.
                Turning it off closes the whole surface: reviewers can't sign in
                and can't approve or reject even with an already-valid session.
                Applications already in the queue stay visible to superadmin.
              </p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <PortalToggle on={portalOn} onToggle={onToggle} disabled={toggling} />
            <span
              className={
                'text-[11px] font-semibold uppercase tracking-wider ' +
                (portalOn ? 'text-emerald-700' : 'text-slate-500')
              }
            >
              {toggling ? 'Saving…' : portalOn ? 'Enabled' : 'Disabled'}
            </span>
          </div>
        </div>

        {err && (
          <div role="alert" className="mx-5 sm:mx-6 mt-4 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-700">
            {err}
          </div>
        )}

        <div className="px-5 sm:px-6 py-5">
          <div className="flex items-baseline justify-between gap-2 mb-3">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Reviewer accounts</p>
              <p className="text-xs text-slate-500 mt-0.5">
                {loading ? 'Loading…' : `${reviewers.length} / 1 account assigned`}
              </p>
            </div>
            {reviewers.length === 0 ? (
              <Button size="sm" onClick={() => setShowAdd((v) => !v)}>
                <Icon.Plus className="h-3.5 w-3.5 mr-1" />
                {showAdd ? 'Cancel' : 'Add reviewer'}
              </Button>
            ) : (
              <span className="text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-md inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-600" />
                1 / 1 Reviewer Configured
              </span>
            )}
          </div>

          {freshCred && (
            <FreshCredentialBanner
              username={freshCred.username}
              password={freshCred.password}
              onDismiss={() => setFreshCred(null)}
            />
          )}

          <AnimatePresence initial={false}>
            {showAdd && (
              <motion.div
                initial={{ opacity: 0, y: -6, height: 0 }}
                animate={{ opacity: 1, y: 0, height: 'auto' }}
                exit={{ opacity: 0, y: -6, height: 0 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                className="overflow-hidden"
              >
                <AddReviewerForm
                  clientId={client.id}
                  onCancel={() => setShowAdd(false)}
                  onCreated={onCreated}
                />
              </motion.div>
            )}
          </AnimatePresence>

          {!loading && reviewers.length === 0 && !showAdd && (
            <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/60 px-4 py-6 text-center">
              <p className="text-sm text-slate-600">No reviewers yet.</p>
              <p className="text-xs text-slate-500 mt-1">
                Add at least one so this client can act on the applications it receives.
              </p>
            </div>
          )}

          {reviewers.length > 0 && (
            <div className="overflow-x-auto rounded-lg ring-1 ring-slate-200">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50/70 text-left text-[11px] uppercase tracking-wider text-slate-500">
                    <th className="px-4 py-2.5">Username</th>
                    <th className="px-4 py-2.5">Display name</th>
                    <th className="px-4 py-2.5">Email</th>
                    <th className="px-4 py-2.5">Added</th>
                    <th className="px-4 py-2.5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {reviewers.map((rv) => (
                    <tr key={rv.id} className="border-t border-slate-100">
                      <td className="px-4 py-2.5 font-mono text-xs text-slate-900">{rv.username}</td>
                      <td className="px-4 py-2.5 text-slate-800">{rv.display_name}</td>
                      <td className="px-4 py-2.5 text-slate-600">{rv.email || <span className="text-slate-400">—</span>}</td>
                      <td className="px-4 py-2.5 text-xs text-slate-500 tabular-nums whitespace-nowrap">
                        {formatShortDate(rv.created_at)}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => askDelete(rv)}
                          className="!text-rose-700 !border-rose-200 hover:!bg-rose-50 hover:!border-rose-300"
                        >
                          Remove
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={!!confirm}
        onCancel={() => setConfirm(null)}
        onConfirm={confirm?.onConfirm || (() => {})}
        title={confirm?.title}
        body={confirm?.body}
        confirmLabel={confirm?.confirmLabel}
        tone={confirm?.tone}
      />
    </>
  )
}

// Small toggle switch. Kept local — the shell doesn't have a shared
// switch primitive yet, and this is the only place it's used.
function PortalToggle({ on, onToggle, disabled }) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onToggle}
      aria-pressed={on}
      className={
        'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full ring-1 transition-colors focus:outline-none focus:ring-2 focus:ring-stone-400 focus:ring-offset-1 ' +
        (on
          ? 'bg-emerald-600 ring-emerald-700'
          : 'bg-slate-200 ring-slate-300 hover:bg-slate-300') +
        (disabled ? ' opacity-60 cursor-wait' : ' cursor-pointer')
      }
      title={on ? 'Enabled — this client shows up on the register form' : 'Disabled — hidden from the register form'}
    >
      <span
        className={
          'inline-block h-5 w-5 rounded-full bg-white shadow-md transform transition-transform duration-150 ease-out ' +
          (on ? 'translate-x-6' : 'translate-x-1')
        }
      />
      <span className="sr-only">{on ? 'Disable portal' : 'Enable portal'}</span>
    </button>
  )
}

function AddReviewerForm({ clientId, onCancel, onCreated }) {
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    setErr('')
    try {
      const row = await createClientReviewer(clientId, {
        username: username.trim(),
        display_name: displayName.trim(),
        email: email.trim(),
        password,
      })
      onCreated(row)
    } catch (ex) {
      setErr(ex.message || 'Could not create reviewer')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      className="mb-4 rounded-lg border border-slate-200 bg-slate-50/60 p-4"
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <Label>Username <span className="text-rose-600">*</span></Label>
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="nta_reviewer_1"
            autoComplete="off"
            required
          />
        </div>
        <div>
          <Label>Display name <span className="text-rose-600">*</span></Label>
          <Input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="NTA Onboarding Team"
            required
          />
        </div>
        <div>
          <Label>Email</Label>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="onboarding@nta.ac.in"
            autoComplete="off"
          />
        </div>
        <div>
          <Label>Password <span className="text-rose-600">*</span></Label>
          <Input
            type="text"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 8 characters"
            autoComplete="new-password"
            required
          />
          <p className="text-[11px] text-slate-500 mt-1">
            Shown once after creation so you can hand it over. Not retrievable later.
          </p>
        </div>
      </div>
      {err && (
        <div role="alert" className="mt-3 rounded-md bg-rose-50 border border-rose-200 px-3 py-1.5 text-xs text-rose-700">
          {err}
        </div>
      )}
      <div className="mt-4 flex items-center justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? 'Creating…' : 'Create reviewer'}
        </Button>
      </div>
    </form>
  )
}

function FreshCredentialBanner({ username, password, onDismiss }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    try {
      navigator.clipboard.writeText(`Username: ${username}\nPassword: ${password}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {}
  }
  return (
    <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider text-amber-800">
            Save this now
          </p>
          <p className="text-xs text-amber-900 mt-1">
            This password is shown once. Hand it to the reviewer before dismissing.
          </p>
          <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
            <div className="rounded-md bg-white ring-1 ring-amber-200 px-3 py-2">
              <p className="text-[10px] uppercase tracking-wider text-slate-500">Username</p>
              <p className="font-mono text-slate-900 mt-0.5 truncate">{username}</p>
            </div>
            <div className="rounded-md bg-white ring-1 ring-amber-200 px-3 py-2">
              <p className="text-[10px] uppercase tracking-wider text-slate-500">Password</p>
              <p className="font-mono text-slate-900 mt-0.5 truncate">{password}</p>
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-1.5 shrink-0">
          <Button size="sm" onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button size="sm" variant="secondary" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </div>
    </div>
  )
}

function formatShortDate(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
    })
  } catch {
    return String(iso).slice(0, 10)
  }
}

function EmptyExams({ onCreate }) {
  return (
    <div className="p-14 text-center">
      <div className="mx-auto h-14 w-14 rounded-2xl bg-slate-100 text-slate-400 flex items-center justify-center mb-4">
        <Icon.FileText className="h-7 w-7" />
      </div>
      <h3 className="text-base font-semibold text-slate-900">No exams under this client yet</h3>
      <p className="text-sm text-slate-500 mt-1 max-w-sm mx-auto">
        Add an exam with its code and verification window. Candidates come
        later, from the exam page.
      </p>
      <Button className="mt-5" onClick={onCreate}>
        <Icon.Plus className="h-4 w-4 mr-1.5" />
        New exam
      </Button>
    </div>
  )
}

// ── Create-exam form ─────────────────────────────────────────────────
// Broken into three visual sections so a first-time user reads it as a
// short story rather than a wall of fields:
//   1. Identity           — what the exam is called
//   2. Verification window — when it's active
//   3. Candidate data     — hint only; the roster + centres CSVs both
//                           get uploaded from the exam page once the
//                           exam exists (one place to do it, one place
//                           to see validation errors + upload history).
//                           The create endpoint is JSON-only and never
//                           accepted a file. TrustView reference was
//                           removed (integration still pending).

function NewExamForm({ clientId, onCancel, onCreated }) {
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [reqFace, setReqFace] = useState(true)
  const [reqFP,   setReqFP]   = useState(true)
  const [reqIris, setReqIris] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  async function onSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setErr('')
    try {
      if (!reqFace && !reqFP && !reqIris) {
        setErr('Pick at least one biometric to require for this exam.')
        setSaving(false)
        return
      }
      const { id: examId } = await createExam(clientId, {
        name: name.trim(),
        exam_code: code.trim(),
        verification_from: from,
        verification_to: to,
        requires_face: reqFace,
        requires_fp: reqFP,
        requires_iris: reqIris,
      })
      onCreated(examId)
    } catch (e) {
      setErr(e.message || 'Could not create exam. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  const canSubmit = name.trim() && code.trim() && from && to && (reqFace || reqFP || reqIris)

  return (
    <div className="mb-6 rounded-xl bg-warm-surface ring-1 ring-warm shadow-sm overflow-hidden">
      <div className="h-1 bg-stone-900" />
      <div className="p-5 sm:p-6">
        <div className="flex items-start gap-3 mb-6">
          <div className="h-9 w-9 rounded-lg bg-stone-100 text-stone-800 flex items-center justify-center shrink-0">
            <Icon.FileText className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-slate-900">New exam</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Add an exam under this client. Upload the candidate roster from the
              exam page once it exists.
            </p>
          </div>
        </div>

        <form onSubmit={onSubmit} className="space-y-6">
          {/* Section 1 — identity */}
          <FormSection num="1" title="Identity" hint="What the exam is called and its unique code.">
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_240px] gap-4">
              <div>
                <Label>Name <span className="text-rose-500">*</span></Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. UPSC Civil Services 2026"
                  maxLength={200}
                  required
                  autoFocus
                />
              </div>
              <div>
                <Label>Exam code <span className="text-rose-500">*</span></Label>
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  placeholder="EXAM-2026-01"
                  maxLength={60}
                  required
                  className="font-mono uppercase tracking-wide"
                />
                <p className="text-[11px] text-slate-500 mt-1">Globally unique. Uppercase, no spaces.</p>
              </div>
            </div>
          </FormSection>

          {/* Section 2 — window */}
          <FormSection num="2" title="Verification window" hint="Colleges can only verify candidates for this exam inside this date & time range.">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label>From (date & time) <span className="text-rose-500">*</span></Label>
                <Input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} required />
              </div>
              <div>
                <Label>To (date & time) <span className="text-rose-500">*</span></Label>
                <Input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} required min={from || undefined} />
              </div>
            </div>
          </FormSection>

          {/* Section 3 — biometric requirements */}
          <FormSection num="3" title="Biometrics" hint="Which biometrics the verification agent must capture for a candidate to be verified. At least one required.">
            <div className="flex flex-wrap gap-4">
              <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={reqFace} onChange={(e) => setReqFace(e.target.checked)} />
                Face
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={reqFP} onChange={(e) => setReqFP(e.target.checked)} />
                Fingerprint
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={reqIris} onChange={(e) => setReqIris(e.target.checked)} />
                Iris
              </label>
            </div>
          </FormSection>

          {/* Section 4 — candidate data.
              Deliberately no form field. Uploads live on the exam page. */}
          <FormSection num="4" title="Candidate data" hint="Uploaded from the exam page after the exam is created.">
            <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2.5 text-xs text-slate-600">
              After creating this exam, open it to upload the candidate roster
              (name, roll_no + optional extras) and the centres CSV. Validation
              errors and upload history live there too.
            </div>
          </FormSection>

          {err && (
            <div role="alert" className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
              {err}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-4 border-t border-slate-100">
            <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
            <Button type="submit" disabled={saving || !canSubmit}>
              {saving ? 'Saving…' : 'Create exam'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}

// FormSection — numbered section with a colored side rule so the eye
// naturally tracks progress down the form.
function FormSection({ num, title, hint, children }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[180px_1fr] gap-x-6 gap-y-3">
      <div className="flex items-start gap-2.5 pt-1">
        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white text-[10px] font-semibold tabular-nums">
          {num}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900 leading-tight">{title}</p>
          {hint && <p className="text-[11px] text-slate-500 mt-0.5 leading-snug">{hint}</p>}
        </div>
      </div>
      <div>{children}</div>
    </div>
  )
}

