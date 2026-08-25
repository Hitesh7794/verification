import { useEffect, useRef, useState } from 'react'
import { Button } from '../ui/ui.jsx'
import { postFaceMatch } from '../../lib/api.js'

// FaceMatchPanel — paid identity match. Mirrors LivenessPanel's auto-
// capture UX: no "Capture" button, the operator just sees a priming
// countdown, one JPEG frame is grabbed automatically, and the snapshot
// is POSTed to /api/face-match. Backend loads the enrolled photo from
// S3 and forwards both to TrustView for cosine-similarity scoring.
// Result panel shows score / threshold + Retake.
//
// Runs immediately once the webcam is streaming — this component is
// mounted only after LivenessPanel.onPass fires, so the operator has
// already committed to "capture me now". The one-click promise starts
// at "Start liveness check" and ends with the score readout below.
//
// The wallet debit happens on this call (liveness is free). If the
// server refuses with 412 (liveness gate expired), the parent bounces
// the operator back to LivenessPanel — this component doesn't own that
// recovery.
//
// The Luxand match runs on the server, NOT on the operator laptop.
// That makes face the only fully OS-independent biometric channel — no
// per-laptop daemon, no install.

const PRIMING_MS = 1500  // pre-capture dwell, matches LivenessPanel

export default function FaceMatchPanel({
  rollNo,
  onResult, // ({ ok, score, threshold, faceFound, captured, raw }) => void
  // Optional: per-verification idempotency key from the parent. Passed
  // through to postFaceMatch so the backend can stash the probe under
  // this key for later promotion by createVerification.
  idempotencyKey,
}) {
  const videoRef = useRef(null)
  // streamRef holds the live MediaStream across renders. When the auto-
  // capture flow renders the snapshot <img> over the <video>, the video
  // element unmounts. The MediaStream itself keeps running, but the
  // <video> that mounts on Retake needs its srcObject re-attached —
  // handled by the effect on [snap].
  const streamRef = useRef(null)
  const [streaming, setStreaming] = useState(false)
  const [webcamErr, setWebcamErr] = useState('')
  const [snap, setSnap] = useState(null)
  const [phase, setPhase] = useState('idle')
    // idle | priming | matching | result | error
  const [countdown, setCountdown] = useState(0)
  const [result, setResult] = useState(null)
  const [callErr, setCallErr] = useState('')

  // Boot webcam on mount, release on unmount.
  useEffect(() => {
    async function start() {
      if (typeof navigator === 'undefined' ||
          !navigator.mediaDevices ||
          typeof navigator.mediaDevices.getUserMedia !== 'function') {
        setWebcamErr(
          'Webcam access is blocked because this page is loaded over plain HTTP from a non-localhost address. ' +
          'Open the portal via http://localhost:5173 (on this machine) or use HTTPS to enable the camera. ' +
          'You can also click "Skip face step" below if you only need to test fingerprint.'
        )
        return
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
        }
        setStreaming(true)
      } catch (e) {
        const reason = e.name || e.message || 'unknown error'
        setWebcamErr(`Unable to access webcam (${reason}).`)
      }
    }
    start()
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop())
        streamRef.current = null
      }
    }
  }, [])

  // Re-attach the live stream whenever the <video> element remounts.
  // The element unmounts when `snap` becomes non-null (the captured
  // <img> renders instead), and remounts when Retake clears `snap`.
  useEffect(() => {
    if (!snap && streamRef.current && videoRef.current) {
      videoRef.current.srcObject = streamRef.current
    }
  }, [snap])

  // Auto-start the capture flow once the webcam is streaming and we're
  // idle (either just mounted or the operator just hit Retake).
  useEffect(() => {
    if (streaming && phase === 'idle' && !webcamErr) {
      run()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, phase, webcamErr])

  function captureSnapshot() {
    const v = videoRef.current
    if (!v || !v.videoWidth) return null
    const canvas = document.createElement('canvas')
    canvas.width = v.videoWidth
    canvas.height = v.videoHeight
    canvas.getContext('2d').drawImage(v, 0, 0)
    // 0.85 quality is what Luxand's reference samples use. Smaller files
    // = lower upload latency without measurable accuracy loss.
    return canvas.toDataURL('image/jpeg', 0.85)
  }

  async function run() {
    setCallErr('')
    setResult(null)
    setPhase('priming')

    let elapsed = 0
    while (elapsed < PRIMING_MS) {
      setCountdown(Math.ceil((PRIMING_MS - elapsed) / 1000))
      await sleep(300)
      elapsed += 300
    }

    const dataURL = captureSnapshot()
    if (!dataURL) {
      setPhase('error')
      setCallErr('No webcam frame available. Click Retake to try again.')
      return
    }
    setSnap(dataURL)
    setPhase('matching')

    try {
      const resp = await postFaceMatch(rollNo, dataURL, idempotencyKey)
      const out = {
        ok: !!resp.status,
        captured: true,
        faceFound: !!resp.face_found,
        score: typeof resp.score === 'number' ? resp.score : 0,
        threshold: typeof resp.threshold === 'number' ? resp.threshold : 0,
        snapshot: dataURL,
        raw: resp,
      }
      setResult(out)
      setPhase('result')
      onResult?.(out)
    } catch (e) {
      setPhase('error')
      setCallErr(e.message || 'face match failed')
    }
  }

  function retake() {
    setSnap(null)
    setResult(null)
    setCallErr('')
    setPhase('idle')
    // The [streaming, phase] effect above re-runs `run()` on the next tick.
  }

  const active = phase === 'priming' || phase === 'matching'

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        {/* Live preview → snapshot swap, with priming overlay while the
            countdown ticks. Same visual language as LivenessPanel. */}
        <div className="aspect-video w-full rounded-lg bg-slate-900 overflow-hidden border border-slate-200 relative">
          {snap ? (
            <img src={snap} alt="captured" className="w-full h-full object-cover" />
          ) : (
            <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
          )}
          {phase === 'priming' && (
            <div className="absolute inset-0 bg-slate-900/40 flex items-center justify-center">
              <div className="text-white text-center">
                <p className="text-xs uppercase tracking-wider opacity-80">Get ready</p>
                <p className="text-5xl font-bold tabular-nums mt-1">{countdown}</p>
                <p className="text-xs mt-2 opacity-80">Capturing your face</p>
              </div>
            </div>
          )}
        </div>

        {/* Instructions / result panel */}
        <div className="aspect-video w-full rounded-lg bg-slate-50 border border-dashed border-slate-300 flex items-center justify-center text-center p-3">
          {!streaming && !webcamErr && (
            <p className="text-xs text-slate-500">Starting camera…</p>
          )}
          {phase === 'priming' && (
            <div className="text-sm text-slate-700">
              <p className="font-semibold">Stay still…</p>
              <p className="text-xs text-slate-500 mt-1">One shot, straight at the camera.</p>
            </div>
          )}
          {phase === 'matching' && (
            <div className="text-sm text-slate-600">
              <div className="h-10 w-10 mx-auto rounded-full border-4 border-indigo-200 border-t-indigo-600 animate-spin" />
              <p className="mt-2">Matching against enrolled photo…</p>
            </div>
          )}
          {phase === 'result' && result && (
            <ResultBox result={result} />
          )}
          {phase === 'error' && (
            <div className="text-rose-700">
              <p className="font-semibold">Capture failed</p>
              <p className="text-xs mt-1 text-slate-600">{callErr || 'Please retake.'}</p>
            </div>
          )}
        </div>
      </div>

      {webcamErr && <p className="text-xs text-rose-600">{webcamErr}</p>}
      {callErr && phase !== 'error' && (
        <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
          {callErr}
        </div>
      )}

      <div className="flex gap-2">
        {(phase === 'result' || phase === 'error') && (
          <Button variant="secondary" onClick={retake} disabled={active}>
            Retake
          </Button>
        )}
        {/* Skip stays available whenever the webcam never came up so
            the operator isn't stuck at Step 2 — face is optional in the
            downstream decision path. */}
        {(!streaming || webcamErr) && !result && (
          <Button
            variant="secondary"
            onClick={() => {
              const out = {
                ok: false,
                captured: false,
                faceFound: false,
                score: 0,
                threshold: 0,
                snapshot: null,
                skipped: true,
              }
              setResult(out)
              setPhase('result')
              onResult?.(out)
            }}
          >
            Skip face step
          </Button>
        )}
      </div>
    </div>
  )
}

function ResultBox({ result }) {
  const { ok, faceFound, score, threshold } = result
  if (!faceFound) {
    return (
      <div className="text-amber-700">
        <p className="font-semibold">No face detected</p>
        <p className="text-xs mt-1">Look at the camera and retake.</p>
      </div>
    )
  }
  // 5-decimal precision so the operator can see when score is brushing
  // the threshold from below — at FAR=0.0001 the threshold sits around
  // 0.9999 and a 3-decimal display rounds both sides to "1.000",
  // making real near-misses look identical to false negatives.
  const fmt = (n) => Number(n).toFixed(5)
  return (
    <div className={ok ? 'text-emerald-700' : 'text-rose-700'}>
      <p className="font-semibold">{ok ? 'Face match' : 'No face match'}</p>
      <p className="text-xs mt-1 text-slate-600 font-mono">
        score {fmt(score)} / threshold {fmt(threshold)}
        {!ok && score >= threshold - 0.001 && (
          <> · <span className="text-amber-700">close miss — try FAR=0.01 in .env</span></>
        )}
      </p>
    </div>
  )
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
