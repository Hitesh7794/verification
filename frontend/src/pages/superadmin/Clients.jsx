import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import AppShell from '../../components/shell/AppShell.jsx'
import SuperTabs from '../../components/shell/SuperTabs.jsx'
import {
  Button,
  Card,
  CardBody,
  Input,
  Label,
  PageHeader,
} from '../../components/ui/ui.jsx'
import { Icon, Pill, Skeleton } from '../../components/ui/extras.jsx'
import { FadeIn } from '../../components/ui/motion.jsx'
import {
  listClients,
  createClient,
  toggleClientVisibility,
  closeClient,
  reopenClient,
} from '../../lib/superadmin/examCatalog.js'

// Superadmin > Clients — the top-level exam-body catalog.
// A client is the conducting authority (UP Govt, NTA); it owns exams.
// Every row has inline List/Unlist + End/Reopen buttons (no modals).
export default function Clients() {
  const [clients, setClients] = useState([])
  // `loading` drives the first paint only. Row actions re-fetch through
  // refresh({quiet:true}) so the table never swaps itself out mid-click.
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newNotes, setNewNotes] = useState('')
  const [saving, setSaving] = useState(false)
  // id of the row with a request in flight — disables that row's buttons
  // so a double-click can't fire the same toggle twice.
  const [busyId, setBusyId] = useState(null)
  // id of the row currently showing its inline "Close?" confirmation.
  const [confirmingId, setConfirmingId] = useState(null)

  const refresh = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true)
    setErr('')
    try {
      setClients(await listClients())
    } catch (e) {
      setErr(errText(e, 'Could not load clients.'))
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  async function onCreate(e) {
    e.preventDefault()
    if (!newName.trim()) return
    setSaving(true)
    setErr('')
    try {
      await createClient({ name: newName.trim(), notes: newNotes.trim() })
      setNewName('')
      setNewNotes('')
      setCreating(false)
      await refresh({ quiet: true })
    } catch (e) {
      setErr(errText(e, 'Could not create the client.'))
    } finally {
      setSaving(false)
    }
  }

  // Every row action funnels through here: marks the row busy, reports
  // failures in the page banner, and always clears the busy flag.
  // Previously toggle/close/reopen had no error handling at all — a
  // failed request became an unhandled rejection, the row silently
  // didn't move, and it read as "the button is broken".
  async function runRowAction(id, fn, fallbackMsg) {
    setBusyId(id)
    setErr('')
    try {
      await fn()
      await refresh({ quiet: true })
    } catch (e) {
      setErr(errText(e, fallbackMsg))
    } finally {
      setBusyId(null)
      setConfirmingId(null)
    }
  }

  const onToggleVisibility = (c) =>
    runRowAction(
      c.id,
      () => toggleClientVisibility(c.id),
      `Could not ${c.visible ? 'hide' : 'show'} "${c.name}".`,
    )

  const onClose = (c) =>
    runRowAction(c.id, () => closeClient(c.id), `Could not close "${c.name}".`)

  const onReopen = (c) =>
    runRowAction(c.id, () => reopenClient(c.id), `Could not reopen "${c.name}".`)

  // Small at-a-glance stats above the table, so the page has a header
  // that reads as a dashboard rather than just a create-button + list.
  const totalClients = clients.length
  const visibleClients = clients.filter(c => c.visible && !c.closed).length
  const totalExams = clients.reduce((s, c) => s + (c.exam_count || 0), 0)

  return (
    <AppShell>
      <SuperTabs />
      <FadeIn>
        <PageHeader
          title="Clients"
          subtitle="Exam-conducting bodies. Each client owns its exams."
          right={
            <Button onClick={() => setCreating(v => !v)}>
              <Icon.Plus className="h-4 w-4 mr-1.5" />
              {creating ? 'Cancel' : 'New client'}
            </Button>
          }
        />

        {/* Stats strip — three quick counts so the page has more
            information density than a bare table. */}
        {!loading && totalClients > 0 && (
          <div className="grid grid-cols-3 gap-3 mb-6">
            <StatChip label="Clients" value={totalClients} />
            <StatChip label="Listed + active" value={visibleClients} tone="emerald" />
            <StatChip label="Exams under them" value={totalExams} tone="indigo" />
          </div>
        )}

        {err && (
          <div role="alert" className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
            {err}
          </div>
        )}

        {/* Creation panel — slides down from under the toolbar with a
            small motion cue. Accent bar at the top makes it read as
            "this is what you're doing right now" without shouting. */}
        <AnimatePresence initial={false}>
          {creating && (
            <motion.div
              initial={{ opacity: 0, y: -8, height: 0 }}
              animate={{ opacity: 1, y: 0, height: 'auto' }}
              exit={{ opacity: 0, y: -8, height: 0 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              className="overflow-hidden"
            >
              <div className="mb-6 rounded-xl bg-white ring-1 ring-slate-200 shadow-sm overflow-hidden">
                <div className="h-1 bg-gradient-to-r from-indigo-500 via-violet-500 to-fuchsia-500" />
                <div className="p-5 sm:p-6">
                  <div className="flex items-start gap-3 mb-5">
                    <div className="h-9 w-9 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0">
                      <Icon.Building className="h-5 w-5" />
                    </div>
                    <div>
                      <h3 className="text-base font-semibold text-slate-900">New client</h3>
                      <p className="text-xs text-slate-500 mt-0.5">
                        An exam body (board, agency, ministry). No login, no wallet — just a container that owns exams.
                      </p>
                    </div>
                  </div>
                  <form onSubmit={onCreate} className="space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <Label>Name <span className="text-rose-500">*</span></Label>
                        <Input
                          value={newName}
                          onChange={(e) => setNewName(e.target.value)}
                          placeholder="e.g. National Testing Agency"
                          maxLength={200}
                          autoFocus
                          required
                        />
                        <p className="text-[11px] text-slate-500 mt-1">
                          Shown to college admins in the exam catalog.
                        </p>
                      </div>
                      <div>
                        <Label>Notes <span className="text-slate-400 font-normal">(optional)</span></Label>
                        <Input
                          value={newNotes}
                          onChange={(e) => setNewNotes(e.target.value)}
                          placeholder="Internal reference"
                          maxLength={200}
                        />
                        <p className="text-[11px] text-slate-500 mt-1">
                          Internal only — not visible to colleges.
                        </p>
                      </div>
                    </div>
                    <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                      <Button type="button" variant="ghost" onClick={() => { setCreating(false); setNewName(''); setNewNotes('') }}>
                        Cancel
                      </Button>
                      <Button type="submit" disabled={saving || !newName.trim()}>
                        {saving ? 'Creating…' : 'Create client'}
                      </Button>
                    </div>
                  </form>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <Card>
          <CardBody className="p-0">
            {loading ? (
              <TableSkeleton />
            ) : clients.length === 0 ? (
              <EmptyClients onCreate={() => setCreating(true)} />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wider text-slate-500 bg-slate-50/70">
                      <th className="px-5 py-3">Name</th>
                      <th className="px-5 py-3">Exams</th>
                      <th className="px-5 py-3">Status</th>
                      <th className="px-5 py-3">Created</th>
                      <th className="px-5 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {clients.map((c) => (
                      <tr key={c.id} className="border-b border-slate-100 last:border-none hover:bg-slate-50/60 transition-colors">
                        <td className="px-5 py-3.5">
                          <Link to={`/superadmin/clients/${c.id}`} className="font-medium text-slate-900 hover:text-indigo-700 hover:underline">
                            {c.name}
                          </Link>
                          {c.notes && <div className="text-xs text-slate-500 mt-0.5">{c.notes}</div>}
                        </td>
                        <td className="px-5 py-3.5 text-slate-700 tabular-nums">{c.exam_count}</td>
                        <td className="px-5 py-3.5">
                          <div className="flex gap-1.5 flex-wrap">
                            {c.visible
                              ? <Pill tone="emerald" dot>Listed</Pill>
                              : <Pill tone="slate" dot>Unlisted</Pill>}
                            {c.closed && <Pill tone="amber" dot>Ended</Pill>}
                          </div>
                        </td>
                        <td className="px-5 py-3.5 text-xs text-slate-500 tabular-nums">
                          {new Date(c.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                        </td>
                        <td className="px-5 py-3.5">
                          {confirmingId === c.id ? (
                            // Inline confirmation: swaps in place of the
                            // buttons rather than opening a dialog, which
                            // is what R5 ("no modal windows") asks for.
                            <div className="flex items-center justify-end gap-2">
                              <span className="text-xs text-slate-600 whitespace-nowrap">
                                End this client?
                              </span>
                              <Button
                                variant="danger"
                                size="sm"
                                disabled={busyId === c.id}
                                onClick={() => onClose(c)}
                              >
                                {busyId === c.id ? 'Ending…' : 'Confirm'}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busyId === c.id}
                                onClick={() => setConfirmingId(null)}
                              >
                                Cancel
                              </Button>
                            </div>
                          ) : (
                            <div className="flex justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busyId === c.id}
                                onClick={() => onToggleVisibility(c)}
                                title={c.visible
                                  ? 'Remove from the catalog admins subscribe from (reversible)'
                                  : 'Add back to the catalog admins subscribe from'}
                              >
                                {busyId === c.id ? '…' : c.visible ? 'Unlist' : 'List'}
                              </Button>
                              {c.closed ? (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={busyId === c.id}
                                  onClick={() => onReopen(c)}
                                  title="Allow new activity under this client again"
                                >
                                  Reopen
                                </Button>
                              ) : (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={busyId === c.id}
                                  onClick={() => setConfirmingId(c.id)}
                                  title="Stop accepting new activity under this client (existing data preserved, reversible)"
                                >
                                  End
                                </Button>
                              )}
                              <Link
                                to={`/superadmin/clients/${c.id}`}
                                className="inline-flex items-center px-2.5 py-1.5 text-xs font-medium rounded-md text-indigo-600 hover:bg-indigo-50 transition-colors"
                                title="Open this client's detail page to see and manage its exams"
                              >
                                Manage
                                <Icon.ChevronRight className="h-3.5 w-3.5 ml-0.5" />
                              </Link>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
      </FadeIn>
    </AppShell>
  )
}

// Turn an ApiError into something worth showing a human. The backend's
// `error` field is written for operators, so prefer it; fall back to a
// task-specific sentence. Deliberately does NOT surface the HTTP status
// — "(HTTP 500)" tells the superadmin nothing they can act on, and it's
// already in the network tab for whoever is debugging.
function errText(e, fallback) {
  return e?.body?.error || e?.message || fallback
}

// Placeholder rows echoing the real table's rhythm, so the swap from
// loading to loaded doesn't shift the layout.
function TableSkeleton({ rows = 4 }) {
  return (
    <div className="divide-y divide-slate-100">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4 px-5 py-4">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-4 w-8" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-24 ml-auto" />
        </div>
      ))}
    </div>
  )
}

// Small numeric summary chip for the top-of-page stats strip.
function StatChip({ label, value, tone = 'slate' }) {
  const tones = {
    slate: 'text-slate-900',
    emerald: 'text-emerald-700',
    indigo: 'text-indigo-700',
  }
  return (
    <div className="rounded-xl bg-white ring-1 ring-slate-200 px-4 py-3">
      <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">{label}</p>
      <p className={`text-2xl font-semibold tabular-nums mt-0.5 ${tones[tone] || tones.slate}`}>{value}</p>
    </div>
  )
}

// Empty state — friendlier than a plain "no clients yet" line.
function EmptyClients({ onCreate }) {
  return (
    <div className="p-14 text-center">
      <div className="mx-auto h-14 w-14 rounded-2xl bg-slate-100 text-slate-400 flex items-center justify-center mb-4">
        <Icon.Building className="h-7 w-7" />
      </div>
      <h3 className="text-base font-semibold text-slate-900">No clients yet</h3>
      <p className="text-sm text-slate-500 mt-1 max-w-sm mx-auto">
        A client is an exam body — the organisation that conducts an exam (UP Government, NTA, CBSE, etc.).
        Add one to start building its exam catalog.
      </p>
      <Button className="mt-5" onClick={onCreate}>
        <Icon.Plus className="h-4 w-4 mr-1.5" />
        Add your first client
      </Button>
    </div>
  )
}
