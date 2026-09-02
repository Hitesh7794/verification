import { useState } from 'react'
import { Button } from '../ui/ui.jsx'
import { MorfinError, tmpFormatFromString } from '../../lib/verify/morfin.js'
import { StartekError } from '../../lib/verify/fingerprint/startek.js'
import { Vendor } from '../../lib/verify/fingerprint/types.js'
import { Status, useDeviceStatus } from '../../lib/verify/useDeviceStatus.js'

// FingerprintCapture orchestrates the full fingerprint stage of a
// verification:
//   1. Wait until device is Ready (status dot turns green).
//   2. Operator clicks "Capture & match" — the daemon captures from the
//      USB device and runs 1:1 against the supplied gallery template.
//   3. We surface the BMP preview (if vendor provides), score, NFIQ,
//      liveness, and call the parent back with the full result so they
//      can submit the final verification record.
//
// There is NO device dropdown and NO init button — both are handled by
// the polling hook. If the device is not Ready, the operator sees a
// human-readable message and the capture button is disabled.
//
// Multi-vendor (2026-05-15): the hook surfaces an `active` vendor on
// the device object. We dispatch the match call to that vendor's
// client and tag the result with vendor=mantra|startek so the audit
// row records which SDK produced the score. Threshold defaults come
// from the registry (vendor scales differ) but a caller-provided
// matchThreshold overrides for explicit control.

export default function FingerprintCapture({
  rollNo, // candidate roll — required by Startek path (backend-side gallery lookup)
  galleryTemplate,
  galleryFormat, // "FMR_V2005" | "FMR_V2011" | "ANSI_V378"
  matchThreshold, // optional — when omitted, use the active vendor's default
  onResult, // (result) => void
}) {
  const { status, device, error, withCapturing, getClient } = useDeviceStatus()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [callError, setCallError] = useState(null)

  const ready = status === Status.Ready && !!device
  // Effective threshold: explicit prop wins over the vendor default
  // surfaced by the registry. Both vendors land into the same
  // match_threshold column on the audit row.
  const effectiveThreshold =
    typeof matchThreshold === 'number' ? matchThreshold : device?.threshold ?? 0

  const runMatch = withCapturing(async () => {
    if (!device) throw new Error('no active fingerprint device')
    const client = getClient(device.vendor)
    if (!client) throw new Error('no client registered for vendor: ' + device.vendor)

    // MorFin's match() expects a numeric TmpFormat enum (FMR_V2005 etc.)
    // because the vendor daemon uses an array-index code on the wire.
    // Startek's match() doesn't take a format argument — the FM220U L1
    // emits ISO/IEC 19794-2 FMR templates and the matcher accepts the
    // same family without any vendor-side enum.
    // Both vendors now use the same two-step server-side path:
    //   1. local capture via the vendor daemon (Mantra MorFin or
    //      Startek ACPL Capture API),
    //   2. probe template POSTed to /api/fp-match → SourceAFIS via
    //      fp-match-service.
    //
    // The vendor clients each implement their own capture+gettemplate
    // sequence internally and then call postFpMatch. From this
    // component's perspective they're identical: pass rollNo, get
    // back a canonical envelope. The galleryTemplate / galleryFormat
    // props are accepted for API back-compat but ignored — the
    // backend looks the gallery up by roll number from the candidate
    // index (single source of truth).
    return client.match({
      rollNo,
      gallery: galleryTemplate,
      format: tmpFormatFromString(galleryFormat),
    })
  })

  async function onCapture() {
    setBusy(true)
    setCallError(null)
    setResult(null)
    try {
      const r = await runMatch()
      const score = typeof r.MatchScore === 'number' ? r.MatchScore : Number(r.MatchScore || 0)
      const passed = !!r.Status && score >= effectiveThreshold
      const out = {
        ok: passed,
        rawSdkResponse: r,
        vendor: device?.vendor || null,
        deviceSerial: device?.info?.SerialNo || r.DeviceSerial || '',
        deviceModel: device?.info?.Model || r.DeviceModel || '',
        templateFormat: galleryFormat,
        quality: r.Quality ?? null,
        nfiq: r.Nfiq ?? null,
        liveness: typeof r.LiveNess_Result === 'number' ? r.LiveNess_Result : null,
        score,
        threshold: effectiveThreshold,
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
            <p className="text-xs text-slate-500 mt-1">
              {device?.label ? `${device.label} · ` : ''}
              {device?.info?.Model} · {device?.info?.SerialNo}
            </p>
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
          {callError instanceof MorfinError || callError instanceof StartekError
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
          <Button onClick={onCapture} disabled={!ready || busy}>
            {busy ? 'Capturing…' : 'Capture & match'}
          </Button>
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
    case Status.Ready: {
      const vendorPrefix = device?.label ? `${device.label} · ` : ''
      const modelSerial = device
        ? `${device.info?.Model || ''}${device.info?.SerialNo ? ' · ' + device.info.SerialNo : ''}`
        : ''
      return {
        tone: 'border-emerald-200 bg-emerald-50 text-emerald-800',
        dot: 'bg-emerald-500',
        title: 'Device ready',
        detail: vendorPrefix + modelSerial,
      }
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
  // Render numeric score/threshold with at most 2 decimals — SourceAFIS
  // returns a double like 215.09143581040846 which is noisy for operators.
  // Integer scores (Mantra MorFin returns ints) render as ints unchanged.
  const fmt = (n) => {
    if (typeof n !== 'number' || Number.isNaN(n)) return n
    return Number.isInteger(n) ? n.toString() : n.toFixed(2)
  }
  // NFIQ 0 means "not measured" per the NIST spec (1..5 are real values where 1
  // is best). Some vendors return 0 instead of null when they don't expose
  // the metric — render as "—" for the operator's eye.
  const nfiqDisplay = (typeof nfiq === 'number' && nfiq > 0) ? nfiq : '—'
  // Quality is null for Startek (ACPL doesn't expose it in the public API);
  // a real number for Mantra MorFin. Same display rule.
  const qualityDisplay = (typeof quality === 'number' && quality > 0) ? quality : '—'
  return (
    <div
      className={`rounded-lg border p-3 text-sm ${
        ok
          ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
          : 'border-rose-200 bg-rose-50 text-rose-800'
      }`}
    >
      {/* Score / threshold removed — operators just get Match / No
          match. Quality + NFIQ + liveness below are capture-time
          signals, not match figures, so they stay. */}
      <p className="font-semibold">
        {ok ? 'Match' : 'No match'}
      </p>
      <p className="text-xs mt-1 text-slate-600">
        quality {qualityDisplay} · NFIQ {nfiqDisplay} ·{' '}
        liveness {liveness === 1 ? 'live' : liveness === 0 ? 'spoof' : '—'}
      </p>
    </div>
  )
}
