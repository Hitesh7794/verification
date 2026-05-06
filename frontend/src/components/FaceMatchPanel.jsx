import { useEffect, useRef, useState } from 'react'
import { Button } from './ui.jsx'
import { postFaceMatch } from '../lib/api.js'

// FaceMatchPanel orchestrates the face capture step:
//   1. Live webcam preview (getUserMedia)
//   2. Operator clicks Capture → JPEG snapshot
//   3. Snapshot is POSTed to /api/face-match — backend looks up the
//      enrolled gallery template, forwards to luxand-service, returns
//      the cosine-similarity score + server-computed threshold + status
//   4. Result panel shows score / threshold inline, parent gets a
//      structured result object via onResult so the Dashboard can
//      propagate face_match_score into the verifications submit
//
// Same design language as FingerprintCapture: status banner, score+
// threshold readout, retake button. Operator never sees an "auth this"
// or "select webcam" decision — first available webcam is used silently.
//
// Note: the Luxand match runs on the server, NOT on the operator laptop.
// That makes face the only fully OS-independent biometric channel — no
// per-laptop daemon, no install. Matches happen in the central server's
// luxand-service via libfsdk.so.

export default function FaceMatchPanel({
  rollNo,
  onResult, // ({ ok, score, threshold, faceFound, captured, raw }) => void
}) {
  const videoRef = useRef(null)
  const [streaming, setStreaming] = useState(false)
  const [webcamErr, setWebcamErr] = useState('')
  const [snap, setSnap] = useState(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [callErr, setCallErr] = useState('')

  // Boot webcam on mount, release on unmount.
  useEffect(() => {
    let stream
    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          setStreaming(true)
        }
      } catch (e) {
        setWebcamErr('Unable to access webcam. ' + e.message)
      }
    }
    start()
    return () => {
      if (stream) stream.getTracks().forEach((t) => t.stop())
    }
  }, [])

  function captureSnapshot() {
    const v = videoRef.current
    if (!v) return null
    const canvas = document.createElement('canvas')
    canvas.width = v.videoWidth
    canvas.height = v.videoHeight
    canvas.getContext('2d').drawImage(v, 0, 0)
    // 0.85 quality is what Luxand's reference samples use. Smaller files
    // = lower upload latency without measurable accuracy loss.
    return canvas.toDataURL('image/jpeg', 0.85)
  }

  async function captureAndMatch() {
    setBusy(true)
    setCallErr('')
    setResult(null)
    try {
      const dataURL = captureSnapshot()
      if (!dataURL) {
        setCallErr('No webcam frame available')
        return
      }
      setSnap(dataURL)

      const resp = await postFaceMatch(rollNo, dataURL)
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
      onResult?.(out)
    } catch (e) {
      setCallErr(e.message || 'face match failed')
    } finally {
      setBusy(false)
    }
  }

  function retake() {
    setSnap(null)
    setResult(null)
    setCallErr('')
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="aspect-video w-full rounded-lg bg-slate-900 overflow-hidden border border-slate-200">
          {snap ? (
            <img src={snap} alt="captured" className="w-full h-full object-cover" />
          ) : (
            <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
          )}
        </div>
        <div className="aspect-video w-full rounded-lg bg-slate-50 border border-dashed border-slate-300 flex items-center justify-center text-center p-3">
          {result ? (
            <ResultBox result={result} />
          ) : busy ? (
            <div className="text-sm text-slate-600">
              <div className="h-12 w-12 mx-auto rounded-full border-4 border-indigo-200 border-t-indigo-600 animate-spin" />
              <p className="mt-2">Matching against enrolled photo…</p>
            </div>
          ) : (
            <p className="text-xs text-slate-500">
              Click <span className="font-medium text-slate-700">Capture &amp; match</span><br />
              The server will compare against the enrolled photo.
            </p>
          )}
        </div>
      </div>

      {webcamErr && <p className="text-xs text-rose-600">{webcamErr}</p>}
      {callErr && (
        <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
          {callErr}
        </div>
      )}

      <div className="flex gap-2">
        {result ? (
          <Button variant="secondary" onClick={retake}>Retake</Button>
        ) : (
          <>
            <Button onClick={captureAndMatch} disabled={!streaming || busy}>
              {busy ? 'Matching…' : 'Capture & match'}
            </Button>
            {/* When the webcam is unavailable (no camera, permission denied,
                or the Luxand service is unreachable on this host), the
                operator otherwise gets stuck at Step 2. This skip path
                emits a "no biometric attempted" result so the workflow can
                proceed to fingerprint / iris / decision — those channels
                are independent. The verifications row records face_match=
                false, which is the truth. */}
            {(!streaming || webcamErr) && (
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
                  onResult?.(out)
                }}
              >
                Skip face step
              </Button>
            )}
          </>
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
