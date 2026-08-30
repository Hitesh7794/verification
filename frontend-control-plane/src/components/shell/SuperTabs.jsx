import { NavLink, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useEffect, useState } from 'react'

// Executive top-bar for the superadmin surfaces. Clean white header
// with a hairline bottom border. Product mark on the left, primary
// tabs in the middle, live IST clock + logout on the right. Active
// tab gets a subtle animated underline via framer's layoutId.
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
    <header className="sticky top-0 z-40 border-b border-warm bg-warm-surface/95 backdrop-blur supports-[backdrop-filter]:bg-warm-surface/85">
      <div className="mx-auto max-w-7xl px-6 flex items-center gap-8 h-14">
        {/* Brand */}
        <div className="flex flex-col leading-tight shrink-0">
          <span className="text-[13px] font-semibold text-stone-900 tracking-tight">Verification Portal</span>
          <span className="text-[10px] uppercase tracking-widest text-warm-accent">Superadmin</span>
        </div>

        {/* Primary tabs */}
        <nav className="flex-1">
          <ul className="flex gap-1">
            {tabs.map((t) => (
              <li key={t.to}>
                <NavLink to={t.to} end={t.end}>
                  {({ isActive }) => (
                    <div className={`relative inline-flex items-center px-3 py-1.5 text-[13px] font-medium rounded-md transition-colors ${isActive ? '' : 'hover:bg-[#F5EEDF]'}`}>
                      {isActive && (
                        <motion.span
                          layoutId="super-nav-indicator"
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

        {/* Right cluster: time + logout */}
        <div className="flex items-center gap-3 shrink-0">
          <span className="hidden md:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#F5EEDF] border border-warm text-[11px] font-mono text-stone-700">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
            {timeText}
          </span>
          <button
            onClick={onLogout}
            className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-stone-800 hover:text-white bg-white hover:bg-stone-900 border border-warm-strong hover:border-stone-900 px-3 py-1.5 rounded-md shadow-sm transition-colors"
            title="Sign out"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            Sign out
          </button>
        </div>
      </div>
    </header>
  )
}
