import { useState } from 'react'
import { Button } from './ui.jsx'
import { morfin, MorfinError, tmpFormatFromString } from '../lib/morfin.js'
import { Status, useDeviceStatus } from '../lib/useDeviceStatus.js'

// FingerprintCapture orchestrates the full fingerprint stage of a
// verification:
//   1. Wait until device is Ready (status dot turns green).
//   2. Operator clicks "Capture & match" — the daemon captures from the
//      USB device and runs 1:1 against the supplied gallery template.
//   3. We surface the BMP preview, score, NFIQ, liveness, and call the
//      parent back with the full result so they can submit the final
//      verification record.
//
// There is NO device dropdown and NO init button — both are handled by
// the polling hook. If the device is not Ready, the operator sees a
// human-readable message and the capture button is disabled.

export default function FingerprintCapture({
  galleryTemplate,
  galleryFormat, // "FMR_V2005" | "FMR_V2011" | "ANSI_V378"
  matchThreshold = 140,
  onResult, // (result) => void
}) {
  const { status, device, error, withCapturing } = useDeviceStatus()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [callError, setCallError] = useState(null)

  const ready = status === Status.Ready && !!device

  const runMatch = withCapturing(async () => {
    const fmt = tmpFormatFromString(galleryFormat)
    if (fmt === null) {
      throw new Error(
        'unsupported gallery format: ' +
          galleryFormat +
          ' (expected FMR_V2005, FMR_V2011, or ANSI_V378)',
      )
    }
    return morfin.match({
      gallery: galleryTemplate,
      format: fmt,
      quality: 60,
      timeoutSec: 10,
    })
  })

  async function onCapture() {
    setBusy(true)
    setCallError(null)
    setResult(null)
    try {
      const r = await runMatch()
      const score = typeof r.MatchScore === 'number' ? r.MatchScore : Number(r.MatchScore || 0)
      const passed = !!r.Status && score >= matchThreshold
      const out = {
        ok: passed,
        rawSdkResponse: r,
        deviceSerial: device?.info?.SerialNo || '',
        deviceModel: device?.info?.Model || '',
        templateFormat: galleryFormat,
        quality: r.Quality ?? null,
        nfiq: r.Nfiq ?? null,
        liveness: typeof r.LiveNess_Result === 'number' ? r.LiveNess_Result : null,
        score,
        threshold: matchThreshold,
        bitmapBase64: r.BitmapData || null,
      }
      setResult(out)
      onResult?.(out)
    } catch (e) {
      setCallError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <DeviceBanner status={status} device={device} error={error} />

      <div className="aspect-square w-full max-w-xs mx-auto rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 flex flex-col items-center justify-center text-center p-6">
        {result?.bitmapBase64 ? (
          <img
            src={`data:image/bmp;base64,${result.bitmapBase64}`}
            alt="captured fingerprint"
            className="w-full h-full object-contain"
          />
        ) : status === Status.Capturing || busy ? (
          <>
            <div className="h-12 w-12 rounded-full border-4 border-indigo-200 border-t-indigo-600 animate-spin" />
            <p className="mt-3 text-sm text-slate-600">Place finger on the device…</p>
          </>
        ) : ready ? (
          <>
            <p className="text-sm font-medium text-slate-700">Device ready</p>
            <p className="text-xs text-slate-500 mt-1">{device?.info?.Model} · {device?.info?.SerialNo}</p>
          </>
        ) : (
          <p className="text-sm text-slate-500">Waiting for fingerprint device…</p>
        )}
      </div>

      {result && (
        <ResultSummary result={result} />
      )}
      {callError && (
        <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
          {callError instanceof MorfinError
            ? `${callError.code}: ${callError.description}`
            : callError.message}
        </div>
      )}

      <div className="flex gap-2 justify-center">
        {result ? (
          <Button variant="secondary" onClick={() => { setResult(null); setCallError(null); }}>
            Recapture
          </Button>
        ) : (
          <>
            <Button onClick={onCapture} disabled={!ready || busy}>
              {busy ? 'Capturing…' : 'Capture & match'}
            </Button>
            {/* Skip path: when the FP service is down, no device is plugged
                in, or the SDK errors at startup, the operator otherwise
                gets stuck at this step. The skip emits a "no biometric
                attempted" result so the dashboard advances and the iris
                fallback / manual decision flow becomes reachable. */}
            {(status === Status.ServiceDown
                || status === Status.NoDevice
                || status === Status.Error) && (
              <Button
                variant="secondary"
                onClick={() => {
                  const out = {
                    ok: false,
                    rawSdkResponse: null,
                    deviceSerial: '',
                    deviceModel: '',
                    templateFormat: galleryFormat,
                    quality: null,
                    nfiq: null,
                    liveness: null,
                    score: 0,
                    threshold: matchThreshold,
                    bitmapBase64: null,
                    skipped: true,
                  }
                  setResult(out)
                  onResult?.(out)
                }}
              >
                Skip fingerprint step
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function DeviceBanner({ status, device, error }) {
  const cfg = bannerFor(status, device, error)
  return (
    <div
      className={`flex items-center gap-3 rounded-lg border px-3 py-2 text-sm ${cfg.tone}`}
    >
      <span className={`h-2.5 w-2.5 rounded-full ${cfg.dot}`} />
      <span className="font-medium">{cfg.title}</span>
      {cfg.detail && <span className="text-slate-500">— {cfg.detail}</span>}
    </div>
  )
}

function bannerFor(status, device, error) {
  switch (status) {
    case Status.Ready:
      return {
        tone: 'border-emerald-200 bg-emerald-50 text-emerald-800',
        dot: 'bg-emerald-500',
        title: 'Device ready',
        detail: device ? `${device.info?.Model} · ${device.info?.SerialNo}` : '',
      }
    case Status.Capturing:
      return {
        tone: 'border-indigo-200 bg-indigo-50 text-indigo-800',
        dot: 'bg-indigo-500 animate-pulse',
        title: 'Capturing…',
        detail: '',
      }
    case Status.Initializing:
      return {
        tone: 'border-amber-200 bg-amber-50 text-amber-800',
        dot: 'bg-amber-500 animate-pulse',
        title: 'Initializing device…',
        detail: '',
      }
    case Status.NoDevice:
      return {
        tone: 'border-amber-200 bg-amber-50 text-amber-800',
        dot: 'bg-amber-500',
        title: 'Plug in the fingerprint device',
        detail: '',
      }
    case Status.ServiceDown:
      return {
        tone: 'border-rose-200 bg-rose-50 text-rose-800',
        dot: 'bg-rose-500',
        title: 'Device service not running',
        detail: 'Ask IT to install the verification client',
      }
    case Status.Error:
      return {
        tone: 'border-rose-200 bg-rose-50 text-rose-800',
        dot: 'bg-rose-500',
        title: 'Device error',
        detail: error?.description || error?.message || '',
      }
    default:
      return {
        tone: 'border-slate-200 bg-slate-50 text-slate-700',
        dot: 'bg-slate-400',
        title: 'Checking device…',
        detail: '',
      }
  }
}

function ResultSummary({ result }) {
  const { ok, score, threshold, quality, nfiq, liveness } = result
  return (
    <div
      className={`rounded-lg border p-3 text-sm ${
        ok
          ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
          : 'border-rose-200 bg-rose-50 text-rose-800'
      }`}
    >
      <p className="font-semibold">
        {ok ? 'Match' : 'No match'} · score {score} / threshold {threshold}
      </p>
      <p className="text-xs mt-1 text-slate-600">
        quality {quality ?? '—'} · NFIQ {nfiq ?? '—'} ·{' '}
        liveness {liveness === 1 ? 'live' : liveness === 0 ? 'spoof' : '—'}
      </p>
    </div>
  )
}
