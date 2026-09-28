import BoardMark from '../../components/fv/BoardMark.jsx'
import { ArtBoard } from '../../components/fv/FvArt.jsx'
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
  const [newApiUrl, setNewApiUrl] = useState('')
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
    if (!newName.trim() || !newApiUrl.trim()) return
    setSaving(true)
    setErr('')
    try {
      await createClient({
        name: newName.trim(),
        notes: newNotes.trim(),
        api_url: newApiUrl.trim(),
        kyc_review_mode: newKycMode,
      })
      setNewName('')
      setNewNotes('')
      setNewApiUrl('')
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
  const totalExams = clients.reduce((s, c) => s + (Number(c.active_exam_count ?? c.exam_count) || 0), 0)

  return (
    <SuperShell>
      <FadeIn>
        <PageHead
          eyebrow="Directory"
          title="Clients" art={ArtBoard}
          subtitle="Exam-conducting bodies. Each client owns its exams."
          right={
            <Button onClick={() => setCreating(v => !v)}>
              {creating
                ? <Icon.X className="h-4 w-4 mr-1.5" />
                : <Icon.Plus className="h-4 w-4 mr-1.5" />}
              {creating ? 'Cancel' : 'New client'}
            </Button>
          }
        />

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
                <div className="h-[3px] rule-gold" />
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
                    <div>
                      {/* Required by CP — this row's api_url is what the
                          Control Plane calls when it needs to reach the
                          client's Data Plane (KYC handoff, exam sync). */}
                      <Label>Data Plane API URL <span className="text-rose-500">*</span></Label>
                      <Input
                        type="url"
                        value={newApiUrl}
                        onChange={(e) => setNewApiUrl(e.target.value)}
                        placeholder="https://ssc.verifyportal.example.com"
                        required
                      />
                      <p className="text-[11px] text-slate-500 mt-1">
                        Base URL of this client's Data Plane. No trailing slash needed.
                      </p>
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
                      <Button type="button" variant="ghost" onClick={() => { setCreating(false); setNewName(''); setNewNotes(''); setNewApiUrl('') }}>
                        Cancel
                      </Button>
                      <Button type="submit" disabled={saving || !newName.trim() || !newApiUrl.trim()}>
                        {saving ? 'Creating…' : 'Create client'}
                      </Button>
                    </div>
                  </form>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {loading ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((k) => (
              <div key={k} className="h-[190px] animate-pulse rounded-[16px] border border-fv-line bg-fv-card" />
            ))}
          </div>
        ) : clients.length === 0 ? (
          <EmptyClients onCreate={() => setCreating(true)} />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {clients.map((c) => (
              <ClientCard
                key={c.id}
                c={c}
                busy={busyId === c.id}
                confirming={confirmingId === c.id}
                onAskEnd={() => setConfirmingId(c.id)}
                onCancelEnd={() => setConfirmingId(null)}
                onEnd={() => onClose(c)}
                onReopen={() => onReopen(c)}
              />
            ))}
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex min-h-[190px] cursor-pointer flex-col items-center justify-center gap-2 rounded-[16px] border-2 border-dashed border-fv-line bg-transparent text-fv-faint transition hover:border-fv-accent-soft hover:bg-fv-card-focus hover:text-fv-accent-deep"
            >
              <span className="grid h-11 w-11 place-items-center rounded-full border-2 border-current text-[22px] font-bold leading-none">+</span>
              <span className="text-[14.5px] font-bold">
                Add a client <span className="fv-hi font-bold">नया क्लाइंट</span>
              </span>
            </button>
          </div>
        )}

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
    // Nobody assigned would strand every incoming KYC, so untick-the-
    // only-box means "switch to the other one" rather than "nothing
    // happens". Previous behaviour silently swallowed the click and
    // the operator got no visual response — they'd click Save/Create
    // and the mode would revert to admin because that's still what
    // was ticked.
    if (!nextAdmin && !nextClient) {
      if (which === 'admin') nextClient = true
      else nextAdmin = true
    }
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

// ── One client ─────────────────────────────────────────────────
// A client is an exam body: it owns exams, it routes its own KYC, and
// it can be ended without losing anything. The card carries those three
// facts and nothing else; the detail page has the rest.
function ClientCard({ c, busy, confirming, onAskEnd, onCancelEnd, onEnd, onReopen }) {
  const active = Number(c.active_exam_count ?? c.exam_count) || 0
  const totalExams = Number(c.exam_count) || 0
  return (
    <div className={`relative flex flex-col overflow-hidden rounded-[16px] border bg-fv-card transition ${
      c.closed ? 'border-[#EDD9B8]' : 'border-fv-line hover:border-fv-accent-soft'
    }`}>
      {c.closed && <span aria-hidden="true" className="absolute inset-x-0 top-0 h-[3px] bg-[#E4A54B]" />}

      <Link to={`/superadmin/clients/${c.id}`} className="group block px-5 pb-4 pt-5">
        <BoardMark name={c.name} nameClass="fv-display text-[17px] font-bold leading-tight group-hover:text-fv-accent-deep" />
        <p className="mt-1.5 line-clamp-2 min-h-[34px] text-[13px] font-semibold leading-snug text-fv-muted">
          {c.notes || 'No note on this client.'}
        </p>
      </Link>

      <div className="mx-5 grid grid-cols-2 gap-3 border-t border-fv-line py-3">
        <span className="leading-tight">
          <span className="block text-[12.5px] font-bold text-fv-faint">
            Exams <span className="fv-hi font-bold">परीक्षाएँ</span>
          </span>
          <span className="block text-[15px] font-bold tabular-nums text-fv-ink">
            {active === totalExams ? totalExams : <>{active} <span className="text-fv-faint">of {totalExams}</span></>}
            {active !== totalExams && <span className="ml-1 text-[12.5px] font-bold text-fv-faint">running</span>}
          </span>
        </span>
        <span className="leading-tight">
          <span className="block text-[12.5px] font-bold text-fv-faint">
            KYC seen by <span className="fv-hi font-bold">जाँच</span>
          </span>
          <span className="block truncate text-[15px] font-bold text-fv-ink">
            {reviewedBy(c.kyc_review_mode || 'admin', c.name)}
          </span>
        </span>
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 border-t border-fv-line bg-fv-page px-5 py-2.5">
        {confirming ? (
          <>
            <span className="text-[13px] font-bold text-fv-ink">End this client?</span>
            <span className="flex gap-1.5">
              <button type="button" disabled={busy} onClick={onEnd}
                      className="cursor-pointer rounded-[9px] bg-[#A8711F] px-2.5 py-1 text-[13px] font-bold text-white disabled:opacity-50">
                {busy ? 'Ending…' : 'Yes, end it'}
              </button>
              <button type="button" disabled={busy} onClick={onCancelEnd}
                      className="cursor-pointer rounded-[9px] border border-fv-line bg-white px-2.5 py-1 text-[13px] font-bold text-fv-muted">
                Keep
              </button>
            </span>
          </>
        ) : (
          <>
            <span className="text-[12.5px] font-bold text-fv-faint">
              {c.closed ? 'Ended' : 'Since'}{' '}
              <span className="tabular-nums">
                {c.created_at ? new Date(c.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}
              </span>
            </span>
            <span className="flex items-center gap-1.5">
              {c.closed ? (
                <button type="button" disabled={busy} onClick={onReopen}
                        className="cursor-pointer rounded-[9px] border border-fv-line bg-white px-2.5 py-1 text-[13px] font-bold text-fv-ink transition hover:bg-fv-card disabled:opacity-50">
                  Reopen
                </button>
              ) : (
                <button type="button" disabled={busy} onClick={onAskEnd}
                        className="cursor-pointer rounded-[9px] px-2 py-1 text-[13px] font-bold text-fv-faint transition hover:text-[#8A5A14] disabled:opacity-50">
                  End
                </button>
              )}
              <Link to={`/superadmin/clients/${c.id}`}
                    className="inline-flex items-center gap-1 rounded-[9px] bg-fv-accent px-3 py-1.5 text-[13.5px] font-bold text-white transition hover:bg-fv-accent-deep">
                Manage <span aria-hidden="true">›</span>
              </Link>
            </span>
          </>
        )}
      </div>
    </div>
  )
}

// Who sees this client's registrations first.
function reviewedBy(mode, clientName) {
  const them = (clientName || '').trim() || 'the client'
  if (mode === 'both') return `${PLATFORM_BRAND}, then ${them}`
  if (mode === 'client') return them
  return PLATFORM_BRAND
}

// KYCReviewModePill — the same fact as reviewedBy(), as a badge. Used
// on the client detail page.
export function KYCReviewModePill({ mode, clientName }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-fv-card-focus px-2.5 py-1 text-[13px] font-bold text-fv-accent-deep ring-1 ring-fv-accent-soft">
      Reviewed by {reviewedBy(mode, clientName)}
    </span>
  )
}
