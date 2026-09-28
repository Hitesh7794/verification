import { useEffect, useRef } from 'react'
import {
  PEOPLE, ELDER, drawPerson, easeOutBack, clamp01, withAlpha, line,
  fillRRect, strokeRRect, fillCircle, strokeCircle, strokeRound,
} from './people.js'

// DeskScene — one verification desk, close up. The login's animation pane.
//
// The camera stands at the counter: one candidate at a time steps up, large;
// a short queue waits behind, smaller; the exam hall sits far back behind a
// haze of the page colour. At the counter the checks happen at full size —
// brackets close on the face, a thumb presses the reader on the counter,
// and when the print won't read (every third candidate, the product's rule)
// the iris scanner comes up to the eye. A tick, the candidate walks back
// into the hall, and the queue steps forward.
//
// Two canvases with a slot between them: the back layer (hall, queue, the
// candidate) and the front layer (the counter and the kit on it). Whatever
// is passed as children — the Verifier — stands between them, behind the
// counter. onPhase(name) reports what the desk is doing ('arrive', 'face',
// 'finger', 'fail', 'iris', 'done') so the agent can act it out.

const INK = '#211E33'
const ACC = '#5B3FA6'
const MARK = '#99641B'
const LINE = '#E3E1EA'
const FLOOR = '#EFEBF9'
const TINT = '#DDD5F2'
const MUTED = '#66627A'
const PAGE = '#F5F4F8'

// Candidates are students — no elderly look in the pool.
const YOUNG = PEOPLE.filter((p) => p.look !== ELDER)

const SHIRTS = [
  ['#DCE6FA', '#BFD2F7'], ['#C58226', '#A66E1E'], ['#575A5F', '#434449'], ['#7C6BC4', '#6556A8'],
  ['#1F4672', '#143153'], ['#9A86D6', '#8570C4'], ['#E8E1F7', '#D3C9EE'], ['#43307D', '#352566'],
  ['#F28C28', '#D97A1E'], ['#138808', '#0F6E07'],   // saffron and India green, from the tiranga
]
const CANDIDATES = Array.from({ length: 15 }, (_, i) => {
  const base = YOUNG[(i * 3) % YOUNG.length]
  const [shirt, shirtDk] = SHIRTS[(i * 7 + 3) % SHIRTS.length]
  return {
    ...base,
    shirt: i < 4 ? base.shirt : shirt, shirtDk: i < 4 ? base.shirtDk : shirtDk,
    glasses: i < 4 ? base.glasses : i % 3 !== 1,
    phase: base.phase + i * 0.73, blinkEvery: base.blinkEvery + (i % 4) * 0.4,
  }
})
const who = (i) => CANDIDATES[((i % 15) + 15) % 15]
const fails = (i) => ((i % 3) + 3) % 3 === 2

const easeInOut = (x) => { x = clamp01(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2 }
const easeOutCubic = (x) => 1 - Math.pow(1 - clamp01(x), 3)

// ── Timing ────────────────────────────────────────────────────────────
const ARRIVE = 1.2, CHECK = 2.3, LEAVE = 1.5
const slotLen = (i) => ARRIVE + CHECK * (fails(i) ? 3 : 2)
const CYCLE = slotLen(0) + slotLen(1) + slotLen(2)
function slotStart(i) {
  const j = ((i % 3) + 3) % 3
  return Math.floor(i / 3) * CYCLE + [0, slotLen(0), slotLen(0) + slotLen(1)][j]
}
function currentAt(t) {
  let c = Math.floor(t / CYCLE) * 3
  while (slotStart(c + 1) <= t) c++
  return c
}

// ── Layout (fractions of the pane) ────────────────────────────────────
function layout(w, h) {
  const k = Math.min(h * 0.0034, w * 0.0029)            // px per figure unit, candidate at the desk
  const counterTop = h * 0.78
  return {
    k, counterTop,
    desk: { x: w * 0.44, y: counterTop + 12 * k, s: 1 },
    q: [
      null,
      { x: w * 0.24, y: h * 0.74, s: 0.62 },
      { x: w * 0.15, y: h * 0.68, s: 0.50 },
      { x: w * 0.08, y: h * 0.63, s: 0.41 },
      { x: w * 0.00, y: h * 0.60, s: 0.34 },
    ],
    away: { x: w * 0.62, y: h * 0.52, s: 0.34 },          // back into the hall
    counterX: w * 0.30,
  }
}
const lerpP = (A, B, m) => ({ x: A.x + (B.x - A.x) * m, y: A.y + (B.y - A.y) * m, s: A.s + (B.s - A.s) * m })

// ── Props, in the candidate's 100-unit figure space ───────────────────
function brackets(ctx, a) {
  const ins = 16 - 12 * easeOutCubic(a / 0.3)
  const l = 25 - ins, r = 75 + ins, tp = 12 - ins, b = 64 + ins, len = 9
  for (const [x, sx] of [[l, 1], [r, -1]]) for (const [y, sy] of [[tp, 1], [b, -1]]) {
    line(ctx, ACC, x, y, x + sx * len, y, 2.2)
    line(ctx, ACC, x, y, x, y + sy * len, 2.2)
  }
  if (a > 0.3 && a < 0.9) {
    const f = ((a - 0.3) / 0.6 * 2) % 1
    line(ctx, withAlpha(ACC, 0.85), l + 3, tp + (b - tp) * f, r - 3, tp + (b - tp) * f, 1.8)
  }
}
function irisDevice(ctx, a) {
  const arrive = easeOutCubic(a / 0.25) * (a > 0.9 ? 1 - easeOutCubic((a - 0.9) / 0.1) : 1)
  const cx = 74 + (1 - arrive) * 60, cy = 47
  fillRRect(ctx, '#E8C39E', cx + 4, cy - 5, 18, 12, 5)             // the agent's hand
  fillRRect(ctx, '#FFFFFF', cx - 11, cy - 7, 24, 14, 4)
  strokeRRect(ctx, INK, cx - 11, cy - 7, 24, 14, 4, 1.8)
  strokeCircle(ctx, INK, cx - 11, cy, 4.6, 1.8)
  fillCircle(ctx, ACC, cx - 11, cy, 1.8)
  if (a > 0.28 && a < 0.88) {
    fillCircle(ctx, Math.sin(a * 60) > 0 ? ACC : withAlpha(INK, 0.3), cx + 8, cy - 4, 1.8)
    const f = ((a - 0.28) / 0.6 * 2) % 1
    line(ctx, ACC, 48, 40 + 15 * f, 70, 40 + 15 * f, 1.6)
  }
}
function badge(ctx, p, color, glyph) {
  if (p <= 0) return
  const s = easeOutBack(p), tx = 50, ty = -14
  ctx.save(); ctx.translate(tx, ty); ctx.scale(s, s); ctx.translate(-tx, -ty)
  fillCircle(ctx, '#FFFFFF', tx, ty, 10)
  strokeCircle(ctx, color, tx, ty, 10, 2.2)
  if (glyph === 'tick') {
    ctx.beginPath(); ctx.moveTo(tx - 4.5, ty); ctx.lineTo(tx - 1, ty + 3.6); ctx.lineTo(tx + 5, ty - 4)
    strokeRound(ctx, color, 2.4)
  } else {
    ctx.fillStyle = color
    ctx.font = '700 14px "Bricolage Grotesque", system-ui, sans-serif'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText('?', tx, ty + 0.5)
  }
  ctx.restore()
}

// ── Drawing ───────────────────────────────────────────────────────────
function inFig(ctx, k, P, fn) {
  const sk = k * P.s
  ctx.save(); ctx.translate(P.x - 50 * sk, P.y - 100 * sk); ctx.scale(sk, sk); fn(); ctx.restore()
}
function bust(ctx, k, c, P, t, { alpha = 1, bob = 0, clipBottom = true } = {}) {
  const sk = k * P.s
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.translate(P.x - 50 * sk, P.y - 100 * sk + bob * sk)
  ctx.scale(sk, sk)
  if (clipBottom) { ctx.beginPath(); ctx.rect(-80, -80, 260, 180); ctx.clip() }
  drawPerson(ctx, c, ((t + c.phase) % c.blinkEvery) < 0.14 ? 0.06 : 1)
  ctx.restore()
}

// What's happening at time t.
function sceneAt(t) {
  const c = currentAt(t)
  const u = t - slotStart(c)
  const fail = fails(c)
  let phase = 'arrive', a = 0
  if (u >= ARRIVE) {
    const k = Math.floor((u - ARRIVE) / CHECK)
    a = ((u - ARRIVE) % CHECK) / CHECK
    phase = ['face', 'finger', 'iris'][Math.min(k, 2)]
  }
  return { c, u, fail, phase, a }
}
export function phaseAt(t) {
  const s = sceneAt(t)
  if (s.phase === 'arrive') return 'arrive'
  if (s.phase === 'finger' && s.fail && s.a > 0.8) return 'fail'
  const last = s.fail ? 'iris' : 'finger'
  if (s.phase === last && s.a > 0.82) return 'done'
  return s.phase
}

function drawBack(ctx, w, h, t) {
  const L = layout(w, h)
  const { k } = L
  const s = sceneAt(t)

  // The hall, far back: two rows of candidates writing — then haze.
  const rows = [[0.33, 0.20, 16], [0.41, 0.25, 13]]
  rows.forEach(([ry, rs, n], r) => {
    for (let j = 0; j < n; j++) {
      const P = { x: w * ((j + 0.5 + (r % 2) * 0.5) / n), y: h * ry, s: rs }
      if ((j * 7 + r * 3) % 5 !== 0) bust(ctx, k, who(j * 3 + r * 5 + 7), P, t)
      inFig(ctx, k, P, () => {
        fillRRect(ctx, '#FFFFFF', -8, 78, 116, 24, 3)
        line(ctx, LINE, -8, 78.5, 108, 78.5, 1)
      })
    }
  })
  ctx.fillStyle = withAlpha(PAGE, 0.6)
  ctx.fillRect(0, 0, w, h)

  // The hall clock, on the back wall, showing the real time.
  const now = new Date()
  const cx = w * 0.5, cy = h * 0.15, R = Math.max(22, h * 0.055)
  fillCircle(ctx, '#FFFFFF', cx, cy, R)
  strokeCircle(ctx, withAlpha(INK, 0.55), cx, cy, R, Math.max(2, R * 0.08))
  for (let j = 0; j < 12; j++) {
    const an = (j / 12) * Math.PI * 2
    const r0 = R * (j % 3 === 0 ? 0.72 : 0.8)
    line(ctx, withAlpha(INK, 0.45), cx + Math.sin(an) * r0, cy - Math.cos(an) * r0,
         cx + Math.sin(an) * R * 0.88, cy - Math.cos(an) * R * 0.88, j % 3 === 0 ? 2 : 1.2)
  }
  const sec = now.getSeconds() + now.getMilliseconds() / 1000
  const mn = now.getMinutes() + sec / 60
  const hr = (now.getHours() % 12) + mn / 60
  const hand = (turn, len, wdt, col) => line(ctx, col, cx, cy,
    cx + Math.sin(turn * Math.PI * 2) * R * len, cy - Math.cos(turn * Math.PI * 2) * R * len, wdt)
  hand(hr / 12, 0.48, Math.max(2.5, R * 0.1), withAlpha(INK, 0.7))
  hand(mn / 60, 0.7, Math.max(2, R * 0.07), withAlpha(INK, 0.7))
  hand(sec / 60, 0.78, 1.2, ACC)
  fillCircle(ctx, ACC, cx, cy, Math.max(2, R * 0.07))

  // Floor.
  const floorTop = h * 0.43
  ctx.fillStyle = FLOOR
  ctx.fillRect(0, floorTop, w, h - floorTop)
  line(ctx, LINE, 0, floorTop + 0.5, w, floorTop + 0.5, 1)
  ctx.fillStyle = withAlpha(TINT, 0.35)
  ctx.fillRect(0, h * 0.66, w, h)

  // The one who just finished, walking back into the hall.
  if (s.u < LEAVE && s.c > 0) {
    const m = easeInOut(s.u / LEAVE)
    const P = lerpP(L.desk, L.away, m)
    const bob = -Math.abs(Math.sin(m * Math.PI * 6)) * 3
    bust(ctx, k, who(s.c - 1), P, t, { alpha: 1 - clamp01((m - 0.7) / 0.3), bob })
  }

  // The queue, back to front, stepping forward while the next one arrives.
  const m = easeInOut(s.u / ARRIVE)
  for (let n = 3; n >= 1; n--) {
    const P = lerpP(L.q[n + 1], L.q[n], m)
    const walking = m > 0 && m < 1
    const bob = walking ? -Math.abs(Math.sin(m * Math.PI * 5)) * 3 : 0
    bust(ctx, k, who(s.c + n), P, t, { alpha: n === 3 ? clamp01(m * 1.5) : 1, bob })
  }

  // The candidate at the desk.
  const P = s.phase === 'arrive' ? lerpP(L.q[1], L.desk, m) : L.desk
  const bob = s.phase === 'arrive' && m < 1 ? -Math.abs(Math.sin(m * Math.PI * 5)) * 3 : 0
  bust(ctx, k, who(s.c), P, t, { bob })
  if (s.phase !== 'arrive') {
    inFig(ctx, k, L.desk, () => {
      if (s.phase === 'face') { brackets(ctx, s.a); badge(ctx, clamp01((s.a - 0.84) / 0.12), ACC, 'tick') }
      if (s.phase === 'iris') { irisDevice(ctx, s.a); badge(ctx, clamp01((s.a - 0.84) / 0.12), ACC, 'tick') }
      if (s.phase === 'finger') {
        badge(ctx, clamp01((s.a - 0.84) / 0.12), s.fail ? MARK : ACC, s.fail ? '?' : 'tick')
      }
    })
  }
}

function drawFront(ctx, w, h, t) {
  const L = layout(w, h)
  const { k, counterTop } = L
  const s = sceneAt(t)
  const x0 = L.counterX

  // The counter: top, front panel to the floor, accent strip.
  const topH = 10
  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(x0, counterTop, w - x0 + 2, h - counterTop)
  line(ctx, LINE, x0, counterTop, x0, h, 1)
  fillRRect(ctx, '#FFFFFF', x0 - 10, counterTop - topH, w - x0 + 20, topH + 2, 4)
  line(ctx, LINE, x0 - 10, counterTop + 1, w + 10, counterTop + 1, 1)
  // The strip along the counter front: the tricolour.
  const sy = counterTop + (h - counterTop) * 0.62, sw = w - x0 + 2
  ctx.fillStyle = '#F28C28'; ctx.fillRect(x0, sy, sw, 3)
  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(x0, sy + 3, sw, 3)
  ctx.fillStyle = '#138808'; ctx.fillRect(x0, sy + 6, sw, 3)
  line(ctx, LINE, x0, sy + 3, w, sy + 3, 0.5)

  // What the desk is doing, printed on the counter front.
  const caption = s.phase === 'arrive' ? 'Next candidate'
    : s.phase === 'face' ? 'Checking face and liveness'
    : s.phase === 'finger' ? (s.fail && s.a > 0.8 ? 'The print didn\'t read' : 'Checking fingerprint')
    : 'Checking iris'
  const done = phaseAt(t) === 'done'
  ctx.fillStyle = done ? ACC : MUTED
  ctx.font = `600 ${Math.round(Math.max(14, Math.min(20, h * 0.021)))}px "Bricolage Grotesque", system-ui, sans-serif`
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
  ctx.fillText(done ? 'Verified' : caption, x0 + 22, counterTop + (h - counterTop) * 0.36)

  // The kit, in the desk candidate's figure space so it lines up.
  inFig(ctx, k, L.desk, () => {
    // The desk camera on its stand, on the counter between reader and agent,
    // turned toward the candidate.
    const live = s.phase === 'face' && s.a > 0.05 && s.a < 0.95
    line(ctx, INK, 130, 86, 130, 50, 2)
    fillRRect(ctx, '#FFFFFF', 118, 36, 24, 17, 3)
    strokeRRect(ctx, INK, 118, 36, 24, 17, 3, 1.8)
    strokeCircle(ctx, INK, 124, 44.5, 3.8, 1.6)
    fillCircle(ctx, live ? ACC : withAlpha(INK, 0.3), 138, 40, 1.5)
    fillRRect(ctx, INK, 124, 85, 12, 3, 1.5)

    // The reader on the counter, and the thumb when it's its turn.
    const reading = s.phase === 'finger' && s.a > 0.3 && s.a < 0.9
    const col = s.fail ? MARK : ACC
    fillRRect(ctx, '#FFFFFF', 80, 76, 28, 14, 3)
    strokeRRect(ctx, INK, 80, 76, 28, 14, 3, 1.6)
    fillRRect(ctx, reading ? withAlpha(col, 0.35) : withAlpha(INK, 0.1), 85, 79, 18, 8, 2)
    if (s.phase === 'finger') {
      const c = who(s.c)
      const down = easeOutCubic(s.a / 0.3) * (s.a > 0.9 ? 1 - clamp01((s.a - 0.9) / 0.1) : 1)
      const top = 52 + (73 - 52) * down
      line(ctx, c.skin, 94, top + 2, 84, top + 26, 8)            // forearm, from below the counter edge
      fillRRect(ctx, c.skin, 89.5, top, 9, 14, 4.5)
      if (reading) {
        const f = ((s.a - 0.3) / 0.6 * 2) % 1
        for (let j = 0; j < 3; j++) {
          const q = (f + j / 3) % 1
          strokeCircle(ctx, withAlpha(col, 1 - q), 94, 83, 2 + 8 * q, 1.3)
        }
      }
    }
  })
}

export default function DeskScene({ className, style, onPhase, children }) {
  const wrapRef = useRef(null)
  const backRef = useRef(null)
  const frontRef = useRef(null)
  const phaseCb = useRef(onPhase)
  phaseCb.current = onPhase

  useEffect(() => {
    const wrap = wrapRef.current
    const cvs = [backRef.current, frontRef.current]
    const ctxs = cvs.map((c) => c.getContext('2d'))
    let w = 0, h = 0, raf = 0, last = performance.now(), lastPhase = ''
    let t = 0.4
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')

    const draw = () => {
      ctxs.forEach((c) => c.clearRect(0, 0, w, h))
      if (!w || !h) return
      drawBack(ctxs[0], w, h, t)
      drawFront(ctxs[1], w, h, t)
      const p = phaseAt(t)
      if (p !== lastPhase) { lastPhase = p; phaseCb.current?.(p) }
    }
    const resize = () => {
      const r = wrap.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      w = r.width; h = r.height
      cvs.forEach((c, i) => {
        c.width = Math.round(w * dpr); c.height = Math.round(h * dpr)
        c.style.width = `${w}px`; c.style.height = `${h}px`
        ctxs[i].setTransform(dpr, 0, 0, dpr, 0, 0)
      })
      draw()
    }
    const frame = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000); last = now
      if (!document.hidden) { t += dt; draw() }
      raf = requestAnimationFrame(frame)
    }
    const start = () => {
      cancelAnimationFrame(raf)
      if (reduce?.matches) { t = ARRIVE + CHECK * 1.5; draw(); return }
      last = performance.now(); raf = requestAnimationFrame(frame)
    }
    const ro = new ResizeObserver(resize)
    ro.observe(wrap)
    resize(); start()
    reduce?.addEventListener?.('change', start)
    document.fonts?.ready?.then(draw)
    return () => { cancelAnimationFrame(raf); ro.disconnect(); reduce?.removeEventListener?.('change', start) }
  }, [])

  const layer = { position: 'absolute', inset: 0, display: 'block', pointerEvents: 'none' }
  return (
    <div ref={wrapRef} className={className} style={{ position: 'relative', overflow: 'hidden', ...style }}>
      <canvas ref={backRef} style={layer} aria-hidden="true" />
      {children}
      <canvas ref={frontRef} style={layer} aria-hidden="true" />
    </div>
  )
}
