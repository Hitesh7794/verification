import { useEffect, useState } from 'react'
import Verifier from '../login/Verifier.jsx'

// DeviceScene — the Devices page's living background: the desk kit working.
//
// A thumb comes down on the fingerprint scanner; the glass glows and the
// ridges light up; the reading travels down the USB cable as pulses to the
// laptop, where the print draws in on screen and a tick lands. The iris
// scanner beside it winks its infrared lights. The companion stands behind
// the laptop: he asks for the finger, watches, and gives a thumbs-up when
// the tick lands. Flat FlatViolet. ?device_t=<s> freezes it.

const V = '#5B3FA6', VD = '#43307D', VS = '#9A86D6', T = '#DDD5F2', L = '#EFEBF9'
const W = '#FFFFFF', INK = '#211E33', SAF = '#F28C28', SKIN = '#E8C39E', SKIN_DK = '#D6AA80'
const CYCLE = 4.6
const clamp = (x) => Math.max(0, Math.min(1, x))
const easeOutBack = (x) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2) }

// cable from the scanner (left) to the laptop (centre)
const CABLE = 'M112 236 C 150 262, 190 262, 222 238'

export default function DeviceScene({ className = '', style }) {
  const frozen = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('device_t') : null
  const [t, setT] = useState(frozen != null ? Number(frozen) : 0.6)
  useEffect(() => {
    if (frozen != null) return undefined
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined
    let raf = 0, last = performance.now(), acc = 0.6, lastPaint = 0
    const loop = (now) => {
      raf = requestAnimationFrame(loop)
      acc += Math.min(0.1, Math.max(0, (now - last) / 1000)); last = now
      if (now - lastPaint > 33) { lastPaint = now; setT(acc) }
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [frozen])

  const u = t % CYCLE
  const down = u < 0.8 ? u / 0.8 : u < 3.2 ? 1 : u < 3.8 ? 1 - (u - 3.2) / 0.6 : 0
  const glow = clamp((u - 0.8) / 0.3) * (u < 3.4 ? 1 : 1 - clamp((u - 3.4) / 0.4))
  const ridges = clamp((u - 0.9) / 0.7)
  const pulse = clamp((u - 1.1) / 1.1)             // data along the cable
  const screen = clamp((u - 1.8) / 0.8)            // print drawing on screen
  const tick = clamp((u - 2.5) / 0.35)
  const ir = Math.sin(t * 5) > 0.2
  const mood = u < 0.8 ? 'askFinger' : u < 2.6 ? 'eyeScan' : u < 3.9 ? 'deviceOk' : 'askFinger'
  const thumbY = -44 + down * 38

  return (
    <div aria-hidden="true" className={`pointer-events-none select-none ${className}`} style={style}>
      <div className="relative h-full w-full">
        {/* him, behind the laptop */}
        <div className="absolute" style={{ left: '38%', top: '0%', width: '30%', aspectRatio: '1 / 1' }}>
          <Verifier mood={{ type: mood }} className="h-full w-full" />
        </div>
        <svg viewBox="0 0 480 300" className="absolute inset-0 h-full w-full">
          {/* the desk */}
          <rect x="10" y="236" width="460" height="12" rx="5" fill={VD} />
          <rect x="20" y="246" width="440" height="54" fill={VS} />

          {/* the cable and its pulses */}
          <path d={CABLE} fill="none" stroke={INK} strokeWidth="4" strokeLinecap="round" opacity=".75" />
          {pulse > 0 && pulse < 1 && [0, 0.18, 0.36].map((o) => {
            const k = clamp(pulse * 1.4 - o)
            if (k <= 0 || k >= 1) return null
            const x = 112 + (222 - 112) * k, y = 236 + Math.sin(k * Math.PI) * 20
            return <circle key={o} cx={x} cy={y} r="5" fill={SAF} />
          })}

          {/* the fingerprint scanner */}
          <g transform="translate(80 236)">
            <path d="M-44 0c0-22 12-40 44-40s44 18 44 40z" fill={VD} />
            <path d="M-34 -2c0-16 10-30 34-30s34 14 34 30z" fill={V} />
            <rect x="-20" y="-22" width="40" height="16" rx="4" fill={glow > 0.05 ? '#C3B6E8' : T} />
            {glow > 0.05 && <rect x="-20" y="-22" width="40" height="16" rx="4" fill={VS} opacity={glow * 0.8} />}
            <g fill="none" stroke={W} strokeWidth="1.6" strokeLinecap="round" opacity={ridges}>
              <path d="M-8 -9a8 6 0 0 1 16 0" /><path d="M-13 -8a13 9 0 0 1 26 0" /><path d="M-3 -10a3 3 0 0 1 6 0" />
            </g>
            <circle cx="30" cy="-10" r="3" fill={glow > 0.5 ? SAF : T} />
            {/* the thumb, coming down onto the glass */}
            <g transform={`translate(0 ${thumbY})`}>
              <rect x="-11" y="-56" width="22" height="46" rx="11" fill={SKIN} />
              <path d="M-7 -14a7 5 0 0 0 14 0" fill={SKIN_DK} />
              <rect x="-14" y="-72" width="28" height="22" rx="8" fill={W} />
            </g>
          </g>

          {/* the laptop */}
          <g transform="translate(222 150)">
            <rect x="0" y="0" width="120" height="80" rx="6" fill={VD} />
            <rect x="6" y="6" width="108" height="68" rx="3" fill={W} />
            <rect x="6" y="6" width="108" height="11" rx="3" fill={V} />
            {/* the print drawing in */}
            <g fill="none" stroke={V} strokeWidth="2.2" strokeLinecap="round">
              {[10, 17, 24].map((r, i) => (
                <path key={r} d={`M${46 - r} 52a${r} ${r * 1.2} 0 0 1 ${r * 2} 0`} pathLength="1" strokeDasharray="1 1"
                      strokeDashoffset={1 - clamp(screen * 1.6 - i * 0.25)} />
              ))}
            </g>
            {tick > 0 && (
              <g transform={`translate(88 46) scale(${easeOutBack(tick)})`}>
                <circle r="13" fill={V} />
                <path d="M-6 0l4 4 8-9" fill="none" stroke={W} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              </g>
            )}
            <path d="M-12 80h144l-8 10H-4z" fill={VS} />
            <circle cx="60" cy="3" r="1.8" fill={T} />
          </g>

          {/* the iris scanner, winking its IR lights */}
          <g transform="translate(400 236)">
            <rect x="-10" y="-30" width="20" height="30" rx="6" fill={VD} />
            <rect x="-38" y="-62" width="76" height="34" rx="16" fill={INK} />
            <circle cx="-16" cy="-45" r="11" fill="#2B2742" stroke={VS} strokeWidth="2" />
            <circle cx="16" cy="-45" r="11" fill="#2B2742" stroke={VS} strokeWidth="2" />
            <circle cx="-16" cy="-45" r="4" fill={V} /><circle cx="16" cy="-45" r="4" fill={V} />
            <circle cx="-30" cy="-45" r="2.4" fill={ir ? SAF : '#4A4660'} />
            <circle cx="30" cy="-45" r="2.4" fill={ir ? '#4A4660' : SAF} />
          </g>
        </svg>
      </div>
    </div>
  )
}
