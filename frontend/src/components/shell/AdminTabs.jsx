import { NavLink, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { useAuth } from '../../lib/auth.jsx'
import WalletWidget from '../wallet/WalletWidget.jsx'
import AvatarMenu from './AvatarMenu.jsx'

// AdminTabs — the sticky top bar for every /admin/* surface.
//
// Structure (left → right):
//   Brand mark (Verification Portal / ADMIN)
//   Tab strip (Overview · Exam catalog · My exams · Operators · History · Downloads)
//   Wallet widget (org balance, top-up)
//   Avatar menu (display_name, role, username, sign out)
//
// Same visual language as SuperTabs: warm ivory background, hairline
// bottom border, tabs animate their pill via framer layoutId, hover
// state is a cream wash. Amber accent on the "ADMIN" wordmark keeps
// the two-tone story with the ink-black primary actions.

const tabs = [
  { to: '/admin',           label: 'Overview',     end: true  },
  { to: '/admin/catalog',   label: 'Exam catalog', end: false },
  { to: '/admin/my-exams',  label: 'My exams',     end: false },
  { to: '/admin/operators', label: 'Operators',    end: false },
  { to: '/admin/history',   label: 'History',      end: false },
  { to: '/admin/products',  label: 'Products',     end: false },
  { to: '/admin/downloads', label: 'Downloads',    end: false },
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
    <header className="sticky top-0 z-40 border-b border-warm bg-warm-surface/95 backdrop-blur supports-[backdrop-filter]:bg-warm-surface/85">
      <div className="mx-auto max-w-7xl px-6 flex items-center gap-8 h-14">
        {/* Brand */}
        <div className="flex flex-col leading-tight shrink-0">
          <span className="text-[13px] font-semibold text-stone-900 tracking-tight">Verification Portal</span>
          <span className="text-[10px] uppercase tracking-widest text-warm-accent">Admin</span>
        </div>

        {/* Primary tabs */}
        <nav className="flex-1 min-w-0">
          <ul className="flex gap-1 overflow-x-auto">
            {tabs.map((t) => (
              <li key={t.to} className="shrink-0">
                <NavLink to={t.to} end={t.end}>
                  {({ isActive }) => (
                    <div className={`relative inline-flex items-center px-3 py-1.5 text-[13px] font-medium rounded-md transition-colors ${isActive ? '' : 'hover:bg-[#F5EEDF]'}`}>
                      {isActive && (
                        <motion.span
                          layoutId="admin-nav-indicator"
                          className="absolute inset-0 rounded-md bg-white ring-1 ring-stone-900/15"
                          transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                        />
                      )}
                      <span className={`relative z-10 ${isActive
                        ? 'text-stone-900'
                        : 'text-stone-600 hover:text-stone-900 transition-colors'}`}>
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
          <span className="hidden lg:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#F5EEDF] border border-warm text-[11px] font-mono text-stone-700">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
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
    </header>
  )
}
