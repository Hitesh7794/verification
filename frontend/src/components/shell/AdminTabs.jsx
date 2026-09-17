import { NavLink, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { useAuth } from '../../lib/auth.jsx'
import WalletWidget from '../wallet/WalletWidget.jsx'
import AvatarMenu from './AvatarMenu.jsx'
import { BrandMark } from '../ui/brand.jsx'
import ReportProblem from '../support/ReportProblem.jsx'
import SignOutConfirm from './SignOutConfirm.jsx'

// AdminTabs — the sticky top bar for every /admin/* surface.
//
// Structure (left → right):
//   Brand mark (Verification Portal / ADMIN)
//   Tab strip (Overview · Exam catalog · My exams · Operators · History · Downloads)
//   Wallet widget (org balance, top-up)
//   Support chip (Report a problem)
//   Avatar menu (display_name, role, username, sign out)
//
// Same visual language as SuperTabs: navy chrome under a gold authority
// rule, tabs animate their pill via framer layoutId. The gold accent on
// the "ADMIN" wordmark is the only chroma in the bar — everything else
// is ink and light, so the tab row stays the thing you read first.

// V15 flow — access is minted automatically at KYC-approval time (no
// admin-driven subscribe). Both 'Exam catalog' and 'My exams' are
// read-only views; the admin can't create or cancel subscriptions from
// either. Kept as tabs for browsing UX so the admin has a sense of
// what the platform offers and what their org already has access to.
const tabs = [
  { to: '/admin',           label: 'Overview',      end: true  },
  { to: '/admin/catalog',   label: 'Exam catalog',  end: false },
  { to: '/admin/my-exams',  label: 'My exams',      end: false },
  { to: '/admin/operators', label: 'Agents',        end: false },
  { to: '/admin/history',   label: 'History',       end: false },
  { to: '/admin/products',  label: 'Products',      end: false },
  { to: '/admin/downloads', label: 'Downloads',     end: false },
]

export default function AdminTabs({ walletRefreshKey, onWalletBalanceChange }) {
  const { user, logout } = useAuth()
  const nav = useNavigate()
  const [now, setNow] = useState(() => new Date())
  const [confirmingSignOut, setConfirmingSignOut] = useState(false)

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(id)
  }, [])

  // Clicking "Sign out" in the avatar dropdown opens the confirmation
  // dialog instead of signing out immediately. AvatarMenu closes itself
  // via its own onLogout handler before this fires, so opening the
  // dialog here leaves no dropdown ghosting behind it.
  function requestSignOut() {
    setConfirmingSignOut(true)
  }

  function handleLogout() {
    const role = user?.role
    logout()
    nav(`/${role || ''}/login`)
  }

  const timeText = now.toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }) + ' IST'

  return (
    <header className="sticky top-0 z-40 bg-ink-chrome overflow-x-clip">
      {/* Layout wraps to two rows below the sm breakpoint so a phone
          viewport doesn't push the tab strip off the right edge:
            Row 1 — Brand + right cluster (wallet + report + avatar)
            Row 2 — Tabs, full width, horizontally scrollable
          At sm+ everything usually fits on one 64px row; if the
          viewport is right at the borderline width where brand +
          tabs + right cluster sum a hair too wide, flex-wrap lets
          the row grow taller rather than horizontally overflowing
          the page (min-h-16 instead of a fixed h-16). */}
      <div className="px-3 sm:px-4 lg:px-6 flex flex-wrap items-center gap-x-3 gap-y-2 sm:gap-4 xl:gap-8 py-2 sm:py-0 sm:min-h-16">
        {/* Brand */}
        <div className="flex items-center gap-2 sm:gap-2.5 shrink-0 min-w-0">
          <BrandMark size={26} tone="inverse" />
          <div className="flex flex-col leading-tight min-w-0">
            <span className="font-display text-[13px] sm:text-[14px] font-extrabold text-white tracking-[-0.02em] truncate">Verification Portal</span>
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-300/90">Admin</span>
          </div>
        </div>

        {/* Right cluster: live clock + wallet + avatar. On mobile this
            sits next to the brand on row 1 (tabs wrap to row 2). The
            ml-auto pushes it to the right edge on that row. */}
        <div className="flex items-center gap-2 xl:gap-3 shrink-0 ml-auto order-2 sm:order-3">
          <span className="hidden xl:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/8 ring-1 ring-inset ring-white/15 text-[11px] font-mono text-slate-200 tabular-nums">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            {timeText}
          </span>
          {user?.role === 'admin' && (
            <WalletWidget
              refreshKey={walletRefreshKey || 0}
              onBalanceChange={onWalletBalanceChange}
              compact
            />
          )}
          <ReportProblem />
          <AvatarMenu user={user} onLogout={requestSignOut} />
        </div>

        {/* Primary tabs — full-width row on mobile (basis-full pushes
            it below the brand row via flex-wrap), flex-1 on sm+ so it
            sits between brand and right cluster on a single line. */}
        <nav className="relative min-w-0 basis-full order-3 sm:order-2 sm:basis-0 sm:flex-1">
          <ul className="flex gap-1 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
            {tabs.map((t) => (
              <li key={t.to} className="shrink-0">
                <NavLink to={t.to} end={t.end}>
                  {({ isActive }) => (
                    <div className="relative inline-flex items-center px-2.5 xl:px-3.5 py-1.5 text-[13px] font-semibold rounded-lg transition-colors">
                      {isActive && (
                        <motion.span
                          layoutId="admin-nav-indicator"
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
          {/* Right-edge fade — tells the eye "there's more to scroll to"
              on narrow viewports. pointer-events-none so it doesn't
              block tab clicks. */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute right-0 top-0 bottom-0 w-6 bg-gradient-to-l from-ink-chrome to-transparent"
          />
        </nav>
      </div>
      {/* Gold authority rule */}
      <div className="h-[2px] rule-gold" />

      <SignOutConfirm
        open={confirmingSignOut}
        onCancel={() => setConfirmingSignOut(false)}
        onConfirm={() => { setConfirmingSignOut(false); handleLogout() }}
      />
    </header>
  )
}
