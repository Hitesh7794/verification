// Lightweight, hand-rolled UI primitives — no icon library, no emojis.
// Tailwind v4 utility classes only.
//
// ── Sentinel ────────────────────────────────────────────────────────
// Every export below keeps its original name, props and tone keys, so
// all ~96 calling components are unchanged by the retheme. What moved
// is the visual language:
//
//   * Azure carries action; ink navy carries chrome. The primary button
//     is no longer near-black — a filled azure reads as "the thing to
//     press" without competing with the navy top bar.
//   * Elevation is spent by role. A plain Card is a hairline on white;
//     only the surfaces that need attention lift.
//   * Every focus state is one visible azure ring, defined once in
//     index.css and inherited here.
//   * Figures use the display face with tabular lining numerals, so a
//     column of counts aligns and an animating CountUp doesn't jitter.

export function cn(...parts) {
  return parts.filter(Boolean).join(' ')
}

export function Button({ variant = 'primary', size = 'md', className = '', ...rest }) {
  const base =
    'inline-flex items-center justify-center gap-2 font-semibold rounded-lg ' +
    'transition-[background-color,box-shadow,transform] duration-150 ' +
    'focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 ' +
    'focus-visible:outline-brand-500 active:translate-y-px ' +
    'disabled:opacity-45 disabled:cursor-not-allowed disabled:active:translate-y-0'

  const variants = {
    // Primary — azure. The single filled action on a page.
    primary:
      'bg-brand-600 text-white shadow-sm hover:bg-brand-700 ' +
      'disabled:hover:bg-brand-600',
    // Secondary — the quiet companion to primary. Hairline, not fill.
    secondary:
      'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 ' +
      'hover:border-slate-400 shadow-xs',
    success:
      'bg-emerald-600 text-white shadow-sm hover:bg-emerald-700',
    danger:
      'bg-rose-600 text-white shadow-sm hover:bg-rose-700',
    // Ghost — for destructive-adjacent or tertiary actions in toolbars.
    ghost:
      'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
    // Ink — reserved for the one authoritative action on dark chrome.
    ink:
      'bg-ink-800 text-white shadow-sm hover:bg-ink-700',
  }

  const sizes = {
    sm: 'text-[13px] px-3 py-1.5',
    md: 'text-sm px-4 py-2',
    lg: 'text-[15px] px-5 py-2.5',
  }

  return (
    <button
      className={cn(base, variants[variant] || variants.primary, sizes[size] || sizes.md, className)}
      {...rest}
    />
  )
}

export function Input({ className = '', ...rest }) {
  return (
    <input
      className={cn(
        'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900',
        'placeholder-slate-400 shadow-xs transition-[border-color,box-shadow] duration-150',
        'hover:border-slate-400',
        'focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-500/12',
        'disabled:bg-slate-50 disabled:text-slate-500 disabled:cursor-not-allowed',
        className,
      )}
      {...rest}
    />
  )
}

export function Label({ className = '', ...rest }) {
  return (
    <label
      className={cn(
        'block text-[13px] font-semibold text-slate-700 mb-1.5 tracking-[-0.005em]',
        className,
      )}
      {...rest}
    />
  )
}

export function Card({ className = '', ...rest }) {
  return (
    <div
      className={cn(
        'rounded-xl border border-slate-200 bg-white shadow-xs',
        className,
      )}
      {...rest}
    />
  )
}

export function CardHeader({ className = '', ...rest }) {
  return (
    <div
      className={cn('px-6 py-4 border-b border-slate-200/80', className)}
      {...rest}
    />
  )
}

export function CardTitle({ className = '', ...rest }) {
  return (
    <h3
      className={cn(
        'font-display text-[15px] font-bold text-slate-900 tracking-[-0.015em]',
        className,
      )}
      {...rest}
    />
  )
}

export function CardBody({ className = '', ...rest }) {
  return <div className={cn('px-6 py-5', className)} {...rest} />
}

export function Badge({ tone = 'slate', children }) {
  // Ring rather than a heavier border: at 11px a 1px border swallows
  // the glyphs, while an inset ring keeps the pill crisp.
  const tones = {
    slate:   'bg-slate-100 text-slate-700 ring-slate-200',
    green:   'bg-emerald-50 text-emerald-800 ring-emerald-200',
    red:     'bg-rose-50 text-rose-800 ring-rose-200',
    indigo:  'bg-brand-50 text-brand-800 ring-brand-200',
    amber:   'bg-amber-50 text-amber-800 ring-amber-200',
  }
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold',
        'ring-1 ring-inset whitespace-nowrap',
        tones[tone] || tones.slate,
      )}
    >
      {children}
    </span>
  )
}

export function StatCard({ label, value, hint, tone = 'indigo' }) {
  // The accent is a top rule rather than a gradient wash — it marks the
  // tile's kind without tinting the figure underneath it.
  const tones = {
    indigo:  'bg-brand-600',
    emerald: 'bg-emerald-600',
    rose:    'bg-rose-600',
    amber:   'bg-amber-500',
    slate:   'bg-slate-400',
  }
  return (
    <Card className="overflow-hidden transition-shadow duration-200 hover:shadow-md">
      <div className={cn('h-[3px]', tones[tone] || tones.indigo)} />
      <CardBody>
        <p className="text-[11px] font-semibold uppercase tracking-[0.09em] text-slate-500">
          {label}
        </p>
        <p className="mt-2 stat-figure text-[32px] leading-none text-slate-900">
          {value}
        </p>
        {hint && <p className="mt-2 text-xs text-slate-500">{hint}</p>}
      </CardBody>
    </Card>
  )
}

export function PageHeader({ title, subtitle, right }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 mb-7">
      <div className="min-w-0">
        <h1 className="font-display text-[26px] font-extrabold tracking-[-0.025em] text-slate-900">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1.5 text-sm text-slate-500 max-w-2xl">{subtitle}</p>
        )}
      </div>
      {right}
    </div>
  )
}

export function EmptyState({ title, body }) {
  return (
    <div className="text-center py-12 px-6">
      {/* A quiet mark rather than an illustration — an empty table is a
          normal state here, not an error worth decorating. */}
      <div
        aria-hidden="true"
        className="mx-auto mb-3 h-9 w-9 rounded-full border border-dashed border-slate-300 bg-slate-50"
      />
      <p className="text-sm font-semibold text-slate-700">{title}</p>
      {body && <p className="mt-1 text-xs text-slate-500 max-w-sm mx-auto">{body}</p>}
    </div>
  )
}
