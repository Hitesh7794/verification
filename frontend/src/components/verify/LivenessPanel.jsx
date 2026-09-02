import { useEffect, useRef, useState } from 'react'
import { Button } from '../ui/ui.jsx'
import { postLivenessClientVerified } from '../../lib/api.js'

// LivenessPanel — active anti-spoof gate that runs BEFORE the paid
// face-match step.
//
// This build uses MediaPipe FaceLandmarker (self-hosted, see
// public/mediapipe/) via the global window.seqrFaceGuide loaded from
// public/face_guide.js. Detection is entirely on-device: no frames
// stream to the server, and no Luxand round-trip. When a valid blink
// completes:
//   1. Grab the current video frame as a JPEG.
//   2. POST to /liveness-client-verified so the server records the
//      gate row (this is where the wallet charge fires — billing is
//      engine-agnostic).
//   3. Hand the captured frame back to the parent as `faceFrame`.
//      The parent's downstream TrustView face-match against the
//      enrolled photo is UNCHANGED — that's a separate call.
//
// Fallback: if MediaPipe fails to load (blocked WASM, unusual browser),
// face_guide.js emits status='__error__'; we surface a helpful message
// and let the operator retry. If retries keep failing, that's a client-
// build problem the operator can't self-solve, but the old Luxand path
// is still wired at /api/candidates/{roll}/liveness-check for a manual
// fallback if support asks.

export default function LivenessPanel({ rollNo, sessionId, onPass }) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const canvasRef = useRef(document.createElement('canvas'))

  // 'idle' — camera booting or waiting for Start
  // 'guiding' — MediaPipe is running, showing framing hints
  // 'uploading' — blink detected, POSTing to server
  // 'pass' — server recorded the gate row; auto-advancing
  // 'fail' — MediaPipe or server error; retry button shown
  const [phase, setPhase] = useState('idle')
  const [streaming, setStreaming] = useState(false)
  const [webcamErr, setWebcamErr] = useState('')
  const [status, setStatus] = useState({ text: 'Starting camera…', tone: 'ok' })
  const [err, setErr] = useState('')

  // Boot webcam on mount (same shape the Luxand version used — face_guide.js
  // reuses whatever <video> already has a live stream).
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
    // Warm up MediaPipe in parallel with camera boot so blink
    // detection is instant once the operator clicks Start.
    try { window.seqrFaceGuide?.preload?.() } catch (_) {}
    return () => {
      try { window.seqrFaceGuide?.stop?.() } catch (_) {}
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop())
        streamRef.current = null
      }
    }
  }, [])

  // Capture the current frame as a JPEG data URL for the parent's
  // downstream TrustView face-match. Called at the moment MediaPipe
  // fires onBlink — face_guide.js already delays ~420ms after eyes
  // reopen so the frame catches an open-eyes moment.
  function grabFrame() {
    const v = videoRef.current
    if (!v || !v.videoWidth) return null
    const canvas = canvasRef.current
    canvas.width = v.videoWidth
    canvas.height = v.videoHeight
    canvas.getContext('2d').drawImage(v, 0, 0)
    return canvas.toDataURL('image/jpeg', 0.85)
  }

  function statusFromGuide(state, level) {
    // face_guide.js emits: state ∈ {'center','closer','back','hold','blink','__error__'}
    // level ∈ {'none','ok','ready','warn','error'}.
    if (state === '__error__') {
      return {
        text: "Couldn't load the liveness engine. Refresh the page or try a different browser.",
        tone: 'error',
      }
    }
    if (level === 'none')  return { text: 'Look straight at the camera.',            tone: 'ok' }
    if (state === 'closer') return { text: 'Move closer to the camera.',              tone: 'warn' }
    if (state === 'back')   return { text: 'Move a bit further from the camera.',    tone: 'warn' }
    if (state === 'center') return { text: 'Centre your face in the frame.',         tone: 'warn' }
    if (state === 'blink')  return { text: 'Now blink.',                              tone: 'ready' }
    // 'hold' with level=ok → framing but not yet armed. Coach "hold still".
    return { text: 'Hold still…', tone: 'ok' }
  }

  async function run() {
    if (!window.seqrFaceGuide) {
      setPhase('fail')
      setErr('Liveness engine did not load. Refresh the page and try again.')
      return
    }
    setErr('')
    setPhase('guiding')
    setStatus({ text: 'Look straight at the camera.', tone: 'ok' })

    window.seqrFaceGuide.start(
      // onStatus — framing / coaching hints
      (state, level) => {
        setStatus(statusFromGuide(state, level))
        if (state === '__error__') {
          setPhase('fail')
          setErr('Liveness engine error. Refresh and try again.')
        }
      },
      // onBlink — fired ONCE per session after a valid blink + delay
      async () => {
        const faceFrame = grabFrame()
        setPhase('uploading')
        setStatus({ text: 'Confirming with server…', tone: 'ok' })
        try {
          const r = await postLivenessClientVerified(rollNo, sessionId)
          setPhase('pass')
          setStatus({ text: 'Live person confirmed', tone: 'ready' })
          // Same 1.6s beat the old flow used so the operator sees the
          // green checkmark before face-match kicks in.
          await sleep(1600)
          onPass?.({
            sessionId: r.session_id,
            expiresIn: r.expires_in_seconds || 90,
            faceFrame,
          })
        } catch (e) {
          setPhase('fail')
          setErr(e?.message || 'Server did not accept the liveness pass. Please retry.')
        }
      }
    )
  }

  function retry() {
    try { window.seqrFaceGuide?.stop?.() } catch (_) {}
    setErr('')
    setPhase('idle')
    setStatus({ text: streaming ? 'Ready.' : 'Starting camera…', tone: 'ok' })
  }

  const active = phase === 'guiding' || phase === 'uploading'
  const toneClass =
    status.tone === 'warn'  ? 'text-amber-700'  :
    status.tone === 'ready' ? 'text-emerald-700' :
    status.tone === 'error' ? 'text-rose-700'   : 'text-slate-700'

  return (
    // Cap the panel width so a 1440-px+ viewport doesn't blow the two
    // aspect-square tiles up to 600+ px each and push the Start button
    // below the fold. Narrow screens (<768 px) are a no-op — the
    // container just fills its parent. Combined with putting the CTA
    // inside the right tile (no separate button row), the whole
    // liveness surface fits in one viewport with no scroll.
    <div className="space-y-2 mx-auto max-w-3xl">
      <div className="grid grid-cols-2 gap-2">
        {/* Face-frame preview — circular mask + glowing coloured border
            that tracks the guide state so the operator sees at a glance
            whether they're framed correctly. */}
        <FaceFrame
          phase={phase}
          hintTone={status.tone}
          videoRef={videoRef}
        />

        {/* Right tile: instructions + CTA co-located. Was previously a
            near-empty aspect-square with the button sitting in its own
            row below the tile grid — that layout stacked to ~750+ px
            tall on a 1366×768 laptop and forced the operator to scroll
            past the whole grid to see Start. Moving the button in here
            keeps the visual weight balanced with the preview and puts
            the CTA in the operator's line of sight the moment the
            camera lights up. */}
        <div className="aspect-square w-full rounded-lg bg-slate-50 border border-dashed border-slate-300 flex flex-col items-center justify-center text-center p-5 gap-4">
          <div className="flex-1 flex items-center justify-center">
            {phase === 'idle' && !streaming && !webcamErr && (
              <p className="text-xs text-slate-500">Starting camera…</p>
            )}
            {phase === 'idle' && streaming && (
              <div className="text-sm text-slate-700 space-y-2">
                <p className="font-semibold">Blink to prove you're present</p>
                <p className="text-xs text-slate-600">
                  Look at the camera and blink once when prompted. Detection runs
                  entirely on this device.
                </p>
              </div>
            )}
            {active && (
              <div className={`text-sm font-medium ${toneClass}`}>
                {status.text}
              </div>
            )}
            {phase === 'pass' && (
              <div className="text-emerald-700 space-y-1">
                <p className="font-semibold">Live person confirmed</p>
                <p className="text-xs text-slate-600">Continuing to face capture…</p>
              </div>
            )}
            {phase === 'fail' && (
              <div className="text-rose-700 space-y-1">
                <p className="font-semibold">Liveness check failed</p>
                <p className="text-xs text-slate-600">{err || 'Please try again.'}</p>
              </div>
            )}
          </div>

          {/* CTA sits at the bottom of the tile so it's always in the
              same spot regardless of which phase text is rendered above. */}
          <div className="w-full">
            {phase === 'pass' ? null : phase === 'fail' ? (
              <Button onClick={retry} className="w-full">Retry liveness</Button>
            ) : (
              <Button onClick={run} disabled={!streaming || active} className="w-full">
                {phase === 'uploading' ? 'Confirming…' : phase === 'guiding' ? 'Running…' : 'Start liveness check'}
              </Button>
            )}
          </div>
        </div>
      </div>

      {webcamErr && <p className="text-xs text-rose-600 text-center">{webcamErr}</p>}
    </div>
  )
}

// FaceFrame — circular camera preview with a coloured, pulsing glow
// ring around it. Tone flips with the guide state so the operator sees
// the frame turn green the moment framing + blink are locked in.
//
//   phase='idle'   → dim slate ring, no pulse
//   phase='guiding'
//     hintTone='ok'    → indigo, gentle pulse (framed, waiting for arm)
//     hintTone='warn'  → amber, pulse (too close / too far / off-centre)
//     hintTone='ready' → emerald, steady (armed → "now blink")
//     hintTone='error' → rose, steady
//   phase='uploading' → emerald, gentle pulse
//   phase='pass'     → emerald, steady bright + big check overlay
//   phase='fail'     → rose, steady
function FaceFrame({ phase, hintTone, videoRef }) {
  const { ringClass, pulse, glow } = ringStyleFor(phase, hintTone)
  return (
    <div className="aspect-square w-full flex items-center justify-center bg-slate-950 rounded-lg overflow-hidden relative">
      {/* Outer glow ring — sits behind the circle-clipped video */}
      <div
        className={`absolute rounded-full transition-all duration-300 ${pulse ? 'animate-pulse' : ''}`}
        style={{
          width: '86%',
          height: '86%',
          boxShadow: glow,
        }}
        aria-hidden
      />
      {/* Solid-colour ring on the edge of the circle */}
      <div
        className={`absolute rounded-full border-4 transition-colors duration-300 ${ringClass}`}
        style={{ width: '86%', height: '86%' }}
        aria-hidden
      />
      {/* Circle-clipped video preview — user's own reflection sits
          inside the ring so they can self-centre without a mirror.
          object-cover means their face fills the circle regardless of
          camera aspect. scaleX(-1) mirrors so left/right feels natural. */}
      <div
        className="rounded-full overflow-hidden bg-slate-900"
        style={{ width: '82%', height: '82%' }}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="w-full h-full object-cover"
          style={{ transform: 'scaleX(-1)' }}
        />
      </div>

      {phase === 'guiding' && (
        <div className="absolute top-2 left-2 inline-flex items-center gap-1.5 rounded-md bg-emerald-600 text-white px-2 py-0.5 text-[11px] font-semibold">
          <span className="h-1.5 w-1.5 rounded-full bg-white animate-pulse" />
          LIVE
        </div>
      )}

      {phase === 'pass' && (
        <div className="absolute inset-0 flex items-center justify-center bg-emerald-600/70">
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
  )
}

function ringStyleFor(phase, hintTone) {
  // Steady / pulse + glow shadow presets. glow is a boxShadow — bigger
  // spread when unarmed to advertise "still working", tighter when
  // locked in.
  if (phase === 'idle') {
    return { ringClass: 'border-slate-700', pulse: false, glow: '0 0 0 0 rgba(0,0,0,0)' }
  }
  if (phase === 'pass') {
    return { ringClass: 'border-emerald-400', pulse: false, glow: '0 0 40px 8px rgba(16,185,129,0.75)' }
  }
  if (phase === 'fail' || hintTone === 'error') {
    return { ringClass: 'border-rose-500', pulse: false, glow: '0 0 24px 6px rgba(244,63,94,0.55)' }
  }
  if (phase === 'uploading') {
    return { ringClass: 'border-emerald-400', pulse: true, glow: '0 0 28px 6px rgba(16,185,129,0.55)' }
  }
  // guiding
  if (hintTone === 'ready') {
    return { ringClass: 'border-emerald-400', pulse: false, glow: '0 0 32px 8px rgba(16,185,129,0.75)' }
  }
  if (hintTone === 'warn') {
    return { ringClass: 'border-amber-400', pulse: true, glow: '0 0 32px 10px rgba(245,158,11,0.55)' }
  }
  // ok — framed but not yet armed (holding still)
  return { ringClass: 'border-indigo-400', pulse: true, glow: '0 0 32px 10px rgba(99,102,241,0.55)' }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
