import { useEffect, useState } from 'react'
import Verifier from '../login/Verifier.jsx'

// CatalogScene — the exam catalog's living background: the answer sheet
// from the page's illustration, drawn large, being filled in.
//
// A saffron pencil moves bubble to bubble and shades one answer per
// question. At question 3 it hesitates between two options (he looks
// confused), then commits. When the last row is done the sheet is
// stamped with a tick and the companion celebrates; the answers fade and
// it starts again. The companion stands beside the sheet and reacts to
// each beat. Flat FlatViolet, no gradients. Still frame for reduced motion.

const V = '#5B3FA6', VD = '#43307D', VS = '#9A86D6', T = '#DDD5F2', L = '#EFEBF9'
const W = '#FFFFFF', INK = '#211E33', SAF = '#F28C28'

const ROWS = 6, COLS = 4
const ANSWERS = [1, 3, 0, 2, 1, 3]
const HESITATE_ROW = 2              // the tricky question
const PER = 1.15                    // seconds per answer: move + shade
const MOVE = 0.5
const PAUSE = 1.4                   // the hesitation
const DONE = 2.8                    // stamp + celebrate
const RESET = 0.9
const CYCLE = ROWS * PER + PAUSE + DONE + RESET

const bx = (c) => 132 + c * 42
const by = (r) => 116 + r * 42

function timeline(t) {
  // → { row, phase, fill[], pencil:{x,y}, mood, stamp, fade }
  let u = t % CYCLE
  const fill = new Array(ROWS).fill(0)
  let pencil = { x: bx(ANSWERS[0]), y: by(0) }
  let mood = 'point'
  let stamp = 0, fade = 1
  const rest = { x: 300, y: 70 }
  for (let r = 0; r < ROWS; r++) {
    const from = r === 0 ? rest : { x: bx(ANSWERS[r - 1]), y: by(r - 1) }
    const to = { x: bx(ANSWERS[r]), y: by(r) }
    let span = PER + (r === HESITATE_ROW ? PAUSE : 0)
    if (u < span) {
      if (r === HESITATE_ROW && u < PAUSE) {
        // hover between the wrong option and the right one
        const k = u / PAUSE
        const wrong = { x: bx((ANSWERS[r] + 2) % COLS), y: by(r) }
        const sway = 0.5 - 0.5 * Math.cos(k * Math.PI * 3)
        pencil = { x: wrong.x + (to.x - wrong.x) * sway, y: to.y - 6 - 4 * Math.sin(k * Math.PI * 6) }
        mood = 'confused'
        return { fill, pencil, mood, stamp, fade }
      }
      const v = r === HESITATE_ROW ? u - PAUSE : u
      if (v < MOVE) {
        const k = 0.5 - 0.5 * Math.cos((v / MOVE) * Math.PI)
        pencil = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k - Math.sin(k * Math.PI) * 14 }
      } else {
        const k = (v - MOVE) / (PER - MOVE)
        fill[r] = Math.min(1, k * 1.25)
        // the tip scribbles round inside the bubble
        pencil = { x: to.x + Math.cos(k * 18) * 3.5 * (1 - k), y: to.y + Math.sin(k * 18) * 3.5 * (1 - k) }
      }
      mood = r === ROWS - 1 ? 'thumbsUp' : 'point'
      return { fill, pencil, mood, stamp, fade }
    }
    fill[r] = 1
    u -= span
  }
  pencil = { x: bx(ANSWERS[ROWS - 1]), y: by(ROWS - 1) }
  if (u < DONE) {
    const k = u / DONE
    stamp = Math.min(1, k / 0.25)
    pencil = { x: pencil.x + (rest.x - pencil.x) * Math.min(1, k * 2), y: pencil.y + (rest.y - pencil.y) * Math.min(1, k * 2) }
    return { fill, pencil, mood: 'right', stamp, fade }
  }
  u -= DONE
  const k = u / RESET
  return { fill, pencil: rest, mood: 'matched', stamp: 1 - k, fade: 1 - k }
}

function easeOutBack(x) { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2) }

export default function CatalogScene({ className = '', style }) {
  // Review aid: ?catalog_t=<seconds> freezes the scene at that moment.
  const frozen = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('catalog_t') : null
  const [t, setT] = useState(frozen != null ? Number(frozen) : 4.2)
  useEffect(() => {
    if (frozen != null) return undefined
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined
    let raf = 0, last = performance.now(), acc = 4.2, lastPaint = 0
    const loop = (now) => {
      raf = requestAnimationFrame(loop)
      acc += Math.min(0.1, (now - last) / 1000); last = now
      if (now - lastPaint > 33) { lastPaint = now; setT(acc) }
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [frozen])
  const f = timeline(t)
  const s = easeOutBack(Math.max(0, Math.min(1, f.stamp)))

  return (
    <div aria-hidden="true" className={`pointer-events-none select-none ${className}`} style={style}>
      <div className="relative h-full w-full">
        <svg viewBox="0 0 360 440" className="absolute inset-0 h-full w-full">
          {/* the sheet */}
          <rect x="60" y="24" width="250" height="396" rx="14" fill={W} stroke={T} strokeWidth="3" />
          <rect x="60" y="24" width="250" height="64" rx="14" fill={V} />
          <rect x="60" y="70" width="250" height="18" fill={V} />
          <rect x="82" y="44" width="92" height="14" rx="7" fill={VS} />
          <rect x="82" y="64" width="54" height="8" rx="4" fill={T} opacity=".8" />
          {Array.from({ length: ROWS }).map((_, r) => (
            <g key={r}>
              <rect x="80" y={by(r) - 5} width="22" height="10" rx="5" fill={T} />
              {Array.from({ length: COLS }).map((__, c) => {
                const chosen = ANSWERS[r] === c
                const k = chosen ? f.fill[r] * f.fade : 0
                return (
                  <g key={c}>
                    <circle cx={bx(c)} cy={by(r)} r="13" fill={W} stroke={VS} strokeWidth="2.6" />
                    {k > 0 && <circle cx={bx(c)} cy={by(r)} r={13 * Math.min(1, k)} fill={V} opacity={0.35 + 0.65 * k} />}
                  </g>
                )
              })}
            </g>
          ))}
          {/* the stamp */}
          {s > 0.01 && (
            <g transform={`translate(250 384) rotate(-14) scale(${s})`} opacity={Math.min(1, f.stamp * 1.4)}>
              <circle r="29" fill="none" stroke={V} strokeWidth="4.5" />
              <circle r="21" fill="none" stroke={V} strokeWidth="2" strokeDasharray="4 4" />
              <path d="M-12 1l8 8 16-17" stroke={V} strokeWidth="6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </g>
          )}
          {/* the pencil: tip at (x, y) */}
          <g transform={`translate(${f.pencil.x} ${f.pencil.y}) rotate(35)`}>
            <path d="M-8 -22h16l-8 22z" fill="#F3E3C8" />
            <path d="M-2.6 -7h5.2L0 0z" fill={INK} />
            <rect x="-8" y="-118" width="16" height="96" rx="3" fill={SAF} />
            <rect x="-8" y="-118" width="5" height="96" fill="#F7B37A" />
            <rect x="-8" y="-128" width="16" height="12" rx="3" fill="#F2A7B5" />
            <rect x="-8" y="-118" width="16" height="6" fill={VD} />
          </g>
        </svg>
        {/* the companion, beside the sheet */}
        <div className="absolute -left-[26%] bottom-0 h-[46%] aspect-square">
          <Verifier mood={{ type: f.mood }} className="h-full w-full" />
        </div>
      </div>
    </div>
  )
}
