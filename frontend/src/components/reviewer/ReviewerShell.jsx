import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useAuth } from '../../lib/auth.jsx'
import { reviewerMe } from '../../lib/reviewer/api.js'

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

export default function ReviewerShell({ children, meOverride }) {
  return (
    <div className="min-h-full bg-warm-page">
      <ReviewerHeader meOverride={meOverride} />
      <motion.main
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        className="mx-auto max-w-6xl px-6 py-8"
      >
        {children}
      </motion.main>
    </div>
  )
}

function ReviewerHeader({ meOverride }) {
  const nav = useNavigate()
  const { user, logout } = useAuth()
  const [me, setMe] = useState(meOverride || null)
  const [now, setNow] = useState(() => new Date())

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
            kick('portal_disabled')
            return
          }
          setMe(r)
        })
        .catch((e) => {
          if (!alive) return
          // 403/401 → session no longer valid (portal off, account
          // deleted, or JWT rejected). Boot to login with the right
          // reason so the banner reads correctly.
          if (e && (e.status === 403 || e.status === 401)) {
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
    logout()
    nav('/reviewer/login', { replace: true })
  }

  const timeText = now.toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }) + ' IST'

  const boardName = me?.name || '…'
  const initial = boardName.trim().charAt(0).toUpperCase() || '?'

  return (
    <header className="sticky top-0 z-40 border-b border-warm bg-warm-surface/95 backdrop-blur supports-[backdrop-filter]:bg-warm-surface/85">
      <div className="mx-auto max-w-6xl px-6 flex items-center gap-4 h-14">
        {/* Board mark: monogram + name. Wide breathing room so it feels
            like an identity anchor, not a page title. */}
        <div className="flex items-center gap-3 min-w-0">
          <span
            aria-hidden="true"
            className="h-8 w-8 rounded-lg bg-stone-900 text-white text-[13px] font-semibold flex items-center justify-center shrink-0"
          >
            {initial}
          </span>
          <div className="flex flex-col leading-tight min-w-0">
            <span className="text-[13px] font-semibold text-stone-900 tracking-tight truncate">
              {boardName}
            </span>
            <span className="text-[10px] uppercase tracking-widest text-warm-accent">
              Review portal
            </span>
          </div>
        </div>

        {/* Reviewer's only surface is the KYC inbox (2026-08-25 cleanup),
            so no tab strip is rendered — the identity anchor on the
            left is enough. Add tabs here when a second surface arrives. */}

        <div className="flex-1" />

        {/* Right cluster: username + time + logout */}
        <div className="flex items-center gap-3 shrink-0">
          {user?.display_name && (
            <span className="hidden md:inline text-[12px] text-stone-600 truncate max-w-[180px]">
              {user.display_name}
            </span>
          )}
          <span className="hidden md:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#F5EEDF] border border-warm text-[11px] font-mono text-stone-700">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
            {timeText}
          </span>
          <button
            onClick={onLogout}
            className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-stone-800 hover:text-white bg-white hover:bg-stone-900 border border-warm-strong hover:border-stone-900 px-3 py-1.5 rounded-md shadow-sm transition-colors"
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
    </header>
  )
}

export function ReviewerPageHead({ eyebrow, title, subtitle, right }) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && (
          <p className="text-[11px] font-semibold uppercase tracking-widest text-warm-accent mb-1.5">
            {eyebrow}
          </p>
        )}
        <h1 className="text-2xl font-semibold text-ink-900 tracking-tight">{title}</h1>
        {subtitle && (
          <p className="text-sm text-stone-500 mt-1 max-w-2xl">{subtitle}</p>
        )}
      </div>
      {right && <div className="flex items-center gap-2 shrink-0">{right}</div>}
    </div>
  )
}
