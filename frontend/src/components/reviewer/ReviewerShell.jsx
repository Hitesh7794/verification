import { useEffect, useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useAuth } from '../../lib/auth.jsx'
import { reviewerMe } from '../../lib/reviewer/api.js'
import { getStoredToken } from '../../lib/authStorage.js'
import ntaLogo from '../../assets/nta-logo.png'
import emblemSvg from '../../assets/emblem.svg'
import ReportProblem from '../support/ReportProblem.jsx'
import SignOutConfirm from '../shell/SignOutConfirm.jsx'

// Board lockups for the navy chrome. The official artwork is used exactly
// as supplied — no recolouring — on a white card, which is how brand
// guides for government marks generally require them to appear on a dark
// ground. One entry per board we hold artwork for; every other board
// keeps its monogram. Matching on the name the Data Plane already
// returns keeps this frontend-only — no new field, no migration.
//
// The word boundaries around "nta" matter: without them any board whose
// name merely contains those three letters would pick up NTA's logo.
const BOARD_MARKS = [
  {
    test: /national testing agency|\bnta\b/i,
    src: ntaLogo,
    alt: 'National Testing Agency — Excellence in Assessment',
  },
]

const tabs = [
  { to: '/reviewer', label: 'KYC Applications', end: true },
  // V16 (2026-09-10) exam-approval surface: dedicated tab for the
  // subscription-request queue. Same data the inline panel on the
  // KYC application detail shows, but grouped by institute so a
  // reviewer with 40 institutes doesn't have to open every KYC row
  // to notice one has a pending request.
  { to: '/reviewer/exam-approval', label: 'Exam approval', end: false },
  // V30 (2026-09-14): auto-disable enforcement surface. Shows every
  // agent under the reviewer's client scope, floats auto-disabled
  // agents to the top, and gives the reviewer the button to lift a
  // lockout.
  { to: '/reviewer/agents', label: 'Agents', end: false },
  { to: '/reviewer/exams', label: 'Exams', end: false },
  { to: '/reviewer/history', label: 'Verification history', end: false },
]

// ReviewerShell — page shell for the client-reviewer portal.
//
// Mirrors the warm-palette treatment SuperShell uses so the app feels
// like one product across roles. Two visible differences from
// SuperShell:
//   - Header shows the CLIENT NAME (e.g. "NTA · Review portal") — the
//     reviewer's whole world is one client, so it anchors the page.
//   - No tab strip: there's a single page (inbox), so tabs would be
//     noise. Adding a second surface later (e.g. audit log) is where
//     tabs come in.

// How often we re-poll /api/client/me while a reviewer is signed in.
// 15s is a good balance: fast enough that a superadmin flipping the
// toggle boots the session within one screen-refresh window, slow
// enough that a dozen reviewer tabs don't hammer the endpoint.
const PORTAL_GATE_INTERVAL_MS = 15_000

// ── /me cache ───────────────────────────────────────────────────────
// Every reviewer page renders its own <ReviewerShell>, so React unmounts
// the header and mounts a fresh one on each tab switch. With `me` starting
// at null, the masthead fell back to its placeholder — the board lockup
// vanished and the name read '…' — until /me came back. That reads as the
// whole bar reloading on every click.
//
// Keyed on the session token rather than held bare: logout() clears the
// stored session but cannot clear a module variable, so an unkeyed cache
// would show one board's identity to the next reviewer who signs in on
// the same tab. A new login mints a new token, which misses.
let meCache = { key: '', data: null }
const sessionKey = () => getStoredToken('reviewer')

export default function ReviewerShell({ children, meOverride }) {
  return (
    <div className="min-h-full bg-warm-page">
      <ReviewerHeader meOverride={meOverride} />
      <motion.main
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        className="px-6 lg:px-8 py-8"
      >
        {children}
      </motion.main>
    </div>
  )
}

function ReviewerHeader({ meOverride }) {
  const nav = useNavigate()
  const { user, logout } = useAuth()
  // Seed from the cache when the token matches, so a tab switch paints
  // the finished masthead on its first render. The poll below still runs
  // and still boots a revoked session; this only removes the blank frame.
  const cacheKey = sessionKey()
  const [me, setMe] = useState(() => {
    if (meOverride) return meOverride
    return cacheKey !== '' && meCache.key === cacheKey ? meCache.data : null
  })
  const [now, setNow] = useState(() => new Date())
  const [confirmingSignOut, setConfirmingSignOut] = useState(false)

  // Poll /me periodically so the moment the superadmin turns the
  // portal off — or the session is otherwise revoked (JWT expiry,
  // reviewer account deleted) — the tab boots itself to the login
  // page. Without this the reviewer would silently be able to browse
  // read-only state until their JWT expires (up to 12h). The initial
  // fire runs on mount and doubles as the "get the client name for
  // the header" call, replacing the old one-shot fetch.
  useEffect(() => {
    if (meOverride) { setMe(meOverride) }

    let alive = true
    const kick = (reason) => {
      if (!alive) return
      logout()
      nav(`/reviewer/login?${reason}=1`, { replace: true })
    }
    const check = () => {
      reviewerMe()
        .then((r) => {
          if (!alive) return
          if (r && r.portal_enabled === false) {
            meCache = { key: '', data: null }
            kick('portal_disabled')
            return
          }
          meCache = { key: sessionKey(), data: r }
          setMe(r)
        })
        .catch((e) => {
          if (!alive) return
          // 403/401 → session no longer valid (portal off, account
          // deleted, or JWT rejected). Boot to login with the right
          // reason so the banner reads correctly.
          if (e && (e.status === 403 || e.status === 401)) {
            meCache = { key: '', data: null }
            const msg = String(e.message || '').toLowerCase()
            kick(msg.includes('portal') ? 'portal_disabled' : 'session_expired')
          }
          // Network blips and 5xx just leave the last-known me in
          // place — no reason to boot the user for a transient error.
        })
    }
    check()
    const id = setInterval(check, PORTAL_GATE_INTERVAL_MS)
    return () => { alive = false; clearInterval(id) }
    // meOverride is intentionally not in deps — we own the polling
    // once mounted regardless of what the parent originally handed us.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(id)
  }, [])

  function onLogout() {
    meCache = { key: '', data: null }
    logout()
    nav('/reviewer/login', { replace: true })
  }

  const timeText = now.toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }) + ' IST'

  const boardName = me?.name || '…'
  const initial = boardName.trim().charAt(0).toUpperCase() || '?'
  // Null until /me lands, so the monogram never flashes under a board
  // that has its own mark.
  const mark = me?.name ? BOARD_MARKS.find((b) => b.test.test(me.name)) : null

  return (
    <header className="sticky top-0 z-40 bg-ink-chrome">
      <div className="pl-3 pr-6 lg:pr-8 flex items-center gap-5 h-20">
        {/* Board mark. Sits hard against the left margin — this is the
            identity anchor, and a centred column left it adrift. */}
        <div className="flex items-center gap-3.5 min-w-0 shrink-0">
          {mark ? (
            // One white card holding the state emblem and the board's
            // lockup, both in their original colours. A generous curve on
            // the top-left and bottom-right and a tight one on the other
            // two, so it reads as a shaped plate rather than a rounded box
            // dropped onto the bar.
            <span className="inline-flex items-center gap-3.5 shrink-0 bg-white px-4 py-2
                             rounded-[18px_4px_18px_4px] ring-1 ring-inset ring-black/5
                             shadow-[0_6px_18px_rgba(2,10,20,0.35)]">
              <img
                src={emblemSvg}
                alt="State Emblem of India"
                className="hidden xl:block h-11 w-auto object-contain shrink-0"
              />
              <span aria-hidden="true" className="hidden xl:block h-9 w-px bg-slate-200 shrink-0" />
              <img src={mark.src} alt={mark.alt} className="h-9 lg:h-10 w-auto object-contain shrink-0" />
            </span>
          ) : (
            <span
              aria-hidden="true"
              className="h-9 w-9 rounded-lg bg-white/12 ring-1 ring-inset ring-white/25 text-white font-display text-[14px] font-bold flex items-center justify-center shrink-0"
            >
              {initial}
            </span>
          )}
          {/* With a lockup the board's name is already set in the
              artwork, so nothing is repeated in type here. */}
          {mark ? null : (
            <div className="flex flex-col leading-tight min-w-0">
              <span className="font-display text-[14px] font-extrabold text-white tracking-[-0.02em] truncate">
                {boardName}
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-300/90">
                Review portal
              </span>
            </div>
          )}
        </div>

        {/* Tab navigation: KYC Applications & Exams */}
        <nav className="flex-1 min-w-0 ml-2">
          <ul className="flex gap-1 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
            {tabs.map((t) => (
              <li key={t.to} className="shrink-0">
                <NavLink to={t.to} end={t.end}>
                  {({ isActive }) => (
                    <div className="relative inline-flex items-center whitespace-nowrap px-3.5 py-1.5 text-[13px] font-semibold rounded-lg transition-colors">
                      {isActive && (
                        <motion.span
                          layoutId="reviewer-nav-indicator"
                          className="absolute inset-0 rounded-lg bg-white/12 ring-1 ring-inset ring-white/20"
                          transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                        />
                      )}
                      <span className={`relative z-10 transition-colors ${isActive
                        ? 'text-white'
                        : 'text-slate-300 hover:text-white'}`}>
                        {t.label}
                      </span>
                    </div>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        {/* Right cluster: time + support + logout */}
        <div className="flex items-center gap-3 shrink-0">
          <span className="hidden md:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/8 ring-1 ring-inset ring-white/15 text-[11px] font-mono text-slate-200 tabular-nums">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            {timeText}
          </span>
          <ReportProblem />
          <button
            onClick={() => setConfirmingSignOut(true)}
            className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-slate-200 hover:text-white bg-white/8 hover:bg-white/16 ring-1 ring-inset ring-white/15 px-3 py-1.5 rounded-lg transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300"
            title="Sign out"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            Sign out
          </button>
        </div>
      </div>
      {/* Gold authority rule */}
      <div className="h-[2px] rule-gold" />

      <SignOutConfirm
        open={confirmingSignOut}
        onCancel={() => setConfirmingSignOut(false)}
        onConfirm={() => { setConfirmingSignOut(false); onLogout() }}
      />
    </header>
  )
}

export function ReviewerPageHead({ eyebrow, title, subtitle, right }) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && (
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-600 mb-1.5">
            {eyebrow}
          </p>
        )}
        <h1 className="font-display text-[26px] font-extrabold text-slate-900 tracking-[-0.025em]">{title}</h1>
        {subtitle && (
          <p className="text-sm text-slate-500 mt-1.5 max-w-2xl">{subtitle}</p>
        )}
      </div>
      {right && <div className="flex items-center gap-2 shrink-0">{right}</div>}
    </div>
  )
}
