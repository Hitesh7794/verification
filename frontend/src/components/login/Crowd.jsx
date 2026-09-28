import { useEffect, useRef } from 'react'
import { PEOPLE, drawPerson, easeOutBack, clamp01 } from './people.js'

// Crowd — the candidates along the foot of the cover page.
// A faithful <canvas> port of the Android ui/welcome/Crowd.kt, plus the flat
// tint floor WelcomeScreen.kt draws behind it (tint from 46 % of the height
// down, a 1 px dash hairline on its top edge).
//
// Five people shoulder to shoulder along the bottom edge. They come up one by
// one — ~187 ms apart, each on a 578 ms ease-out with a small overshoot (the
// source's gap 0.055 / span 0.17 of its 3.4 s clock) — beginning `start` ms
// after mount. Then they live: each breathes, sways and blinks on a clock of
// their own. Outer people are drawn first so the middle one stands in front.
//
// SIZING. The canvas fills its CSS box. The source lays the box out as
//   width  = the full page width
//   height = clamp(width / 3.6, 118px, 190px)
// i.e. an aspect ratio of ~3.6 : 1 (wider boxes are fine — the height caps at
// 190). The figure scale is height / 106 (a 100-unit bust, a little air above
// the turban) and each person gets width / 5; at 3.6 : 1 the busts overlap a
// little, which is the "shoulder to shoulder" look. Anything drawn outside the
// box (the rise from below the edge) is clipped, like clipToBounds().

// Scheme (ACTIVE = FlatViolet).
const TINT = '#DDD5F2'
const DASH = '#E3E1EA'

// Crowd(progress, startAt = 0.50, gap = 0.055, span = 0.17) on a 3400 ms clock.
const CLOCK_MS = 3400
const GAP_MS = 0.055 * CLOCK_MS
const SPAN_MS = 0.17 * CLOCK_MS
const CLOCK_SPAN = 600 // the idle clock runs 0…600 s, then repeats
const ORDER = [0, 4, 1, 3, 2] // outer people first, so the middle one stands in front

function drawCrowd(ctx, w, h, sinceStart, t, reduced) {
  // The floor.
  const top = h * 0.46
  ctx.fillStyle = TINT
  ctx.fillRect(0, top, w, h - top)
  ctx.fillStyle = DASH
  ctx.fillRect(0, top - 0.5, w, 1)

  const n = PEOPLE.length
  const k = h / 106
  const slot = w / n
  const TAU = Math.PI * 2
  for (const i of ORDER) {
    const p = PEOPLE[i]
    const local = reduced ? 1 : clamp01((sinceStart - i * GAP_MS) / SPAN_MS)
    if (local <= 0) continue
    const e = easeOutBack(local)
    let breath = 0, sway = 0, eyeOpen = 1
    if (!reduced) {
      breath = Math.sin(TAU * t / p.breathEvery + p.phase)
      sway = Math.sin(TAU * t / (p.breathEvery * 1.7) + p.phase * 2.1)
      const b = (t + p.phase * 2) % p.blinkEvery
      if (b < 0.16) eyeOpen = Math.min(1, Math.max(0.06, 1 - Math.sin(Math.PI * b / 0.16)))
    }
    const cx = slot * (i + 0.5)
    const rise = (1 - e) * 112 * k // from fully below the edge
    ctx.save()
    ctx.translate(cx - 50 * k, h - 100 * k + rise + breath * 0.7 * k)
    ctx.translate(50 * k, 100 * k)
    ctx.rotate((sway * 1.1 * Math.PI) / 180)
    ctx.translate(-50 * k, -100 * k)
    ctx.scale(k, k)
    drawPerson(ctx, p, eyeOpen)
    ctx.restore()
  }
}

export default function Crowd({ start = 0, className, style }) {
  const canvasRef = useRef(null)
  const startRef = useRef(start)
  startRef.current = start

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

    function draw() {
      const dpr = window.devicePixelRatio || 1
      const bw = Math.max(1, Math.round(cssW * dpr))
      const bh = Math.max(1, Math.round(cssH * dpr))
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw
        canvas.height = bh
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, bw, bh)
      if (cssW <= 0 || cssH <= 0) return
      ctx.setTransform(bw / cssW, 0, 0, bh / cssH, 0, 0)
      drawCrowd(ctx, cssW, cssH, clock - startRef.current, (clock / 1000) % CLOCK_SPAN, reduced)
    }

    function frame(now) {
      raf = 0
      if (last != null) clock += Math.min(100, Math.max(0, now - last))
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
