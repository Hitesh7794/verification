import { motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

// Small primitives shared across the redesigned superadmin surfaces.
// Kept in a single file so the pages stay concise — every page can
// import { StatCard, DataCard, ToneBadge, TrendPill, CountUp } from
// one place.

// ── CountUp ──────────────────────────────────────────────────────────
// Animates a number from 0 to `value` on mount. 720ms, ease-out.
// Reduced-motion safe: if the OS asks for less motion, the final
// value renders immediately.
export function CountUp({ value = 0, duration = 720, className = '', format = 'int' }) {
  const [n, setN] = useState(0)
  useEffect(() => {
    const target = Number(value) || 0
    const prefersReduced = typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (prefersReduced || target === 0) { setN(target); return }
    const start = performance.now()
    let raf
    const tick = (t) => {
      const p = Math.min(1, (t - start) / duration)
      // easeOutCubic
      const eased = 1 - Math.pow(1 - p, 3)
      setN(target * eased)
      if (p < 1) raf = requestAnimationFrame(tick)
      else setN(target)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, duration])
  const rendered = format === 'pct' ? `${n.toFixed(1)}%` : Math.round(n).toLocaleString('en-IN')
  return <span className={`tabular-nums ${className}`}>{rendered}</span>
}

// ── StatCard ─────────────────────────────────────────────────────────
// The primary at-a-glance tile used across the Overview + list pages.
// Structure: eyebrow label + large numeric value (CountUp) + optional
// trend pill or subtitle. Hover lifts the shadow subtly.
export function StatCard({
  label, value, subtitle, trend, tone = 'slate', icon, to, format = 'int',
}) {
  const railMap = {
    slate:   'before:bg-slate-300',
    indigo:  'before:bg-brand-500',
    emerald: 'before:bg-emerald-500',
    amber:   'before:bg-amber-400',
    rose:    'before:bg-rose-500',
  }
  const iconToneMap = {
    slate:   'bg-slate-100 text-slate-600',
    indigo:  'bg-brand-50 text-brand-700',
    emerald: 'bg-emerald-50 text-emerald-700',
    amber:   'bg-amber-50 text-amber-700',
    rose:    'bg-rose-50 text-rose-700',
  }

  const inner = (
    <motion.div
      whileHover={{ y: -2 }}
      transition={{ type: 'spring', stiffness: 400, damping: 25 }}
      className={`group relative overflow-hidden rounded-xl border border-slate-200 bg-white p-5 pl-6
                  shadow-xs hover:shadow-md transition-shadow
                  before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:content-['']
                  ${railMap[tone] || railMap.slate}`}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-500">
          {label}
        </p>
        {icon && (
          <span className={`grid place-items-center h-8 w-8 rounded-lg ${iconToneMap[tone] || iconToneMap.slate}`}>
            {icon}
          </span>
        )}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="stat-figure text-[34px] leading-none text-slate-900">
          <CountUp value={value} format={format} />
        </span>
        {trend && <TrendPill {...trend} />}
      </div>
      {subtitle && (
        <p className="mt-2 text-xs text-slate-500">{subtitle}</p>
      )}
      {to && (
        <div className="mt-3 flex items-center gap-1 text-[11px] font-semibold text-brand-600 opacity-0 group-hover:opacity-100 transition-opacity">
          View details →
        </div>
      )}
    </motion.div>
  )
  return to ? <Link to={to} className="block rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500">{inner}</Link> : inner
}

// ── TrendPill ────────────────────────────────────────────────────────
// Optional delta indicator (↑ 12.4% vs 7d). Renders inline with the
// stat value. If `direction` is unset, computes from the sign of delta.
export function TrendPill({ delta = 0, unit = '%', label }) {
  const dir = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'
  const cls = dir === 'up'   ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
            : dir === 'down' ? 'bg-rose-50 text-rose-700 border-rose-200'
            :                  'bg-slate-50 text-slate-600 border-slate-200'
  const arrow = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '→'
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-semibold border ${cls}`}>
      {arrow} {Math.abs(delta).toFixed(1)}{unit}
      {label && <span className="font-normal opacity-70 ml-0.5">{label}</span>}
    </span>
  )
}

// ── DataCard ─────────────────────────────────────────────────────────
// General-purpose card for tables, forms, or content blocks. Consistent
// border-radius, hairline border, header slot with title + actions,
// scrollable body. Use for anything that isn't a stat tile.
export function DataCard({ title, subtitle, actions, footer, children, className = '', bodyClassName = '' }) {
  return (
    <div className={`rounded-xl border border-slate-200 bg-white shadow-xs overflow-hidden ${className}`}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-slate-200">
          <div className="min-w-0">
            {title && (
              <h3 className="font-display text-[14px] font-bold text-slate-900 tracking-[-0.015em] truncate">
                {title}
              </h3>
            )}
            {subtitle && (
              <p className="text-[11px] text-slate-500 mt-0.5 truncate">{subtitle}</p>
            )}
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </div>
      )}
      <div className={bodyClassName || 'p-5'}>{children}</div>
      {footer && (
        <div className="px-5 py-2.5 border-t border-slate-200 bg-slate-50 text-[11px] text-slate-500">
          {footer}
        </div>
      )}
    </div>
  )
}

// ── ToneBadge ────────────────────────────────────────────────────────
// Status pills for statuses like "Approved / Pending / Rejected",
// "Listed / Unlisted / Ended", etc.
export function ToneBadge({ tone = 'slate', children }) {
  const toneMap = {
    slate:   'bg-slate-100 text-slate-700 ring-slate-200',
    indigo:  'bg-brand-50 text-brand-800 ring-brand-200',
    emerald: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
    amber:   'bg-amber-50 text-amber-800 ring-amber-200',
    rose:    'bg-rose-50 text-rose-800 ring-rose-200',
    ink:     'bg-ink-800 text-white ring-ink-700',
  }
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold ring-1 ring-inset whitespace-nowrap ${toneMap[tone] || toneMap.slate}`}>
      {children}
    </span>
  )
}

// ── DataTable ────────────────────────────────────────────────────────
// Consistent, subtle table. Header row is small-caps slate. Body rows
// have hover states and last-column-right alignment for numbers.
export function DataTable({ columns, rows, empty = 'No data', onRowClick }) {
  if (!rows?.length) {
    return (
      <div className="text-center py-10 text-sm text-slate-500 italic">{empty}</div>
    )
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50/70">
            {columns.map((c) => (
              <th key={c.key} className={`px-4 py-2.5 text-left text-[10.5px] font-bold uppercase tracking-[0.09em] text-slate-500 ${c.align === 'right' ? 'text-right' : ''}`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r, i) => (
            <tr
              key={r.id ?? i}
              className={onRowClick ? 'hover:bg-brand-50/50 cursor-pointer transition-colors' : ''}
              onClick={() => onRowClick?.(r)}
            >
              {columns.map((c) => (
                <td key={c.key} className={`px-4 py-3 text-slate-700 ${c.align === 'right' ? 'text-right tabular-nums' : ''}`}>
                  {c.render ? c.render(r) : r[c.key] ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── LoadingSkeleton ──────────────────────────────────────────────────
// Shimmer placeholder used during initial data fetches.
export function LoadingSkeleton({ rows = 3, height = 'h-4' }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className={`${height} relative overflow-hidden rounded-md bg-slate-200`}
          style={{ opacity: 1 - i * 0.15 }}
        >
          <div
            className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/70 to-transparent"
            style={{ animation: 'shimmer 1.4s infinite' }}
          />
        </div>
      ))}
    </div>
  )
}
