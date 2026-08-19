import { useRef, useState } from 'react'
import { Button, Card, CardBody } from '../../components/ui/ui.jsx'
import { bulkUploadBiometrics } from '../../lib/superadmin/examCatalog.js'

// Four-card bulk-upload panel that sits on ExamDetail. Superadmin
// drops a .zip per modality, backend streams every entry straight
// into S3 keyed by <exam_code>/<modality>/<roll>.<ext>, DB flags
// flip, and the operator UI sees the newly-enrolled biometrics on
// the very next lookup — no restart.
//
// Cards for a modality the exam doesn't require (requires_face=false
// etc.) render dimmed with a hint pointing at exam settings; we
// leave them visible so the operator sees the full grid every time
// and remembers the modalities exist.
//
// Filename convention is strict: <roll>.<ext>. Anything else shows
// up in the per-file result table as a red row with the reason —
// operator can iterate without having to re-upload the successes.

const MODALITIES = [
  {
    key:   'photos',
    label: 'Photos',
    hint:  'JPG or PNG · one per candidate · filename = <roll>.jpg',
    exts:  '.jpg,.jpeg,.png',
    requires: (exam) => exam.requires_face !== false,
  },
  {
    key:   'fp-images',
    label: 'Fingerprint images',
    hint:  'BMP / WSQ / JPG · raw fingerprint capture · filename = <roll>.<ext>',
    exts:  '.bmp,.wsq,.jpg,.jpeg,.png',
    requires: (exam) => !!exam.requires_fp,
  },
  {
    key:   'fp-templates',
    label: 'Fingerprint templates',
    hint:  'ISO / FMR / ANSI · pre-extracted template · filename = <roll>.<ext>',
    exts:  '.iso,.fmr,.ansi,.bin',
    requires: (exam) => !!exam.requires_fp,
  },
  {
    key:   'iris',
    label: 'Iris',
    hint:  'ISO / K7 / BMP · iris capture · filename = <roll>.<ext>',
    exts:  '.iso,.k7,.bmp,.bin',
    requires: (exam) => !!exam.requires_iris,
  },
]

export default function BulkBiometricUpload({ examId, exam, onUploaded }) {
  return (
    <Card className="mb-6">
      <CardBody>
        <div className="mb-3">
          <h3 className="text-sm font-semibold text-slate-900">Bulk biometric upload</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Zip up one modality at a time, filenames as{' '}
            <code className="text-[11px] bg-slate-100 px-1 py-0.5 rounded">&lt;roll&gt;.&lt;ext&gt;</code>.
            Rolls not present in this exam's CSV are skipped with a reason.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {MODALITIES.map((m) => (
            <ModalityCard
              key={m.key}
              examId={examId}
              modality={m}
              enabled={m.requires(exam)}
              onUploaded={onUploaded}
            />
          ))}
        </div>
      </CardBody>
    </Card>
  )
}

function ModalityCard({ examId, modality, enabled, onUploaded }) {
  const [pct, setPct]     = useState(0)   // 0..100 upload progress
  const [busy, setBusy]   = useState(false)
  const [result, setResult] = useState(null) // { total, uploaded, skipped, errors, per_file }
  const [err, setErr]       = useState('')

  // Handle to the in-flight upload's cancel() so the "Cancel" button
  // can abort a huge upload mid-flight. Also lets us clear a picked
  // file input by resetting the ref (Reset button).
  const controllerRef = useRef(null)
  const fileInputRef  = useRef(null)

  async function pickAndUpload(file) {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.zip')) {
      setErr('please pick a .zip archive')
      return
    }
    setErr('')
    setResult(null)
    setPct(0)
    setBusy(true)
    const ctl = bulkUploadBiometrics(examId, modality.key, file, (p) => setPct(p))
    controllerRef.current = ctl
    try {
      const r = await ctl.promise
      setResult(r)
      onUploaded?.(r)
    } catch (e) {
      // Canceled uploads are quiet — no red banner, the user asked
      // for the abort themselves.
      if (!e.canceled) setErr(e.message || 'upload failed')
    } finally {
      setBusy(false)
      controllerRef.current = null
    }
  }

  function cancel() {
    if (controllerRef.current) controllerRef.current.cancel()
  }

  function resetCard() {
    setErr('')
    setResult(null)
    setPct(0)
    // Clear the underlying file input so re-picking the same file
    // fires onChange again (browsers dedup identical filenames).
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  // Card body colouring: enabled = normal white, disabled = dimmed
  // slate so it's obviously off but still discoverable.
  const cardTone = enabled
    ? 'bg-white ring-1 ring-warm hover:shadow-sm'
    : 'bg-slate-50 ring-1 ring-slate-200 opacity-70'

  return (
    <div className={`rounded-xl p-4 transition-shadow ${cardTone}`}>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-slate-900">{modality.label}</p>
        <p className="text-[11px] text-slate-500 mt-1">{modality.hint}</p>
      </div>

      {!enabled && (
        <p className="mt-3 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5">
          Not required for this exam — enable in exam settings above to activate.
        </p>
      )}

      {enabled && (
        <div className="mt-3">
          {/* Primary + secondary controls on one row so the card height
              stays predictable across idle / busy / done states.
              Idle:  [Select .zip]
              Busy:  [Uploading…]  [Cancel]
              Done:  [Select .zip] [Delete] */}
          <div className="flex items-center gap-2 flex-wrap">
            <label className={`inline-flex items-center rounded-lg px-3 py-2 text-xs font-medium cursor-pointer transition-colors ${
              busy
                ? 'bg-slate-100 text-slate-500 cursor-wait'
                : 'bg-stone-900 text-white hover:bg-stone-800'
            }`}>
              {busy ? 'Uploading…' : 'Select .zip'}
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip,application/zip"
                className="hidden"
                disabled={busy}
                onChange={(e) => pickAndUpload(e.target.files?.[0])}
              />
            </label>

            {busy && (
              <button
                type="button"
                onClick={cancel}
                className="inline-flex items-center rounded-lg border border-rose-300 bg-white text-rose-700 hover:bg-rose-50 px-3 py-2 text-xs font-medium transition-colors"
                title="Abort this upload — nothing that already reached the server will be undone"
              >
                Cancel
              </button>
            )}

            {!busy && (result || err) && (
              <button
                type="button"
                onClick={resetCard}
                className="inline-flex items-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 px-3 py-2 text-xs font-medium transition-colors"
                title="Clear this card's result table so the next upload starts fresh"
              >
                Delete
              </button>
            )}
          </div>

          {busy && (
            <div className="mt-2">
              <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-500 transition-all duration-200"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <p className="text-[10px] text-slate-500 mt-1 tabular-nums">
                {pct < 100 ? `Uploading ${pct}%` : 'Server processing zip…'}
              </p>
            </div>
          )}

          {err && (
            <p className="mt-2 text-xs text-rose-700">{err}</p>
          )}

          {result && !busy && <ResultSummary result={result} />}
        </div>
      )}
    </div>
  )
}

function ResultSummary({ result }) {
  const [showAll, setShowAll] = useState(false)
  const rows = showAll ? result.per_file : result.per_file.slice(0, 5)
  const hasMore = result.per_file.length > 5 && !showAll

  return (
    <div className="mt-3">
      <div className="flex items-center gap-2 flex-wrap text-[11px]">
        <span className="rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 px-2 py-0.5 font-medium tabular-nums">
          {result.uploaded} uploaded
        </span>
        {result.skipped > 0 && (
          <span className="rounded-full bg-amber-50 border border-amber-200 text-amber-800 px-2 py-0.5 font-medium tabular-nums">
            {result.skipped} skipped
          </span>
        )}
        {result.errors > 0 && (
          <span className="rounded-full bg-rose-50 border border-rose-200 text-rose-700 px-2 py-0.5 font-medium tabular-nums">
            {result.errors} error{result.errors === 1 ? '' : 's'}
          </span>
        )}
        <span className="text-slate-400">·</span>
        <span className="text-slate-500 tabular-nums">{result.total} total</span>
      </div>

      {result.per_file.length > 0 && (
        <div className="mt-2 rounded-md border border-slate-200 overflow-hidden">
          <table className="w-full text-[11px]">
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={i}
                  className={`border-b border-slate-100 last:border-none ${
                    r.status === 'ok' ? 'bg-emerald-50/40'
                    : r.status === 'skipped' ? 'bg-amber-50/40'
                    : 'bg-rose-50/40'
                  }`}
                >
                  <td className="px-2 py-1.5 w-4">
                    {r.status === 'ok' && <span className="text-emerald-600">✓</span>}
                    {r.status === 'skipped' && <span className="text-amber-600">◔</span>}
                    {r.status === 'error' && <span className="text-rose-600">✗</span>}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-slate-700 truncate max-w-[120px]" title={r.filename}>
                    {r.filename}
                  </td>
                  <td className="px-2 py-1.5 text-slate-500 truncate" title={r.reason || ''}>
                    {r.reason || (r.status === 'ok' ? `${prettyBytes(r.bytes)} → S3` : '')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {hasMore && (
            <div className="text-center border-t border-slate-100">
              <Button variant="ghost" size="sm" onClick={() => setShowAll(true)}>
                Show all {result.per_file.length} files
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function prettyBytes(n) {
  if (!n) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
