import { useEffect, useRef } from 'react'
import { easeOutBack, clamp01 } from './people.js'

// EmblemDraw — the State Emblem draws itself.
// A faithful <canvas> port of EmblemReveal in the Android
// ui/welcome/WelcomeScreen.kt ("The emblem draws itself").
//
// The lion capital as a raster (/emblem_lions.png, 1100×1571) and beside it an
// ORDER MAP (/emblem_order.png, alpha = 255 − order: how far along the
// engraving each ink pixel lies from the base). A threshold on the order,
// on a steep ramp (k = 7), reveals the ink from the base up to the lions. Two
// passes — the accent with its frontier pushed 22 levels ahead, then ink — leave
// a band of wet violet at the leading edge that dries to ink behind it; the
// raster's own coverage is multiplied back in (DstIn) so the edges stay clean.
// Then the mark settles from 0.94 (pivot bottom-centre), the Ashoka wheel turns
// its last 14° into place, one hairline ring goes out from the wheel, and the
// motto (/emblem_motto.png, tinted ink) tracks in beneath.
//
// Clock t = elapsed / duration (the source's 3.4 s, linear), windows:
//   flow   = smootherstep((t − 0.02) / 0.34)      the ink's progress
//   settle = easeOutBack((t − 0.30) / 0.16)       scale 0.94 → 1, wheel −14° → 0
//   ring   = (t − 0.34) / 0.26                    radius 1.4·R + 0.95·H·ring, α 0.32·(1 − ring)
//   motto  = smootherstep((t − 0.30) / 0.16)      alpha, scaleX 1.14 → 1
//
// Implementation: once per load, the full-resolution order and coverage are
// read into byte arrays; once per resize they are box-filtered to the
// emblem's device-pixel size (order averaged over ink pixels only, so thin
// lines keep their place in the sequence). Each reveal frame builds a 256-entry
// lookup (order → colour, alpha) for the two passes and writes one ImageData,
// touching only pixels the raster covers.
//
// SIZING. The canvas fills its CSS box; the content is fitted inside it
// (centred) at the phone proportions of the source: emblem height E, a gap of
// 0.10·E, the motto 0.12·E tall (100 / 10 / 12 dp). Give the box
//   with motto:    aspect-ratio 0.735 / 1.22 (≈ 0.603), e.g. 72 × 120 px
//   without motto: aspect-ratio 1100 / 1571 (≈ 0.700)
// (the 0.735·E width leaves room for the motto's 1.14× tracking-in).
// The emblem draws in its own box and is clipped to it, including the ring.

// Scheme (ACTIVE = FlatViolet).
const INK = [0x21, 0x1e, 0x33]
const ACC = [0x5b, 0x3f, 0xa6]
const INK_CSS = '#211E33'

const EMBLEM_W = 1100
const EMBLEM_H = 1571
const CHAKRA_X = 560
const CHAKRA_Y = 1330
const CHAKRA_R = 126
const MOTTO_W = 742
const MOTTO_H = 138
const GAP_E = 0.10 // 10 dp under a 100 dp emblem
const MOTTO_E = 0.12 // 12 dp motto under a 100 dp emblem
const K = 7 // the ramp's steepness
const LEAD = 22 // the accent's frontier, ahead of the ink
const END_T = 0.60 // the ring's window closes last

const smootherstep = (x) => { const t = clamp01(x); return t * t * t * (t * (t * 6 - 15) + 10) }

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

/** The image's alpha channel at full resolution. */
function alphaOf(img) {
  const c = makeCanvas(img.naturalWidth, img.naturalHeight)
  const g = c.getContext('2d', { willReadFrequently: true })
  g.drawImage(img, 0, 0)
  const d = g.getImageData(0, 0, c.width, c.height).data
  const a = new Uint8Array(c.width * c.height)
  for (let i = 0, j = 3; i < a.length; i++, j += 4) a[i] = d[j]
  return a
}

/** An image drawn in one solid colour through its own alpha. */
function tinted(img, w, h, color) {
  const c = makeCanvas(w, h)
  const g = c.getContext('2d')
  g.imageSmoothingQuality = 'high'
  g.drawImage(img, 0, 0, w, h)
  g.globalCompositeOperation = 'source-in'
  g.fillStyle = color
  g.fillRect(0, 0, w, h)
  return c
}

/**
 * Box-filter the full-resolution order and coverage down (or nearest up) to
 * dw × dh. Order is averaged over ink pixels only; coverage over all.
 */
function resample(order, cov, dw, dh) {
  const sw = EMBLEM_W, sh = EMBLEM_H
  const outA = new Uint8Array(dw * dh)
  const outC = new Uint8Array(dw * dh)
  const xs = new Int32Array(dw + 1)
  for (let x = 0; x <= dw; x++) xs[x] = Math.min(sw, Math.floor((x * sw) / dw))
  let n = 0
  for (let y = 0; y < dh; y++) {
    const y0 = Math.min(sh - 1, Math.floor((y * sh) / dh))
    const y1 = Math.max(y0 + 1, Math.min(sh, Math.floor(((y + 1) * sh) / dh)))
    for (let x = 0; x < dw; x++) {
      const x0 = Math.min(sw - 1, xs[x])
      const x1 = Math.max(x0 + 1, xs[x + 1])
      let sumA = 0, inkN = 0, sumC = 0
      for (let yy = y0; yy < y1; yy++) {
        let i = yy * sw + x0
        for (let xx = x0; xx < x1; xx++, i++) {
          const a = order[i]
          if (a > 0) { sumA += a; inkN++ }
          sumC += cov[i]
        }
      }
      const o = y * dw + x
      const area = (x1 - x0) * (y1 - y0)
      outC[o] = Math.round(sumC / area)
      outA[o] = inkN ? Math.round(sumA / inkN) : 0
      if (outC[o]) n++
    }
  }
  const idx = new Int32Array(n)
  for (let i = 0, j = 0; i < outC.length; i++) if (outC[i]) idx[j++] = i
  return { a: outA, c: outC, idx }
}

export default function EmblemDraw({ duration = 3400, delay = 0, showMotto = true, className, style }) {
  const canvasRef = useRef(null)
  const propsRef = useRef({ duration, delay, showMotto })
  propsRef.current = { duration, delay, showMotto }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined

    const mq = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null
    let reduced = !!(mq && mq.matches)
    let cssW = 0, cssH = 0
    let clock = 0 // ms of visible running time since mount
    let last = null
    let raf = 0
    let alive = true

    // Loaded once.
    let lionsImg = null, orderFull = null, covFull = null
    let mottoInk = null
    // Per display size.
    let built = null // { w, h, a, c, idx, inkLions, reveal, img, u32, layer }

    const lutRGB = new Uint32Array(256)
    const lutA = new Float32Array(256)

    function build(w, h) {
      if (built && built.w === w && built.h === h) return built
      const { a, c, idx } = resample(orderFull, covFull, w, h)
      const reveal = makeCanvas(w, h)
      const rg = reveal.getContext('2d')
      const img = rg.createImageData(w, h)
      built = {
        w, h, a, c, idx,
        inkLions: tinted(lionsImg, w, h, INK_CSS),
        reveal, rg, img, u32: new Uint32Array(img.data.buffer),
        layer: makeCanvas(w, h),
      }
      return built
    }

    /** Two threshold passes (accent ahead, then ink), times the raster's coverage. */
    function paintReveal(b, flow) {
      const off1 = K * (LEAD - 255 * (1 - flow))
      const off2 = K * (0 - 255 * (1 - flow))
      for (let A = 0; A < 256; A++) {
        const a1 = Math.min(255, Math.max(0, K * A + off1)) / 255
        const a2 = Math.min(255, Math.max(0, K * A + off2)) / 255
        const w1 = a1 * (1 - a2)
        const ao = a2 + w1
        lutA[A] = ao
        if (ao > 0) {
          const r = Math.round((INK[0] * a2 + ACC[0] * w1) / ao)
          const g = Math.round((INK[1] * a2 + ACC[1] * w1) / ao)
          const bl = Math.round((INK[2] * a2 + ACC[2] * w1) / ao)
          lutRGB[A] = (bl << 16) | (g << 8) | r
        } else lutRGB[A] = 0
      }
      const { a, c, idx, u32 } = b
      for (let j = 0; j < idx.length; j++) {
        const i = idx[j]
        const A = a[i]
        const al = Math.round(lutA[A] * c[i])
        u32[i] = al ? (lutRGB[A] | (al << 24)) >>> 0 : 0
      }
      b.rg.putImageData(b.img, 0, 0)
      return b.reveal
    }

    /** The finished mark with the wheel turned `deg` degrees inside its rim. */
    function paintTurn(b, deg) {
      const g = b.layer.getContext('2d')
      const cx = b.w * (CHAKRA_X / EMBLEM_W)
      const cy = b.h * (CHAKRA_Y / EMBLEM_H)
      const r = b.h * (CHAKRA_R / EMBLEM_H)
      g.setTransform(1, 0, 0, 1, 0, 0)
      g.globalCompositeOperation = 'copy'
      g.drawImage(b.inkLions, 0, 0)
      g.globalCompositeOperation = 'destination-out'
      g.beginPath()
      g.arc(cx, cy, r, 0, Math.PI * 2)
      g.fill()
      g.globalCompositeOperation = 'source-over'
      g.save()
      g.clip()
      g.translate(cx, cy)
      g.rotate((deg * Math.PI) / 180)
      g.translate(-cx, -cy)
      g.drawImage(b.inkLions, 0, 0)
      g.restore()
      return b.layer
    }

    function currentT() {
      if (reduced) return 1
      const { duration: d, delay: dl } = propsRef.current
      return clamp01((clock - dl) / Math.max(1, d))
    }

    function draw() {
      const dpr = window.devicePixelRatio || 1
      const bw = Math.max(1, Math.round(cssW * dpr))
      const bh = Math.max(1, Math.round(cssH * dpr))
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw
        canvas.height = bh
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.globalAlpha = 1
      ctx.clearRect(0, 0, bw, bh)
      if (!lionsImg || cssW <= 0 || cssH <= 0) return

      const withMotto = propsRef.current.showMotto
      // Fit the content (in device px).
      const contentW = withMotto ? Math.max(EMBLEM_W / EMBLEM_H, MOTTO_E * (MOTTO_W / MOTTO_H) * 1.14) : EMBLEM_W / EMBLEM_H
      const contentH = withMotto ? 1 + GAP_E + MOTTO_E : 1
      const E = Math.min(bh / contentH, bw / contentW)
      const eh = Math.max(1, Math.round(E))
      const ew = Math.max(1, Math.round(E * (EMBLEM_W / EMBLEM_H)))
      const x0 = Math.round((bw - ew) / 2)
      const y0 = Math.round((bh - E * contentH) / 2)

      const t = currentT()
      const flow = smootherstep((t - 0.02) / 0.34)
      const settle = easeOutBack(clamp01((t - 0.30) / 0.16))
      const ring = clamp01((t - 0.34) / 0.26)
      const mottoIn = smootherstep((t - 0.30) / 0.16)

      const b = build(ew, eh)
      ctx.save()
      ctx.beginPath()
      ctx.rect(x0, y0, ew, eh)
      ctx.clip()
      ctx.save()
      const s = 0.94 + 0.06 * settle
      ctx.translate(x0 + ew / 2, y0 + eh)
      ctx.scale(s, s)
      ctx.translate(-ew / 2, -eh)
      ctx.imageSmoothingQuality = 'high'
      if (flow >= 0.999) {
        ctx.drawImage(settle < 0.999 ? paintTurn(b, -14 * (1 - settle)) : b.inkLions, 0, 0)
      } else if (flow > 0) {
        ctx.drawImage(paintReveal(b, flow), 0, 0)
      }
      ctx.restore()
      // One ring, out from the wheel and gone.
      if (ring > 0 && ring < 1) {
        const cx = x0 + ew * (CHAKRA_X / EMBLEM_W)
        const cy = y0 + eh * (CHAKRA_Y / EMBLEM_H)
        const r = eh * (CHAKRA_R / EMBLEM_H)
        ctx.beginPath()
        ctx.arc(cx, cy, r * 1.4 + eh * 0.95 * ring, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(${INK[0]},${INK[1]},${INK[2]},${0.32 * (1 - ring)})`
        ctx.lineWidth = dpr // 1 dp
        ctx.stroke()
      }
      ctx.restore()

      // The motto tracks in beneath.
      if (withMotto && mottoIn > 0) {
        const mh = E * MOTTO_E
        const mw = mh * (MOTTO_W / MOTTO_H)
        const my = y0 + E * (1 + GAP_E)
        const sx = 1.14 - 0.14 * mottoIn
        ctx.save()
        ctx.globalAlpha = mottoIn
        ctx.translate(bw / 2, my + mh / 2)
        ctx.scale(sx, 1)
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(mottoInk, -mw / 2, -mh / 2, mw, mh)
        ctx.restore()
      }
    }

    function frame(now) {
      raf = 0
      if (last != null) clock += Math.min(100, Math.max(0, now - last))
      last = now
      // Until the rasters are in, hold the clock at the start of the drawing.
      if (!lionsImg) clock = Math.min(clock, propsRef.current.delay)
      draw()
      schedule()
    }
    function schedule() {
      if (raf || reduced || document.hidden || !alive) return
      if (lionsImg && currentT() >= END_T) return // done: the last frame stands
      raf = requestAnimationFrame(frame)
    }
    function stop() {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      last = null
    }

    Promise.all([loadImage('/emblem_lions.png'), loadImage('/emblem_order.png'), loadImage('/emblem_motto.png')])
      .then(([lions, order, motto]) => {
        if (!alive) return
        covFull = alphaOf(lions)
        orderFull = alphaOf(order)
        mottoInk = tinted(motto, MOTTO_W, MOTTO_H, INK_CSS)
        lionsImg = lions
        draw()
        schedule()
      })
      .catch(() => { /* no emblem; the box stays empty */ })

    const ro = new ResizeObserver((entries) => {
      const r = entries[0] && entries[0].contentRect
      if (!r) return
      cssW = r.width
      cssH = r.height
      draw()
    })
    ro.observe(canvas)
    const rect = canvas.getBoundingClientRect()
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
      alive = false
      stop()
      ro.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      if (mq) {
        if (mq.removeEventListener) mq.removeEventListener('change', onMotion)
        else if (mq.removeListener) mq.removeListener(onMotion)
      }
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className={className}
      aria-hidden="true"
      style={{ display: 'block', width: '100%', height: '100%', pointerEvents: 'none', ...style }}
    />
  )
}
