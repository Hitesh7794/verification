import { useEffect, useState } from 'react'
import { Button } from '../ui/ui.jsx'
import { iris, IrisError } from '../../lib/verify/iris.js'

// IrisCapture is the fallback used when fingerprint match fails.
// Operator triggers a single-eye capture; if a gallery template is
// supplied via props, we also run a 1:1 match server-side. Otherwise
// the capture lands on the verifications row as audit-only.
//
// Since the switch to Mantra's native Windows Marvis Auth Web SDK
// (v1.4, replacing the WSL2 + Java fallback), the daemon captures a
// single eye per invocation rather than left+right in one shot. We
// keep the old result contract (leftQuality/rightQuality/etc.) so
// Dashboard.jsx and the verifications table shape don't change — one
// capture maps to the "left*" slots, "right*" stay null. If we later
// decide to prompt for both eyes, run capture twice and merge.
//
// Auto-heartbeat: polls /marvisauth/info every 2s to detect whether
// the daemon is up. If it goes down mid-session we surface it before
// the operator clicks and gets a cryptic error. Same discipline as
// FingerprintCapture.

export default function IrisCapture({
  galleryTemplate,          // base64 iris template (optional; enables match)
  galleryFormat,            // numeric ImgFormat matching the gallery (default ISO)
  matchThreshold = 0.6,     // score gate for "ok"; SDK scores are 0..1
  quality = 55,             // min capture quality (1..100), passed to /capture
  timeoutMs = 10000,        // wall-clock capture timeout
  onResult,                 // (result) => void
}) {
  const [status, setStatus] = useState('checking') // checking|service_down|ready|capturing|error
  const [device, setDevice] = useState(null)       // { model, serial } from /info
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  // Heartbeat — every 2s, ping /marvisauth/info to check the daemon
  // is alive. Vendor SDK auto-inits the attached device on first
  // capture, so there's no explicit init/connected-list to call.
  useEffect(() => {
    let alive = true
    let timer
    async function tick() {
      if (!alive) return
      try {
        const env = await iris.getInfo()
        if (!alive) return
        setDevice({
          model:  env.Model  || env.DeviceModel  || '',
          serial: env.SerialNo || env.SerialNumber || '',
        })
        // Only flip to 'ready' when idle — never trample 'capturing'.
        setStatus((s) => (s === 'capturing' ? s : 'ready'))
      } catch (e) {
        if (!alive) return
        if (e instanceof IrisError && e.kind === 'service') {
          setStatus('service_down')
          setDevice(null)
        } else {
          setStatus('error')
          setError(e)
        }
      }
      timer = setTimeout(tick, 2000)
    }
    tick()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [])

  async function onCapture() {
    setBusy(true)
    setError(null)
    setResult(null)
    setStatus('capturing')
    try {
      // Two shapes here depending on whether a gallery is supplied:
      //   - gallery present → /match (captures + compares in one hop,
      //     returns Score alongside Quality + BitmapData)
      //   - no gallery      → /capture (audit-only, no Score)
      let env
      let matched = null // null = no match attempted
      if (galleryTemplate) {
        env = await iris.match({
          galleryTemplate,
          format: galleryFormat,
          quality,
          timeoutMs,
        })
        // Vendor sample surfaces Score + Status; we treat Status
        // (their own boolean) as the primary signal, tightened by our
        // own threshold gate for a defence-in-depth check.
        const score = num(env.Score)
        matched = !!env.Status && score != null && score >= matchThreshold
      } else {
        env = await iris.capture({ quality, timeoutMs })
      }

      // Keep the old result-object contract so Dashboard.jsx's submit
      // body and the verifications.iris_* columns don't need to
      // change. Single-eye capture → populate 'left*', leave 'right*'
      // NULL.
      const out = {
        ok: matched,
        captured: true,
        deviceSerial: device?.serial || '',
        deviceModel:  device?.model  || '',
        leftQuality:  num(env.Quality),
        rightQuality: null,
        leftScore:    num(env.Score),
        rightScore:   null,
        threshold:    matchThreshold,
        leftBmp:      env.BitmapData || null,
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
