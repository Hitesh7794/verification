import { motion } from 'framer-motion'
import SuperTabs from './SuperTabs.jsx'

// Executive page shell for all superadmin surfaces. Sits between the
// sticky SuperTabs top bar and the page content. Provides:
//   - Consistent max-width + horizontal padding.
//   - PageHead: title + optional eyebrow + right-slot actions.
//   - Page-mount fade so navigation feels alive without being noisy.
//
// Usage:
//   <SuperShell>
//     <PageHead eyebrow="Overview" title="System dashboard" right={<Button ...>Export</Button>} />
//     ...page content
//   </SuperShell>

export default function SuperShell({ children }) {
  return (
    <div className="min-h-full bg-warm-page">
      <SuperTabs />
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

export function PageHead({ eyebrow, title, subtitle, right }) {
  return (
    <div className="mb-7 flex items-start justify-between gap-4">
      <div>
        {eyebrow && (
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-600 mb-1.5">
            {eyebrow}
          </p>
        )}
        <h1 className="font-display text-[26px] font-extrabold text-slate-900 tracking-[-0.025em]">
          {title}
        </h1>
        {subtitle && (
          <p className="text-sm text-slate-500 mt-1.5 max-w-2xl">{subtitle}</p>
        )}
      </div>
      {right && <div className="flex items-center gap-2 shrink-0">{right}</div>}
    </div>
  )
}

// Section title used within a page (below PageHead) to demarcate
// groupings. Small caps eyebrow, thin hairline underneath.
export function SectionHead({ title, count, right }) {
  return (
    <div className="mb-3.5 flex items-baseline justify-between gap-4 border-b border-slate-200 pb-2.5">
      <div className="flex items-baseline gap-2.5">
        <h2 className="text-[12px] font-bold uppercase tracking-[0.13em] text-slate-600">
          {title}
        </h2>
        {typeof count === 'number' && (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-mono font-semibold text-slate-600 tabular-nums">
            {count}
          </span>
        )}
      </div>
      {right && <div className="flex items-center gap-2">{right}</div>}
    </div>
  )
}
