import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import Verifier from '../login/Verifier.jsx'
import FaceHud from './FaceHud.jsx'

// CaptureStage — the photo step takes the whole screen.
//
// While the desk is capturing, nothing else matters: the live picture fills
// the display, the guide sits on the candidate's face, and the companion
// stands beside it and talks them through it — he points at the lens while
// the portal looks for a face, mimes the blink when it wants one, waits
// while it reads, and celebrates when it passes.

// He mimes the blink, waves them into frame, and keeps moving while the
// portal reads — each state has its own little loop.
const LOOPS = {
  // nothing found yet: catch their eye, then point at the lens
  looking: [{ type: 'wave' }, { type: 'point' }, { type: 'pointUp' }, { type: 'point' }],
  // face in frame: close the eyes, open them — do it with them
  blink: [{ type: 'covered' }, { type: 'covered', peek: true }, { type: 'idle' }, { type: 'covered' }, { type: 'covered', peek: true }],
  // the portal is reading: hold still, thumbs at the ready
  reading: [{ type: 'waiting' }, { type: 'waiting' }, { type: 'pointUp' }],
  // it passed
  won: [{ type: 'right' }, { type: 'matched' }, { type: 'thumbsUp' }],
}
const BEAT_MS = { looking: 1200, blink: 640, reading: 1100, won: 1300 }

function useCompanion({ passing, passed, faceDetected }) {
  const key = passed ? 'won' : passing ? 'reading' : faceDetected ? 'blink' : 'looking'
  const [beat, setBeat] = useState(0)
  useEffect(() => { setBeat(0) }, [key])
  useEffect(() => {
    const id = setInterval(() => setBeat((b) => b + 1), BEAT_MS[key])
    return () => clearInterval(id)
  }, [key])
  const loop = LOOPS[key]
  return key === 'won' ? loop[Math.min(beat, loop.length - 1)] : loop[beat % loop.length]
}

export default function CaptureStage({
  videoRef, snap, cameraActive, faceDetected, blinkProgress,
  passing, passed, frozen, error, line, onCapture, onRetake, onCarryOn, showRetake,
  onNext, nextLabel = ['Next', 'आगे'],
}) {
  const mood = useCompanion({ passing, passed, faceDetected })

  // Straight onto the body: the shell animates its content with a
  // transform, and a transformed ancestor would pin this overlay inside
  // the page instead of over the screen.
  return createPortal((
    <div className="fixed inset-0 z-[60] flex flex-col bg-[#0E0B1C]">
      {/* the picture, filling the display */}
      {frozen && snap ? (
        <img src={snap} alt="" className="absolute inset-0 h-full w-full object-cover opacity-90" />
      ) : (
        <video ref={videoRef} autoPlay playsInline muted
               className="absolute inset-0 h-full w-full object-cover"
               style={{ transform: 'scaleX(-1)' }} />
      )}

      {!cameraActive && !frozen && (
        <div className="absolute inset-0 grid place-items-center text-center">
          <div>
            <div className="mx-auto h-24 w-24 animate-pulse rounded-full bg-white/10" />
            <p className="mt-4 text-[17px] font-bold text-white">Starting the camera…</p>
            <p className="fv-hi mt-1 text-[14px] font-bold text-white/60">कैमरा शुरू हो रहा है</p>
          </div>
        </div>
      )}

      {!frozen && <FaceHud faceDetected={faceDetected} blinkProgress={blinkProgress} passed={passed} />}

      {/* the step */}
      <div className="relative flex items-start p-5">
        <span className="rounded-[12px] bg-white/10 px-4 py-2 backdrop-blur-sm">
          <span className="text-[15px] font-bold text-white">Step 2 of 4 · Face and liveness</span>
          <span className="fv-hi ml-2 text-[13px] font-bold text-white/70">चेहरा और जीवंतता</span>
        </span>
      </div>

      <div className="flex-1" />

      {/* him, guiding them through it */}
      <div className="relative flex flex-wrap items-end justify-between gap-6 px-8 pb-7 pt-24"
           style={{ background: 'linear-gradient(to top, rgba(14,11,28,.94), rgba(14,11,28,.72) 45%, rgba(14,11,28,0))' }}>
        <div className="flex items-end gap-4">
          <span className="h-[clamp(150px,30vh,300px)] w-[clamp(150px,30vh,300px)] shrink-0">
            <Verifier mood={mood} className="h-full w-full" />
          </span>
          <span className="pb-3 leading-tight">
            <span className="block text-[clamp(22px,3.8vh,38px)] font-bold tracking-[-0.025em] text-white">{line[0]}</span>
            <span className="fv-hi mt-1.5 block text-[clamp(16px,2.6vh,24px)] font-bold text-white/75">{line[1]}</span>
            {error && (
              <span className="mt-3 block max-w-[46ch] rounded-[10px] bg-[#A8711F]/25 px-3 py-2 text-[14px] font-bold text-[#F6E3C4]">
                {error}
              </span>
            )}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3 pb-3">
          {showRetake ? (
            <>
              <button type="button" onClick={onRetake} disabled={passing}
                      className="rounded-[12px] border-2 border-white/40 px-6 py-3 text-[16px] font-bold text-white transition hover:bg-white/10 disabled:opacity-50">
                Retake <span className="fv-hi ml-1 text-[14px] font-bold text-white/70">फिर से</span>
              </button>
              <button type="button" onClick={onCarryOn}
                      className="rounded-[12px] bg-fv-accent px-6 py-3 text-[16px] font-bold text-white transition hover:bg-fv-accent-deep">
                Carry on anyway
              </button>
            </>
          ) : passed ? (
            <button type="button" onClick={onNext}
                    className="rounded-[12px] bg-fv-accent px-8 py-3.5 text-[17px] font-bold text-white transition hover:bg-fv-accent-deep">
              {nextLabel[0]}
              <span className="fv-hi ml-2 text-[14px] font-bold text-white/80">{nextLabel[1]}</span>
              <span aria-hidden="true" className="ml-2">&rarr;</span>
            </button>
          ) : (
            <button type="button" onClick={onCapture} disabled={passing}
                    className="rounded-[12px] bg-fv-accent px-8 py-3.5 text-[17px] font-bold text-white transition hover:bg-fv-accent-deep disabled:opacity-60">
              {passing ? 'Reading the blink…' : 'Take the photo'}
              <span aria-hidden="true" className="ml-2">→</span>
            </button>
          )}
        </div>
      </div>
    </div>
  ), document.body)
}
