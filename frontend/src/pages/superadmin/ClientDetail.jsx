import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
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
  uploadCandidateCSV,
} from '../../lib/superadmin/examCatalog.js'

// Superadmin > Client detail — client card + list of its exams inline.
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
    return <AppShell><div className="p-10 text-center text-sm text-slate-500">Loading…</div></AppShell>
  }
  if (!client) {
    return (
      <AppShell>
        <PageHeader title="Client not found" />
        <Link to="/superadmin/clients" className="text-indigo-600 hover:underline text-sm">
          ← Back to clients
        </Link>
      </AppShell>
    )
  }

  return (
    <AppShell>
      <SuperTabs />
      <FadeIn>
        <div className="mb-2">
          <Link to="/superadmin/clients" className="text-xs text-slate-500 hover:text-slate-700">
            ← All clients
          </Link>
        </div>
        <PageHeader
          title={client.name}
          subtitle={
            <span className="inline-flex items-center gap-2">
              {client.visible ? <Pill tone="emerald" dot>Visible</Pill> : <Pill tone="slate" dot>Hidden</Pill>}
              {client.closed && <Pill tone="amber" dot>Closed</Pill>}
              <span className="text-slate-400">·</span>
              <span>{client.exam_count} exam{client.exam_count === 1 ? '' : 's'}</span>
              {client.notes && <><span className="text-slate-400">·</span><span>{client.notes}</span></>}
            </span>
          }
          right={
            <Button onClick={() => setCreating(v => !v)}>
              <Icon.Plus className="h-4 w-4 mr-1" />
              {creating ? 'Cancel' : 'New exam'}
            </Button>
          }
        />

        {err && (
          <div role="alert" className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
            {err}
          </div>
        )}

        {creating && (
          <NewExamForm
            clientId={client.id}
            onCancel={() => setCreating(false)}
            onCreated={async (examId) => {
              setCreating(false)
              await refresh()
              nav(`/superadmin/exams/${examId}`)
            }}
          />
        )}

        <Card>
          <CardBody className="p-0">
            {exams.length === 0 ? (
              <div className="p-10 text-center">
                <p className="text-sm text-slate-500">No exams under this client yet.</p>
                <p className="text-xs text-slate-400 mt-1">Click <b>New exam</b> to add one.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wider text-slate-500 bg-slate-50">
                      <th className="px-4 py-2.5">Exam code</th>
                      <th className="px-4 py-2.5">Name</th>
                      <th className="px-4 py-2.5">Window</th>
                      <th className="px-4 py-2.5">Candidates</th>
                      <th className="px-4 py-2.5">Status</th>
                      <th className="px-4 py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {exams.map((e) => (
                      <tr key={e.id} className="border-b border-slate-100 last:border-none hover:bg-slate-50/60">
                        <td className="px-4 py-3 font-mono text-xs text-slate-700 tabular-nums">
                          <Link to={`/superadmin/exams/${e.id}`} className="hover:underline">
                            {e.exam_code}
                          </Link>
                        </td>
                        <td className="px-4 py-3 font-medium text-slate-900">{e.name}</td>
                        <td className="px-4 py-3 text-xs text-slate-600 tabular-nums">
                          {e.verification_from} → {e.verification_to}
                        </td>
                        <td className="px-4 py-3 text-slate-700 tabular-nums">{e.candidate_count}</td>
                        <td className="px-4 py-3">
                          <div className="flex gap-1.5">
                            {e.visible ? <Pill tone="emerald" dot>Visible</Pill> : <Pill tone="slate" dot>Hidden</Pill>}
                            {e.closed && <Pill tone="amber" dot>Closed</Pill>}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex justify-end gap-2">
                            <Button variant="ghost" size="sm" onClick={() => onToggleVisibility(e.id)}>
                              {e.visible ? 'Hide' : 'Show'}
                            </Button>
                            {e.closed
                              ? <Button variant="ghost" size="sm" onClick={() => onReopen(e.id)}>Reopen</Button>
                              : <Button variant="ghost" size="sm" onClick={() => onClose(e.id)}>Close</Button>}
                            <Link
                              to={`/superadmin/exams/${e.id}`}
                              className="inline-flex items-center px-2.5 py-1.5 text-xs font-medium rounded-md text-slate-700 hover:bg-slate-100"
                            >
                              Open →
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

// ── Create-exam form + optional CSV upload immediately after ─────────

function NewExamForm({ clientId, onCancel, onCreated }) {
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [trustview, setTrustview] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [csvFile, setCsvFile] = useState(null)
  const [uploadResult, setUploadResult] = useState(null)

  async function onSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setErr('')
    try {
      const { id: examId } = await createExam(clientId, {
        name: name.trim(),
        exam_code: code.trim(),
        trustview_ref: trustview.trim(),
        verification_from: from,
        verification_to: to,
      })
      if (csvFile) {
        try {
          const res = await uploadCandidateCSV(examId, csvFile)
          setUploadResult(res)
        } catch (uploadErr) {
          setErr(`Exam created — but CSV upload failed: ${uploadErr.message}. You can retry from the exam page.`)
          setTimeout(() => onCreated(examId), 2000)
          return
        }
      }
      onCreated(examId)
    } catch (e) {
      setErr(e.message || 'Could not create exam')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="mb-6">
      <CardBody>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label>Name</Label>
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
              <Label>Exam code <span className="text-xs text-slate-500 font-normal">(globally unique)</span></Label>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="EXAM-2026-01"
                maxLength={60}
                required
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label>Verification from</Label>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />
            </div>
            <div>
              <Label>Verification to</Label>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} required />
            </div>
          </div>
          <div>
            <Label>TrustView reference <span className="text-xs text-slate-500 font-normal">(optional)</span></Label>
            <Input
              value={trustview}
              onChange={(e) => setTrustview(e.target.value)}
              placeholder="TrustView exam ID or URL"
            />
          </div>
          <div>
            <Label>Candidate CSV <span className="text-xs text-slate-500 font-normal">(optional — can upload later)</span></Label>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => setCsvFile(e.target.files?.[0] || null)}
              className="block w-full text-sm text-slate-700 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200"
            />
            <p className="mt-1 text-xs text-slate-500">
              Columns required: <code>name</code>, <code>roll_no</code>, <code>verification_date</code>. Only passed candidates.
            </p>
          </div>

          {err && (
            <div role="alert" className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
              {err}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : (csvFile ? 'Create + upload' : 'Create exam')}
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  )
}
