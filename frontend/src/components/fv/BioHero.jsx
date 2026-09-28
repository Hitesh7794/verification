import { useMemo, useRef } from 'react'
import useScene from './motion.js'

// BioHero — the capture, drawn as the thing itself.
//
// THE FINGER. The pad rests on the glass as a ghost: every ridge is there,
// faint, with the light drifting over it. The moment the reader starts, a
// ring goes out from where the finger landed and the reader's line climbs
// the pad. Behind the line each ridge traces itself on, lit along its
// crest and shadowed underneath, with the pores showing; the line leaves a
// decaying afterglow, throws flecks where it crosses a ridge, and once it
// is home the matcher draws its web and lands its points one by one. A
// match blooms out of the core.
//
// THE EYE. It sits almost still, drifting the way an eye does, blinking
// between reads. The read sends a ring of light out from the pupil and the
// iris materialises just behind it — deep furrows first, then crypts, then
// the fine surface fibres, each layer turning at its own rate so the eye
// has parallax when it moves. The cornea carries a dome of light, the
// scanner's two infrared points reflect in it, the pupil answers the light,
// and the iris code writes itself on the rim and along a strip below.
//
// Geometry is built once per candidate and memoised; a frame only moves a
// handful of numbers.
//
// props: kind 'finger'|'iris', status, seed, src, theme

const V = '#5B3FA6', W = '#FFFFFF'
const AMB = '#E4A54B', AMB_D = '#A8711F'
const PAD = 'M50 12c18.5 0 30 14.5 30 34 0 17-3.5 33-9.5 45-4.6 9.2-12 14-20.5 14s-15.9-4.8-20.5-14C23.5 79 20 63 20 46c0-19.5 11.5-34 30-34z'
const EYE = 'M3 66C16 41 34 27 51 27c18 0 37 15 46 35-9 22-28 37-46 37-17 0-35-14-48-33z'
const LID = 'M3 66C16 41 34 27 51 27c18 0 37 15 46 35-11-13-28-20-46-20-17 0-34 8-48 24z'

const hash = (s) => {
  let h = 2166136261
  for (let i = 0; i < String(s).length; i++) { h ^= String(s).charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}
const rnd = (seed) => {
  let h = seed || 1
  return () => { h = (Math.imul(h, 1103515245) + 12345) >>> 0; return h / 4294967296 }
}
const clamp = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)

// A fingerprint, built the way one is built.
//
// A print is a flow, and two kinds of point govern it: a core, where the
// ridges turn back on themselves, and a delta, where three families of
// ridge meet. Place those and the orientation everywhere else follows
// (Sherlock & Monro's zero-pole model). Ridges are then traced along that
// flow and packed an even distance apart, so they never cross and never
// bunch — the way skin actually grows. A few are cut in open ground,
// because real ridges simply stop, and those endings are exactly what a
// matcher marks.
//
// The candidate's own seed decides the pattern: roughly two in three get
// a loop, one in four a whorl, the rest a plain arch.
function printPaths(seed) {
  const r = rnd(hash(seed || 'x'))
  r(); r(); r()
  const CX = 50, CY = 58, RX = 30, RY = 46, SEP = 2.0
  const inside = (x, y) => ((x - CX) / RX) ** 2 + ((y - CY) / RY) ** 2 <= 1
  const depth = (x, y) => 1 - Math.sqrt(((x - CX) / RX) ** 2 + ((y - CY) / RY) ** 2)

  const pick = r()
  const kind = pick < 0.62 ? 'loop' : pick < 0.88 ? 'whorl' : 'arch'
  const hand = r() < 0.5 ? 1 : -1
  const jx = (r() - 0.5) * 4, jy = (r() - 0.5) * 4
  let cores = [], deltas = []
  if (kind === 'loop') {
    cores = [{ x: CX + hand * 5 + jx, y: CY - 11 + jy }]
    deltas = [{ x: CX - hand * 15 + jx, y: CY + 18 + jy }]
  } else if (kind === 'whorl') {
    cores = [{ x: CX - 1.4 + jx, y: CY - 7 + jy }, { x: CX + 1.4 + jx, y: CY - 3.5 + jy }]
    deltas = [{ x: CX - 16 + jx, y: CY + 18 + jy }, { x: CX + 16 + jx, y: CY + 18 + jy }]
  }

  const bow = (x) => -1.7 * Math.exp(-(((x - CX) / 21) ** 2)) * ((x - CX) / 21)
  const theta = (x, y) => {
    let a = 0
    for (const c of cores) a += 0.5 * Math.atan2(y - c.y, x - c.x)
    for (const d of deltas) a -= 0.5 * Math.atan2(y - d.y, x - d.x)
    return a + bow(x) * (kind === 'arch' ? 1 : 0.25)
      + 0.05 * Math.sin((x - CX) / 14) + 0.05 * Math.cos((y - CY) / 18)
  }

  // a coarse grid, so "is there already a ridge here" stays cheap
  const grid = new Map()
  const near = (x, y, d) => {
    const gx = Math.floor(x / SEP), gy = Math.floor(y / SEP)
    const rr = Math.ceil(d / SEP)
    for (let i = -rr; i <= rr; i++) {
      for (let j = -rr; j <= rr; j++) {
        const b = grid.get((gx + i) * 997 + (gy + j))
        if (!b) continue
        for (let k = 0; k < b.length; k += 2) if ((b[k] - x) ** 2 + (b[k + 1] - y) ** 2 < d * d) return true
      }
    }
    return false
  }
  const put = (x, y) => {
    const k = Math.floor(x / SEP) * 997 + Math.floor(y / SEP)
    const b = grid.get(k)
    if (b) b.push(x, y); else grid.set(k, [x, y])
  }

  const STEP = 0.45
  const trace = (sx, sy, dir) => {
    const pts = []
    let x = sx, y = sy
    let px = Math.cos(theta(x, y)) * dir, py = Math.sin(theta(x, y)) * dir
    for (let i = 0; i < 520; i++) {
      if (!inside(x, y) || (i > 2 && near(x, y, SEP * 0.55))) break
      pts.push([x, y])
      const t1 = theta(x, y)
      let ux = Math.cos(t1), uy = Math.sin(t1)
      if (ux * px + uy * py < 0) { ux = -ux; uy = -uy }
      const t2 = theta(x + ux * STEP * 0.5, y + uy * STEP * 0.5)
      let vx = Math.cos(t2), vy = Math.sin(t2)
      if (vx * ux + vy * uy < 0) { vx = -vx; vy = -vy }
      x += vx * STEP; y += vy * STEP; px = vx; py = vy
    }
    return pts
  }

  const lines = []
  const start = cores[0] || { x: CX, y: CY - 9 }
  const queue = [[start.x + SEP * 2, start.y], [start.x - SEP * 2, start.y],
    [start.x, start.y + SEP * 2], [start.x, start.y - SEP * 2]]
  let guard = 0
  while (queue.length && lines.length < 300 && guard++ < 24000) {
    const [sx, sy] = queue.shift()
    if (!inside(sx, sy) || near(sx, sy, SEP * 0.9)) continue
    if (cores.length > 1 && cores.some((c) => Math.hypot(c.x - sx, c.y - sy) < 2.4)) continue
    const a = trace(sx, sy, 1), b = trace(sx, sy, -1)
    const line = b.slice(1).reverse().concat(a)
    if (line.length < 7) continue
    for (const q of line) put(q[0], q[1])
    lines.push(line)
    for (let i = 2; i < line.length - 2; i += 5) {
      const dx = line[i + 1][0] - line[i - 1][0], dy = line[i + 1][1] - line[i - 1][1]
      const L = Math.hypot(dx, dy) || 1
      queue.push([line[i][0] - dy / L * SEP, line[i][1] + dx / L * SEP])
      queue.push([line[i][0] + dy / L * SEP, line[i][1] - dx / L * SEP])
    }
  }

  // ridges that simply stop, in open skin
  const ends = []
  for (let n = 0; n < 30 && ends.length < 14 && lines.length > 12; n++) {
    const li = Math.floor(r() * lines.length)
    const line = lines[li]
    if (!line || line.length < 44) continue
    const at = Math.floor(line.length * (0.25 + r() * 0.5))
    if (depth(line[at][0], line[at][1]) < 0.18) continue
    const head = line.slice(0, at), tail = line.slice(at + 4)
    if (head.length < 10 || tail.length < 10) continue
    lines.splice(li, 1, head, tail)
    ends.push([head[head.length - 1], head[head.length - 5]], [tail[0], tail[4]])
  }

  const marks = []
  for (const [q, back] of ends) {
    if (marks.length >= 7) break
    if (marks.some((m) => Math.hypot(m.x - q[0], m.y - q[1]) < 11)) continue
    marks.push({ x: q[0], y: q[1], kind: marks.length % 2, a: Math.atan2(q[1] - back[1], q[0] - back[0]) * 57.3 })
  }

  const pores = []
  for (const line of lines) {
    for (let i = 8; i < line.length - 8; i += 15) {
      if (r() < 0.4) pores.push({ x: line[i][0], y: line[i][1], r: 0.18 + r() * 0.07 })
    }
  }

  const ridges = lines.map((l, i) => ({
    d: 'M' + l.map((q) => `${q[0].toFixed(2)} ${q[1].toFixed(2)}`).join('L'),
    w: 0.76 + ((i * 7) % 5) * 0.045,
  }))
  return { kind, ridges, marks, pores, cores, deltas }
}

// An eye in three layers, so it has parallax when it moves: deep furrows,
// crypts, and the fine fibres on the surface.
function eyeParts(seed) {
  const r = rnd(hash(seed) ^ 0x9e37)
  const layer = (n, i0, spread, wMin, wMax) => Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 + r() * 0.06
    const inner = i0 + r() * 2
    return { a, inner, outer: inner + spread * (0.5 + r()), w: wMin + r() * (wMax - wMin), o: 0.25 + r() * 0.55, dark: r() > 0.7 }
  })
  const deep = layer(46, 15, 15, 0.9, 2.1)
  const crypts = layer(96, 15.5, 11, 0.45, 1.2)
  const fibres = layer(130, 17, 7, 0.22, 0.6)
  const furrows = Array.from({ length: 7 }, (_, i) => 18 + i * 4.2 + r() * 1.1)
  const veins = Array.from({ length: 9 }, (_, i) => {
    const side = i % 2 ? 1 : -1
    const y = 64 + (r() - 0.5) * 16
    return `M${(51 + side * 46).toFixed(1)} ${y.toFixed(1)}q${(-side * 12).toFixed(1)} ${((r() - 0.5) * 9).toFixed(1)} ${(-side * 23).toFixed(1)} ${((r() - 0.5) * 6).toFixed(1)}`
  })
  const marks = Array.from({ length: 12 }, () => {
    const a = r() * Math.PI * 2
    const rad = 17 + r() * 14
    return { x: 51 + Math.cos(a) * rad, y: 64 + Math.sin(a) * rad * 0.9 }
  })
  const bits = Array.from({ length: 44 }, () => r() > 0.45)
  return { deep, crypts, fibres, furrows, veins, marks, bits }
}

export default function BioHero({ kind = 'finger', status = 'idle', seed = '', src, theme = 'dark', className = '' }) {
  const { t, v } = useScene({ done: status === 'pass' || status === 'fail' ? 1 : 0 }, 6, 32)
  const scanning = status === 'scanning'
  const ok = status === 'pass'
  const bad = status === 'fail'
  const light = theme === 'light'
  const tone = bad ? AMB : V
  const GHOST = light ? '#5B3FA6' : W
  const LINE = light ? '#2B1E55' : W
  const id = useMemo(() => Math.random().toString(36).slice(2, 8), [])
  const geo = useMemo(() => (kind === 'iris' ? eyeParts(seed) : printPaths(seed)), [kind, seed])

  // the read runs once and holds; the spring carries the verdict in
  const born = useRef(null)
  if (scanning && born.current === null) born.current = t
  if (!scanning && status === 'idle') born.current = null
  const raw = scanning ? clamp((t - (born.current ?? t)) / 1.6) : status === 'idle' ? 0 : 1
  const fill = Math.max(raw * (scanning ? 1 : v.done > 0.02 ? 1 : 0), v.done)
  const since = scanning ? t - (born.current ?? t) : 9
  const contact = since < 0.9 ? 1 - since / 0.9 : 0
  const sweeping = fill > 0.001 && fill < 0.999
  const bloom = v.done > 0.02 && v.done < 0.96 ? 1 - v.done : 0
  const beam = v.done > 0.02 && v.done < 0.98 ? v.done : 0
  const analysed = clamp((v.done - 0.15) * 1.6)
  const glint = 0.5 + Math.sin(t * 2.4) * 0.5
  const drift = (t * 0.5) % 1

  // the finger's line, and the flecks it throws
  const line = 118 - fill * 112
  const sparks = sweeping
    ? Array.from({ length: 8 }).map((_, k) => {
      const q = (k * 37 + Math.floor(t * 10)) % 61
      return { x: 22 + (q % 13) * 4.6, o: 0.25 + ((q * 7) % 10) / 14, r: 0.3 + ((q * 3) % 5) / 10 }
    })
    : []

  // the eye's ring of light, its drift, and its blink
  const ringR = fill * 62
  const gx = Math.sin(t * 0.8) * 0.9 + Math.sin(t * 2.3 + 1.1) * 0.35
  const gy = Math.cos(t * 0.95) * 0.5 + Math.sin(t * 1.7) * 0.2
  const bp = (t * 0.28) % 1
  const blink = scanning ? 0 : bp > 0.93 ? Math.sin(((bp - 0.93) / 0.07) * Math.PI) : 0
  const pupil = scanning ? 10.2 + contact * 3.6 + Math.sin(t * 2.2) * 0.8 : 13.2 - blink * 1.2

  return (
    <div aria-hidden="true" className={`relative ${className}`}>
      <svg viewBox="0 0 100 130" className="h-full w-full">
        <defs>
          <linearGradient id={`bh-ink-${id}`} x1="0" y1="1" x2=".25" y2="0">
            <stop offset="0" stopColor={bad ? '#7A4E10' : '#2B1A63'} />
            <stop offset=".5" stopColor={bad ? AMB_D : '#4A3390'} />
            <stop offset="1" stopColor={bad ? AMB : '#6E56C8'} />
          </linearGradient>
          <radialGradient id={`bh-pad-g-${id}`} cx="44%" cy="30%" r="70%">
            <stop offset="0" stopColor="#FFFFFF" stopOpacity={light ? '.92' : '.12'} />
            <stop offset=".62" stopColor="#F4F0FE" stopOpacity={light ? '.8' : '.06'} />
            <stop offset="1" stopColor="#DCD3F6" stopOpacity={light ? '.55' : '.02'} />
          </radialGradient>
          <radialGradient id={`bh-warm-${id}`} cx="50%" cy="72%" r="66%">
            <stop offset="0" stopColor={bad ? AMB_D : '#6E4FD0'} stopOpacity=".5" />
            <stop offset="1" stopColor={bad ? AMB_D : '#6E4FD0'} stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`bh-iris-${id}`} cx="44%" cy="40%" r="58%">
            <stop offset="0" stopColor="#B4A2F2" /><stop offset=".38" stopColor="#7357C8" />
            <stop offset=".76" stopColor="#3C2A79" /><stop offset="1" stopColor="#1E1440" />
          </radialGradient>
          <radialGradient id={`bh-dome-${id}`} cx="38%" cy="28%" r="62%">
            <stop offset="0" stopColor={W} stopOpacity=".5" />
            <stop offset=".45" stopColor={W} stopOpacity=".08" />
            <stop offset="1" stopColor={W} stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`bh-pupil-${id}`} cx="50%" cy="50%" r="50%">
            <stop offset=".62" stopColor="#05040C" /><stop offset="1" stopColor="#05040C" stopOpacity="0" />
          </radialGradient>
          <clipPath id={`bh-pad-${id}`}><path d={PAD} /></clipPath>
          <clipPath id={`bh-eye-${id}`}><path d={EYE} /></clipPath>
          <linearGradient id={`bh-edge-${id}`} x1="0" y1={(line - 8).toFixed(2)} x2="0" y2={(line + 2).toFixed(2)}
                          gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#000" /><stop offset="1" stopColor="#fff" />
          </linearGradient>
          <mask id={`bh-fill-${id}`}>
            {kind === 'finger' ? (
              <>
                <rect x="0" y={(line - 8).toFixed(2)} width="100" height="10" fill={`url(#bh-edge-${id})`} />
                <rect x="0" y={(line + 2).toFixed(2)} width="100" height="140" fill="#fff" />
              </>
            ) : <circle cx="51" cy="64" r={ringR.toFixed(2)} fill="#fff" />}
          </mask>
        </defs>

        {kind === 'finger' ? (
          <>
            {/* the shadow it casts on the glass */}
            <ellipse cx="50" cy="117" rx="30" ry="5" fill={light ? '#6E58B8' : '#000'} opacity={light ? '.1' : '.25'} />
            <ellipse cx="50" cy="116" rx="19" ry="3" fill={light ? '#6E58B8' : '#000'} opacity={light ? '.08' : '.2'} />

            {/* the pad, and the ghost of every ridge on it */}
            <g clipPath={`url(#bh-pad-${id})`}>
              <path d={PAD} fill={`url(#bh-pad-g-${id})`} />
              <g fill="none" stroke={GHOST} strokeWidth=".46" opacity={light ? '.2' : '.16'} strokeLinecap="round">
                {geo.ridges.map((p, i) => <path key={i} d={p.d} />)}
              </g>
              {!sweeping && v.done < 0.02 && (
                <path d={`M${(-30 + drift * 150).toFixed(1)} 0l20 0l-28 130l-20 0z`}
                      fill={light ? '#FFFFFF' : W} opacity=".16" />
              )}
            </g>
            <path d={PAD} fill="none" stroke={light ? '#C9BDEF' : GHOST} strokeWidth=".7"
                  opacity={light ? '.55' : '.18'} />
            <path d={PAD} fill="none" stroke="#FFFFFF" strokeWidth="1.2" opacity={light ? '.45' : '.05'}
                  transform="translate(-.35 -.5)" />

            {/* the ring the finger sends out as it lands */}
            {contact > 0.01 && (
              <g clipPath={`url(#bh-pad-${id})`} opacity={(contact * 0.6).toFixed(2)}>
                <circle cx="50" cy="62" r={(6 + (1 - contact) * 52).toFixed(1)} fill="none" stroke={light ? V : W} strokeWidth="1.1" />
                <circle cx="50" cy="62" r={(2 + (1 - contact) * 30).toFixed(1)} fill="none" stroke={light ? V : W} strokeWidth=".7" opacity=".7" />
              </g>
            )}

            {/* the print, built behind the reader's line */}
            <g mask={`url(#bh-fill-${id})`}>
              <g clipPath={`url(#bh-pad-${id})`}>
                <path d={PAD} fill={`url(#bh-warm-${id})`} opacity={(0.35 + fill * 0.45).toFixed(2)} />
                {/* the shadow each ridge casts, and the light on its crest */}
                <g fill="none" stroke={light ? '#7C68C0' : '#140E2C'} strokeLinecap="round"
                   opacity={light ? '.22' : '.4'} transform="translate(.22 .4)">
                  {geo.ridges.map((p, i) => <path key={i} d={p.d} strokeWidth={(p.w + 0.12).toFixed(2)} />)}
                </g>
                <g fill="none" stroke={light ? '#FFFFFF' : '#E7DEFF'} strokeLinecap="round" opacity=".38"
                   transform="translate(-.2 -.3)">
                  {geo.ridges.map((p, i) => <path key={i} d={p.d} strokeWidth=".3" />)}
                </g>
                {/* and the ridge itself */}
                <g fill="none" stroke={`url(#bh-ink-${id})`} strokeLinecap="round">
                  {geo.ridges.map((p, i) => <path key={i} d={p.d} strokeWidth={p.w.toFixed(2)} />)}
                </g>
                {geo.pores.map((q, i) => (
                  <circle key={i} cx={q.x.toFixed(2)} cy={q.y.toFixed(2)} r={q.r.toFixed(2)}
                          fill={light ? '#FFFFFF' : W} opacity={light ? '.55' : '.4'} />
                ))}
                {/* the sheen that stays on the wet glass */}
                <path d="M26 30q22 16 48 6l-8 16q-24 8-44-8z" fill={W} opacity={light ? '.07' : '.05'} />
              </g>
            </g>

            {/* the reader's line, with the glow it leaves behind it */}
            {sweeping && (
              <g clipPath={`url(#bh-pad-${id})`}>
                <rect x="0" y={(line - 9).toFixed(2)} width="100" height="9" fill={tone} opacity=".13" />
                {[0, 1, 2, 3, 4].map((k) => (
                  <rect key={k} x="0" y={(line - 1.1 - k * 1.5).toFixed(2)} width="100" height=".3"
                        fill={tone} opacity={(0.2 - k * 0.035).toFixed(2)} />
                ))}
                <rect x="0" y={(line - 0.75).toFixed(2)} width="100" height="1.5" rx=".75"
                      fill={light ? V : W} opacity={(0.5 + glint * 0.4).toFixed(2)} />
                <rect x="0" y={(line - 0.26).toFixed(2)} width="100" height=".52" rx=".26"
                      fill={light ? '#FFFFFF' : W} opacity=".96" />
                {sparks.map((sp, k) => (
                  <circle key={k} cx={sp.x.toFixed(1)} cy={(line + (k % 2 ? -0.9 : 0.9)).toFixed(2)}
                          r={sp.r.toFixed(2)} fill={light ? V : W} opacity={sp.o.toFixed(2)} />
                ))}
              </g>
            )}

            {/* the beam that passes over it as the verdict lands */}
            {beam > 0 && (
              <g clipPath={`url(#bh-pad-${id})`} opacity={((1 - beam) * 0.9).toFixed(2)}>
                <rect x={(-30 + beam * 130).toFixed(1)} y="0" width="10" height="130" fill={W} opacity=".5" transform="skewX(-12)" />
                <rect x={(-24 + beam * 130).toFixed(1)} y="0" width="2.4" height="130" fill={tone} opacity=".8" transform="skewX(-12)" />
              </g>
            )}

            {/* and the bloom out of the core */}
            {bloom > 0.02 && (
              <g opacity={(bloom * 0.8).toFixed(2)}>
                <circle cx="50" cy="60" r={(10 + (1 - bloom) * 62).toFixed(1)} fill="none" stroke={tone} strokeWidth="1.2" />
                <circle cx="50" cy="60" r={(4 + (1 - bloom) * 34).toFixed(1)} fill="none" stroke={light ? '#FFFFFF' : W} strokeWidth=".7" />
              </g>
            )}

            {/* the matcher's web, then its points */}
            {ok && analysed > 0.02 && (
              <g opacity={(Math.min(1, analysed * 1.4) * (1 - clamp((analysed - 0.7) / 0.3)) * 0.5).toFixed(2)}>
                {geo.marks.map((m, i) => {
                  const n = geo.marks[(i + 1) % geo.marks.length]
                  return <line key={i} x1={m.x.toFixed(1)} y1={m.y.toFixed(1)} x2={n.x.toFixed(1)} y2={n.y.toFixed(1)} stroke={tone} strokeWidth=".3" strokeDasharray="1 1.8" />
                })}
              </g>
            )}
            {ok && v.done > 0.1 && geo.marks.map((m, i) => {
              const pop = clamp((v.done - i * 0.04) * 3)
              return (
                <g key={i} transform={`translate(${m.x.toFixed(1)} ${m.y.toFixed(1)}) rotate(${m.a.toFixed(0)}) scale(${(0.5 + pop * 0.5).toFixed(2)})`}
                   opacity={(pop * 0.85).toFixed(2)}>
                  <circle r={(2.4 + (1 - pop) * 5).toFixed(2)} fill="none" stroke={tone} strokeWidth=".5" opacity={((1 - pop) * 0.8).toFixed(2)} />
                  <circle r="3.1" fill={light ? '#FFFFFF' : '#0B0918'} opacity={light ? '.62' : '.45'} />
                  {m.kind
                    ? <circle r="2.5" fill="none" stroke={tone} strokeWidth=".8" />
                    : <rect x="-1.9" y="-1.9" width="3.8" height="3.8" rx=".7" fill="none" stroke={tone} strokeWidth=".8" />}
                  <circle r=".75" fill={tone} />
                  <path d="M0 -2.5v-2.2" stroke={tone} strokeWidth=".5" strokeLinecap="round" opacity=".7" />
                </g>
              )
            })}
          </>
        ) : (
          <>
            {/* the ghost eye */}
            <g opacity={light ? '.26' : '.18'}>
              <path d={EYE} fill={light ? '#FFFFFF' : 'none'} fillOpacity=".5" stroke={GHOST} strokeWidth=".9" />
              <circle cx="51" cy="64" r="33" fill="none" stroke={GHOST} strokeWidth=".7" />
              <circle cx="51" cy="64" r="14" fill="none" stroke={GHOST} strokeWidth=".7" />
              {geo.crypts.filter((_, i) => i % 4 === 0).map((c, i) => (
                <line key={i} x1={(51 + Math.cos(c.a) * c.inner).toFixed(2)} y1={(64 + Math.sin(c.a) * c.inner).toFixed(2)}
                      x2={(51 + Math.cos(c.a) * c.outer).toFixed(2)} y2={(64 + Math.sin(c.a) * c.outer).toFixed(2)}
                      stroke={GHOST} strokeWidth=".4" />
              ))}
            </g>

            {/* the eye, coming up behind the ring of light */}
            <g mask={`url(#bh-fill-${id})`}>
              <g clipPath={`url(#bh-eye-${id})`}>
                <path d={EYE} fill={light ? '#FBF8FF' : '#E9E4F4'} fillOpacity={light ? '1' : '.12'} />
                <g fill="none" strokeLinecap="round">
                  {geo.veins.map((d, i) => (
                    <g key={i}>
                      <path d={d} stroke={bad ? AMB : '#C56B63'} strokeWidth=".5" opacity={light ? '.5' : '.4'} />
                      <path d={d} stroke={bad ? AMB : '#E8A49C'} strokeWidth=".2" opacity=".5" transform="translate(.5 .6)" />
                    </g>
                  ))}
                </g>
                <path d={LID} fill="#1A1236" opacity={light ? '.16' : '.35'} />

                {/* the iris: three layers, each turning at its own rate */}
                <g transform={`translate(${gx.toFixed(2)} ${gy.toFixed(2)}) rotate(${((1 - Math.min(1, fill)) * 26).toFixed(2)} 51 64)`}>
                  <circle cx="51" cy="64" r="33" fill={bad ? '#40301A' : `url(#bh-iris-${id})`} />
                  <g transform={`rotate(${(t * 1.6).toFixed(2)} 51 64)`} strokeLinecap="round">
                    {geo.deep.map((c, i) => (
                      <line key={i} x1={(51 + Math.cos(c.a) * c.inner).toFixed(2)} y1={(64 + Math.sin(c.a) * c.inner).toFixed(2)}
                            x2={(51 + Math.cos(c.a) * c.outer).toFixed(2)} y2={(64 + Math.sin(c.a) * c.outer).toFixed(2)}
                            stroke={c.dark ? '#1B1138' : '#8D77D8'} strokeWidth={c.w.toFixed(2)} opacity={(c.o * 0.8).toFixed(2)} />
                    ))}
                  </g>
                  <g transform={`rotate(${(-t * 1.1).toFixed(2)} 51 64)`} strokeLinecap="round">
                    {geo.crypts.map((c, i) => (
                      <line key={i} x1={(51 + Math.cos(c.a) * c.inner).toFixed(2)} y1={(64 + Math.sin(c.a) * c.inner).toFixed(2)}
                            x2={(51 + Math.cos(c.a) * c.outer).toFixed(2)} y2={(64 + Math.sin(c.a) * c.outer).toFixed(2)}
                            stroke={c.dark ? '#241645' : '#D6C9F8'} strokeWidth={c.w.toFixed(2)} opacity={c.o.toFixed(2)} />
                    ))}
                  </g>
                  <g transform={`rotate(${(t * 0.6).toFixed(2)} 51 64)`} strokeLinecap="round">
                    {geo.fibres.map((c, i) => (
                      <line key={i} x1={(51 + Math.cos(c.a) * c.inner).toFixed(2)} y1={(64 + Math.sin(c.a) * c.inner).toFixed(2)}
                            x2={(51 + Math.cos(c.a) * c.outer).toFixed(2)} y2={(64 + Math.sin(c.a) * c.outer).toFixed(2)}
                            stroke="#F0E9FF" strokeWidth={c.w.toFixed(2)} opacity={(c.o * 0.5).toFixed(2)} />
                    ))}
                  </g>
                  <g fill="none" stroke="#E7E0FB" opacity=".2">
                    {geo.furrows.map((rr, i) => <circle key={i} cx="51" cy="64" r={rr.toFixed(1)} strokeWidth=".3" />)}
                  </g>
                  <circle cx="51" cy="64" r="16.4" fill="none" stroke="#F1ECFD" strokeWidth=".8" opacity=".4" />
                  <circle cx="51" cy="64" r={(pupil + 4).toFixed(2)} fill={`url(#bh-pupil-${id})`} opacity=".6" />
                  <circle cx="51" cy="64" r={pupil.toFixed(2)} fill="#05040C" />
                  <circle cx="51" cy="64" r="33" fill="none" stroke="#120C28" strokeWidth="2.4" opacity=".9" />
                  {/* the scanner's two points, reflected in the cornea */}
                  <circle cx="60" cy="53" r="1.5" fill={W} opacity=".95" />
                  <circle cx="64" cy="57" r=".9" fill={W} opacity=".7" />
                </g>

                {/* the dome of light over it */}
                <ellipse cx="45" cy="52" rx="42" ry="30" fill={`url(#bh-dome-${id})`} />
                {scanning && (
                  <path d={`M${(2 + drift * 84).toFixed(1)} 28q13 36 0 72q-9-36 0-72z`} fill={W} opacity=".16" />
                )}
              </g>

              <path d={EYE} fill="none" stroke={LINE} strokeWidth="1.2" opacity={light ? '.5' : '.55'} />
              <g stroke={LINE} strokeWidth=".9" strokeLinecap="round" opacity={light ? '.6' : '.5'}>
                <path d="M12 44l-6-6M28 32l-4-7M50 26v-8M72 32l4-7M88 44l6-6" />
              </g>
            </g>

            {/* the ring of light the read sends out */}
            {sweeping && (
              <g>
                <circle cx="51" cy="64" r={ringR.toFixed(2)} fill="none" stroke={light ? V : W}
                        strokeWidth="1.1" opacity={(0.5 + glint * 0.4).toFixed(2)} />
                <circle cx="51" cy="64" r={(ringR - 1.6).toFixed(2)} fill="none" stroke={W} strokeWidth=".45" opacity=".7" />
                <line x1="51" y1="64"
                      x2={(51 + Math.cos(-Math.PI / 2 + fill * Math.PI * 2) * ringR).toFixed(2)}
                      y2={(64 + Math.sin(-Math.PI / 2 + fill * Math.PI * 2) * ringR).toFixed(2)}
                      stroke={light ? V : W} strokeWidth=".8" opacity=".6" />
              </g>
            )}

            {/* it crystallises when it locks */}
            {bloom > 0.02 && [0, 1, 2].map((i) => (
              <circle key={i} cx="51" cy="64" r={(18 + i * 10 + (1 - bloom) * 24).toFixed(1)} fill="none"
                      stroke={tone} strokeWidth=".8" opacity={(bloom * 0.45).toFixed(2)} />
            ))}

            {/* the lid, when it blinks */}
            {blink > 0.01 && (
              <g>
                <path d={EYE} fill={light ? '#F6EFE6' : '#1B1533'} opacity={Math.min(1, blink * 1.2).toFixed(2)}
                      transform={`translate(0 ${(-64 + 64 * blink).toFixed(2)})`} />
                <path d={LID} fill={light ? '#E9DCCB' : '#221A42'} opacity={Math.min(1, blink).toFixed(2)} />
              </g>
            )}

            {/* the code on the rim, and written out below */}
            {Array.from({ length: 56 }).map((_, i) => {
              const a = (i / 56) * Math.PI * 2 - Math.PI / 2
              const on = i < Math.round(fill * 56)
              return (
                <rect key={i} x="-.85" y="-2" width="1.7" height="4" rx=".7"
                      transform={`translate(${(51 + Math.cos(a) * 41).toFixed(2)} ${(64 + Math.sin(a) * 41).toFixed(2)}) rotate(${(a * 57.3 + 90).toFixed(1)})`}
                      fill={on ? tone : light ? '#D7CFF0' : '#463C74'} opacity={on ? 0.95 : 0.3} />
              )
            })}
            <g transform="translate(8 118)">
              {geo.bits.map((tall, i) => {
                const on = i < Math.round(fill * geo.bits.length)
                return (
                  <rect key={i} x={(i * 2).toFixed(1)} y={tall ? -2.6 : -1.4} width="1.2" height={tall ? 5.2 : 2.8} rx=".5"
                        fill={on ? tone : light ? '#D7CFF0' : '#463C74'} opacity={on ? 0.9 : 0.3} />
                )
              })}
            </g>

            {ok && v.done > 0.1 && geo.marks.map((m, i) => {
              const pop = clamp((v.done - i * 0.04) * 3)
              return (
                <g key={i} transform={`translate(${m.x.toFixed(1)} ${m.y.toFixed(1)}) scale(${(0.5 + pop * 0.5).toFixed(2)})`}
                   opacity={(pop * 0.75).toFixed(2)}>
                  <circle r="2.2" fill="none" stroke={W} strokeWidth=".5" />
                  <circle r=".7" fill={W} />
                </g>
              )
            })}
          </>
        )}
      </svg>
    </div>
  )
}
