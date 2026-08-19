import { useEffect, useRef, useState } from 'react'
import { Button } from '../ui/ui.jsx'
import { postLivenessCheck } from '../../lib/api.js'

// LivenessPanel — active anti-spoof gate that runs BEFORE the paid
// face-match step. Flow:
//   1. Boot the webcam (same getUserMedia dance FaceMatchPanel does).
//   2. Operator clicks "Start liveness check".
//   3. Show a 2-second "look at the camera" priming phase so we
//      capture enough calibration frames before the challenge starts.
//   4. Prompt "Blink twice, keep looking at the camera" and capture
//      ~30 frames over ~3 seconds (10 fps). This gives Luxand's
//      tracker the sequence it needs to score passive liveness AND
//      count blinks.
//   5. Upload the frames to /api/candidates/{roll}/liveness-check.
//   6. On pass → call onPass({ sessionId, expiresIn }) so the parent
//      can unlock the face-capture step.
//   7. On fail → surface why + let the operator retry infinitely.
//
// The wallet is NOT charged here — /face-match is the payable event.
// If /face-match later refuses with 412 (gate expired), the parent
// bounces the operator back to this step.

const FRAMES_PER_CAPTURE = 30    // ~3s worth at 10 fps — matches Java MIN_FRAMES=15 with headroom
const CAPTURE_INTERVAL_MS = 100  // 10 fps
const PRIMING_MS = 1500          // pre-challenge dwell for tracker warm-up
const CHALLENGES = ['blink']     // "turn_left" reserved for a follow-up

export default function LivenessPanel({ rollNo, sessionId, onPass }) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const canvasRef = useRef(document.createElement('canvas'))

  const [streaming, setStreaming] = useState(false)
  const [webcamErr, setWebcamErr] = useState('')
  const [phase, setPhase] = useState('idle')
    // idle | priming | recording | uploading | pass | fail
  const [countdown, setCountdown] = useState(0)   // priming ticks
  const [captureIdx, setCaptureIdx] = useState(0) // frames captured so far
  const [result, setResult] = useState(null)
  const [err, setErr] = useState('')

  // Boot webcam on mount. Same pattern as FaceMatchPanel — kept in
  // its own effect so navigating away releases the tracks.
  useEffect(() => {
    async function start() {
      if (typeof navigator === 'undefined' ||
          !navigator.mediaDevices ||
          typeof navigator.mediaDevices.getUserMedia !== 'function') {
        setWebcamErr(
          'Webcam access needs HTTPS or localhost. Open the portal via ' +
          'https:// or http://localhost — otherwise the browser blocks the camera.'
        )
        return
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false,
        })
        streamRef.current = stream
        if (videoRef.current) videoRef.current.srcObject = stream
        setStreaming(true)
      } catch (e) {
        setWebcamErr(`Unable to access webcam (${e.name || e.message || 'unknown'}).`)
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

  function grabFrame() {
    const v = videoRef.current
    if (!v || !v.videoWidth) return null
    const canvas = canvasRef.current
    canvas.width = v.videoWidth
    canvas.height = v.videoHeight
    canvas.getContext('2d').drawImage(v, 0, 0)
    // 0.7 quality: 30 frames × ~35 KB ≈ 1 MB payload. Anything higher
    // makes uploads sluggish without any accuracy gain in FSDK.
    return canvas.toDataURL('image/jpeg', 0.7)
  }

  async function run() {
    setErr('')
    setResult(null)
    setPhase('priming')

    // Priming — countdown, but no capture yet. Gives the tracker time
    // to warm up on the operator's face before we lock frames in.
    let elapsed = 0
    while (elapsed < PRIMING_MS) {
      setCountdown(Math.ceil((PRIMING_MS - elapsed) / 1000))
      await sleep(300)
      elapsed += 300
    }

    setPhase('recording')
    setCaptureIdx(0)
    const frames = []
    for (let i = 0; i < FRAMES_PER_CAPTURE; i++) {
      const f = grabFrame()
      if (f) frames.push(f)
      setCaptureIdx(i + 1)
      await sleep(CAPTURE_INTERVAL_MS)
    }

    if (frames.length < FRAMES_PER_CAPTURE / 2) {
      setPhase('fail')
      setErr('Camera did not deliver enough frames. Check the webcam and retry.')
      return
    }

    setPhase('uploading')
    try {
      const r = await postLivenessCheck(rollNo, frames, sessionId, CHALLENGES)
      setResult(r)
      if (r.pass) {
        // Dwell on the success state for a beat so the operator sees the
        // green checkmark before the parent yanks them to face capture.
        // ~1.6s is long enough to register as a distinct moment ("it
        // worked!") but short enough that it doesn't feel like a wait.
        setPhase('pass')
        await sleep(1600)
        onPass?.({
          sessionId: r.session_id,
          expiresIn: r.expires_in_seconds || 90,
        })
      } else {
        setPhase('fail')
      }
    } catch (e) {
      setPhase('fail')
      setErr(e.message || 'Liveness upload failed')
    }
  }

  const active = phase === 'priming' || phase === 'recording' || phase === 'uploading'

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        {/* Live preview — always shows the stream, even during upload,
            so the operator has visual confirmation the camera is on. */}
        <div className="aspect-video w-full rounded-lg bg-slate-900 overflow-hidden border border-slate-200 relative">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="w-full h-full object-cover"
          />
          {phase === 'priming' && (
            <div className="absolute inset-0 bg-slate-900/40 flex items-center justify-center">
              <div className="text-white text-center">
                <p className="text-xs uppercase tracking-wider opacity-80">Get ready</p>
                <p className="text-5xl font-bold tabular-nums mt-1">{countdown}</p>
                <p className="text-xs mt-2 opacity-80">Look straight at the camera</p>
              </div>
            </div>
          )}
          {phase === 'recording' && (
            <>
              <div className="absolute top-2 left-2 inline-flex items-center gap-1.5 rounded-md bg-rose-600 text-white px-2 py-0.5 text-[11px] font-semibold">
                <span className="h-1.5 w-1.5 rounded-full bg-white animate-pulse" />
                REC
              </div>
              <div className="absolute bottom-2 left-2 right-2 h-1.5 bg-slate-900/50 rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-400 transition-all duration-100"
                  style={{ width: `${(captureIdx / FRAMES_PER_CAPTURE) * 100}%` }}
                />
              </div>
            </>
          )}
          {phase === 'pass' && (
            // Big, unmissable "you passed" moment layered over the
            // webcam preview so the operator has a distinct visual beat
            // before the next step swaps in. The parent auto-advances
            // ~1.6s after this shows.
            <div className="absolute inset-0 bg-emerald-600/85 flex items-center justify-center">
              <div className="text-white text-center">
                <div className="mx-auto h-20 w-20 rounded-full bg-white/20 ring-4 ring-white/40 flex items-center justify-center animate-[ping_1.2s_ease-out_1]">
                  <svg className="h-12 w-12 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="5 12 10 17 20 7" />
                  </svg>
                </div>
                <p className="mt-3 text-lg font-bold tracking-tight">Liveness verified</p>
                <p className="text-xs opacity-90 mt-0.5">Opening face capture…</p>
              </div>
            </div>
          )}
        </div>

        {/* Instructions / result panel */}
        <div className="aspect-video w-full rounded-lg bg-slate-50 border border-dashed border-slate-300 flex items-center justify-center text-center p-4">
          {phase === 'idle' && !streaming && !webcamErr && (
            <p className="text-xs text-slate-500">Starting camera…</p>
          )}
          {phase === 'idle' && streaming && (
            <div className="text-sm text-slate-700 space-y-2">
              <p className="font-semibold">Prove you're a real person</p>
              <p className="text-xs text-slate-600">
                Look at the camera and, when prompted, <b>blink twice</b>. This runs
                before the enrolled record is unlocked and is free of charge.
              </p>
            </div>
          )}
          {phase === 'priming' && (
            <div className="text-sm text-slate-700">
              <p className="font-semibold">Stay still…</p>
              <p className="text-xs text-slate-500 mt-1">Framing your face.</p>
            </div>
          )}
          {phase === 'recording' && (
            <div className="text-sm text-slate-700">
              <p className="text-base font-bold text-slate-900">Blink twice</p>
              <p className="text-xs text-slate-500 mt-2 tabular-nums">
                Recording frame {captureIdx} / {FRAMES_PER_CAPTURE}
              </p>
            </div>
          )}
          {phase === 'uploading' && (
            <div className="text-sm text-slate-600">
              <div className="h-10 w-10 mx-auto rounded-full border-4 border-slate-200 border-t-emerald-600 animate-spin" />
              <p className="mt-2">Scoring…</p>
            </div>
          )}
          {phase === 'pass' && result && (
            <PassBox result={result} />
          )}
          {phase === 'fail' && (
            <FailBox result={result} err={err} />
          )}
        </div>
      </div>

      {webcamErr && <p className="text-xs text-rose-600">{webcamErr}</p>}

      <div className="flex gap-2">
        {phase === 'pass' ? (
          <p className="text-sm text-emerald-700">
            Liveness passed. Continue to face capture below.
          </p>
        ) : (
          <Button
            onClick={run}
            disabled={!streaming || active}
          >
            {active
              ? (phase === 'uploading' ? 'Scoring…' : 'Running…')
              : phase === 'fail'
              ? 'Retry liveness'
              : 'Start liveness check'}
          </Button>
        )}
      </div>
    </div>
  )
}

function PassBox({ result }) {
  return (
    <div className="text-emerald-700 space-y-1">
      <p className="font-semibold">Live person confirmed</p>
      <p className="text-xs text-slate-600">
        Passive score {(result.passive_mean * 100).toFixed(0)} / 100 · blinks{' '}
        {result.blinks_detected}
      </p>
    </div>
  )
}

function FailBox({ result, err }) {
  const msg = err || pickFailReason(result)
  return (
    <div className="text-rose-700 space-y-1">
      <p className="font-semibold">Liveness check failed</p>
      <p className="text-xs text-slate-600">{msg}</p>
      <p className="text-[11px] text-slate-500 mt-1">Click "Retry liveness" to try again.</p>
    </div>
  )
}

function pickFailReason(result) {
  if (!result) return 'Unknown error. Please retry.'
  if (result.faces_found === 0) return 'No face detected. Look straight at the camera.'
  if (!result.passive_passed) {
    return 'Anti-spoof score too low. Improve lighting and remove any screen or photo held up to the camera.'
  }
  if (!result.challenges_passed?.includes('blink')) {
    return 'Blink not detected. Blink twice clearly during the recording window.'
  }
  return 'Please try again.'
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
