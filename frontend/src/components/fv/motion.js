import { useEffect, useRef, useState } from 'react'

// useScene — one clock for a drawn scene, plus springs that chase their
// targets so nothing in it ever snaps from one pose to the next.
//
//   const { t, v } = useScene({ open: isOpen ? 1 : 0 })
//
// `t` is seconds since mount (frozen at 0 for prefers-reduced-motion) and
// `v` holds the chased values. Repaints are throttled to ~40fps, which is
// plenty for SVG and keeps React out of the way.
export default function useScene(targets, speed = 7.5, minMs = 24) {
  const [, tick] = useState(0)
  const st = useRef({ t: 0, v: {} })
  const tRef = useRef(targets)
  tRef.current = targets
  Object.keys(targets).forEach((k) => {
    if (st.current.v[k] === undefined) st.current.v[k] = targets[k]
  })

  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      st.current.v = { ...tRef.current }
      tick((n) => n + 1)
      return undefined
    }
    let raf = 0, last = performance.now(), paint = 0
    const loop = (now) => {
      raf = requestAnimationFrame(loop)
      const dt = Math.min(0.06, Math.max(0, (now - last) / 1000)); last = now
      st.current.t += dt
      const tg = tRef.current
      Object.keys(tg).forEach((k) => {
        const cur = st.current.v[k] ?? tg[k]
        st.current.v[k] = cur + (tg[k] - cur) * Math.min(1, dt * speed)
      })
      if (now - paint > minMs) { paint = now; tick((n) => n + 1) }
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [speed, minMs])

  return { t: st.current.t, v: st.current.v }
}
