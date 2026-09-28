import { useEffect, useRef, useState } from 'react'
import Verifier from '../login/Verifier.jsx'

// FvGuide — the companion, popping out beside whatever you hover.
//
// Hidden until you hover something marked data-guide="…" (optionally
// data-guide-title). Then the page blurs back, that thing zooms forward, and
// he pops up right next to it with his bubble — to its right, below it, above
// it or to its left, whichever has room. He only ever stands over blurred
// page, never over the thing he's explaining, and nothing on the page moves
// to make room for him. Leave it and he and the blur are gone at once.
//
// Review aids: ?guide_demo=<data-guide-title> pins him on that element;
// ?guide_mood=<mood> forces his expression.

const FOCUS_DELAY = 80
const HOVER_DELAY = 260
const W = 252          // his card: bubble on top, him below
const A = 150          // his box
const GAP = 18         // clearance from the zoomed subject
const EDGE = 14        // clearance from the window edge

// First-run tour: shown once per browser for the institution admin and
// the reviewer, then never again. Bump the version if the tour changes.
const TOUR_DONE_KEY = 'fv-guide-tour-done-v1'
// "Fastly" — long enough to read a two-line bubble, short enough to
// keep moving. ~1.8 s per step, ~15 s for a full 8-step tour.
const TOUR_STEP_MS = 1800

// ── Expressions ───────────────────────────────────────────────────────
// He reacts to what he's explaining instead of pointing at everything the
// same way. An element can say how he should feel with data-guide-mood;
// otherwise it's read from its title and text. While you linger he
// alternates with a second beat, so he never freezes into one pose.
const MOOD_RULES = [
  [/institution|application|kyc|waiting on you|papers/i, 'typing', 'file'],
  [/agents can verify|verify now|verify candidates for right now/i, 'typing', 'stamp'],
  [/^my exams$/i, 'typing', 'write'],
  [/history|so far|record|audit/i, 'detective'],
  [/wallet|top up|balance|₹|spend/i, 'matched'],
  [/checked today|today/i, 'right'],
  [/recent|latest|newest/i, 'eyeScan'],
  [/device|scanner|camera|hardware/i, 'typing', 'scan'],
  [/download|installer|laptop|desktop app/i, 'reaching'],
  [/agent/i, 'wave'],
  [/centre|center|busiest/i, 'pointUp'],
  [/volume|per day|week|chart/i, 'point'],
  [/enrolled|registered|candidates/i, 'selfie'],
  [/exam|catalog|board|omr|answer sheet/i, 'selfie', 'omr'],
  [/signed in|sign out|administrator|reviewer|super admin/i, 'wave'],
  [/time|ist|clock/i, 'waiting'],
  [/portal|institution|your institution/i, 'namaste'],
  [/denied|reject|locked|disabled|sent back|fix and resubmit/i, 'confused', 'no'],
  [/approv|verified|pass/i, 'thumbsUp'],
]
const NEXT = {
  detective: 'confused', right: 'matched', matched: 'right', eyeScan: 'point', deviceOk: 'matched',
  reaching: 'deviceOk', wave: 'namaste', namaste: 'wave', pointUp: 'point', point: 'pointUp',
  selfie: 'matched', askFinger: 'pointUp', waiting: 'thumbsUp', confused: 'detective', thumbsUp: 'right',
}
function moodOf(el) {
  const forced = el.getAttribute('data-guide-mood')
  const forcedProp = el.getAttribute('data-guide-prop') || null
  if (forced) return { mood: forced, prop: forcedProp }
  const title = el.getAttribute('data-guide-title') || ''
  const text = el.getAttribute('data-guide') || ''
  for (const [re, m, pr] of MOOD_RULES) if (re.test(title)) return { mood: m, prop: forcedProp || pr || null }
  for (const [re, m, pr] of MOOD_RULES) if (re.test(text)) return { mood: m, prop: forcedProp || pr || null }
  return { mood: 'point', prop: forcedProp }
}

// The paper he writes on for "My exams": lines of handwriting appear
// behind a small pencil; `p` runs 0 → 1 over the page.
const W_LINES = 5
function HeldPaper({ p }) {
  const line = Math.min(W_LINES - 1, Math.floor(p * W_LINES))
  const k = p * W_LINES - line
  const x0 = 10, x1 = 34
  const pen = { x: x0 + (x1 - x0) * k, y: 18 + line * 7 }
  return (
    <svg viewBox="0 0 44 56" className="h-full w-full" aria-hidden="true">
      <rect x="4" y="3" width="36" height="50" rx="3.5" fill="#FFFFFF" stroke="#DDD5F2" strokeWidth="1.4" />
      <rect x="4" y="3" width="36" height="6" rx="3" fill="#5B3FA6" />
      {Array.from({ length: W_LINES }).map((_, i) => {
        const y = 18 + i * 7
        const done = i < line ? 1 : i === line ? k : 0
        const d = `M${x0} ${y} q2 -2.4 4 0 q2 2 4 0 q2 -2.4 4 0 q2 2 4 0 q2 -2.4 4 0 q2 2 4 0`
        return (
          <g key={i}>
            <line x1={x0} y1={y + 2.4} x2={x1} y2={y + 2.4} stroke="#EFEBF9" strokeWidth=".8" />
            {done > 0 && <path d={d} pathLength="1" strokeDasharray="1 1" strokeDashoffset={1 - done} fill="none" stroke="#211E33" strokeWidth="1" strokeLinecap="round" />}
          </g>
        )
      })}
      {/* the pencil, tip on the line */}
      <g transform={`translate(${pen.x} ${pen.y}) rotate(35)`}>
        <path d="M-1.6 -4.5h3.2L0 0z" fill="#F3E3C8" />
        <rect x="-1.6" y="-19" width="3.2" height="14.5" rx=".8" fill="#F28C28" />
        <ellipse cx="0" cy="-9" rx="3" ry="3.6" fill="#F3EAD9" stroke="#E2D4BE" strokeWidth=".6" />
      </g>
      {/* his other hand holding the sheet */}
      <ellipse cx="4.5" cy="40" rx="3.6" ry="5" fill="#F3EAD9" stroke="#E2D4BE" strokeWidth=".8" />
    </svg>
  )
}

// At his desk: the paper lies flat on the table and his hand brings a
// "verified" stamp down on it, presses, lifts, and does it again.
// `k` runs 0 → 1 over one press. Drawn over the lower part of his box, so
// the desk hides his body from the chest down.
function DeskStamp({ k }) {
  const drop = k < 0.35 ? k / 0.35 : k < 0.5 ? 1 : k < 0.8 ? 1 - (k - 0.5) / 0.3 : 0
  const press = k >= 0.35 && k < 0.5
  const squash = press ? 1 - Math.sin(((k - 0.35) / 0.15) * Math.PI) * 0.14 : 1
  const inked = k >= 0.4
  const y = 4 + drop * 16          // stamp face height above the paper → on it
  return (
    <svg viewBox="0 0 100 46" className="h-full w-full overflow-visible" aria-hidden="true">
      {/* the desk */}
      <rect x="2" y="12" width="96" height="6" rx="2.4" fill="#43307D" />
      <rect x="5" y="17" width="90" height="29" fill="#9A86D6" />
      {/* the paper, lying flat (seen in perspective) */}
      <path d="M30 12.6 L70 12.6 L76 22 L24 22 Z" fill="#FFFFFF" stroke="#DDD5F2" strokeWidth=".8" />
      <path d="M30 12.6 L70 12.6 L71.4 14.8 L28.6 14.8 Z" fill="#5B3FA6" />
      {[16.8, 18.6, 20.4].map((ly, r) => (
        <g key={ly}>{[40, 47, 54, 61].map((x, c) => (
          <ellipse key={x} cx={x + (ly - 16) * 0.2 * (c - 1.5)} cy={ly} rx="1.9" ry=".8"
                   fill={c === (r * 2 + 1) % 4 ? '#5B3FA6' : '#FFFFFF'} stroke="#9A86D6" strokeWidth=".4" />
        ))}</g>
      ))}
      {/* the ink it leaves */}
      {inked && (
        <g transform="translate(64 19) scale(1 .45) rotate(-12)" opacity={Math.min(1, (k - 0.4) * 8)}>
          <circle r="6" fill="none" stroke="#5B3FA6" strokeWidth="1.5" />
          <path d="M-2.8 .2l2 2 3.8-4.2" fill="none" stroke="#5B3FA6" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      )}
      {/* the stamp in his hand */}
      <g transform={`translate(64 ${y}) scale(1 ${squash})`}>
        <ellipse cx="0" cy="0" rx="6.5" ry="1.8" fill="#43307D" />
        <rect x="-5.5" y="-3.2" width="11" height="3.4" rx="1" fill="#43307D" />
        <rect x="-2" y="-11" width="4" height="8" rx="1.4" fill="#99641B" />
        <circle cx="0" cy="-12.4" r="3.4" fill="#C99A50" />
      </g>
      {/* his arm, from his shoulder on the right down to the handle */}
      <path d={`M88 3 C 84 ${4 + (y - 4) * 0.3}, 74 ${y - 12}, ${66.5} ${y - 9.5}`} stroke="#FFFFFF" strokeWidth="6.5" strokeLinecap="round" fill="none" />
      <path d={`M88 3 C 84 ${4 + (y - 4) * 0.3}, 74 ${y - 12}, ${66.5} ${y - 9.5}`} stroke="#E3E1EA" strokeWidth=".6" fill="none" />
      <ellipse cx="64" cy={y - 9.5} rx="4.4" ry="3.6" fill="#F3EAD9" stroke="#E2D4BE" strokeWidth=".6" />
      {/* his other hand resting on the desk */}
      <ellipse cx="34" cy="13" rx="4.2" ry="2.6" fill="#F3EAD9" stroke="#E2D4BE" strokeWidth=".6" />
    </svg>
  )
}

// Devices: at his desk he presses his thumb on a fingerprint scanner; the
// glass glows, the ridges light, a tick pops over it, and he lifts off.
function DeskScan({ k }) {
  const down = k < 0.25 ? k / 0.25 : k < 0.7 ? 1 : k < 0.85 ? 1 - (k - 0.7) / 0.15 : 0
  const glow = k > 0.28 && k < 0.78
  const tick = k > 0.45 && k < 0.95 ? Math.min(1, (k - 0.45) / 0.1) : 0
  const ty = -6 + down * 7           // thumb tip height above the glass
  return (
    <svg viewBox="0 0 100 46" className="h-full w-full overflow-visible" aria-hidden="true">
      <rect x="2" y="12" width="96" height="6" rx="2.4" fill="#43307D" />
      <rect x="5" y="17" width="90" height="29" fill="#9A86D6" />
      <g transform="translate(12 0)">
      {/* the scanner */}
      <path d="M48 13c0-7 5-12 13-12s13 5 13 12z" fill="#43307D" />
      <path d="M51 12.6c0-5 4-8.6 10-8.6s10 3.6 10 8.6z" fill="#5B3FA6" />
      <rect x="55" y="6" width="12" height="5" rx="1.6" fill={glow ? '#C3B6E8' : '#DDD5F2'} />
      {glow && <g fill="none" stroke="#FFFFFF" strokeWidth=".7" strokeLinecap="round"><path d="M58 9.6a3 2 0 0 1 6 0" /><path d="M56.6 10a4.4 2.8 0 0 1 8.8 0" /></g>}
      <circle cx="70" cy="8" r="1" fill={glow ? '#F28C28' : '#DDD5F2'} />
      {/* cable off the back */}
      <path d="M74 12 C 82 12, 84 16, 92 16" stroke="#211E33" strokeWidth="1.2" fill="none" opacity=".7" />
      {/* his arm (from his right shoulder, below his face) and thumb */}
      <path d={`M82 9 C 80 ${ty + 2}, 72 ${ty - 8}, 64 ${ty - 4}`} stroke="#FFFFFF" strokeWidth="6.5" strokeLinecap="round" fill="none" />
      <path d={`M82 9 C 80 ${ty + 2}, 72 ${ty - 8}, 64 ${ty - 4}`} stroke="#E3E1EA" strokeWidth=".6" fill="none" />
      <ellipse cx="63" cy={ty - 3} rx="4.6" ry="3.4" fill="#F3EAD9" stroke="#E2D4BE" strokeWidth=".6" />
      <rect x="59" y={ty - 3} width="4.4" height="6" rx="2.2" fill="#F3EAD9" stroke="#E2D4BE" strokeWidth=".6" />
      {/* the tick */}
      {tick > 0 && (
        <g transform={`translate(61 ${-8 - tick * 4}) scale(${tick})`}>
          <circle r="5" fill="#5B3FA6" />
          <path d="M-2.4 .1l1.6 1.6 3.2-3.6" fill="none" stroke="#FFFFFF" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      )}
      </g>
      <ellipse cx="34" cy="13" rx="4.2" ry="2.6" fill="#F3EAD9" stroke="#E2D4BE" strokeWidth=".6" />
    </svg>
  )
}

// The file, held the way it is held at every government desk: a fat
// bundle of papers in a manila cover, tied shut with a saffron string in
// a bow, its edges uneven, a tag on the front with its number, one corner
// dog-eared, and two more waiting behind it. He lifts the cover, reads
// down the page, then lets it fall shut. `k` runs 0 → 1 over one look.
function HeldFile({ k, returned = false }) {
  // Returned files are never opened — he holds them out, stamped.
  const open = returned ? 0 : (k < 0.12 ? k / 0.12 : k < 0.8 ? 1 : k < 0.92 ? 1 - (k - 0.8) / 0.12 : 0)
  const push = returned ? (k < 0.3 ? k / 0.3 : k < 0.75 ? 1 : 1 - (k - 0.75) / 0.25) : 0
  const mark = returned ? Math.min(1, Math.max(0, (k - 0.3) / 0.12)) : 0
  const read = Math.min(1, Math.max(0, (k - 0.15) / 0.6))
  const lift = -18 * open                  // how far the cover is lifted
  const sway = returned ? Math.sin(k * Math.PI * 10) * 2.4 * push : Math.sin(k * Math.PI * 2) * 1.6
  const LINES = 4
  const line = Math.min(LINES - 1, Math.floor(read * LINES))
  return (
    <svg viewBox="0 0 52 56" className="h-full w-full overflow-visible" aria-hidden="true">
      <g transform={`translate(0 ${-6 * push}) rotate(${sway} 26 40)`}>
        {/* the two waiting behind */}
        <rect x="7" y="16" width="38" height="36" rx="2" fill="#DDBB85" transform="rotate(-5 26 34)" />
        <rect x="6" y="14" width="40" height="38" rx="2" fill="#EDD9B8" transform="rotate(3 26 33)" />

        {/* the papers inside, edges never quite level */}
        <g>
          <rect x="9" y="12" width="34" height="38" rx="1.5" fill="#FFFFFF" stroke="#E3E1EA" strokeWidth=".8" />
          <rect x="10.5" y="10.5" width="32" height="38" rx="1.5" fill="#FFFFFF" stroke="#E3E1EA" strokeWidth=".8" />
          <rect x="9.5" y="9" width="33" height="38" rx="1.5" fill="#FFFFFF" stroke="#DDD5F2" strokeWidth=".9" />
          {/* what he is reading, line by line */}
          {Array.from({ length: LINES }).map((_, n) => (
            <rect key={n} x="14" y={17 + n * 6} width={n === LINES - 1 ? 12 : 22} height="2" rx="1"
                  fill={n <= line && open > 0.5 ? '#66627A' : '#DDD5F2'} />
          ))}
          <path d="M14 13l5-3 5 3z" fill="#43307D" opacity={open > 0.5 ? 1 : 0} />
        </g>

        {/* the cover, lifted while he reads */}
        <g transform={`translate(0 ${lift}) rotate(${-10 * open} 8 46)`}>
          <path d="M6 14h40v34a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2z" fill="#EDD9B8" stroke="#DDBB85" strokeWidth="1.2" />
          {/* dog-eared corner */}
          <path d="M40 48l6-6v6z" fill="#DDBB85" />
          {/* the tag with its number */}
          <rect x="11" y="18" width="21" height="11" rx="1.5" fill="#FFFFFF" stroke="#DDD5F2" strokeWidth="1" />
          <rect x="13.5" y="21" width="12" height="2" rx="1" fill="#5B3FA6" />
          <rect x="13.5" y="25" width="8" height="2" rx="1" fill="#DDD5F2" />
          {/* the string, tied in a bow */}
          <path d="M6 36h40" stroke="#F28C28" strokeWidth="2.4" />
          <path d="M26 30v18" stroke="#F28C28" strokeWidth="2.4" opacity=".85" />
          <path d="M26 36c-4-4-8-1-5 2 2 2 5 0 5-2zM26 36c4-4 8-1 5 2-2 2-5 0-5-2z" fill="#F28C28" />
          <circle cx="26" cy="36" r="1.8" fill="#D97A1E" />
        </g>

        {/* sent back: the cross, stamped across the cover */}
        {mark > 0.01 && (
          <g transform={`translate(26 34) rotate(-12) scale(${mark})`}>
            <circle r="13" fill="none" stroke="#A8711F" strokeWidth="3.2" />
            <circle r="9" fill="none" stroke="#A8711F" strokeWidth="1" strokeDasharray="2.4 2.4" />
            <path d="M-5 -5l10 10M5 -5l-10 10" stroke="#A8711F" strokeWidth="3.2" strokeLinecap="round" />
          </g>
        )}

        {/* his hands, one under the file, one holding the edge */}
        <ellipse cx="7" cy="44" rx="4" ry="5.2" fill="#F3EAD9" stroke="#E2D4BE" strokeWidth=".8" />
        <ellipse cx="45" cy="44" rx="4" ry="5.2" fill="#F3EAD9" stroke="#E2D4BE" strokeWidth=".8" />
      </g>
    </svg>
  )
}

// The answer sheet he holds up for anything about exams. Its bubbles fill
// in one by one while he talks, and it bobs a little in his hands.
function HeldSheet({ filled }) {
  const ANS = [1, 2, 0, 2, 1]
  return (
    <svg viewBox="0 0 44 56" className="h-full w-full" aria-hidden="true">
      <rect x="4" y="3" width="36" height="50" rx="3.5" fill="#FFFFFF" stroke="#DDD5F2" strokeWidth="1.4" />
      <rect x="4" y="3" width="36" height="9" rx="3.5" fill="#5B3FA6" />
      <rect x="4" y="8" width="36" height="4" fill="#5B3FA6" />
      <rect x="8" y="6" width="13" height="2.6" rx="1.3" fill="#9A86D6" />
      {ANS.map((a, r) => (
        <g key={r}>
          <rect x="8" y={17.2 + r * 7} width="5" height="2" rx="1" fill="#DDD5F2" />
          {[0, 1, 2].map((c) => (
            <circle key={c} cx={19 + c * 7} cy={18.2 + r * 7} r="2.5"
                    fill={c === a && r < filled ? '#5B3FA6' : '#FFFFFF'} stroke="#9A86D6" strokeWidth="1" />
          ))}
        </g>
      ))}
      {/* his thumbs over the edges */}
      <ellipse cx="4.5" cy="33" rx="3.6" ry="5" fill="#F3EAD9" stroke="#E2D4BE" strokeWidth=".8" />
      <ellipse cx="39.5" cy="33" rx="3.6" ry="5" fill="#F3EAD9" stroke="#E2D4BE" strokeWidth=".8" />
    </svg>
  )
}
const BEAT_MS = 2600

// Estimated bubble height, so he can be placed before he's drawn.
const bubbleH = (title, text) => 34 + (title ? 22 : 0) + Math.ceil(text.length / 29) * 20

function place(r, title, text) {
  const vw = window.innerWidth, vh = window.innerHeight
  // The subject as it looks zoomed (scale 1.045 about its centre).
  const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2
  const hw = (r.width * 1.045) / 2, hh = (r.height * 1.045) / 2
  const z = { left: cx - hw, right: cx + hw, top: cy - hh - 3, bottom: cy + hh - 3 }
  const H = bubbleH(title, text) + 12 + A
  const clampY = (y) => Math.max(EDGE, Math.min(vh - H - EDGE, y))
  const clampX = (x) => Math.max(EDGE, Math.min(vw - W - EDGE, x))

  if (vw - z.right - GAP >= W + EDGE) return { x: z.right + GAP, y: clampY(cy - H / 2), side: 'right' }
  if (vh - z.bottom - GAP >= H + EDGE) return { x: clampX(z.right - W), y: z.bottom + GAP, side: 'below' }
  if (z.top - GAP >= H + EDGE) return { x: clampX(z.right - W), y: z.top - GAP - H, side: 'above' }
  if (z.left - GAP >= W + EDGE) return { x: z.left - GAP - W, y: clampY(cy - H / 2), side: 'left' }
  // Nowhere clear: the bottom-right corner.
  return { x: vw - W - EDGE, y: vh - H - EDGE, side: 'corner' }
}

export default function FvGuide({ tour = false }) {
  const cur = useRef(null)
  const timers = useRef({})
  const wasActive = useRef(false)
  const [s, setS] = useState({ active: false, x: 0, y: 0, side: 'right', title: '', text: '', mood: 'point', prop: null })
  const [beat, setBeat] = useState(0)

  // Tour-mode state. `tourDone` is read from localStorage once at
  // mount so the tour never flashes for a returning user; the QA
  // reset hook fires in the initial-state function so it happens
  // before any effect can inspect the flag.
  const [tourDone, setTourDone] = useState(() => {
    try {
      if (typeof window === 'undefined') return true
      if (new URLSearchParams(window.location.search).get('guide_reset')) {
        localStorage.removeItem(TOUR_DONE_KEY)
        return false
      }
      return !!localStorage.getItem(TOUR_DONE_KEY)
    } catch { return false }
  })
  const [tourIdx, setTourIdx] = useState(-1)
  const tourTargets = useRef([])
  const runningTour = tour && !tourDone && tourIdx >= 0

  // Shared helpers, used by both the tour and the hover effect.
  const focusEl = (el) => {
    document.querySelectorAll('.fv-focused').forEach((n) => { if (n !== el) n.classList.remove('fv-focused') })
    el.classList.add('fv-focused')
    document.documentElement.classList.add('fv-focus')
  }
  const unfocusAll = () => {
    document.documentElement.classList.remove('fv-focus')
    document.querySelectorAll('.fv-focused').forEach((n) => n.classList.remove('fv-focused'))
  }
  const explainEl = (el) => {
    focusEl(el)
    const title = el.getAttribute('data-guide-title') || ''
    const text = el.getAttribute('data-guide') || ''
    const p = place(el.getBoundingClientRect(), title, text)
    const forced = new URLSearchParams(window.location.search).get('guide_mood')
    const mo = moodOf(el)
    const agent = /agent/i.test(title) || /agent/i.test(text) || !!el.closest('[data-guide-agent]')
    setS({ active: true, ...p, title, text, mood: forced || mo.mood, prop: mo.prop, agent })
    setBeat(0)
  }
  const hideGuide = () => setS((p) => ({ ...p, active: false }))
  const finishTour = () => {
    try { localStorage.setItem(TOUR_DONE_KEY, '1') } catch {}
    unfocusAll()
    hideGuide()
    tourTargets.current = []
    setTourIdx(-1)
    setTourDone(true)
  }

  // Collect tour steps once, after the shell has painted. Cap at 8
  // so the whole tour is done in roughly fifteen seconds. If nothing
  // is found we still mark the flag so we do not retry on every mount.
  useEffect(() => {
    if (!tour || tourDone) return undefined
    const t = setTimeout(() => {
      const found = [...document.querySelectorAll('[data-guide]')]
        .filter((el) => (el.getAttribute('data-guide') || '').trim().length > 0)
        .slice(0, 8)
      if (found.length === 0) { finishTour(); return }
      tourTargets.current = found
      setTourIdx(0)
    }, 700)
    return () => clearTimeout(t)
  }, [tour, tourDone])

  // Auto-advance through the tour. Targets are scrolled into view
  // first so items below the fold on a short viewport are shown.
  useEffect(() => {
    if (!runningTour) return undefined
    const el = tourTargets.current[tourIdx]
    if (!el || !el.isConnected) { finishTour(); return undefined }
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }) } catch {}
    const showT = setTimeout(() => explainEl(el), 220)
    const nextT = setTimeout(() => {
      if (tourIdx + 1 >= tourTargets.current.length) finishTour()
      else setTourIdx((i) => i + 1)
    }, TOUR_STEP_MS)
    return () => { clearTimeout(showT); clearTimeout(nextT) }
  }, [runningTour, tourIdx])

  useEffect(() => {
    // Tour roles don't attach any hover listeners. Once the tour is
    // finished the guide is fully dormant, so the page never blurs.
    if (tour) return undefined
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const demoMode = new URLSearchParams(window.location.search).get('guide_demo')
    if (demoMode) document.documentElement.classList.add('fv-demo')
    const clear = () => { Object.values(timers.current).forEach(clearTimeout) }
    const focus = (el) => {
      document.querySelectorAll('.fv-focused').forEach((n) => { if (n !== el) n.classList.remove('fv-focused') })
      el.classList.add('fv-focused')
      document.documentElement.classList.add('fv-focus')
    }
    const unfocus = () => {
      document.documentElement.classList.remove('fv-focus')
      document.querySelectorAll('.fv-focused').forEach((n) => n.classList.remove('fv-focused'))
    }
    const explain = (el) => {
      focus(el)
      const title = el.getAttribute('data-guide-title') || ''
      const text = el.getAttribute('data-guide') || ''
      const p = place(el.getBoundingClientRect(), title, text)
      const forced = new URLSearchParams(window.location.search).get('guide_mood')
      const mo = moodOf(el)
      // agent things get him in the agent's casual shirt; everything else, formal
      const agent = /agent/i.test(title) || /agent/i.test(text) || !!el.closest('[data-guide-agent]')
      setS({ active: true, ...p, title, text, mood: forced || mo.mood, prop: mo.prop, agent })
      setBeat(0)
    }
    const hide = () => setS((p) => ({ ...p, active: false }))
    // Off a subject, he's gone at once — no delay, no exit animation.
    const away = () => { cur.current = null; clear(); unfocus(); hide() }
    const over = (e) => {
      const el = e.target.closest?.('[data-guide]') || null
      if (el && el === cur.current) return
      if (!el) { if (cur.current) away(); return }
      cur.current = el
      clear()
      timers.current.focus = setTimeout(() => focus(el), reduce ? 0 : FOCUS_DELAY)
      timers.current.in = setTimeout(() => explain(el), reduce ? 0 : HOVER_DELAY)
    }
    // The pointer leaving the window, or the window losing focus.
    const out = (e) => { if (!e.relatedTarget) away() }

    if (demoMode) {
      timers.current.demo = setTimeout(() => {
        const el = [...document.querySelectorAll('[data-guide]')].find((n) => n.getAttribute('data-guide-title') === demoMode)
        if (el) explain(el)
      }, 1200)
    } else {
      document.addEventListener('pointerover', over)
      document.addEventListener('mouseout', out)
      window.addEventListener('blur', away)
      window.addEventListener('scroll', away, { passive: true })
      window.addEventListener('resize', away)
    }
    return () => {
      clear(); unfocus()
      document.removeEventListener('pointerover', over)
      document.removeEventListener('mouseout', out)
      window.removeEventListener('blur', away)
      window.removeEventListener('scroll', away)
      window.removeEventListener('resize', away)
    }
  }, [tour])

  // While he's shown, alternate between the subject's mood and its second beat.
  useEffect(() => {
    if (!s.active) return undefined
    const id = setInterval(() => setBeat((b) => b + 1), BEAT_MS)
    return () => clearInterval(id)
  }, [s.active, s.title])
  const [writeP, setWriteP] = useState(0)
  useEffect(() => {
    if (!s.active || !['write', 'stamp', 'scan', 'file', 'no'].includes(s.prop)) return undefined
    const start = performance.now()
    const period = s.prop === 'stamp' ? 1900 : s.prop === 'scan' ? 2400 : s.prop === 'file' ? 4200 : s.prop === 'no' ? 2600 : 6500
    const id = setInterval(() => setWriteP(((performance.now() - start) / period) % 1), 40)
    return () => clearInterval(id)
  }, [s.active, s.prop, s.title])
  const writeCaret = (writeP * W_LINES) % 1
  const mood = s.prop === 'write'
    ? { type: 'typing', caret: writeCaret, count: 3 + Math.floor(writeP * 20) }
    : s.prop === 'stamp'
    ? { type: 'typing', caret: 0.72, count: writeP >= 0.4 ? 9 : 4 }
    : s.prop === 'scan'
    ? { type: 'typing', caret: 0.62, count: writeP >= 0.45 ? 9 : 4 }
    : s.prop === 'file'
    ? { type: 'typing', caret: Math.min(1, Math.max(0, (writeP - 0.15) / 0.6)), count: 6 }
    : s.prop === 'no'
    ? { type: 'typing', caret: 0.5, count: 5 }
    : { type: s.prop ? s.mood : (beat % 2 === 1 && NEXT[s.mood] ? NEXT[s.mood] : s.mood) }
  // the sheet fills a bubble every ~0.9 s while he holds it
  const [fillTick, setFillTick] = useState(0)
  useEffect(() => {
    if (!s.active || !s.prop) return undefined
    setFillTick(0)
    const id = setInterval(() => setFillTick((n) => (n + 1) % 8), 900)
    return () => clearInterval(id)
  }, [s.active, s.prop, s.title])

  // Glide between subjects while shown; appear in place (no fly-in) when first shown.
  const glide = wasActive.current && s.active
  useEffect(() => { wasActive.current = s.active }, [s.active])
  const tailLeft = s.side === 'left' ? '67%' : s.side === 'right' ? '33%' : '61%'

  return (
    <>
    {runningTour && (
      <button
        type="button"
        onClick={finishTour}
        className="fixed bottom-6 right-6 z-[60] rounded-full border border-fv-line bg-white/95 px-5 py-2.5 text-[13.5px] font-bold text-fv-ink shadow-[0_8px_24px_rgba(23,20,44,.18)] backdrop-blur transition hover:bg-white"
      >
        Skip tour
        <span className="fv-hi ml-2 text-[12px] font-bold text-fv-faint">छोड़ें</span>
      </button>
    )}
    <div
      aria-hidden="true"
      className="fv-guide-pop pointer-events-none fixed z-50"
      style={{
        left: s.x, top: s.y, width: W,
        transition: glide ? 'left 380ms cubic-bezier(.22,.9,.28,1), top 380ms cubic-bezier(.22,.9,.28,1)' : 'none',
        visibility: s.active ? 'visible' : 'hidden',
      }}
    >
      {/* The bubble. */}
      <div
        className="relative rounded-[14px] border border-fv-line bg-fv-card px-4 py-3"
        style={{
          transformOrigin: 'bottom center',
          transform: s.active ? 'none' : 'translateY(6px) scale(0.94)',
          opacity: s.active ? 1 : 0,
          transition: s.active ? 'transform 300ms cubic-bezier(.25,1.35,.4,1) 120ms, opacity 180ms ease 120ms' : 'none',
        }}
      >
        {s.title && <p className="fv-display text-[15px] font-bold leading-tight text-fv-ink">{s.title}</p>}
        <p className={`text-[14px] leading-snug text-fv-muted ${s.title ? 'mt-1' : ''}`}>{s.text}</p>
        <span className="absolute -bottom-[7px] h-3 w-3 -translate-x-1/2 rotate-45 border-b border-r border-fv-line bg-fv-card" style={{ left: tailLeft }} />
      </div>
      {/* Him — popping up out of a slot under the bubble. */}
      <div className="relative mt-3 overflow-hidden" style={{ height: A, marginLeft: s.side === 'left' ? W - A - 8 : s.side === 'right' ? 8 : W - A - 24, width: A }}>
        <div style={{
          width: A, height: A,
          transform: s.active ? 'none' : `translateY(${A}px)`,
          transition: s.active ? 'transform 420ms cubic-bezier(.3,1.4,.45,1)' : 'none',
        }}>
          <Verifier outfit={s.agent ? 'casual' : 'formal'} mood={s.active ? mood : { type: 'idle' }} className="h-full w-full" />
          {s.active && s.prop === 'write' && (
            <div className="absolute" style={{ left: '33%', top: '58%', width: '34%', height: '42%', transform: 'rotate(-4deg)' }}>
              <HeldPaper p={writeP} />
            </div>
          )}
          {s.active && s.prop === 'no' && (
            <div className="absolute" style={{ left: '24%', top: '62%', width: '50%', height: '44%' }}>
              <HeldFile k={writeP} returned />
            </div>
          )}
          {s.active && s.prop === 'file' && (
            <div className="absolute" style={{ left: '28%', top: '55%', width: '44%', height: '46%' }}>
              <HeldFile k={writeP} />
            </div>
          )}
          {s.active && s.prop === 'scan' && (
            <div className="absolute" style={{ left: '-4%', top: '54%', width: '108%', height: '50%' }}>
              <DeskScan k={writeP} />
            </div>
          )}
          {s.active && s.prop === 'stamp' && (
            <div className="absolute" style={{ left: '-4%', top: '54%', width: '108%', height: '50%' }}>
              <DeskStamp k={writeP} />
            </div>
          )}
          {s.active && s.prop === 'omr' && (
            <div className="fv-hold absolute" style={{ left: '34%', top: '59%', width: '32%', height: '41%' }}>
              <HeldSheet filled={Math.min(5, fillTick)} />
            </div>
          )}
        </div>
      </div>
    </div>
    </>
  )
}
