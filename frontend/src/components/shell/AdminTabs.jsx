import { NavLink, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { useAuth } from '../../lib/auth.jsx'
import WalletWidget from '../wallet/WalletWidget.jsx'
import AvatarMenu from './AvatarMenu.jsx'
import { BrandMark } from '../ui/brand.jsx'

// AdminTabs — the sticky top bar for every /admin/* surface.
//
// Structure (left → right):
//   Brand mark (Verification Portal / ADMIN)
//   Tab strip (Overview · Exam catalog · My exams · Operators · History · Downloads)
//   Wallet widget (org balance, top-up)
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

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(id)
  }, [])

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
    <header className="sticky top-0 z-40 bg-ink-chrome">
      <div className="mx-auto max-w-7xl px-6 flex items-center gap-8 h-16">
        {/* Brand */}
        <div className="flex items-center gap-2.5 shrink-0">
          <BrandMark size={26} tone="inverse" />
          <div className="flex flex-col leading-tight">
            <span className="font-display text-[14px] font-extrabold text-white tracking-[-0.02em]">Verification Portal</span>
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-300/90">Admin</span>
          </div>
        </div>

        {/* Primary tabs */}
        <nav className="flex-1 min-w-0">
          {/* overflow-x-auto keeps the tabs scrollable when the viewport
              is narrower than the row, but the scrollbar itself is
              hidden so users on macOS "always show scrollbars" don't
              see a stray track between the tabs and the wallet widget.
              The arbitrary selectors cover both WebKit and Firefox. */}
          <ul className="flex gap-1 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
            {tabs.map((t) => (
              <li key={t.to} className="shrink-0">
                <NavLink to={t.to} end={t.end}>
                  {({ isActive }) => (
                    <div className="relative inline-flex items-center px-3.5 py-1.5 text-[13px] font-semibold rounded-lg transition-colors">
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
        </nav>

        {/* Right cluster: live clock + wallet + avatar */}
        <div className="flex items-center gap-3 shrink-0">
          <span className="hidden lg:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/8 ring-1 ring-inset ring-white/15 text-[11px] font-mono text-slate-200 tabular-nums">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            {timeText}
          </span>
          {user?.role === 'admin' && (
            <WalletWidget
              refreshKey={walletRefreshKey || 0}
              onBalanceChange={onWalletBalanceChange}
            />
          )}
          <AvatarMenu user={user} onLogout={handleLogout} />
        </div>
      </div>
      {/* Gold authority rule */}
      <div className="h-[2px] rule-gold" />
    </header>
  )
}
