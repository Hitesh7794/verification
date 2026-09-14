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
        // Vendors that return a pre-formed data URL (e.g. Startek via the
        // ISO 19794-4 decoder) fill this; Mantra fills bitmapBase64
        // as raw BMP base64 and this stays null. The JSX prefers this
        // when present.
        bitmapDataUrl: r.BitmapDataUrl || null,
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
  const isPass = result && result.ok === true
  const isFail = result && result.ok === false

  return (
    <div className="space-y-3 font-mono text-xs">
      <DeviceBanner status={status} device={device} error={error} />

      <div className="my-2 flex flex-col items-center">
        <div
          onClick={ready && !busy ? onCapture : undefined}
          className={`platen-sensor w-36 h-40 rounded-xl flex flex-col items-center justify-center transition-all duration-300 relative overflow-hidden ${
            ready && !busy ? 'cursor-pointer hover:border-[#0B4F8F]' : ''
          } ${
            isPass
              ? 'border-2 border-[#0F6B45] ring-2 ring-[#0F6B45]/30 bg-emerald-50/60'
              : isFail
              ? 'border-2 border-[#DC2626] ring-2 ring-red-500/40 bg-red-50/60 shake-error-anim'
              : busy || status === Status.Capturing
              ? 'border-2 border-cyan-500/80 bg-cyan-950/10'
              : ''
          }`}
        >
          {/* Laser Scanner Line */}
          {(busy || status === Status.Capturing) && <div className="fp-laser-scanner" />}
          {isPass && <div className="fp-laser-scanner scanner-green" />}
          {isFail && <div className="fp-laser-scanner scanner-red" />}

          {/* Captured Bitmap Preview or Vector SVG */}
          {result?.bitmapDataUrl || result?.bitmapBase64 ? (
            <div className="relative w-full h-full p-2 flex items-center justify-center">
              <img
                src={result.bitmapDataUrl || `data:image/bmp;base64,${result.bitmapBase64}`}
                alt="captured fingerprint"
                className="w-full h-full object-contain"
              />
              {isPass && (
                <div className="absolute inset-0 flex items-center justify-center bg-emerald-950/20 z-10">
                  <div className="w-10 h-10 rounded-full bg-[#0F6B45] text-white flex items-center justify-center shadow-lg success-glow-ring">
                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="3">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="relative flex items-center justify-center">
              <svg
                className={`w-20 h-28 transition-all duration-300 ${
                  isPass
                    ? 'text-[#0F6B45] drop-shadow-[0_0_12px_rgba(15,107,69,0.9)]'
                    : isFail
                    ? 'text-[#DC2626] drop-shadow-[0_0_12px_rgba(220,38,38,0.9)]'
                    : busy || status === Status.Capturing
                    ? 'text-cyan-500 drop-shadow-[0_0_8px_rgba(6,182,212,0.8)]'
                    : 'text-slate-400 group-hover:text-[#0B4F8F]'
                }`}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 2C6.48 2 2 6.48 2 12c0 2.85 1.2 5.41 3.12 7.23M12 6c-3.31 0-6 2.69-6 6 0 1.94.92 3.66 2.36 4.77M12 10c-1.1 0-2 .9-2 2 0 .8.47 1.48 1.15 1.8M12 14c-.55 0-1 .45-1 1M18.88 19.23C20.8 17.41 22 14.85 22 12c0-5.52-4.48-10-10-10M17.64 16.77C19.08 15.66 20 13.94 20 12c0-4.42-3.58-8-8-8M14.85 13.8C15.53 13.48 16 12.8 16 12c0-2.21-1.79-4-4-4" />
              </svg>

              {isPass && (
                <div className="absolute inset-0 flex items-center justify-center z-10">
                  <div className="w-10 h-10 rounded-full bg-[#0F6B45] text-white flex items-center justify-center shadow-lg success-glow-ring">
                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="3">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                </div>
              )}

              {isFail && (
                <div className="absolute inset-0 flex items-center justify-center z-10">
                  <div className="w-10 h-10 rounded-full bg-[#DC2626] text-white flex items-center justify-center shadow-lg">
                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="3">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </div>
                </div>
              )}
            </div>
          )}

          <span
            className={`text-[9.5px] font-mono font-bold uppercase mt-2 transition-colors ${
              isPass
                ? 'text-[#0F6B45]'
                : isFail
                ? 'text-[#DC2626]'
                : busy || status === Status.Capturing
                ? 'text-cyan-700 animate-pulse'
                : 'text-slate-500'
            }`}
          >
            {isPass
              ? 'Fingerprint Verified (Pass)'
              : isFail
              ? 'Ridge Defect (<40)'
              : busy || status === Status.Capturing
              ? 'Scanning Ridges…'
              : 'Touch Sensor Glass'}
          </span>
        </div>
      </div>

      {/* Odometer & Status Strip */}
      <div className="p-2.5 rounded-lg bg-white border border-[#E7EDF4] flex items-center justify-between font-mono text-xs mb-3">
        <div>
          <span className="text-[9px] text-slate-400 block uppercase">Match Score</span>
          <span className={`text-lg font-bold tabular-nums ${isPass ? 'text-[#0F6B45]' : isFail ? 'text-[#DC2626]' : 'text-slate-400'}`}>
            {result?.score != null ? String(result.score).padStart(3, '0') : '000'}
          </span>
        </div>
        <span
          className={`px-2 py-0.5 rounded font-bold text-[11px] ${
            isPass
              ? 'bg-[#E8F5EE] border border-[#B4DCC7] text-[#0F6B45]'
              : isFail
              ? 'bg-[#FBEAEC] border border-[#EFC0C7] text-[#DC2626]'
              : busy || status === Status.Capturing
              ? 'bg-cyan-100 text-cyan-800 animate-pulse'
              : 'bg-slate-100 text-slate-500'
          }`}
        >
          {isPass ? 'MATCH (PASS)' : isFail ? 'LOW QUALITY (<40)' : busy ? 'SCANNING…' : 'WAITING SCAN'}
        </span>
      </div>

      {callError && (
        <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700 font-mono">
          {callError instanceof MorfinError || callError instanceof StartekError
            ? `${callError.code}: ${callError.description}`
            : callError.message}
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
              setCallError(null)
            }}
          >
            Recapture
          </Button>
        ) : (
          <button
            type="button"
            onClick={onCapture}
            disabled={!ready || busy}
            className="w-full py-2 px-3 rounded-lg bg-[#0B4F8F] hover:bg-[#083E72] disabled:opacity-50 text-white font-mono font-bold text-xs uppercase tracking-wider transition shadow-xs flex items-center justify-center gap-2 group cursor-pointer"
          >
            <svg
              className="w-4 h-4 text-cyan-300 group-hover:scale-110 transition-transform"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 2a10 10 0 0 0-10 10c0 2.85 1.2 5.41 3.12 7.23M12 6a6 6 0 0 0-6 6c0 1.94.92 3.66 2.36 4.77M12 10a2 2 0 0 0-2 2c0 .8.47 1.48 1.15 1.8M12 14c-.55 0-1 .45-1 1M18.88 19.23A10 10 0 0 0 22 12c0-5.52-4.48-10-10-10M17.64 16.77A6 6 0 0 0 20 12c0-4.42-3.58-8-8-8M14.85 13.8A2 2 0 0 0 16 12c0-2.21-1.79-4-4-4" />
            </svg>
            <span>{busy ? 'Capturing Ridges…' : 'Scan Candidate Fingerprint'}</span>
          </button>
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
      // Detail intentionally empty — the previous "Ask IT to install
      // the verification client" line wrapped to two lines inside the
      // narrower fingerprint card and broke the banner layout. Title
      // alone is clear enough for the operator.
      return {
        tone: 'border-rose-200 bg-rose-50 text-rose-800',
        dot: 'bg-rose-500',
        title: 'Device service not running',
        detail: '',
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
  // Operator-facing pass/fail only. Score/threshold/quality/NFIQ/liveness
  // are still on `result` (backend + audit_log consume them); they're just
  // not shown here.
  const { ok } = result
  return (
    <div
      className={`rounded-lg border p-3 text-sm ${
        ok
          ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
          : 'border-rose-200 bg-rose-50 text-rose-800'
      }`}
    >
      {/* Operators get pass/fail only. Score/threshold + quality/NFIQ/
          liveness detail lines both removed — they were internal
          debugging exposed to the field. */}
      <p className="font-semibold">
        {ok ? 'Match' : 'No match'}
      </p>
    </div>
  )
}
