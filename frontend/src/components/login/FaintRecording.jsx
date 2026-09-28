import { useEffect, useRef } from 'react'
import {
  PEOPLE, drawPerson, easeOutBack, clamp01, withAlpha,
  line, fillRRect, strokeRRect, fillCircle, strokeCircle, strokeRound,
} from './people.js'

// FaintRecording — the checks, playing faintly behind the page.
// A faithful <canvas> port of the Android ui/welcome/FaintRecording.kt
// (drawPerson / PEOPLE / easeOutBack from ui/welcome/Crowd.kt live in people.js).
//
// Three stations — iris, fingerprint, face — drawn in ink and the accent,
// then faded as ONE layer (CSS opacity on the wrapper, like graphicsLayer),
// so overlapping lines never add up. At each station a student slides in,
// is checked, gets the tick, slides out, and the next takes the seat; the
// stations run a third of a cycle apart. REC with a running timecode sits
// in the corner, and the frame has its corner brackets. dp → CSS px 1:1.

const CYCLE = 7.5
const CLOCK_SPAN = 600 // the Compose clock runs 0…600 s, then repeats

// Scheme (ACTIVE = FlatViolet).
const INK = '#211E33'
const ACC = '#5B3FA6'

/** A station: kind (0 iris, 1 fingerprint, 2 face), x and the table line's y, as fractions. */
export const COVER_STATIONS = [
  { kind: 0, x: 0.24, y: 0.30 },
  { kind: 1, x: 0.76, y: 0.56 },
  { kind: 2, x: 0.26, y: 0.82 },
]
/** The sign-in: a row across the free width under the panel. */
export const LOGIN_STATIONS = [
  { kind: 0, x: 0.15, y: 0.80 },
  { kind: 1, x: 0.41, y: 0.80 },
  { kind: 2, x: 0.66, y: 0.80 },
]

// ── Helpers ───────────────────────────────────────────────────────────
const easeOutCubic = (x) => 1 - Math.pow(1 - clamp01(x), 3)
const easeInCubic = (x) => Math.pow(clamp01(x), 3)

// ── The checks (FaintRecording.kt) ────────────────────────────────────

/** The iris scanner comes in from the right to the near eye; its LED blinks; a band reads the eye. */
function iris(ctx, a, ink, acc, skin) {
  const arrive = easeOutCubic(a / 0.25)
  const dx = (1 - arrive) * 46
  const cx = 74 + dx, cy = 48
  // The operator's hand holding it, then the device: a body with a lens at its left end.
  fillRRect(ctx, skin, cx + 4, cy - 5, 16, 12, 5)
  strokeRRect(ctx, ink, cx - 11, cy - 7, 24, 14, 4, 1.8)
  strokeCircle(ctx, ink, cx - 11, cy, 4.6, 1.8)
  fillCircle(ctx, ink, cx - 11, cy, 1.6)
  if (a > 0.28 && a < 0.86) {
    const on = Math.sin(a * 60) > 0
    fillCircle(ctx, on ? acc : withAlpha(ink, 0.35), cx + 8, cy - 4, 1.8)
    // The read: a band sweeping the eye, twice.
    const f = ((a - 0.28) / 0.58 * 2) % 1
    const y = 41 + 15 * f
    line(ctx, acc, 48, y, 70, y, 1.6)
  }
}

/** The reader on the table; the thumb comes down onto its pad; ridges pulse while it reads. */
function finger(ctx, a, ink, acc, skin) {
  const padX = 90, padY = 86
  strokeRRect(ctx, ink, 78, 80, 26, 18, 3, 1.8)
  fillRRect(ctx, a > 0.3 && a < 0.86 ? withAlpha(acc, 0.35) : withAlpha(ink, 0.12), 83, 83, 14, 10, 2)
  // The thumb, descending.
  const down = easeOutCubic(a / 0.3)
  const top = 58 + (76 - 58) * down
  fillRRect(ctx, skin, padX - 4.5, top, 9, 14, 4.5)
  line(ctx, skin, padX, top + 2, padX + 14, top - 10, 7) // the arm, back to the shoulder
  if (a > 0.3 && a < 0.86) {
    const f = ((a - 0.3) / 0.56 * 2) % 1
    for (let i = 0; i < 3; i++) {
      const q = (f + i / 3) % 1
      strokeCircle(ctx, withAlpha(acc, 1 - q), padX, padY + 2, 2 + 7 * q, 1.2)
    }
  }
}

/** Corner brackets tighten round the face; a line reads it top to bottom. */
function face(ctx, a, ink, acc) {
  const ins = 14 - 10 * easeOutCubic(a / 0.3)
  const l = 25 - ins, r = 75 + ins, tp = 14 - ins, b = 62 + ins
  const len = 9
  for (const [x, sx] of [[l, 1], [r, -1]]) {
    for (const [y, sy] of [[tp, 1], [b, -1]]) {
      line(ctx, ink, x, y, x + sx * len, y, 1.8)
      line(ctx, ink, x, y, x, y + sy * len, 1.8)
    }
  }
  if (a > 0.3 && a < 0.86) {
    const f = ((a - 0.3) / 0.56 * 2) % 1
    const y = tp + (b - tp) * f
    line(ctx, acc, l + 3, y, r - 3, y, 1.6)
  }
}

function drawScene(ctx, w, h, t, stations) {
  const ink = INK
  const acc = ACC
  // The frame's corner brackets.
  const inset = 14, len = 22, sw = 1.5
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const x = sx < 0 ? inset : w - inset
    const y = sy < 0 ? inset : h - inset
    line(ctx, ink, x, y, x - sx * len, y, sw)
    line(ctx, ink, x, y, x, y - sy * len, sw)
  }
  const k = (h * 0.115) / 100 // a bust is ~11 % of the height
  for (const st of stations) {
    const kind = st.kind
    const phase = t / CYCLE + kind / 3
    const u = phase - Math.floor(phase)
    const cycle = Math.floor(phase)
    const person = PEOPLE[(cycle * 2 + kind * 3) % PEOPLE.length]
    const cx = w * st.x
    const base = h * st.y
    // The table.
    line(ctx, withAlpha(ink, 0.7), cx - 80 * k, base, cx + 80 * k, base, 1.5)
    if (u >= 0.92) continue
    let slide = 0
    if (u < 0.14) slide = (1 - easeOutCubic(u / 0.14)) * w * 0.22
    else if (u > 0.80) slide = -easeInCubic((u - 0.80) / 0.12) * w * 0.30
    const a = clamp01((u - 0.16) / 0.50) // the check itself
    const tick = clamp01((u - 0.68) / 0.10)
    const blink = ((t + person.phase) % person.blinkEvery) < 0.14

    ctx.save()
    ctx.translate(cx - 50 * k + slide, base - 100 * k)
    ctx.scale(k, k)
    ctx.save()
    ctx.beginPath()
    ctx.rect(-60, -40, 220, 140) // clipRect(-60, -40, 160, 100)
    ctx.clip()
    drawPerson(ctx, person, blink ? 0.06 : 1)
    ctx.restore()
    if (kind === 0) iris(ctx, a, ink, acc, person.skin)
    else if (kind === 1) finger(ctx, a, ink, acc, person.skin)
    else face(ctx, a, ink, acc)
    if (tick > 0) {
      const s = easeOutBack(tick)
      const tx = 50, ty = -14
      ctx.save()
      ctx.translate(tx, ty)
      ctx.scale(s, s)
      ctx.translate(-tx, -ty)
      strokeCircle(ctx, acc, tx, ty, 9, 2)
      ctx.beginPath()
      ctx.moveTo(tx - 4, ty)
      ctx.lineTo(tx - 1, ty + 3.2)
      ctx.lineTo(tx + 4.5, ty - 3.5)
      strokeRound(ctx, acc, 2.2)
      ctx.restore()
    }
    ctx.restore()
  }
}

const pad2 = (n) => String(n).padStart(2, '0')
function timecode(t) {
  const secs = Math.trunc(t)
  return `${pad2((9 + Math.trunc(secs / 3600)) % 24)}:${pad2(Math.trunc(secs / 60) % 60)}:${pad2(secs % 60)}`
}

// A static frame for reduced motion (not in the source): chosen so all three
// students are seated — iris just arrived, fingerprint mid-read, face ticked.
const STATIC_T = 1.025

export default function FaintRecording({ stations = COVER_STATIONS, alpha = 0.14, className, style }) {
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const dotRef = useRef(null)
  const labelRef = useRef(null)
  const stationsRef = useRef(stations)
  const redrawRef = useRef(null)
  stationsRef.current = stations

  // Redraw the current frame when stations change (matters when paused / reduced motion).
  useEffect(() => { if (redrawRef.current) redrawRef.current() }, [stations])

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return undefined
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined

    const mq = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null
    let reduced = !!(mq && mq.matches)
    let cssW = 0, cssH = 0
    let clock = 0 // seconds of visible running time, like the Compose frame clock
    let last = null
    let raf = 0
    let lastLabel = ''

    function draw() {
      const t = reduced ? STATIC_T : clock % CLOCK_SPAN
      const dpr = window.devicePixelRatio || 1
      const bw = Math.max(1, Math.round(cssW * dpr))
      const bh = Math.max(1, Math.round(cssH * dpr))
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw
        canvas.height = bh
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      if (cssW > 0 && cssH > 0) {
        ctx.setTransform(bw / cssW, 0, 0, bh / cssH, 0, 0)
        drawScene(ctx, cssW, cssH, t, stationsRef.current)
      }
      const label = `REC  ${timecode(t)}`
      if (label !== lastLabel && labelRef.current) {
        labelRef.current.textContent = label
        lastLabel = label
      }
      if (dotRef.current) dotRef.current.style.opacity = (t % 1.2) < 0.7 ? '1' : '0.25'
    }
    redrawRef.current = draw

    function frame(now) {
      raf = 0
      if (last != null) clock += Math.min(0.1, Math.max(0, (now - last) / 1000))
      last = now
      draw()
      schedule()
    }
    function schedule() {
      if (raf || reduced || document.hidden) return
      raf = requestAnimationFrame(frame)
    }
    function stop() {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      last = null
    }

    const ro = new ResizeObserver((entries) => {
      const r = entries[0] && entries[0].contentRect
      if (!r) return
      cssW = r.width
      cssH = r.height
      draw()
    })
    ro.observe(wrap)
    const rect = wrap.getBoundingClientRect()
    cssW = rect.width
    cssH = rect.height
    draw()
    schedule()

    const onVisibility = () => { if (document.hidden) stop(); else schedule() }
    document.addEventListener('visibilitychange', onVisibility)
    const onMotion = () => {
      reduced = !!(mq && mq.matches)
      if (reduced) stop()
      draw()
      schedule()
    }
    if (mq) {
      if (mq.addEventListener) mq.addEventListener('change', onMotion)
      else if (mq.addListener) mq.addListener(onMotion)
    }

    return () => {
      stop()
      ro.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      if (mq) {
        if (mq.removeEventListener) mq.removeEventListener('change', onMotion)
        else if (mq.removeListener) mq.removeListener(onMotion)
      }
      redrawRef.current = null
    }
  }, [])

  return (
    <div
      ref={wrapRef}
      className={className}
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        pointerEvents: 'none',
        ...style,
        opacity: alpha, // the whole layer fades as one, like graphicsLayer { alpha }
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
      />
      <div style={{ position: 'absolute', top: 20, left: 24, display: 'flex', alignItems: 'center' }}>
        <span
          ref={dotRef}
          style={{ width: 9, height: 9, borderRadius: '50%', background: ACC, flex: 'none' }}
        />
        <span style={{ width: 8, flex: 'none' }} />
        <span
          ref={labelRef}
          style={{
            color: INK,
            fontFamily: 'var(--font-fv)',
            fontVariationSettings: '"opsz" 14',
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: 1.2,
            whiteSpace: 'pre',
          }}
        >
          {'REC  09:00:00'}
        </span>
      </div>
    </div>
  )
}
