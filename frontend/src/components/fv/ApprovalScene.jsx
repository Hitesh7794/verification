import { useEffect, useState } from 'react'
import Verifier from '../login/Verifier.jsx'

// ApprovalScene — the super admin's living background: the country board.
//
// A map board hangs on the wall with the institutions on it. One by one a
// pin drops onto a city, its card flips from waiting to approved, and the
// counter on the board ticks up; the companion stands beside the board and
// points each one in, then gives a thumbs-up when the row is full and the
// board resets. Flat FlatViolet. ?approval_t=<s> freezes it.

const V = '#5B3FA6', VD = '#43307D', VS = '#9A86D6', T = '#DDD5F2', L = '#EFEBF9'
const W = '#FFFFFF', INK = '#211E33', SAF = '#F28C28'

// A rough silhouette of India — a shape, not a survey map.
const INDIA = 'M104 18 L120 24 L133 14 L142 32 L133 46 L150 50 L172 46 L188 62 L196 82 L188 95 L168 100 '
  + 'L156 118 L148 142 L136 174 L122 212 L114 244 L106 214 L98 180 L84 150 L66 126 L54 102 L40 86 L32 64 '
  + 'L48 56 L64 50 L76 34 Z'
// where the pins land, in map coordinates
const PINS = [
  { x: 86, y: 74, name: 'Amritsar' },
  { x: 128, y: 96, name: 'Kanpur' },
  { x: 74, y: 118, name: 'Jaipur' },
  { x: 150, y: 132, name: 'Kolkata' },
  { x: 96, y: 164, name: 'Pune' },
  { x: 112, y: 206, name: 'Kochi' },
]
const PER = 1.5, END = 2.2
const CYCLE = PINS.length * PER + END
const clamp = (x) => Math.max(0, Math.min(1, x))
const easeOutBack = (x) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2) }

export default function ApprovalScene({ className = '', style }) {
  const frozen = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('approval_t') : null
  const [t, setT] = useState(frozen != null ? Number(frozen) : 0.5)
  useEffect(() => {
    if (frozen != null) return undefined
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined
    let raf = 0, last = performance.now(), acc = 0.5, lastPaint = 0
    const loop = (now) => {
      raf = requestAnimationFrame(loop)
      acc += Math.min(0.1, Math.max(0, (now - last) / 1000)); last = now
      if (now - lastPaint > 33) { lastPaint = now; setT(acc) }
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [frozen])

  const u = t % CYCLE
  const k = Math.min(PINS.length - 1, Math.floor(u / PER))     // the pin being placed
  const f = (u - k * PER) / PER
  const finishing = u >= PINS.length * PER
  const placed = finishing ? PINS.length : k
  const drop = finishing ? 1 : clamp(f / 0.45)
  const pop = finishing ? 1 : easeOutBack(clamp((f - 0.4) / 0.25))
  const count = placed + (pop > 0.5 ? 1 : 0)
  const mood = finishing ? 'thumbsUp' : f < 0.5 ? 'point' : 'right'

  return (
    <div aria-hidden="true" className={`pointer-events-none select-none ${className}`} style={style}>
      <div className="relative h-full w-full">
        {/* him, beside the board */}
        <div className="absolute" style={{ left: '2%', bottom: '2%', width: '34%', aspectRatio: '1 / 1' }}>
          <Verifier mood={{ type: mood }} className="h-full w-full" />
        </div>
        <svg viewBox="0 0 420 300" className="absolute inset-0 h-full w-full">
          {/* the board */}
          <rect x="150" y="10" width="262" height="282" rx="10" fill={W} stroke={T} strokeWidth="3" />
          <rect x="150" y="10" width="262" height="30" rx="9" fill={V} />
          <rect x="150" y="32" width="262" height="8" fill={V} />
          <rect x="168" y="19" width="70" height="10" rx="5" fill={VS} />
          {/* the counter on the board */}
          <g transform="translate(360 24)">
            <rect x="-26" y="-11" width="52" height="22" rx="7" fill={W} />
            <text x="0" y="6" textAnchor="middle" fontSize="15" fontWeight="800" fill={V} fontFamily="Bricolage Grotesque, sans-serif">{count}</text>
          </g>

          {/* the map */}
          <g transform="translate(196 44) scale(0.86)">
            <path d={INDIA} fill={L} stroke={VS} strokeWidth="3" strokeLinejoin="round" />
            {PINS.map((p, i) => {
              const on = i < placed
              const now = i === placed && !finishing
              if (!on && !now) return null
              const y = now ? p.y - 40 * (1 - drop) : p.y
              const s = now ? (pop > 0 ? pop : 0.001) : 1
              return (
                <g key={p.name} transform={`translate(${p.x} ${y})`}>
                  {/* the pin */}
                  <path d="M0 0c-4.6 0-8 3.4-8 8 0 5.6 8 12 8 12s8-6.4 8-12c0-4.6-3.4-8-8-8z"
                        transform="translate(0 -20)" fill={now && pop < 0.6 ? SAF : V} />
                  <circle cx="0" cy="-13" r="3.2" fill={W} />
                  {/* its approved tick, popping in */}
                  <g transform={`translate(11 -22) scale(${s})`}>
                    <circle r="6.5" fill={V} />
                    <path d="M-3 0l2 2 4-4.4" fill="none" stroke={W} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </g>
                </g>
              )
            })}
          </g>

          {/* the application cards stacked at the foot of the board */}
          <g transform="translate(168 250)">
            {[0, 1, 2].map((i) => (
              <g key={i} transform={`translate(${i * 78} 0)`}>
                <rect width="66" height="34" rx="5" fill={W} stroke={T} strokeWidth="2" />
                <rect width="66" height="7" rx="3.5" fill={i < count % 4 ? V : T} />
                <rect x="7" y="14" width="30" height="4" rx="2" fill={T} />
                <rect x="7" y="22" width="20" height="4" rx="2" fill={L} />
                {i < count % 4 && (
                  <g transform="translate(52 24)">
                    <circle r="7" fill={V} />
                    <path d="M-3 0l2 2 4-4.4" fill="none" stroke={W} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </g>
                )}
              </g>
            ))}
          </g>
        </svg>
      </div>
    </div>
  )
}
