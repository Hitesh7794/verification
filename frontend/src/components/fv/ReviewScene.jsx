import { useEffect, useState } from 'react'
import Verifier from '../login/Verifier.jsx'

// ReviewScene — the exam board's living background: the review desk.
//
// An institution's file slides onto the desk, the companion runs his
// magnifying glass across its papers, then a stamp comes down: violet tick
// for approved, amber cross for the ones sent back (he frowns at those).
// The file slides off into the tray and the next one arrives. A shelf of
// exam boxes stands behind him. Flat FlatViolet. ?review_t=<s> freezes it.

const V = '#5B3FA6', VD = '#43307D', VS = '#9A86D6', T = '#DDD5F2', L = '#EFEBF9'
const W = '#FFFFFF', INK = '#211E33', SAF = '#F28C28', MARK = '#A8711F'

const IN = 0.8, CHECK = 1.6, STAMP = 0.9, OUT = 0.8
const CYCLE = IN + CHECK + STAMP + OUT
const clamp = (x) => Math.max(0, Math.min(1, x))
const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2)
const easeOutBack = (x) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2) }
const hash = (n) => { const x = Math.sin(n * 57.3 + 4.1) * 43758.5453; return x - Math.floor(x) }

export default function ReviewScene({ className = '', style }) {
  const frozen = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('review_t') : null
  const [t, setT] = useState(frozen != null ? Number(frozen) : 1.1)
  useEffect(() => {
    if (frozen != null) return undefined
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined
    let raf = 0, last = performance.now(), acc = 1.1, lastPaint = 0
    const loop = (now) => {
      raf = requestAnimationFrame(loop)
      acc += Math.min(0.1, Math.max(0, (now - last) / 1000)); last = now
      if (now - lastPaint > 33) { lastPaint = now; setT(acc) }
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [frozen])

  const k = Math.floor(t / CYCLE)
  const u = t % CYCLE
  const rejected = hash(k) < 0.25
  const fileX = u < IN ? 420 - ease(u / IN) * 200          // sliding in from the right
    : u > IN + CHECK + STAMP ? 220 - ease((u - IN - CHECK - STAMP) / OUT) * 210
      : 220
  const fileO = u > IN + CHECK + STAMP ? 1 - clamp((u - IN - CHECK - STAMP - 0.4) / 0.4) : 1
  const checking = u >= IN && u < IN + CHECK
  const lensX = checking ? 176 + Math.sin(((u - IN) / CHECK) * Math.PI * 2) * 52 : null
  const stampU = u >= IN + CHECK && u < IN + CHECK + STAMP ? (u - IN - CHECK) / STAMP : null
  const stampDrop = stampU == null ? 0 : stampU < 0.4 ? stampU / 0.4 : stampU < 0.55 ? 1 : 1 - (stampU - 0.55) / 0.45
  const inked = stampU != null && stampU > 0.45
  const mood = checking ? 'detective' : stampU != null ? (rejected ? 'confused' : 'right') : 'waiting'
  const trayCount = (k % 4) + 1

  return (
    <div aria-hidden="true" className={`pointer-events-none select-none ${className}`} style={style}>
      <div className="relative h-full w-full">
        {/* him, at the desk */}
        <div className="absolute" style={{ left: '30%', top: '-2%', width: '32%', aspectRatio: '1 / 1' }}>
          <Verifier mood={{ type: mood }} className="h-full w-full" />
        </div>
        <svg viewBox="0 0 440 300" className="absolute inset-0 h-full w-full">
          {/* the shelf of exam boxes behind him */}
          <rect x="18" y="52" width="120" height="8" rx="3" fill={VD} />
          {[0, 1, 2].map((i) => (
            <g key={i} transform={`translate(${24 + i * 38} 18)`}>
              <rect width="32" height="34" rx="3" fill={i === 1 ? VS : L} stroke={VS} strokeWidth="2" />
              <rect x="6" y="9" width="20" height="4" rx="2" fill={W} />
              <rect x="6" y="17" width="13" height="4" rx="2" fill={W} />
            </g>
          ))}

          {/* the desk */}
          <rect x="10" y="196" width="420" height="12" rx="5" fill={VD} />
          <rect x="22" y="206" width="396" height="94" fill={VS} />

          {/* the out tray, with what he's already done */}
          <g transform="translate(46 196)">
            {Array.from({ length: trayCount }).map((_, i) => (
              <rect key={i} x={-18 + i * 1.5} y={-6 - i * 5} width="58" height="7" rx="2" fill={W} stroke={T} strokeWidth="1.4" />
            ))}
            <path d="M-26 0h74l-8 -12h-58z" fill={VD} />
          </g>

          {/* the file being reviewed */}
          <g transform={`translate(${fileX} 118)`} opacity={fileO}>
            <rect width="132" height="78" rx="6" fill={W} stroke={T} strokeWidth="2.4" />
            <rect width="132" height="12" rx="5" fill={V} />
            {/* the institution's crest and name */}
            <g transform="translate(14 22)">
              <path d="M0 18l12-7 12 7z" fill={VD} />
              <rect x="1" y="18" width="22" height="14" fill={L} />
              {[4, 10, 16].map((x) => <rect key={x} x={x} y="20" width="3" height="12" fill={W} />)}
            </g>
            <rect x="48" y="24" width="60" height="6" rx="3" fill={T} />
            <rect x="48" y="36" width="42" height="5" rx="2.5" fill={L} />
            {/* its documents */}
            {[0, 1, 2].map((i) => (
              <rect key={i} x={14 + i * 26} y="56" width="22" height="14" rx="2" fill={L} stroke={VS} strokeWidth="1.4" />
            ))}
            {/* the decision, once it lands */}
            {inked && (
              <g transform="translate(104 60) rotate(-14)" opacity={clamp((stampU - 0.45) * 8)}>
                <circle r="16" fill="none" stroke={rejected ? MARK : V} strokeWidth="3.4" />
                {rejected
                  ? <path d="M-6 -6l12 12M6 -6l-12 12" stroke={MARK} strokeWidth="3.4" strokeLinecap="round" />
                  : <path d="M-7 0l4.5 4.5 9.5-10" fill="none" stroke={V} strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />}
              </g>
            )}
          </g>

          {/* his magnifying glass, running across the papers */}
          {lensX != null && (
            <g transform={`translate(${lensX} 150)`}>
              <line x1="20" y1="-18" x2="38" y2="-38" stroke={MARK} strokeWidth="6" strokeLinecap="round" />
              <circle r="26" fill={L} fillOpacity=".4" stroke={VD} strokeWidth="5" />
              <path d="M-14 -13a18 18 0 0 1 10 -6" stroke={W} strokeWidth="3.4" strokeLinecap="round" fill="none" />
            </g>
          )}

          {/* the stamp coming down on the file */}
          {stampU != null && (
            <g transform={`translate(324 ${96 + stampDrop * 66}) scale(1 ${stampU > 0.4 && stampU < 0.55 ? 0.88 : 1})`}>
              <ellipse cx="0" cy="0" rx="17" ry="5" fill={VD} />
              <rect x="-15" y="-9" width="30" height="10" rx="3" fill={VD} />
              <rect x="-6" y="-30" width="12" height="22" rx="4" fill={rejected ? MARK : '#99641B'} />
              <circle cx="0" cy="-33" r="9" fill="#C99A50" />
            </g>
          )}
        </svg>
      </div>
    </div>
  )
}
