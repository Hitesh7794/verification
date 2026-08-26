import { useCallback, useEffect, useMemo, useState } from 'react'
import ReviewerShell, { ReviewerPageHead } from '../../components/reviewer/ReviewerShell.jsx'
import { Button, Card, CardBody, Input, Label } from '../../components/ui/ui.jsx'
import { Icon, Pill } from '../../components/ui/extras.jsx'
import { FadeIn } from '../../components/ui/motion.jsx'
import {
  listReviewerExams,
  createReviewerExam,
  bulkCreateReviewerExamsCSV,
  downloadSampleExamCSV,
} from '../../lib/reviewer/api.js'

function formatShortDateTime(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    return d.toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
  } catch {
    return String(iso).slice(0, 16).replace('T', ' ')
  }
}

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
                    placeholder="e.g. NET-2026-01"
                    maxLength={60}
                    required
                    className="font-mono uppercase tracking-wide"
                  />
                  <p className="text-[11px] text-slate-500 mt-1">Globally unique. Uppercase, no spaces.</p>
                </div>
              </div>
            </FormSection>

            <FormSection num="2" title="Verification Window" hint="Colleges can only verify candidates for this exam inside this date & time range.">
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

            <FormSection num="3" title="Biometric Requirements" hint="Which biometrics the verification agent must capture for candidate verification.">
              <div className="flex flex-wrap gap-6 pt-1">
                <label className="inline-flex items-center gap-2 text-sm text-slate-700 font-medium cursor-pointer">
                  <input
                    type="checkbox"
                    checked={reqFace}
                    onChange={(e) => setReqFace(e.target.checked)}
                    className="rounded border-slate-300 text-stone-900 focus:ring-stone-700"
                  />
                  Face match
                </label>
                <label className="inline-flex items-center gap-2 text-sm text-slate-700 font-medium cursor-pointer">
                  <input
                    type="checkbox"
                    checked={reqFP}
                    onChange={(e) => setReqFP(e.target.checked)}
                    className="rounded border-slate-300 text-stone-900 focus:ring-stone-700"
                  />
                  Fingerprint match
                </label>
                <label className="inline-flex items-center gap-2 text-sm text-slate-700 font-medium cursor-pointer">
                  <input
                    type="checkbox"
                    checked={reqIris}
                    onChange={(e) => setReqIris(e.target.checked)}
                    className="rounded border-slate-300 text-stone-900 focus:ring-stone-700"
                  />
                  Iris match
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
            {/* Step 1: Download Sample Template */}
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="min-w-0">
                  <h4 className="text-sm font-semibold text-slate-900">1. CSV Template & Format Guidelines</h4>
                  <p className="text-xs text-slate-500 mt-1 max-w-xl">
                    Required headers: <code className="bg-slate-200/80 px-1 py-0.5 rounded text-slate-800 font-mono text-[11px]">exam_name</code>, <code className="bg-slate-200/80 px-1 py-0.5 rounded text-slate-800 font-mono text-[11px]">exam_code</code>, <code className="bg-slate-200/80 px-1 py-0.5 rounded text-slate-800 font-mono text-[11px]">verification_from</code>, <code className="bg-slate-200/80 px-1 py-0.5 rounded text-slate-800 font-mono text-[11px]">verification_to</code>.
                    <br />
                    Optional biometrics: <code className="bg-slate-200/80 px-1 py-0.5 rounded text-slate-800 font-mono text-[11px]">requires_face</code>, <code className="bg-slate-200/80 px-1 py-0.5 rounded text-slate-800 font-mono text-[11px]">requires_fp</code>, <code className="bg-slate-200/80 px-1 py-0.5 rounded text-slate-800 font-mono text-[11px]">requires_iris</code> (<code className="text-slate-700">yes</code> / <code className="text-slate-700">no</code>).
                  </p>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={downloadSampleExamCSV}
                  className="bg-white hover:bg-slate-100 text-slate-800 shadow-sm shrink-0"
                >
                  <Icon.Download className="h-4 w-4 mr-1.5 text-slate-600" />
                  Download sample CSV
                </Button>
              </div>
            </div>

            {/* Step 2: Upload CSV Dropzone */}
            <div>
              <h4 className="text-sm font-semibold text-slate-900 mb-2">2. Upload your CSV file</h4>
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleFileDrop}
                className={`relative flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 transition-colors text-center ${
                  dragOver
                    ? 'border-stone-900 bg-stone-50/50'
                    : 'border-slate-300 hover:border-slate-400 bg-white'
                }`}
              >
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) {
                      setCsvFile(file)
                      setBulkErr('')
                      setValidationErrors([])
                    }
                  }}
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                />
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-600 mb-3">
                  <Icon.Upload className="h-6 w-6" />
                </div>
                <p className="text-sm font-semibold text-slate-800">
                  {csvFile ? csvFile.name : 'Choose a CSV file or drag and drop here'}
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  {csvFile
                    ? `${(csvFile.size / 1024).toFixed(1)} KB — Click or drop another file to replace`
                    : 'Only .csv files up to 20 MB are supported'}
                </p>
                {csvFile && (
                  <div className="mt-3 flex items-center gap-2">
                    <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-600/20">
                      <Icon.Check className="h-3.5 w-3.5" />
                      Ready to upload
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        setCsvFile(null)
                        setValidationErrors([])
                        setBulkErr('')
                      }}
                      className="text-xs text-slate-500 hover:text-rose-600 underline ml-2"
                    >
                      Remove
                    </button>
                  </div>
                )}
              </div>
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

export default function ReviewerExams() {
  const [exams, setExams] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [search, setSearch] = useState('')
  const [showCreate, setShowCreate] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      const data = await listReviewerExams()
      setExams(data || [])
    } catch (e) {
      setErr(e?.body?.error || e?.message || 'Could not load exams')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const filteredExams = useMemo(() => {
    const s = search.trim().toLowerCase()
    if (!s) return exams
    return exams.filter((e) =>
      (e.name || '').toLowerCase().includes(s) ||
      (e.exam_code || '').toLowerCase().includes(s)
    )
  }, [exams, search])

  const activeCount = useMemo(() => exams.filter((e) => !e.closed).length, [exams])
  const closedCount = useMemo(() => exams.filter((e) => e.closed).length, [exams])

  return (
    <ReviewerShell>
      <FadeIn>
        <ReviewerPageHead
          eyebrow="Exam Management"
          title="Board Exams"
          subtitle="Manage exams under your exam board. Create individual exams or upload bulk rosters via CSV."
          right={
            <Button
              onClick={() => setShowCreate((v) => !v)}
              className="shadow-sm"
            >
              {showCreate ? (
                <>
                  <Icon.X className="h-4 w-4 mr-1.5" />
                  Close form
                </>
              ) : (
                <>
                  <Icon.Plus className="h-4 w-4 mr-1.5" />
                  New exam
                </>
              )}
            </Button>
          }
        />

        {showCreate && (
          <NewExamForm
            onCancel={() => setShowCreate(false)}
            onCreated={() => {
              setShowCreate(false)
              load()
            }}
            onBulkCreated={() => {
              setShowCreate(false)
              load()
            }}
          />
        )}

        {/* Filter and stats bar */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div className="w-full sm:w-72">
            <Input
              type="search"
              placeholder="Search exams by name or code…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-white"
            />
          </div>
          <div className="flex items-center gap-3 text-xs text-slate-500">
            <span className="font-medium text-slate-700">
              Total: <strong className="text-slate-900">{exams.length}</strong>
            </span>
            <span>·</span>
            <span className="text-emerald-700 font-medium">
              Active: <strong>{activeCount}</strong>
            </span>
            {closedCount > 0 && (
              <>
                <span>·</span>
                <span className="text-slate-500">
                  Closed: <strong>{closedCount}</strong>
                </span>
              </>
            )}
          </div>
        </div>

        {err && (
          <div role="alert" className="mb-6 rounded-xl bg-rose-50 border border-rose-200 p-4 text-sm text-rose-800">
            {err}
          </div>
        )}

        {loading ? (
          <div className="p-16 text-center text-sm text-slate-500 bg-white rounded-2xl border border-warm shadow-sm">
            <div className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-stone-900 border-r-transparent mb-2" />
            <p>Loading exams…</p>
          </div>
        ) : filteredExams.length === 0 ? (
          <Card className="border-warm shadow-sm">
            <CardBody className="p-16 text-center">
              <div className="mx-auto h-14 w-14 rounded-2xl bg-slate-100 text-slate-400 flex items-center justify-center mb-4">
                <Icon.FileText className="h-7 w-7" />
              </div>
              <h3 className="text-base font-semibold text-slate-900">
                {search ? 'No matching exams found' : 'No exams created yet'}
              </h3>
              <p className="text-sm text-slate-500 mt-1 max-w-md mx-auto">
                {search
                  ? `No exams matched "${search}". Try searching for another keyword or clear the search input.`
                  : 'Get started by creating your first exam manually or uploading a batch using a CSV file.'}
              </p>
              {!search && (
                <Button className="mt-5" onClick={() => setShowCreate(true)}>
                  <Icon.Plus className="h-4 w-4 mr-1.5" />
                  Create first exam
                </Button>
              )}
            </CardBody>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4">
            {filteredExams.map((exam) => (
              <div
                key={exam.id}
                className="rounded-2xl bg-white border border-stone-200/80 p-5 shadow-sm hover:shadow-md transition-shadow"
              >
                <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
                  <div>
                    <div className="flex items-center gap-2.5">
                      <h3 className="text-base font-bold text-slate-900">{exam.name}</h3>
                      <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-stone-100 border border-stone-200 text-xs font-mono font-semibold text-stone-800 tracking-wide">
                        {exam.exam_code}
                      </span>
                    </div>
                    {exam.client_name && (
                      <p className="text-xs text-slate-500 mt-0.5">Exam Body: {exam.client_name}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {exam.closed ? (
                      <Pill variant="neutral">Closed</Pill>
                    ) : (
                      <Pill variant="success">Active</Pill>
                    )}
                    {exam.visible ? (
                      <span className="text-[11px] font-medium text-slate-500 bg-slate-100 px-2 py-0.5 rounded-md">
                        Visible
                      </span>
                    ) : (
                      <span className="text-[11px] font-medium text-amber-700 bg-amber-50 px-2 py-0.5 rounded-md border border-amber-200">
                        Hidden
                      </span>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 pt-3 border-t border-slate-100 text-xs">
                  <div>
                    <span className="text-slate-500 block">Verification Window:</span>
                    <span className="font-medium text-slate-800 mt-0.5 block">
                      {formatShortDateTime(exam.verification_from)} → {formatShortDateTime(exam.verification_to)}
                    </span>
                  </div>

                  <div>
                    <span className="text-slate-500 block">Candidate Roster:</span>
                    <span className="font-medium text-slate-800 mt-0.5 block">
                      {exam.candidate_count ?? 0} candidate(s) enrolled
                    </span>
                  </div>

                  <div>
                    <span className="text-slate-500 block mb-1">Required Biometrics:</span>
                    <div className="flex flex-wrap gap-1.5">
                      {exam.requires_face && (
                        <span className="inline-flex items-center gap-1 rounded bg-stone-100 px-1.5 py-0.5 text-[11px] font-medium text-stone-700">
                          Face
                        </span>
                      )}
                      {exam.requires_fp && (
                        <span className="inline-flex items-center gap-1 rounded bg-stone-100 px-1.5 py-0.5 text-[11px] font-medium text-stone-700">
                          Fingerprint
                        </span>
                      )}
                      {exam.requires_iris && (
                        <span className="inline-flex items-center gap-1 rounded bg-stone-100 px-1.5 py-0.5 text-[11px] font-medium text-stone-700">
                          Iris
                        </span>
                      )}
                      {!exam.requires_face && !exam.requires_fp && !exam.requires_iris && (
                        <span className="text-slate-400">None specified</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </FadeIn>
    </ReviewerShell>
  )
}
