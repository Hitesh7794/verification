// DEMO MODE — click-through prototype for design review.
// Enabled only when Vite runs with VITE_DEMO=1. Off in every real build.
// Bypasses validation, OTP, camera liveness and USB scanners so any
// input advances to the next stage.
export const DEMO = import.meta.env.VITE_DEMO === '1'
export const demoWait = (ms) => new Promise((r) => setTimeout(r, ms))
