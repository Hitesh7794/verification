import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import ReviewerShell, { ReviewerPageHead } from '../../components/reviewer/ReviewerShell.jsx'
import ConfirmDialog from '../../components/shell/ConfirmDialog.jsx'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '../../components/ui/ui.jsx'
import { Icon, Pill } from '../../components/ui/extras.jsx'
import { FadeIn } from '../../components/ui/motion.jsx'
import {
  getExam,
  patchExam,
  closeExam,
  reopenExam,
  deleteExam,
  listCandidates,
  uploadCandidateCSV,
  downloadRawCSV,
  getExamCompleteness,
  uploadBiometric,
} from '../../lib/superadmin/examCatalog.js'
import { uploadExamCSV } from '../../lib/api.js'
import { dateOnly, dateRange, toDatetimeLocal } from '../../lib/dates.js'
import BulkBiometricUpload from '../superadmin/BulkBiometricUpload.jsx'

// Reviewer > Exam Detail — the exam metadata, list of enrolled candidates (paginated),
// CSV upload area, upload history with download links, inline visibility + close/reopen buttons,
// centre catalog upload, and bulk biometric zip uploads.
export default function ReviewerExamDetail() {
  const { id } = useParams()
  const nav = useNavigate()
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

  // Centres CSV upload state
  const [centresUploading, setCentresUploading] = useState(false)
  const [centresUploadInfo, setCentresUploadInfo] = useState(null)
  const [centresUploadErrs, setCentresUploadErrs] = useState(null)

  // Confirm-dialog state
  const [dlg, setDlg] = useState(null)

  // Biometrics completeness
  const [completeness, setCompleteness] = useState(null)
  const bioByRoll = completeness?.per_candidate
    ? Object.fromEntries(completeness.per_candidate.map((c) => [c.roll, c]))
    : {}
  const [bioTarget, setBioTarget] = useState(null)

  const refreshCompleteness = useCallback(async () => {
    try { setCompleteness(await getExamCompleteness(id)) } catch { /* silent */ }
  }, [id])

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
    Promise.all([refreshExam(), refreshCandidates(), refreshCompleteness()])
      .finally(() => setLoading(false))
  }, [refreshExam, refreshCandidates, refreshCompleteness])

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



  function askClose() {
    setDlg({
      title:        `End "${exam.name}"?`,
      body:         'New verifications will be blocked.\nExisting data is preserved — you can reopen it later.',
      confirmLabel: 'End exam',
      tone:         'warn',
      onConfirm:    async () => { await closeExam(id); await refreshExam(); setDlg(null) },
    })
  }

  async function onReopen() {
    await reopenExam(id)
    await refreshExam()
  }

  function askDelete() {
    setDlg({
      title:        `Delete "${exam.name}"?`,
      body:         'This is permanent. Only allowed if no verifications reference candidates in this exam.\n\nDeleting will also remove all its candidates, centres, CSV uploads, and verification agent assignments.\n\nUse "End" instead if you want to close it while preserving data.',
      confirmLabel: 'Delete exam',
      tone:         'danger',
      onConfirm:    async () => { await deleteExam(id); nav('/reviewer/exams') },
    })
  }

  if (loading) {
    return (
      <ReviewerShell>
        <div className="p-12 text-center text-sm text-slate-500">Loading exam…</div>
      </ReviewerShell>
    )
  }

  if (!exam) {
    return (
      <ReviewerShell>
        <ReviewerPageHead eyebrow="Exam" title="Exam not found" />
        <Link to="/reviewer/exams" className="text-indigo-600 hover:underline text-sm">
          ← Back to all exams
        </Link>
      </ReviewerShell>
    )
  }

  const totalPages = Math.ceil(totalCandidates / PAGE)
  const currentPage = Math.floor(offset / PAGE) + 1

  const isExpired = exam.verification_to && new Date() > new Date(exam.verification_to)
  const isOngoing = !exam.closed && (!exam.verification_from || new Date(exam.verification_from) <= new Date()) && !isExpired

  return (
    <ReviewerShell>
      <FadeIn>
        <div className="mb-2">
          <Link to="/reviewer/exams" className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-800 transition-colors">
            <Icon.ChevronLeft className="h-3.5 w-3.5" />
            All board exams
          </Link>
        </div>

        <ReviewerPageHead
          eyebrow="Exam Management"
          title={exam.name}
          subtitle={
            <span className="inline-flex items-center gap-2 flex-wrap">
              <code className="text-xs bg-slate-100 px-1.5 py-0.5 rounded text-slate-700 font-mono font-semibold">{exam.exam_code}</code>
              <span className="text-slate-400">·</span>
              <span>{dateRange(exam.verification_from, exam.verification_to)}</span>
              <span className="text-slate-400">·</span>
              {exam.closed && <Pill tone="amber" dot>Ended</Pill>}
              {isExpired && !exam.closed && <Pill tone="amber" dot>Archived (Window Expired)</Pill>}
              {isOngoing && <Pill tone="emerald" dot>Live</Pill>}
              {!isOngoing && !isExpired && !exam.closed && <Pill tone="blue" dot>Upcoming</Pill>}
              <span className="text-slate-400">·</span>
              <span className="text-xs text-slate-600">
                Requires: {[
                  exam.requires_face !== false && 'Face',
                  exam.requires_fp   !== false && 'Fingerprint',
                  exam.requires_iris && 'Iris',
                ].filter(Boolean).join(' + ') || '—'}
              </span>
            </span>
          }
          right={
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setEditing((v) => !v)}>
                {editing ? 'Cancel' : 'Edit window'}
              </Button>
              {exam.closed ? (
                <Button
                  variant="secondary"
                  onClick={onReopen}
                  title="Allow new verifications against this exam again"
                >
                  Reopen
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  onClick={askClose}
                  title="Stop accepting new verifications (existing data preserved, reversible)"
                >
                  End
                </Button>
              )}
              <Button
                variant="secondary"
                onClick={askDelete}
                title="Permanently delete this exam — only allowed if no verifications reference its candidates"
                className="!text-rose-700 !border-rose-200 hover:!bg-rose-50 hover:!border-rose-300"
              >
                Delete
              </Button>
            </div>
          }
        />

        {err && (
          <div role="alert" className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
            {err}
          </div>
        )}

        {(isExpired || exam.closed) && (
          <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50/80 p-4 text-xs text-amber-900 flex items-start gap-3 shadow-2xs">
            <div className="h-7 w-7 rounded-lg bg-amber-100 text-amber-800 flex items-center justify-center shrink-0">
              <Icon.Calendar className="h-4 w-4" />
            </div>
            <div>
              <p className="font-semibold text-amber-900 text-sm">
                {exam.closed ? 'This examination has been ended' : 'This examination is archived (window expired)'}
              </p>
              <p className="mt-0.5 text-amber-800 leading-relaxed">
                {exam.closed
                  ? 'New candidate verifications are blocked. Click "Reopen" or "Edit window" to re-activate this exam.'
                  : 'The verification window for this exam has passed. Click "Edit window" above to extend the verification window to a future date/time — doing so will automatically remove it from the archive.'}
              </p>
            </div>
          </div>
        )}

        {editing && (
          <EditExamForm
            exam={exam}
            onCancel={() => setEditing(false)}
            onSaved={async () => {
              setEditing(false)
              await refreshExam()
            }}
          />
        )}

        {/* Candidate CSV upload */}
        <Card className="mb-6">
          <CardHeader className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>Candidate Roster</CardTitle>
              <p className="mt-1 text-xs text-slate-500">
                Required: <code>name</code>, <code>roll_no</code>. Optional: <code>verification_date</code>,
                {' '}<code>registration_id</code>, <code>father_name</code>, <code>dob</code>,
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
                <p className="text-sm font-semibold text-rose-800 mb-1">
                  Upload rejected — {uploadErr.length} problem{uploadErr.length === 1 ? '' : 's'}:
                </p>
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

        {/* Centres CSV upload */}
        <Card className="mb-6">
          <CardHeader className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>Exam Centres</CardTitle>
              <p className="mt-1 text-xs text-slate-500">
                Required: <code>centre_code</code>, <code>centre_name</code>. Optional: <code>address</code>,
                {' '}<code>city</code>, <code>state</code>, <code>pincode</code>. Extra fields are ignored.
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
                <p className="text-sm font-semibold text-rose-800 mb-1">
                  Upload rejected — {centresUploadErrs.length} problem{centresUploadErrs.length === 1 ? '' : 's'}:
                </p>
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

        {/* Bulk-zip upload for each biometric modality */}
        {exam && (
          <BulkBiometricUpload
            examId={id}
            exam={exam}
            onUploaded={() => {
              refreshCompleteness()
              refreshCandidates()
            }}
          />
        )}

        {/* Biometrics completeness banner */}
        {completeness && completeness.total > 0 && (
          <div className="mb-4 rounded-xl border border-warm bg-warm-surface p-4 shadow-sm">
            <div className="flex items-baseline justify-between flex-wrap gap-3 mb-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-warm-accent">
                  Biometric enrolment completeness
                </p>
                <p className="text-sm text-stone-600 mt-0.5">
                  {completeness.total.toLocaleString()} candidate{completeness.total === 1 ? '' : 's'} enrolled
                </p>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <BioMetric label="Photo"       have={completeness.with_photo}       total={completeness.total} />
              <BioMetric label="FP image"    have={completeness.with_fp_image}    total={completeness.total} />
              <BioMetric label="FP template" have={completeness.with_fp_template} total={completeness.total} />
              <BioMetric label="Iris"        have={completeness.with_iris}        total={completeness.total} />
            </div>
          </div>
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
                <p className="text-xs text-slate-400 mt-1">Upload a CSV above to seed the candidate roster.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wider text-slate-500 bg-slate-50">
                      <th className="px-4 py-2.5">Roll no.</th>
                      <th className="px-4 py-2.5">Name</th>
                      <th className="px-4 py-2.5">Verification date</th>
                      <th className="px-4 py-2.5">Biometrics</th>
                      <th className="px-4 py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {candidates.map((c) => {
                      const bio = bioByRoll[c.roll_no] || {}
                      return (
                        <tr key={c.id} className="border-b border-slate-100 last:border-none hover:bg-slate-50/60">
                          <td className="px-4 py-3 font-mono text-xs text-slate-700 tabular-nums">{c.roll_no}</td>
                          <td className="px-4 py-3 text-slate-900 font-medium">{c.name}</td>
                          <td className="px-4 py-3 text-xs text-slate-500 tabular-nums">{dateOnly(c.verification_date) || '—'}</td>
                          <td className="px-4 py-3">
                            <div className="inline-flex items-center gap-2">
                              <BioDot label="Photo"       ok={bio.has_photo} />
                              <BioDot label="FP image"    ok={bio.has_fp_image} />
                              <BioDot label="FP template" ok={bio.has_fp_template} />
                              <BioDot label="Iris"        ok={bio.has_iris} />
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <Button variant="secondary" size="sm" onClick={() => setBioTarget(c)}>
                              Upload
                            </Button>
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

      <BiometricUploadModal
        open={!!bioTarget}
        examId={id}
        candidate={bioTarget}
        currentStatus={bioTarget ? (bioByRoll[bioTarget.roll_no] || {}) : {}}
        onClose={() => setBioTarget(null)}
        onUploaded={async () => { await refreshCompleteness() }}
      />
    </ReviewerShell>
  )
}

function BioMetric({ label, have, total }) {
  const pct = total ? (have / total) * 100 : 0
  const complete = pct >= 100
  const low = pct < 80 && !complete
  return (
    <div className="rounded-lg border border-warm bg-[#FBF7F0] px-4 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-stone-500 mb-1">{label}</p>
      <p className="text-xl font-semibold text-ink-900 tabular-nums leading-none">
        {have.toLocaleString('en-IN')} <span className="text-xs font-normal text-stone-400">/ {total.toLocaleString('en-IN')}</span>
      </p>
      <div className="mt-2 h-1 rounded-full bg-stone-200 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ease-out ${complete ? 'bg-emerald-600' : low ? 'bg-amber-600' : 'bg-stone-700'}`}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
    </div>
  )
}

function BioDot({ label, ok }) {
  return (
    <span
      title={`${label}: ${ok ? 'uploaded' : 'missing'}`}
      className={`inline-block h-2 w-2 rounded-full ${ok ? 'bg-emerald-600' : 'bg-transparent border border-stone-300'}`}
      aria-label={`${label} ${ok ? 'uploaded' : 'missing'}`}
    />
  )
}

function BiometricUploadModal({ open, examId, candidate, currentStatus, onClose, onUploaded }) {
  const [uploadingKind, setUploadingKind] = useState(null)
  const [err, setErr] = useState('')

  if (!open || !candidate) return null

  async function handleUpload(kind, file) {
    if (!file) return
    setUploadingKind(kind)
    setErr('')
    try {
      await uploadBiometric(examId, candidate.roll_no, kind, file)
      await onUploaded()
    } catch (e) {
      setErr(e.message || 'Upload failed')
    } finally {
      setUploadingKind(null)
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-stone-900/40 backdrop-blur-sm"
        onClick={() => uploadingKind == null && onClose()}
      />
      <div className="relative w-full max-w-lg rounded-2xl bg-warm-surface border border-warm shadow-2xl overflow-hidden">
        <div className="px-6 py-5 border-b border-warm">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-warm-accent mb-1">
            Upload biometrics
          </p>
          <h3 className="text-base font-semibold text-ink-900">
            {candidate.name} <span className="text-stone-500 font-mono text-sm">· {candidate.roll_no}</span>
          </h3>
        </div>
        <div className="p-6 space-y-4">
          <BioUploadRow label="Photo"        kind="photo"       accept=".jpg,.jpeg,.png"       have={currentStatus.has_photo}       busy={uploadingKind === 'photo'}       onFile={(f) => handleUpload('photo', f)} />
          <BioUploadRow label="FP image"     kind="fp_image"    accept=".jpg,.jpeg,.png,.bmp"  have={currentStatus.has_fp_image}    busy={uploadingKind === 'fp_image'}    onFile={(f) => handleUpload('fp_image', f)} />
          <BioUploadRow label="FP template"  kind="fp_template" accept=".iso,.dat,.bin"        have={currentStatus.has_fp_template} busy={uploadingKind === 'fp_template'} onFile={(f) => handleUpload('fp_template', f)} />
          <BioUploadRow label="Iris"         kind="iris"        accept=".iso,.k7,.bmp"         have={currentStatus.has_iris}        busy={uploadingKind === 'iris'}        onFile={(f) => handleUpload('iris', f)} />

          {err && (
            <div role="alert" className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-700">
              {err}
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-6 py-3 bg-[#FBF7F0] border-t border-warm">
          <button
            type="button"
            onClick={onClose}
            disabled={uploadingKind != null}
            className="inline-flex items-center px-4 py-2 text-sm font-medium rounded-lg text-stone-700 hover:bg-stone-100 focus:outline-none focus:ring-2 focus:ring-stone-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

function BioUploadRow({ label, kind, accept, have, busy, onFile }) {
  const inputId = `reviewer-bio-upload-${kind}`
  return (
    <div className="flex items-center justify-between gap-3 py-2 border-b border-warm last:border-none">
      <div className="flex items-center gap-2.5 min-w-0">
        <span
          className={`inline-block h-2 w-2 rounded-full shrink-0 ${have ? 'bg-emerald-600' : 'bg-transparent border border-stone-300'}`}
          aria-hidden="true"
        />
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink-900">{label}</p>
          <p className="text-[11px] text-stone-500">
            {have ? 'Uploaded — new file replaces it' : 'Not uploaded yet'}
            <span className="mx-1 text-stone-300">·</span>
            <span className="text-stone-400">{accept}</span>
          </p>
        </div>
      </div>
      <div className="shrink-0">
        <input
          id={inputId}
          type="file"
          accept={accept}
          disabled={busy}
          onChange={(e) => onFile(e.target.files?.[0])}
          className="hidden"
        />
        <label
          htmlFor={inputId}
          className={`inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-md border border-warm-strong bg-white text-stone-800 hover:bg-stone-50 cursor-pointer transition-colors ${busy ? 'opacity-60 cursor-not-allowed' : ''}`}
        >
          {busy ? 'Uploading…' : (have ? 'Replace' : 'Choose file')}
        </label>
      </div>
    </div>
  )
}

function EditExamForm({ exam, onCancel, onSaved }) {
  const examFrom = toDatetimeLocal(exam.verification_from, '00:00')
  const examTo = toDatetimeLocal(exam.verification_to, '23:59')

  const [name, setName] = useState(exam.name)
  const [from, setFrom] = useState(examFrom)
  const [to, setTo] = useState(examTo)
  const [reqFace, setReqFace] = useState(exam.requires_face !== false)
  const [reqFP,   setReqFP]   = useState(exam.requires_fp   !== false)
  const [reqIris, setReqIris] = useState(!!exam.requires_iris)
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
      const patch = {}
      if (name !== exam.name) patch.name = name.trim()
      if (from !== examFrom) patch.verification_from = from
      if (to !== examTo) patch.verification_to = to
      if (reqFace !== (exam.requires_face !== false)) patch.requires_face = reqFace
      if (reqFP   !== (exam.requires_fp   !== false)) patch.requires_fp   = reqFP
      if (reqIris !== !!exam.requires_iris)           patch.requires_iris = reqIris
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
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Exam name" required />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label>Verification from (date & time)</Label>
              <Input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} required />
            </div>
            <div>
              <Label>Verification to (date & time)</Label>
              <Input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} required min={from || undefined} />
            </div>
          </div>
          <div>
            <Label>Biometrics required for verification</Label>
            <p className="text-xs text-slate-500 mb-2">
              Verification agents only see capture panels for the biometrics ticked here.
              At least one must be selected.
            </p>
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
