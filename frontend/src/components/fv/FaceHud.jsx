import { useEffect, useRef, useState } from 'react'

// FaceHud — the guide the portal draws over the live camera.
//
// A head-and-shoulders silhouette for the candidate to sit into. While the
// portal is still looking it is amber and dashed, the dashes march, a ring
// pulses out from the middle and thirds-marks show where to sit. The moment
// it has the face the outline snaps violet and solid, the brackets travel
// in, and the marks fade. The blink is read around the head as a ring of
// ticks lighting up one by one, and when it passes the whole guide gives
// way to a tick and a ring burst.
//
// props: faceDetected, blinkProgress (0..100), passed

const V = '#5B3FA6', W = '#FFFFFF', AMB = '#E4A54B'
const TICKS = 28

export default function FaceHud({ faceDetected = false, blinkProgress = 0, passed = false }) {
  const [t, setT] = useState(0)
  const grip = useRef(0)
  const win = useRef(0)
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined
    let raf = 0, last = performance.now(), acc = 0, paint = 0
    const loop = (now) => {
      raf = requestAnimationFrame(loop)
      const dt = Math.min(0.06, (now - last) / 1000); last = now
      acc += dt
      grip.current += ((faceDetected || passed ? 1 : 0) - grip.current) * Math.min(1, dt * 6)
      win.current += ((passed ? 1 : 0) - win.current) * Math.min(1, dt * 5)
      if (now - paint > 26) { paint = now; setT(acc) }
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [faceDetected, passed])

  const g = grip.current, won = win.current
  const tone = passed || faceDetected ? V : AMB
  const cx = 50, cy = 43
  const breathe = 1 + (1 - g) * Math.sin(t * 2.2) * 0.014
  const rx = (20.5 - g * 1.3) * breathe, ry = (26.5 - g * 1.7) * breathe
  const p = Math.max(0, Math.min(100, passed ? 100 : blinkProgress)) / 100
  const lit = Math.round(p * TICKS)
  const march = (t * 9) % 9
  const pulse = ((t * 0.6) % 1)
  const inn = g * 3
  const x = 15 + inn, y = 9 + inn, w = 70 - inn * 2, h = 82 - inn * 2
  const arm = 9 + g * 2
  const shoulders = `M${(cx - rx * 1.85).toFixed(1)} 98q0 -19 ${(rx * 1.85).toFixed(1)} -19t${(rx * 1.85).toFixed(1)} 19`

  return (
    <svg viewBox="0 0 100 100" className="pointer-events-none absolute inset-0 h-full w-full">
      <defs>
        <mask id="fhMask">
          <rect x="0" y="0" width="100" height="100" fill="#fff" />
          <ellipse cx={cx} cy={cy} rx={(rx + 1).toFixed(2)} ry={(ry + 1).toFixed(2)} fill="#000" />
          <path d={`${shoulders}z`} fill="#000" />
        </mask>
      </defs>

      {/* what is not the candidate sits back */}
      <rect x="0" y="0" width="100" height="100" fill="#0E0B1C"
            opacity={(0.36 - g * 0.14 - won * 0.1).toFixed(2)} mask="url(#fhMask)" />

      {/* while it looks: a pulse out of the middle, and thirds to sit by */}
      {!passed && (
        <>
          <ellipse cx={cx} cy={cy} rx={(rx * (0.7 + pulse * 1.5)).toFixed(1)} ry={(ry * (0.7 + pulse * 1.5)).toFixed(1)}
                   fill="none" stroke={tone} strokeWidth=".8" opacity={((1 - pulse) * 0.32 * (1 - g)).toFixed(2)} />
          <g stroke={W} strokeWidth=".5" opacity={((1 - g) * 0.22).toFixed(2)}>
            <path d={`M${cx} ${y + 4}v6M${cx} ${y + h - 10}v6M${x + 4} ${cy}h6M${x + w - 10} ${cy}h6`} />
          </g>
        </>
      )}

      {/* the guide */}
      <g fill="none" stroke={tone} strokeLinecap="round" opacity={(1 - won * 0.85).toFixed(2)}>
        <ellipse cx={cx} cy={cy} rx={rx.toFixed(2)} ry={ry.toFixed(2)} strokeWidth={(1.1 + g * 0.5).toFixed(2)}
                 strokeDasharray={g > 0.65 ? 'none' : '5 4'} strokeDashoffset={g > 0.65 ? 0 : -march}
                 opacity=".95" />
        <path d={shoulders} strokeWidth={(1.1 + g * 0.4).toFixed(2)}
              strokeDasharray={g > 0.65 ? 'none' : '5 4'} strokeDashoffset={g > 0.65 ? 0 : -march} opacity=".7" />
      </g>

      {/* the blink, read tick by tick around the head */}
      <g opacity={(1 - won * 0.85).toFixed(2)}>
        {Array.from({ length: TICKS }).map((_, i) => {
          const a = (i / TICKS) * Math.PI * 2 - Math.PI / 2
          const c = Math.cos(a), s = Math.sin(a)
          const r0 = 2.6, r1 = i < lit ? 6 : 4.2
          return (
            <line key={i}
                  x1={(cx + c * (rx + r0)).toFixed(2)} y1={(cy + s * (ry + r0)).toFixed(2)}
                  x2={(cx + c * (rx + r1)).toFixed(2)} y2={(cy + s * (ry + r1)).toFixed(2)}
                  stroke={i < lit ? tone : W} strokeWidth={i < lit ? 1.5 : 0.7} strokeLinecap="round"
                  opacity={i < lit ? 0.95 : 0.22} />
          )
        })}
      </g>

      {/* the frame, travelling in as it locks */}
      <g fill="none" stroke={tone} strokeWidth={(1.6 + g * 0.6).toFixed(1)} strokeLinecap="round" strokeLinejoin="round"
         opacity={(0.55 + g * 0.35 - won * 0.6).toFixed(2)}>
        <path d={`M${x} ${y + arm}V${y + 4}a4 4 0 0 1 4-4h${arm}`} />
        <path d={`M${x + w} ${y + arm}V${y + 4}a4 4 0 0 0-4-4h-${arm}`} />
        <path d={`M${x} ${y + h - arm}V${y + h - 4}a4 4 0 0 0 4 4h${arm}`} />
        <path d={`M${x + w} ${y + h - arm}V${y + h - 4}a4 4 0 0 1-4 4h-${arm}`} />
      </g>

      {/* and when it passes */}
      {won > 0.02 && (
        <g transform={`translate(${cx} ${cy}) scale(${(0.6 + won * 0.4).toFixed(3)})`} opacity={Math.min(1, won * 1.5).toFixed(2)}>
          <circle r={(16 + (1 - won) * 26).toFixed(1)} fill="none" stroke={V} strokeWidth="1.6" opacity={((1 - won) * 0.8).toFixed(2)} />
          <circle r="15" fill={V} />
          <path d="M-6.5 .6l4.4 4.4 9-10" fill="none" stroke={W} strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      )}
    </svg>
  )
}
