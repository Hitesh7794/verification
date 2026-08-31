import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import ReviewerShell, { ReviewerPageHead } from '../../components/reviewer/ReviewerShell.jsx'
import ConfirmDialog from '../../components/shell/ConfirmDialog.jsx'
import { Button, Card, CardBody, Input, Label } from '../../components/ui/ui.jsx'
import { Icon, Pill } from '../../components/ui/extras.jsx'
import { FadeIn } from '../../components/ui/motion.jsx'
import {
  listReviewerExams,
  createReviewerExam,
  bulkCreateReviewerExamsCSV,
  downloadSampleExamCSV,
  reviewerMe,
} from '../../lib/reviewer/api.js'
import {
  closeExam,
  reopenExam,
  deleteExam,
} from '../../lib/superadmin/examCatalog.js'
import { dateRange } from '../../lib/dates.js'

function FormSection({ num, title, hint, children }) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-stone-900 text-[10px] font-bold text-white">
          {num}
        </span>
        <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-800">{title}</h4>
      </div>
      {hint && <p className="text-xs text-slate-500 pl-7">{hint}</p>}
      <div className="pl-7">{children}</div>
    </div>
  )
}

function NewExamForm({ onCancel, onCreated, onBulkCreated }) {
  const [mode, setMode] = useState('single') // 'single' | 'bulk'

  // Single exam state
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [reqFace, setReqFace] = useState(true)
  const [reqFP, setReqFP] = useState(true)
  const [reqIris, setReqIris] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  // Bulk CSV state
  const [csvFile, setCsvFile] = useState(null)
  const [bulkSaving, setBulkSaving] = useState(false)
  const [bulkErr, setBulkErr] = useState('')
  const [validationErrors, setValidationErrors] = useState([])
  const [bulkSuccess, setBulkSuccess] = useState(null)
  const [dragOver, setDragOver] = useState(false)

  async function onSingleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setErr('')
    try {
      if (!reqFace && !reqFP && !reqIris) {
        setErr('Pick at least one biometric to require for this exam.')
        setSaving(false)
        return
      }
      const res = await createReviewerExam({
        name: name.trim(),
        exam_code: code.trim(),
        verification_from: from,
        verification_to: to,
        requires_face: reqFace,
        requires_fp: reqFP,
        requires_iris: reqIris,
      })
      onCreated(res.id)
    } catch (e) {
      setErr(e?.body?.error || e?.message || 'Could not create exam. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  async function onBulkSubmit(e) {
    e.preventDefault()
    if (!csvFile) return
    setBulkSaving(true)
    setBulkErr('')
    setValidationErrors([])
    setBulkSuccess(null)
    try {
      const res = await bulkCreateReviewerExamsCSV(csvFile)
      setBulkSuccess(res.rows_seeded || res.exams?.length || 'Multiple')
      setTimeout(() => {
        if (onBulkCreated) onBulkCreated(res.rows_seeded)
      }, 1200)
    } catch (e) {
      if (e?.body?.validation_errors?.length) {
        setValidationErrors(e.body.validation_errors)
      } else {
        setBulkErr(e?.body?.error || e?.message || 'Bulk upload failed. Please check the CSV format.')
      }
    } finally {
      setBulkSaving(false)
    }
  }

  function handleFileDrop(e) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer?.files?.[0]
    if (file && (file.name.endsWith('.csv') || file.type.includes('csv') || file.type.includes('text'))) {
      setCsvFile(file)
      setBulkErr('')
      setValidationErrors([])
    } else if (file) {
      setBulkErr('Please upload a valid .csv file.')
    }
  }

  const canSingleSubmit = name.trim() && code.trim() && from && to && (reqFace || reqFP || reqIris)

  return (
    <div className="mb-8 rounded-2xl bg-white border border-stone-200/80 shadow-md overflow-hidden">
      <div className="h-1 bg-stone-900" />
      <div className="p-6 sm:p-7">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-6 pb-4 border-b border-slate-100">
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-xl bg-stone-100 text-stone-800 flex items-center justify-center shrink-0">
              {mode === 'single' ? <Icon.FileText className="h-5 w-5" /> : <Icon.Upload className="h-5 w-5" />}
            </div>
            <div>
              <h3 className="text-base font-semibold text-slate-900">
                {mode === 'single' ? 'New Exam' : 'Bulk Create Exams via CSV'}
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                {mode === 'single'
                  ? 'Add a single exam under your exam board with verification window and biometric requirements.'
                  : 'Upload a CSV file to create multiple exams at once under your exam board.'}
              </p>
            </div>
          </div>

          {/* Mode Switcher Tabs */}
          <div className="inline-flex rounded-lg bg-slate-100 p-1 text-xs font-semibold">
            <button
              type="button"
              onClick={() => { setMode('single'); setErr(''); }}
              className={`flex items-center gap-1.5 rounded-md px-3.5 py-1.5 transition-all ${
                mode === 'single'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Icon.FileText className="h-3.5 w-3.5" />
              <span>Single exam</span>
            </button>
            <button
              type="button"
              onClick={() => { setMode('bulk'); setBulkErr(''); setValidationErrors([]); }}
              className={`flex items-center gap-1.5 rounded-md px-3.5 py-1.5 transition-all ${
                mode === 'bulk'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Icon.Upload className="h-3.5 w-3.5" />
              <span>Bulk upload (CSV)</span>
            </button>
          </div>
        </div>

        {mode === 'single' ? (
          /* Single Exam Form */
          <form onSubmit={onSingleSubmit} className="space-y-6">
            <FormSection num="1" title="Identity" hint="What the exam is called and its unique code.">
              <div className="grid grid-cols-1 sm:grid-cols-[1fr_240px] gap-4">
                <div>
                  <Label>Exam Name <span className="text-rose-500">*</span></Label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. National Eligibility Test 2026"
                    maxLength={200}
                    required
                    autoFocus
                  />
                </div>
                <div>
                  <Label>Exam Code <span className="text-rose-500">*</span></Label>
                  <Input
                    value={code}
                    onChange={(e) => setCode(e.target.value.toUpperCase())}
                    placeholder="e.g. NET-2026"
                    maxLength={64}
                    required
                    className="font-mono"
                  />
                </div>
              </div>
            </FormSection>

            <FormSection num="2" title="Verification window" hint="Date and time when operators are permitted to verify candidates for this exam.">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <Label>Window start (From) <span className="text-rose-500">*</span></Label>
                  <Input
                    type="datetime-local"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <Label>Window end (To) <span className="text-rose-500">*</span></Label>
                  <Input
                    type="datetime-local"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                    required
                    min={from || undefined}
                  />
                </div>
              </div>
            </FormSection>

            <FormSection num="3" title="Biometric requirements" hint="Select which biometric capture channels are enforced for candidates of this exam.">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <label className={`flex items-start gap-3 rounded-xl border p-3.5 transition-all cursor-pointer ${
                  reqFace ? 'border-stone-900 bg-stone-50/50 shadow-xs' : 'border-slate-200 hover:border-slate-300'
                }`}>
                  <input
                    type="checkbox"
                    checked={reqFace}
                    onChange={(e) => setReqFace(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-slate-300 text-stone-900 focus:ring-stone-900"
                  />
                  <div>
                    <span className="text-xs font-bold text-slate-900 block">Facial Recognition</span>
                    <span className="text-[11px] text-slate-500 mt-0.5 block leading-tight">Live camera face match against enrolled photo</span>
                  </div>
                </label>

                <label className={`flex items-start gap-3 rounded-xl border p-3.5 transition-all cursor-pointer ${
                  reqFP ? 'border-stone-900 bg-stone-50/50 shadow-xs' : 'border-slate-200 hover:border-slate-300'
                }`}>
                  <input
                    type="checkbox"
                    checked={reqFP}
                    onChange={(e) => setReqFP(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-slate-300 text-stone-900 focus:ring-stone-900"
                  />
                  <div>
                    <span className="text-xs font-bold text-slate-900 block">Fingerprint</span>
                    <span className="text-[11px] text-slate-500 mt-0.5 block leading-tight">Biometric sensor scan (ISO/FMR templates)</span>
                  </div>
                </label>

                <label className={`flex items-start gap-3 rounded-xl border p-3.5 transition-all cursor-pointer ${
                  reqIris ? 'border-stone-900 bg-stone-50/50 shadow-xs' : 'border-slate-200 hover:border-slate-300'
                }`}>
                  <input
                    type="checkbox"
                    checked={reqIris}
                    onChange={(e) => setReqIris(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-slate-300 text-stone-900 focus:ring-stone-900"
                  />
                  <div>
                    <span className="text-xs font-bold text-slate-900 block">Iris Scan</span>
                    <span className="text-[11px] text-slate-500 mt-0.5 block leading-tight">Dual-eye optical iris capture & verification</span>
                  </div>
                </label>
              </div>
            </FormSection>

            {err && (
              <div role="alert" className="rounded-lg bg-rose-50 border border-rose-200 px-4 py-2.5 text-sm text-rose-700">
                {err}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-4 border-t border-slate-100">
              <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
              <Button type="submit" disabled={saving || !canSingleSubmit}>
                {saving ? 'Creating exam…' : 'Create exam'}
              </Button>
            </div>
          </form>
        ) : (
          /* Bulk CSV Upload Form */
          <form onSubmit={onBulkSubmit} className="space-y-6">
            <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4 text-xs text-slate-600">
              <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
                <span className="font-semibold text-slate-800">CSV Columns Reference:</span>
                <button
                  type="button"
                  onClick={downloadSampleExamCSV}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-stone-900 hover:text-stone-700 bg-white border border-slate-200 px-2.5 py-1 rounded-md shadow-2xs transition-colors"
                >
                  <Icon.Download className="h-3.5 w-3.5" />
                  Download sample CSV template
                </button>
              </div>
              <p className="leading-relaxed">
                Required columns: <code className="bg-white px-1.5 py-0.5 rounded border font-mono text-[11px] text-stone-900">exam_name</code>,{' '}
                <code className="bg-white px-1.5 py-0.5 rounded border font-mono text-[11px] text-stone-900">exam_code</code>,{' '}
                <code className="bg-white px-1.5 py-0.5 rounded border font-mono text-[11px] text-stone-900">verification_from</code>,{' '}
                <code className="bg-white px-1.5 py-0.5 rounded border font-mono text-[11px] text-stone-900">verification_to</code>.
                <br />
                Optional columns:{' '}
                <code className="bg-white px-1.5 py-0.5 rounded border font-mono text-[11px] text-stone-900">requires_face</code>,{' '}
                <code className="bg-white px-1.5 py-0.5 rounded border font-mono text-[11px] text-stone-900">requires_fp</code>,{' '}
                <code className="bg-white px-1.5 py-0.5 rounded border font-mono text-[11px] text-stone-900">requires_iris</code> (use <code className="font-mono text-stone-800">yes</code> or <code className="font-mono text-stone-800">no</code>).
              </p>
            </div>

            {/* Drag and Drop Box */}
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleFileDrop}
              className={`relative rounded-2xl border-2 border-dashed p-8 text-center transition-all ${
                dragOver
                  ? 'border-stone-900 bg-stone-50/50 ring-4 ring-stone-900/10'
                  : csvFile
                  ? 'border-emerald-300 bg-emerald-50/30'
                  : 'border-slate-300 hover:border-slate-400 bg-white'
              }`}
            >
              <input
                type="file"
                accept=".csv,text/csv"
                id="reviewer-exam-csv-input"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) {
                    setCsvFile(f)
                    setBulkErr('')
                    setValidationErrors([])
                  }
                }}
                className="sr-only"
              />
              <label htmlFor="reviewer-exam-csv-input" className="cursor-pointer block">
                <div className="mx-auto h-12 w-12 rounded-xl bg-stone-100 text-stone-700 flex items-center justify-center mb-3">
                  {csvFile ? <Icon.Check className="h-6 w-6 text-emerald-600" /> : <Icon.Upload className="h-6 w-6" />}
                </div>
                {csvFile ? (
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{csvFile.name}</p>
                    <p className="text-xs text-slate-500 mt-1">{(csvFile.size / 1024).toFixed(1)} KB · Click or drag another to replace</p>
                  </div>
                ) : (
                  <div>
                    <p className="text-sm font-semibold text-slate-900">
                      <span className="text-stone-900 underline underline-offset-2">Click to browse</span> or drag and drop your CSV
                    </p>
                    <p className="text-xs text-slate-500 mt-1">Up to 1,000 exams per batch</p>
                  </div>
                )}
              </label>
            </div>

            {/* Validation Errors Table */}
            {validationErrors.length > 0 && (
              <div className="rounded-xl border border-rose-200 bg-rose-50/50 p-4">
                <div className="flex items-center gap-2 text-rose-800 font-semibold text-sm mb-2">
                  <Icon.AlertCircle className="h-4 w-4" />
                  <span>Found {validationErrors.length} format error(s) in CSV</span>
                </div>
                <div className="max-h-48 overflow-y-auto rounded-lg border border-rose-200 bg-white">
                  <table className="w-full text-xs text-left">
                    <thead className="bg-rose-100/50 text-rose-900 font-medium">
                      <tr>
                        <th className="px-3 py-1.5 w-20">Row</th>
                        <th className="px-3 py-1.5">Issue</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-rose-100">
                      {validationErrors.map((ve, idx) => (
                        <tr key={idx} className="hover:bg-rose-50/30">
                          <td className="px-3 py-1.5 font-mono text-rose-700">Line {ve.line}</td>
                          <td className="px-3 py-1.5 text-slate-700">{ve.msg}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {bulkErr && (
              <div role="alert" className="rounded-lg bg-rose-50 border border-rose-200 px-4 py-2.5 text-sm text-rose-700">
                {bulkErr}
              </div>
            )}

            {bulkSuccess && (
              <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-2.5 text-sm text-emerald-800 flex items-center gap-2">
                <Icon.Check className="h-4 w-4 text-emerald-600" />
                <span>Successfully created {bulkSuccess} exams! Refreshing list…</span>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-4 border-t border-slate-100">
              <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
              <Button type="submit" disabled={bulkSaving || !csvFile}>
                {bulkSaving ? 'Processing CSV…' : 'Upload and create exams'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

function EmptyExams({ onCreate }) {
  return (
    <div className="p-16 text-center">
      <div className="mx-auto h-12 w-12 rounded-xl bg-stone-100 text-stone-800 flex items-center justify-center mb-3">
        <Icon.FileText className="h-6 w-6" />
      </div>
      <h3 className="text-base font-semibold text-slate-900">No exams yet</h3>
      <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
        Create an exam manually or upload a batch via CSV to start receiving verifications for your board.
      </p>
      <Button onClick={onCreate} className="mt-4">
        <Icon.Plus className="h-4 w-4 mr-1.5" />
        New exam
      </Button>
    </div>
  )
}

export default function ReviewerExams() {
  const nav = useNavigate()
  const [client, setClient] = useState(null)
  const [exams, setExams] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [creating, setCreating] = useState(false)
  const [tab, setTab] = useState('active') // 'active' | 'archived'
  const [search, setSearch] = useState('')

  // Confirm-dialog state
  const [dlg, setDlg] = useState(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      const [meRes, examsRes] = await Promise.all([
        reviewerMe(),
        listReviewerExams(),
      ])
      setClient(meRes)
      setExams(examsRes || [])
    } catch (e) {
      setErr(e?.body?.error || e?.message || 'Could not load board exams')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])



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

  const totalCandidates = useMemo(() => exams.reduce((s, e) => s + (e.candidate_count || 0), 0), [exams])
  const openExams = useMemo(() => exams.filter(isExamOngoing).length, [exams])

  const activeExams = useMemo(() => exams.filter((e) => !isExamArchived(e)), [exams])
  const archivedExams = useMemo(() => exams.filter(isExamArchived), [exams])

  const displayedExams = useMemo(() => {
    const list = tab === 'active' ? activeExams : archivedExams
    const s = search.trim().toLowerCase()
    if (!s) return list
    return list.filter((e) =>
      (e.name || '').toLowerCase().includes(s) ||
      (e.exam_code || '').toLowerCase().includes(s)
    )
  }, [tab, activeExams, archivedExams, search])

  return (
    <ReviewerShell>
      <FadeIn>
        {/* Client board hero banner matching superadmin ClientDetail */}
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
                    {client?.name || 'Board Examinations'}
                  </h1>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    {client?.visible ? <Pill tone="emerald" dot>Visible</Pill> : <Pill tone="slate" dot>Hidden</Pill>}
                    {client?.closed && <Pill tone="amber" dot>Closed</Pill>}
                    <span className="text-slate-300">·</span>
                    <span className="text-slate-600">Exam Controller Portal</span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button onClick={() => setCreating((v) => !v)}>
                  <Icon.Plus className="h-4 w-4 mr-1.5" />
                  {creating ? 'Cancel' : 'New exam'}
                </Button>
              </div>
            </div>

            <div className="mt-5 pt-5 border-t border-slate-100 grid grid-cols-3 gap-6 text-sm">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Total Exams</p>
                <p className="text-lg font-semibold text-slate-900 mt-0.5 tabular-nums">{exams.length}</p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Open / Live</p>
                <p className="text-lg font-semibold text-emerald-700 mt-0.5 tabular-nums">{openExams}</p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Enrolled Candidates</p>
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
                onCancel={() => setCreating(false)}
                onCreated={async (examId) => {
                  setCreating(false)
                  await refresh()
                  if (examId) nav(`/reviewer/exams/${examId}`)
                }}
                onBulkCreated={async () => {
                  setCreating(false)
                  await refresh()
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

          <div className="w-full sm:w-64">
            <Input
              type="search"
              placeholder="Search by code or name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-white text-xs"
            />
          </div>
        </div>

        {tab === 'archived' && (
          <p className="text-xs text-slate-500 mb-3">
            Exams with expired verification windows or ended status. Extending an exam's window to a future date will automatically unarchive it.
          </p>
        )}

        <Card>
          <CardBody className="p-0">
            {loading ? (
              <div className="p-12 text-center text-sm text-slate-500">Loading exams…</div>
            ) : displayedExams.length === 0 ? (
              tab === 'active' ? (
                exams.length === 0 ? (
                  <EmptyExams onCreate={() => setCreating(true)} />
                ) : (
                  <div className="p-10 text-center">
                    <p className="text-sm text-slate-600 font-medium">No active or upcoming exams.</p>
                    <p className="text-xs text-slate-400 mt-1">
                      All exams under your board are archived ({archivedExams.length}). You can create a new exam or extend an archived exam's verification window.
                    </p>
                  </div>
                )
              ) : (
                <div className="p-10 text-center">
                  <p className="text-sm text-slate-600 font-medium">No archived exams.</p>
                  <p className="text-xs text-slate-400 mt-1">
                    Exams whose verification window has passed or that are ended will automatically appear here.
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
                              to={`/reviewer/exams/${e.id}`}
                              className="font-mono text-xs font-semibold text-indigo-700 hover:underline tabular-nums"
                            >
                              {e.exam_code}
                            </Link>
                          </td>
                          <td className="px-5 py-3.5 font-medium text-slate-900">{e.name}</td>
                          <td className="px-5 py-3.5 text-xs text-slate-600 tabular-nums whitespace-nowrap">
                            {dateRange(e.verification_from, e.verification_to)}
                          </td>
                          <td className="px-5 py-3.5 text-slate-700 tabular-nums font-mono">{e.candidate_count ?? 0}</td>
                          <td className="px-5 py-3.5">
                            <div className="flex gap-1.5 flex-wrap">
                              {tab === 'archived' ? (
                                <>
                                  {e.closed && <Pill tone="amber" dot>Ended</Pill>}
                                  {isExpired && !e.closed && <Pill tone="amber" dot>Window Expired</Pill>}
                                </>
                              ) : (
                                <>
                                  {ongoing && <Pill tone="emerald" dot>Live</Pill>}
                                  {!ongoing && !e.closed && <Pill tone="blue" dot>Upcoming</Pill>}
                                </>
                              )}
                            </div>
                          </td>
                          <td className="px-5 py-3.5">
                            <div className="flex justify-end gap-1.5">
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
                                to={`/reviewer/exams/${e.id}`}
                                className="inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-lg bg-stone-900 text-white hover:bg-stone-800 transition-colors"
                                title="Open this exam's detail page to upload CSVs, edit window, and manage candidates"
                              >
                                Manage
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
    </ReviewerShell>
  )
}
