import { useEffect, useState } from 'react'
import useScene from './motion.js'
import Verifier from '../login/Verifier.jsx'

// PhotoBoothScene — the companion showing the operator how the photo goes.
//
// He is the portal's own character, the one on the login screen, so he is
// the one who stands on the mark here. The camera rehearses a take every
// few seconds: the barrel racks out, the focus ring spins up, the frame
// tightens onto his face, the lamp charges, the shutter fires and the
// camera kicks back. He plays it out with it — a wave, a namaste, holding
// still for the shot, then the tick and a thumbs-up.
//
// Nothing else is in the picture: a ground shadow, him, and the camera.

const V = '#5B3FA6', VD = '#43307D', VS = '#9A86D6', T = '#DDD5F2', L = '#EFEBF9'
const W = '#FFFFFF', SAF = '#F28C28'

const CYCLE = 7.2
const FOCUS_AT = 3.2      // the barrel starts racking out
const SNAP_AT = 5.2       // the shutter fires

const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : 1 - Math.pow(1 - x, 3))
const span = (k, from, len) => Math.max(0, Math.min(1, (k - from) / len))

// what he does, take by take
const BEATS = [
  [0.0, { type: 'wave' }],
  [1.7, { type: 'pointUp' }],       // look at the lens
  [3.0, { type: 'namaste' }],       // holding the pose for the shot
  [5.2, { type: 'right' }],         // the shutter lands
  [6.1, { type: 'matched' }],
  [6.7, { type: 'thumbsUp' }],
]

export default function PhotoBoothScene({ className = '' }) {
  const { t } = useScene({}, 8)
  const k = t % CYCLE

  const relax = ease(span(k, SNAP_AT + 0.8, 0.9))
  const rack = ease(span(k, FOCUS_AT, 0.9)) * (1 - relax)
  const lock = ease(span(k, FOCUS_AT + 0.5, 0.7)) * (1 - relax)
  const charge = span(k, FOCUS_AT, SNAP_AT - FOCUS_AT)
  const flash = k > SNAP_AT && k < SNAP_AT + 0.4 ? 1 - (k - SNAP_AT) / 0.4 : 0
  const kick = k > SNAP_AT && k < SNAP_AT + 0.5 ? Math.sin(((k - SNAP_AT) / 0.5) * Math.PI) : 0
  const aim = lock * 2.2                                   // it tips towards him as it locks
  const hop = k > SNAP_AT && k < SNAP_AT + 1.2 ? Math.sin(((k - SNAP_AT) / 1.2) * Math.PI) : 0

  // his pose changes on the beat, not every frame — the character keeps
  // its own springs, so it only needs telling what to do.
  const [mood, setMood] = useState(BEATS[0][1])
  useEffect(() => {
    let alive = true
    const at = (i) => {
      if (!alive) return
      setMood(BEATS[i][1])
      const next = (i + 1) % BEATS.length
      const wait = next === 0
        ? (CYCLE - BEATS[i][0]) * 1000
        : (BEATS[next][0] - BEATS[i][0]) * 1000
      setTimeout(() => at(next), wait)
    }
    at(0)
    return () => { alive = false }
  }, [])

  return (
    <div aria-hidden="true" className={`relative mx-auto ${className}`} style={{ aspectRatio: '44 / 25' }}>
      {/* the ground, and the camera behind him */}
      <svg viewBox="0 0 440 250" className="absolute inset-0 h-full w-full">
        <defs>
          <linearGradient id="pbLens" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#9FD2F2" /><stop offset=".5" stopColor="#5B3FA6" /><stop offset="1" stopColor="#241C44" />
          </linearGradient>
        </defs>

        <ellipse cx="220" cy="228" rx="196" ry="16" fill={L} />
        <ellipse cx="302" cy="224" rx="62" ry="12" fill="#E2DAF6" />
        <ellipse cx="302" cy="221" rx="62" ry="12" fill={T} />
        <ellipse cx="302" cy="219" rx="50" ry="9" fill="#E6DEF8" />
        <ellipse cx={(302 + hop * 2).toFixed(1)} cy="219"
                 rx={(34 - hop * 9).toFixed(1)} ry={(6.5 - hop * 1.8).toFixed(1)}
                 fill={VD} opacity={(0.2 - hop * 0.07).toFixed(3)} />

        <g transform={`translate(${(-kick * 6).toFixed(2)} 0) rotate(${(kick * 1.8 + aim * 0.35).toFixed(2)} 118 150)`}>
          <ellipse cx="118" cy="222" rx="62" ry="8" fill={VD} opacity=".14" />
          <path d="M108 156l-40 64 8 5 39-62zM128 156l40 64-8 5-39-62zM114 158v64h8v-64z" fill={VD} />
          <rect x="104" y="136" width="26" height="24" rx="6" fill={VD} />
          <circle cx="136" cy="146" r="5" fill={VS} />

          {/* the body, aiming as it locks */}
          <g transform={`rotate(${(-aim).toFixed(2)} 118 108)`}>
            <rect x="34" y="70" width="132" height="70" rx="18" fill={V} />
            <rect x="34" y="70" width="132" height="20" rx="10" fill={W} opacity=".12" />
            <rect x="72" y="54" width="44" height="18" rx="6" fill={VD} />
            <rect x="82" y="46" width="24" height="10" rx="4" fill={V} />
            <rect x="44" y="96" width="30" height="10" rx="5" fill={VD} opacity=".55" />
            <circle cx="152" cy="88" r="6.5" fill={charge > 0.98 ? SAF : T} opacity={(0.55 + charge * 0.45).toFixed(2)} />
            <circle cx="152" cy="88" r="12" fill={SAF} opacity={(charge * 0.28).toFixed(2)} />

            <g transform={`translate(${(rack * 12).toFixed(2)} 0)`}>
              <rect x="160" y="86" width="18" height="38" rx="4" fill="#2A2933" />
              <circle cx="188" cy="105" r="35" fill="#2A2933" />
              <circle cx="188" cy="105" r="28" fill={VD} />
              <circle cx="188" cy="105" r="18" fill="url(#pbLens)" />
              <circle cx="188" cy="105" r="9.5" fill="#1D1B27" />
              <ellipse cx={(194 - rack * 2).toFixed(1)} cy="97" rx="5.4" ry="3.4" fill={W} opacity=".85"
                       transform={`rotate(-28 ${(194 - rack * 2).toFixed(1)} 97)`} />
              <circle cx="188" cy="105" r="31.5" fill="none" stroke={V} strokeWidth="3" strokeDasharray="13 9"
                      opacity={(0.2 + lock * 0.7).toFixed(2)}
                      transform={`rotate(${((t * 90 + lock * 240) % 360).toFixed(1)} 188 105)`} />
            </g>
          </g>
        </g>
      </svg>

      {/* him, on the mark */}
      <div className="absolute" style={{ left: '46.6%', top: '14%', width: '43.2%', aspectRatio: '1 / 1' }}>
        <Verifier mood={mood} className="h-full w-full" />
      </div>

      {/* the frame the portal holds on his face, and the shutter */}
      <svg viewBox="0 0 440 250" className="pointer-events-none absolute inset-0 h-full w-full">
        <defs>
          <radialGradient id="pbFlash" cx="50%" cy="50%" r="50%">
            <stop offset="0" stopColor="#FFFFFF" stopOpacity=".92" /><stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
          </radialGradient>
        </defs>

        <g opacity={(0.4 + lock * 0.6).toFixed(2)}
           transform={`translate(297 100) scale(${(1.14 - lock * 0.14).toFixed(3)}) translate(-297 -100)`}>
          <rect x="236" y="36" width="122" height="128" rx="12" fill="none" stroke={VS} strokeWidth="2.2" strokeDasharray="8 9" />
          <g fill="none" stroke={flash > 0.02 ? W : V} strokeWidth={(5 + flash * 3).toFixed(1)} strokeLinecap="round">
            <path d="M236 58V42a6 6 0 0 1 6-6h16M358 58V42a6 6 0 0 0-6-6h-16M236 142v16a6 6 0 0 0 6 6h16M358 142v16a6 6 0 0 1-6 6h-16" />
          </g>
          {lock > 0.6 && (
            <g fill={V} opacity={((lock - 0.6) / 0.4).toFixed(2)}>
              <circle cx="281" cy="98" r="2.2" /><circle cx="313" cy="98" r="2.2" /><circle cx="297" cy="126" r="2.2" />
            </g>
          )}
        </g>

        {flash > 0.01 && (
          <>
            <circle cx="230" cy="110" r={(76 + (1 - flash) * 46).toFixed(0)} fill="url(#pbFlash)" opacity={flash.toFixed(2)} />
            <rect x="0" y="0" width="440" height="250" fill={W} opacity={(flash * 0.4).toFixed(2)} />
          </>
        )}
      </svg>
    </div>
  )
}
