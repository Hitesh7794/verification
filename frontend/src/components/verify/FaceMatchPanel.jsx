import { useEffect, useRef, useState } from 'react'
import { Button } from '../ui/ui.jsx'
import { postFaceMatch } from '../../lib/api.js'

// FaceMatchPanel — paid identity match. Runs completely automatically:
// no button, no countdown. The instant the webcam is streaming (this
// component only mounts after LivenessPanel.onPass), a single JPEG
// frame is grabbed and POSTed to /api/face-match. Backend loads the
// enrolled photo from S3 and forwards both to TrustView for
// cosine-similarity scoring. Result panel shows score / threshold
// plus a Retake button.
//
// No priming countdown here: LivenessPanel already dwelt 1.6s on its
// "Liveness verified" success moment before handing off, and the
// operator's face is by definition centred and lit (they just blinked
// twice at the same camera one second ago). Adding another 1.5s of
// "Get ready" would just delay the score without improving the shot.
//
// The wallet debit happens on this call (liveness is free). If the
// server refuses with 412 (liveness gate expired), the parent bounces
// the operator back to LivenessPanel — this component doesn't own that
// recovery.
//
// The TrustView match runs on the server, NOT on the operator laptop —
// no per-laptop daemon, no install for the face channel.

// grabFrame retries: getUserMedia can flip streaming=true before the
// first frame is fully decoded, so v.videoWidth is briefly 0. Wait a
// few 100ms ticks before giving up.
const FRAME_RETRY_MS = 100
const FRAME_MAX_TRIES = 20

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
    // idle | matching | result | error
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
    setPhase('matching')

    // The webcam element sometimes reports streaming=true before the
    // first frame is decoded, so v.videoWidth is briefly 0 and the
    // toDataURL call returns a black rectangle. Poll for a real frame
    // for up to 2s before giving up.
    let dataURL = null
    for (let i = 0; i < FRAME_MAX_TRIES; i++) {
      dataURL = captureSnapshot()
      if (dataURL) break
      await sleep(FRAME_RETRY_MS)
    }
    if (!dataURL) {
      setPhase('error')
      setCallErr('Camera did not deliver a frame. Click Retake to try again.')
      return
    }
    setSnap(dataURL)

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

  const active = phase === 'matching'

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        {/* Live preview → captured snapshot swap. No overlay — the
            capture happens the instant the camera is ready, so there's
            no "get ready" moment worth showing. */}
        <div className="aspect-video w-full rounded-lg bg-slate-900 overflow-hidden border border-slate-200 relative">
          {snap ? (
            <img src={snap} alt="captured" className="w-full h-full object-cover" />
          ) : (
            <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
          )}
        </div>

        {/* Status / result panel */}
        <div className="aspect-video w-full rounded-lg bg-slate-50 border border-dashed border-slate-300 flex items-center justify-center text-center p-3">
          {phase === 'idle' && !streaming && !webcamErr && (
            <p className="text-xs text-slate-500">Starting camera…</p>
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
