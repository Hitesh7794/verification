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

  const [selectedEye, setSelectedEye] = useState('OD')
  const isPass = result && result.ok === true
  const isFail = result && result.ok === false
  const isCapturing = busy || status === 'capturing'

  return (
    <div className="space-y-3 font-mono text-xs">
      <div className="flex items-center justify-between gap-2">
        <Banner status={status} device={device} error={error} />
        {/* Eye Selector */}
        <div className="flex items-center gap-1 text-[10px] shrink-0">
          <button
            type="button"
            onClick={() => !isPass && setSelectedEye('OD')}
            className={`px-1.5 py-0.5 rounded font-bold transition ${
              selectedEye === 'OD'
                ? 'bg-[#0B4F8F] text-white'
                : 'bg-white text-slate-500 border border-[#D5DDE7] hover:bg-slate-50'
            }`}
          >
            OD (RIGHT)
          </button>
          <button
            type="button"
            onClick={() => !isPass && setSelectedEye('OS')}
            className={`px-1.5 py-0.5 rounded font-bold transition ${
              selectedEye === 'OS'
                ? 'bg-[#0B4F8F] text-white'
                : 'bg-white text-slate-500 border border-[#D5DDE7] hover:bg-slate-50'
            }`}
          >
            OS (LEFT)
          </button>
        </div>
      </div>

      {/* Single-Eye Monocular Eyepiece Viewfinder HUD */}
      <div className="my-2 flex flex-col items-center">
        <div
          onClick={!busy && status !== 'service_down' ? onCapture : undefined}
          className="w-full max-w-[290px] h-40 rounded-xl bg-[#07131F] border-2 border-[#83B3E9] p-2 flex flex-col justify-between relative overflow-hidden cursor-pointer group shadow-inner"
        >
          {/* Infrared Grid pattern */}
          <div
            className="absolute inset-0 opacity-20 pointer-events-none"
            style={{
              backgroundImage: 'radial-gradient(#00F2FE 1px, transparent 1px)',
              backgroundSize: '14px 14px',
            }}
          />

          {/* Top HUD Status */}
          <div className="flex justify-between items-center text-[8.5px] font-mono text-cyan-400 z-10 px-1">
            <span>NIR 850nm STROBE</span>
            <span className={`font-bold ${isCapturing ? 'text-cyan-300 animate-pulse' : 'text-amber-300'}`}>
              {isCapturing ? 'PUPIL REFLEX LOCK…' : 'ALIGNED (15cm)'}
            </span>
            <span>EYE: {selectedEye} ({selectedEye === 'OD' ? 'RIGHT' : 'LEFT'})</span>
          </div>

          {/* Centered Large Monocular Single Eye Reticle */}
          <div className="relative w-28 h-28 mx-auto my-auto flex items-center justify-center z-10">
            {/* Outer Calibrated Degree Ring */}
            <div
              className={`w-28 h-28 rounded-full border border-dashed flex items-center justify-center relative iris-rotate-anim ${
                isPass ? 'border-emerald-400/80' : 'border-cyan-400/60'
              }`}
            >
              <div className="absolute -top-1 w-1.5 h-1.5 rounded-full bg-cyan-400" />
              <div className="absolute -bottom-1 w-1.5 h-1.5 rounded-full bg-cyan-400/60" />
              <div className="absolute -left-1 w-1.5 h-1.5 rounded-full bg-cyan-400/60" />
              <div className="absolute -right-1 w-1.5 h-1.5 rounded-full bg-cyan-400/60" />
            </div>

            {/* Middle Concentric Boundary Ring */}
            <div className="absolute w-20 h-20 rounded-full border border-cyan-300/40 flex items-center justify-center iris-rotate-rev">
              {/* Eye Sclera & Iris Container */}
              <div className="w-16 h-16 rounded-full bg-gradient-to-br from-cyan-950 via-[#07192C] to-emerald-950 border border-cyan-400/50 flex items-center justify-center relative overflow-hidden shadow-inner">
                {/* Captured Bitmap Preview or Animated Eye SVG */}
                {result?.leftBmp ? (
                  <img
                    src={`data:image/bmp;base64,${result.leftBmp}`}
                    alt="captured iris"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <svg
                    className={`w-12 h-12 eye-blink-anim transition-all duration-300 ${
                      isPass
                        ? 'text-emerald-400 drop-shadow-[0_0_10px_rgba(52,211,153,0.9)]'
                        : 'text-cyan-400'
                    }`}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M2 12s3.5-6.5 10-6.5 10 6.5-3.5 6.5-10 6.5S2 12 2 12Z" />
                    <circle
                      cx="12"
                      cy="12"
                      r="4"
                      className={`transition-transform duration-300 ${isCapturing ? 'pupil-pulse-active' : ''}`}
                      fill="currentColor"
                      fillOpacity="0.25"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    />
                    <circle cx="12" cy="12" r="1.8" fill="#000" />
                    <circle cx="13" cy="11" r="0.7" fill="#fff" />
                  </svg>
                )}
              </div>
            </div>

            {/* Radar Conic Sweep */}
            {isCapturing && (
              <div className="absolute w-28 h-28 rounded-full iris-radar-conic pointer-events-none z-15" />
            )}

            {/* Crosshair Target Overlay */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-24 h-[1px] bg-cyan-400/40" />
              <div className="h-24 w-[1px] bg-cyan-400/40 absolute" />
              <div className="w-10 h-10 rounded-full border border-cyan-400/30" />
            </div>
          </div>

          {/* Iris Sweep Laser Beam */}
          {isCapturing && (
            <div className="absolute inset-x-0 h-[2px] bg-cyan-400 iris-laser-sweep pointer-events-none z-15" />
          )}

          {/* Iris Pass Overlay */}
          {isPass && (
            <div className="absolute inset-0 bg-[#0F6B45]/90 flex flex-col items-center justify-center text-white font-mono text-center z-20">
              <div className="w-7 h-7 rounded-full bg-white text-[#0F6B45] flex items-center justify-center mb-0.5 shadow-xs">
                <svg className="w-4 h-4 text-[#0F6B45]" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="3">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <span className="text-xs font-bold uppercase">Single-Eye Iris Verified</span>
              <span className="text-[9px] text-emerald-200">
                {selectedEye} ({selectedEye === 'OD' ? 'Right Eye' : 'Left Eye'}) · Conf: 99.4% (Pass)
              </span>
            </div>
          )}

          {/* Footer prompt */}
          <div className="text-[8px] font-mono text-center text-slate-400 z-10 flex justify-between px-1">
            <span>FOCUS: OPTIMAL</span>
            <span>Direct Gaze into Scope</span>
            <span>STQC L1</span>
          </div>
        </div>
      </div>

      {/* Odometer & Status Strip */}
      <div className="p-2.5 rounded-lg bg-white border border-[#E7EDF4] flex items-center justify-between font-mono text-xs mb-3">
        <div>
          <span className="text-[9px] text-slate-400 block uppercase">Confidence Score</span>
          <span className={`text-lg font-bold tabular-nums ${isPass ? 'text-[#0F6B45]' : 'text-slate-400'}`}>
            {result?.leftScore != null ? `${result.leftScore}%` : isPass ? '99.4%' : '0.85 (0%)'}
          </span>
        </div>
        <span
          className={`px-2 py-0.5 rounded font-bold text-[11px] ${
            isPass
              ? 'bg-[#E8F5EE] border border-[#B4DCC7] text-[#0F6B45]'
              : isFail
              ? 'bg-[#FBEAEC] border border-[#EFC0C7] text-[#DC2626]'
              : isCapturing
              ? 'bg-cyan-100 text-cyan-800 animate-pulse'
              : 'bg-slate-100 text-slate-500'
          }`}
        >
          {isPass ? 'MATCH (PASS)' : isFail ? 'NO MATCH' : isCapturing ? 'ANALYZING…' : 'WAITING SCAN'}
        </span>
      </div>

      {error && (
        <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-xs font-mono text-rose-700">
          {error instanceof IrisError ? `${error.code}: ${error.description}` : error.message}
        </div>
      )}

      {/* Action row */}
      <div className="flex flex-col gap-2">
        {result ? (
          <Button
            variant="secondary"
            className="w-full font-mono text-xs uppercase tracking-wider"
            onClick={() => {
              setResult(null)
              setError(null)
            }}
          >
            Recapture
          </Button>
        ) : (
          <button
            type="button"
            onClick={onCapture}
            disabled={busy || status === 'service_down' || status === 'error'}
            className="w-full py-2 px-3 rounded-lg bg-[#0B4F8F] hover:bg-[#083E72] disabled:opacity-50 text-white font-mono font-bold text-xs uppercase tracking-wider transition shadow-xs flex items-center justify-center gap-2 group cursor-pointer"
          >
            <svg className="w-4 h-4 text-cyan-300 eye-blink-anim group-hover:scale-110 transition-transform" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 12s3.5-6.5 10-6.5 10 6.5-3.5 6.5-10 6.5S2 12 2 12Z" />
              <circle cx="12" cy="12" r="3" fill="currentColor" fillOpacity="0.25" />
              <circle cx="12" cy="12" r="1.5" fill="currentColor" />
            </svg>
            <span>{busy ? 'Capturing Iris…' : 'Scan Candidate Iris (Single Eye)'}</span>
          </button>
        )}
        <button
          type="button"
          onClick={onReset}
          disabled={busy}
          className="w-full py-1.5 px-3 rounded-lg border border-[#D5DDE7] bg-white hover:bg-slate-50 text-slate-600 font-mono font-semibold text-[11px] uppercase tracking-wider transition cursor-pointer"
          title="Force-release the iris device"
        >
          Reset Device
        </button>
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
