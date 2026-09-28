import { useEffect, useMemo, useRef, useState } from 'react'
import { VIEW, COUNTRY, ISLANDS, STATES, CITY } from './indiaGeo.js'

// IndiaReachMap — where the platform has reached.
//
// The map is real: the border is India's own boundary data, projected
// equirectangular at 23°N, and every city goes through the same
// projection, so a pin sits where the city sits.
//
// It plays once, in order. The coastline draws itself from the north
// clockwise. The land washes in behind it. The state lines come up one
// after another, the way a map is inked in. Then each institution's pin
// falls, squashes on the ground, springs back and sends a ring out
// across the country, with its city named beside it. After that the map
// holds and only breathes, with a slow light crossing it.
//
// props: places [{ id, name, city }], className

const NAMES = Object.keys(CITY)

// Which city a name belongs to. If the name says so, believe it;
// otherwise give that institution a city of its own, the same one every
// time, so the map never reshuffles between loads.
function placeOf(text, i) {
  const s = String(text || '')
  const named = NAMES.find((c) => new RegExp(c, 'i').test(s))
  if (named) return named
  let h = 2166136261
  for (let k = 0; k < s.length; k++) { h ^= s.charCodeAt(k); h = Math.imul(h, 16777619) }
  return NAMES[(h >>> 0) % NAMES.length] || NAMES[i % NAMES.length]
}

const clamp = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)
const easeOut = (x) => 1 - (1 - x) ** 3

const DRAW = 1.45        // the coastline drawing itself
const INK = 1.1          // the state lines coming up
const FIRST = 2.1        // when the first pin falls
const GAP = 0.34         // and the next

export default function IndiaReachMap({ places = [], className = '' }) {
  const [t, setT] = useState(0)

  const pins = useMemo(() => places.slice(0, 9).map((p, i) => {
    const city = p.city && CITY[p.city] ? p.city : placeOf(`${p.city || ''} ${p.name || ''}`, i)
    const [x, y] = CITY[city]
    return { id: p.id ?? i, name: p.name, city, x, y, at: FIRST + i * GAP }
  }), [places])

  const last = FIRST + pins.length * GAP + 1.2
  const reduced = useRef(false)

  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      reduced.current = true
      setT(999)
      return undefined
    }
    let raf = 0, painted = 0
    const t0 = performance.now()
    const loop = (now) => {
      raf = requestAnimationFrame(loop)
      if (now - painted < 32) return
      painted = now
      setT((now - t0) / 1000)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  const draw = clamp(t / DRAW)
  const wash = clamp((t - DRAW * 0.66) / 0.55)
  const ink = clamp((t - DRAW * 0.9) / INK)
  const settled = t > last
  const sweep = settled ? ((t - last) % 9) / 9 : -1

  return (
    <svg viewBox={VIEW} className={className} aria-label="Where the platform has reached">
      <defs>
        <linearGradient id="irm-land" x1=".15" y1="0" x2=".85" y2="1">
          <stop offset="0" stopColor="#F4F1FE" />
          <stop offset=".5" stopColor="#EAE4FA" />
          <stop offset="1" stopColor="#DCD2F6" />
        </linearGradient>
        <radialGradient id="irm-lift" cx="42%" cy="34%" r="62%">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity=".95" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
        </radialGradient>
        <clipPath id="irm-clip"><path d={COUNTRY} /></clipPath>
      </defs>

      {/* the country sits on the page rather than floating on it */}
      <g opacity={wash.toFixed(3)}>
        <path d={COUNTRY} fill="#2B1F52" opacity=".07" transform="translate(1.6 2.4)" />
        <path d={COUNTRY} fill="url(#irm-land)" />
        <g clipPath="url(#irm-clip)">
          <path d={COUNTRY} fill="url(#irm-lift)" opacity=".75" />
        </g>
      </g>

      {/* the states, inked in one after another */}
      <g clipPath="url(#irm-clip)" fill="none" stroke="#B4A3E8" strokeWidth=".38" strokeLinejoin="round">
        {STATES.map((d, i) => {
          const o = clamp((ink - (i / STATES.length) * 0.55) * 2.6)
          return o <= 0 ? null : <path key={i} d={d} opacity={(o * 0.9).toFixed(2)} />
        })}
      </g>

      {/* the islands, once the mainland is there */}
      <g opacity={clamp((wash - 0.4) * 2).toFixed(2)}>
        {ISLANDS.map((d, i) => (
          <path key={i} d={d} fill="url(#irm-land)" stroke="#5B3FA6" strokeWidth=".5" strokeLinejoin="round" />
        ))}
      </g>

      {/* the coastline, drawing itself */}
      <path d={COUNTRY} fill="none" stroke="#4A3390" strokeWidth="1.15"
            strokeLinejoin="round" strokeLinecap="round"
            pathLength="1000" strokeDasharray="1000"
            style={{ strokeDashoffset: 1000 * (1 - easeOut(draw)) }} />

      {/* every place it has reached */}
      {pins.map((p) => {
        const age = t - p.at
        if (age < 0) return null
        const fall = clamp(age / 0.6)
        const grounded = easeOut(fall)
        const y = p.y - 34 * (1 - grounded)
        const squash = age > 0.52 && age < 0.86
          ? 1 - Math.sin(((age - 0.52) / 0.34) * Math.PI) * 0.24
          : 1
        const ring = age - 0.58
        const breathe = settled ? 1 + Math.sin(t * 1.5 + p.x * 0.4) * 0.04 : 1
        const label = clamp((age - 0.75) / 0.4)
        const flip = p.x > 140

        return (
          <g key={p.id}>
            {ring > 0 && ring < 1.7 && (
              <g opacity={((1 - ring / 1.7) * 0.8).toFixed(2)}>
                <circle cx={p.x} cy={p.y} r={(ring * 24).toFixed(1)} fill="none" stroke="#5B3FA6" strokeWidth=".8" />
                <circle cx={p.x} cy={p.y} r={(ring * 13).toFixed(1)} fill="none" stroke="#9A86D6" strokeWidth=".6" />
              </g>
            )}

            <ellipse cx={p.x} cy={p.y + 0.5}
                     rx={(3.6 * (2.2 - grounded * 1.2)).toFixed(2)}
                     ry={(1.3 * (2.2 - grounded * 1.2)).toFixed(2)}
                     fill="#2B1F52" opacity={(0.06 + grounded * 0.14).toFixed(2)} />

            <g transform={`translate(${p.x} ${y}) scale(${breathe.toFixed(3)} ${(squash * breathe).toFixed(3)})`}>
              <path d="M0 0c-2.9-4-4.8-6.1-4.8-8.6a4.8 4.8 0 019.6 0C4.8-6.1 2.9-4 0 0z" fill="#5B3FA6" />
              <circle cx="0" cy="-8.6" r="1.9" fill="#FFFFFF" />
            </g>

            {label > 0 && (
              <text x={flip ? p.x - 6 : p.x + 6} y={p.y - 0.4}
                    textAnchor={flip ? 'end' : 'start'}
                    opacity={label.toFixed(2)}
                    style={{ font: '700 5.2px "Bricolage Grotesque", system-ui, sans-serif' }}
                    fill="#43307D">
                {p.city}
              </text>
            )}
          </g>
        )
      })}

      {/* and a slow light across it, once everything has landed */}
      {sweep >= 0 && sweep < 0.34 && (
        <g clipPath="url(#irm-clip)" opacity={(Math.sin((sweep / 0.34) * Math.PI) * 0.5).toFixed(2)}>
          <rect x={(-40 + (sweep / 0.34) * 260).toFixed(1)} y="-20" width="18" height="260"
                fill="#FFFFFF" transform="skewX(-14)" />
        </g>
      )}
    </svg>
  )
}
