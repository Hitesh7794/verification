import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import SuperShell, { PageHead } from '../../components/shell/SuperShell.jsx'
import {
  Button,
  Card,
  CardBody,
  Input,
  Label,
} from '../../components/ui/ui.jsx'
import { Icon, Pill, Skeleton } from '../../components/ui/extras.jsx'
import { FadeIn } from '../../components/ui/motion.jsx'
import {
  listClients,
  createClient,
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
  const [newKycMode, setNewKycMode] = useState('admin') // 'admin' | 'client' | 'both'
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
      await createClient({ name: newName.trim(), notes: newNotes.trim(), kyc_review_mode: newKycMode })
      setNewName('')
      setNewNotes('')
      setNewKycMode('admin')
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

  const onClose = (c) =>
    runRowAction(c.id, () => closeClient(c.id), `Could not close "${c.name}".`)

  const onReopen = (c) =>
    runRowAction(c.id, () => reopenClient(c.id), `Could not reopen "${c.name}".`)

  // Small at-a-glance stats above the table. 'Active' = not-ended
  // (the Listed/Unlisted split is retired since admins no longer
  // browse a client dropdown).
  const totalClients = clients.length
  const activeClients = clients.filter(c => !c.closed).length
  const totalExams = clients.reduce((s, c) => s + (c.exam_count || 0), 0)

  return (
    <SuperShell>
      <FadeIn>
        <PageHead
          eyebrow="Directory"
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
            <StatChip label="Active" value={activeClients} tone="emerald" />
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
              <div className="mb-6 rounded-xl bg-warm-surface ring-1 ring-warm shadow-sm overflow-hidden">
                <div className="h-1 bg-stone-900" />
                <div className="p-5 sm:p-6">
                  <div className="flex items-start gap-3 mb-5">
                    <div className="h-9 w-9 rounded-lg bg-stone-100 text-stone-800 flex items-center justify-center shrink-0">
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
                    <div className="pt-2">
                      <Label>KYC review by <span className="text-rose-500">*</span></Label>
                      <p className="text-[11px] text-slate-500 mt-0.5 mb-2">
                        Who approves institution registrations tied to this client.
                      </p>
                      <KYCReviewModePicker
                        value={newKycMode}
                        onChange={setNewKycMode}
                        clientName={newName.trim() || 'Client reviewer'}
                      />
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
                            {c.closed && <Pill tone="amber" dot>Ended</Pill>}
                            <KYCReviewModePill mode={c.kyc_review_mode || 'admin'} clientName={c.name} />
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
                            <div className="flex justify-end gap-1.5">
                              {c.closed ? (
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  disabled={busyId === c.id}
                                  onClick={() => onReopen(c)}
                                  title="Allow new activity under this client again"
                                >
                                  Reopen
                                </Button>
                              ) : (
                                <Button
                                  variant="secondary"
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
                                className="inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-lg bg-stone-900 text-white hover:bg-stone-800 transition-colors"
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
    </SuperShell>
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

// Platform brand shown on the left checkbox. Constant on purpose — this
// is the "us" side of the picker, not a per-client value.
const PLATFORM_BRAND = 'Innovatiview'

// KYCReviewModePicker — two-checkbox surface for who reviews KYC apps
// for this client. Left box: the platform (Innovatiview). Right box:
// the client's own reviewer, labelled with the client's actual name
// (e.g. "NTA"). Both checked = the previous 'both' mode (superadmin
// approves first, then the client reviewer finalises).
//
// The picker maps to the same kyc_review_mode enum values the backend
// already understands: 'admin' | 'client' | 'both'. At least one box
// must stay ticked — un-ticking both would leave nobody to review KYC.
export function KYCReviewModePicker({ value, onChange, clientName }) {
  const adminChecked  = value === 'admin'  || value === 'both'
  const clientChecked = value === 'client' || value === 'both'
  const rightLabel = (clientName || '').trim() || 'Client reviewer'

  const toggle = (which) => {
    let nextAdmin  = adminChecked
    let nextClient = clientChecked
    if (which === 'admin')  nextAdmin  = !adminChecked
    if (which === 'client') nextClient = !clientChecked
    // Guard: at least one box has to remain ticked. If the user tries
    // to untick the last one, ignore the change and keep the current
    // mode — leaving nobody assigned would strand every incoming KYC.
    if (!nextAdmin && !nextClient) return
    const nextMode = nextAdmin && nextClient ? 'both'
      : nextAdmin ? 'admin'
      : 'client'
    onChange(nextMode)
  }

  const boxes = [
    { key: 'admin',  label: PLATFORM_BRAND, checked: adminChecked  },
    { key: 'client', label: rightLabel,     checked: clientChecked },
  ]

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      {boxes.map((b) => (
        <label
          key={b.key}
          className={`flex items-center gap-3 rounded-lg border px-3.5 py-3 cursor-pointer transition-colors ${
            b.checked
              ? 'border-stone-900 bg-stone-50 ring-1 ring-stone-900/10'
              : 'border-slate-200 bg-white hover:border-slate-300'
          }`}
        >
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-slate-400 text-stone-900 focus:ring-stone-500"
            checked={b.checked}
            onChange={() => toggle(b.key)}
          />
          <span className="text-sm font-medium text-slate-900">{b.label}</span>
        </label>
      ))}
      <p className="col-span-1 sm:col-span-2 text-[11px] text-slate-500">
        Both ticked → {PLATFORM_BRAND} approves first, then {rightLabel}. At least one must stay ticked.
      </p>
    </div>
  )
}

// KYCReviewModePill — compact badge used in the clients table. Labels
// mirror the picker's checkbox naming (platform brand + client name)
// so the reader doesn't have to translate 'admin'/'client'/'both'.
export function KYCReviewModePill({ mode, clientName }) {
  const rightLabel = (clientName || '').trim() || 'Client'
  const label = mode === 'both' ? `${PLATFORM_BRAND} + ${rightLabel}`
    : mode === 'client' ? rightLabel
    : PLATFORM_BRAND
  const tone = mode === 'both' ? 'indigo'
    : mode === 'client' ? 'emerald'
    : 'slate'
  return <Pill tone={tone}>Review: {label}</Pill>
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
