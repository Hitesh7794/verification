// Verifier — the login's companion character.
//
// A line-for-line port of the Android Compose drawing
//   mobile-android/app/src/main/java/com/innovatiview/verification/ui/login/Verifier.kt
// onto an HTML <canvas> 2D context. Same 100×100 grid, same geometry, same
// numbers, same draw order, same dials and springs. Colours are the ACTIVE
// Android scheme (FlatViolet, built on Flat → HumanEye) from ui/common/Scheme.kt.
//
// He reacts to what the operator is doing:
//   idle      open eyes, small smile. Left alone for a few seconds he takes
//             his phone out and scrolls it (eyes down, thumb flicking); any
//             activity puts it away.
//   wave      right hand up beside the head, waving; big smile
//   typing    a keyboard slides up and his hands tap the keys — one hand hops
//             per keystroke (count changes), alternating; eyes follow the caret
//   covered   hands over the eyes; `peek` drops them so he looks down at it
//   waiting   hands rest on the keys, eyes up, mouth flat
//   confused  head tilts, one brow up, wavy mouth, hand scratches head, "?" badge
//   right     happy ^ ^ eyes, big smile, ✓ badge, thumbs-up, a double hop + burst
//   selfie    phone out, then raised to arm's length (raised); face mirrors the
//             capture prompt; `youToo` raises the free hand toward the viewer
//   matched   both thumbs up, big smile, the double hop + burst
//   detective black suit, hat, specs, pointing at Retake (holdingTab, perch)
//   reaching, point, thumbsUp, fingerScan, eyeScan, askFinger, noDevice,
//   deviceOk, pointUp, namaste, tip(kind) — see the Kotlin source's Mood docs.
// He also blinks on his own every 2.6–4.4 s, whatever the mood.
//
// ── API ────────────────────────────────────────────────────────────────
//   <Verifier mood={{ type: 'typing', caret: 0.4, count: 7 }} className="h-full w-full" />
//   mood: { type:'idle' } | { type:'wave' } | { type:'typing', caret, count }
//       | { type:'covered', peek } | { type:'waiting' } | { type:'confused' }
//       | { type:'right' } | { type:'selfie', raised, face, youToo }
//       | { type:'matched' } | { type:'detective', holdingTab, perch }
//       | { type:'reaching' } | { type:'point' } | { type:'thumbsUp' }
//       | { type:'fingerScan' } | { type:'eyeScan' } | { type:'askFinger' }
//       | { type:'noDevice' } | { type:'deviceOk' } | { type:'pointUp' }
//       | { type:'namaste' } | { type:'tip', kind }
//   face: 'neutral'|'smile'|'blink'|'lean'|'wow'|'ok'   (default 'smile')
//   kind: 'faceGuide'|'light'|'noGlasses'|'fingerFlat'|'wipe'|'holdStill'
//         |'scannerClose'|'eyeOpen'|'noGlare'
//
// ── Sizing / overflow contract ─────────────────────────────────────────
// The component renders a <div> (className/style go on it; default style is
// `position: relative; aspect-ratio: 1 / 1`). That div's content box is the
// Compose Canvas: s = min(width, height) / 100 and the 100×100 grid starts at
// its top-left corner, exactly like the source (a non-square box leaves the
// figure top-left, as Compose does).
// The Compose Canvas does not clip: raised hands, the hop (up to 17 units),
// the hat, sun, "?", hourglass, the selfie phone held out left, the landing
// burst and the oversized thumb all draw outside 0..100. To mirror that, the
// <canvas> is absolutely positioned and extends past the div by OVERFLOW grid
// units on each side (top 24, right/left 16, bottom 16), pointer-events none.
// The host should therefore size the div as the 100×100 box and leave room
// (or at least `overflow: visible` on ancestors) for ~24% above and ~16% to
// the sides/below if it wants every extra visible; anything beyond OVERFLOW
// (only the faint tail of the burst ring) is clipped.
//
// ── Animation ─────────────────────────────────────────────────────────
// One requestAnimationFrame loop; all state in refs, React never re-renders
// per frame. animateFloatAsState dials → analytic damped springs / tweens;
// one-shot Animatables (blink, key taps, hop, squash, burst) → a small
// Animatable with Compose's interruption semantics (a new animateTo cancels
// the running one and the awaiting coroutine), driven by async "effects"
// keyed exactly like the LaunchedEffects.
// prefers-reduced-motion: the two clocks freeze at 0, and the idle extras —
// blinks, boredom phone, idle boing, the celebration hop/burst and the
// per-key body bounce — are off. Moods still switch (the dials still spring)
// and the per-key hand taps remain as feedback.

import { useEffect, useRef } from 'react'

// Grid units drawn outside the 100×100 box on each side (see contract above).
const OVERFLOW = { top: 24, right: 16, bottom: 16, left: 16 }

// ─── Colours (Scheme.kt ACTIVE = FlatViolet) ───────────────────────────
// [r, g, b, alpha 0..1]
const hex = (h, a = 1) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), a]
const Ink = hex('#211E33')          // Scheme.CharInk (= ink, no charInk override)
const Skin = hex('#F3EAD9')         // Scheme.Skin
const SkinDk = hex('#E2D4BE')       // Scheme.SkinDark
const Blush = hex('#B9CDEA', 0x59 / 255)   // a cool blush — no red in this app
const Shirt = hex('#FFFFFF')
const ShirtDk = hex('#F0EEF5')      // Scheme.ShirtShade
// Outfits. 'formal' is the app's white shirt and violet tie; 'casual' is a
// plain lavender shirt, open collar, no tie — how an agent actually dresses
// at the desk. Shirt/ShirtDk are swapped in place per instance before each
// frame is drawn (drawing is synchronous, so instances never mix).
const OUTFITS = {
  formal: { shirt: hex('#FFFFFF'), shade: hex('#F0EEF5'), casual: false },
  casual: { shirt: hex('#D9D1F1'), shade: hex('#C6BBE6'), casual: true },
}
const OUTFIT = { casual: false }
function applyOutfit(name) {
  const o = OUTFITS[name] || OUTFITS.formal
  for (let i = 0; i < 4; i++) { Shirt[i] = o.shirt[i]; ShirtDk[i] = o.shade[i] }
  OUTFIT.casual = o.casual
}
const CollarLt = hex('#EFEAFB'), Placket = hex('#B7AADF')
const Keys = hex('#EFEBF9')         // Scheme.CardFocused
const KeyCap = hex('#FFFFFF')
const Accent = hex('#5B3FA6')       // Scheme.Accent
const Tie = Accent                  // the portal's own hue
const TieDk = hex('#43307D')        // Scheme.AccentDeep
const AccentDk = TieDk
const AccentSoft = hex('#9A86D6')   // Scheme.AccentSoft
const Muted = hex('#66627A')        // Scheme.Muted
const Query = hex('#A29EB3')        // Scheme.Faint
const Mark = hex('#99641B')         // Scheme.Mark (HumanEye amber 70)
const OnAccent = hex('#FFFFFF')     // Palette default onAccent
const White = hex('#FFFFFF')

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const clamp01 = (v) => clamp(v, 0, 1)
const lerp = (a, b, t) => a + (b - a) * t
const withA = (c, a) => [c[0], c[1], c[2], clamp01(a)]
const css = (c) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${clamp01(c[3])})`

// Compose's androidx.compose.ui.graphics.lerp(Color, Color, t) — the explicit
// import wins over the file's private component-wise lerp — interpolates in
// Oklab. Ported here with the standard sRGB ↔ Oklab transforms.
const toLin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
const fromLin = (c) => 255 * clamp01(c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)
function toOklab(c) {
  const r = toLin(c[0]), g = toLin(c[1]), b = toLin(c[2])
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ]
}
function fromOklab(L, A, B) {
  const l = Math.pow(L + 0.3963377774 * A + 0.2158037573 * B, 3)
  const m = Math.pow(L - 0.1055613458 * A - 0.0638541728 * B, 3)
  const s = Math.pow(L - 0.0894841775 * A - 1.2914855480 * B, 3)
  return [
    fromLin(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLin(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLin(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
  ]
}
function lerpColor(a, b, t) {
  const p = toOklab(a), q = toOklab(b)
  const rgb = fromOklab(lerp(p[0], q[0], t), lerp(p[1], q[1], t), lerp(p[2], q[2], t))
  return [rgb[0], rgb[1], rgb[2], clamp01(lerp(a[3], b[3], t))]
}
const PupilInk = lerpColor(Ink, hex('#3A3F4B'), 0.35)
const MouthDark = lerpColor(Ink, hex('#2E3550'), 0.5)
const Tongue = hex('#9DB4E4')

// ─── Geometry helpers ──────────────────────────────────────────────────
const P = (x, y) => ({ x, y })
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y })
const lerpP = (a, b, t) => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) })
const TAU = 2 * Math.PI
const { sin, cos, abs, max, PI } = Math

// withTransform { rotate(deg, pivot) } / { scale(sx, sy, pivot) }
function rotateP(g, deg, px, py) { g.translate(px, py); g.rotate((deg * PI) / 180); g.translate(-px, -py) }
function scaleP(g, sx, sy, px, py) { g.translate(px, py); g.scale(sx, sy); g.translate(-px, -py) }

// ─── DrawScope primitives ──────────────────────────────────────────────
function rrPath(g, x, y, w, h, r) {
  if (w < 0) { x += w; w = -w }
  if (h < 0) { y += h; h = -h }
  r = max(0, Math.min(r, w / 2, h / 2))
  g.beginPath()
  g.moveTo(x + r, y)
  g.arcTo(x + w, y, x + w, y + h, r)
  g.arcTo(x + w, y + h, x, y + h, r)
  g.arcTo(x, y + h, x, y, r)
  g.arcTo(x, y, x + w, y, r)
  g.closePath()
}
function strokeWith(g, c, w, cap = 'butt', join = 'miter', path) {
  g.strokeStyle = css(c); g.lineWidth = w; g.lineCap = cap; g.lineJoin = join; g.miterLimit = 4
  if (path) g.stroke(path); else g.stroke()
}
function fillWith(g, c, path) { g.fillStyle = css(c); if (path) g.fill(path); else g.fill() }
// drawRoundRect(color, topLeft, size, CornerRadius(r)[, Stroke(sw)])
function rrect(g, x, y, w, h, r, c, sw) {
  if (c[3] <= 0) return
  rrPath(g, x, y, w, h, r)
  if (sw != null) strokeWith(g, c, sw); else fillWith(g, c)
}
// drawRect(color, topLeft, size)
function rect(g, x, y, w, h, c) {
  if (c[3] <= 0) return
  g.fillStyle = css(c)
  g.fillRect(x, y, w, h)
}
// drawCircle(color, radius, center[, Stroke(sw)])
function circle(g, cx, cy, r, c, sw) {
  if (!(r > 0) || c[3] <= 0) return
  g.beginPath(); g.arc(cx, cy, r, 0, TAU)
  if (sw != null) strokeWith(g, c, sw); else fillWith(g, c)
}
// drawOval(color, topLeft, size[, Stroke(sw)])
function oval(g, x, y, w, h, c, sw) {
  if (!(w > 0) || !(h > 0) || c[3] <= 0) return
  g.beginPath(); g.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, TAU)
  if (sw != null) strokeWith(g, c, sw); else fillWith(g, c)
}
// drawLine(color, start, end, strokeWidth, cap)
function line(g, c, a, b, w, cap = 'butt') {
  if (c[3] <= 0) return
  g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y)
  strokeWith(g, c, w, cap)
}
// verticalGradient(0 → c, 1 → Transparent) over [y0, y1], filling a rect.
function gradRect(g, x, y, w, h, c, y0, y1) {
  if (c[3] <= 0) return
  const gr = g.createLinearGradient(0, y0, 0, y1)
  gr.addColorStop(0, css(c))
  gr.addColorStop(1, css(withA(c, 0)))
  g.fillStyle = gr
  g.fillRect(x, y, w, h)
}

// ─── The Innovatiview gear ────────────────────────────────────────────
// The company's mark, exactly as in the report standard's
// iv-gear-watermark.svg: two paths — the geared ring and the lens arc —
// each with its OWN translate (they differ), and the viewBox origin
// (121.763 5.604) over 55.593 units. Path data is verbatim.
const IV_GEAR = [
  { d: 'M292.31,71.331a15.046,15.046,0,0,1-7.265-1.869l1.088-1.966a12.783,12.783,0,0,0,14.4-20.976l1.447-1.722a15.03,15.03,0,0,1-9.672,26.534', tx: -142.428, ty: -22.384 },
  { d: 'M294.532,37.339l4.416-.311a27.856,27.856,0,0,0-2.872-10.483l-3.962,1.977a23.5,23.5,0,0,0-5.6-7.228l2.9-3.344a27.74,27.74,0,0,0-9.445-5.382l-1.4,4.2a23.405,23.405,0,0,0-7.418-1.211c-.554,0-1.1.019-1.651.06l-.312-4.419A27.95,27.95,0,0,0,258.7,14.068l1.979,3.965a23.467,23.467,0,0,0-7.229,5.6l-3.344-2.9a27.775,27.775,0,0,0-5.386,9.446l4.2,1.4a23.334,23.334,0,0,0-1.152,9.07l-4.417.312a27.865,27.865,0,0,0,2.87,10.484l3.966-1.976a23.5,23.5,0,0,0,5.6,7.227l-2.9,3.344a27.689,27.689,0,0,0,9.444,5.383l1.4-4.2a23.38,23.38,0,0,0,7.42,1.211c.553,0,1.1-.019,1.651-.06l.313,4.42A27.96,27.96,0,0,0,283.6,63.917l-1.98-3.965a23.484,23.484,0,0,0,7.229-5.6l3.346,2.9a27.8,27.8,0,0,0,5.383-9.446l-4.2-1.4a23.357,23.357,0,0,0,1.153-9.071m-6.361,7.333h0a17.946,17.946,0,1,1-11.337-22.7,17.949,17.949,0,0,1,11.337,22.7', tx: -121.598, ty: -5.594 },
]
let ivGearCache = null
function ivGear() {
  if (!ivGearCache) {
    ivGearCache = IV_GEAR.map((m) => {
      // PathMeasure.setPath measures the FIRST contour only; keep it apart
      // for the trimmed stroke.
      const i = m.d.slice(1).search(/[Mm]/)
      const first = i < 0 ? m.d : m.d.slice(0, i + 1)
      return { meta: m, path: new Path2D(m.d), first, firstPath: new Path2D(first), len: null }
    })
  }
  return ivGearCache
}
function gearTransform(g, cx, cy, r, meta) {
  const k = (2 * r) / 55.593
  g.translate(cx - r, cy - r); g.scale(k, k); g.translate(meta.tx - 121.763, meta.ty - 5.604)
  return k
}
/** The gear mark centred on (cx, cy), r its radius, in color. */
function drawIvGear(g, cx, cy, r, color) {
  for (const it of ivGear()) {
    g.save(); gearTransform(g, cx, cy, r, it.meta)
    fillWith(g, color, it.path)
    g.restore()
  }
}
/** The gear mark drawing itself: outlines traced 0 → trim of their length,
 *  as a stroke, then filled by fill (0…1). (Not used by the Verifier
 *  itself; ported for completeness. PathMeasure → SVG getTotalLength +
 *  a line dash over the first contour.) */
// eslint-disable-next-line no-unused-vars
function drawIvGearTrim(g, cx, cy, r, color, trim, fill, stroke) {
  for (const it of ivGear()) {
    g.save(); const k = gearTransform(g, cx, cy, r, it.meta)
    if (fill > 0.01) fillWith(g, withA(color, color[3] * fill), it.path)
    if (trim > 0.001 && fill < 0.999) {
      if (it.len == null) {
        try {
          const el = document.createElementNS('http://www.w3.org/2000/svg', 'path')
          el.setAttribute('d', it.first)
          it.len = el.getTotalLength()
        } catch { it.len = 0 }
      }
      if (it.len > 0) {
        g.setLineDash([it.len * clamp01(trim), it.len + 1])
        strokeWith(g, color, stroke / k, 'round', 'round', it.firstPath)
        g.setLineDash([])
      }
    }
    g.restore()
  }
}

// ─── Motion (theme/Motion.kt) ──────────────────────────────────────────
const MotionStandard = 260
const MotionSlow = 330
const StiffnessLow = 200
const StiffnessMediumLow = 400
const StiffnessMedium = 1500

function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by
  const sx = (t) => ((ax * t + bx) * t + cx) * t
  const sy = (t) => ((ay * t + by) * t + cy) * t
  const dsx = (t) => (3 * ax * t + 2 * bx) * t + cx
  return (x) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let t = x
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x
      if (abs(e) < 1e-6) return sy(t)
      const d = dsx(t)
      if (abs(d) < 1e-6) break
      t -= e / d
    }
    let lo = 0, hi = 1; t = x
    for (let i = 0; i < 30; i++) {
      const v = sx(t)
      if (abs(v - x) < 1e-6) break
      if (v < x) lo = t; else hi = t
      t = (lo + hi) / 2
    }
    return sy(t)
  }
}
const FastOutSlowIn = cubicBezier(0.4, 0, 0.2, 1)
const Linear = (x) => x
const JumpUp = cubicBezier(0.2, 0.9, 0.4, 1)
const JumpDown = cubicBezier(0.6, 0, 0.9, 0.5)

// Specs. Compose tween's default easing is FastOutSlowInEasing.
const spring = (dampingRatio, stiffness) => ({ type: 'spring', z: dampingRatio, k: stiffness })
const tween = (dur, easing = FastOutSlowIn) => ({ type: 'tween', dur, easing })
// keyframes: [{ t, v, ease }] — `ease` applies to the interval starting at t;
// the first frame's value is replaced by the start value (Compose semantics).
const keyframes = (dur, frames) => ({ type: 'keyframes', dur, frames })

// Analytic damped spring (mass 1), as Compose's SpringSimulation.
function springAt(x0, v0, z, k, t) {
  const w0 = Math.sqrt(k)
  if (z < 1) {
    const wd = w0 * Math.sqrt(1 - z * z), e = Math.exp(-z * w0 * t)
    const A = x0, B = (v0 + z * w0 * x0) / wd, c = cos(wd * t), s = sin(wd * t)
    return [e * (A * c + B * s), e * ((-z * w0 * A + wd * B) * c + (-z * w0 * B - wd * A) * s)]
  }
  if (z === 1) {
    const e = Math.exp(-w0 * t), A = x0, B = v0 + w0 * x0
    return [(A + B * t) * e, (B - w0 * (A + B * t)) * e]
  }
  const r = w0 * Math.sqrt(z * z - 1), r1 = -z * w0 + r, r2 = -z * w0 - r
  const C2 = (r1 * x0 - v0) / (r1 - r2), C1 = x0 - C2
  return [C1 * Math.exp(r1 * t) + C2 * Math.exp(r2 * t), C1 * r1 * Math.exp(r1 * t) + C2 * r2 * Math.exp(r2 * t)]
}

// Coroutine stand-ins. CANCEL is thrown into an awaiting "coroutine" when
// its Job is cancelled or its animation is interrupted by another animateTo.
const CANCEL = { cancelled: true }
const noop = () => {}
class Job {
  constructor() { this.cancelled = false; this.cbs = new Set() }
  onCancel(f) { this.cbs.add(f) }
  offCancel(f) { this.cbs.delete(f) }
  cancel() {
    if (this.cancelled) return
    this.cancelled = true
    const cbs = [...this.cbs]; this.cbs.clear()
    for (const f of cbs) f()
  }
}
function launch(fn) { fn().catch((e) => { if (e !== CANCEL) console.error(e) }) }

// A small Animatable<Float>. Time comes from the engine's frame clock.
class Anim {
  constructor(clock, v = 0) { this.clock = clock; this.value = v; this.velocity = 0; this.target = v; this.a = null }
  _interrupt() {
    const a = this.a
    if (!a) return
    this.a = null
    if (a.job) a.job.offCancel(a.onCancel)
    a.reject(CANCEL)
  }
  snapTo(v) {
    this._interrupt()
    this.value = v; this.velocity = 0; this.target = v
    return Promise.resolve()
  }
  animateTo(to, spec, job) {
    if (job && job.cancelled) return Promise.reject(CANCEL)
    this._interrupt()
    this.target = to
    return new Promise((resolve, reject) => {
      const a = { to, spec, start: this.clock.now, from: this.value, v0: this.velocity, resolve, reject, job }
      if (spec.type === 'keyframes') {
        a.frames = spec.frames.map((f, i) => (i === 0 ? { ...f, v: this.value } : f))
        a.to = a.frames[a.frames.length - 1].v
        this.target = a.to
      }
      if (job) {
        a.onCancel = () => {
          if (this.a !== a) return
          this.a = null; this.velocity = 0   // cancelled: stays where it is
          reject(CANCEL)
        }
        job.onCancel(a.onCancel)
      }
      this.a = a
    })
  }
  _finish() {
    const a = this.a
    this.a = null
    this.value = a.to; this.velocity = 0
    if (a.job) a.job.offCancel(a.onCancel)
    a.resolve()
  }
  step(now) {
    const a = this.a
    if (!a) return
    const t = now - a.start
    const sp = a.spec
    if (sp.type === 'spring') {
      const [x, v] = springAt(a.from - a.to, a.v0, sp.z, sp.k, t / 1000)
      if (abs(x) < 0.005 && abs(v) < 0.05) return this._finish()
      this.value = a.to + x; this.velocity = v
    } else if (sp.type === 'tween') {
      const p = sp.dur <= 0 ? 1 : t / sp.dur
      if (p >= 1) return this._finish()
      const prev = this.value
      this.value = a.from + (a.to - a.from) * sp.easing(p)
      const dt = (now - (a.last ?? a.start)) / 1000
      this.velocity = dt > 0 ? (this.value - prev) / dt : 0
      a.last = now
    } else {
      if (t >= sp.dur) return this._finish()
      const fr = a.frames
      let i = 0
      while (i < fr.length - 2 && t >= fr[i + 1].t) i++
      const f0 = fr[i], f1 = fr[i + 1]
      const p = f1.t > f0.t ? (t - f0.t) / (f1.t - f0.t) : 1
      const prev = this.value
      this.value = f0.v + (f1.v - f0.v) * (f0.ease || Linear)(clamp01(p))
      const dt = (now - (a.last ?? a.start)) / 1000
      this.velocity = dt > 0 ? (this.value - prev) / dt : 0
      a.last = now
    }
  }
}

// ─── Mood ──────────────────────────────────────────────────────────────
const MOODS = new Set(['idle', 'wave', 'typing', 'covered', 'waiting', 'confused', 'right', 'selfie', 'matched',
  'detective', 'reaching', 'point', 'thumbsUp', 'fingerScan', 'eyeScan', 'askFinger', 'noDevice', 'deviceOk',
  'pointUp', 'namaste', 'tip'])
function normMood(m) {
  if (!m || typeof m !== 'object' || !MOODS.has(m.type)) return { type: 'idle' }
  switch (m.type) {
    case 'typing': return { type: 'typing', caret: clamp01(Number(m.caret) || 0), count: Math.max(0, Math.floor(Number(m.count) || 0)) }
    case 'covered': return { type: 'covered', peek: !!m.peek }
    case 'selfie': return { type: 'selfie', raised: !!m.raised, face: m.face || 'smile', youToo: !!m.youToo }
    case 'detective': return { type: 'detective', holdingTab: !!m.holdingTab, perch: !!m.perch }
    case 'tip': return { type: 'tip', kind: m.kind || 'faceGuide' }
    default: return { type: m.type }
  }
}

// ── Dials: every animateFloatAsState, with its spec ───────────────────
// Every mood change rides one soft, slightly under-damped spring, so a
// change of face or hand arrives with a little follow-through and settles.
const soft = spring(0.68, StiffnessMediumLow)
const DIAL_SPECS = {
  phone: spring(0.75, StiffnessLow),
  keyboard: spring(0.78, StiffnessLow),
  eyeOpen: soft,
  happyEyes: soft,
  detective: spring(0.85, StiffnessLow),
  matched: spring(0.6, StiffnessMediumLow),
  perch: spring(0.75, StiffnessMediumLow),
  namaste: spring(0.8, StiffnessLow),
  pointUp: spring(0.7, StiffnessMediumLow),
  tipping: tween(MotionStandard),
  handTip: tween(MotionStandard),
  brackets: spring(0.7, StiffnessMediumLow),
  sun: spring(0.75, StiffnessLow),
  glare: tween(MotionStandard),
  shield: spring(0.75, StiffnessMediumLow),
  wipe: spring(0.8, StiffnessLow),
  still: tween(MotionSlow),
  specs: tween(MotionStandard),
  pointing: spring(0.7, StiffnessMediumLow),
  scan: spring(0.8, StiffnessLow),
  shrug: spring(0.7, StiffnessMediumLow),
  nod: spring(0.8, StiffnessMediumLow),
  tab: spring(0.8, StiffnessLow),
  wired: spring(0.8, StiffnessLow),
  eyeScan: spring(0.8, StiffnessLow),
  askFinger: spring(0.75, StiffnessMediumLow),
  bigThumb: spring(0.55, StiffnessMediumLow),
  reaching: spring(0.75, StiffnessLow),
  pupilX: tween(MotionStandard, FastOutSlowIn),
  pupilY: tween(MotionStandard, FastOutSlowIn),
  mouth: soft,
  confused: spring(0.7, StiffnessLow),
  cover: spring(0.72, StiffnessLow),
  lookAway: spring(0.7, StiffnessLow),
  wave: spring(0.7, StiffnessMediumLow),
  selfie: spring(0.78, StiffnessLow),
  youToo: spring(0.7, StiffnessMediumLow),
  wow: soft,
  beckon: spring(0.7, StiffnessMediumLow),
  okThumb: spring(0.6, StiffnessMediumLow),
  thumbs: spring(0.6, StiffnessMediumLow),
  badge: spring(0.55, StiffnessMedium),
}

function dialTargets(m, bored) {
  const T = m.type
  const is = (t) => T === t
  const tip = is('tip') ? m.kind : null
  const typing = is('typing') || is('waiting')
  const sel = is('selfie')
  const face = sel ? m.face : null
  const b = (v) => (v ? 1 : 0)
  const holdingTab = is('detective') && m.holdingTab
  const tabbed = is('fingerScan') || is('deviceOk') || is('askFinger') || is('eyeScan') || holdingTab
    || tip === 'fingerFlat' || tip === 'wipe' || tip === 'scannerClose'

  let eyeOpen = 1
  if (is('right') || is('matched')) eyeOpen = 0                // happy arcs take over
  else if (sel) eyeOpen = face === 'wow' ? 1.25 : 1
  else if (is('eyeScan')) eyeOpen = 1.3                         // wide open, looking into the scanner
  else if (is('detective')) eyeOpen = 0.8                       // narrowed, serious
  else if (tip) eyeOpen = tip === 'eyeOpen' ? 1.45 : tip === 'noGlare' ? 0.45 : tip === 'scannerClose' ? 1.3 : 0.8
  else if (is('pointUp')) eyeOpen = 1.05
  else if (is('namaste')) eyeOpen = 0.12                        // eyes gently closed

  let pupilX = 0
  if (is('typing')) pupilX = lerp(-2.2, 2.2, m.caret)
  else if (is('confused')) pupilX = 2.0
  else if (sel) pupilX = m.raised ? -2.0 : 0                   // eyes on the phone
  else if (is('eyeScan')) pupilX = 2.2                          // toward the scanner at his right
  else if (is('reaching')) pupilX = -2.0
  else if (is('point')) pupilX = -2.2
  else if (is('covered')) pupilX = m.peek ? 1.8 : -2.4           // eyes off to the side while you type; a glance at the reveal
  else if (is('pointUp')) pupilX = 1.6
  else if (tip) pupilX = (tip === 'light' || tip === 'noGlare') ? -2.0 : tip === 'scannerClose' ? 2.2 : 0

  let pupilY = 0
  if (is('typing')) pupilY = -1.6
  else if (is('waiting')) pupilY = -1.6
  else if (is('confused')) pupilY = -1.2
  else if (is('covered')) pupilY = m.peek ? 1.6 : -1.3
  else if (is('idle')) pupilY = bored ? 2.2 : 0
  else if (sel) pupilY = m.raised ? -0.6 : 2.2
  else if (is('reaching')) pupilY = 2.0
  else if (is('detective')) pupilY = m.perch ? 2.4 : 0          // eyes down on the pill he stands on
  else if (is('fingerScan')) pupilY = 2.4
  else if (is('askFinger')) pupilY = 2.0
  else if (is('eyeScan')) pupilY = 0
  else if (is('pointUp')) pupilY = -2.4
  else if (tip) pupilY = (tip === 'light' || tip === 'noGlare') ? -2.4 : (tip === 'fingerFlat' || tip === 'wipe') ? 2.4 : 0

  let mouth = 0.6                                               // −1 … 1; Confused uses its own wavy mouth
  if (is('right') || is('matched')) mouth = 1.4
  else if (is('wave')) mouth = 1.2
  else if (is('thumbsUp')) mouth = 1.2
  else if (is('fingerScan')) mouth = 0.3
  else if (is('deviceOk')) mouth = 0.02                         // poker face
  else if (is('askFinger')) mouth = 0.7
  else if (is('eyeScan')) mouth = 0.2
  else if (is('noDevice')) mouth = -0.35
  else if (is('detective')) mouth = -0.15                       // flat, unimpressed
  else if (tip) mouth = 0.35                                    // explaining, a little warmer
  else if (is('pointUp')) mouth = 0.9
  else if (is('namaste')) mouth = 1.0
  else if (is('reaching')) mouth = 0.4
  else if (sel) mouth = (face === 'smile' || face === 'ok') ? 1.3 : (face === 'lean') ? 0.7 : (face === 'wow') ? 0 : 0.5
  else if (is('waiting')) mouth = 0.05
  else if (is('covered')) mouth = m.peek ? 0.2 : 0.45

  return {
    phone: b(bored || sel),
    keyboard: b(typing),
    eyeOpen,
    happyEyes: b(is('right') || is('matched')),
    detective: b(is('detective') || is('tip')),
    matched: b(is('matched')),
    perch: b(is('detective') && m.perch),
    namaste: b(is('namaste')),
    pointUp: b(is('pointUp')),
    tipping: b(tip != null),
    handTip: b(tip === 'fingerFlat' || tip === 'wipe' || tip === 'noGlare' || tip === 'scannerClose'),
    brackets: b(tip === 'faceGuide'),
    sun: b(tip === 'light' || tip === 'noGlare'),
    glare: b(tip === 'noGlare'),
    shield: b(tip === 'noGlare'),
    wipe: b(tip === 'wipe'),
    still: b(tip === 'holdStill'),
    specs: b(is('detective') || is('tip')),
    pointing: b(is('point')),
    scan: b(is('fingerScan') || tip === 'fingerFlat'),
    shrug: b(is('noDevice')),
    nod: 0,
    tab: b(is('noDevice') || tabbed),
    wired: b(tabbed),
    eyeScan: b(is('eyeScan') || tip === 'scannerClose'),
    askFinger: b(is('askFinger')),
    bigThumb: b(is('deviceOk')),
    reaching: b(is('reaching')),
    pupilX,
    pupilY,
    mouth,
    confused: b(is('confused') || is('noDevice')),
    cover: 0,
    lookAway: is('covered') && !m.peek ? 1 : 0,
    wave: b(is('wave')),
    selfie: b(sel && m.raised),
    youToo: b(sel && m.youToo),
    wow: b(face === 'wow'),
    beckon: b(sel && m.raised && face === 'lean'),
    okThumb: b((sel && m.raised && face === 'ok') || is('thumbsUp')),
    thumbs: b(is('right') || is('matched')),
    badge: b(is('right') || is('confused')),
  }
}

// Kotlin Int LCG: (seed * 1103515245 + 12345) and 0x7fffffff
const lcg = (seed) => ((Math.imul(seed, 1103515245) + 12345) | 0) & 0x7fffffff

// ─── Engine: dials, one-shot Animatables, keyed effects ────────────────
function createEngine() {
  const clock = { now: 0 }
  const timers = new Set()
  const dials = {}
  for (const k of Object.keys(DIAL_SPECS)) dials[k] = { anim: new Anim(clock), init: false }
  const blink = new Anim(clock), tapL = new Anim(clock), tapR = new Anim(clock)
  const hop = new Anim(clock), sq = new Anim(clock), burst = new Anim(clock)
  const anims = [blink, tapL, tapR, hop, sq, burst]
  const st = { bored: false, t0: null, reduced: false }
  const jobs = {}
  const keys = {}

  const delay = (ms, job) => new Promise((resolve, reject) => {
    if (job.cancelled) return reject(CANCEL)
    const t = { at: clock.now + ms, resolve, reject: null }
    t.reject = () => { timers.delete(t); reject(CANCEL) }
    job.onCancel(t.reject)
    t.done = () => { job.offCancel(t.reject); resolve() }
    timers.add(t)
  })

  // The jump. Anticipation first — he crouches — then a real leap, a
  // landing squash and a settle. hop is height (negative = up), sq the
  // squash-and-stretch dial: +1 crouched/squashed, −1 stretched tall.
  async function jump(height, job) {
    await hop.snapTo(0)
    await sq.animateTo(0.7, tween(110, FastOutSlowIn), job)                        // crouch
    launch(async () => { await sq.animateTo(-0.6, tween(120), job); await sq.animateTo(0, tween(180), job) })  // stretch on the way up
    await hop.animateTo(-height, tween(210, JumpUp), job)
    await hop.animateTo(0, tween(200, JumpDown), job)
    launch(async () => { await sq.animateTo(1, tween(70), job); await sq.animateTo(0, spring(0.4, StiffnessMedium), job) })  // land, wobble
    await hop.animateTo(0, keyframes(260, [{ t: 0, v: 0 }, { t: 110, v: -height * 0.22, ease: FastOutSlowIn }, { t: 260, v: 0 }]), job)
  }

  const EFFECTS = {
    // Blinks: a quick close/open every 2.6–4.4 s, forever.
    blink: (job) => async () => {
      if (st.reduced) { await blink.snapTo(0); return }
      let seed = 0x5EED
      for (;;) {
        seed = lcg(seed)
        await delay(2600 + (seed % 1800), job)
        await blink.animateTo(1, tween(70, FastOutSlowIn), job)
        await blink.animateTo(0, tween(120, FastOutSlowIn), job)
      }
    },
    // Boredom: after 4 s of Idle the phone comes out; it goes away the
    // moment the mood changes. Loops phone-out 7 s / phone-away 3 s.
    bored: (job, m) => async () => {
      st.bored = false
      if (m.type !== 'idle' || st.reduced) return
      for (;;) {
        await delay(4000, job); if (!job.cancelled) st.bored = true
        await delay(7000, job); if (!job.cancelled) st.bored = false
        await delay(3000, job)
      }
    },
    // Key taps: one hop per keystroke, alternating hands.
    taps: (job, m) => async () => {
      const count = m.type === 'typing' ? m.count : -1
      if (count < 0) return
      const hand = count % 2 === 0 ? tapL : tapR
      await hand.snapTo(0)
      await hand.animateTo(1, tween(70, FastOutSlowIn), job)
      await hand.animateTo(0, tween(150, FastOutSlowIn), job)
    },
    // Every key: a small bounce, in time with the tap.
    bounce: (job, m) => async () => {
      const count = m.type === 'typing' ? m.count : -1
      if (count < 0 || st.reduced) return
      launch(async () => { await sq.snapTo(0.22); await sq.animateTo(0, spring(0.5, StiffnessMedium), job) })
      await hop.animateTo(-2, tween(70, FastOutSlowIn), job)
      await hop.animateTo(0, tween(130, FastOutSlowIn), job)
    },
    // The celebration: a double jump — the first big, the second smaller —
    // and a burst of sparks from his feet on the first landing.
    celebrate: (job, m) => async () => {
      if (!(m.type === 'right' || m.type === 'matched') || st.reduced) return
      launch(async () => { await burst.snapTo(0); await delay(430, job); await burst.animateTo(1, tween(760, FastOutSlowIn), job) })
      await jump(17, job)
      await jump(8, job)
    },
    // Idle life: a boing every 7–12 s while nothing is happening.
    idling: (job, m) => async () => {
      const idling = m.type === 'idle' || m.type === 'pointUp' || m.type === 'waiting'
      if (!idling || st.reduced) return
      let seed = 0xB01
      for (;;) {
        seed = lcg(seed)
        await delay(7000 + (seed % 5000), job)
        await jump(3.5, job)
      }
    },
  }

  function effectKeys(m) {
    const r = st.reduced ? 'R' : ''
    const count = m.type === 'typing' ? m.count : -1
    return {
      blink: r,
      bored: (m.type === 'idle') + r,
      taps: String(count),
      bounce: count + r,
      celebrate: (m.type === 'right' || m.type === 'matched') + r,
      idling: (m.type === 'idle' || m.type === 'pointUp' || m.type === 'waiting') + r,
    }
  }

  function runEffects(m) {
    const k = effectKeys(m)
    for (const name of Object.keys(EFFECTS)) {
      if (keys[name] === k[name]) continue
      keys[name] = k[name]
      if (jobs[name]) jobs[name].cancel()
      const job = new Job()
      jobs[name] = job
      launch(EFFECTS[name](job, m))
    }
    // Reduced motion: nothing may be left frozen mid-blink or mid-air.
    if (st.reduced) {
      if (!blink.a && blink.value !== 0) blink.snapTo(0)
      if (!hop.a && hop.value !== 0) hop.snapTo(0)
      if (!sq.a && sq.value !== 0) sq.snapTo(0)
      if (!burst.a && burst.value !== 0) burst.snapTo(0)
    }
  }

  function frame(now, m) {
    clock.now = now
    if (st.t0 == null) st.t0 = now
    runEffects(m)
    for (const t of [...timers]) if (now >= t.at) { timers.delete(t); t.done() }
    const tg = dialTargets(m, st.bored)
    for (const k in dials) {
      const d = dials[k]
      const v = tg[k]
      if (!d.init) { d.init = true; d.anim.snapTo(v) }
      else if (v !== d.anim.target) d.anim.animateTo(v, DIAL_SPECS[k]).catch(noop)
      d.anim.step(now)
    }
    for (const a of anims) a.step(now)
    // Two clocks, as rememberClock: loop 0..1 over the period.
    const el = now - st.t0
    return {
      clock: st.reduced ? 0 : (el % 1400) / 1400,
      life: st.reduced ? 0 : (el % 12000) / 12000,
    }
  }

  function dispose() {
    for (const k in jobs) jobs[k].cancel()
    for (const t of [...timers]) t.reject()
  }

  const dial = (k) => dials[k].anim.value
  return { frame, dispose, dial, st, blink, tapL, tapR, hop, sq, burst }
}

// ─── The figure (Verifier composable's Canvas block) ───────────────────
function drawVerifier(g, E, m, clockV, life) {
  const D = E.dial
  const tip = m.type === 'tip' ? m.kind : null
  const sleepy = 0                          // the sky is locked to evening; never sleepy
  const wind = 0                            // LocalSky.windy → false on the web
  const phone = D('phone'), keyboard = D('keyboard'), eyeOpen = D('eyeOpen'), happyEyes = D('happyEyes')
  const detective = D('detective'), matched = D('matched'), perch = D('perch'), namaste = D('namaste'), pointUp = D('pointUp')
  const tipping = D('tipping'), handTip = D('handTip'), brackets = D('brackets'), sun = D('sun'), glare = D('glare')
  const shield = D('shield'), wipe = D('wipe'), still = D('still'), specs = D('specs'), pointing = D('pointing')
  const scan = D('scan'), shrug = D('shrug'), nod = D('nod'), tab = D('tab'), wired = D('wired'), eyeScan = D('eyeScan')
  const askFinger = D('askFinger'), bigThumb = D('bigThumb'), reaching = D('reaching'), pupilX = D('pupilX'), pupilY = D('pupilY')
  const lookAway = D('lookAway')
  const mouth = D('mouth'), confused = D('confused'), cover = D('cover'), wave = D('wave'), selfie = D('selfie')
  const youToo = D('youToo'), wow = D('wow'), beckon = D('beckon'), okThumb = D('okThumb'), thumbs = D('thumbs'), badge = D('badge')

  const clock = clockV
  const breathe = sin(life * TAU * 3)                        // 4 s breath
  const swayRaw = sin(life * TAU * 2.3)                      // ~5.2 s sway
  // Eyes wander only when they are not tracking something.
  const T = m.type
  const tracking = T === 'typing' || (T === 'selfie' && m.raised) || T === 'reaching' || T === 'fingerScan' || T === 'point'
    || T === 'askFinger' || T === 'eyeScan' || T === 'pointUp' || T === 'tip'
  const wanderX = tracking ? 0 : 1.5 * sin(life * TAU * 3.9) + 0.6 * sin(life * TAU * 7.3)
  const wanderY = tracking ? 0 : 0.7 * sin(life * TAU * 2.7)
  const fidget = sin(life * TAU * 5.1)                       // resting hands

  const selfieFace = T === 'selfie' ? m.face : null
  // Selfie "blink for the camera": a slow, deliberate blink every ~1.4 s.
  const demoBlink = selfieFace === 'blink' ? (clock < 0.18 ? sin((clock / 0.18) * PI) : 0) : 0
  const lean = selfieFace === 'lean' ? 1 : 0
  const noBlink = tip === 'eyeOpen' ? 1 : 0
  // NoGlasses: glasses (and hat) on for a beat, slide down and off, back on.
  let specsOff = 0
  if (tip === 'noGlasses') {
    const ph = (clock * 2) % 1
    specsOff = ph < 0.35 ? 0 : smoothstep01((ph - 0.35) / 0.35) * (1 - smoothstep01((ph - 0.85) / 0.15))
  }
  const sway = swayRaw * (1 - still)                         // "hold still" holds still

  const hopV = E.hop.value, sqV = E.sq.value
  // translate(sway*0.6*s, (hop + breathe*0.9)*s); scale(s) — s is applied by the caller.
  g.translate(sway * 0.6, hopV + breathe * 0.9)
  // Breathing: the torso rises and the figure scales a hair from its feet.
  scaleP(g, 1 + 0.007 * breathe, 1 + 0.016 * breathe, 50, 100)
  // Squash and stretch, from the feet.
  scaleP(g, 1 + 0.09 * sqV, 1 - 0.12 * sqV, 50, 100)
  // Sway: a slow 1.2° lean either side.
  rotateP(g, 1.2 * sway, 50, 100)

  // The burst: twelve sparks out from the feet, rising and fading, with a
  // soft ring that runs out ahead of them.
  const b = E.burst.value
  if (b > 0 && b < 1) {
    const feet = P(50, 96)
    circle(g, feet.x, feet.y, 8 + 46 * b, withA(Accent, 0.30 * (1 - b)), 2.2 * (1 - b) + 0.4)
    for (let k = 0; k < 12; k++) {
      const a = (-PI * 0.1) - PI * 0.8 * (k / 11)
      const d = (14 + 34 * b) * (0.8 + (0.2 * ((k * 7) % 5)) / 4)
      const e = 1 - b
      const pos = P(feet.x + cos(a) * d, feet.y + sin(a) * d + 10 * b * b)
      const col = k % 3 === 0 ? Accent : k % 3 === 1 ? Mark : AccentSoft
      circle(g, pos.x, pos.y, (1.2 + 1.6 * (1 - b)) * (k % 2 === 0 ? 1 : 0.7), withA(col, 0.9 * e))
    }
  }
  drawBody(g, detective, wind * sin(clock * TAU * 3) + 0.45 * cos(life * TAU * 2.3) * (1 - still))
  // Head group: tilts when confused, turns toward the raised phone, leans
  // in for "closer", dips when reaching.
  g.save()
  rotateP(g,
    -9 * confused * (1 - shrug) - 5 * selfie + 6 * reaching + 11 * lookAway + 1.5 * sin(life * TAU * 1.7)
      + 5 * shrug * sin(clock * TAU * 1.5),                               // head-shake
    50, 60)
  g.translate(0, 2.6 * nod * (sin(clock * TAU * 1.2) * 0.5 + 0.5))        // nod
  g.translate(0, 4.5 * namaste)                                           // the bow
  scaleP(g, 1, 1 - 0.06 * namaste, 50, 30)
  scaleP(g, 1 + 0.05 * lean, 1 + 0.05 * lean, 50, 46)
  drawHead(g)
  drawFace(g,
    eyeOpen * (1 - 0.45 * sleepy) * (1 - E.blink.value * (1 - noBlink)) * (1 - demoBlink),
    happyEyes, pupilX + wanderX, pupilY + wanderY, mouth, confused, wow, detective, specs, specsOff)
  drawHat(g, detective * (1 - 0.95 * specsOff))
  drawBrackets(g, brackets, clock)
  g.restore()
  drawKeyboardAndHands(g, {
    kb: keyboard, tapL: E.tapL.value, tapR: E.tapR.value, scratch: confused * (1 - shrug), thumbs, cover, wave,
    phone, selfie, youToo, beckon, okThumb, matched, detective, reaching, clock, fidget, pointing, scan, shrug,
    bigThumb, tab, wired, askFinger, eyeScan, perch, pointUp, wipe, shield, tipping, namaste, handTip,
  })
  drawNamaste(g, namaste, fidget)
  drawQuestion(g, confused, clock)
  drawBadge(g, badge, confused)
  drawSun(g, sun, glare, life)
  drawHourglass(g, still, clock)
}

// ─── Parts (100×100 grid) ────────────────────────────────────────────

function drawBody(g, suit = 0, flutter = 0) {
  const shirt = new Path2D()
  shirt.moveTo(8, 100); shirt.lineTo(8, 76)
  shirt.quadraticCurveTo(8, 64, 22, 62)
  shirt.lineTo(78, 62)
  shirt.quadraticCurveTo(92, 64, 92, 76)
  shirt.lineTo(92, 100); shirt.closePath()
  fillWith(g, Shirt, shirt)
  rect(g, 8, 94, 84, 6, ShirtDk)
  if (!OUTFIT.casual) rect(g, 18, 82, 2.6, 12, Ink)   // the pen in the formal shirt
  // Detective: a black suit jacket over the shirt, open in a V so the white
  // shirt and the tie still show.
  if (suit > 0.01) {
    const jacket = new Path2D()
    jacket.moveTo(8, 100); jacket.lineTo(8, 76)
    jacket.quadraticCurveTo(8, 64, 22, 62)
    jacket.lineTo(36, 62); jacket.lineTo(50, 92); jacket.lineTo(64, 62)
    jacket.lineTo(78, 62)
    jacket.quadraticCurveTo(92, 64, 92, 76)
    jacket.lineTo(92, 100); jacket.closePath()
    fillWith(g, withA(Ink, suit), jacket)
    // Lapels — a lighter edge along the V.
    line(g, withA(Muted, 0.55 * suit), P(36, 62), P(50, 92), 2.2, 'round')
    line(g, withA(Muted, 0.55 * suit), P(64, 62), P(50, 92), 2.2, 'round')
  }
  rrect(g, 42, 52, 16, 14, 3, SkinDk)
  // Sleeves — the upper arms are shirt, so raised hands read as arms.
  const sleeveColor = lerpColor(Shirt, Ink, suit)
  rrect(g, 6, 66, 14, 30, 7, sleeveColor)
  rrect(g, 80, 66, 14, 30, 7, sleeveColor)
  if (OUTFIT.casual && suit < 0.5) {
    // the open neck
    const v = new Path2D(); v.moveTo(44, 62); v.lineTo(50, 71); v.lineTo(56, 62); v.closePath(); fillWith(g, Skin, v)
    // collar points, lying open
    const c1 = new Path2D(); c1.moveTo(33, 61); c1.lineTo(45, 61); c1.lineTo(50, 71); c1.lineTo(40, 70); c1.closePath(); fillWith(g, CollarLt, c1)
    const c2 = new Path2D(); c2.moveTo(67, 61); c2.lineTo(55, 61); c2.lineTo(50, 71); c2.lineTo(60, 70); c2.closePath(); fillWith(g, CollarLt, c2)
    line(g, Placket, P(40, 70), P(50, 71), 1, 'round')
    line(g, Placket, P(60, 70), P(50, 71), 1, 'round')
    // the button placket and two buttons
    line(g, Placket, P(50, 72), P(50, 100), 1.4, 'round')
    circle(g, 50, 80, 1.2, CollarLt)
    circle(g, 50, 90, 1.2, CollarLt)
    // a chest pocket
    const pk = new Path2D(); pk.moveTo(59, 76); pk.lineTo(70, 76); pk.lineTo(70, 85); pk.quadraticCurveTo(64.5, 88, 59, 85); pk.closePath()
    g.save(); g.lineWidth = 1; g.strokeStyle = `rgba(${Placket[0]},${Placket[1]},${Placket[2]},1)`; g.stroke(pk); g.restore()
    return
  }
  const t1 = new Path2D(); t1.moveTo(34, 62); t1.lineTo(50, 74); t1.lineTo(46, 62); t1.closePath(); fillWith(g, Tie, t1)
  const t2 = new Path2D(); t2.moveTo(66, 62); t2.lineTo(50, 74); t2.lineTo(54, 62); t2.closePath(); fillWith(g, Tie, t2)
  // The tie's tail swings with flutter (−1…1).
  const fx = 6 * flutter
  const t3 = new Path2D(); t3.moveTo(46, 72); t3.lineTo(54, 72); t3.lineTo(56 + fx, 100); t3.lineTo(44 + fx, 100); t3.closePath(); fillWith(g, Tie, t3)
  const t4 = new Path2D(); t4.moveTo(46, 72); t4.lineTo(54, 72); t4.lineTo(52, 78); t4.lineTo(48, 78); t4.closePath(); fillWith(g, TieDk, t4)
}

function drawHead(g) {
  circle(g, 23, 44, 5.5, Skin)
  circle(g, 77, 44, 5.5, Skin)
  rrect(g, 25, 16, 50, 46, 20, Skin)
  const hair = new Path2D()
  hair.moveTo(25, 30)
  hair.quadraticCurveTo(25, 8, 50, 8)
  hair.quadraticCurveTo(75, 8, 75, 30)
  hair.lineTo(75, 42)
  hair.lineTo(69, 33); hair.lineTo(61, 40); hair.lineTo(53, 31); hair.lineTo(45, 39); hair.lineTo(37, 31); hair.lineTo(31, 40)
  hair.lineTo(25, 36)
  hair.closePath()
  fillWith(g, Ink, hair)
  rrect(g, 25, 28, 5, 18, 2, Ink)
  rrect(g, 70, 28, 5, 18, 2, Ink)
}

/** A fedora: crown over the hair, a band, a brim that overhangs. */
function drawHat(g, a) {
  if (a < 0.01) return
  const lift = (1 - a) * -12                     // drops in from above
  g.save(); g.translate(0, lift)
  rrect(g, 30, 6, 40, 20, 8, withA(Ink, a))
  rrect(g, 18, 22, 64, 6.5, 3.2, withA(Ink, a))
  rrect(g, 30, 18, 40, 4, 1, withA(Tie, a))
  g.restore()
}

function drawFace(g, eyeOpen, happy, px, py, mouth, confused, wow = 0, serious = 0, glasses = 0, glassesDrop = 0) {
  // The face as an expression system: a few dials, not shapes per mood.
  const open = clamp(eyeOpen, 0, 1.3)
  const squint = happy
  const lift = -0.55 * wow - 0.35 * happy + 0.10 * serious
  const knit = serious
  const worry = 0
  const quiz = confused
  const curve = mouth
  const round = wow

  const eyeY = 48.5
  const ew = 10.4, eh = 12.4
  const EX = [40.5, 59.5]
  for (let k = 0; k < 2; k++) {
    const ex = EX[k]
    const sgn = k === 0 ? -1 : 1                                 // outer side
    const cx = ex, cy = eyeY
    const wide = 1 + 0.10 * max(open - 1, 0)
    const w = ew * wide, h = eh * wide
    const white = new Path2D()
    white.ellipse(cx, cy, w / 2, h / 2, 0, 0, TAU)
    // Happy eyes: the eye closes into an upward arc.
    if (squint > 0.55) {
      const a = clamp01((squint - 0.55) / 0.45)
      const arc = new Path2D(); arc.moveTo(cx - 4.8, cy + 1.6); arc.quadraticCurveTo(cx, cy - 5.6, cx + 4.8, cy + 1.6)
      if (a > 0) strokeWith(g, withA(Ink, a), 3.0, 'round', 'miter', arc)
    }
    const eyeA = 1 - clamp01((squint - 0.55) / 0.45)
    if (eyeA > 0.01) {
      fillWith(g, withA(White, eyeA), white)
      g.save(); g.clip(white)
      // The pupil: converges inward a hair, tracks the gaze, stays inside.
      const ix = cx + clamp(px, -2.6, 2.6) - sgn * 0.5
      const iy = cy + clamp(py, -2.2, 2.2) + 0.8
      const pw = 5.6, ph = 7.4
      rrect(g, ix - pw / 2, iy - ph / 2, pw, ph, 2.8, withA(Accent, eyeA))
      rrect(g, ix - pw * 0.30, iy - ph * 0.28, pw * 0.60, ph * 0.56, 1.8, withA(PupilInk, eyeA))
      circle(g, ix - 1.5, iy - 1.8, 2.0, withA(White, eyeA))
      circle(g, ix + 1.5, iy + 1.7, 0.6, withA(White, 0.6 * eyeA))
      // The upper lid, coming down: skin over the white, a soft shadow under
      // its edge and a lash line along it.
      const cov = (1 - Math.min(open, 1)) * 1.08
      if (cov > 0.02) {
        const lidBottom = cy - h / 2 + h * cov
        rect(g, cx - w, cy - h, w * 2, lidBottom - (cy - h), withA(Skin, eyeA))
        gradRect(g, cx - w, lidBottom, w * 2, 2.2, withA(Ink, 0.22 * eyeA), lidBottom, lidBottom + 2.2)
        line(g, withA(Ink, 0.85 * eyeA), P(cx - w / 2, lidBottom), P(cx + w / 2, lidBottom), 1.5, 'round')
      } else {
        // Open: a whisper of shadow from the lid on the top of the white.
        gradRect(g, cx - w, cy - h / 2, w * 2, 2.4, withA(Ink, 0.16 * eyeA), cy - h / 2, cy - h / 2 + 2.4)
      }
      // The lower lid, rising in a squint.
      if (squint > 0.02 && squint <= 0.55) {
        const rise = h * 0.42 * (squint / 0.55)
        const lidTop = cy + h / 2 - rise
        rect(g, cx - w, lidTop, w * 2, h, withA(Skin, eyeA))
        line(g, withA(Ink, 0.45 * eyeA), P(cx - w / 2 + 1, lidTop), P(cx + w / 2 - 1, lidTop), 1.1, 'round')
      }
      g.restore()
    }
  }

  // Blush: warm on the cheeks, warmer with a smile.
  const blushA = 0.32 + (0.30 * clamp(curve, 0, 1.4)) / 1.4
  circle(g, 33, 56, 3.8, withA(Blush, blushA))
  circle(g, 67, 56, 3.8, withA(Blush, blushA))

  // Brows: thick, dark, just under the fringe.
  for (let k = 0; k < 2; k++) {
    const ex = EX[k]
    const sgn = k === 0 ? -1 : 1
    const base = 40.8 - 3.2 * lift
    const innerY = base + 2.8 * knit - 2.6 * worry + (k === 0 ? -2.8 : 0.9) * quiz
    const outerY = base - 0.4 * knit + 0.6 * worry + (k === 0 ? -1.2 : 0.3) * quiz
    const peakY = base - 1.0 + 0.6 * knit - 1.4 * worry + (k === 0 ? -2.2 : 0.6) * quiz
    const innerX = ex - sgn * (4.4 - 0.9 * knit)
    const outerX = ex + sgn * 5.0
    const p = new Path2D(); p.moveTo(innerX, innerY); p.quadraticCurveTo(ex + sgn * 1.4, peakY, outerX, outerY)
    strokeWith(g, Ink, 3.0, 'round', 'miter', p)
  }

  // Glasses: they sit on, then slide down and off (glassesDrop 0 → 1).
  if (glasses > 0.01) {
    const gy = 46 + 22 * glassesDrop
    const a = clamp01(glasses * (1 - glassesDrop))
    const gc = withA(Ink, a)
    rrect(g, 33, gy - 4.5, 15, 9.5, 4, withA(White, 0.28 * a))
    rrect(g, 52, gy - 4.5, 15, 9.5, 4, withA(White, 0.28 * a))
    rrect(g, 33, gy - 4.5, 15, 9.5, 4, gc, 1.7)
    rrect(g, 52, gy - 4.5, 15, 9.5, 4, gc, 1.7)
    line(g, gc, P(48, gy - 1.5), P(52, gy - 1.5), 1.7, 'round')          // bridge
    line(g, gc, P(33, gy - 1.5), P(25, gy - 3), 1.5, 'round')            // arms to the ears
    line(g, gc, P(67, gy - 1.5), P(75, gy - 3), 1.5, 'round')
    // A thin glint so the lenses read as glass, not holes.
    line(g, withA(White, 0.35 * gc[3]), P(36, gy - 2.5), P(40, gy - 2.5), 1.2, 'round')
    line(g, withA(White, 0.35 * gc[3]), P(55, gy - 2.5), P(59, gy - 2.5), 1.2, 'round')
  }
  // The mouth: an "o" (wow), a wavy "hmm" (confused), a frown…smile curve,
  // and past a plain smile an open mouth with teeth and a tongue.
  const my = 58.5
  if (round > 0.01) {
    const r = 2.4 + 1.8 * round
    oval(g, 50 - r * 0.85, my - r, r * 1.7, r * 2.2, withA(MouthDark, round))
    oval(g, 50 - r * 0.85, my - r, r * 1.7, r * 2.2, withA(Ink, round), 1.6)
  }
  if (quiz > 0.01) {
    const p = new Path2D()
    p.moveTo(45, my + 0.5); p.quadraticCurveTo(47.5, my - 2.5, 50, my + 0.5); p.quadraticCurveTo(52.5, my + 3.5, 55, my + 0.5)
    strokeWith(g, withA(Ink, 0.85 * quiz), 2.4, 'round', 'miter', p)
  }
  const plainA = (1 - quiz) * (1 - round)
  if (plainA > 0.01) {
    const mw = lerp(5.5, 9.2, clamp(curve, 0, 1.4) / 1.4)
    const openness = clamp01((curve - 0.95) / 0.45)
    const dip = 6.5 * curve + 4 * openness
    if (openness > 0.01) {
      const mouthPath = new Path2D()
      mouthPath.moveTo(50 - mw, my)
      mouthPath.quadraticCurveTo(50, my + dip, 50 + mw, my)
      mouthPath.quadraticCurveTo(50, my + 1.2, 50 - mw, my)
      mouthPath.closePath()
      fillWith(g, withA(MouthDark, plainA * openness), mouthPath)
      g.save(); g.clip(mouthPath)
      rrect(g, 50 - mw + 1.5, my, mw * 2 - 3, 2.6, 1, withA(White, plainA * openness))
      oval(g, 50 - 4, my + 2.5 + 2 * curve, 8, 6, withA(Tongue, plainA * openness))
      g.restore()
    }
    const lip = new Path2D(); lip.moveTo(50 - mw, my); lip.quadraticCurveTo(50, my + dip, 50 + mw, my)
    strokeWith(g, withA(Ink, 0.85 * plainA), 2.5, 'round', 'miter', lip)
    // A frown pulls the corners down and adds a small crease under the lip.
    if (curve < -0.05) line(g, withA(Ink, 0.25 * plainA * (-curve)), P(47, my + 4.5), P(53, my + 4.5), 1.2, 'round')
  }
}

/**
 * Keyboard + both hands. kb 0..1 slides the keyboard up and brings the hands
 * onto it; tapL/tapR 0..1 are the key hops; scratch moves the right hand to
 * the temple; thumbs raises the left hand in a thumbs-up.
 */
function drawKeyboardAndHands(g, o) {
  const { kb, tapL, tapR, scratch, thumbs, cover, wave, phone, selfie, youToo, beckon, okThumb, matched, detective,
    reaching, clock, fidget = 0, pointing = 0, scan = 0, shrug = 0, bigThumb = 0, tab = 0, wired = 0, askFinger = 0,
    eyeScan = 0, perch = 0, pointUp = 0, wipe = 0, shield = 0, tipping = 0, handTip = 1 } = o
  // Tablet + wire. The tab rises into his left hand; a wire leaves its right
  // edge. With a scanner the wire ends in a pad his finger presses; without
  // one (shrug) it ends in a loose plug in his right hand.
  const press = sin(clock * TAU) * 0.5 + 0.5                 // 0 lifted … 1 pressed
  const tabY = lerp(108, 62, tab)                            // tab top edge
  const padY = 86
  // The plug hand jabs toward the tab's port and misses, twice a second.
  const jab = sin(clock * TAU * 2) * 0.5 + 0.5
  const plugAt = P(lerp(63, 51, jab), 76 - 3 * jab)
  if (tab > 0.01) {
    g.save(); rotateP(g, -6, 32, tabY + 16)
    rrect(g, 19, tabY, 26, 34, 3, Ink)
    rrect(g, 21, tabY + 2.5, 22, 29, 1.8, Skin)
    // Something on the screen: a title bar and a fingerprint outline.
    rrect(g, 23, tabY + 5, 14, 2, 1, Keys)
    circle(g, 32, tabY + 19, 5, withA(Accent, 0.5), 1.3)
    circle(g, 32, tabY + 19, 2.6, withA(Accent, 0.5), 1.3)
    g.restore()
    if (wired > 0.5) {
      // Connected: wire from the tab's port to the scanner — on the desk, or
      // up at his eye for the iris scan.
      const padAt = lerpP(P(60, padY + 4), P(74, 52), eyeScan)
      const wire = new Path2D()
      wire.moveTo(44, tabY + 22)
      wire.bezierCurveTo(52, tabY + 22, 50, padAt.y + 12, padAt.x, padAt.y)
      strokeWith(g, withA(Ink, 0.85 * tab), 1.6, 'round', 'miter', wire)
    } else if (shrug > 0.01) {
      // Not connected: the wire hangs from the plug in his hand down to a
      // scanner dangling below.
      const dangle = P(plugAt.x + 6 + 2 * jab, 96)
      const wire = new Path2D()
      wire.moveTo(plugAt.x, plugAt.y + 3)
      wire.bezierCurveTo(plugAt.x - 6, plugAt.y + 14, dangle.x + 8, dangle.y - 10, dangle.x, dangle.y - 4)
      strokeWith(g, withA(Ink, 0.85 * shrug), 1.6, 'round', 'miter', wire)
      g.save(); rotateP(g, 18 * (jab - 0.5), dangle.x, dangle.y)
      rrect(g, dangle.x - 9, dangle.y - 3, 18, 9, 2.8, withA(Keys, shrug))
      rrect(g, dangle.x - 7, dangle.y - 1, 14, 5, 1.6, withA(SkinDk, shrug))
      g.restore()
      // Port on the tab that he keeps missing.
      rrect(g, 43, tabY + 20, 2.4, 4, 0.8, Keys)
    }
    if (wired > 0.01 && eyeScan < 0.5) {
      // Scanner pad on the end of the wire: LED on when connected, the sweep
      // only while reading.
      rrect(g, 58, padY, 24, 12, 3.5, Keys)
      rrect(g, 61, padY + 2.5, 18, 7, 2, SkinDk)
      if (scan > 0.01) {
        const sweep = padY + 2.5 + 7 * ((clock * 1.5) % 1)
        line(g, withA(Accent, 0.8 * scan), P(61.5, sweep), P(78.5, sweep), 1.2, 'round')
      }
      circle(g, 80, padY + 2, 1.1, withA(Accent, wired))
    }
  }
  // Thumbs pump twice a second while up; the detective's finger jabs on the same beat.
  const pump = sin(clock * TAU * 2) * 0.5 + 0.5
  // Phone: rises from below the hem into both hands at chest height, then
  // (selfie) travels up and out to the left at arm's length, tilting.
  const chestY = lerp(106, 74, phone)
  const pc = lerpP(P(50, chestY), P(7, 50), selfie)          // phone centre
  const tilt = -24 * selfie
  const grow = 1 + 0.3 * selfie                              // nearer the viewer, a little bigger
  if (phone > 0.01) {
    g.save(); rotateP(g, tilt, pc.x, pc.y); scaleP(g, grow, grow, pc.x, pc.y)
    rrect(g, pc.x - 7, pc.y - 10, 14, 20, 2.8, Ink)
    rrect(g, pc.x - 5.6, pc.y - 8.4, 11.2, 16.8, 1.6, Skin)
    // The company's gear on the screen, faint, behind whatever it shows.
    drawIvGear(g, pc.x, pc.y + 0.6, 3.6, withA(Accent, 0.35))
    if (selfie < 0.5) {
      // Feed: lines scrolling up on the clock.
      const scroll = ((clock * 3) % 1) * 5
      for (let i = 0; i < 4; i++) {
        const ly = pc.y - 6 + i * 5 - scroll
        if (ly > pc.y - 7 && ly < pc.y + 9) rrect(g, pc.x - 4, ly, 8 - (i % 2) * 2.5, 1.6, 0.8, Keys)
      }
    } else {
      // Selfie camera open: a tiny him on the screen, and the shutter dot.
      circle(g, pc.x, pc.y - 3, 3.2, Ink)
      circle(g, pc.x, pc.y - 2.2, 2.4, Skin)
      circle(g, pc.x - 0.9, pc.y - 2.6, 0.5, Ink)
      circle(g, pc.x + 0.9, pc.y - 2.6, 0.5, Ink)
      rrect(g, pc.x - 3.4, pc.y + 0.8, 6.8, 3.2, 1.6, Ink)
      circle(g, pc.x, pc.y + 6.2, 1.4, Accent)
      circle(g, pc.x, pc.y + 6.2, 0.7, Skin)
    }
    g.restore()
  }
  // Keyboard rises from below the hem.
  if (kb > 0.01) {
    const ky = lerp(104, 84, kb)
    rrect(g, 20, ky, 60, 14, 3.5, Keys)
    for (let r = 0; r < 2; r++) for (let c = 0; c < 9; c++) {
      rrect(g, 23 + c * 6.2, ky + 2.4 + r * 5.4, 4.6, 3.8, 1, KeyCap)
    }
    rrect(g, 35, ky + 8.2, 30, 3.8, 1, KeyCap)
  }

  // Hands over the eyes: at 1 they cover, below ~0.75 they sit under the
  // eyes and spread a little (peeking).
  const coverY = lerp(80, 46, cover)
  const spread = lerp(3, 0, clamp01((cover - 0.7) / 0.3))

  // Left hand: rests → keys → over the eye → thumbs-up.
  {
    const restL = P(30 + 0.8 * fidget, 100)
    const keyL = P(38, 84 - 3.5 * tapL - 0.5 * fidget)
    const eyeL = P(40 - spread, coverY)
    const upL = P(20, 70 - 2.5 * pump)
    // Holding the phone: at the chest with both hands; raised, the left hand
    // alone grips its lower edge at arm's length.
    const holdL = lerpP(P(41, chestY + 6), P(pc.x + 2, pc.y + 13), selfie)
    const reachL = P(4, 84)                                   // down and out toward the Start pill
    const shrugL = P(30, tabY + 33)                           // gripping the tab's bottom edge
    let pos = lerpP(restL, keyL, kb)
    pos = lerpP(pos, holdL, phone)
    pos = lerpP(pos, eyeL, cover)
    pos = lerpP(pos, reachL, reaching)
    pos = lerpP(pos, shrugL, tab)
    pos = lerpP(pos, upL, thumbs)
    if (thumbs < 0.5) hand(g, pos, P(16, 92), { fingers: cover, point: reaching })
    else thumbUp(g, pos, P(16, 92), thumbs)
  }
  // Right hand: rests → keys → over the eye → head-scratch → wave.
  {
    const restR = P(70 - 0.8 * fidget, 100)
    const keyR = P(62, 84 - 3.5 * tapR + 0.5 * fidget)
    const eyeR = P(60 + spread, coverY)
    const wob = sin(clock * TAU * 2) * 1.6
    const headR = P(76 + wob, 26)
    // Wave: hand up beside the head, swinging side to side.
    const swing = sin(clock * TAU * 2.2) * 7 * wave
    const waveR = P(90 + swing, 28 + abs(swing) * 0.25)
    // On the phone the right thumb flicks upward every so often.
    const flick = clamp01((sin(clock * TAU * 3) - 0.6) / 0.4) * 3
    // Holds the phone at the chest; once raised the right hand is free — it
    // rests, or comes up open toward the viewer for "you too".
    const holdR = lerpP(P(59, chestY + 4 - flick), P(74, 92), selfie)
    const youR = P(88, 52)
    // Beckon: open hand at shoulder height, pulling in and back, twice a second.
    const pull = sin(clock * TAU * 2) * 0.5 + 0.5
    const beckonR = P(lerp(90, 78, pull), 50 - 3 * pull)
    const thumbR = P(86, 60 - 2.5 * pump)
    // Matched: second thumb up. Detective: arm across, pointing left.
    const matchR = P(80, 70 - 2.5 * pump)
    const pointR = P(68 - 2.5 * pump, 66)
    const castR = P(76 - 2.5 * pump, 58)                      // casual point, no suit
    const scanR = P(70, padY - 9 + 2.5 * press)               // finger over the scanner
    let pos = lerpP(restR, keyR, kb)
    pos = lerpP(pos, holdR, phone)
    pos = lerpP(pos, youR, youToo)
    pos = lerpP(pos, beckonR, beckon)
    pos = lerpP(pos, thumbR, okThumb)
    pos = lerpP(pos, matchR, matched)
    // The detective's across-the-body point, unless he is acting a tip out.
    pos = lerpP(pos, pointR, detective * (1 - tipping * handTip))
    // On the pill: the arm drops and the finger points straight down, with a slow bob.
    pos = lerpP(pos, P(82, 76 - 1.5 * pump), perch)
    // "Up here": hand up beside the head, index finger straight up.
    pos = lerpP(pos, P(86, 36 - 1.2 * pump), pointUp)
    // Wiping: the hand sweeps side to side over the pad with a cloth.
    pos = lerpP(pos, P(70 + 7 * sin(clock * TAU * 1.5), padY - 8), wipe)
    // Shielding the eyes from glare: flat hand at the brow.
    pos = lerpP(pos, P(62, 39), shield)
    pos = lerpP(pos, castR, pointing)
    pos = lerpP(pos, scanR, scan)
    pos = lerpP(pos, plugAt, shrug)                           // holding the loose plug up
    pos = lerpP(pos, P(76, 62), bigThumb)
    // Hovering above the scanner, finger pointing down at it, with a small bob.
    pos = lerpP(pos, P(70, 72 - 1.5 * pump), askFinger)
    // Iris scanner held just beside the right eye.
    pos = lerpP(pos, P(80, 56), eyeScan)
    pos = lerpP(pos, eyeR, cover)
    pos = lerpP(pos, headR, scratch)
    pos = lerpP(pos, waveR, wave)
    if (bigThumb > 0.5) {
      thumbUp(g, pos, P(84, 92), bigThumb, true, 1 + 1.9 * bigThumb)
    } else if (okThumb > 0.5 || matched > 0.5) {
      thumbUp(g, pos, P(84, 92), max(okThumb, matched), true)
    } else {
      hand(g, pos, P(84, 92), {
        fingers: cover,
        open: max(wave, youToo, beckon, 0.6 * shield),
        point: max(detective * (1 - perch) * (1 - tipping * handTip), pointing),
        sleeve: detective,
        pressDown: max(scan, 0.8 * askFinger, 0.5 * wipe),
        pointDown: perch * (1 - wipe) * (1 - shield) * (1 - scan) * (1 - eyeScan),
        pointUp,
      })
      // The cloth, under the wiping hand.
      if (wipe > 0.5) rrect(g, pos.x - 7, pos.y + 4, 14, 6, 3, Shirt)
      // The iris scanner beside the eye, its window facing it; a faint beam.
      if (eyeScan > 0.5) {
        const c = P(72, 47)
        line(g, withA(Accent, 0.22), P(c.x - 6, c.y), P(61, 46), 5, 'round')
        rrect(g, c.x - 6, c.y - 6.5, 13, 13, 3, Keys)
        circle(g, c.x - 1, c.y, 4.2, withA(Ink, 0.85))
        circle(g, c.x - 1, c.y, 4.2, withA(Accent, 0.9), 1.2)
        circle(g, c.x + 4.6, c.y - 4.6, 1, Accent)
      }
      // The loose plug, pinched in the hand.
      if (shrug > 0.5) rrect(g, pos.x - 2.2, pos.y - 9, 4.4, 6, 1, Ink)
    }
  }
}

// ── Hands ─────────────────────────────────────────────────────────────
// A real hand, seen from the back: a palm, four fingers of different
// lengths (index, middle, ring, little), each with a shadow side, a knuckle
// crease and a nail, and a thumb that sets on the inner edge. Poses:
//   relaxed  fingers curled under, knuckles showing
//   flat     fingers together, pointing up (covering the eyes); gap spreads them
//   spread   fingers fanned (the wave)
//   point    index out along a direction, the rest curled, thumb tucked
const FINGER_LEN = [0.9, 1, 0.94, 0.74]
function finger(g, base, dir, len, w = 2.9, nail = true) {
  const tip = add(base, P(dir.x * len, dir.y * len))
  line(g, SkinDk, add(base, P(0.55, 0.6)), add(tip, P(0.55, 0.6)), w + 0.35, 'round')
  line(g, Skin, base, tip, w, 'round')
  // Knuckle crease at two-fifths, across the finger.
  const m = lerpP(base, tip, 0.45), nx = -dir.y * (w * 0.32), ny = dir.x * (w * 0.32)
  line(g, withA(SkinDk, 0.75), add(m, P(-nx, -ny)), add(m, P(nx, ny)), 0.6, 'round')
  if (nail && len > 2.5) {
    const n = add(tip, P(-dir.x * 1.15, -dir.y * 1.15))
    circle(g, n.x, n.y, w * 0.3, withA(Shirt, 0.5))
  }
  return tip
}
const unit = (x, y) => { const l = Math.hypot(x, y) || 1; return P(x / l, y / l) }
const rotV = (v, deg) => { const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r); return P(v.x * c - v.y * s, v.x * s + v.y * c) }

function drawHandShape(g, at, inward, pose, { dir = P(0, -1), gap = 0 } = {}) {
  const pw = 11.4, ph = 10.4
  const top = at.y - ph / 2
  // Where each finger leaves the palm, index nearest the thumb.
  const baseOf = (i) => P(at.x + inward * (3.9 - i * 2.6), top + 1.4 + (i === 3 ? 0.6 : 0))
  // Palm, one-step shadow, then the thumb behind or in front as the pose needs.
  rrect(g, at.x - pw / 2 + 0.8, top + 1, pw, ph, 4.6, SkinDk)
  rrect(g, at.x - pw / 2, top, pw, ph, 4.6, Skin)
  line(g, withA(SkinDk, 0.6), P(at.x - 3.2, at.y + ph / 2 - 0.4), P(at.x + 3.2, at.y + ph / 2 - 0.4), 0.7, 'round')

  if (pose === 'flat') {
    for (let i = 0; i < 4; i++) {
      const fan = (i - 1.5) * (1.8 + gap * 5) * -inward
      finger(g, baseOf(i), rotV(P(0, -1), fan), 7.8 * FINGER_LEN[i])
    }
    finger(g, P(at.x + inward * 4.8, at.y + 1.2), unit(inward * 0.9, -1), 5.4, 3.2)
  } else if (pose === 'spread') {
    for (let i = 0; i < 4; i++) finger(g, baseOf(i), rotV(P(0, -1), (i - 1.5) * 15 * -inward), 8 * FINGER_LEN[i])
    finger(g, P(at.x + inward * 5, at.y + 1.4), unit(inward, -0.35), 5.6, 3.2)
  } else {
    // Relaxed or pointing: curled fingers show as rolled segments along the
    // lower edge, a knuckle bump above each.
    for (let i = 0; i < 4; i++) {
      if (pose === 'point' && i === 0) continue
      const b = baseOf(i)
      circle(g, b.x, b.y - 0.4, 1.45, Skin)
      const kx = b.x, ky = at.y + 1.8
      rrect(g, kx - 1.35 + 0.45, ky + 0.5, 2.7, 4.2 * (i === 3 ? 0.85 : 1), 1.35, SkinDk)
      rrect(g, kx - 1.35, ky, 2.7, 4.2 * (i === 3 ? 0.85 : 1), 1.35, Skin)
    }
    if (pose === 'point') {
      finger(g, baseOf(0), dir, 10.5)
      // Thumb tucked across the curled fingers.
      line(g, SkinDk, P(at.x + inward * 4.4, at.y + 2.4), P(at.x + inward * 0.6, at.y + 3.6), 3.5, 'round')
      line(g, Skin, P(at.x + inward * 4.4, at.y + 2), P(at.x + inward * 0.6, at.y + 3.2), 3.2, 'round')
    } else {
      finger(g, P(at.x + inward * 4.6, at.y + 1.6), unit(inward * 0.75, -1), 4.8, 3.3)
    }
  }
}

function hand(g, at, shoulder, { fingers = 0, open = 0, point = 0, sleeve = 0, pressDown = 0, pointDown = 0, pointUp = 0 } = {}) {
  if (at.y >= 99) return
  // Arm: shirt sleeve for the upper half, skin for the forearm; a suit
  // sleeve (ink) runs the whole arm when sleeve > 0.
  const elbow = lerpP(shoulder, at, 0.42)
  line(g, Shirt, shoulder, elbow, 9, 'round')
  line(g, Skin, elbow, at, 6.6, 'round')
  if (sleeve > 0.01) line(g, withA(Ink, sleeve), shoulder, lerpP(shoulder, at, 0.8), 9, 'round')
  const inward = at.x < 50 ? 1 : -1
  const inward2 = inward
  if (pressDown > 0.01) return drawHandShape(g, at, inward2, 'point', { dir: unit(0, 1) })
  if (pointDown > 0.01) return drawHandShape(g, at, inward2, 'point', { dir: unit(-inward * 0.08, 1) })
  if (pointUp > 0.01) return drawHandShape(g, at, inward2, 'point', { dir: unit(-inward * 0.05, -1) })
  if (point > 0.01) return drawHandShape(g, at, inward2, 'point', { dir: unit(-15, 9) })
  if (open > 0.3) return drawHandShape(g, at, inward2, 'spread')
  if (fingers > 0.3) return drawHandShape(g, at, inward2, 'flat', { gap: clamp01((fingers - 0.6) / 0.4) })
  return drawHandShape(g, at, inward2, 'relaxed')
}

function thumbUp(g, at, shoulder, t, mirror = false, scale = 1) {
  const wrist = add(at, P(0, 4))
  const elbow = lerpP(shoulder, wrist, 0.42)
  line(g, Shirt, shoulder, elbow, 9, 'round')
  line(g, Skin, elbow, wrist, 6.6, 'round')
  // Oversized (comic) thumbs-up: the fist scales about its own centre.
  if (scale !== 1) {
    g.save(); scaleP(g, scale, scale, at.x, at.y)
    thumbFist(g, at, t, mirror)
    g.restore()
    return
  }
  thumbFist(g, at, t, mirror)
}

function thumbFist(g, at, t, mirror) {
  // A fist seen from the side: four rolled fingers stacked, each with a
  // knuckle, a one-step shadow, and the thumb rising from the top with a nail.
  rrect(g, at.x - 4.7, at.y - 3.5, 11.2, 10.2, 3.6, SkinDk)
  rrect(g, at.x - 5.6, at.y - 4.6, 11.2, 10.2, 3.6, Skin)
  for (let i = 0; i < 4; i++) {
    const y = at.y - 3.6 + i * 2.5
    rrect(g, at.x + 1.2 + 0.4, y + 0.4, 5.2, 2.4, 1.2, SkinDk)
    rrect(g, at.x + 1.2, y, 5.2, 2.4 - (i === 3 ? 0.3 : 0), 1.2, Skin)
  }
  const th = 8.5 * clamp01((t - 0.5) / 0.5)
  const tx = mirror ? 2.6 : -6.8
  if (th > 0.2) {
    rrect(g, at.x + tx + 0.5, at.y - 3.8 - th + 0.5, 4.2, th + 3.4, 2.1, SkinDk)
    rrect(g, at.x + tx, at.y - 3.8 - th, 4.2, th + 3.4, 2.1, Skin)
    line(g, withA(SkinDk, 0.7), P(at.x + tx + 0.8, at.y - 3.8 - th * 0.45), P(at.x + tx + 3.4, at.y - 3.8 - th * 0.45), 0.6, 'round')
    rrect(g, at.x + tx + 1, at.y - 3.6 - th, 2.2, 2.2, 1.1, withA(Shirt, 0.5))
  }
}

/**
 * Namaste: both palms pressed together at the chest, fingers up, thumbs
 * crossed in front. One shape that scales in where it belongs.
 */
function drawNamaste(g, a, fidget) {
  if (a < 0.01) return
  const c = P(50, 79 - 0.5 * fidget)
  const al = smoothstep01(a)
  // Arms: shirt to the elbow, skin to the wrist, from both shoulders.
  for (const sideSign of [-1, 1]) {
    const shoulder = P(50 + sideSign * 34, 92)
    const wrist = add(c, P(sideSign * 5, 9))
    const elbow = add(lerpP(shoulder, wrist, 0.5), P(sideSign * 4, 3))
    line(g, withA(Shirt, al), shoulder, elbow, 9, 'round')
    line(g, withA(Skin, al), elbow, wrist, 6.6, 'round')
  }
  g.save(); scaleP(g, 0.6 + 0.4 * al, 0.6 + 0.4 * al, c.x, c.y)
  const skin = withA(Skin, al), dk = withA(SkinDk, al)
  // Two palms, meeting on the centre line.
  rrect(g, c.x - 9.6, c.y - 4 + 1, 9.6, 13, 4, dk)
  rrect(g, c.x + 0.9, c.y - 4 + 1, 9.6, 13, 4, dk)
  rrect(g, c.x - 9.6, c.y - 4, 9.6, 13, 4, skin)
  rrect(g, c.x + 0, c.y - 4, 9.6, 13, 4, skin)
  // Four fingers up on each hand, the outer ones a little shorter.
  for (let i = 0; i < 4; i++) {
    const len = 10 - (i === 0 ? 2.5 : 0) - (i === 3 ? 1 : 0)
    const xl = c.x - 8.2 + i * 2.35
    const xr = c.x + 8.2 - i * 2.35
    line(g, dk, P(xl + 0.5, c.y - 2), P(xl + 0.5, c.y - 2 - len), 2.2, 'round')
    line(g, skin, P(xl, c.y - 2), P(xl, c.y - 2 - len), 2.2, 'round')
    line(g, dk, P(xr + 0.5, c.y - 2), P(xr + 0.5, c.y - 2 - len), 2.2, 'round')
    line(g, skin, P(xr, c.y - 2), P(xr, c.y - 2 - len), 2.2, 'round')
  }
  // Thumbs, crossed in front at the top of the palms.
  line(g, skin, add(c, P(-1.5, 1)), add(c, P(2.2, -6.5)), 2.4, 'round')
  line(g, skin, add(c, P(1.5, 1)), add(c, P(-2.2, -6.5)), 2.4, 'round')
  // The seam where the palms meet.
  line(g, dk, add(c, P(0, -3)), add(c, P(0, 8)), 1.1, 'round')
  g.restore()
}

/** Corner brackets around his own face — "centre the face in the guide". */
function drawBrackets(g, a, clock) {
  if (a < 0.01) return
  const breathe = 1 + 0.03 * sin(clock * TAU)
  const l = 50 - 29 * breathe * a, r = 50 + 29 * breathe * a
  const t = 46 - 31 * breathe * a, b = 46 + 25 * breathe * a
  const arm = 7
  const c = withA(Accent, a)
  for (const p of [P(l, t), P(r, t), P(l, b), P(r, b)]) {
    const sx = p.x < 50 ? 1 : -1
    const sy = p.y < 46 ? 1 : -1
    line(g, c, p, add(p, P(sx * arm, 0)), 2.4, 'round')
    line(g, c, p, add(p, P(0, sy * arm)), 2.4, 'round')
  }
}

/** A sun up and to his left — "bright, even light"; struck through for glare. */
function drawSun(g, a, glare, life) {
  if (a < 0.01) return
  const c = P(18, 20 - 6 * (1 - a))
  const col = withA(Accent, a)
  circle(g, c.x, c.y, 5.5 * a, col)
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * TAU + life * TAU * 0.5
    const dx = cos(ang), dy = sin(ang)
    line(g, col, P(c.x + dx * 8, c.y + dy * 8), P(c.x + dx * (11 + 1.5 * a), c.y + dy * (11 + 1.5 * a)), 2, 'round')
  }
  if (glare > 0.01) {
    line(g, withA(Shirt, glare), add(c, P(-11, 11)), add(c, P(11, -11)), 4.6, 'round')
    line(g, withA(TieDk, glare), add(c, P(-11, 11)), add(c, P(11, -11)), 2.6, 'round')
  }
}

/** An hourglass above his head — "hold still until it reads". */
function drawHourglass(g, a, clock) {
  if (a < 0.01) return
  const c = P(82, 14)
  const col = withA(Accent, a)
  const w = 6, h = 8
  const top = new Path2D(); top.moveTo(c.x - w, c.y - h); top.lineTo(c.x + w, c.y - h); top.lineTo(c.x, c.y); top.closePath()
  const bot = new Path2D(); bot.moveTo(c.x - w, c.y + h); bot.lineTo(c.x + w, c.y + h); bot.lineTo(c.x, c.y); bot.closePath()
  strokeWith(g, col, 1.8, 'butt', 'round', top)
  strokeWith(g, col, 1.8, 'butt', 'round', bot)
  // Sand: the bottom fills up on the clock.
  const f = sin(clock * TAU) * 0.5 + 0.5
  rect(g, c.x - w * 0.5 * f, c.y + h - 3 * f, w * f, 3 * f, col)
}

function smoothstep01(x) { const t = clamp01(x); return t * t * (3 - 2 * t) }

function drawQuestion(g, a, clock) {
  if (a < 0.01) return
  const bob = sin(clock * TAU) * 1.4
  const x = 88, y = 16 + bob - 6 * (1 - a)
  const p = new Path2D()
  p.moveTo(x - 4.5, y - 3)
  p.quadraticCurveTo(x - 4.5, y - 9, x, y - 9)
  p.quadraticCurveTo(x + 4.5, y - 9, x + 4.5, y - 3)
  p.quadraticCurveTo(x + 4.5, y + 1, x, y + 2)
  p.lineTo(x, y + 5)
  strokeWith(g, withA(Query, a), 2.6, 'round', 'miter', p)
  circle(g, x, y + 9.5, 1.6, withA(Query, a))
}

function drawBadge(g, scale, confused) {
  if (scale < 0.01) return
  const c = P(80, 80)
  const fill = lerpColor(Accent, Query, clamp01(confused))
  const shade = lerpColor(AccentDk, Muted, clamp01(confused))
  g.save(); scaleP(g, scale, scale, c.x, c.y)
  circle(g, c.x, c.y, 16, fill)
  circle(g, c.x + 1.5, c.y + 1.5, 16, shade, 3)
  const w = 4.2
  if (confused < 0.5) {
    const p = new Path2D(); p.moveTo(c.x - 7, c.y + 0.5); p.lineTo(c.x - 2, c.y + 5.5); p.lineTo(c.x + 7.5, c.y - 5)
    strokeWith(g, OnAccent, w, 'round', 'miter', p)
  } else {
    const x = c.x, y = c.y + 1
    const p = new Path2D()
    p.moveTo(x - 4.5, y - 3)
    p.quadraticCurveTo(x - 4.5, y - 9, x, y - 9)
    p.quadraticCurveTo(x + 4.5, y - 9, x + 4.5, y - 3)
    p.quadraticCurveTo(x + 4.5, y + 1, x, y + 2)
    p.lineTo(x, y + 4)
    strokeWith(g, OnAccent, 3.4, 'round', 'miter', p)
    circle(g, x, y + 8.5, 2, OnAccent)
  }
  g.restore()
}

// ─── React component ──────────────────────────────────────────────────
export default function Verifier({ mood, className, style, outfit = 'formal' }) {
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const moodRef = useRef(normMood(mood))
  const outfitRef = useRef(outfit)
  outfitRef.current = outfit

  // Mood → ref only; the frame loop reads it. No per-frame React renders.
  useEffect(() => { moodRef.current = normMood(mood) })

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return undefined
    const g = canvas.getContext('2d')
    if (!g) return undefined
    const E = createEngine()
    const box = { w: 0, h: 0, dpr: 0, s: 0 }

    const layout = () => {
      const dpr = window.devicePixelRatio || 1
      const w = box.w, h = box.h
      const s = Math.min(w, h) / 100
      box.s = s; box.dpr = dpr
      const cw = w + (OVERFLOW.left + OVERFLOW.right) * s
      const ch = h + (OVERFLOW.top + OVERFLOW.bottom) * s
      canvas.style.left = `${-OVERFLOW.left * s}px`
      canvas.style.top = `${-OVERFLOW.top * s}px`
      canvas.style.width = `${cw}px`
      canvas.style.height = `${ch}px`
      const pw = Math.max(1, Math.round(cw * dpr)), ph = Math.max(1, Math.round(ch * dpr))
      if (canvas.width !== pw) canvas.width = pw
      if (canvas.height !== ph) canvas.height = ph
    }
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect
      box.w = r.width; box.h = r.height
      layout()
    })
    ro.observe(wrap)

    const mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
    E.st.reduced = !!(mq && mq.matches)
    const onMq = () => { E.st.reduced = !!(mq && mq.matches) }
    if (mq) {
      if (mq.addEventListener) mq.addEventListener('change', onMq)
      else if (mq.addListener) mq.addListener(onMq)
    }

    let raf = 0
    const loop = (now) => {
      raf = requestAnimationFrame(loop)
      const m = moodRef.current
      applyOutfit(outfitRef.current)
      const { clock, life } = E.frame(now, m)
      if (box.w <= 0 || box.h <= 0) return
      if ((window.devicePixelRatio || 1) !== box.dpr) layout()
      const s = box.s
      g.setTransform(1, 0, 0, 1, 0, 0)
      g.clearRect(0, 0, canvas.width, canvas.height)
      g.setTransform(box.dpr, 0, 0, box.dpr, 0, 0)
      g.translate(OVERFLOW.left * s, OVERFLOW.top * s)   // grid origin = the div's top-left
      g.save()
      g.scale(s, s)
      drawVerifier(g, E, m, clock, life)
      g.restore()
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      if (mq) {
        if (mq.removeEventListener) mq.removeEventListener('change', onMq)
        else if (mq.removeListener) mq.removeListener(onMq)
      }
      E.dispose()
    }
  }, [])

  return (
    <div ref={wrapRef} className={className} style={{ position: 'relative', aspectRatio: '1 / 1', ...style }}>
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        style={{ position: 'absolute', display: 'block', pointerEvents: 'none', background: 'transparent' }}
      />
    </div>
  )
}
