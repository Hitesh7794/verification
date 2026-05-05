import { useEffect, useState } from 'react'
import { Button } from './ui.jsx'
import { iris, IrisError } from '../lib/iris.js'

// IrisCapture is the fallback used when fingerprint match fails. Same
// auto-init / auto-recover discipline as FingerprintCapture, but for
// iris there's no enrolled gallery in the sample data, so capture is
// for **audit only** unless an iris template is supplied via props.
//
// When the operator triggers capture, we call /iris/capture (which
// wraps Marvis AutoCapture) and surface the per-eye quality + image.
// If both `galleryLeft` and `galleryRight` are supplied (base64), we
// then call /iris/match to compute scores; otherwise we just record
// the capture as evidence and let the operator decide manually.

export default function IrisCapture({
  galleryLeft,    // base64 of enrolled left iris (optional)
  galleryRight,   // base64 of enrolled right iris (optional)
  galleryFormat = 'K7',
  matchThreshold = 0.6,
  onResult,       // (result) => void
}) {
  const [status, setStatus] = useState('checking') // checking|service_down|no_device|ready|capturing|error
  const [device, setDevice] = useState(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    let timer
    async function tick() {
      if (!alive) return
      try {
        const devs = await iris.getConnectedDevices()
        if (!alive) return
        if (devs.length === 0) {
          setStatus('no_device')
          setDevice(null)
        } else {
          // Auto-init silently when a device is detected.
          const name = devs[0]
          if (!device || device.name !== name) {
            try {
              await iris.init(name)
              const info = await iris.getInfo(name)
              if (!alive) return
              setDevice({ name, info })
              setStatus('ready')
            } catch (e) {
              if (!alive) return
              setStatus(e instanceof IrisError && e.kind === 'device' ? 'no_device' : 'error')
              setError(e)
            }
          } else {
            setStatus('ready')
          }
        }
      } catch (e) {
        if (!alive) return
        setStatus(e instanceof IrisError && e.kind === 'service' ? 'service_down' : 'error')
        setError(e)
        setDevice(null)
      }
      timer = setTimeout(tick, 2000)
    }
    tick()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device?.name])

  async function onCapture() {
    setBusy(true)
    setError(null)
    setResult(null)
    setStatus('capturing')
    try {
      const cap = await iris.capture()
      let matchEnv = null
      if (galleryLeft || galleryRight) {
        // The probe images coming back from /iris/capture aren't
        // raw template bytes — they're whatever the SDK exposed via
        // GetImage (BMP by default in our Java wrapper). Pass them
        // straight through; the format param tells the matcher how
        // to interpret both sides.
        matchEnv = await iris.match({
          probeLeft: cap.Left?.BitmapB64,
          probeRight: cap.Right?.BitmapB64,
          galleryLeft,
          galleryRight,
          format: galleryFormat,
        })
      }
      const left = cap.Left?.Quality ?? null
      const right = cap.Right?.Quality ?? null
      const lScore = matchEnv?.LeftScore ?? null
      const rScore = matchEnv?.RightScore ?? null
      const passed = matchEnv
        ? !!matchEnv.Status &&
          ((lScore != null && lScore >= matchThreshold) ||
            (rScore != null && rScore >= matchThreshold))
        : null

      const out = {
        ok: passed,                           // null = no match was attempted
        captured: true,
        deviceSerial: device?.info?.SerialNo || '',
        deviceModel: device?.info?.Model || '',
        leftQuality: left,
        rightQuality: right,
        leftScore: lScore,
        rightScore: rScore,
        threshold: matchThreshold,
        leftBmp: cap.Left?.BitmapB64 || null,
        rightBmp: cap.Right?.BitmapB64 || null,
      }
      setResult(out)
      onResult?.(out)
      setStatus('ready')
    } catch (e) {
      setError(e)
      setStatus(e instanceof IrisError && e.kind === 'device' ? 'no_device' : 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <Banner status={status} device={device} error={error} />

      {(result?.leftBmp || result?.rightBmp) && (
        <div className="grid grid-cols-2 gap-3">
          {['leftBmp', 'rightBmp'].map((k) => (
            <div
              key={k}
              className="aspect-video rounded-lg bg-slate-100 overflow-hidden flex items-center justify-center"
            >
              {result[k] ? (
                <img
                  src={`data:image/bmp;base64,${result[k]}`}
                  alt={k}
                  className="w-full h-full object-cover"
                />
              ) : (
                <span className="text-xs text-slate-400">{k.replace('Bmp', '')}</span>
              )}
            </div>
          ))}
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
        detail: device ? `${device.info?.Model} · ${device.info?.SerialNo}` : '',
      }
    case 'capturing':
      return {
        tone: 'border-indigo-200 bg-indigo-50 text-indigo-800',
        dot: 'bg-indigo-500 animate-pulse',
        title: 'Look at the iris device…',
        detail: '',
      }
    case 'no_device':
      return {
        tone: 'border-amber-200 bg-amber-50 text-amber-800',
        dot: 'bg-amber-500',
        title: 'Plug in the iris device',
        detail: '',
      }
    case 'service_down':
      return {
        tone: 'border-rose-200 bg-rose-50 text-rose-800',
        dot: 'bg-rose-500',
        title: 'Iris service not running',
        detail: 'Ask IT to install mantra-iris-service',
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
        left q {r.leftQuality ?? '—'} · right q {r.rightQuality ?? '—'}
        {(r.leftScore != null || r.rightScore != null) && (
          <> · left s {r.leftScore ?? '—'} · right s {r.rightScore ?? '—'} · threshold {r.threshold}</>
        )}
      </p>
    </div>
  )
}
