import { useEffect, useRef, useState } from 'react'
import Verifier from '../login/Verifier.jsx'

// AgentDeskScene — the verification desk, alive, with no words on it.
//
// The room is an ordinary Indian office: whitewash above, an oil-painted
// dado below, a barred window onto the day, a steel almirah with tied
// ledgers on top, a tube light, a wall calendar, a switchboard on its
// conduit, and a ceiling fan that wobbles the way they all do. He sits at a
// wooden desk under a sheet of glass in his white shirt and tie, with
// nothing on it but the screen and the tricolour.
//
// Everything answers what the agent is doing: the monitor carries the roll
// number into five slots as it is typed, with a blinking caret; a ring spins
// while the lookup runs; a tick lands when the number looks complete; on a
// bad number the monitor jolts and shows a cross. He is never still — he
// waves when the desk wakes up, points up at the screen while it thinks,
// throws both thumbs when the number is good, and scratches his head at a
// bad one.
//
// state: 'idle' | 'typing' | 'ready' | 'searching' | 'error'

// the portal's own hues, for the screen and what he wears
const V = '#5B3FA6', T = '#DDD5F2', L = '#EFEBF9'
const W = '#FFFFFF', INK = '#211E33', GRN = '#138808', RED = '#C62828'
// and the room's own, which are the colours such a room actually is
const WALL = '#EDE3D0', WALL_D = '#DED2BA'
const DADO_L = '#5E938B', DADO_D = '#3D6B66'
const WOOD = '#8A5A34', WOOD_D = '#6A4326', WOOD_L = '#A5723F'
const STEEL = '#76867F', STEEL_D = '#59685F', STEEL_L = '#8E9C93'
const STONE = '#D9C4A0', STONE_D = '#BFA57E', LEAF = '#3F7A4C', TRUNK = '#6B4A2F'
const BRASS = '#C9A24A', RUST = '#C2522F'
const SLOTS = 5

// What he does, one beat after another, for each thing the desk can be.
// 'ready' runs to its last beat and holds it; the rest loop.
const BEATS = {
  idle:      [{ type: 'waiting' }, { type: 'wave' }, { type: 'idle' }, { type: 'point' }, { type: 'waiting' },
              { type: 'namaste' }, { type: 'idle' }, { type: 'reaching' }, { type: 'waiting' }, { type: 'pointUp' }],
  searching: [{ type: 'pointUp' }, { type: 'waiting' }, { type: 'point' }, { type: 'waiting' }],
  error:     [{ type: 'confused' }, { type: 'waiting' }, { type: 'confused' }, { type: 'noDevice' }],
  ready:     [{ type: 'right' }, { type: 'matched' }, { type: 'thumbsUp' }],
}
const BEAT_MS = { idle: 2600, searching: 2100, error: 2000, ready: 1400 }

// ── The ceiling fan ───────────────────────────────────────────────────
// Blades on a disc seen almost edge-on: every point of a blade goes through
// the same squash, so they foreshorten as they come round instead of
// pinwheeling flat. And it wobbles, because they all do.
const FAN_R = 74, FAN_SQ = 0.3
const fanPt = (a, r, w) => {
  const c = Math.cos(a), s = Math.sin(a)
  return `${(r * c - w * s).toFixed(1)} ${((r * s + w * c) * FAN_SQ).toFixed(1)}`
}
const blade = (a) =>
  `M${fanPt(a, 12, -4.5)}L${fanPt(a, FAN_R - 7, -9)}L${fanPt(a, FAN_R, -4)}L${fanPt(a, FAN_R, 4)}L${fanPt(a, FAN_R - 7, 9)}L${fanPt(a, 12, 4.5)}Z`

function CeilingFan({ t }) {
  const spin = t * 3.4
  const wob = Math.sin(t * 6.8) * 0.5
  return (
    <g transform={`translate(240 ${(34 + wob).toFixed(2)}) rotate(${(Math.sin(t * 3.4) * 0.7).toFixed(2)})`}>
      <rect x="-3" y="-34" width="6" height="28" fill="#6E6A60" />
      <rect x="-1.2" y="-34" width="1.6" height="28" fill="#9A968C" />
      <path d="M-11 -34h22l-4 -5h-14z" fill="#8A867C" />
      <ellipse cx="0" cy="0" rx={FAN_R} ry={FAN_R * FAN_SQ} fill="#CFC6B4" opacity=".07" />
      {[0, 1, 2].map((i) => {
        const a = spin + (i * Math.PI * 2) / 3
        const front = Math.sin(a) > 0
        return (
          <g key={i}>
            <path d={blade(a - 0.2)} fill="#C6BCA8" opacity=".18" />
            <path d={blade(a - 0.1)} fill="#DCD3C1" opacity=".34" />
            <path d={blade(a)} fill={front ? '#F2EADA' : '#DCD2BE'} />
            {!front && <path d={blade(a)} fill={INK} opacity=".12" />}
          </g>
        )
      })}
      <ellipse cx="0" cy="3" rx="18" ry="7" fill="#C9C0AE" />
      <rect x="-18" y="-5" width="36" height="9" fill="#E4DCCA" />
      <ellipse cx="0" cy="-5" rx="18" ry="7" fill="#F2EADA" />
      <ellipse cx="0" cy="-5" rx="12" ry="4.6" fill="#E0D7C4" />
      <rect x="-18" y="0" width="36" height="1.8" fill="#A79D8A" opacity=".7" />
      <ellipse cx="0" cy="7" rx="6.5" ry="2.8" fill="#8A867C" />
    </g>
  )
}

// ── The national flag on the desk ─────────────────────────────────────
// A cloth that a draught travels along, with the Ashoka chakra riding the
// same wave. 24 spokes, navy, on the white band — it is the flag, so it is
// drawn properly.
const FL = 68, FB = 14, FTOP = -106
function DeskFlag({ t }) {
  const off = (x) => (x / FL) * 6.8 * Math.sin(x * 0.15 - t * 4.6)
  const lift = (x) => (x / FL) * 2.4 * Math.sin(x * 0.15 - t * 4.6 + 1.1)
  const N = 16
  const xs = Array.from({ length: N + 1 }, (_, i) => 3 + (FL - 3) * (i / N))
  const H = FB * 3
  // a line that follows the cloth at a given depth
  const along = (depth) => xs.map((x, i) =>
    `${i ? 'L' : 'M'}${x.toFixed(1)} ${(FTOP + depth + off(x) + (lift(x) * depth) / H).toFixed(1)}`).join('')
  const band = (k) => {
    const y0 = FTOP + k * FB, y1 = y0 + FB
    const top = xs.map((x, i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${(y0 + off(x) + (lift(x) * (k * FB)) / H).toFixed(1)}`).join('')
    const bot = [...xs].reverse().map((x) => `L${x.toFixed(1)} ${(y1 + off(x) + (lift(x) * ((k + 1) * FB)) / H).toFixed(1)}`).join('')
    return top + bot + 'Z'
  }
  const cx = 3 + (FL - 3) * 0.46
  const ang = Math.atan2(off(cx + 5) - off(cx - 5), 10) * 57.2958
  const flyTop = FTOP + off(FL), flyH = H + lift(FL)
  const tassel = Math.sin(t * 2.3) * 3.5

  return (
    <g transform="translate(400 227)">
      {/* what it throws on the glass */}
      <ellipse cx="9" cy="2" rx="34" ry="5.5" fill={INK} opacity=".22" />

      {/* the base: turned wood, a brass ring, a plain brass plate */}
      <ellipse cx="0" cy="0" rx="21" ry="6.5" fill="#3F362E" />
      <ellipse cx="0" cy="-2.5" rx="21" ry="6.5" fill="#5A4B3C" />
      <ellipse cx="0" cy="-3.5" rx="17" ry="5.2" fill="#6E5C49" />
      <ellipse cx="0" cy="-7" rx="12" ry="4" fill="#5A4B3C" />
      <ellipse cx="0" cy="-8.5" rx="12" ry="4" fill="#7A6650" />
      <ellipse cx="-4" cy="-9.5" rx="5" ry="1.6" fill="#94806A" opacity=".8" />
      <rect x="-9" y="-6" width="18" height="2.4" rx="1.2" fill={BRASS} opacity=".9" />
      <ellipse cx="0" cy="-11" rx="5.5" ry="2" fill={BRASS} />

      {/* the staff, with its ferrule and finial */}
      <rect x="-2.1" y={FTOP - 9} width="4.2" height={-(FTOP - 9) - 10} rx="2.1" fill="#4A3B2C" />
      <rect x="-.7" y={FTOP - 7} width="1.3" height={-(FTOP - 7) - 12} fill="#8C7658" opacity=".65" />
      <rect x="-3" y="-22" width="6" height="5" rx="1.5" fill={BRASS} />
      <rect x="-3" y={FTOP - 4} width="6" height="4.5" rx="1.5" fill={BRASS} />
      <circle cx="0" cy={FTOP - 9} r="4.2" fill={BRASS} />
      <path d={`M0 ${FTOP - 20}l2.6 8h-5.2z`} fill={BRASS} />
      <circle cx="-1.2" cy={FTOP - 10.4} r="1.4" fill={W} opacity=".65" />

      {/* the hoist sleeve, then the three bands */}
      <path d={band(0)} fill="#FF9933" />
      <path d={band(1)} fill={W} />
      <path d={band(2)} fill="#138808" />

      {/* the seams between the bands, and the hem along top and bottom */}
      <path d={along(FB)} fill="none" stroke="#D9822B" strokeWidth=".7" opacity=".55" />
      <path d={along(FB * 2)} fill="none" stroke="#0E6606" strokeWidth=".7" opacity=".5" />
      <path d={along(1.4)} fill="none" stroke={W} strokeWidth=".7" opacity=".4" />
      <path d={along(H - 1.4)} fill="none" stroke={INK} strokeWidth=".7" opacity=".18" />
      {/* the creases a cloth takes */}
      <path d={along(FB * 0.5)} fill="none" stroke={INK} strokeWidth=".5" opacity=".08" />
      <path d={along(FB * 2.5)} fill="none" stroke={INK} strokeWidth=".5" opacity=".08" />

      {/* the chakra, riding the same wave */}
      <g transform={`translate(${cx.toFixed(1)} ${(FTOP + FB * 1.5 + off(cx) + (lift(cx) * 1.5) / 3).toFixed(1)}) rotate(${ang.toFixed(1)})`}
         stroke="#0A0A5A" fill="none">
        <circle r="6" strokeWidth="1" />
        <circle r="4.9" strokeWidth=".4" />
        <circle r="1.2" fill="#0A0A5A" stroke="none" />
        {Array.from({ length: 24 }).map((_, i) => {
          const a = (i / 24) * Math.PI * 2
          return <line key={i} x1={(Math.cos(a) * 1.4).toFixed(2)} y1={(Math.sin(a) * 1.4).toFixed(2)}
                       x2={(Math.cos(a) * 5.4).toFixed(2)} y2={(Math.sin(a) * 5.4).toFixed(2)} strokeWidth=".4" />
        })}
        {Array.from({ length: 24 }).map((_, i) => {
          const a = ((i + 0.5) / 24) * Math.PI * 2
          return <circle key={i} cx={(Math.cos(a) * 5.7).toFixed(2)} cy={(Math.sin(a) * 5.7).toFixed(2)} r=".35" fill="#0A0A5A" stroke="none" />
        })}
      </g>

      {/* the light and shade the draught makes across it */}
      {xs.slice(0, -1).map((x, i) => {
        const x2 = xs[i + 1]
        const sl = (off(x2) - off(x)) / (x2 - x)
        const y0 = FTOP + off(x), y0b = FTOP + off(x2)
        return (
          <path key={i} d={`M${x.toFixed(1)} ${y0.toFixed(1)}L${x2.toFixed(1)} ${y0b.toFixed(1)}L${x2.toFixed(1)} ${(y0b + H + lift(x2)).toFixed(1)}L${x.toFixed(1)} ${(y0 + H + lift(x)).toFixed(1)}Z`}
                fill={sl > 0 ? INK : W} opacity={Math.min(0.24, Math.abs(sl) * 0.45)} />
        )
      })}

      {/* the golden fringe along the fly edge */}
      {Array.from({ length: 13 }).map((_, i) => {
        const y = flyTop + (flyH * i) / 12
        const k = Math.sin(t * 4.2 + i * 0.5) * 1.4
        return <path key={i} d={`M${FL} ${y.toFixed(1)}q2 1 ${3.6 + k * 0.2} ${2.4 + k}`}
                     fill="none" stroke={i % 2 ? '#D9A93F' : '#C9962F'} strokeWidth="1.1" strokeLinecap="round" />
      })}

      {/* the cord and tassel, hung off the finial on the free side */}
      <path d={`M-1.6 ${FTOP - 7}q-9 8 ${-4 + tassel * 0.5} 19`} fill="none" stroke="#C9962F" strokeWidth="1.4" strokeLinecap="round" />
      <path d={`M-1.6 ${FTOP - 7}q-7 9 ${-3 + tassel * 0.5} 19`} fill="none" stroke="#E0BB5C" strokeWidth=".7" strokeLinecap="round" />
      <g transform={`translate(${(-5.6 + tassel * 0.5).toFixed(1)} ${FTOP + 12}) rotate(${(tassel * 1.6).toFixed(1)})`}>
        <circle r="2.4" fill="#D9A93F" />
        <circle cx="-.8" cy="-.8" r=".8" fill={W} opacity=".5" />
        <path d="M-2.4 1.8h4.8l-1.1 7.6h-2.6z" fill="#C9962F" />
        <path d="M-2.2 9h4.4l-.7 3.6h-3z" fill="#E0BB5C" />
      </g>

      {/* the hoist: the sleeve the staff runs through */}
      <path d={`M3 ${FTOP}L3 ${FTOP + H}`} stroke={INK} strokeWidth="2.2" opacity=".22" />
      <path d={`M5.6 ${FTOP + 1}L5.6 ${FTOP + H - 1}`} stroke={W} strokeWidth="1" opacity=".35" />
    </g>
  )
}

// Someone out in the queue, seen through the bars.
const KURTA = ['#C2522F', '#3F5EA8', '#2F6B4F', '#7A3F8C', '#C9962F', '#2B5E7A']
function Walker({ x, y, s, i, ph }) {
  const sw = Math.sin(ph) * 3.4
  const bob = Math.abs(Math.cos(ph)) * 1.1
  const c = KURTA[i % KURTA.length]
  return (
    <g transform={`translate(${x.toFixed(1)} ${(y - bob).toFixed(1)}) scale(${s})`}>
      <circle cx="0" cy="-15" r="4.2" fill="#8A5F3C" />
      <path d="M-4.4 -17.6a4.6 4.2 0 0 1 8.8 0z" fill="#2A2320" />
      <path d="M-4.6 -10h9.2l2 11h-13.2z" fill={c} />
      <path d={`M-1.3 1l${(-sw * 0.5).toFixed(1)} 8h-2.6l${(sw * 0.2).toFixed(1)} -8z`} fill="#3A3A45" />
      <path d={`M1.3 1l${(sw * 0.5).toFixed(1)} 8h2.6l${(-sw * 0.2).toFixed(1)} -8z`} fill="#3A3A45" />
      <path d={`M-4.8 -8l${(-sw * 0.4).toFixed(1)} 7`} stroke={c} strokeWidth="1.8" fill="none" strokeLinecap="round" />
      <path d={`M4.8 -8l${(sw * 0.4).toFixed(1)} 7`} stroke={c} strokeWidth="1.8" fill="none" strokeLinecap="round" />
    </g>
  )
}

export default function AgentDeskScene({ state = 'idle', roll = '', className = '' }) {
  const [t, setT] = useState(0)
  const reduced = useRef(false)
  useEffect(() => {
    reduced.current = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduced.current) return undefined
    let raf = 0, last = performance.now(), acc = 0, paint = 0
    const loop = (now) => {
      raf = requestAnimationFrame(loop)
      acc += Math.min(0.1, Math.max(0, (now - last) / 1000)); last = now
      if (now - paint > 24) { paint = now; setT(acc) }
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  // He never holds one pose: each state walks its own beats, and a state
  // change starts them again from the top.
  const [beat, setBeat] = useState(0)
  useEffect(() => { setBeat(0) }, [state])
  useEffect(() => {
    if (state === 'typing') return undefined
    const id = setInterval(() => setBeat((b) => b + 1), BEAT_MS[state] || 3000)
    return () => clearInterval(id)
  }, [state])

  const list = BEATS[state] || BEATS.idle
  const mood = state === 'typing'
    ? { type: 'typing', caret: Math.min(1, roll.length / SLOTS), count: roll.length }
    : state === 'ready' ? list[Math.min(beat, list.length - 1)] : list[beat % list.length]

  const digits = roll.replace(/\s/g, '').slice(-SLOTS).split('')
  const pop = useRef({ n: -1, at: -9 })
  if (pop.current.n !== digits.length) pop.current = { n: digits.length, at: t }
  const popAge = t - pop.current.at
  const caretOn = (t % 1) < 0.55 && (state === 'typing' || state === 'idle')
  const busy = state === 'searching'
  const sec = (t % 60) / 60
  const shake = state === 'error' ? Math.sin(t * 34) * 2.4 : 0
  const swivel = Math.sin(t * 0.42) * 1.1 + Math.sin(t * 0.17) * 0.5
  const draught = Math.sin(t * 3.4)

  return (
    <div aria-hidden="true"
         className={`relative mx-auto overflow-hidden rounded-[16px] border border-fv-line ${className}`}
         style={{ aspectRatio: '5 / 3' }}>
      <div className="absolute inset-0">

        {/* ── the room ───────────────────────────────────────────────── */}
        <svg viewBox="0 0 480 288" className="absolute inset-0 h-full w-full">
          <defs>
            <linearGradient id="fvup" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#F6EFE0" /><stop offset=".55" stopColor={WALL} /><stop offset="1" stopColor={WALL_D} />
            </linearGradient>
            <linearGradient id="fvdado" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={DADO_L} /><stop offset="1" stopColor={DADO_D} />
            </linearGradient>
            <linearGradient id="fvsky" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#A8CDEA" /><stop offset=".72" stopColor="#CFE4F3" /><stop offset="1" stopColor="#E9F0E3" />
            </linearGradient>
            <linearGradient id="fvsteel" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor={STEEL_L} /><stop offset=".45" stopColor={STEEL} /><stop offset="1" stopColor={STEEL_D} />
            </linearGradient>
            <radialGradient id="fvsun" cx="50%" cy="50%" r="50%">
              <stop offset="0" stopColor="#FFE7BF" stopOpacity=".85" /><stop offset="1" stopColor="#FFE7BF" stopOpacity="0" />
            </radialGradient>
            <pattern id="fvgrain" width="7" height="7" patternUnits="userSpaceOnUse">
              <circle cx="1.5" cy="1.5" r=".55" fill="#6B5B45" opacity=".05" />
              <circle cx="5" cy="4.5" r=".5" fill={W} opacity=".07" />
            </pattern>
            <clipPath id="fvwin"><rect x="28" y="46" width="118" height="92" /></clipPath>
            <filter id="fvsh" x="-25%" y="-25%" width="160%" height="170%">
              <feDropShadow dx="1.5" dy="3" stdDeviation="2.4" floodColor="#2A2015" floodOpacity=".3" />
            </filter>
          </defs>

          {/* ceiling, whitewash, and the oil-painted dado under it */}
          <rect x="0" y="0" width="480" height="26" fill="#F8F3E8" />
          <rect x="0" y="23" width="480" height="4" fill="#CFC3AB" />
          <rect x="0" y="26" width="480" height="126" fill="url(#fvup)" />
          <rect x="0" y="152" width="480" height="78" fill="url(#fvdado)" />
          <rect x="0" y="148.5" width="480" height="4" fill="#2F544F" />
          <rect x="0" y="152.5" width="480" height="1.6" fill={DADO_L} opacity=".55" />
          <rect x="0" y="26" width="480" height="196" fill="url(#fvgrain)" />

          {/* the day, coming in from the window */}
          <path d="M30 140 L150 140 L232 230 L4 230z" fill="url(#fvsun)" opacity=".5" />
          {Array.from({ length: 9 }).map((_, i) => {
            const k = (t * 0.06 + i / 9) % 1
            const x = 44 + i * 17 + Math.sin(t * 0.8 + i) * 9
            return <circle key={i} cx={x.toFixed(1)} cy={(138 + k * 78).toFixed(1)} r={1 + (i % 3) * 0.5}
                           fill="#FFE1B0" opacity={(0.5 * Math.sin(k * Math.PI)).toFixed(2)} />
          })}

          {/* the tube light */}
          <g>
            <rect x="320" y="30" width="142" height="7" rx="2" fill="#D8D2C4" />
            <rect x="324" y="32" width="134" height="3.4" rx="1.7" fill={W} />
            <rect x="320" y="37" width="142" height="3" fill="#B7B0A0" />
            <ellipse cx="391" cy="45" rx="80" ry="13" fill={W} opacity=".2" />
          </g>

          {/* the barred window, and the queue out in the sun */}
          <g filter="url(#fvsh)">
            <rect x="18" y="38" width="138" height="110" rx="3" fill="#3E6B66" />
            <rect x="24" y="44" width="126" height="98" rx="2" fill="#2F544F" />
            <rect x="28" y="46" width="118" height="92" fill="url(#fvsky)" />
            <g clipPath="url(#fvwin)">
              <circle cx="120" cy="58" r="12" fill="#FFF2D2" opacity=".9" />
              {[0, 1].map((i) => {
                const x = 150 - ((t * 4 + i * 80) % 200)
                return (
                  <g key={i} transform={`translate(${x.toFixed(1)} ${56 + i * 14})`} fill={W} opacity={i ? '.65' : '.85'}>
                    <ellipse cx="0" cy="0" rx="13" ry="5" /><ellipse cx="9" cy="-3" rx="8" ry="5" /><ellipse cx="-9" cy="-1" rx="7" ry="4" />
                  </g>
                )
              })}
              <g transform={`translate(${(((t * 13) % 200) - 24).toFixed(1)} ${(66 + Math.sin(t * 1.4) * 5).toFixed(1)})`} opacity=".5">
                <path d={`M-5 0q2.5 ${(-2 - Math.abs(Math.sin(t * 7)) * 3).toFixed(1)} 5 0q2.5 ${(-2 - Math.abs(Math.sin(t * 7)) * 3).toFixed(1)} 5 0`}
                      fill="none" stroke="#4A4038" strokeWidth="1.2" strokeLinecap="round" />
              </g>
              {/* the exam block across the yard */}
              <rect x="30" y="80" width="54" height="34" fill={STONE} />
              <rect x="30" y="76" width="54" height="5" fill={STONE_D} />
              <path d="M52 62l15 14H37z" fill={RUST} />
              <rect x="54" y="66" width="7" height="10" fill={STONE_D} />
              {[0, 1, 2, 3].map((i) => <rect key={`a${i}`} x={35 + i * 13} y="86" width="8" height="10" fill="#6E7F8C" />)}
              {[0, 1, 2, 3].map((i) => <rect key={`b${i}`} x={35 + i * 13} y="101" width="8" height="10" fill="#6E7F8C" />)}
              {/* trees */}
              <rect x="100" y="94" width="4" height="22" fill={TRUNK} />
              <circle cx="102" cy="88" r="13" fill={LEAF} />
              <circle cx="94" cy="93" r="9" fill="#356B42" />
              <circle cx="110" cy="93" r="9" fill="#4A8A57" />
              <rect x="130" y="100" width="3" height="16" fill={TRUNK} />
              <circle cx="131" cy="96" r="9" fill="#4A8A57" />
              <rect x="28" y="114" width="118" height="24" fill="#C9B894" />
              <rect x="28" y="114" width="118" height="3" fill="#A79571" />
              {[0, 1, 2, 3, 4].map((i) => {
                const x = 22 + ((t * 7 + i * 33) % 150)
                return <Walker key={i} x={x} y={132} i={i} ph={t * 6 + i * 1.7} s={0.85 + (i % 3) * 0.12} />
              })}
            </g>
            {/* the grill, and the light on the glass */}
            {[0, 1, 2, 3].map((i) => <rect key={i} x={45 + i * 24} y="46" width="3.5" height="92" fill="#25423F" opacity=".9" />)}
            <rect x="28" y="88" width="118" height="3.5" fill="#25423F" opacity=".9" />
            <path d="M28 138L74 46h16L44 138z" fill={W} opacity=".1" />
            <rect x="14" y="145" width="146" height="8" rx="2" fill="#E3D9C4" />
            <rect x="14" y="151" width="146" height="3" rx="1.5" fill="#BEB299" />
          </g>

          {/* the switchboard, on its conduit */}
          <g>
            <rect x="171" y="26" width="5" height="88" fill="#E8E2D4" />
            <rect x="172.6" y="26" width="1.4" height="88" fill="#BDB5A3" />
            <g filter="url(#fvsh)">
              <rect x="162" y="112" width="24" height="32" rx="2" fill="#F4F1E8" />
              <rect x="165" y="116" width="7" height="10" rx="1" fill="#DCD6C8" />
              <rect x="176" y="116" width="7" height="10" rx="1" fill="#DCD6C8" />
              <rect x="165" y="130" width="7" height="10" rx="1" fill="#DCD6C8" />
              <circle cx="179.5" cy="135" r="3.4" fill="#C9C2B2" />
              <circle cx="179.5" cy="135" r="1.2" fill="#8C8577" />
            </g>
          </g>

          {/* the wall clock */}
          <g transform="translate(352 74)" filter="url(#fvsh)">
            <circle r="26" fill="#E9E3D5" />
            <circle r="22" fill={W} />
            <circle r="26" fill="none" stroke="#C2B9A4" strokeWidth="2.5" />
            {Array.from({ length: 12 }).map((_, i) => {
              const a = (i / 12) * Math.PI * 2
              return <line key={i} x1={(Math.sin(a) * 16).toFixed(1)} y1={(-Math.cos(a) * 16).toFixed(1)}
                           x2={(Math.sin(a) * 19.5).toFixed(1)} y2={(-Math.cos(a) * 19.5).toFixed(1)}
                           stroke={i % 3 ? '#9A927F' : INK} strokeWidth={i % 3 ? 1.4 : 2.4} />
            })}
            <line x1="0" y1="0" x2="0" y2="-11" stroke={INK} strokeWidth="3" strokeLinecap="round" />
            <line x1="0" y1="0" x2="10" y2="5" stroke={INK} strokeWidth="3" strokeLinecap="round" />
            <line x1={(-Math.sin(sec * Math.PI * 2) * 5).toFixed(1)} y1={(Math.cos(sec * Math.PI * 2) * 5).toFixed(1)}
                  x2={(Math.sin(sec * Math.PI * 2) * 18).toFixed(1)} y2={(-Math.cos(sec * Math.PI * 2) * 18).toFixed(1)}
                  stroke={RUST} strokeWidth="1.4" strokeLinecap="round" />
            <circle r="2.2" fill={RUST} />
          </g>

          {/* the calendar, its page lifting when the fan comes round */}
          <g transform="translate(300 116)" filter="url(#fvsh)">
            <circle cx="21" cy="-3" r="2.4" fill="#8C8577" />
            <rect x="0" y="0" width="42" height="14" rx="2" fill={RUST} />
            <rect x="4" y="4" width="20" height="3" rx="1.5" fill={W} opacity=".85" />
            <rect x="28" y="4" width="10" height="3" rx="1.5" fill="#F2C48E" opacity=".9" />
            <g transform={`rotate(${(-1.5 + draught * 2.4).toFixed(2)} 21 14)`}>
              <rect x="0" y="14" width="42" height="34" rx="1.5" fill="#FAF6EC" />
              <rect x="4" y="19" width="34" height="8" rx="1.5" fill="#E2D9C4" />
              {[0, 1, 2, 3, 4, 5, 6].map((i) => <rect key={`r1${i}`} x={4 + i * 5} y="30" width="3.4" height="3.4" rx=".8" fill={i > 4 ? RUST : '#A79D8A'} />)}
              {[0, 1, 2, 3, 4, 5, 6].map((i) => <rect key={`r2${i}`} x={4 + i * 5} y="36" width="3.4" height="3.4" rx=".8" fill={i > 4 ? RUST : '#A79D8A'} />)}
              {[0, 1, 2, 3, 4, 5, 6].map((i) => <rect key={`r3${i}`} x={4 + i * 5} y="42" width="3.4" height="3.4" rx=".8" fill={i === 2 ? GRN : '#A79D8A'} />)}
            </g>
          </g>

          {/* the steel almirah, with the year's ledgers tied on top */}
          <g filter="url(#fvsh)">
            <rect x="386" y="96" width="94" height="126" fill="url(#fvsteel)" />
            <rect x="386" y="96" width="94" height="6" fill={STEEL_L} />
            <rect x="390" y="106" width="42" height="108" rx="2" fill={STEEL} stroke={STEEL_D} strokeWidth="1.4" />
            <rect x="434" y="106" width="42" height="108" rx="2" fill={STEEL} stroke={STEEL_D} strokeWidth="1.4" />
            <rect x="428" y="140" width="4" height="26" rx="2" fill="#3D4843" />
            <rect x="436" y="140" width="4" height="26" rx="2" fill="#3D4843" />
            <circle cx="430" cy="176" r="3" fill={BRASS} />
            <rect x="392" y="112" width="12" height="2" rx="1" fill={STEEL_L} opacity=".7" />
            <g transform="translate(396 76)">
              <rect x="0" y="6" width="44" height="7" rx="1.5" fill="#B0482F" />
              <rect x="2" y="0" width="40" height="7" rx="1.5" fill="#C9962F" />
              <rect x="6" y="13" width="44" height="7" rx="1.5" fill="#3F5EA8" />
              <path d="M18 -1v22M20.6 -1v22" stroke="#F4EEDC" strokeWidth="1.3" opacity=".85" />
            </g>
          </g>

          {/* his chair, turning a little under him */}
          <g transform={`rotate(${swivel.toFixed(2)} 240 238)`} filter="url(#fvsh)">
            <rect x="232" y="200" width="16" height="34" rx="5" fill="#2C2A33" />
            <rect x="138" y="168" width="204" height="66" rx="24" fill="#2C2A33" />
            <rect x="146" y="176" width="188" height="56" rx="19" fill="#3C3946" />
            <rect x="156" y="184" width="168" height="44" rx="15" fill={V} opacity=".45" />
            <rect x="138" y="204" width="22" height="11" rx="5.5" fill="#22202A" />
            <rect x="320" y="204" width="22" height="11" rx="5.5" fill="#22202A" />
          </g>

          {/* the fan, hanging in front of it all */}
          <CeilingFan t={t} />
        </svg>

        {/* ── him, at the desk, in the white shirt and tie ────────────── */}
        <div className="absolute" style={{ left: '31.04%', top: '15.6%', width: '38.5%', aspectRatio: '1 / 1',
                                           transform: `rotate(${swivel.toFixed(2)}deg) translateY(${(Math.sin(t * 1.15) * 0.22).toFixed(2)}%)`,
                                           transformOrigin: '50% 104%',
                                           filter: 'drop-shadow(0 3px 4px rgba(33,30,51,.22))' }}>
          <Verifier mood={mood} className="h-full w-full" />
        </div>

        {/* ── the desk, and the two things on it ──────────────────────── */}
        <svg viewBox="0 0 480 288" className="absolute inset-0 h-full w-full">
          <ellipse cx={(240 + swivel * 6).toFixed(1)} cy="230" rx="86" ry="7" fill={INK} opacity=".22" />

          {/* the monitor */}
          <g transform={`translate(${shake.toFixed(2)} 11)`}>
            <ellipse cx="79.5" cy="221" rx="30" ry="5" fill={INK} opacity=".25" />
            <rect x="74" y="196" width="11" height="24" fill="#33313B" />
            <ellipse cx="79.5" cy="220" rx="27" ry="5" fill="#3C3A45" />
            <rect x="18" y="130" width="123" height="72" rx="7" fill="#2A2933" />
            <rect x="24" y="136" width="111" height="56" rx="3" fill={W} />
            <rect x="24" y="136" width="111" height="9" rx="3" fill={V} />
            <circle cx="30" cy="140.5" r="1.6" fill={L} /><circle cx="35" cy="140.5" r="1.6" fill={L} />
            {Array.from({ length: SLOTS }).map((_, i) => {
              const d = digits[i]
              const active = i === digits.length
              return (
                <g key={i} transform={`translate(${39 + i * 20} 162)`}>
                  <rect x="-8" y="-12" width="16" height="25" rx="3" fill={d ? L : W} stroke={d ? V : T} strokeWidth="1.6" />
                  {d && (
                    <g transform={`scale(${(i === digits.length - 1 ? 1 + Math.exp(-popAge * 9) * 0.45 : 1).toFixed(3)})`}>
                      <text x="0" y="8" textAnchor="middle" fontSize="15" fontWeight="800" fill={INK}
                            fontFamily="Bricolage Grotesque, sans-serif">{d}</text>
                    </g>
                  )}
                  {active && caretOn && <rect x="-1" y="-8" width="2" height="18" rx="1" fill={V} />}
                </g>
              )
            })}
            {busy && (
              <>
                <g transform="translate(79.5 182)">
                  <circle r="8" fill="none" stroke={L} strokeWidth="3" />
                  <path d="M8 0a8 8 0 0 1-8 8" fill="none" stroke={V} strokeWidth="3" strokeLinecap="round"
                        transform={`rotate(${((t * 320) % 360).toFixed(1)})`} />
                </g>
                <rect x="34" y="187" width="91" height="3" rx="1.5" fill={L} />
                <rect x={(34 + ((t * 46) % 91) * 0.62).toFixed(1)} y="187" width="34" height="3" rx="1.5" fill={V} />
              </>
            )}
            {state === 'ready' && (
              <g transform="translate(79.5 184)">
                <circle r="9" fill={GRN} />
                <path d="M-4 .2l2.8 2.8 5.6-6.2" fill="none" stroke={W} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
              </g>
            )}
            {state === 'error' && (
              <g transform="translate(79.5 184)">
                <circle r="9" fill={RED} />
                <path d="M-3.6 -3.6l7.2 7.2M3.6 -3.6l-7.2 7.2" stroke={W} strokeWidth="2.4" strokeLinecap="round" />
              </g>
            )}
            <rect x="24" y={(137 + ((t * 26) % 54)).toFixed(1)} width="111" height="2" fill={W} opacity=".45" />
            <rect x="24" y="136" width="111" height="56" rx="3" fill={W} opacity={(0.04 + Math.abs(Math.sin(t * 1.3)) * 0.04).toFixed(3)} />
            <path d="M24 136h111v10z" fill={W} opacity=".16" />
          </g>

          {/* the wooden desk, under its sheet of glass */}
          <rect x="-6" y="224" width="492" height="4" fill="#F6F1E6" opacity=".85" />
          <rect x="-6" y="227" width="492" height="14" rx="3" fill={WOOD} />
          <rect x="-6" y="227" width="492" height="4" fill={WOOD_L} />
          <rect x="-6" y="238" width="492" height="3" fill={WOOD_D} />
          <rect x="0" y="241" width="480" height="47" fill={WOOD_D} />
          <rect x="0" y="241" width="480" height="47" fill="url(#fvgrain)" opacity=".6" />
          <rect x="26" y="248" width="184" height="33" rx="3" fill={WOOD} />
          <rect x="270" y="248" width="184" height="33" rx="3" fill={WOOD} />
          <rect x="26" y="248" width="184" height="2" fill={WOOD_L} opacity=".7" />
          <rect x="270" y="248" width="184" height="2" fill={WOOD_L} opacity=".7" />
          <rect x="96" y="261" width="44" height="6" rx="3" fill={BRASS} />
          <rect x="340" y="261" width="44" height="6" rx="3" fill={BRASS} />
          <path d="M10 227h120l-38 11H-4z" fill={W} opacity=".16" />

          {/* the tricolour */}
          <DeskFlag t={t} />
        </svg>
      </div>
    </div>
  )
}
