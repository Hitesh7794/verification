import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import FvSideShell, { FvPageHead } from '../fv/FvSideShell.jsx'
import ReviewScene from '../fv/ReviewScene.jsx'
import { IconFile, IconBook, IconPeople, IconClock, IconGrid } from '../fv/FvAdminShell.jsx'
import { useAuth } from '../../lib/auth.jsx'
import { reviewerMe } from '../../lib/reviewer/api.js'
import { getStoredToken } from '../../lib/authStorage.js'
import ntaLogo from '../../assets/nta-logo.png'
import emblemSvg from '../../assets/emblem.svg'
import ReportProblem from '../support/ReportProblem.jsx'

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
  { to: '/reviewer', label: 'KYC applications', end: true, icon: IconFile, guide: 'Institutions asking to verify candidates for your exams. Check their papers and decide.' },
  // V16 (2026-09-10) exam-approval surface: dedicated tab for the
  // subscription-request queue. Same data the inline panel on the
  // KYC application detail shows, but grouped by institute so a
  // reviewer with 40 institutes doesn't have to open every KYC row
  // to notice one has a pending request.
  { to: '/reviewer/exam-approval', label: 'Exam approval', end: false, icon: IconGrid, guide: 'Institutions asking to take on one of your exams, grouped by institution.' },
  // V30 (2026-09-14): auto-disable enforcement surface. Shows every
  // agent under the reviewer's client scope, floats auto-disabled
  // agents to the top, and gives the reviewer the button to lift a
  // lockout.
  { to: '/reviewer/agents', label: 'Agents', end: false, icon: IconPeople, guide: 'Every agent verifying for your exams. Locked-out agents float to the top.' },
  { to: '/reviewer/exams', label: 'Exams', end: false, icon: IconBook, guide: 'Your exams, their windows and their candidates.' },
  { to: '/reviewer/history', label: 'Verification history', end: false, icon: IconClock, guide: 'Every candidate checked for your exams, with the report for each.' },
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

  function onLogout() {
    meCache = { key: '', data: null }
    logout()
    nav('/reviewer/login', { replace: true })
  }

  const boardName = me?.name || '…'
  // Null until /me lands, so the monogram never flashes under a board
  // that has its own mark.
  const mark = me?.name ? BOARD_MARKS.find((b) => b.test.test(me.name)) : null

  return (
    <FvSideShell
      bold
      guideTour
      backdrop="hall"
      scene={<ReviewScene className="fixed bottom-[20px] right-[1%] z-0 h-[min(60vh,540px)] aspect-[440/300] opacity-[0.15]" />}
      subtitle={mark ? 'Review portal' : `${boardName}, review portal`}
      brandArt={mark ? (
        // The official artwork exactly as supplied, on its own white plate.
        <span className="inline-flex items-center gap-3 rounded-[12px] border border-fv-line bg-white px-3 py-2">
          <img src={emblemSvg} alt="State Emblem of India" className="h-10 w-auto object-contain shrink-0" />
          <span aria-hidden="true" className="h-8 w-px bg-fv-line shrink-0" />
          <img src={mark.src} alt={mark.alt} className="h-8 w-auto object-contain shrink-0" />
        </span>
      ) : null}
      nav={tabs}
      extra={<div className="mb-1 px-2"><ReportProblem /></div>}
      user={{ name: user?.name || user?.username || 'Reviewer', role: me?.name ? `Reviewer, ${me.name}` : 'Reviewer' }}
      onSignOut={onLogout}
    >
      {children}
    </FvSideShell>
  )
}

export function ReviewerPageHead({ eyebrow, title, subtitle, right, art }) {
  return <FvPageHead eyebrow={eyebrow} title={title} subtitle={subtitle} right={right} art={art} />
}
