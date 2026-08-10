// Extra UI primitives — refined "Linear / Vercel / Notion"-style.
//
// Design principles:
//   - Monochrome-leaning. Slate carries the load; colour appears only
//     on intentional accents (status pills, the primary CTA, error
//     states). No bright accent strips on cards.
//   - Subtle shadow + crisp 1px border. Cards feel like physical
//     surfaces, not flat coloured panels.
//   - All interactive elements animated via framer-motion (see
//     motion.jsx). Hover lift on cards, scale-down on press for
//     clickables.
//   - Single-glyph SVG icons (icons.jsx). No emoji, no library.

import { motion } from 'framer-motion'
import { Icon } from './icons.jsx'

// ---------------------------------------------------------------------------
// AestheticCard — the new primary container.
//
// No coloured accent strip. Subtle border + soft 2-layer shadow. When
// `interactive` is set, gains a hover lift and a slight border darken.
// ---------------------------------------------------------------------------
export function AestheticCard({ children, className = '', interactive = false }) {
  const base =
    'overflow-hidden rounded-2xl bg-white border border-slate-200/80 ' +
    'shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(15,23,42,0.08)]'
  if (interactive) {
    return (
      <motion.div
        whileHover={{
          y: -2,
          transition: { duration: 0.18, ease: 'easeOut' },
        }}
        className={`${base} transition-colors hover:border-slate-300 ${className}`}
      >
        {children}
      </motion.div>
    )
  }
  return <div className={`${base} ${className}`}>{children}</div>
}

// Back-compat: EnhancedCard is still imported by older files. Treat it
// as an alias for AestheticCard. The `accent` prop is now ignored (no
// more coloured top strips).
export function EnhancedCard({ children, className = '' }) {
  return <AestheticCard className={className}>{children}</AestheticCard>
}

// ---------------------------------------------------------------------------
// GradientHeader — kept for back-compat but now renders a refined dark
// slate header instead of the previous rainbow gradient. Most callers
// have moved to PortalHeader (in brand.jsx); this stays so old imports
// don't break.
// ---------------------------------------------------------------------------
export function GradientHeader({ title, subtitle, eyebrow, children }) {
  return (
    <div className="relative overflow-hidden bg-slate-900">
      <div
        aria-hidden="true"
        className="absolute inset-0 opacity-[0.15] [background-image:radial-gradient(circle_at_30%_20%,white,transparent_40%)]"
      />
      <div className="relative mx-auto max-w-5xl px-6 py-10 sm:py-14">
        {eyebrow && (
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400 mb-3">
            {eyebrow}
          </p>
        )}
        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-white">{title}</h1>
        {subtitle && (
          <p className="mt-3 text-base text-slate-300 max-w-2xl leading-relaxed">{subtitle}</p>
        )}
        {children && <div className="mt-6">{children}</div>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// StatTile — Linear / Plausible-style metric card.
//
// Layout (top → bottom, in clean rhythm):
//   1. Top row: small status DOT + label in small caps + (optional)
//      icon as a subtle accent on the right.
//   2. Big hero number (text-4xl, tabular, slate-900).
//   3. Optional caption in slate-500.
//
// No giant icon chip, no rails, no tinted card body. The colour shows
// up in exactly two places: a 6px status dot next to the label and a
// faint matching tint on the small icon. Clean, deliberate, lets the
// number be the focal point.
// ---------------------------------------------------------------------------
export function StatTile({ label, value, accent, icon: IconComp, hint, onClick, active = false }) {
  // Each accent only paints the card border + ring WHEN selected.
  // Default + hover stay neutral slate so the row looks calm; the
  // coloured border is the single clear "I'm the active filter" cue.
  const palettes = {
    pending:  { dot: 'bg-amber-500',   icon: 'text-amber-500',   activeBorder: 'border-amber-500',   ring: 'ring-amber-200' },
    approved: { dot: 'bg-emerald-500', icon: 'text-emerald-500', activeBorder: 'border-emerald-500', ring: 'ring-emerald-200' },
    rejected: { dot: 'bg-rose-500',    icon: 'text-rose-500',    activeBorder: 'border-rose-500',    ring: 'ring-rose-200' },
    total:    { dot: 'bg-slate-700',   icon: 'text-slate-500',   activeBorder: 'border-slate-700',   ring: 'ring-slate-200' },
  }
  const p = palettes[accent] || {
    dot: 'bg-slate-400', icon: 'text-slate-400',
    activeBorder: 'border-slate-900', ring: 'ring-slate-200',
  }

  const Tag = onClick ? motion.button : motion.div
  return (
    <Tag
      onClick={onClick}
      whileHover={onClick ? { y: -2 } : undefined}
      whileTap={onClick ? { y: 0, scale: 0.99 } : undefined}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className={`group relative overflow-hidden rounded-2xl border bg-white text-left w-full
                  shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(15,23,42,0.06)]
                  transition-all duration-150
                  ${active
                    ? `${p.activeBorder} ring-2 ${p.ring}`
                    : `border-slate-200/80 ${onClick ? 'hover:border-slate-300' : ''}`}
                  ${onClick ? 'cursor-pointer' : ''}`}
    >
      <div className="p-5">
        {/* Top row: dot + label (left), icon (right). The icon is a
            subtle slate stroke tinted to match the status — much
            quieter than the chunky chip it replaces. */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`h-1.5 w-1.5 rounded-full ${p.dot} shrink-0`} aria-hidden="true" />
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500 truncate">
              {label}
            </p>
          </div>
          {IconComp && (
            <IconComp className={`h-4 w-4 shrink-0 ${p.icon} opacity-80`} />
          )}
        </div>

        {/* Hero number — large, slate, tabular figures so values
            don't jitter when they change. */}
        <p className="mt-4 text-4xl font-semibold text-slate-900 tabular-nums tracking-tight leading-none">
          {value}
        </p>

        {/* Caption — small, slate-500, single line. */}
        {hint && (
          <p className="mt-2 text-xs text-slate-500 truncate">{hint}</p>
        )}

        {/* Active-state marker — small check in the bottom-right
            corner. Subtle but unambiguous. */}
        {active && (
          <span className="absolute bottom-3 right-3 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-slate-700">
            <Icon.Check className="h-3 w-3" />
            Filtered
          </span>
        )}
      </div>
    </Tag>
  )
}

// ---------------------------------------------------------------------------
// Pill — small coloured chip with optional dot indicator. Tonal,
// not saturated.
// ---------------------------------------------------------------------------
export function Pill({ tone = 'slate', children, dot = false }) {
  const tones = {
    slate:   'bg-slate-100 text-slate-700',
    indigo:  'bg-indigo-50 text-indigo-700',
    amber:   'bg-amber-50 text-amber-800',
    emerald: 'bg-emerald-50 text-emerald-800',
    rose:    'bg-rose-50 text-rose-800',
    violet:  'bg-violet-50 text-violet-800',
  }
  const dots = {
    slate:   'bg-slate-500',
    indigo:  'bg-indigo-500',
    amber:   'bg-amber-500',
    emerald: 'bg-emerald-500',
    rose:    'bg-rose-500',
    violet:  'bg-violet-500',
  }
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${tones[tone] || tones.slate}`}>
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${dots[tone] || dots.slate}`} />}
      {children}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Skeleton — pulsing placeholder with shimmer.
// ---------------------------------------------------------------------------
export function Skeleton({ className = 'h-4 w-full' }) {
  return (
    <div
      className={`relative overflow-hidden rounded bg-slate-200/70 ${className}`}
    >
      <div
        className="absolute inset-0 -translate-x-full animate-[shimmer_1.5s_infinite] bg-gradient-to-r from-transparent via-white/60 to-transparent"
        style={{ animationFillMode: 'forwards' }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// SectionTitle — small icon-led tracker above content groups.
// ---------------------------------------------------------------------------
export function SectionTitle({ icon: IconComp, children, action }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-2">
        {IconComp && (
          <span className="h-6 w-6 rounded-md bg-slate-100 text-slate-600 flex items-center justify-center">
            <IconComp className="h-3.5 w-3.5" />
          </span>
        )}
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-600">{children}</h3>
      </div>
      {action}
    </div>
  )
}

export { Icon }
