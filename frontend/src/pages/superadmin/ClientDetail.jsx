import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
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
import { Icon, Pill } from '../../components/ui/extras.jsx'
import { FadeIn } from '../../components/ui/motion.jsx'
import {
  getClient,
  createExam,
  toggleExamVisibility,
  closeExam,
  reopenExam,
} from '../../lib/superadmin/examCatalog.js'
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
  async function onClose(examId) {
    if (!confirm('Close this exam? New verifications against it will be blocked (reversible).')) return
    await closeExam(examId)
    await refresh()
  }
  async function onReopen(examId) {
    await reopenExam(examId)
    await refresh()
  }

  if (loading) {
    return <AppShell><SuperTabs /><div className="p-12 text-center text-sm text-slate-500">Loading…</div></AppShell>
  }
  if (!client) {
    return (
      <AppShell>
        <SuperTabs />
        <PageHeader title="Client not found" />
        <Link to="/superadmin/clients" className="text-indigo-600 hover:underline text-sm">← Back to clients</Link>
      </AppShell>
    )
  }

  const totalCandidates = exams.reduce((s, e) => s + (e.candidate_count || 0), 0)
  const openExams = exams.filter(e => !e.closed).length

  return (
    <AppShell>
      <SuperTabs />
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
        <div className="mb-8 rounded-xl bg-white ring-1 ring-slate-200 overflow-hidden">
          <div className="h-1 bg-gradient-to-r from-indigo-500 via-violet-500 to-fuchsia-500" />
          <div className="p-5 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex items-start gap-4 min-w-0">
                <div className="h-12 w-12 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0">
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
              <Button onClick={() => setCreating(v => !v)}>
                <Icon.Plus className="h-4 w-4 mr-1.5" />
                {creating ? 'Cancel' : 'New exam'}
              </Button>
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

        <Card>
          <CardBody className="p-0">
            {exams.length === 0 ? (
              <EmptyExams onCreate={() => setCreating(true)} />
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
                    {exams.map((e) => (
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
                            {e.visible ? <Pill tone="emerald" dot>Visible</Pill> : <Pill tone="slate" dot>Hidden</Pill>}
                            {e.closed && <Pill tone="amber" dot>Closed</Pill>}
                          </div>
                        </td>
                        <td className="px-5 py-3.5">
                          <div className="flex justify-end gap-1">
                            <Button variant="ghost" size="sm" onClick={() => onToggleVisibility(e.id)}>
                              {e.visible ? 'Hide' : 'Show'}
                            </Button>
                            {e.closed
                              ? <Button variant="ghost" size="sm" onClick={() => onReopen(e.id)}>Reopen</Button>
                              : <Button variant="ghost" size="sm" onClick={() => onClose(e.id)}>Close</Button>}
                            <Link
                              to={`/superadmin/exams/${e.id}`}
                              className="inline-flex items-center px-2.5 py-1.5 text-xs font-medium rounded-md text-indigo-600 hover:bg-indigo-50 transition-colors"
                            >
                              Open
                              <Icon.ChevronRight className="h-3.5 w-3.5 ml-0.5" />
                            </Link>
                          </div>
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
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  async function onSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setErr('')
    try {
      const { id: examId } = await createExam(clientId, {
        name: name.trim(),
        exam_code: code.trim(),
        verification_from: from,
        verification_to: to,
      })
      onCreated(examId)
    } catch (e) {
      const status = e.status ? ` (HTTP ${e.status})` : ''
      const backend = e.body?.error ? `: ${e.body.error}` : ''
      setErr(`${e.message || 'Could not create exam'}${status}${backend}`)
    } finally {
      setSaving(false)
    }
  }

  const canSubmit = name.trim() && code.trim() && from && to

  return (
    <div className="mb-6 rounded-xl bg-white ring-1 ring-slate-200 shadow-sm overflow-hidden">
      <div className="h-1 bg-gradient-to-r from-indigo-500 via-violet-500 to-fuchsia-500" />
      <div className="p-5 sm:p-6">
        <div className="flex items-start gap-3 mb-6">
          <div className="h-9 w-9 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0">
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
          <FormSection num="2" title="Verification window" hint="Colleges can only verify candidates for this exam inside this date range.">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label>From <span className="text-rose-500">*</span></Label>
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />
              </div>
              <div>
                <Label>To <span className="text-rose-500">*</span></Label>
                <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} required min={from || undefined} />
              </div>
            </div>
          </FormSection>

          {/* Section 3 — candidate data.
              Deliberately no form field. Uploads live on the exam page. */}
          <FormSection num="3" title="Candidate data" hint="Uploaded from the exam page after the exam is created.">
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

