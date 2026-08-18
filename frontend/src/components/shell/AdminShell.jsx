import { motion } from 'framer-motion'
import AdminTabs from './AdminTabs.jsx'

// AdminShell — page chrome for every /admin/* surface.
//
// Sits below AdminTabs (which is the sticky header with brand, wallet,
// avatar, and the row of admin tabs). Provides consistent padding,
// max-width, and a subtle page-mount fade-in so navigation feels alive
// without being noisy.
//
// Usage:
//
//   <AdminShell>
//     <PageHead eyebrow="Overview" title="My dashboard" right={...} />
//     ...page content
//   </AdminShell>

export default function AdminShell({ children, walletRefreshKey, onWalletBalanceChange }) {
  return (
    <div className="min-h-full bg-warm-page">
      <AdminTabs
        walletRefreshKey={walletRefreshKey}
        onWalletBalanceChange={onWalletBalanceChange}
      />
      <motion.main
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        className="mx-auto max-w-7xl px-6 py-8"
      >
        {children}
      </motion.main>
    </div>
  )
}

// PageHead — title strip used at the top of each admin page. Matches
// the SuperShell PageHead visually so the two portals feel like one
// family, differentiated only by the tab strip up top.
export function PageHead({ eyebrow, title, subtitle, right }) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        {eyebrow && (
          <p className="text-[11px] font-semibold uppercase tracking-widest text-warm-accent mb-1.5">
            {eyebrow}
          </p>
        )}
        <h1 className="text-2xl font-semibold text-ink-900 tracking-tight">
          {title}
        </h1>
        {subtitle && (
          <p className="text-sm text-stone-500 mt-1 max-w-2xl">{subtitle}</p>
        )}
      </div>
      {right && <div className="flex items-center gap-2 shrink-0">{right}</div>}
    </div>
  )
}
