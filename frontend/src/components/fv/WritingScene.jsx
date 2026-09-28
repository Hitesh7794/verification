import { useEffect, useState } from 'react'
import Verifier from '../login/Verifier.jsx'

// WritingScene — the "My exams" living background: the companion at an
// exam desk, writing his paper.
//
// Handwriting runs across the sheet line by line behind a saffron pencil,
// and his eyes follow the pencil (the companion's typing mood, with the
// caret driven by the pen). Halfway down he stops, taps the pencil and
// thinks; then carries on. When the page is full it slides off the desk
// with a tick, he celebrates, and a fresh sheet slides in. A wall clock
// ticks above. Flat FlatViolet. ?writing_t=<s> freezes it for review.

const V = '#5B3FA6', VD = '#43307D', VS = '#9A86D6', T = '#DDD5F2', L = '#EFEBF9'
const W = '#FFFFFF', INK = '#211E33', SAF = '#F28C28'

const LINES = 7
const WRITE = 1.55, RET = 0.3, THINK_AFTER = 2, THINK = 1.5, DONE = 2.4
const CYCLE = LINES * (WRITE + RET) + THINK + DONE

// paper geometry (front svg, viewBox 0 0 400 300)
const PX0 = 152, PX1 = 262, PY0 = 190, GAP = 12.5
const lineY = (i) => PY0 + i * GAP
const lineEnd = (i) => (i === LINES - 1 ? PX0 + (PX1 - PX0) * 0.55 : PX1 - (i % 3) * 14)

// a cursive-looking squiggle along one line
function scrawl(i) {
  const y = lineY(i), x1 = lineEnd(i)
  let d = `M${PX0} ${y}`
  let x = PX0
  let k = 0
  while (x < x1) {
    const w = 7 + ((i * 7 + k * 5) % 6)
    const h = 3 + ((i + k) % 3)
    const up = k % 2 === 0 ? -h : h * 0.6
    d += ` q${w / 2} ${up} ${w} 0`
    x += w
    k++
    if (k % 5 === 4) { d += ` m6 0`; x += 6 }   // a gap between words
  }
  return d
}
const PATHS = Array.from({ length: LINES }, (_, i) => scrawl(i))

function timeline(t) {
  let u = t % CYCLE
  const prog = new Array(LINES).fill(0)
  const rest = { x: PX1 + 30, y: PY0 - 10 }
  for (let i = 0; i < LINES; i++) {
    if (i === THINK_AFTER) {
      if (u < THINK) {
        const k = u / THINK
        const x = lineEnd(i - 1)
        // lift, tap-tap, think
        return { prog, pen: { x: x - 10, y: lineY(i) - 10 - Math.abs(Math.sin(k * Math.PI * 4)) * 8 }, mood: { type: 'confused' }, slide: 0, tick: 0 }
      }
      u -= THINK
    }
    if (u < WRITE) {
      const k = u / WRITE
      prog[i] = k
      const x = PX0 + (lineEnd(i) - PX0) * k
      return {
        prog, pen: { x, y: lineY(i) + Math.sin(k * 60) * 1.8 },
        mood: { type: 'typing', caret: Math.min(1, Math.max(0, (x - PX0) / (PX1 - PX0))), count: 4 + i * 3 },
        slide: 0, tick: 0,
      }
    }
    prog[i] = 1
    u -= WRITE
    if (u < RET) {
      const k = u / RET
      const from = { x: lineEnd(i), y: lineY(i) }, to = { x: PX0, y: lineY(Math.min(LINES - 1, i + 1)) }
      return { prog, pen: { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k - Math.sin(k * Math.PI) * 8 }, mood: { type: 'typing', caret: 1 - k, count: 5 + i * 3 }, slide: 0, tick: 0 }
    }
    u -= RET
    prog[i] = 1
  }
  const k = u / DONE
  prog.fill(1)
  return {
    prog, pen: rest, mood: { type: k < 0.75 ? 'right' : 'matched' },
    tick: Math.min(1, k / 0.18),
    slide: k < 0.55 ? 0 : (k - 0.55) / 0.45,       // the finished page slides away
  }
}

function easeOutBack(x) { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2) }

export default function WritingScene({ className = '', style }) {
  const frozen = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('writing_t') : null
  const [t, setT] = useState(frozen != null ? Number(frozen) : 1.2)
  useEffect(() => {
    if (frozen != null) return undefined
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined
    let raf = 0, last = performance.now(), acc = 1.2, lastPaint = 0
    const loop = (now) => {
      raf = requestAnimationFrame(loop)
      acc += Math.min(0.1, Math.max(0, (now - last) / 1000)); last = now
      if (now - lastPaint > 33) { lastPaint = now; setT(acc) }
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [frozen])

  const f = timeline(t)
  const sx = f.slide * 260, so = 1 - f.slide
  const tk = easeOutBack(Math.max(0, Math.min(1, f.tick)))
  const sec = Math.floor(t) % 60

  return (
    <div aria-hidden="true" className={`pointer-events-none select-none ${className}`} style={style}>
      <div className="relative h-full w-full">
        {/* behind him: the wall clock */}
        <svg viewBox="0 0 400 300" className="absolute inset-0 h-full w-full">
          <circle cx="330" cy="46" r="26" fill={W} stroke={VD} strokeWidth="4" />
          {Array.from({ length: 12 }).map((_, i) => {
            const a = (i / 12) * Math.PI * 2
            return <line key={i} x1={330 + Math.sin(a) * 19} y1={46 - Math.cos(a) * 19} x2={330 + Math.sin(a) * 22} y2={46 - Math.cos(a) * 22} stroke={VS} strokeWidth="2" />
          })}
          <line x1="330" y1="46" x2="330" y2="31" stroke={INK} strokeWidth="3" strokeLinecap="round" />
          <line x1="330" y1="46" x2="341" y2="50" stroke={INK} strokeWidth="3" strokeLinecap="round" />
          <line x1="330" y1="46" x2={330 + Math.sin((sec / 60) * Math.PI * 2) * 20} y2={46 - Math.cos((sec / 60) * Math.PI * 2) * 20} stroke={SAF} strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="330" cy="46" r="2.6" fill={SAF} />
        </svg>

        {/* him, seated behind the desk */}
        <div className="absolute" style={{ left: '29%', top: '1%', width: '42%', aspectRatio: '1 / 1' }}>
          <Verifier mood={f.mood} className="h-full w-full" />
        </div>

        {/* in front of him: the desk, the paper, the pencil */}
        <svg viewBox="0 0 400 300" className="absolute inset-0 h-full w-full">
          <rect x="20" y="152" width="360" height="16" rx="6" fill={VD} />
          <rect x="30" y="164" width="340" height="130" rx="8" fill={VS} />
          
          
          {/* a pencil pot and the admit card on the desk */}
          <rect x="316" y="176" width="34" height="40" rx="6" fill={V} />
          <rect x="322" y="160" width="5" height="22" rx="2" fill={SAF} transform="rotate(-8 324 171)" />
          <rect x="332" y="156" width="5" height="26" rx="2" fill="#138808" transform="rotate(6 334 169)" />
          <rect x="52" y="200" width="54" height="36" rx="4" fill={W} transform="rotate(-6 79 218)" />
          <rect x="52" y="200" width="54" height="6" rx="3" fill={SAF} transform="rotate(-6 79 218)" />
          <circle cx="68" cy="222" r="7" fill={T} transform="rotate(-6 79 218)" />
          {/* the paper (slides away when finished) */}
          <g transform={`translate(${sx} 0)`} opacity={so}>
            <rect x={PX0 - 14} y={PY0 - 20} width={PX1 - PX0 + 28} height={LINES * GAP + 30} rx="5" fill={W} stroke={T} strokeWidth="2" />
            <rect x={PX0 - 14} y={PY0 - 20} width={PX1 - PX0 + 28} height="8" rx="4" fill={V} />
            {PATHS.map((d, i) => (
              <g key={i}>
                <line x1={PX0} y1={lineY(i) + 4} x2={PX1} y2={lineY(i) + 4} stroke={L} strokeWidth="1.2" />
                {f.prog[i] > 0 && (
                  <path d={d} pathLength="1" fill="none" stroke={INK} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
                        strokeDasharray="1 1" strokeDashoffset={1 - f.prog[i]} />
                )}
              </g>
            ))}
            {tk > 0.01 && (
              <g transform={`translate(${PX1 - 6} ${PY0 + LINES * GAP - 6}) rotate(-12) scale(${tk})`}>
                <circle r="16" fill="none" stroke={V} strokeWidth="3" />
                <path d="M-7 0l5 5 9-10" fill="none" stroke={V} strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
              </g>
            )}
          </g>
          {/* the pencil: tip at (x, y) */}
          <g transform={`translate(${f.pen.x} ${f.pen.y}) rotate(38)`}>
            <path d="M-4.5 -13h9l-4.5 13z" fill="#F3E3C8" />
            <path d="M-1.5 -4h3L0 0z" fill={INK} />
            <rect x="-4.5" y="-72" width="9" height="59" rx="2" fill={SAF} />
            <rect x="-4.5" y="-72" width="3" height="59" fill="#F7B37A" />
            <rect x="-4.5" y="-79" width="9" height="8" rx="2" fill="#F2A7B5" />
            <rect x="-4.5" y="-72" width="9" height="4" fill={VD} />
            {/* his hand on the pencil */}
            <ellipse cx="0" cy="-30" rx="8.5" ry="10" fill="#F3EAD9" stroke="#E2D4BE" strokeWidth="1" />
          </g>
        </svg>
      </div>
    </div>
  )
}
