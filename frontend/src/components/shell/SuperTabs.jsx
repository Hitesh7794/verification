import { NavLink, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { BrandMark } from '../ui/brand.jsx'

// Executive top-bar for the superadmin surfaces. Navy chrome with a
// gold authority rule beneath it — the register a national credentialing
// body writes in. Product mark on the left, primary tabs in the middle,
// live IST clock + logout on the right. Active tab gets a subtle
// animated pill via framer's layoutId.
//
// Route surface (kept in sync with server.go /api/super* + /api/superadmin/*):
//   Overview      → /superadmin           (verification metrics)
//   Applications  → /superadmin/applications  (institution KYC queue)
//   Clients       → /superadmin/clients   (exam catalog root)

const tabs = [
  { to: '/superadmin',              label: 'Overview',     end: true  },
  { to: '/superadmin/applications', label: 'Applications', end: false },
  { to: '/superadmin/clients',      label: 'Clients',      end: false },
]

export default function SuperTabs() {
  const nav = useNavigate()
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(id)
  }, [])

  function onLogout() {
    try {
      localStorage.removeItem('token')
      localStorage.removeItem('role_scope')
      sessionStorage.clear()
    } catch { /* ignore quota / privacy-mode errors */ }
    nav('/superadmin/login', { replace: true })
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
            <span className="font-display text-[14px] font-extrabold text-white tracking-[-0.02em]">
              Verification Portal
            </span>
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-300/90">
              Superadmin
            </span>
          </div>
        </div>

        {/* Primary tabs */}
        <nav className="flex-1">
          <ul className="flex gap-1">
            {tabs.map((t) => (
              <li key={t.to}>
                <NavLink to={t.to} end={t.end}>
                  {({ isActive }) => (
                    <div className="relative inline-flex items-center px-3.5 py-1.5 text-[13px] font-semibold rounded-lg transition-colors">
                      {isActive && (
                        <motion.span
                          layoutId="super-nav-indicator"
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

        {/* Right cluster: time + logout */}
        <div className="flex items-center gap-3 shrink-0">
          <span className="hidden md:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/8 ring-1 ring-inset ring-white/15 text-[11px] font-mono text-slate-200 tabular-nums">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            {timeText}
          </span>
          <button
            onClick={onLogout}
            className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-slate-200 hover:text-white bg-white/8 hover:bg-white/16 ring-1 ring-inset ring-white/15 px-3 py-1.5 rounded-lg transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300"
            title="Sign out"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            Sign out
          </button>
        </div>
      </div>
      {/* Gold authority rule */}
      <div className="h-[2px] rule-gold" />
    </header>
  )
}
