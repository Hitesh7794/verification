import { useEffect, useState } from 'react'
import { Button } from '../ui/ui.jsx'
import { iris, IrisError } from '../../lib/verify/iris.js'
import { postIrisMatch } from '../../lib/api.js'

// IrisCapture is the fallback used when fingerprint match fails.
// Operator triggers a single-eye capture via the local Marvis daemon
// (localhost:8031); the raw bitmap is then POSTed to the backend, which
// forwards it to the TrustView hosted compare API for the actual 1:1
// match. Threshold is TrustView's unified 0..100 scale (50 = threshold).
//
// Before the TrustView migration (Aug 2026), matching happened locally
// on the operator laptop via /marvisauth/match. The move to server-side
// compare lets us swap engines without touching the operator laptop.
//
// Iris was never enrolled server-side so the backend currently returns
// `gallery_missing: true` for every roll — the UI treats that as
// "audit-only capture", same UX as the previous no-gallery path.
//
// We keep the leftQuality/leftScore/leftBmp field names on the result
// object so Dashboard.jsx's submit body + verifications.iris_left_*
// columns don't need to change. Marvis SDK v1.4 captures one eye per
// invocation — the "right*" slots stay null.
//
// Auto-heartbeat: polls /marvisauth/info every 2s to detect whether
// the local daemon is up.

export default function IrisCapture({
  rollNo,                   // REQUIRED — backend needs it for gallery lookup
  matchThreshold = 50,      // unified 0..100 score gate (TrustView default)
  quality = 55,             // min capture quality (1..100), passed to /capture
  timeoutMs = 10000,        // wall-clock capture timeout
  onResult,                 // (result) => void
}) {
  const [status, setStatus] = useState('checking') // checking|service_down|ready|capturing|error
  const [device, setDevice] = useState(null)       // { model, serial } from /info
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  // NO mount /info -- every /info call the SDK accumulates as
  // internal state, and after ~5-10 verifications the daemon starts
  // returning -2014 "Device Already Initialized" on the next capture.
  // /capture auto-inits from a clean state, so we let the SDK manage
  // its own lifecycle and only touch it when the operator clicks
  // Capture (or Reset). Trade-off: we can't display device serial /
  // model until AFTER first capture (or the operator hits Reset).
  useEffect(() => {
    setStatus('ready')
    return () => {
      // Best-effort release on unmount so a page nav doesn't leave
      // the device holding state across tabs.
      iris.uninit().catch(() => {})
    }
  }, [])

  // Manual "Reset iris device" button handler. Runs uninit + info
  // via iris.reset(); surfaces success or a helpful error banner.
  async function onReset() {
    setError(null)
    setStatus('capturing')
    try {
      const env = await iris.reset()
      setDevice({
        model:  env?.Model  || env?.DeviceModel  || '',
        serial: env?.SerialNo || env?.SerialNumber || '',
      })
      setStatus('ready')
    } catch (e) {
      setStatus('error')
      setError(e)
    }
  }

  async function onCapture() {
    setBusy(true)
    setError(null)
    setResult(null)
    setStatus('capturing')
    try {
      // Step 1: capture locally via Marvis daemon on localhost:8031.
      const cap = await iris.capture({ quality, timeoutMs })

      // Step 2: forward the raw bitmap to the backend, which forwards
      // to TrustView. If we don't have a rollNo (dev/preview mode)
      // skip the compare and record capture as audit-only.
      let matched = null // null = no compare attempted
      let score = null
      let engine = ''
      let galleryMissing = true // default when we skip the POST
      if (rollNo) {
        try {
          const resp = await postIrisMatch(rollNo, cap.BitmapData || '', {
            serial: device?.serial || '',
            model:  device?.model  || '',
          })
          galleryMissing = !!resp.gallery_missing
          if (!galleryMissing) {
            score = num(resp.score)
            matched = !!resp.matched && score != null && score >= matchThreshold
            engine = resp.engine || ''
          }
        } catch (e) {
          // A compare failure shouldn't lose the operator's capture —
          // fall through with matched=null so the row still records the
          // audit evidence. Surface the error as a soft banner.
          setError(e)
        }
      }

      // Keep the old result-object contract so Dashboard.jsx's submit
      // body and the verifications.iris_* columns don't need to
      // change. Single-eye capture → populate 'left*', leave 'right*'
      // NULL.
      const out = {
        ok: matched,
        captured: true,
        galleryMissing,
        engine,
        deviceSerial: device?.serial || '',
        deviceModel:  device?.model  || '',
        leftQuality:  num(cap.Quality),
        rightQuality: null,
        leftScore:    score,
        rightScore:   null,
        threshold:    matchThreshold,
        leftBmp:      cap.BitmapData || null,
        rightBmp:     null,
      }
      setResult(out)
      onResult?.(out)
      setStatus('ready')
    } catch (e) {
      setError(e)
      if (e instanceof IrisError && e.kind === 'service') {
        setStatus('service_down')
      } else if (e instanceof IrisError && e.kind === 'device') {
        setStatus('error')
      } else {
        setStatus('error')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <Banner status={status} device={device} error={error} />

      {result?.leftBmp && (
        <div className="rounded-lg bg-slate-100 overflow-hidden flex items-center justify-center aspect-video">
          <img
            src={`data:image/bmp;base64,${result.leftBmp}`}
            alt="captured iris"
            className="max-h-64 object-contain"
          />
        </div>
      )}

      {result && <ResultSummary r={result} />}

      {error && (
        <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
          {error instanceof IrisError ? `${error.code}: ${error.description}` : error.message}
        </div>
      )}

      <div className="flex gap-2 justify-center">
        {result ? (
          <Button variant="secondary" onClick={() => { setResult(null); setError(null) }}>
            Recapture
          </Button>
        ) : (
          <Button onClick={onCapture} disabled={status !== 'ready' || busy}>
            {busy ? 'Capturing iris…' : 'Capture iris'}
          </Button>
        )}
        <Button
          variant="secondary"
          onClick={onReset}
          disabled={busy}
          title="Force-release the iris device -- click this if you see 'Device Already Initialized' errors"
        >
          Reset device
        </Button>
      </div>
    </div>
  )
}

// num safely coerces vendor numeric-string quirks to a real Number or
// null. Vendor sample sometimes returns "0.85" as a string; sometimes
// as a JSON number. Handle both without exploding.
function num(v) {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function Banner({ status, device, error }) {
  const cfg = bannerFor(status, device, error)
  return (
    <div className={`flex items-center gap-3 rounded-lg border px-3 py-2 text-sm ${cfg.tone}`}>
      <span className={`h-2.5 w-2.5 rounded-full ${cfg.dot}`} />
      <span className="font-medium">{cfg.title}</span>
      {cfg.detail && <span className="text-slate-500">— {cfg.detail}</span>}
    </div>
  )
}

function bannerFor(status, device, error) {
  switch (status) {
    case 'ready':
      return {
        tone: 'border-emerald-200 bg-emerald-50 text-emerald-800',
        dot: 'bg-emerald-500',
        title: 'Iris device ready',
        detail: device?.model || device?.serial
          ? `${device.model}${device.serial ? ' · ' + device.serial : ''}`
          : '',
      }
    case 'capturing':
      return {
        tone: 'border-indigo-200 bg-indigo-50 text-indigo-800',
        dot: 'bg-indigo-500 animate-pulse',
        title: 'Look at the iris device…',
        detail: '',
      }
    case 'service_down':
      return {
        tone: 'border-rose-200 bg-rose-50 text-rose-800',
        dot: 'bg-rose-500',
        title: 'Iris service not running',
        detail: 'Ask IT to start MarvisAuthClientService on this laptop',
      }
    case 'error':
      return {
        tone: 'border-rose-200 bg-rose-50 text-rose-800',
        dot: 'bg-rose-500',
        title: 'Iris device error',
        detail: error?.description || error?.message || '',
      }
    default:
      return {
        tone: 'border-slate-200 bg-slate-50 text-slate-700',
        dot: 'bg-slate-400',
        title: 'Checking iris device…',
        detail: '',
      }
  }
}

function ResultSummary({ r }) {
  const matched = r.ok
  const noMatchAttempted = r.ok === null
  return (
    <div
      className={`rounded-lg border p-3 text-sm ${
        noMatchAttempted
          ? 'border-amber-200 bg-amber-50 text-amber-800'
          : matched
          ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
          : 'border-rose-200 bg-rose-50 text-rose-800'
      }`}
    >
      <p className="font-semibold">
        {noMatchAttempted
          ? 'Iris captured (no enrolled template — record for audit)'
          : matched
          ? 'Iris match'
          : 'Iris did not match'}
      </p>
      <p className="text-xs mt-1 text-slate-600">
        quality {r.leftQuality ?? '—'}
        {r.leftScore != null && (
          <> · score {r.leftScore.toFixed(3)} · threshold {r.threshold}</>
        )}
      </p>
    </div>
  )
}
