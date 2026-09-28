import { useEffect, useRef } from 'react'
import {
  makeCast, drawPerson, easeOutBack, clamp01, withAlpha, line,
  fillRRect, strokeRRect, fillCircle, strokeCircle, strokeRound,
} from './people.js'

// ExamHall — the landing page's living scene. Exam day, drawn in the
// companion's paper (people.js, from the app's Crowd.kt): candidates step
// out of the door at the back of the hall and walk forward — growing as
// they come — into the queue; at the counters they face the camera, press
// a thumb on the reader and, when a print won't read, look into the iris
// scanner. Each check ends in a tick; verified candidates walk back into
// the hall and take a seat, which fills row by row and clears as the next
// wave arrives.
//
// Depth, flat: far rows of candidates already writing sit behind a haze of
// the page colour; the floor's aisle lines run to the back; everything in
// the hall is drawn back to front so desks and counters occlude properly;
// an invigilator crosses close to us, cropped by the edge; and every layer
// drifts with the pointer and the scroll by its depth.
//
// It runs as a pipeline: a candidate enters every STEP seconds and every
// station holds one person at a time. Every third candidate's print fails
// → iris, exactly the product's fallback rule.
//
// Size: fills its CSS box. Designed for ~3.2:1 on desktop; below 720px wide
// the hall falls away and the three counters take the width.

const STEP = 2.6            // seconds per pipeline step
const SEATS = 12            // 3 rows × 4 desks
const INK = '#211E33'
const ACC = '#5B3FA6'
const MARK = '#99641B'
const LINE = '#E3E1EA'
const FLOOR = '#EFEBF9'
const TINT = '#DDD5F2'
const MUTED = '#66627A'
const PAGE = '#F5F4F8'

// Fifteen candidates: the five looks, re-dressed so the queue never repeats
// visibly. Clothes stay in the Crowd's own register.
// Candidates are students, and every face is different: far rows use cast
// 0…27, the pipeline 28…71 (makeCast in people.js).
const CAST = makeCast(72)
const farWho = (j) => CAST[((j % 28) + 28) % 28]
const INVIGILATOR = { ...CAST[9], shirt: INK, shirtDk: '#15131F', glasses: true, phase: 0.2, blinkEvery: 4.8 }
const who = (i) => CAST[28 + (((i % 44) + 44) % 44)]
const failsPrint = (i) => ((i % 3) + 3) % 3 === 2

const easeInOut = (x) => { x = clamp01(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2 }
const easeOutCubic = (x) => 1 - Math.pow(1 - clamp01(x), 3)

// ── Layout ────────────────────────────────────────────────────────────
// Every place is {x, y, s}: y is where the bust's shoulders stand, s its
// scale — further back is higher and smaller.
function layout(w, h, opt = {}) {
  const { insetL = 0, scale = 1 } = opt
  const wide = w >= 720
  const k = scale * Math.min(h * 0.30, w * (wide ? 0.07 : 0.16)) / 100
  const lane = h * 0.9
  const X = (x) => w * (insetL + (1 - insetL) * x)   // insetL keeps the left edge clear
  const P = (x, y, s) => ({ x: X(x), y, s })
  const place = wide
    ? {
        off:    P(0.035, h * 0.40, 0.42),   // the door at the back of the hall
        q2:     P(0.05, lane - h * 0.05, 0.86),
        q1:     P(0.12, lane - h * 0.02, 0.94),
        face:   P(0.23, lane, 1),
        finger: P(0.38, lane, 1),
        iris:   P(0.53, lane, 1),
        exit:   P(0.63, lane - h * 0.03, 0.95),
      }
    : {
        off: P(-0.25, lane, 1), q2: P(-0.12, lane, 1), q1: P(-0.02, lane, 1),
        face: P(0.18, lane, 1), finger: P(0.52, lane, 1), iris: P(0.86, lane, 1), exit: P(1.3, lane, 1),
      }
  const seats = []
  if (wide) {
    const rows = [[0.46, 0.56], [0.58, 0.64], [0.70, 0.72]]
    rows.forEach(([ry, rs], r) => {
      for (let c = 0; c < 4; c++) {
        const x0 = 0.71 - r * 0.012, x1 = 0.955 + r * 0.012
        seats.push({ x: X(x0 + (x1 - x0) * (c / 3)), y: h * ry, s: rs, row: r })
      }
    })
  }
  return { wide, k, lane, place, seats }
}

const lerpP = (A, B, m) => ({ x: A.x + (B.x - A.x) * m, y: A.y + (B.y - A.y) * m, s: A.s + (B.s - A.s) * m })

// Where candidate i is, and what they're doing, at pipeline time t.
function stateOf(i, t, L) {
  const rel = t - i * STEP
  if (rel < 0) return null
  const step = Math.floor(rel / STEP)
  const u = rel / STEP - step
  const fail = failsPrint(i)
  const path = ['off', 'q2', 'q1', 'face', 'finger', fail ? 'iris' : 'exit']
  if (step <= 5) {
    const from = L.place[path[step - 1] || 'off']
    const to = L.place[path[step]]
    const walkSpan = step === 1 ? 0.9 : 0.32
    const m = easeInOut(u / walkSpan)
    const pos = lerpP(from, to, m)
    return {
      i, ...pos, at: path[step], u, fail,
      walking: step > 0 && m < 1,
      act: clamp01((u - 0.34) / 0.52), done: clamp01((u - 0.86) / 0.1),
      fade: step === 0 ? clamp01(u / 0.4) : undefined,
    }
  }
  if (!L.wide) {
    if (step > 6) return null
    const A = L.place[path[5]]
    return { i, x: A.x + (L.place.exit.x + 200 - A.x) * easeInOut(u), y: A.y, s: 1, at: 'leaving', walking: true, u, fail }
  }
  const seat = L.seats[((i % SEATS) + SEATS) % SEATS]
  if (step === 6) {
    const m = easeInOut(u / 0.6)
    return { i, ...lerpP(L.place[path[5]], seat, m), at: m >= 1 ? 'seat' : 'leaving', walking: m < 1, u, fail, seat }
  }
  if (step < 6 + SEATS) return { i, x: seat.x, y: seat.y, s: seat.s, at: 'seat', walking: false, u, fail, seat }
  if (step === 6 + SEATS && u < 0.45) {
    return { i, x: seat.x, y: seat.y, s: seat.s, at: 'seat', walking: false, u, fail, seat, fade: 1 - u / 0.45 }
  }
  return null
}

// ── Station props (FaintRecording.kt's checks, enlarged, in full colour) ──
function faceCheck(ctx, a) {
  // A bubble asks for a blink; the camera flashes. No lines on the face.
  const bs = easeOutBack(clamp01((a - 0.05) / 0.12)) * (1 - clamp01((a - 0.55) / 0.08))
  if (bs > 0.01) {
    ctx.save(); ctx.translate(84, 6); ctx.scale(bs, bs)
    fillCircle(ctx, '#FFFFFF', 0, 0, 9.5)
    ctx.beginPath(); ctx.moveTo(-6, 6); ctx.lineTo(-10, 11); ctx.lineTo(-2, 8); ctx.fillStyle = '#FFFFFF'; ctx.fill()
    const shut = (a > 0.3 && a < 0.35) || (a > 0.43 && a < 0.48)
    if (shut) { ctx.beginPath(); ctx.moveTo(-5, 0.5); ctx.quadraticCurveTo(0, 3.5, 5, 0.5); strokeRound(ctx, ACC, 1.3) }
    else { fillCircle(ctx, ACC, 0, 0, 2.6); fillCircle(ctx, INK, 0, 0, 1.1) }
    ctx.restore()
  }
  if (a > 0.6 && a < 0.74) {
    const f = 1 - (a - 0.6) / 0.14
    fillRRect(ctx, `rgba(255,255,255,${(0.85 * f * f).toFixed(3)})`, 16, 4, 68, 66, 24)
  }
}
// Face mapping, in place of a scan line: landmark points land one by one on
// brows, eyes, nose, mouth and jaw; faint lines join them into a mesh; the
// mesh gives one soft pulse when the face is confirmed.
const LANDMARKS = [
  [36, 39], [44, 38.3], [56, 38.3], [64, 39],            // brows
  [33.5, 48.5], [46.5, 48.5], [53.5, 48.5], [66.5, 48.5], // eye corners
  [50, 49], [50, 54.2],                                   // nose bridge, tip
  [43.5, 58], [50, 60.5], [56.5, 58],                     // mouth
  [30, 53], [36, 60.5], [50, 65], [64, 60.5], [70, 53],   // jaw
]
const MESH_EDGES = [
  [0, 1], [2, 3], [1, 8], [2, 8], [4, 5], [6, 7], [5, 8], [6, 8], [8, 9], [9, 10], [9, 12],
  [10, 11], [11, 12], [13, 14], [14, 15], [15, 16], [16, 17], [4, 13], [7, 17], [10, 14], [12, 16], [11, 15],
]
function faceMesh(ctx, a, color, scale = 1) {
  const n = LANDMARKS.length
  const land = (i) => clamp01((a - 0.22 - i * 0.022) / 0.08)          // each point's arrival
  const pulse = a > 0.72 ? Math.sin(clamp01((a - 0.72) / 0.2) * Math.PI) : 0
  const fade = a > 0.9 ? 1 - clamp01((a - 0.9) / 0.1) : 1
  ctx.save()
  for (const [i, j] of MESH_EDGES) {
    const f = Math.min(land(i), land(j))
    if (f <= 0) continue
    const [x0, y0] = LANDMARKS[i], [x1, y1] = LANDMARKS[j]
    ctx.globalAlpha = (0.28 + 0.4 * pulse) * f * fade
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f)
    ctx.lineWidth = 0.7 * scale; ctx.strokeStyle = color; ctx.lineCap = 'round'; ctx.stroke()
  }
  for (let i = 0; i < n; i++) {
    const f = land(i)
    if (f <= 0) continue
    const [x, y] = LANDMARKS[i]
    ctx.globalAlpha = fade
    const r = (0.85 + 0.45 * pulse) * scale * (f < 1 ? 0.6 + 0.8 * easeOutBack(f) : 1)
    ctx.beginPath(); ctx.arc(x, y, r + 0.45 * scale, 0, Math.PI * 2); ctx.fillStyle = '#FFFFFF'; ctx.fill()
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill()
  }
  ctx.restore()
}

function reader(ctx, lit, color) {
  fillRRect(ctx, '#FFFFFF', 78, 80, 26, 16, 3)
  strokeRRect(ctx, INK, 78, 80, 26, 16, 3, 1.6)
  fillRRect(ctx, lit ? withAlpha(color, 0.35) : withAlpha(INK, 0.1), 83, 83, 14, 9, 2)
}
function fingerCheck(ctx, a, skin, fail) {
  const padX = 91, padY = 86
  const reading = a > 0.3 && a < 0.92
  const col = fail ? MARK : ACC
  reader(ctx, reading, col)
  const down = easeOutCubic(a / 0.3) * (a > 0.92 ? 1 - clamp01((a - 0.92) / 0.08) : 1)
  const top = 56 + (76 - 56) * down
  line(ctx, skin, padX, top + 2, padX + 15, top - 12, 7)
  fillRRect(ctx, skin, padX - 4.5, top, 9, 14, 4.5)
  if (reading) {
    const f = ((a - 0.3) / 0.62 * 2) % 1
    for (let j = 0; j < 3; j++) {
      const q = (f + j / 3) % 1
      strokeCircle(ctx, withAlpha(col, 1 - q), padX, padY + 1, 2 + 7 * q, 1.3)
    }
  }
}
function irisCheck(ctx, a, operatorSkin) {
  const arrive = easeOutCubic(a / 0.25)
  const cx = 74 + (1 - arrive) * 46, cy = 48
  fillRRect(ctx, operatorSkin, cx + 4, cy - 5, 16, 12, 5)
  fillRRect(ctx, '#FFFFFF', cx - 11, cy - 7, 24, 14, 4)
  strokeRRect(ctx, INK, cx - 11, cy - 7, 24, 14, 4, 1.8)
  strokeCircle(ctx, INK, cx - 11, cy, 4.6, 1.8)
  fillCircle(ctx, ACC, cx - 11, cy, 1.8)
  if (a > 0.28 && a < 0.9) {
    fillCircle(ctx, Math.sin(a * 60) > 0 ? ACC : withAlpha(INK, 0.3), cx + 8, cy - 4, 1.8)
    const f = ((a - 0.28) / 0.62 * 2) % 1
    strokeCircle(ctx, withAlpha(ACC, 0.9 * (1 - f)), 59.5, 48.5, 4 + 9 * (1 - f), 1.4)
  }
}
function badge(ctx, p, color, draw) {
  if (p <= 0) return
  const s = easeOutBack(p), tx = 50, ty = -12
  ctx.save(); ctx.translate(tx, ty); ctx.scale(s, s); ctx.translate(-tx, -ty)
  fillCircle(ctx, '#FFFFFF', tx, ty, 9)
  strokeCircle(ctx, color, tx, ty, 9, 2)
  draw(tx, ty)
  ctx.restore()
}
const tick = (ctx, p) => badge(ctx, p, ACC, (tx, ty) => {
  ctx.beginPath(); ctx.moveTo(tx - 4, ty); ctx.lineTo(tx - 1, ty + 3.2); ctx.lineTo(tx + 4.5, ty - 3.5)
  strokeRound(ctx, ACC, 2.2)
})
const query = (ctx, p) => badge(ctx, p, MARK, (tx, ty) => {
  ctx.fillStyle = MARK
  ctx.font = '700 13px "Bricolage Grotesque", system-ui, sans-serif'
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillText('?', tx, ty + 0.5)
})
// A verification counter: a white top the kit sits on, a front panel down
// to the floor, and a thin accent strip — so it stands, not floats.
function counter(ctx) {
  fillRRect(ctx, '#FFFFFF', -16, 118, 132, 6, 3)          // foot, on the floor
  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(-10, 84, 120, 36)                           // front panel
  line(ctx, LINE, -10, 84, -10, 120, 1)
  line(ctx, LINE, 110, 84, 110, 120, 1)
  ctx.fillStyle = '#F28C28'; ctx.fillRect(-10, 106, 120, 2)   // tricolour strip
  ctx.fillStyle = '#138808'; ctx.fillRect(-10, 110, 120, 2)
  fillRRect(ctx, '#FFFFFF', -18, 78, 136, 8, 3)            // counter top, overhanging
  line(ctx, LINE, -18, 86, 118, 86, 1)
}
function camera(ctx, live) {
  line(ctx, INK, 106, 80, 106, 44, 2)
  fillRRect(ctx, '#FFFFFF', 96, 30, 22, 16, 3)
  strokeRRect(ctx, INK, 96, 30, 22, 16, 3, 1.8)
  strokeCircle(ctx, INK, 102, 38, 3.6, 1.6)
  fillCircle(ctx, live ? ACC : withAlpha(INK, 0.3), 113, 34, 1.5)
}
function examDesk(ctx, occupied) {
  fillRRect(ctx, '#FFFFFF', -8, 78, 116, 24, 3)
  line(ctx, LINE, -8, 78.5, 108, 78.5, 1)
  if (occupied) {
    fillRRect(ctx, TINT, 30, 82, 40, 10, 1.5)
    line(ctx, withAlpha(INK, 0.35), 34, 85.5, 60, 85.5, 1)
  }
}

// ── Scene ─────────────────────────────────────────────────────────────
const FAR_ROWS = [[0.20, 0.30, 15], [0.29, 0.36, 13]]   // [y, scale, desks across]

function drawHall(ctx, w, h, t, par, clearLeft = 0, opt = {}) {
  const L = layout(w, h, opt)
  const { k } = L
  const shift = (depth) => par.x * depth * 26
  const blinkOf = (c) => (((t + c.phase) % c.blinkEvery) < 0.14 ? 0.06 : 1)
  const inFigure = (x, y, s, fn) => {
    const sk = k * s
    ctx.save(); ctx.translate(x - 50 * sk, y - 100 * sk); ctx.scale(sk, sk); fn(); ctx.restore()
  }
  const drawBust = (c, x, y, s, alpha = 1, bob = 0, lean = 0, clip = true) => {
    const sk = k * s
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.translate(x, y)
    if (lean) ctx.rotate((lean * Math.PI) / 180)
    ctx.translate(-50 * sk, -100 * sk + bob * sk)
    ctx.scale(sk, sk)
    if (clip) { ctx.beginPath(); ctx.rect(-60, -60, 240, 160); ctx.clip() }
    drawPerson(ctx, c, blinkOf(c))
    ctx.restore()
  }

  // Far layer: the back of the hall, rows already writing — then haze.
  if (L.wide) {
    ctx.save(); ctx.translate(shift(0.15), par.y * 0.15)
    FAR_ROWS.forEach(([ry, rs, n], r) => {
      for (let c = 0; c < n; c++) {
        const x = w * ((c + 0.5 + (r % 2) * 0.5) / n)
        if (x < clearLeft * w) continue          // keep the copy's side of the wall quiet
        if ((c * 7 + r * 3) % 5 !== 0) drawBust(farWho(r * 15 + c), x, h * ry, rs)
        inFigure(x, h * ry, rs, () => examDesk(ctx, false))
      }
    })
    ctx.restore()
    ctx.fillStyle = withAlpha(PAGE, 0.62)
    ctx.fillRect(0, 0, w, h)
  }

  // Floor, with aisle lines running to the back.
  const floorTop = L.wide ? h * 0.33 : L.lane - 22 * k
  ctx.save(); ctx.translate(shift(0.35), 0)
  ctx.fillStyle = FLOOR
  ctx.fillRect(-60, floorTop, w + 120, h - floorTop)
  line(ctx, LINE, -60, floorTop + 0.5, w + 60, floorTop + 0.5, 1)
  if (L.wide) {
    // Depth bands: the floor steps one shade lighter toward the back,
    // like rows of tiles receding — flat fills, no gradient.
    const bands = [0.46, 0.58, 0.70]
    bands.forEach((by, j) => {
      ctx.fillStyle = withAlpha(TINT, 0.12 + j * 0.08)
      ctx.fillRect(-60, h * by - 6, w + 120, h * 0.12)
    })
    ctx.fillStyle = withAlpha(TINT, 0.5)
    ctx.fillRect(-60, L.lane - 24 * k, w + 120, h)
    line(ctx, TINT, -60, L.lane - 24 * k, w + 60, L.lane - 24 * k, 1)
  }
  ctx.restore()

  // Everyone and everything in the hall, back to front.
  const first = Math.floor(t / STEP) - (6 + SEATS + 1)
  const last = Math.floor(t / STEP)
  const people = []
  for (let i = first; i <= last; i++) { const s = stateOf(i, t, L); if (s) people.push(s) }

  const items = []
  for (const seat of L.seats) {
    const sitter = people.find((p) => p.at === 'seat' && p.seat === seat)
    if (sitter) items.push({ y: seat.y, s: seat.s, draw: () => drawBust(who(sitter.i), seat.x, seat.y, seat.s, sitter.fade ?? 1) })
    items.push({ y: seat.y + 0.5, s: seat.s, draw: () => inFigure(seat.x, seat.y, seat.s, () => examDesk(ctx, !!sitter && !sitter.fade)) })
  }
  const stationKeys = ['face', 'finger', 'iris']
  for (const p of people.filter((q) => q.at !== 'seat')) {
    const c = who(p.i)
    const at = !p.walking && stationKeys.includes(p.at) ? p.at : null
    const bob = p.walking ? -Math.abs(Math.sin(p.u * Math.PI * (p.at === 'q2' ? 12 : 7))) * 3.2 : 0
    items.push({ y: p.y, s: p.s, draw: () => {
      drawBust(c, p.x, p.y, p.s, p.fade ?? 1, bob, p.walking ? 2.5 : 0)
      if (!at) return
      inFigure(p.x, p.y, p.s, () => {
        if (at === 'face') { faceCheck(ctx, p.act); tick(ctx, p.done) }
        if (at === 'finger') { fingerCheck(ctx, p.act, c.skin, p.fail); if (p.fail) query(ctx, p.done); else tick(ctx, p.done) }
        if (at === 'iris') { irisCheck(ctx, p.act, '#E8C39E'); tick(ctx, p.done) }
      })
    } })
  }
  for (const key of stationKeys) {
    const P = L.place[key]
    items.push({ y: P.y + 0.5, s: 1, draw: () => inFigure(P.x, P.y, 1, () => {
      counter(ctx)
      const here = people.find((p) => p.at === key && !p.walking)
      if (key === 'face') camera(ctx, !!here && here.act > 0 && here.act < 0.95)
      if (key === 'finger' && !here) reader(ctx, false, ACC)
    }) })
  }
  items.sort((a, b) => a.y - b.y)
  for (const it of items) {
    ctx.save(); ctx.translate(shift(0.35 + 0.65 * it.s), 0)
    it.draw()
    ctx.restore()
  }

  // Station labels on the lane edge.
  ctx.save(); ctx.translate(shift(1), 0)
  ctx.fillStyle = MUTED
  ctx.font = `600 ${Math.max(11, Math.round(k * 13))}px "Bricolage Grotesque", system-ui, sans-serif`
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'
  const ly = h - Math.max(6, k * 6)
  ctx.fillText('Face and liveness', L.place.face.x, ly)
  ctx.fillText('Fingerprint', L.place.finger.x, ly)
  ctx.fillText('Iris, if the print fails', L.place.iris.x, ly)
  if (L.wide) ctx.fillText('Seated', (L.seats[0].x + L.seats[3].x) / 2, ly)
  ctx.restore()

  // Foreground: an invigilator walks past close to us, cropped by the edge.
  if (L.wide) {
    const lap = 17, cross = 8
    const q = (t % lap) / cross
    if (q < 1) {
      const s = 2.5
      ctx.save(); ctx.translate(shift(1.8), 0)
      drawBust(INVIGILATOR, -0.15 * w + 1.3 * w * q, h + 100 * k * s * 0.52, s, 1,
               -Math.abs(Math.sin(q * Math.PI * 9)) * 2, 1.5, false)
      ctx.restore()
    }
  }
}

// top: the scene occupies the lower (1 − top) of the box, so copy can sit
// above it; clearLeft: fraction of the width kept free of far rows.
// insetL: fraction of the width kept clear at the left (e.g. for a figure
// standing there); scale: multiplier on the figures' size.
export default function ExamHall({ className, style, top = 0, clearLeft = 0, insetL = 0, scale = 1 }) {
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    let w = 0, h = 0, raf = 0, last = performance.now()
    let t = STEP * 12.4        // start mid-shift: every station busy, hall half full
    const par = { x: 0, y: 0, tx: 0, ty: 0 }
    const onMove = (e) => { par.tx = (e.clientX / window.innerWidth - 0.5) * 2 }
    const onScroll = () => { par.ty = Math.min(1, window.scrollY / 600) * -18 }
    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('scroll', onScroll, { passive: true })
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')

    const draw = () => {
      ctx.clearRect(0, 0, w, h)
      if (!w || !h) return
      ctx.save(); ctx.translate(0, h * top)
      drawHall(ctx, w, h * (1 - top), t, par, clearLeft, { insetL, scale })
      ctx.restore()
    }
    const resize = () => {
      const r = wrap.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      w = r.width; h = r.height
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr)
      canvas.style.width = `${w}px`; canvas.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      draw()
    }
    const frame = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000); last = now
      if (!document.hidden) {
        t += dt
        par.x += (par.tx - par.x) * Math.min(1, dt * 4)
        par.y += (par.ty - par.y) * Math.min(1, dt * 4)
        draw()
      }
      raf = requestAnimationFrame(frame)
    }
    const start = () => {
      cancelAnimationFrame(raf)
      if (reduce?.matches) { t = STEP * 12.6; draw(); return }
      last = performance.now(); raf = requestAnimationFrame(frame)
    }
    const ro = new ResizeObserver(resize)
    ro.observe(wrap)
    resize()
    start()
    reduce?.addEventListener?.('change', start)
    document.fonts?.ready?.then(draw)
    return () => {
      cancelAnimationFrame(raf); ro.disconnect()
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('scroll', onScroll)
      reduce?.removeEventListener?.('change', start)
    }
  }, [])

  return (
    <div ref={wrapRef} className={className} style={{ position: 'relative', ...style }} aria-hidden="true">
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, display: 'block' }} />
    </div>
  )
}
