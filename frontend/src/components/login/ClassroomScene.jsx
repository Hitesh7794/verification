import { useEffect, useRef } from 'react'
import {
  drawPerson, makeCast, easeOutBack, clamp01, withAlpha, line,
  fillRRect, strokeRRect, fillCircle, strokeCircle, strokeRound,
} from './people.js'

// ClassroomScene — exam day in a college classroom, shot like a film.
//
// The verification desk sits at the front of the room. Candidates come in
// through the door at the back, queue, and step up one at a time: brackets
// close on the face, a thumb presses the reader, and when a print won't read
// (every third candidate, the product's rule) the iris scanner comes up to
// the eye. A tick, and they walk off to the benches. Behind them the room
// lives: students write, nod, flip pages and glance up at the clock; the
// invigilator walks the aisle; ceiling fans turn; a tree sways in the
// window, birds cross it, sunlight falls in beams with dust drifting in them.
//
// Depth is built like a camera: the room is split across stacked canvases,
// each with its own depth-of-field blur (far soft, the desk sharp, a plant
// in the extreme foreground very soft), and each drifts with the pointer and
// a slow camera float by its depth — parallax. Everyone is a different
// person (makeCast); no face repeats on screen.
//
// Children (the Verifier) render between the action layer and the counter,
// so the agent stands behind the desk. onPhase(name) reports what the desk
// is doing: 'arrive' | 'face' | 'finger' | 'fail' | 'iris' | 'done'.

const INK = '#211E33'
const ACC = '#5B3FA6'
const ACC_DEEP = '#43307D'
const MARK = '#99641B'
const LINE = '#E3E1EA'
const MUTED = '#66627A'
const SAFFRON = '#F28C28'
const GREEN = '#138808'
const CHAKRA = '#0B1F6B'
const WALL = '#F4F2F8'
const FLOORC = '#ECE8F3'
const TINT_S = '#DDD5F2'
const WOOD = '#E6D3B6', WOOD_DK = '#CDB594', WOOD_EDGE = '#B99C74'

const CAST = makeCast(80)
// Indices: benches use 0…35, the desk pipeline 36…79 — never the same face twice.
const benchWho = (j) => CAST[j % 36]
const deskWho = (i) => CAST[36 + (((i % 44) + 44) % 44)]
const TEACHER = { ...CAST[5], shirt: '#2F3A4F', shirtDk: '#232C3D', glasses: true, moustache: true, look: 10 }

const easeInOut = (x) => { x = clamp01(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2 }
const easeOutCubic = (x) => 1 - Math.pow(1 - clamp01(x), 3)
const TAU = Math.PI * 2

// ── Desk timing (same pipeline as DeskScene) ──────────────────────────
const fails = (i) => ((i % 3) + 3) % 3 === 2
const ARRIVE = 1.6, CHECK = 2.3, LEAVE = 1.8
const slotLen = (i) => ARRIVE + CHECK * (fails(i) ? 3 : 2)
const CYCLE = slotLen(0) + slotLen(1) + slotLen(2)
const slotStart = (i) => Math.floor(i / 3) * CYCLE + [0, slotLen(0), slotLen(0) + slotLen(1)][((i % 3) + 3) % 3]
function currentAt(t) { let c = Math.floor(t / CYCLE) * 3; while (slotStart(c + 1) <= t) c++; return c }
function sceneAt(t) {
  const c = currentAt(t), u = t - slotStart(c), fail = fails(c)
  let phase = 'arrive', a = 0
  if (u >= ARRIVE) {
    const k = Math.floor((u - ARRIVE) / CHECK)
    a = ((u - ARRIVE) % CHECK) / CHECK
    phase = ['face', 'finger', 'iris'][Math.min(k, 2)]
  }
  return { c, u, fail, phase, a }
}
function phaseAt(t) {
  const s = sceneAt(t)
  if (s.phase === 'arrive') return 'arrive'
  if (s.phase === 'finger' && s.fail && s.a > 0.8) return 'fail'
  if (s.phase === (s.fail ? 'iris' : 'finger') && s.a > 0.82) return 'done'
  return s.phase
}

// ── Layout ────────────────────────────────────────────────────────────
function layout(w, h) {
  const k = Math.min(h * 0.0033, w * 0.0028)             // px per figure unit at the desk
  const wallB = h * 0.47                                  // where wall meets floor
  const counterTop = h * 0.79
  return {
    k, wallB, counterTop, counterX: w * 0.30,
    door: { x: w * 0.035, y: wallB + h * 0.005, s: 0.30 },
    desk: { x: w * 0.44, y: counterTop + 12 * k, s: 1 },
    q: [null,
      { x: w * 0.235, y: h * 0.745, s: 0.64 },
      { x: w * 0.155, y: h * 0.685, s: 0.53 },
      { x: w * 0.095, y: h * 0.63, s: 0.44 },
      { x: w * 0.05, y: h * 0.57, s: 0.37 },
    ],
    rows: [                                               // benches, back → front: [y, scale, x0, x1, n]
      { y: h * 0.535, s: 0.27, x0: 0.36, x1: 0.97, n: 9, blur: 0 },
      { y: h * 0.605, s: 0.34, x0: 0.40, x1: 1.0, n: 8, blur: 1 },
      { y: h * 0.69, s: 0.43, x0: 0.47, x1: 1.04, n: 7, blur: 2 },
    ],
  }
}
const lerpP = (A, B, m) => ({ x: A.x + (B.x - A.x) * m, y: A.y + (B.y - A.y) * m, s: A.s + (B.s - A.s) * m })

// ── Figure helpers ────────────────────────────────────────────────────
function inFig(ctx, k, P, fn) {
  const sk = k * P.s
  ctx.save(); ctx.translate(P.x - 50 * sk, P.y - 100 * sk); ctx.scale(sk, sk); fn(); ctx.restore()
}
// A person with life: breath, a slow weight-shift sway, and — walking —
// bob, lean and squash-and-stretch from the feet. look: {x, y} pupils.
function person(ctx, k, c, P, t, o = {}) {
  const { alpha = 1, walk = null, look = null, nod = 0, blinkNow = false } = o
  const sk = k * P.s
  const br = Math.sin(((t + c.phase) / c.breathEvery) * TAU)
  let bob = 0, lean = 0, sqx = 0, sqy = 0
  if (walk != null) {
    const st = Math.abs(Math.sin(walk * Math.PI))
    bob = -st * 2.4
    const contact = 1 - st
    sqx = contact * 0.04; sqy = -contact * 0.05 + st * 0.02
    lean = 1.8
  } else {
    lean = 0.9 * Math.sin(((t + c.phase * 1.7) / 5.3) * TAU)
  }
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.translate(P.x, P.y + (bob + nod) * sk)
  ctx.rotate((lean * Math.PI) / 180)
  ctx.scale(1 + 0.006 * br + sqx, 1 + 0.013 * br + sqy)
  ctx.translate(-50 * sk, -100 * sk)
  ctx.scale(sk, sk)
  ctx.beginPath(); ctx.rect(-80, -80, 260, 180); ctx.clip()
  const eye = blinkNow || ((t + c.phase) % c.blinkEvery) < 0.13 ? 0.06 : 1
  drawPerson(ctx, look ? { ...c, lookX: look.x, lookY: look.y } : c, eye)
  ctx.restore()
}

// ── Layer painters ────────────────────────────────────────────────────
// F: floor (sharp), with perspective tiles and window light.
function paintFloor(ctx, w, h, t, L) {
  ctx.fillStyle = FLOORC
  ctx.fillRect(0, L.wallB, w, h - L.wallB)
  const vx = w * 0.55, vy = h * 0.12
  // Tile lines: converging to the vanishing point, rows closing toward the back.
  for (let j = -8; j <= 12; j++) {
    const bx = w * 0.55 + j * w * 0.13
    const m = (L.wallB - vy) / (h - vy)
    line(ctx, withAlpha('#FFFFFF', 0.9), vx + (bx - vx) * m, L.wallB, bx, h, 1.4)
  }
  for (let r = 0; r < 9; r++) {
    const y = L.wallB + (h - L.wallB) * Math.pow(r / 8, 1.8)
    line(ctx, withAlpha('#FFFFFF', 0.9), 0, y, w, y, 1.2)
  }
  // Skirting.
  ctx.fillStyle = '#E2DDEB'; ctx.fillRect(0, L.wallB - h * 0.012, w, h * 0.012)
  // Sunlight from the windows, laid on the floor as flat patches.
  const drift = Math.sin(t * 0.05) * w * 0.01
  const sunF = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(t * 0.21))
  ctx.fillStyle = `rgba(255,255,255,${(0.55 * sunF).toFixed(3)})`
  for (const [x0, x1] of [[0.76, 0.86], [0.88, 0.98]]) {
    ctx.beginPath()
    ctx.moveTo(w * x0 - w * 0.02 + drift, L.wallB + 2)
    ctx.lineTo(w * x1 - w * 0.02 + drift, L.wallB + 2)
    ctx.lineTo(w * x1 - w * 0.2 + drift, h * 0.66)
    ctx.lineTo(w * x0 - w * 0.2 + drift, h * 0.66)
    ctx.closePath(); ctx.fill()
  }
}

// L0: the back wall — board, notice board, door, clock, windows, tree, birds — and the back row.
function paintWall(ctx, w, h, t, L) {
  ctx.fillStyle = WALL
  ctx.fillRect(0, 0, w, L.wallB)
  // Ceiling edge and tube lights.
  ctx.fillStyle = '#E6E2EE'; ctx.fillRect(0, 0, w, h * 0.035)
  for (const x of [0.2, 0.5, 0.8]) {
    const flicker = x === 0.8 && (t % 17) < 0.4 && Math.sin(t * 70) > 0
    fillRRect(ctx, flicker ? '#E9E6F1' : '#FFFFFF', w * x - w * 0.06, h * 0.045, w * 0.12, h * 0.012, h * 0.006)
    line(ctx, LINE, w * x - w * 0.06, h * 0.058, w * x + w * 0.06, h * 0.058, 1)
  }

  // Door, open, corridor light beyond.
  const dx0 = w * 0.01, dx1 = w * 0.1, dy0 = h * 0.12
  ctx.fillStyle = '#DDD5F2'; ctx.fillRect(dx0, dy0, dx1 - dx0, L.wallB - dy0)
  ctx.fillStyle = '#EFEBF9'; ctx.fillRect(dx0, L.wallB - h * 0.06, dx1 - dx0, h * 0.06)
  ctx.fillStyle = ACC_DEEP
  ctx.beginPath()                                                     // the door leaf, swung in
  const sd = sceneAt(t)
  const openAmt = 0.3 + 0.7 * Math.sin(Math.PI * clamp01(sd.u / (ARRIVE + 0.4)))
  const leafW = w * 0.055 * openAmt
  ctx.moveTo(dx1, dy0); ctx.lineTo(dx1 + leafW, dy0 + h * 0.03 * openAmt)
  ctx.lineTo(dx1 + leafW, L.wallB + h * 0.016 * openAmt); ctx.lineTo(dx1, L.wallB); ctx.closePath(); ctx.fill()
  fillCircle(ctx, MARK, dx1 + leafW * 0.8, (dy0 + L.wallB) / 2 + h * 0.02, Math.max(2, h * 0.004))
  strokeRRect(ctx, '#B9ACD8', dx0, dy0, dx1 - dx0, L.wallB - dy0, 1, Math.max(3, w * 0.004))

  // Notice board: cork, pinned papers, a seating plan.
  const nx = w * 0.13, ny = h * 0.14, nw = w * 0.13, nh = h * 0.16
  fillRRect(ctx, WOOD_EDGE, nx - 4, ny - 4, nw + 8, nh + 8, 3)
  fillRRect(ctx, '#D9B98C', nx, ny, nw, nh, 2)
  const papers = [[0.06, 0.1, 0.36, 0.42, -3, SAFFRON], [0.5, 0.08, 0.42, 0.5, 2, GREEN], [0.12, 0.58, 0.3, 0.34, 4, ACC], [0.54, 0.64, 0.38, 0.28, -2, ACC_DEEP]]
  papers.forEach(([px, py, pw, ph, rot, pin], j) => {
    ctx.save()
    ctx.translate(nx + nw * (px + pw / 2), ny + nh * (py + ph / 2))
    ctx.rotate(((rot + (j === 0 ? Math.sin(t * 7) * 2.4 + Math.sin(t * 2.3) * 1.3 : 0)) * Math.PI) / 180)
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(-nw * pw / 2, -nh * ph / 2, nw * pw, nh * ph)
    for (let r = 0; r < 4; r++) line(ctx, withAlpha(INK, 0.25), -nw * pw * 0.35, -nh * ph * 0.25 + r * nh * ph * 0.16, nw * pw * (j === 1 ? 0.35 : 0.15), -nh * ph * 0.25 + r * nh * ph * 0.16, 1)
    if (j === 1) for (let cI = 0; cI < 3; cI++) line(ctx, withAlpha(INK, 0.2), -nw * pw * 0.35 + cI * nw * pw * 0.35, -nh * ph * 0.3, -nw * pw * 0.35 + cI * nw * pw * 0.35, nh * ph * 0.3, 1)
    fillCircle(ctx, pin, 0, -nh * ph / 2 + 3, Math.max(2, h * 0.004))
    ctx.restore()
  })

  // The greenboard, chalk on it.
  const bx = w * 0.3, by = h * 0.1, bw = w * 0.36, bh = h * 0.24
  fillRRect(ctx, WOOD_EDGE, bx - 6, by - 6, bw + 12, bh + 12, 4)
  fillRRect(ctx, '#27463C', bx, by, bw, bh, 2)
  const chalk = 'rgba(238,243,239,0.92)'
  ctx.fillStyle = chalk
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
  ctx.font = `600 ${Math.round(h * 0.032)}px "Bricolage Grotesque", system-ui, sans-serif`
  ctx.fillText('Lecture Hall 3', bx + bw * 0.07, by + bh * 0.3)
  ctx.font = `500 ${Math.round(h * 0.021)}px "Bricolage Grotesque", system-ui, sans-serif`
  ctx.fillText('Identity check before entry', bx + bw * 0.07, by + bh * 0.5)
  ctx.fillText('Face, fingerprint, iris', bx + bw * 0.07, by + bh * 0.64)
  // "Verified today", chalked up — each new number wiped in by hand.
  {
    const sc = sceneAt(t)
    const count = 142 + sc.c
    const label = 'Verified today'
    const lx = bx + bw * 0.07, ly = by + bh * 0.84
    ctx.fillText(label, lx, ly)
    ctx.font = `700 ${Math.round(h * 0.026)}px "Bricolage Grotesque", system-ui, sans-serif`
    const nx0 = lx + ctx.measureText(label).width + bw * 0.03 + 6
    const reveal = clamp01(sc.u / 0.8)
    const num = String(count), nw = ctx.measureText(num).width
    ctx.save(); ctx.beginPath(); ctx.rect(nx0 - 2, ly - h * 0.04, (nw + 4) * reveal, h * 0.05); ctx.clip()
    ctx.fillText(num, nx0, ly)
    ctx.restore()
    if (reveal < 1) {                                         // the chalk, mid-stroke
      const cxk = nx0 + nw * reveal
      fillRRect(ctx, '#FFFFFF', cxk - 2, ly - h * 0.028, 5, h * 0.018, 2)
    }
  }
  // A chalk underline, a little wobbly.
  ctx.beginPath()
  for (let j = 0; j <= 20; j++) {
    const x = bx + bw * (0.07 + 0.5 * (j / 20)), y = by + bh * 0.36 + Math.sin(j * 1.3) * 1.2
    j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
  }
  strokeRound(ctx, chalk, 1.6)
  // A chalk fingerprint in the corner.
  const fx = bx + bw * 0.82, fy = by + bh * 0.46
  for (let r = 1; r <= 5; r++) {
    ctx.beginPath(); ctx.ellipse(fx, fy, r * bh * 0.028, r * bh * 0.04, 0, Math.PI * 1.05, Math.PI * 2.1)
    strokeRound(ctx, 'rgba(238,243,239,0.6)', 1.2)
  }
  // Chalk tray and a duster.
  fillRRect(ctx, WOOD_EDGE, bx - 6, by + bh + 4, bw + 12, h * 0.012, 2)
  fillRRect(ctx, '#3B3F4D', bx + bw * 0.78, by + bh + 1, bw * 0.08, h * 0.012, 2)
  fillRRect(ctx, '#FFFFFF', bx + bw * 0.2, by + bh + 2, bw * 0.03, h * 0.006, 2)

  // The clock, showing the real time.
  const now = new Date()
  const cx = w * 0.715, cy = h * 0.15, R = Math.max(18, h * 0.045)
  fillCircle(ctx, '#FFFFFF', cx, cy, R)
  strokeCircle(ctx, INK, cx, cy, R, Math.max(2, R * 0.09))
  for (let j = 0; j < 12; j++) {
    const an = (j / 12) * TAU
    line(ctx, withAlpha(INK, 0.55), cx + Math.sin(an) * R * (j % 3 ? 0.78 : 0.68), cy - Math.cos(an) * R * (j % 3 ? 0.78 : 0.68),
      cx + Math.sin(an) * R * 0.86, cy - Math.cos(an) * R * 0.86, j % 3 ? 1.1 : 2)
  }
  const sec = now.getSeconds() + now.getMilliseconds() / 1000, mn = now.getMinutes() + sec / 60, hr = (now.getHours() % 12) + mn / 60
  const hand = (turn, len, wd, col) => line(ctx, col, cx, cy, cx + Math.sin(turn * TAU) * R * len, cy - Math.cos(turn * TAU) * R * len, wd)
  hand(hr / 12, 0.48, Math.max(2.5, R * 0.1), INK)
  hand(mn / 60, 0.7, Math.max(2, R * 0.07), INK)
  const fr = now.getMilliseconds() / 1000
  const snap = now.getSeconds() - 1 + (fr < 0.18 ? easeOutBack(fr / 0.18) : 1)
  hand(snap / 60, 0.78, 1.2, ACC)
  fillCircle(ctx, ACC, cx, cy, Math.max(2, R * 0.08))

  // Windows: sky, a tree swaying, birds crossing now and then.
  const wins = [[0.765, 0.86], [0.88, 0.975]]
  const wy0 = h * 0.08, wy1 = h * 0.37
  for (const [x0, x1] of wins) {
    ctx.save()
    ctx.beginPath(); ctx.rect(w * x0, wy0, w * (x1 - x0), wy1 - wy0); ctx.clip()
    ctx.fillStyle = '#DCE6FA'; ctx.fillRect(w * x0, wy0, w * (x1 - x0), wy1 - wy0)
    const cdx = w * (((t * 0.011) % 1) * 0.42 - 0.08)            // a cloud, drifting
    fillCircle(ctx, '#FFFFFF', w * 0.75 + cdx, h * 0.14, h * 0.03)
    fillCircle(ctx, '#FFFFFF', w * 0.775 + cdx, h * 0.13, h * 0.038)
    fillCircle(ctx, '#FFFFFF', w * 0.8 + cdx, h * 0.145, h * 0.028)
    const sway = Math.sin(t * 0.8) * w * 0.004
    ctx.fillStyle = '#7C6A52'; ctx.fillRect(w * 0.905, h * 0.24, w * 0.008, h * 0.14)   // trunk
    for (const [tx, ty, tr, col] of [[0.9, 0.22, 0.055, '#4E8A45'], [0.93, 0.19, 0.05, '#5D9A50'], [0.875, 0.27, 0.045, '#5D9A50'], [0.945, 0.26, 0.045, '#4E8A45'], [0.91, 0.15, 0.04, '#6BA85C']]) {
      fillCircle(ctx, col, w * tx + sway * (1 + ty * 2), h * ty, h * tr)
    }
    // Birds: a pair crosses every 14 s.
    const bq = (t % 14) / 5
    if (bq < 1) {
      for (let j = 0; j < 3; j++) {
        const x = w * (0.74 + 0.28 * bq) + j * w * 0.015, y = h * (0.12 + 0.02 * j) + Math.sin(bq * 10 + j) * 3
        const flap = Math.sin(t * 14 + j) * 3
        ctx.beginPath(); ctx.moveTo(x - 5, y - flap); ctx.lineTo(x, y); ctx.lineTo(x + 5, y - flap)
        strokeRound(ctx, INK, 1.4)
      }
    }
    ctx.restore()
    strokeRRect(ctx, '#FFFFFF', w * x0, wy0, w * (x1 - x0), wy1 - wy0, 1, Math.max(4, w * 0.005))
    line(ctx, '#FFFFFF', w * (x0 + x1) / 2, wy0, w * (x0 + x1) / 2, wy1, Math.max(3, w * 0.003))
    line(ctx, '#FFFFFF', w * x0, (wy0 + wy1) / 2, w * x1, (wy0 + wy1) / 2, Math.max(3, w * 0.003))
    fillRRect(ctx, '#E2DDEB', w * x0 - 6, wy1, w * (x1 - x0) + 12, h * 0.012, 2)   // sill
    for (let g = 1; g < 6; g++) {                                             // the grille
      const gx = w * (x0 + (x1 - x0) * (g / 6))
      line(ctx, withAlpha('#FFFFFF', 0.85), gx, wy0, gx, wy1, 1.2)
    }
  }
  // Curtains, gathered at the sides, stirring in the fan's air.
  for (const [cx0, dir] of [[0.745, 1], [0.978, -1]]) {
    const stir = Math.sin(t * 1.1 + cx0 * 9) * w * 0.003
    ctx.fillStyle = '#CFC3EE'
    ctx.beginPath()
    ctx.moveTo(w * cx0, wy0 - h * 0.01)
    ctx.lineTo(w * cx0 + dir * w * 0.022, wy0 - h * 0.01)
    ctx.quadraticCurveTo(w * cx0 + dir * w * 0.012 + stir, (wy0 + wy1) / 2, w * cx0 + dir * w * 0.026 + stir * 1.6, wy1 + h * 0.02)
    ctx.lineTo(w * cx0 + stir, wy1 + h * 0.02)
    ctx.closePath(); ctx.fill()
    line(ctx, '#B9ACD8', w * cx0 + dir * w * 0.008, wy0, w * cx0 + dir * w * 0.009 + stir, wy1 + h * 0.015, 1)
  }
  line(ctx, '#B9ACD8', w * 0.74, wy0 - h * 0.012, w * 0.985, wy0 - h * 0.012, 2)     // curtain rod

  // A pigeon: lands on the sill every 22 s, pecks about, flies off.
  {
    const pq = (t + 6) % 22
    if (pq < 10) {
      const sx = w * 0.79, sy = wy1 - 1
      let px = sx, py = sy, flying = false
      if (pq < 1.4) { const f = pq / 1.4; px = sx - w * 0.08 * (1 - f); py = sy - h * 0.08 * (1 - f) * (1 - f); flying = true }
      else if (pq > 8.6) { const f = (pq - 8.6) / 1.4; px = sx + w * 0.1 * f; py = sy - h * 0.1 * f * f; flying = true }
      else px = sx + Math.sin(pq * 0.9) * w * 0.012
      const peck = !flying && Math.sin(pq * 5) > 0.6 ? 1 : 0
      const u = Math.max(4, h * 0.009)
      ctx.fillStyle = '#8C8FA3'
      ctx.beginPath(); ctx.ellipse(px, py - u, u * 1.5, u, 0, 0, TAU); ctx.fill()
      fillCircle(ctx, '#7A7D92', px + u * 1.2, py - u * (1.9 - peck * 0.9), u * 0.62)
      ctx.fillStyle = MARK
      ctx.beginPath(); ctx.moveTo(px + u * 1.75, py - u * (1.9 - peck * 0.9)); ctx.lineTo(px + u * 2.3, py - u * (1.75 - peck * 0.9)); ctx.lineTo(px + u * 1.75, py - u * (1.6 - peck * 0.9)); ctx.fill()
      if (flying) {
        const flap = Math.sin(t * 22) * u * 1.4
        ctx.beginPath(); ctx.moveTo(px - u * 0.4, py - u * 1.3); ctx.lineTo(px - u * 1.6, py - u * 1.3 - flap); ctx.lineTo(px + u * 0.6, py - u * 1.2); ctx.fillStyle = '#9A9DB0'; ctx.fill()
      } else {
        line(ctx, MARK, px - u * 0.3, py - u * 0.2, px - u * 0.3, py, 1)
        line(ctx, MARK, px + u * 0.3, py - u * 0.2, px + u * 0.3, py, 1)
      }
    }
  }

  // CCTV on the wall, panning slowly, its light blinking.
  {
    const cx = w * 0.275, cy = h * 0.07, u = Math.max(5, h * 0.012)
    fillRRect(ctx, '#D3CEE4', cx - u * 0.3, cy - u * 1.6, u * 0.6, u * 1.6, 1)
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(Math.sin(t * 0.35) * 0.35)
    fillRRect(ctx, '#FFFFFF', -u * 0.4, -u * 0.55, u * 2.6, u * 1.1, u * 0.35)
    strokeRRect(ctx, '#B9ACD8', -u * 0.4, -u * 0.55, u * 2.6, u * 1.1, u * 0.35, 1)
    fillCircle(ctx, INK, u * 2.05, 0, u * 0.32)
    fillCircle(ctx, (t % 1.6) < 0.2 ? ACC : withAlpha(ACC, 0.25), u * 0.1, -u * 0.18, u * 0.15)
    ctx.restore()
  }
  // A rolled projector screen above the board, its pull cord swaying.
  fillRRect(ctx, '#E2DDEB', w * 0.31, h * 0.068, w * 0.34, h * 0.014, h * 0.007)
  line(ctx, '#B9ACD8', w * 0.48 + Math.sin(t * 1.3) * 2, h * 0.082, w * 0.48 + Math.sin(t * 1.3 + 0.6) * 3, h * 0.095, 1)
  // A speaker, top right; a switchboard by the door.
  fillRRect(ctx, '#FFFFFF', w * 0.965, h * 0.045, w * 0.025, h * 0.03, 3)
  for (let r = 0; r < 3; r++) line(ctx, '#D3CEE4', w * 0.969, h * 0.052 + r * h * 0.007, w * 0.986, h * 0.052 + r * h * 0.007, 1)
  fillRRect(ctx, '#FFFFFF', w * 0.108, h * 0.28, w * 0.016, h * 0.03, 2)
  for (let r = 0; r < 2; r++) for (let c2 = 0; c2 < 2; c2++) fillRRect(ctx, '#D3CEE4', w * 0.111 + c2 * w * 0.006, h * 0.285 + r * h * 0.011, w * 0.004, h * 0.007, 1)
}

// A row of benches with students writing at them.
function paintRow(ctx, w, h, t, L, rowIdx, base) {
  const R = L.rows[rowIdx]
  for (let j = 0; j < R.n; j++) {
    const x = w * (R.x0 + (R.x1 - R.x0) * (j / (R.n - 1)))
    const P = { x, y: R.y, s: R.s }
    const c = benchWho(base + j)
    // Writing, looking down; now and then a glance up at the clock.
    const glance = ((t + c.phase * 3) % 11) < 1.3
    const cheer = phaseAt(t) === 'done' && rowIdx > 0 && j % 2 === 0     // heads turn to the desk
    const look = cheer ? { x: -2, y: 0.2 } : glance ? { x: 1.2, y: -2 } : { x: 0.3, y: 2 }
    const nod = glance ? -1.2 : 0.9 * Math.max(0, Math.sin(((t + c.phase) / 2.3) * TAU))
    person(ctx, L.k, c, P, t, { look, nod: cheer ? 0 : nod })
    const raising = rowIdx === 2 && j === 3 ? handRaise(t) : 0
    inFig(ctx, L.k, P, () => {
      if (raising > 0) {                                     // a question for the invigilator
        const top = 66 - 62 * raising
        ctx.fillStyle = c.shirt; ctx.fillRect(80, top + 8, 11, 66 - top)
        fillRRect(ctx, c.skin, 79, top - 4, 13, 14, 5)
        fillRRect(ctx, c.skin, 80, top - 10, 3, 8, 1.5)
        fillRRect(ctx, c.skin, 84, top - 12, 3, 9, 1.5)
        fillRRect(ctx, c.skin, 88, top - 10, 3, 8, 1.5)
      }
      // The bench: top and front panel, continuous along the row.
      ctx.fillStyle = WOOD; ctx.fillRect(-14, 80, 128, 8)
      ctx.fillStyle = WOOD_DK; ctx.fillRect(-14, 88, 128, 30)
      line(ctx, WOOD_EDGE, -14, 88, 114, 88, 1.2)
      // Answer sheet, a page that flips now and then, the writing hand and pen.
      const flip = ((t + c.phase * 2) % 9)
      const fw = flip < 0.5 ? Math.abs(Math.cos((flip / 0.5) * Math.PI)) : 1
      // Seat number on the bench front; a bottle or a pouch on the desk.
      fillRRect(ctx, '#FFFFFF', 40, 93, 20, 9, 1.5)
      ctx.fillStyle = MUTED; ctx.font = '600 6.5px "Bricolage Grotesque", system-ui, sans-serif'
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText(String(101 + rowIdx * 20 + j), 50, 97.8)
      if ((j + rowIdx) % 3 === 0) {
        const bc = ['#94B7F2', '#F28C28', '#9A86D6', '#138808'][(j + rowIdx) % 4]
        fillRRect(ctx, withAlpha(bc, 0.8), 8, 66, 8, 15, 2.5); fillRRect(ctx, bc, 9.5, 63, 5, 4, 1)
      } else if ((j + rowIdx) % 3 === 1) {
        fillRRect(ctx, ['#43307D', '#C58226', '#2E6DA4'][j % 3], 4, 76, 18, 5, 2.5)
      }
      ctx.fillStyle = '#FFFFFF'; ctx.fillRect(30, 81.5, 34, 5)
      ctx.fillStyle = '#F4F2F8'; ctx.fillRect(64 - 16 * fw, 81, 16 * fw, 5.5)
      if (!glance) {
        const hx = 56 + Math.sin((t + c.phase) * 7) * 4 + Math.sin((t + c.phase) * 1.3) * 3
        line(ctx, INK, hx + 2, 80, hx + 6, 76, 1.4)
        fillRRect(ctx, c.skin, hx - 4, 79, 9, 6, 3)
      } else {
        fillRRect(ctx, c.skin, 66, 80, 9, 6, 3)
      }
    })
  }
}

// L1/L2 extras: ceiling fans, the invigilator in the aisle, sunbeams with dust.
// One student raises a hand every 13 s; the invigilator turns to them.
function handRaise(t) {
  const q = (t + 4) % 13
  if (q > 3) return 0
  return q < 0.5 ? easeOutBack(q / 0.5) : q > 2.5 ? 1 - easeOutCubic((q - 2.5) / 0.5) : 1
}

function paintFans(ctx, w, h, t) {
  // The projector, hanging from the ceiling, its fan light pulsing.
  line(ctx, MUTED, w * 0.56, 0, w * 0.56, h * 0.05, Math.max(2, h * 0.003))
  fillRRect(ctx, '#FFFFFF', w * 0.535, h * 0.05, w * 0.05, h * 0.022, 4)
  strokeRRect(ctx, '#B9ACD8', w * 0.535, h * 0.05, w * 0.05, h * 0.022, 4, 1)
  fillCircle(ctx, INK, w * 0.542, h * 0.061, h * 0.006)
  fillCircle(ctx, withAlpha(ACC, 0.4 + 0.4 * Math.sin(t * 2)), w * 0.578, h * 0.056, h * 0.0025)
  for (const [fx, sp] of [[0.4, 5.2], [0.72, 4.6]]) {
    const cx = w * fx, cy = h * 0.075, Lb = w * 0.085
    line(ctx, MUTED, cx, 0, cx, cy, Math.max(2, h * 0.003))
    for (let b = 0; b < 3; b++) {
      const an = t * sp + (b * TAU) / 3
      const ex = Math.cos(an) * Lb, ey = Math.sin(an) * Lb * 0.18
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.lineTo(cx + ex - ey * 0.6, cy + ey + ex * 0.02)
      ctx.lineTo(cx + ex * 1.02 + ey * 0.6, cy + ey + 3)
      ctx.closePath()
      ctx.fillStyle = '#D6D0E3'; ctx.fill()
    }
    fillRRect(ctx, MUTED, cx - h * 0.014, cy - h * 0.008, h * 0.028, h * 0.016, h * 0.006)
  }
}
function paintTeacher(ctx, w, h, t, L) {
  const lap = 16, q = (t % lap) / lap
  const dir = q < 0.5 ? 1 : -1
  const m = q < 0.5 ? easeInOut(q * 2) : easeInOut((1 - q) * 2)
  const P = { x: w * (0.5 + 0.42 * m), y: h * 0.575, s: 0.36 }
  const walking = Math.abs(Math.sin(q * TAU)) > 0.08
  const R2 = L.rows[2]
  const askX = w * (R2.x0 + (R2.x1 - R2.x0) * (3 / (R2.n - 1)))
  const asked = handRaise(t) > 0.2
  const look = asked ? { x: Math.sign(askX - P.x) * 2.2, y: 1.2 } : { x: dir * 1.8, y: 0.8 }
  person(ctx, L.k, TEACHER, P, t, { walk: walking && !asked ? (t * 1.6) % 1 : null, look })
}
const MOTES = Array.from({ length: 28 }, (_, i) => ({ x: (i * 0.618) % 1, y: (i * 0.377) % 1, r: 0.8 + (i % 3) * 0.5, sp: 0.02 + (i % 5) * 0.006 }))
function paintBeams(ctx, w, h, t, L) {
  const drift = Math.sin(t * 0.05) * w * 0.01
  const sun = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(t * 0.21))
  ctx.fillStyle = `rgba(255,255,255,${(0.17 * sun).toFixed(3)})`
  for (const [x0, x1] of [[0.765, 0.86], [0.88, 0.975]]) {
    ctx.beginPath()
    ctx.moveTo(w * x0, h * 0.1); ctx.lineTo(w * x1, h * 0.1)
    ctx.lineTo(w * x1 - w * 0.2 + drift, h * 0.66); ctx.lineTo(w * x0 - w * 0.2 + drift, h * 0.66)
    ctx.closePath(); ctx.fill()
  }
  // Dust, drifting up through the light.
  for (const d of MOTES) {
    const yy = (d.y - t * d.sp) % 1
    const y = h * (0.12 + 0.52 * (yy < 0 ? yy + 1 : yy))
    const f = (y - h * 0.1) / (h * 0.56)
    const x = w * (0.77 + 0.2 * d.x) - w * 0.2 * f + Math.sin(t * 0.7 + d.x * 9) * 4
    fillCircle(ctx, 'rgba(255,255,255,0.8)', x, y, d.r)
  }
}

// L3: the queue and the candidate at the desk (sharp).
function paintAction(ctx, w, h, t, L) {
  const s = sceneAt(t)
  const k = L.k
  // The last candidate, off to the benches.
  if (s.u < LEAVE && s.c > 0) {
    const m = easeInOut(s.u / LEAVE)
    const P = lerpP(L.desk, { x: w * 0.6, y: h * 0.62, s: 0.36 }, m)
    person(ctx, k, deskWho(s.c - 1), P, t, { alpha: 1 - clamp01((m - 0.75) / 0.25), walk: (s.u * 1.8) % 1, look: { x: 1.5, y: 0 } })
  }
  // The queue, from the door forward. Anticipation: a small dip before each step.
  const m = easeInOut(clamp01((s.u - 0.15) / (ARRIVE - 0.15)))
  const dip = s.u < 0.15 ? Math.sin((s.u / 0.15) * Math.PI) * 2 : 0
  for (let n = 4; n >= 1; n--) {
    const from = n === 4 ? L.door : L.q[n + 1]
    const P = lerpP(from, L.q[n], m)
    const moving = m > 0 && m < 1
    person(ctx, k, deskWho(s.c + n), P, t, {
      alpha: n === 4 ? clamp01(m * 2) : 1, walk: moving ? (m * 3) % 1 : null, nod: dip,
      look: n === 1 ? { x: 1.6, y: 0.2 } : { x: Math.sin((t + n * 1.7) * 0.6) * 2, y: Math.sin((t + n) * 0.45) * 0.8 },
    })
  }
  // At the desk.
  const P = s.phase === 'arrive' ? lerpP(L.q[1], L.desk, m) : L.desk
  const c = deskCandidate(s.c)
  const lookAt = s.phase === 'face' ? { x: 1.8, y: -0.4 } : s.phase === 'finger' ? { x: 1.2, y: 2.2 } : { x: 1.6, y: 0 }
  const specsOff = s.phase === 'iris' && c.glasses ? specsAmount(s.a) : 0
  const blinkNow = s.phase === 'face' && ((s.a > 0.3 && s.a < 0.35) || (s.a > 0.43 && s.a < 0.48))
  person(ctx, k, specsOff > 0 ? { ...c, glasses: false } : c, P, t, {
    walk: s.phase === 'arrive' && m < 1 && m > 0 ? (m * 3) % 1 : null, nod: s.phase === 'arrive' ? dip : 0, look: lookAt, blinkNow,
  })
  if (s.phase !== 'arrive') {
    inFig(ctx, k, L.desk, () => {
      if (s.phase === 'face') { faceCapture(ctx, s.a, c); badge(ctx, clamp01((s.a - 0.86) / 0.12), ACC, 'tick') }
      if (s.phase === 'iris') {
        if (specsOff > 0) specsInHand(ctx, specsOff, c)
        irisDevice(ctx, c.glasses ? clamp01((s.a - 0.2) / 0.7) : s.a)
        badge(ctx, clamp01((s.a - 0.84) / 0.14), ACC, 'tick')
      }
      if (s.phase === 'finger') badge(ctx, clamp01((s.a - 0.78) / 0.2), s.fail ? MARK : ACC, s.fail ? '?' : 'tick')
    })
  }
}
function brackets(ctx, a) {
  const ins = 16 - 12 * easeOutCubic(a / 0.3)
  const l = 25 - ins, r = 75 + ins, tp = 12 - ins, b = 64 + ins, len = 9
  for (const [x, sx] of [[l, 1], [r, -1]]) for (const [y, sy] of [[tp, 1], [b, -1]]) {
    line(ctx, ACC, x, y, x + sx * len, y, 2.2); line(ctx, ACC, x, y, x, y + sy * len, 2.2)
  }
  faceMesh(ctx, a, ACC)
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

// The candidate at the desk. Those sent on to iris usually wear glasses —
// so they can take them off for the scanner.
function deskCandidate(i) {
  const c = deskWho(i)
  return fails(i) && c.look !== 2 ? { ...c, glasses: true } : c      // 2 = turban: his own dark glasses
}
// Glasses off for the iris scan: lifted away (0 → 1), held, put back at the end.
function specsAmount(a) {
  const off = easeInOut(clamp01(a / 0.18))
  const back = a > 0.9 ? easeInOut((a - 0.9) / 0.1) : 0
  return off * (1 - back)
}
function specsInHand(ctx, off, c) {
  // From on the face to held low at the candidate's side, turning as they come.
  const x = 0 - 34 * off, y = 0 + 30 * off
  ctx.save()
  ctx.translate(50 + x, 48.5 + y)
  ctx.rotate(-0.5 * off)
  ctx.translate(-50, -48.5)
  strokeCircle(ctx, INK, 40.5, 48.5, 7.2, 1.5)
  strokeCircle(ctx, INK, 59.5, 48.5, 7.2, 1.5)
  line(ctx, INK, 47.7, 47.6, 52.3, 47.6, 1.5)
  line(ctx, INK, 33.3, 47.5, 26 - 4 * off, 45.5 + 3 * off, 1.4)
  line(ctx, INK, 66.7, 47.5, 74 + 3 * off, 45.5 + 2 * off, 1.4)
  fillCircle(ctx, 'rgba(255,255,255,0.35)', 38.5, 46, 2)          // a glint on the lens
  fillCircle(ctx, 'rgba(255,255,255,0.35)', 57.5, 46, 2)
  // The hand holding them by the frame.
  if (off > 0.05) {
    fillRRect(ctx, c.shade, 22.5, 42.5, 10, 11, 4.5)
    fillRRect(ctx, c.skin, 22, 42, 10, 11, 4.5)
    fillRRect(ctx, c.skin, 29, 44.5, 5.5, 3.2, 1.6)                 // thumb on the frame
  }
  ctx.restore()
}

// A photo of the candidate for the monitor: their own drawing — face,
// hair, glasses, clothes — cropped to head and shoulders.
function miniPortrait(ctx, x, y, sz, c) {
  const w = sz, h = sz * 1.15
  ctx.save()
  ctx.beginPath(); ctx.rect(x - w / 2, y - h / 2, w, h); ctx.clip()
  const k = w / 70
  ctx.translate(x - 50 * k, y - h / 2 - 1 * k)
  ctx.scale(k, k)
  drawPerson(ctx, { ...c, lookX: 0, lookY: 0 }, 1)
  ctx.restore()
}

// The face check as a photo taken at the counter: a bubble asks for a blink
// (the candidate blinks twice — liveness), the desk camera flashes, and the
// snapshot flies to the monitor, where it's matched against the record.
function faceCapture(ctx, a, c) {
  // The prompt bubble with an eye that blinks in time with the candidate.
  const bIn = easeOutBack(clamp01((a - 0.05) / 0.12)), bOut = clamp01((a - 0.52) / 0.08)
  const bs = bIn * (1 - bOut)
  if (bs > 0.01) {
    ctx.save(); ctx.translate(86, 8); ctx.scale(bs, bs)
    fillCircle(ctx, '#FFFFFF', 0, 0, 10)
    ctx.beginPath(); ctx.moveTo(-6, 6); ctx.lineTo(-11, 12); ctx.lineTo(-2, 8.5); ctx.fillStyle = '#FFFFFF'; ctx.fill()
    const shut = (a > 0.3 && a < 0.35) || (a > 0.43 && a < 0.48)
    if (shut) {
      ctx.beginPath(); ctx.moveTo(-5, 0.5); ctx.quadraticCurveTo(0, 3.5, 5, 0.5); strokeRound(ctx, ACC_DEEP, 1.3)
    } else {
      ctx.beginPath(); ctx.moveTo(-6, 0); ctx.quadraticCurveTo(0, -5.5, 6, 0); ctx.quadraticCurveTo(0, 5.5, -6, 0)
      ctx.fillStyle = '#F4F2F8'; ctx.fill()
      fillCircle(ctx, ACC, 0, 0, 2.6); fillCircle(ctx, INK, 0, 0, 1.1); fillCircle(ctx, '#FFFFFF', -0.8, -0.8, 0.5)
    }
    ctx.restore()
  }
  // The flash.
  if (a > 0.58 && a < 0.72) {
    const f = 1 - (a - 0.58) / 0.14
    fillRRect(ctx, `rgba(255,255,255,${(0.85 * f * f).toFixed(3)})`, 16, 4, 68, 66, 24)
  }
  // The snapshot, flying to the monitor.
  if (a > 0.62 && a < 0.86) {
    const m = easeInOut((a - 0.62) / 0.24)
    const x = 42 + (140 - 42) * m, y = 18 + (50 - 18) * m - Math.sin(m * Math.PI) * 14
    const sc = 1 - 0.55 * m
    ctx.save(); ctx.translate(x, y); ctx.rotate((1 - m) * -0.12); ctx.scale(sc, sc)
    fillRRect(ctx, '#FFFFFF', -9, -10, 18, 22, 2)
    fillRRect(ctx, '#EFEBF9', -7.5, -8.5, 15, 15, 1.5)
    miniPortrait(ctx, 0, -1.5, 14, c)
    ctx.restore()
  }
}

function irisDevice(ctx, a) {
  const arrive = easeInOut(clamp01(a / 0.28)) * (a > 0.88 ? 1 - easeInOut((a - 0.88) / 0.12) : 1)
  const cx = 72 + (1 - arrive) * 70, cy = 48 + (1 - arrive) * 18
  // Cable, trailing back to the laptop.
  ctx.beginPath(); ctx.moveTo(cx + 15, cy + 3)
  ctx.bezierCurveTo(cx + 30, cy + 12, cx + 40, cy + 34, cx + 64, cy + 40)
  strokeRound(ctx, '#3B3F4D', 1.6)
  // The agent's hand round the grip.
  fillRRect(ctx, '#F1D2B6', cx + 5, cy - 3, 16, 13, 6)
  fillRRect(ctx, '#E0B896', cx + 6, cy + 5, 13, 3, 1.5)
  // Body, lens housing, lens.
  fillRRect(ctx, '#3B3F4D', cx - 13, cy - 8, 28, 16, 6)
  fillRRect(ctx, '#4A4F60', cx - 12, cy - 7, 26, 5, 3)
  fillCircle(ctx, '#23262F', cx - 9, cy, 7.2)
  fillCircle(ctx, '#1B2230', cx - 9, cy, 5.4)
  fillCircle(ctx, '#2E3F5C', cx - 9, cy, 3.8)
  fillCircle(ctx, ACC, cx - 9, cy, 1.9)
  fillCircle(ctx, 'rgba(255,255,255,0.8)', cx - 10.4, cy - 1.6, 0.9)
  // Infrared LEDs round the lens, flashing while it reads.
  const reading = a > 0.3 && a < 0.86
  for (let j = 0; j < 6; j++) {
    const an = (j / 6) * TAU + 0.3
    const on = reading && Math.sin(a * 80 + j) > 0
    fillCircle(ctx, on ? '#B9A6F0' : '#555A6B', cx - 9 + Math.cos(an) * 6.3, cy + Math.sin(an) * 6.3, 0.7)
  }
  fillCircle(ctx, reading ? ACC : '#555A6B', cx + 11, cy - 5, 0.9)
  if (reading) {
    // A ring settles onto the eye, and a band reads it.
    const f = ((a - 0.3) / 0.56 * 2) % 1
    strokeCircle(ctx, withAlpha(ACC, 0.9 * (1 - f)), 59.5, 48.5, 4 + 9 * (1 - f), 1.4)
    strokeCircle(ctx, withAlpha(ACC, 0.5), 59.5, 48.5, 5.2, 0.8)
  }
}
function badge(ctx, p, color, glyph) {
  if (p <= 0) return
  const tx = 50, ty = -14
  const sc = 0.85 + 0.15 * easeOutBack(clamp01(p * 1.4))
  ctx.save(); ctx.translate(tx, ty); ctx.scale(sc, sc); ctx.translate(-tx, -ty)
  fillCircle(ctx, '#FFFFFF', tx, ty, 10.5)
  // The ring draws round, then the mark writes itself.
  const ring = clamp01(p * 1.6)
  ctx.beginPath(); ctx.arc(tx, ty, 10, -Math.PI / 2, -Math.PI / 2 + ring * TAU)
  strokeRound(ctx, color, 2.2)
  const mk = clamp01((p - 0.35) / 0.65)
  if (glyph === 'tick' && mk > 0) {
    const pts = [[tx - 4.5, ty], [tx - 1, ty + 3.6], [tx + 5, ty - 4]]
    const l1 = Math.hypot(3.5, 3.6), l2 = Math.hypot(6, 7.6), total = (l1 + l2) * mk
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1])
    if (total <= l1) ctx.lineTo(pts[0][0] + 3.5 * (total / l1), pts[0][1] + 3.6 * (total / l1))
    else { ctx.lineTo(pts[1][0], pts[1][1]); const f = (total - l1) / l2; ctx.lineTo(pts[1][0] + 6 * f, pts[1][1] - 7.6 * f) }
    strokeRound(ctx, color, 2.4)
  } else if (mk > 0) {
    ctx.globalAlpha = mk
    ctx.fillStyle = color; ctx.font = '700 14px "Bricolage Grotesque", system-ui, sans-serif'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('?', tx, ty + 0.5)
  }
  ctx.restore()
}

// L4: the counter and everything on it.
function paintCounter(ctx, w, h, t, L) {
  const s = sceneAt(t)
  const { k, counterTop } = L
  const x0 = L.counterX
  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(x0, counterTop, w - x0 + 2, h - counterTop)
  line(ctx, LINE, x0, counterTop, x0, h, 1)
  fillRRect(ctx, '#FFFFFF', x0 - 10, counterTop - 10, w - x0 + 20, 12, 4)
  line(ctx, LINE, x0 - 10, counterTop + 1, w + 10, counterTop + 1, 1)
  // The tricolour strip along the front.
  const sy = counterTop + (h - counterTop) * 0.64, sw = w - x0 + 2
  ctx.fillStyle = SAFFRON; ctx.fillRect(x0, sy, sw, 3)
  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(x0, sy + 3, sw, 3)
  ctx.fillStyle = GREEN; ctx.fillRect(x0, sy + 6, sw, 3)
  // What the desk is doing, on the counter front.
  const ph = phaseAt(t)
  const caption = ph === 'done' ? 'Verified'
    : s.phase === 'arrive' ? 'Next candidate'
    : s.phase === 'face' ? 'Checking face and liveness'
    : s.phase === 'finger' ? (ph === 'fail' ? 'The print didn\'t read' : 'Checking fingerprint') : 'Checking iris'
  ctx.fillStyle = ph === 'done' ? ACC : MUTED
  ctx.font = `600 ${Math.round(Math.max(14, Math.min(20, h * 0.021)))}px "Bricolage Grotesque", system-ui, sans-serif`
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
  ctx.fillText(caption, x0 + 22, counterTop + (h - counterTop) * 0.36)

  inFig(ctx, k, L.desk, () => kit(ctx, t, s))
}

// The verification kit, in the desk candidate's figure space (counter top at y 88).
function kit(ctx, t, s) {
  const ph = phaseAt(t)
  const col = s.fail ? MARK : ACC
  const reading = s.phase === 'finger' && s.a > 0.3 && s.a < 0.9
  const cable = (x0, y0, x1, y1, sag) => {
    ctx.beginPath(); ctx.moveTo(x0, y0)
    ctx.bezierCurveTo(x0 + (x1 - x0) * 0.3, y0 + sag, x0 + (x1 - x0) * 0.7, y1 + sag, x1, y1)
    strokeRound(ctx, '#3B3F4D', 1.4)
  }

  // Cables first, so the devices sit on them.
  cable(110, 84, 160, 86, 5)                       // reader → laptop
  cable(146, 86, 160, 86.5, 2)                     // display → laptop
  if (s.phase !== 'iris') cable(212, 85, 205, 86, 3)

  // ── Fingerprint reader: dark body, glass platen that lights as it reads.
  fillRRect(ctx, '#2B2E3A', 76, 77, 36, 11, 5)
  fillRRect(ctx, '#3B3F4D', 77, 74.5, 34, 9, 4.5)
  fillRRect(ctx, '#4A4F60', 78, 75, 32, 2.4, 1.2)
  fillRRect(ctx, reading ? withAlpha(col, 0.7) : '#1B2230', 86, 76, 16, 6, 2)
  if (reading) {
    for (let r = 1; r <= 3; r++) {
      ctx.beginPath(); ctx.ellipse(94, 79.5, r * 2.2, r * 1.2, 0, Math.PI, TAU)
      strokeRound(ctx, 'rgba(255,255,255,0.55)', 0.5)
    }
  }
  const ledOn = s.phase === 'finger' ? (reading ? Math.sin(t * 16) > 0 : s.a > 0.9) : false
  fillCircle(ctx, ledOn ? col : withAlpha(ACC, 0.35), 80.5, 79, 1.1)
  line(ctx, '#5B6072', 104.5, 79, 108.5, 79, 0.8)
  if (s.phase === 'finger') {
    // The candidate's right arm: sleeve from the shoulder, a hand with curled
    // fingers and knuckles, the thumb coming down flat onto the platen.
    const c = deskCandidate(s.c)
    const down = easeInOut(clamp01(s.a / 0.3)) * (s.a > 0.9 ? 1 - easeInOut((s.a - 0.9) / 0.1) : 1)
    const hx = 95, hy = 67 - (1 - down) * 9                          // hand centre
    const sh = { x: 80, y: 74 }                                      // shoulder, behind the counter edge
    ctx.lineCap = 'round'
    ctx.beginPath(); ctx.moveTo(sh.x + 0.6, sh.y + 0.8); ctx.quadraticCurveTo(hx - 12, hy + 6, hx - 5, hy + 2.5)
    ctx.lineWidth = 11; ctx.strokeStyle = c.shirtDk; ctx.stroke()
    ctx.beginPath(); ctx.moveTo(sh.x, sh.y); ctx.quadraticCurveTo(hx - 12.5, hy + 5, hx - 5.5, hy + 1.8)
    ctx.lineWidth = 10; ctx.strokeStyle = c.shirt; ctx.stroke()
    // Wrist and palm, one-step shadow.
    fillRRect(ctx, c.skin, hx - 8, hy - 2, 6, 7, 3)
    fillRRect(ctx, c.shade, hx - 5.2, hy - 3.6, 12, 9.4, 4.2)
    fillRRect(ctx, c.skin, hx - 5.8, hy - 4.2, 12, 9.4, 4.2)
    // Curled fingers on the far side: a knuckle each, creases between.
    for (let i = 0; i < 4; i++) {
      fillCircle(ctx, c.skin, hx + 5.6, hy - 2.8 + i * 2.3, 1.45)
      if (i < 3) line(ctx, c.shade, hx + 2.2, hy - 1.7 + i * 2.3, hx + 6.4, hy - 1.7 + i * 2.3, 0.6)
    }
    // The thumb, pointing down onto the glass, with its nail.
    fillRRect(ctx, c.shade, hx - 2, hy + 3.4, 5, 8.2, 2.5)
    fillRRect(ctx, c.skin, hx - 2.5, hy + 3, 5, 8.2, 2.5)
    line(ctx, c.shade, hx - 1.8, hy + 6, hx + 1.8, hy + 6, 0.6)
    fillRRect(ctx, 'rgba(255,255,255,0.45)', hx - 1.5, hy + 8.4, 3, 2.2, 1.1)
    if (reading) {
      const f = ((s.a - 0.3) / 0.6 * 2) % 1
      for (let j = 0; j < 3; j++) { const q = (f + j / 3) % 1; strokeCircle(ctx, withAlpha(col, 0.9 * (1 - q)), 94, 79, 2 + 9 * q, 1.2) }
    }
  }

  // ── Candidate-facing display with the webcam on top. Shows the check live.
  fillRRect(ctx, '#D3CEE4', 131, 70, 8, 16, 2)
  fillRRect(ctx, '#C9C3DB', 123, 85, 24, 3.5, 1.7)
  fillRRect(ctx, '#2B2E3A', 115, 40, 40, 32, 3.5)
  const SX = 117.5, SY = 42.5, SW = 35, SH = 27
  fillRRect(ctx, '#FFFFFF', SX, SY, SW, SH, 2)
  ctx.save(); ctx.beginPath(); ctx.rect(SX, SY, SW, SH); ctx.clip()
  ctx.fillStyle = ACC; ctx.fillRect(SX, SY, SW, 3.4)
  fillCircle(ctx, '#FFFFFF', SX + 2.4, SY + 1.7, 0.7)
  const cxs = SX + SW / 2, cys = SY + 13.5
  if (s.phase === 'finger' || s.phase === 'iris') {
    const who = deskCandidate(s.c)
    fillRRect(ctx, '#EFEBF9', SX + 1.5, SY + 5, 7, 8, 1)
    miniPortrait(ctx, SX + 5, SY + 9, 6.6, who)
    fillRRect(ctx, '#D3CEE4', SX + 1.5, SY + 14, 7, 1, 0.5)
    fillRRect(ctx, '#E3E1EA', SX + 1.5, SY + 16, 5, 1, 0.5)
  }
  if (s.phase === 'arrive') {
    const pulse = 0.5 + 0.5 * Math.sin(t * 4)
    fillCircle(ctx, withAlpha(TINT_S, 0.6 + 0.4 * pulse), cxs, cys - 1.5, 4.2)
    fillRRect(ctx, withAlpha(TINT_S, 0.6 + 0.4 * pulse), cxs - 7, cys + 3.5, 14, 6, 3)
  } else if (s.phase === 'face') {
    // On record (left) and live (right); when the snapshot lands, they slide together and match.
    const c = deskCandidate(s.c)
    const land = clamp01((s.a - 0.8) / 0.06)
    const merge = easeInOut(clamp01((s.a - 0.86) / 0.1))
    const off = 8.5 * (1 - merge)
    fillRRect(ctx, '#EFEBF9', cxs - off - 6, cys - 7, 12, 13, 1.5)
    miniPortrait(ctx, cxs - off, cys - 1, 11, c)
    fillRRect(ctx, '#EFEBF9', cxs + off - 6, cys - 7, 12, 13, 1.5)
    if (land > 0) { ctx.save(); ctx.globalAlpha = land; miniPortrait(ctx, cxs + off, cys - 1, 11, c); ctx.restore() }
    else {
      fillRRect(ctx, '#C9C3DB', cxs + off - 2.2, cys - 2.4, 4.4, 3, 0.8)          // a camera, waiting
      fillCircle(ctx, '#EFEBF9', cxs + off, cys - 0.9, 0.9)
    }
    if (merge > 0.6) {
      const q = easeOutBack(clamp01((merge - 0.6) / 0.4))
      fillCircle(ctx, ACC, cxs + 5, cys + 4, 2.6 * q)
      if (q > 0.6) { ctx.beginPath(); ctx.moveTo(cxs + 3.9, cys + 4); ctx.lineTo(cxs + 4.7, cys + 4.8); ctx.lineTo(cxs + 6.2, cys + 3.1); strokeRound(ctx, '#FFFFFF', 0.6) }
    }
  } else if (s.phase === 'finger') {
    // The print draws itself, ridge by ridge.
    const n = 6, shown = s.a * n * 1.2
    for (let r = 1; r <= n; r++) {
      const f = clamp01(shown - (r - 1))
      if (f <= 0) break
      ctx.beginPath()
      ctx.ellipse(cxs, cys + 1, r * 1.25, r * 1.6, 0, Math.PI * 1.1, Math.PI * 1.1 + Math.PI * 1.8 * f)
      strokeRound(ctx, ph === 'fail' ? MARK : ACC, 0.7)
    }
  } else if (s.phase === 'iris') {
    ctx.beginPath(); ctx.moveTo(cxs - 9, cys); ctx.quadraticCurveTo(cxs, cys - 7, cxs + 9, cys); ctx.quadraticCurveTo(cxs, cys + 7, cxs - 9, cys)
    ctx.fillStyle = '#F4F2F8'; ctx.fill(); strokeRound(ctx, INK, 0.7)
    fillCircle(ctx, ACC, cxs, cys, 3.2); fillCircle(ctx, INK, cxs, cys, 1.4)
    const f = (s.a * 3) % 1
    strokeCircle(ctx, withAlpha(ACC, 1 - f), cxs, cys, 3.4 + 4 * f, 0.6)
  }
  if (ph === 'done') {
    // The verdict, over whatever was on screen.
    ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fillRect(SX, SY + 3.4, SW, SH - 3.4)
    const q = clamp01((s.a - 0.82) / 0.14)
    fillCircle(ctx, ACC, cxs, cys, 5.5 * easeOutBack(clamp01(q * 1.5)))
    if (q > 0.35) {
      const m2 = clamp01((q - 0.35) / 0.65)
      ctx.beginPath(); ctx.moveTo(cxs - 2.5, cys)
      if (m2 < 0.4) ctx.lineTo(cxs - 2.5 + 1.8 * (m2 / 0.4), cys + 1.9 * (m2 / 0.4))
      else { ctx.lineTo(cxs - 0.7, cys + 1.9); ctx.lineTo(cxs - 0.7 + 3.6 * ((m2 - 0.4) / 0.6), cys + 1.9 - 4.2 * ((m2 - 0.4) / 0.6)) }
      strokeRound(ctx, '#FFFFFF', 1.1)
    }
  }
  // Progress along the bottom: three steps.
  const steps = s.fail ? 3 : 2
  const idx = s.phase === 'arrive' ? 0 : s.phase === 'face' ? 0 : s.phase === 'finger' ? 1 : 2
  const prog = s.phase === 'arrive' ? 0 : (idx + clamp01(s.a / 0.9)) / steps
  fillRRect(ctx, TINT_S, SX + 3, SY + SH - 3.2, SW - 6, 1.4, 0.7)
  fillRRect(ctx, ph === 'fail' ? MARK : ACC, SX + 3, SY + SH - 3.2, (SW - 6) * clamp01(prog), 1.4, 0.7)
  ctx.restore()
  // The webcam, clipped on top of the display.
  const live = s.phase === 'face' && s.a > 0.05 && s.a < 0.95
  fillRRect(ctx, '#2B2E3A', 128, 35.5, 14, 6, 3)
  fillCircle(ctx, '#1B2230', 135, 38.5, 2.1)
  fillCircle(ctx, '#2E3F5C', 135, 38.5, 1.3)
  fillCircle(ctx, 'rgba(255,255,255,0.7)', 134.4, 37.9, 0.45)
  fillCircle(ctx, live ? ACC : '#555A6B', 139.8, 37.5, 0.7)

  // ── Laptop, its back to us: keyboard deck, lid, the portal's mark.
  fillRRect(ctx, '#C9C3DB', 155, 84.5, 54, 3.5, 1.7)
  ctx.fillStyle = '#E3E1EA'
  ctx.beginPath(); ctx.moveTo(160, 86); ctx.lineTo(162, 70); ctx.lineTo(202, 70); ctx.lineTo(204, 86); ctx.closePath(); ctx.fill()
  line(ctx, '#D3CEE4', 162.5, 71, 201.5, 71, 1)
  ctx.save(); ctx.translate(182, 78); ctx.scale(0.36, 0.36)
  ctx.beginPath(); ctx.moveTo(0, -14); ctx.lineTo(-12, -9); ctx.lineTo(-12, 1); ctx.quadraticCurveTo(-12, 9, 0, 14)
  ctx.quadraticCurveTo(12, 9, 12, 1); ctx.lineTo(12, -9); ctx.closePath(); ctx.fillStyle = ACC; ctx.fill()
  ctx.restore()
  fillCircle(ctx, (t % 3) < 1.5 ? ACC : TINT_S, 206, 86, 0.6)

  // ── The iris scanner, resting on the counter until it's needed.
  if (s.phase !== 'iris') {
    fillRRect(ctx, '#3B3F4D', 212, 80, 22, 8, 4)
    fillRRect(ctx, '#4A4F60', 213, 80.5, 20, 2.4, 1.2)
    fillCircle(ctx, '#1B2230', 216.5, 84, 3)
    fillCircle(ctx, '#2E3F5C', 216.5, 84, 1.9)
    fillCircle(ctx, ACC, 216.5, 84, 0.9)
  }

  // ── A small tiranga on its stand, fluttering.
  const FX = 240, FS = 0.7
  line(ctx, '#8D8898', FX, 86, FX, 86 - 34 * FS, 1.4)
  fillRRect(ctx, '#8D8898', FX - 5, 84, 10, 3, 1.5)
  const fy = 86 - 34 * FS, band = 3.4 * FS, fw = 18 * FS
  const fl = (y, c2) => {
    ctx.beginPath(); ctx.moveTo(FX, y)
    for (let j = 0; j <= 10; j++) ctx.lineTo(FX + (j / 10) * fw, y + Math.sin(t * 4 + j * 0.7) * 0.8 * (j / 10))
    for (let j = 10; j >= 0; j--) ctx.lineTo(FX + (j / 10) * fw, y + band + Math.sin(t * 4 + j * 0.7) * 0.8 * (j / 10))
    ctx.closePath(); ctx.fillStyle = c2; ctx.fill()
  }
  fl(fy, SAFFRON); fl(fy + band, '#FFFFFF'); fl(fy + band * 2, GREEN)
  strokeCircle(ctx, CHAKRA, FX + fw / 2, fy + band * 1.5, 1.1 * FS + 0.4, 0.5)
}

// L5: the extreme foreground — a potted plant at the corner, very soft.
function paintForeground(ctx, w, h, t) {
  const bx = w * 0.02, by = h
  const sway = Math.sin(t * 0.9) * 3
  const leaves = [[-0.2, 0.34, 0.07, '#2F6B3A'], [0.25, 0.3, 0.06, '#3C7D45'], [-0.55, 0.22, 0.06, '#3C7D45'], [0.6, 0.2, 0.05, '#2F6B3A'], [0, 0.42, 0.06, '#4A8C4E']]
  for (const [ang, len, wd, col] of leaves) {
    const L2 = h * len, a = -Math.PI / 2 + ang + Math.sin(t * 0.9 + ang * 3) * 0.04
    const tx = bx + Math.cos(a) * L2 + sway, ty = by - h * 0.06 + Math.sin(a) * L2
    ctx.beginPath(); ctx.moveTo(bx, by - h * 0.06)
    ctx.quadraticCurveTo((bx + tx) / 2 - Math.sin(a) * h * wd, (by - h * 0.06 + ty) / 2 + Math.cos(a) * h * wd, tx, ty)
    ctx.quadraticCurveTo((bx + tx) / 2 + Math.sin(a) * h * wd, (by - h * 0.06 + ty) / 2 - Math.cos(a) * h * wd, bx, by - h * 0.06)
    ctx.fillStyle = col; ctx.fill()
  }
  fillRRect(ctx, '#C58226', bx - w * 0.05, by - h * 0.09, w * 0.1, h * 0.12, 6)
  fillRRect(ctx, '#A66E1E', bx - w * 0.055, by - h * 0.095, w * 0.11, h * 0.02, 4)
}

// ── Component ─────────────────────────────────────────────────────────
// Layers, back to front, with their depth (parallax) and blur (depth of field).
const LAYERS = [
  { key: 'floor', depth: 0.25, blur: 0 },
  { key: 'wall', depth: 0.12, blur: 1.7 },
  { key: 'row0', depth: 0.3, blur: 1.3 },
  { key: 'mid', depth: 0.42, blur: 0.8 },
  { key: 'row2', depth: 0.6, blur: 0.35 },
  { key: 'action', depth: 0.82, blur: 0 },
  // children slot here
  { key: 'counter', depth: 1, blur: 0 },
  { key: 'fore', depth: 1.7, blur: 5 },
]

export default function ClassroomScene({ className, style, onPhase, children }) {
  const wrapRef = useRef(null)
  const refs = useRef([])
  const slotRef = useRef(null)
  const phaseCb = useRef(onPhase)
  phaseCb.current = onPhase

  useEffect(() => {
    const wrap = wrapRef.current
    const cvs = refs.current
    const ctxs = cvs.map((c) => c.getContext('2d'))
    let w = 0, h = 0, raf = 0, last = performance.now(), lastPhase = '', t = 0.6
    const par = { x: 0, tx: 0 }
    const onMove = (e) => { par.tx = (e.clientX / window.innerWidth - 0.5) * 2 }
    window.addEventListener('pointermove', onMove, { passive: true })
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')

    const draw = () => {
      if (!w || !h) return
      const L = layout(w, h)
      ctxs.forEach((c) => c.clearRect(0, 0, w, h))
      const [F, W, R0, M, R2, A, C, FG] = ctxs
      paintFloor(F, w, h, t, L)
      paintWall(W, w, h, t, L)
      paintRow(R0, w, h, t, L, 0, 0)
      paintFans(M, w, h, t); paintRow(M, w, h, t, L, 1, 9); paintTeacher(M, w, h, t, L)
      paintBeams(R2, w, h, t, L); paintRow(R2, w, h, t, L, 2, 17)
      paintAction(A, w, h, t, L)
      paintCounter(C, w, h, t, L)
      paintForeground(FG, w, h, t)
      // The frame is locked off: depth comes from focus, scale and overlap,
      // not from moving the camera.
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
        const b = LAYERS[i].blur * (h / 900)
        c.style.filter = b > 0.05 ? `blur(${b.toFixed(2)}px)` : 'none'
        // Blurred layers are scaled a hair so their soft edges stay outside the frame.
        c.style.transform = b > 0.05 ? 'scale(1.02)' : 'none'
      })
      draw()
    }
    const frame = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000); last = now
      if (!document.hidden) {
        t += dt
        par.x += (par.tx - par.x) * Math.min(1, dt * 3)
        draw()
      }
      raf = requestAnimationFrame(frame)
    }
    const start = () => {
      cancelAnimationFrame(raf)
      // Review aid: ?scene_t=<seconds> freezes the scene at that moment.
      const qt = Number(new URLSearchParams(window.location.search).get('scene_t'))
      if (qt > 0) { t = qt; draw(); return }
      if (reduce?.matches) { t = ARRIVE + CHECK * 1.5; draw(); return }
      last = performance.now(); raf = requestAnimationFrame(frame)
    }
    const ro = new ResizeObserver(resize)
    ro.observe(wrap)
    resize(); start()
    reduce?.addEventListener?.('change', start)
    document.fonts?.ready?.then(draw)
    return () => {
      cancelAnimationFrame(raf); ro.disconnect()
      window.removeEventListener('pointermove', onMove)
      reduce?.removeEventListener?.('change', start)
    }
  }, [])

  const layer = { position: 'absolute', inset: 0, display: 'block', pointerEvents: 'none', willChange: 'transform' }
  const slotAt = LAYERS.findIndex((l) => l.key === 'counter')
  return (
    <div ref={wrapRef} className={className} style={{ position: 'relative', overflow: 'hidden', background: WALL, ...style }}>
      {LAYERS.map((ly, i) => (
        <FragmentLayer key={ly.key} before={i === slotAt}
          slot={<div ref={slotRef} style={{ position: 'absolute', inset: 0, willChange: 'transform' }}>{children}</div>}>
          <canvas ref={(el) => { refs.current[i] = el }} style={layer} aria-hidden="true" />
        </FragmentLayer>
      ))}
    </div>
  )
}

function FragmentLayer({ before, slot, children }) {
  return (<>{before ? slot : null}{children}</>)
}
