import { useEffect, useState } from 'react'
import { Button } from '../ui/ui.jsx'
import { iris, IrisError, isIrisServiceReachable } from '../../lib/verify/iris.js'
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
  timeoutSec = 15,          // capture timeout in seconds (Marvis SDK unit)
  onResult,                 // (result) => void
}) {
  // Initial status is 'idle' — we deliberately do NOT probe the
  // Marvis daemon at mount (each /info call accumulates SDK state
  // and after ~5-10 verifications the daemon returns -2014 "Device
  // Already Initialized"). So we can't honestly claim "ready" up
  // front — the device presence is only proven when the operator
  // clicks Capture (or Reset). Idle uses a neutral slate banner
  // that doesn't lie about device state; 'ready' is only set after
  // an actual successful capture or a manual Reset.
  const [status, setStatus] = useState('idle') // idle|service_down|ready|capturing|error
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
    // Reachability probe — does the Marvis daemon respond at all on
    // localhost:8031? This does NOT touch any SDK endpoint (info /
    // capture / uninit) so it doesn't accumulate state; only a
    // socket-level failure flips us to 'service_down'. The narrower
    // "device attached / not attached" distinction still isn't
    // probed at mount (needs /info, which is what breaks captures)
    // — that surfaces from an actual Capture click.
    let cancelled = false
    isIrisServiceReachable().then((reachable) => {
      if (cancelled) return
      if (!reachable) setStatus('service_down')
      // reachable → leave as 'idle' (we don't claim ready without
      // proof from a successful capture).
    })
    return () => {
      cancelled = true
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
      setError(e)
      // Distinguish "service unreachable" from other errors so the
      // banner tone matches — mirrors onCapture's error handling.
      if (e instanceof IrisError && e.kind === 'service') {
        setStatus('service_down')
      } else {
        setStatus('error')
      }
    }
  }

  async function onCapture() {
    setBusy(true)
    setError(null)
    setResult(null)
    setStatus('capturing')
    try {
      // Step 1: capture locally via Marvis daemon on localhost:8031.
      const cap = await iris.capture({ quality, timeoutSec })

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

      {/* Preview + prompt area — same shape as FingerprintCapture's
          dashed placeholder so the two capture cards read as one visual
          family. Gives the operator a target zone even before capture
          starts ("look at the iris device"), morphs into a spinner
          during capture, and lands the captured BMP inline afterwards.
          max-w-xs mx-auto keeps the tile a comfortable size on wide
          layouts and doesn't fight the containing card's padding. */}
      <div className="aspect-square w-full max-w-xs mx-auto rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 flex flex-col items-center justify-center text-center p-6">
        {result?.leftBmp ? (
          <img
            src={`data:image/bmp;base64,${result.leftBmp}`}
            alt="captured iris"
            className="w-full h-full object-contain"
          />
        ) : busy || status === 'capturing' ? (
          <>
            <div className="h-12 w-12 rounded-full border-4 border-indigo-200 border-t-indigo-600 animate-spin" />
            <p className="mt-3 text-sm text-slate-600">Look at the iris device…</p>
          </>
        ) : status === 'ready' ? (
          <>
            <p className="text-sm font-medium text-slate-700">Device ready</p>
            <p className="text-xs text-slate-500 mt-1">
              {device?.model || ''}
              {device?.serial ? ` · ${device.serial}` : ''}
            </p>
          </>
        ) : status === 'service_down' || status === 'error' ? (
          <p className="text-sm text-slate-500">See message above</p>
        ) : (
          // idle — no probe has run yet. Tell the operator to
          // capture; device presence is only known after that.
          <p className="text-sm text-slate-500">Click Capture iris to start</p>
        )}
      </div>

      {result && <ResultSummary r={result} />}

      {error && (
        <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
          {error instanceof IrisError ? `${error.code}: ${error.description}` : error.message}
        </div>
      )}

      {/* Action row — mirrors FingerprintCapture's structure: full-
          width primary button on top, secondary (Reset device) full-
          width below, so both cards align at the bottom regardless
          of how many buttons the modality has. */}
      <div className="flex flex-col gap-2">
        {result ? (
          <Button variant="secondary" className="w-full" onClick={() => { setResult(null); setError(null) }}>
            Recapture
          </Button>
        ) : (
          <Button
            className="w-full"
            onClick={onCapture}
            // Enabled when idle too — that's the whole point of not
            // pre-probing: readiness is proven by the capture attempt.
            // Only block during a capture-in-flight or a known-bad
            // state (service_down / error) that the operator hasn't
            // dismissed via Reset device.
            disabled={busy || status === 'service_down' || status === 'error'}
          >
            {busy ? 'Capturing iris…' : 'Capture iris'}
          </Button>
        )}
        <Button
          variant="secondary"
          className="w-full"
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
      // Detail intentionally empty — matches FingerprintCapture. The
      // longer "Ask IT to start MarvisAuthClientService…" copy wrapped
      // to two lines in the narrower iris card and broke the banner
      // layout. Title alone is clear enough.
      return {
        tone: 'border-rose-200 bg-rose-50 text-rose-800',
        dot: 'bg-rose-500',
        title: 'Iris service not running',
        detail: '',
      }
    case 'error':
      return {
        tone: 'border-rose-200 bg-rose-50 text-rose-800',
        dot: 'bg-rose-500',
        title: 'Iris device error',
        detail: error?.description || error?.message || '',
      }
    default:
      // 'idle' — we haven't probed the daemon (probing accumulates
      // SDK state and breaks captures after ~10 rounds), so we can't
      // claim ready. Honest neutral banner, single-line shape to
      // match FingerprintCapture. Placeholder tile below carries the
      // "Click Capture iris to start" prompt so the banner stays
      // tight and doesn't wrap on narrow cards.
      return {
        tone: 'border-slate-200 bg-slate-50 text-slate-700',
        dot: 'bg-slate-400',
        title: 'Iris scanner',
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
      {/* Score + threshold removed — operators get pass/fail from the
          heading above; quality stays because it's a capture-time
          signal, not a match figure. */}
      <p className="text-xs mt-1 text-slate-600">
        quality {r.leftQuality ?? '—'}
      </p>
    </div>
  )
}
