import { useEffect, useState } from 'react'
import Verifier from '../login/Verifier.jsx'

// DownloadScene — the Downloads page's living background: the installer
// arriving on an agent's laptop.
//
// A package drops out of the portal's cloud, slides down the beam into the
// laptop, the install bar fills, and the app opens with a tick. The
// companion stands beside it: he points the package in, watches the bar,
// then gives a thumbs-up. Flat FlatViolet. ?download_t=<s> freezes it.

const V = '#5B3FA6', VD = '#43307D', VS = '#9A86D6', T = '#DDD5F2', L = '#EFEBF9'
const W = '#FFFFFF', INK = '#211E33', SAF = '#F28C28'
const CYCLE = 5.4
const clamp = (x) => Math.max(0, Math.min(1, x))
const easeOutBack = (x) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2) }
const easeInOut = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2)

export default function DownloadScene({ className = '', style }) {
  const frozen = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('download_t') : null
  const [t, setT] = useState(frozen != null ? Number(frozen) : 0.4)
  useEffect(() => {
    if (frozen != null) return undefined
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined
    let raf = 0, last = performance.now(), acc = 0.4, lastPaint = 0
    const loop = (now) => {
      raf = requestAnimationFrame(loop)
      acc += Math.min(0.1, Math.max(0, (now - last) / 1000)); last = now
      if (now - lastPaint > 33) { lastPaint = now; setT(acc) }
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [frozen])

  const u = t % CYCLE
  const fall = clamp(u / 1.5)                    // package leaving the cloud
  const inside = u > 1.5
  const bar = clamp((u - 1.6) / 1.9)             // the install bar
  const done = clamp((u - 3.6) / 0.35)           // the app, with its tick
  const mood = u < 1.5 ? 'pointDown' : u < 3.5 ? 'waiting' : 'thumbsUp'
  const boxY = 74 + easeInOut(fall) * 92
  const boxX = 190 + easeInOut(fall) * 34
  const beam = u < 1.7 ? 1 : 1 - clamp((u - 1.7) / 0.4)

  return (
    <div aria-hidden="true" className={`pointer-events-none select-none ${className}`} style={style}>
      <div className="relative h-full w-full">
        {/* him, beside the desk */}
        <div className="absolute" style={{ left: '4%', top: '14%', width: '30%', aspectRatio: '1 / 1' }}>
          <Verifier mood={{ type: mood === 'pointDown' ? 'point' : mood }} className="h-full w-full" />
        </div>
        <svg viewBox="0 0 480 300" className="absolute inset-0 h-full w-full">
          {/* the desk */}
          <rect x="120" y="246" width="350" height="10" rx="4" fill={VD} />
          <rect x="130" y="254" width="330" height="46" fill={VS} />

          {/* the portal's cloud */}
          <g opacity={0.9}>
            <path d="M196 74a26 26 0 0 1 52-4 20 20 0 0 1 4 39h-52a18 18 0 0 1-4-35z" fill={L} stroke={VS} strokeWidth="3" />
            <path d="M214 96l12 12 12-12" fill="none" stroke={V} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" opacity={beam} />
          </g>

          {/* the package on its way down */}
          {!inside && (
            <g transform={`translate(${boxX} ${boxY}) rotate(${fall * 12})`} opacity={1 - clamp((fall - 0.85) / 0.15)}>
              <rect x="-20" y="-18" width="40" height="36" rx="5" fill={SAF} />
              <rect x="-20" y="-4" width="40" height="7" fill="#D97A1E" />
              <rect x="-4" y="-18" width="8" height="36" fill="#D97A1E" />
              <path d="M-13 -24l13 6 13-6" fill="none" stroke={W} strokeWidth="2.4" strokeLinecap="round" />
            </g>
          )}

          {/* the laptop */}
          <g transform="translate(232 160)">
            <rect x="0" y="0" width="140" height="88" rx="7" fill={VD} />
            <rect x="7" y="7" width="126" height="74" rx="4" fill={W} />
            <rect x="7" y="7" width="126" height="12" rx="4" fill={V} />
            {done < 0.05 ? (
              <>
                {/* installing */}
                <rect x="24" y="40" width="92" height="12" rx="6" fill={L} />
                <rect x="24" y="40" width={92 * bar} height="12" rx="6" fill={V} />
                <text x="70" y="68" textAnchor="middle" fontSize="12" fontWeight="700" fill={INK} fontFamily="Bricolage Grotesque, sans-serif">
                  {Math.round(bar * 100)}%
                </text>
                <rect x="52" y="26" width="36" height="8" rx="4" fill={T} />
              </>
            ) : (
              <>
                {/* the app, ready */}
                <rect x="22" y="28" width="44" height="10" rx="5" fill={T} />
                <rect x="22" y="44" width="30" height="8" rx="4" fill={L} />
                <g transform={`translate(98 50) scale(${easeOutBack(done)})`}>
                  <circle r="15" fill={V} />
                  <path d="M-7 0l4.6 4.6 9-10" fill="none" stroke={W} strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
                </g>
              </>
            )}
            <path d="M-14 88h168l-10 10H-4z" fill={VS} />
          </g>

          {/* a fingerprint scanner plugged in beside it */}
          <g transform="translate(418 246)">
            <path d="M-26 0c0-13 7-23 26-23s26 10 26 23z" fill={VD} />
            <rect x="-12" y="-14" width="24" height="9" rx="3" fill={T} />
            <path d="M-26 -4 C -40 -4, -44 4, -56 4" fill="none" stroke={INK} strokeWidth="3" opacity=".6" />
          </g>
        </svg>
      </div>
    </div>
  )
}
