import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// BlinkWipe — the screen blinks, and when it opens the decision is there.
//
// The last thing the desk reads is the candidate's eye, so the step after
// it is handed over the way an eye hands over: the lids sweep shut, the
// work happens in the dark, and they open on the record. Closing is quick
// and opening is slower, which is how a real blink is timed.
//
// The lids hold shut while `hold` is true — the record is still being
// saved — up to a limit, so the page is never revealed half-made.
//
// props: active, hold, onShut (fires the moment it goes dark), onDone

const CLOSE = 420, SHUT = 250, OPEN = 620, MAX_HOLD = 1800

const easeInOut = (x) => (x < 0.5 ? 2 * x * x : 1 - ((-2 * x + 2) ** 2) / 2)
const easeOut = (x) => 1 - (1 - x) ** 3

export default function BlinkWipe({ active, hold = false, onShut, onDone }) {
  const [p, setP] = useState(0)                 // 0 open, 1 shut
  const [live, setLive] = useState(false)
  const fns = useRef({ onShut, onDone, hold })
  fns.current = { onShut, onDone, hold }

  useEffect(() => {
    if (!active) { setP(0); setLive(false); return undefined }

    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) { fns.current.onShut?.(); fns.current.onDone?.(); return undefined }

    setLive(true)
    const t0 = performance.now()
    let raf = 0, shutAt = null, openAt = null, fired = false

    const frame = (now) => {
      const t = now - t0
      if (t < CLOSE) {
        setP(easeInOut(t / CLOSE))
      } else {
        if (!fired) { fired = true; fns.current.onShut?.() }
        if (shutAt === null) shutAt = now
        if (openAt === null) {
          setP(1)
          const held = now - shutAt
          if (held > SHUT && (!fns.current.hold || held > MAX_HOLD)) openAt = now
        } else {
          const o = (now - openAt) / OPEN
          if (o >= 1) { setP(0); setLive(false); fns.current.onDone?.(); return }
          setP(1 - easeOut(o))
        }
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [active])

  if (!active || !live) return null

  const e = -3 + p * 56                    // where the upper lid has got to
  const f = 103 - p * 56                   // and the lower
  const bulge = 4.5 * (1 - p * 0.35)       // the curve of the lid margin
  const seam = p > 0.9 ? (p - 0.9) / 0.1 : 0
  const rim = (0.5 * (1 - p * 0.55)).toFixed(2)

  return createPortal(
    <div className="fixed inset-0 z-[95]" style={{ pointerEvents: p > 0.02 ? 'auto' : 'none' }} aria-hidden="true">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full">
        <defs>
          <linearGradient id="bw-top" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#120C28" />
            <stop offset=".72" stopColor="#241A4C" />
            <stop offset="1" stopColor="#3B2B70" />
          </linearGradient>
          <linearGradient id="bw-bottom" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stopColor="#120C28" />
            <stop offset=".72" stopColor="#241A4C" />
            <stop offset="1" stopColor="#3B2B70" />
          </linearGradient>
          <filter id="bw-soft" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation=".45" />
          </filter>
        </defs>

        <g filter="url(#bw-soft)">
          <path d={`M-2 -8H102V${e.toFixed(2)}Q50 ${(e + bulge * 2).toFixed(2)} -2 ${e.toFixed(2)}Z`} fill="url(#bw-top)" />
          <path d={`M-2 108H102V${f.toFixed(2)}Q50 ${(f - bulge * 2).toFixed(2)} -2 ${f.toFixed(2)}Z`} fill="url(#bw-bottom)" />
        </g>

        {/* the light that catches each lid margin as it travels */}
        <path d={`M-2 ${e.toFixed(2)}Q50 ${(e + bulge * 2).toFixed(2)} 102 ${e.toFixed(2)}`}
              fill="none" stroke="#C9BDFA" strokeWidth=".3" opacity={rim} />
        <path d={`M-2 ${f.toFixed(2)}Q50 ${(f - bulge * 2).toFixed(2)} 102 ${f.toFixed(2)}`}
              fill="none" stroke="#C9BDFA" strokeWidth=".3" opacity={rim} />

        {/* and the seam where they meet */}
        {seam > 0 && (
          <g opacity={seam.toFixed(2)}>
            <rect x="0" y="49.1" width="100" height="1.8" fill="#6E56C8" opacity=".45" />
            <rect x="0" y="49.85" width="100" height=".3" fill="#E4DCFF" opacity=".75" />
          </g>
        )}
      </svg>
    </div>,
    document.body,
  )
}
