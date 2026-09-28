import { useEffect, useRef } from 'react'
import { drawPerson, makeCast, easeOutBack, clamp01 } from '../login/people.js'

// FvBackdrop — the admin pages' living background, over the whole screen.
//
// Two things, drawn flat in FlatViolet:
//   · the Ashoka chakra, turning slowly in the bottom-right
//   · a queue of candidates stepping through a checkpoint along the foot of
//     the page: a face frame locks on, a badge pops (India green verified,
//     amber denied) and they move on — no two faces alike
// The cards over it are slightly see-through, so it lives under everything.
// Canvas, 30 fps, pauses while the tab is hidden; a still frame for reduced
// motion.

const V = '#5B3FA6', VD = '#43307D', VS = '#9A86D6', TINT = '#DDD5F2'
const SAF = '#F28C28', GRN = '#138808', MARK = '#A8711F', W = '#FFFFFF'
const TAU = Math.PI * 2
const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x) }
const easeInOut = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2)
const CAST = makeCast(48)

// ── Ashoka chakra ─────────────────────────────────────────────────────
function chakra(ctx, cx, cy, R, t, alpha) {
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.translate(cx, cy); ctx.rotate(t * 0.08)
  ctx.strokeStyle = VD; ctx.fillStyle = VD
  ctx.lineWidth = R * 0.07
  ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.stroke()
  ctx.lineWidth = R * 0.018
  ctx.beginPath(); ctx.arc(0, 0, R * 0.86, 0, TAU); ctx.stroke()
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * TAU
    // a tapered spoke
    ctx.save(); ctx.rotate(a)
    ctx.beginPath()
    ctx.moveTo(R * 0.13, -R * 0.012); ctx.lineTo(R * 0.5, -R * 0.03); ctx.lineTo(R * 0.86, 0)
    ctx.lineTo(R * 0.5, R * 0.03); ctx.lineTo(R * 0.13, R * 0.012); ctx.closePath(); ctx.fill()
    // the little scallop on the rim between spokes
    ctx.rotate(TAU / 48)
    ctx.beginPath(); ctx.arc(R * 0.905, 0, R * 0.028, 0, TAU); ctx.fill()
    ctx.restore()
  }
  ctx.beginPath(); ctx.arc(0, 0, R * 0.13, 0, TAU); ctx.fill()
  ctx.restore()
}

// ── The checkpoint queue along the foot of the page ───────────────────
function queue(ctx, x0, w, h, t, alpha) {
  ctx.save(); ctx.beginPath(); ctx.rect(x0, 0, w - x0, h); ctx.clip()   // never behind the sidebar
  const S = 88, P = 2.8, M = 0.85, scale = 0.72
  const gateX = x0 + (w - x0) * 0.6
  const base = h + 4
  const k = Math.floor(t / P), f = t % P
  const prog = k + easeInOut(clamp01(f / M))
  const c = clamp01((f - M) / (P - M))
  const fails = (j) => hash(j * 7.3) < 0.2

  // the floor line
  ctx.globalAlpha = alpha * 0.8
  ctx.strokeStyle = TINT; ctx.lineWidth = 2; ctx.setLineDash([6, 6])
  ctx.beginPath(); ctx.moveTo(x0, h - 6); ctx.lineTo(w, h - 6); ctx.stroke(); ctx.setLineDash([])

  const jMin = Math.floor(prog - (gateX - x0) / S) - 1, jMax = Math.ceil(prog + (w - gateX) / S) + 1
  for (let j = jMin; j <= jMax; j++) {
    const x = gateX + (j - prog) * S
    const moving = f < M
    const bob = moving ? Math.abs(Math.sin((f / M) * Math.PI * 2)) * 4 : Math.sin(t * 1.6 + j) * 0.8
    const p = CAST[((j % CAST.length) + CAST.length) % CAST.length]
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.translate(x - 50 * scale, base - 100 * scale - bob)
    ctx.scale(scale, scale)
    drawPerson(ctx, p, (t + j) % 4.1 > 0.12)
    ctx.restore()
    // badge above those through the gate (and the one being checked, once decided)
    const done = j <= k || (j === k + 1 && c > 0.5)
    if (done) {
      const pop = j === k + 1 ? easeOutBack(clamp01((c - 0.5) / 0.15)) : 1
      const bx = x + 26, by = base - 100 * scale - 2 - bob, r = 9 * pop
      ctx.globalAlpha = alpha * 1.3
      ctx.fillStyle = fails(j) ? MARK : GRN
      ctx.beginPath(); ctx.arc(bx, by, r, 0, TAU); ctx.fill()
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
      ctx.beginPath()
      if (fails(j)) { ctx.moveTo(bx - r * 0.35, by - r * 0.35); ctx.lineTo(bx + r * 0.35, by + r * 0.35); ctx.moveTo(bx + r * 0.35, by - r * 0.35); ctx.lineTo(bx - r * 0.35, by + r * 0.35) }
      else { ctx.moveTo(bx - r * 0.42, by); ctx.lineTo(bx - r * 0.1, by + r * 0.32); ctx.lineTo(bx + r * 0.44, by - r * 0.3) }
      ctx.stroke()
    }
  }

  // the gate: two posts, a beam with a camera and a status light
  const gh = 100 * scale + 34
  ctx.globalAlpha = alpha * 1.1
  ctx.fillStyle = VS
  ctx.fillRect(gateX - S / 2 - 3, base - gh, 6, gh)
  ctx.fillRect(gateX + S / 2 - 3, base - gh, 6, gh)
  ctx.fillStyle = VD
  ctx.fillRect(gateX - S / 2 - 6, base - gh - 8, S + 12, 9)
  ctx.fillRect(gateX - 9, base - gh + 1, 18, 9)
  const decided = c > 0.5
  ctx.fillStyle = decided ? (fails(k + 1) ? MARK : GRN) : SAF
  ctx.beginPath(); ctx.arc(gateX + S / 2 - 12, base - gh - 3.5, 3, 0, TAU); ctx.fill()

  // the face frame locking on to whoever is at the gate
  if (f >= M && c < 0.62) {
    const lock = easeInOut(clamp01(c / 0.3))
    const fx = gateX, fy = base - 100 * scale * 0.62
    const half = 42 - 16 * lock, arm = 9
    ctx.globalAlpha = alpha * 1.5 * (c > 0.52 ? 1 - (c - 0.52) / 0.1 : 1)
    ctx.strokeStyle = V; ctx.lineWidth = 2.4; ctx.lineCap = 'round'
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      ctx.beginPath()
      ctx.moveTo(fx + sx * half, fy + sy * (half - arm)); ctx.lineTo(fx + sx * half, fy + sy * half); ctx.lineTo(fx + sx * (half - arm), fy + sy * half)
      ctx.stroke()
    }
  }
  ctx.restore()
}

// The hall, mid-exam: candidates at their desks, heads down, pencils
// going. Now and then one sits up to think, and one puts a hand up for
// the invigilator. Drawn along the foot of the page, like the queue.
function hall(ctx, x0, w, h, t, alpha) {
  ctx.save(); ctx.beginPath(); ctx.rect(x0, 0, w - x0, h); ctx.clip()
  const S = 128, scale = 0.62, base = h + 2
  const first = Math.floor((x0 - 40) / S), last = Math.ceil((w + 40) / S)

  // the floor
  ctx.globalAlpha = alpha * 0.8
  ctx.strokeStyle = TINT; ctx.lineWidth = 2; ctx.setLineDash([6, 6])
  ctx.beginPath(); ctx.moveTo(x0, h - 8); ctx.lineTo(w, h - 8); ctx.stroke(); ctx.setLineDash([])

  for (let j = first; j <= last; j++) {
    const x = j * S + S / 2
    const p = CAST[((j % CAST.length) + CAST.length) % CAST.length]
    const ph = hash(j * 3.1) * 10
    const think = (t + ph) % 11 < 1.6            // sits up to think
    const raise = hash(j * 5.7) > 0.86 && ((t + ph) % 17) < 3   // hand up
    const lean = think ? 0 : 5                   // head down over the paper
    const bob = Math.sin((t + ph) * 3.4) * (think ? 0.6 : 1.6)

    // the candidate
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.translate(x - 50 * scale, base - 100 * scale - 26 + lean + bob)
    ctx.scale(scale, scale)
    drawPerson(ctx, p, (t + j) % 5.3 > 0.14)
    ctx.restore()

    // a hand up for the invigilator
    if (raise) {
      const k = clamp01(((t + ph) % 17) / 0.5)
      ctx.globalAlpha = alpha
      ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 7; ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(x + 20, base - 44)
      ctx.lineTo(x + 26, base - 44 - 34 * k)
      ctx.stroke()
      ctx.fillStyle = '#F3EAD9'
      ctx.beginPath(); ctx.arc(x + 27, base - 46 - 34 * k, 6, 0, TAU); ctx.fill()
    }

    // the desk, in front of them
    ctx.globalAlpha = alpha * 1.05
    ctx.fillStyle = VD
    ctx.fillRect(x - 46, base - 30, 92, 6)
    ctx.fillStyle = VS
    ctx.fillRect(x - 40, base - 24, 80, 26)

    // the paper, and the pencil going along the line
    ctx.globalAlpha = alpha
    ctx.fillStyle = W
    ctx.fillRect(x - 22, base - 30, 40, 9)
    ctx.strokeStyle = VS; ctx.lineWidth = 1
    for (let r = 0; r < 2; r++) {
      ctx.beginPath(); ctx.moveTo(x - 18, base - 27 + r * 3.4); ctx.lineTo(x + 8, base - 27 + r * 3.4); ctx.stroke()
    }
    if (!think) {
      const px = x - 18 + (((t * 22 + ph * 30) % 26))
      ctx.strokeStyle = SAF; ctx.lineWidth = 2.4
      ctx.beginPath(); ctx.moveTo(px, base - 26); ctx.lineTo(px + 5, base - 34); ctx.stroke()
    }
  }
  ctx.restore()
}

function drawScene(ctx, w, h, t, left, variant) {
  const main = Math.max(1, w - left)
  chakra(ctx, w - main * 0.1, h * 0.8, Math.max(20, Math.min(main, h) * 0.3), t, 0.1)
  if (variant === 'hall') hall(ctx, left, w, h, t, 0.13)
  else if (variant !== 'none') queue(ctx, left, w, h, t, 0.13)
  ctx.globalAlpha = 1
}

export default function FvBackdrop({ left = 264, variant = 'queue' }) {
  const ref = useRef(null)
  const leftRef = useRef(left)
  const variantRef = useRef(variant)
  variantRef.current = variant
  leftRef.current = left
  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas.getContext('2d')
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    let raf = 0, last = 0, clock = 8, prev = null, w = 0, h = 0
    const size = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      w = window.innerWidth; h = window.innerHeight
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    // A drawing error must never take the page down with it.
    const draw = () => { ctx.clearRect(0, 0, w, h); try { drawScene(ctx, w, h, clock, leftRef.current, variantRef.current) } catch { /* skip this frame */ } }
    const frame = (now) => {
      raf = requestAnimationFrame(frame)
      if (now - last < 33) return
      if (prev != null) clock += Math.min(0.1, (now - prev) / 1000)
      prev = now; last = now
      draw()
    }
    const onVis = () => {
      if (document.hidden) { cancelAnimationFrame(raf); raf = 0; prev = null }
      else if (!reduced && !raf) raf = requestAnimationFrame(frame)
    }
    const onResize = () => { size(); draw() }
    size(); draw()
    if (!reduced) raf = requestAnimationFrame(frame)
    window.addEventListener('resize', onResize)
    document.addEventListener('visibilitychange', onVis)
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', onResize); document.removeEventListener('visibilitychange', onVis) }
  }, [])
  return <canvas ref={ref} aria-hidden="true" className="pointer-events-none fixed inset-0 z-0 h-screen w-screen" />
}
