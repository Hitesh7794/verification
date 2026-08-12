import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import AppShell from '../../components/shell/AppShell.jsx'
import SuperTabs from '../../components/shell/SuperTabs.jsx'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Input,
  Label,
  PageHeader,
} from '../../components/ui/ui.jsx'
import { Icon, Pill } from '../../components/ui/extras.jsx'
import { FadeIn } from '../../components/ui/motion.jsx'
import {
  getExam,
  patchExam,
  toggleExamVisibility,
  closeExam,
  reopenExam,
  listCandidates,
  uploadCandidateCSV,
  downloadRawCSV,
} from '../../lib/superadmin/examCatalog.js'
import { uploadExamCSV } from '../../lib/api.js'
import { dateOnly, dateRange } from '../../lib/dates.js'

// Superadmin > Exam detail — the exam meta, list of enrolled
// candidates (paginated), CSV upload area, upload history with
// download links, inline visibility + close buttons.
export default function ExamDetail() {
  const { id } = useParams()
  const [exam, setExam] = useState(null)
  const [uploads, setUploads] = useState([])
  const [candidates, setCandidates] = useState([])
  const [totalCandidates, setTotalCandidates] = useState(0)
  const [offset, setOffset] = useState(0)
  const PAGE = 100
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [uploadErr, setUploadErr] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [editing, setEditing] = useState(false)
  // Centres CSV upload — separate state so it doesn't clash with the
  // candidates upload panel's uploading/uploadErr signals.
  const [centresUploading, setCentresUploading] = useState(false)
  const [centresUploadInfo, setCentresUploadInfo] = useState(null) // {ok, msg} | null
  const [centresUploadErrs, setCentresUploadErrs] = useState(null)

  const refreshExam = useCallback(async () => {
    try {
      const { exam, uploads } = await getExam(id)
      setExam(exam)
      setUploads(uploads || [])
    } catch (e) {
      setErr(e.message || 'Could not load exam')
    }
  }, [id])

  const refreshCandidates = useCallback(async () => {
    try {
      const { candidates, total } = await listCandidates(id, { limit: PAGE, offset })
      setCandidates(candidates || [])
      setTotalCandidates(total || 0)
    } catch (e) {
      setErr(e.message || 'Could not load candidates')
    }
  }, [id, offset])

  useEffect(() => {
    setLoading(true)
    Promise.all([refreshExam(), refreshCandidates()]).finally(() => setLoading(false))
  }, [refreshExam, refreshCandidates])

  async function onCSVUpload(file) {
    if (!file) return
    setUploading(true)
    setUploadErr(null)
    setErr('')
    try {
      const res = await uploadCandidateCSV(id, file)
      setOffset(0)
      await Promise.all([refreshExam(), refreshCandidates()])
      alert(`Uploaded — ${res.rows_seeded} row${res.rows_seeded === 1 ? '' : 's'} seeded.`)
    } catch (e) {
      if (e.status === 422 && e.body?.validation_errors) {
        setUploadErr(e.body.validation_errors)
      } else {
        setErr(e.message || 'CSV upload failed')
      }
    } finally {
      setUploading(false)
    }
  }

  async function onCentresUpload(file) {
    if (!file) return
    setCentresUploading(true)
    setCentresUploadErrs(null)
    setCentresUploadInfo(null)
    try {
      const { status, body } = await uploadExamCSV(id, 'centres', file)
      if (status === 422 && body?.validation_errors) {
        setCentresUploadErrs(body.validation_errors)
        return
      }
      setCentresUploadInfo({
        ok: true,
        msg: `Uploaded — ${body.rows_seeded} centre${body.rows_seeded === 1 ? '' : 's'} seeded.`,
      })
    } catch (e) {
      setCentresUploadInfo({ ok: false, msg: e.message || 'Centres upload failed' })
    } finally {
      setCentresUploading(false)
    }
  }

  async function onToggleVisibility() {
    await toggleExamVisibility(id)
    await refreshExam()
  }
  async function onClose() {
    if (!confirm('Close this exam? New verifications will be blocked (reversible).')) return
    await closeExam(id)
    await refreshExam()
  }
  async function onReopen() {
    await reopenExam(id)
    await refreshExam()
  }

  if (loading) {
    return <AppShell><div className="p-10 text-center text-sm text-slate-500">Loading…</div></AppShell>
  }
  if (!exam) {
    return (
      <AppShell>
        <PageHeader title="Exam not found" />
        <Link to="/superadmin/clients" className="text-indigo-600 hover:underline text-sm">
          ← Back to clients
        </Link>
      </AppShell>
    )
  }

  const totalPages = Math.ceil(totalCandidates / PAGE)
  const currentPage = Math.floor(offset / PAGE) + 1

  return (
    <AppShell>
      <SuperTabs />
      <FadeIn>
        <div className="mb-2">
          <Link to={`/superadmin/clients/${exam.client_id}`} className="text-xs text-slate-500 hover:text-slate-700">
            ← {exam.client_name}
          </Link>
        </div>
        <PageHeader
          title={exam.name}
          subtitle={
            <span className="inline-flex items-center gap-2">
              <code className="text-xs bg-slate-100 px-1.5 py-0.5 rounded text-slate-700">{exam.exam_code}</code>
              <span className="text-slate-400">·</span>
              <span>{dateRange(exam.verification_from, exam.verification_to)}</span>
              <span className="text-slate-400">·</span>
              {exam.visible ? <Pill tone="emerald" dot>Visible</Pill> : <Pill tone="slate" dot>Hidden</Pill>}
              {exam.closed && <Pill tone="amber" dot>Closed</Pill>}
            </span>
          }
          right={
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setEditing(v => !v)}>
                {editing ? 'Cancel' : 'Edit'}
              </Button>
              <Button variant="ghost" onClick={onToggleVisibility}>
                {exam.visible ? 'Hide' : 'Show'}
              </Button>
              {exam.closed
                ? <Button variant="ghost" onClick={onReopen}>Reopen</Button>
                : <Button variant="ghost" onClick={onClose}>Close</Button>}
            </div>
          }
        />

        {err && (
          <div role="alert" className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
            {err}
          </div>
        )}

        {editing && (
          <EditExamForm exam={exam} onCancel={() => setEditing(false)} onSaved={async () => { setEditing(false); await refreshExam() }} />
        )}

        {/* Candidate CSV upload */}
        <Card className="mb-6">
          <CardHeader className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>Candidates</CardTitle>
              <p className="mt-1 text-xs text-slate-500">
                Required: <code>name</code>, <code>roll_no</code>. Optional: <code>verification_date</code>,
                {' '}<code>registration_id</code>, <code>fname</code>, <code>dob</code>,
                {' '}<code>gender</code>, <code>shift_name</code>, <code>centre_code</code>. Unknown columns are ignored.
              </p>
            </div>
          </CardHeader>
          <CardBody>
            <input
              type="file"
              accept=".csv,text/csv"
              disabled={uploading}
              onChange={(e) => onCSVUpload(e.target.files?.[0])}
              className="block w-full text-sm text-slate-700 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200"
            />
            {uploading && <p className="mt-2 text-xs text-slate-500">Uploading + validating…</p>}
            {uploadErr && (
              <div className="mt-3 rounded-lg bg-rose-50 border border-rose-200 p-3">
                <p className="text-sm font-semibold text-rose-800 mb-1">Upload rejected — {uploadErr.length} problem{uploadErr.length === 1 ? '' : 's'}:</p>
                <ul className="text-xs text-rose-700 space-y-0.5">
                  {uploadErr.slice(0, 10).map((v, i) => (
                    <li key={i}>Line {v.line}: {v.msg}</li>
                  ))}
                  {uploadErr.length > 10 && <li>… {uploadErr.length - 10} more</li>}
                </ul>
              </div>
            )}
          </CardBody>
        </Card>

        {/* Centres CSV upload — feeds the per-exam exam_centres catalog,
            which the PDF receipt reads for the centre address block. */}
        <Card className="mb-6">
          <CardHeader className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>Centres</CardTitle>
              <p className="mt-1 text-xs text-slate-500">
                Required: <code>centre_code</code>, <code>centre_name</code>. Optional: <code>address</code>,
                {' '}<code>city</code>, <code>state</code>, <code>pincode</code>. Extra fields
                (zone, lat/lng, RM…) are ignored.
              </p>
            </div>
          </CardHeader>
          <CardBody>
            <input
              type="file"
              accept=".csv,text/csv"
              disabled={centresUploading}
              onChange={(e) => onCentresUpload(e.target.files?.[0])}
              className="block w-full text-sm text-slate-700 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200"
            />
            {centresUploading && <p className="mt-2 text-xs text-slate-500">Uploading + validating…</p>}
            {centresUploadInfo && (
              <div
                className={`mt-3 rounded-lg px-3 py-2 text-sm border ${
                  centresUploadInfo.ok
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                    : 'bg-rose-50 border-rose-200 text-rose-700'
                }`}
              >
                {centresUploadInfo.msg}
              </div>
            )}
            {centresUploadErrs && (
              <div className="mt-3 rounded-lg bg-rose-50 border border-rose-200 p-3">
                <p className="text-sm font-semibold text-rose-800 mb-1">Upload rejected — {centresUploadErrs.length} problem{centresUploadErrs.length === 1 ? '' : 's'}:</p>
                <ul className="text-xs text-rose-700 space-y-0.5">
                  {centresUploadErrs.slice(0, 10).map((v, i) => (
                    <li key={i}>Line {v.line}: {v.msg}</li>
                  ))}
                  {centresUploadErrs.length > 10 && <li>… {centresUploadErrs.length - 10} more</li>}
                </ul>
              </div>
            )}
          </CardBody>
        </Card>

        {/* Upload history */}
        {uploads.length > 0 && (
          <Card className="mb-6">
            <CardBody className="p-0">
              <div className="px-4 py-3 border-b border-slate-100">
                <h3 className="text-sm font-semibold text-slate-900">Upload history</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wider text-slate-500 bg-slate-50">
                      <th className="px-4 py-2.5">File</th>
                      <th className="px-4 py-2.5">Size</th>
                      <th className="px-4 py-2.5">Rows</th>
                      <th className="px-4 py-2.5">Uploaded by</th>
                      <th className="px-4 py-2.5">At</th>
                      <th className="px-4 py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {uploads.map((u) => (
                      <tr key={u.id} className="border-b border-slate-100 last:border-none">
                        <td className="px-4 py-3 text-slate-700 truncate max-w-xs" title={u.filename}>{u.filename}</td>
                        <td className="px-4 py-3 text-xs text-slate-500 tabular-nums">{formatBytes(u.size_bytes)}</td>
                        <td className="px-4 py-3 text-slate-700 tabular-nums">{u.rows_seeded}</td>
                        <td className="px-4 py-3 text-xs text-slate-500">{u.uploaded_by || '—'}</td>
                        <td className="px-4 py-3 text-xs text-slate-500">{new Date(u.uploaded_at).toLocaleString()}</td>
                        <td className="px-4 py-3 text-right">
                          <Button variant="ghost" size="sm" onClick={() => downloadRawCSV(u.id, u.filename)}>
                            <Icon.Download className="h-3.5 w-3.5 mr-1" />
                            Download
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardBody>
          </Card>
        )}

        {/* Candidates table */}
        <Card>
          <CardBody className="p-0">
            <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">
                Enrolled candidates <span className="text-slate-400 font-normal">({totalCandidates.toLocaleString()})</span>
              </h3>
              {totalPages > 1 && (
                <div className="flex items-center gap-2 text-xs">
                  <Button variant="ghost" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>‹ Prev</Button>
                  <span className="text-slate-500">Page {currentPage} of {totalPages}</span>
                  <Button variant="ghost" size="sm" disabled={currentPage >= totalPages} onClick={() => setOffset(offset + PAGE)}>Next ›</Button>
                </div>
              )}
            </div>
            {candidates.length === 0 ? (
              <div className="p-10 text-center">
                <p className="text-sm text-slate-500">No candidates yet.</p>
                <p className="text-xs text-slate-400 mt-1">Upload a CSV above to seed the passed-candidate list.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wider text-slate-500 bg-slate-50">
                      <th className="px-4 py-2.5">Roll no.</th>
                      <th className="px-4 py-2.5">Name</th>
                      <th className="px-4 py-2.5">Verification date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {candidates.map((c) => (
                      <tr key={c.id} className="border-b border-slate-100 last:border-none hover:bg-slate-50/60">
                        <td className="px-4 py-3 font-mono text-xs text-slate-700 tabular-nums">{c.roll_no}</td>
                        <td className="px-4 py-3 text-slate-900">{c.name}</td>
                        <td className="px-4 py-3 text-xs text-slate-500 tabular-nums">{dateOnly(c.verification_date) || '—'}</td>
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

// ── Edit form (inline) ────────────────────────────────────────────────

function EditExamForm({ exam, onCancel, onSaved }) {
  // The API hands these back as RFC 3339 ("2026-08-06T00:00:00Z"), but
  // <input type="date"> only accepts YYYY-MM-DD — anything else is
  // treated as an invalid value and the field renders BLANK. That made
  // the form look like it had lost the exam's dates, and forced the
  // superadmin to re-pick both just to rename an exam. Normalise on the
  // way in, and compare against the normalised value on the way out so
  // the dirty-check doesn't see "2026-08-06" != "2026-08-06T00:00:00Z"
  // and patch dates that were never touched.
  const examFrom = dateOnly(exam.verification_from)
  const examTo = dateOnly(exam.verification_to)

  const [name, setName] = useState(exam.name)
  const [trustview, setTrustview] = useState(exam.trustview_ref || '')
  const [from, setFrom] = useState(examFrom)
  const [to, setTo] = useState(examTo)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  async function onSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setErr('')
    try {
      const patch = {}
      if (name !== exam.name) patch.name = name.trim()
      if (trustview !== (exam.trustview_ref || '')) patch.trustview_ref = trustview.trim()
      if (from !== examFrom) patch.verification_from = from
      if (to !== examTo) patch.verification_to = to
      if (Object.keys(patch).length === 0) {
        onCancel()
        return
      }
      await patchExam(exam.id, patch)
      onSaved()
    } catch (e) {
      setErr(e.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="mb-6">
      <CardBody>
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
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
            <Label>TrustView reference</Label>
            <Input value={trustview} onChange={(e) => setTrustview(e.target.value)} />
          </div>
          <p className="text-xs text-slate-500">Exam code cannot be changed after creation.</p>
          {err && (
            <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">{err}</div>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</Button>
          </div>
        </form>
      </CardBody>
    </Card>
  )
}

function formatBytes(n) {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / (1024 * 1024)).toFixed(1) + ' MB'
}
