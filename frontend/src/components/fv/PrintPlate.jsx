import { useRef } from 'react'
import useScene from './motion.js'

// PrintPlate — where the candidate's own capture is shown.
//
// The scanner hands back a bitmap: the fingerprint it lifted, or the eye
// it photographed. This is the plate it lands on. While the scan runs the
// picture develops from the bottom under a travelling bar, the way a print
// comes up on glass. When it matches, the points the matcher used pop on
// one after another and a violet ring closes around the plate; when it
// does not, the plate goes amber and crosses itself out.
//
// With no bitmap (an older device, or the demo) it draws the ridges
// itself, so the plate never sits empty.
//
// props: src, status ('idle'|'scanning'|'pass'|'fail'), kind, seed

const V = '#5B3FA6', VS = '#9A86D6', L = '#EFEBF9', W = '#FFFFFF'
const INK = '#211E33', AMB = '#A8711F', AMB_L = '#E4A54B'

const hash = (s) => {
  let h = 2166136261
  for (let i = 0; i < String(s).length; i++) { h ^= String(s).charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}

// The points a matcher would mark up, laid out from the seed so one
// candidate always gets the same marks.
function minutiae(seed, n = 9) {
  let h = hash(seed) || 1
  const out = []
  for (let i = 0; i < n; i++) {
    h = (Math.imul(h, 1103515245) + 12345) >>> 0
    const a = ((h >>> 8) % 360) * (Math.PI / 180)
    const r = 8 + ((h >>> 3) % 26)
    out.push({ x: 50 + Math.cos(a) * r, y: 52 + Math.sin(a) * r * 1.15, t: (h >>> 2) % 2 })
  }
  return out
}

// A fingerprint, drawn, for when the device gives us no picture.
function DrawnRidges({ seed, tint }) {
  const h = hash(seed)
  return (
    <g fill="none" stroke={tint} strokeLinecap="round">
      {Array.from({ length: 11 }).map((_, i) => {
        const r = 5 + i * 3.6
        const wob = ((h >> i) % 5) * 0.35
        return (
          <ellipse key={i} cx="50" cy={52 + i * 0.25} rx={r * (0.82 + wob * 0.04)} ry={r * 1.16}
                   strokeWidth={i % 2 ? 1.5 : 1.9} opacity={0.5 + (i % 3) * 0.14} />
        )
      })}
      <path d="M50 18v14M50 72v14" strokeWidth="1.6" opacity=".45" />
      <path d="M18 52c2 14 5 24 10 32M82 52c-2 14-5 24-10 32" strokeWidth="1.6" opacity=".4" />
    </g>
  )
}

// An eye, drawn, for the same reason: limbal ring, crypts, collarette,
// a pupil with a soft edge and a catchlight.
function DrawnIris({ seed, tint }) {
  const h = hash(seed)
  return (
    <g>
      <defs>
        <radialGradient id={`ppIris-${h}`} cx="50%" cy="46%" r="52%">
          <stop offset="0" stopColor="#8B79CE" /><stop offset=".62" stopColor="#5B3FA6" /><stop offset="1" stopColor="#2E2058" />
        </radialGradient>
      </defs>
      {/* the white, and the lid over it */}
      <path d="M8 52s17-22 42-22 42 22 42 22-17 22-42 22S8 52 8 52z" fill="#E9E4F4" opacity=".14" />
      <path d="M8 52s17-22 42-22 42 22 42 22-17 22-42 22S8 52 8 52z" fill="none" stroke={tint} strokeWidth="1.6" opacity=".7" />
      {/* the iris */}
      <circle cx="50" cy="52" r="20" fill={`url(#ppIris-${h})`} />
      <circle cx="50" cy="52" r="20" fill="none" stroke="#1A1236" strokeWidth="2.2" opacity=".8" />
      <g stroke={tint} strokeLinecap="round">
        {Array.from({ length: 40 }).map((_, i) => {
          const a = (i / 40) * Math.PI * 2
          const len = 6 + ((h >> (i % 12)) % 5)
          return <line key={i} x1={50 + Math.cos(a) * 9} y1={52 + Math.sin(a) * 9}
                       x2={50 + Math.cos(a) * (9 + len)} y2={52 + Math.sin(a) * (9 + len)}
                       strokeWidth={i % 3 ? 0.7 : 1.1} opacity={i % 2 ? 0.5 : 0.75} />
        })}
      </g>
      <circle cx="50" cy="52" r="9.6" fill="none" stroke="#C9BEEA" strokeWidth="1" opacity=".5" />
      {/* the pupil */}
      <circle cx="50" cy="52" r="8" fill="#0B0918" />
      <circle cx="50" cy="52" r="8" fill="none" stroke="#000" strokeWidth="1.4" opacity=".6" />
      <circle cx="54.4" cy="47.4" r="3.1" fill={W} opacity=".85" />
      <circle cx="45.6" cy="57" r="1.5" fill={W} opacity=".45" />
      {/* lashes */}
      <g stroke={tint} strokeWidth="1.2" strokeLinecap="round" opacity=".55">
        <path d="M18 42l-4-4M30 34l-2.6-5M50 30v-5.5M70 34l2.6-5M82 42l4-4" />
      </g>
    </g>
  )
}

export default function PrintPlate({ src, status = 'idle', kind = 'finger', seed = '', className = '' }) {
  const { t, v } = useScene({
    show: status === 'idle' ? 0 : 1,
    done: status === 'pass' || status === 'fail' ? 1 : 0,
  }, 6)
  const scanning = status === 'scanning'
  const ok = status === 'pass'
  const bad = status === 'fail'
  const tone = bad ? AMB_L : V

  // the picture comes up once, from the bottom, and stays up — it used
  // to loop, which read as the scan starting over
  const born = useRef(null)
  if (scanning && born.current === null) born.current = t
  if (!scanning && status === 'idle') born.current = null
  const dev = scanning ? Math.min(1, (t - (born.current ?? t)) / 1.3) : Math.max(v.show, status === 'idle' ? 0 : 1)
  const bar = scanning ? 100 - ((t * 62) % 108) : -20
  const marks = minutiae(seed || kind)
  const pop = (i) => Math.max(0, Math.min(1, (v.done - i * 0.055) * 3))

  return (
    <div className={`relative overflow-hidden rounded-[14px] bg-[#16132A] ${className}`}>
      {/* what the scanner handed back */}
      {src && (
        <img src={src} alt="" aria-hidden="true"
             className="absolute inset-0 h-full w-full object-cover"
             style={{
               clipPath: `inset(${((1 - dev) * 100).toFixed(1)}% 0 0 0)`,
               filter: `grayscale(1) contrast(1.25) ${bad ? 'sepia(.6) hue-rotate(-18deg)' : ''}`,
               opacity: 0.92,
             }} />
      )}

      <svg viewBox="0 0 100 104" preserveAspectRatio="xMidYMid meet" className="absolute inset-0 h-full w-full">
        {/* the plate itself */}
        <rect x="0" y="0" width="100" height="104" fill="#16132A" opacity={src ? 0 : 1} />
        <g opacity={(0.25 + v.show * 0.35).toFixed(2)}>
          {Array.from({ length: 9 }).map((_, i) => (
            <line key={i} x1="0" y1={11 + i * 11} x2="100" y2={11 + i * 11} stroke={VS} strokeWidth=".3" opacity=".25" />
          ))}
        </g>

        {/* waiting: a ghost of what is coming */}
        {status === 'idle' && (
          <g opacity=".16">
            {kind === 'iris'
              ? <DrawnIris seed={seed || kind} tint="#CFC7E8" />
              : <DrawnRidges seed={seed || kind} tint="#CFC7E8" />}
          </g>
        )}

        {/* drawn, when there is no picture to show */}
        {!src && status !== 'idle' && (
          <g style={{ clipPath: `inset(${((1 - dev) * 100).toFixed(1)}% 0 0 0)` }}
             opacity={(0.5 + v.show * 0.45).toFixed(2)}>
            {kind === 'iris'
              ? <DrawnIris seed={seed || kind} tint={bad ? AMB_L : '#CFC7E8'} />
              : <DrawnRidges seed={seed || kind} tint={bad ? AMB_L : '#CFC7E8'} />}
          </g>
        )}

        {/* the bar that lifts it */}
        {scanning && (
          <>
            <rect x="0" y={bar.toFixed(1)} width="100" height="1.6" fill={W} opacity=".8" />
            <rect x="0" y={(bar - 7).toFixed(1)} width="100" height="7" fill={W} opacity=".14" />
          </>
        )}

        {/* the points the matcher used */}
        {v.done > 0.02 && ok && marks.map((m, i) => (
          <g key={i} transform={`translate(${m.x.toFixed(1)} ${m.y.toFixed(1)}) scale(${(0.4 + pop(i) * 0.6).toFixed(2)})`}
             opacity={pop(i).toFixed(2)}>
            {m.t
              ? <circle r="2.6" fill="none" stroke={V} strokeWidth="1.3" />
              : <path d="M-2.4 -2.4l4.8 4.8M2.4 -2.4l-4.8 4.8" stroke={V} strokeWidth="1.3" strokeLinecap="round" />}
          </g>
        ))}

        {/* and how it went */}
        <rect x="1" y="1" width="98" height="102" rx="9" fill="none"
              stroke={tone} strokeWidth={(1 + v.done * 1.6).toFixed(2)}
              opacity={(0.35 + v.done * 0.6).toFixed(2)} />
        {v.done > 0.05 && (
          <g transform={`translate(84 ${bad ? 18 : 18}) scale(${(0.7 + v.done * 0.3).toFixed(2)})`} opacity={Math.min(1, v.done * 1.6).toFixed(2)}>
            <circle r={(9 + (1 - v.done) * 10).toFixed(1)} fill="none" stroke={bad ? AMB : V} strokeWidth="1.4" opacity={((1 - v.done) * 0.8).toFixed(2)} />
            <circle r="9" fill={bad ? AMB : V} />
            {bad
              ? <path d="M-3.4 -3.4l6.8 6.8M3.4 -3.4l-6.8 6.8" stroke={W} strokeWidth="2" strokeLinecap="round" />
              : <path d="M-4 .4l2.8 2.8 5.6-6.4" fill="none" stroke={W} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}
          </g>
        )}
      </svg>
    </div>
  )
}

// A stand-in capture, so the demo shows the same interface the desk will.
export function demoCapture(kind, seed = '') {
  const h = hash(seed || kind)
  const ridges = Array.from({ length: 13 }).map((_, i) => {
    const r = 6 + i * 6.2
    const w = ((h >> i) % 6) * 0.5
    return `<ellipse cx='105' cy='120' rx='${(r * (0.8 + w * 0.03)).toFixed(1)}' ry='${(r * 1.18).toFixed(1)}' />`
  }).join('')
  const svg = kind === 'iris'
    ? `<svg xmlns='http://www.w3.org/2000/svg' width='210' height='240' viewBox='0 0 210 240'>
         <rect width='210' height='240' fill='#0B0A16'/>
         <ellipse cx='105' cy='120' rx='92' ry='58' fill='#1A1730'/>
         <circle cx='105' cy='120' r='46' fill='#2C2748'/>
         <g stroke='#6A5FA0' stroke-width='1.6'>${Array.from({ length: 40 }).map((_, i) => {
           const a = (i / 40) * Math.PI * 2
           return `<line x1='${105 + Math.cos(a) * 18}' y1='${120 + Math.sin(a) * 18}' x2='${105 + Math.cos(a) * 45}' y2='${120 + Math.sin(a) * 45}' />`
         }).join('')}</g>
         <circle cx='105' cy='120' r='18' fill='#07060E'/>
         <circle cx='116' cy='108' r='7' fill='#D8D2EA' opacity='.75'/>
       </svg>`
    : `<svg xmlns='http://www.w3.org/2000/svg' width='210' height='240' viewBox='0 0 210 240'>
         <rect width='210' height='240' fill='#0B0A16'/>
         <g fill='none' stroke='#CFC7E8' stroke-width='3' stroke-linecap='round' opacity='.8'>${ridges}</g>
         <path d='M105 26v34M105 190v30' stroke='#CFC7E8' stroke-width='3' opacity='.5'/>
       </svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg.replace(/\s+/g, ' '))}`
}
