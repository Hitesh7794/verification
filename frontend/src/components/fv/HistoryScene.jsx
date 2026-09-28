import { useEffect, useState } from 'react'
import Verifier from '../login/Verifier.jsx'

// HistoryScene — the verification history's living background: the archive.
//
// Verification reports ride a timeline from right to left. Each carries the
// candidate's photo and fingerprint. The companion, in his detective hat,
// holds a magnifying glass over the rail; as each report passes under the
// lens it gets its seal (violet tick verified, amber cross denied — he looks
// puzzled at those). At the left end the reports drop into a filing
// cabinet whose drawer bumps open to take them. A desk calendar flips its
// page every few reports. Flat FlatViolet. ?history_t=<s> freezes it.

const V = '#5B3FA6', VD = '#43307D', VS = '#9A86D6', T = '#DDD5F2', L = '#EFEBF9'
const W = '#FFFFFF', INK = '#211E33', SAF = '#F28C28', MARK = '#A8711F'

const SLOT = 96, P = 2.2, MOVE = 0.8
const LENS_X = 330, RAIL_Y = 206, DRAWER_X = 112
const SKINS = ['#F1D2B6', '#C68B59', '#E8C39E', '#A66E48', '#D9A47C', '#F5DCC4']
const SHIRTS = [V, SAF, '#138808', VS, VD, '#3671B5']
const hash = (n) => { const x = Math.sin(n * 91.7 + 17.3) * 43758.5453; return x - Math.floor(x) }
const fails = (j) => hash(j) < 0.22
const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2)
const easeOutBack = (x) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2) }

function Report({ j, x, y, o, seal }) {
  const skin = SKINS[Math.abs(j) % SKINS.length], shirt = SHIRTS[Math.abs(j * 5) % SHIRTS.length]
  const bad = fails(j)
  return (
    <g transform={`translate(${x - 30} ${y - 76})`} opacity={o}>
      <rect width="60" height="76" rx="6" fill={W} stroke={T} strokeWidth="2" />
      <rect width="60" height="11" rx="5" fill={V} />
      <rect y="6" width="60" height="5" fill={V} />
      {/* photo */}
      <rect x="7" y="17" width="20" height="24" rx="3" fill={L} />
      <path d="M9 41c0-6 3.6-9 8-9s8 3 8 9z" fill={shirt} />
      <circle cx="17" cy="26" r="5" fill={skin} />
      <path d="M12 25.4a5 5 0 0 1 10 0c-1.6-1.6-3-2-5-2s-3.4.4-5 2z" fill={INK} />
      {/* lines */}
      <rect x="31" y="19" width="22" height="3.4" rx="1.7" fill={T} />
      <rect x="31" y="26" width="16" height="3" rx="1.5" fill={L} />
      <rect x="31" y="32" width="19" height="3" rx="1.5" fill={L} />
      {/* fingerprint */}
      <g fill="none" stroke={VS} strokeWidth="1.5" strokeLinecap="round">
        <path d="M11 60a6 7 0 1 1 12 0" /><path d="M8 63a9 10 0 1 1 18 -1" /><path d="M14 60a3 3.6 0 1 1 6 0" />
      </g>
      <rect x="31" y="52" width="20" height="3" rx="1.5" fill={L} />
      <rect x="31" y="58" width="14" height="3" rx="1.5" fill={L} />
      {/* seal */}
      {seal > 0.01 && (
        <g transform={`translate(46 64) rotate(-12) scale(${seal})`}>
          <circle r="11" fill={bad ? MARK : V} />
          {bad
            ? <path d="M-4 -4l8 8M4 -4l-8 8" stroke={W} strokeWidth="2.6" strokeLinecap="round" />
            : <path d="M-4.6 .2l3 3 6-6.6" fill="none" stroke={W} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />}
        </g>
      )}
    </g>
  )
}

export default function HistoryScene({ className = '', style }) {
  const frozen = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('history_t') : null
  const [t, setT] = useState(frozen != null ? Number(frozen) : 1.4)
  useEffect(() => {
    if (frozen != null) return undefined
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined
    let raf = 0, last = performance.now(), acc = 1.4, lastPaint = 0
    const loop = (now) => {
      raf = requestAnimationFrame(loop)
      acc += Math.min(0.1, Math.max(0, (now - last) / 1000)); last = now
      if (now - lastPaint > 33) { lastPaint = now; setT(acc) }
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [frozen])

  const k = Math.floor(t / P), f = t % P
  const prog = k + ease(Math.min(1, f / MOVE))
  const c = Math.max(0, (f - MOVE) / (P - MOVE))          // 0 → 1 while holding
  const atLens = k + 1                                     // the report under the glass during the hold
  const lensBad = f >= MOVE && fails(atLens)
  // drawer bumps open as a report arrives at the left end
  const bump = f < MOVE ? Math.sin((f / MOVE) * Math.PI) : 0
  const page = Math.floor(k / 4)
  const flip = (k % 4 === 3) ? Math.min(1, c * 1.6) : 0

  const cards = []
  for (let j = Math.floor(prog) - 4; j <= Math.floor(prog) + 3; j++) {
    const x = LENS_X + (j - prog) * SLOT
    if (x > 520 || x < DRAWER_X - 90) continue
    let y = RAIL_Y, o = 1
    if (x < DRAWER_X + 20) {                       // dropping into the drawer
      const d = (DRAWER_X + 20 - x) / 90
      y = RAIL_Y + d * 70; o = 1 - d * 0.5
    }
    const passed = j < atLens || (j === atLens && f >= MOVE && c > 0.25)
    const seal = j === atLens && f >= MOVE ? easeOutBack(Math.min(1, Math.max(0, (c - 0.25) / 0.2))) : passed ? 1 : 0
    cards.push(<Report key={j} j={j} x={x} y={y} o={o} seal={seal} />)
  }
  const lensBob = Math.sin(t * 2.4) * 3

  return (
    <div aria-hidden="true" className={`pointer-events-none select-none ${className}`} style={style}>
      <div className="relative h-full w-full">
        {/* behind: the calendar on the wall */}
        <svg viewBox="0 0 480 300" className="absolute inset-0 h-full w-full">
          <g transform="translate(404 18)">
            <rect width="62" height="60" rx="7" fill={W} stroke={T} strokeWidth="2" />
            <rect width="62" height="16" rx="6" fill={V} />
            <rect y="10" width="62" height="6" fill={V} />
            <rect x="14" y="-5" width="5" height="12" rx="2.5" fill={VD} /><rect x="43" y="-5" width="5" height="12" rx="2.5" fill={VD} />
            <text x="31" y="48" textAnchor="middle" fontSize="24" fontWeight="800" fill={INK} fontFamily="Bricolage Grotesque, sans-serif">{((page % 28) + 1)}</text>
            {flip > 0 && (
              <g style={{ transformOrigin: '31px 16px' }} transform={`translate(0 16) scale(1 ${1 - flip}) translate(0 -16)`}>
                <rect y="16" width="62" height="44" rx="4" fill={L} />
              </g>
            )}
          </g>
        </svg>

        {/* him, the detective, behind the rail */}
        <div className="absolute" style={{ left: '38%', top: '-2%', width: '31%', aspectRatio: '1 / 1' }}>
          <Verifier mood={{ type: lensBad ? 'confused' : 'detective' }} className="h-full w-full" />
        </div>

        <svg viewBox="0 0 480 300" className="absolute inset-0 h-full w-full">
          {/* the timeline rail */}
          <rect x="20" y={RAIL_Y + 4} width="460" height="8" rx="4" fill={VS} />
          {Array.from({ length: 10 }).map((_, i) => (
            <circle key={i} cx={130 + i * 40 - ((prog * SLOT) % 40)} cy={RAIL_Y + 8} r="2.2" fill={W} />
          ))}
          {/* the cabinet, behind the falling reports */}
          <rect x="20" y="150" width="104" height="146" rx="8" fill={VD} />
          {cards}
          {/* drawer front over the reports (they drop in behind it) */}
          <g transform={`translate(${-bump * 10} 0)`}>
            <rect x="14" y="228" width="116" height="34" rx="6" fill={V} />
            <rect x="56" y="240" width="32" height="8" rx="4" fill={T} />
          </g>
          <rect x="20" y="266" width="104" height="30" rx="5" fill={VD} />
          <rect x="56" y="276" width="32" height="7" rx="3.5" fill={VS} />
          {/* the magnifying glass over the report being checked */}
          <g transform={`translate(${LENS_X} ${RAIL_Y - 44 + lensBob})`}>
            <line x1="26" y1="-24" x2="46" y2="-46" stroke={MARK} strokeWidth="7" strokeLinecap="round" />
            <circle r="34" fill={L} fillOpacity=".35" stroke={VD} strokeWidth="6" />
            <path d="M-18 -18a24 24 0 0 1 14 -8" stroke={W} strokeWidth="4" strokeLinecap="round" fill="none" />
          </g>
        </svg>
      </div>
    </div>
  )
}
