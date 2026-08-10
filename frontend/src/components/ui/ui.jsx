// Lightweight, hand-rolled UI primitives — no icon library, no emojis.
// Tailwind v4 utility classes only.

export function cn(...parts) {
  return parts.filter(Boolean).join(' ')
}

export function Button({ variant = 'primary', size = 'md', className = '', ...rest }) {
  const base =
    'inline-flex items-center justify-center font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed'
  const variants = {
    primary:
      'bg-indigo-600 text-white hover:bg-indigo-700 focus:ring-indigo-500',
    secondary:
      'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 focus:ring-slate-300',
    success:
      'bg-emerald-600 text-white hover:bg-emerald-700 focus:ring-emerald-500',
    danger:
      'bg-rose-600 text-white hover:bg-rose-700 focus:ring-rose-500',
    ghost:
      'text-slate-700 hover:bg-slate-100 focus:ring-slate-300',
  }
  const sizes = {
    sm: 'text-sm px-3 py-1.5',
    md: 'text-sm px-4 py-2',
    lg: 'text-base px-5 py-2.5',
  }
  return (
    <button
      className={cn(base, variants[variant], sizes[size], className)}
      {...rest}
    />
  )
}

export function Input({ className = '', ...rest }) {
  return (
    <input
      className={cn(
        'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200',
        className,
      )}
      {...rest}
    />
  )
}

export function Label({ className = '', ...rest }) {
  return (
    <label
      className={cn('block text-sm font-medium text-slate-700 mb-1.5', className)}
      {...rest}
    />
  )
}

export function Card({ className = '', ...rest }) {
  return (
    <div
      className={cn(
        'rounded-xl border border-slate-200 bg-white shadow-sm',
        className,
      )}
      {...rest}
    />
  )
}

export function CardHeader({ className = '', ...rest }) {
  return <div className={cn('px-6 py-4 border-b border-slate-100', className)} {...rest} />
}

export function CardTitle({ className = '', ...rest }) {
  return (
    <h3
      className={cn('text-base font-semibold text-slate-900', className)}
      {...rest}
    />
  )
}

export function CardBody({ className = '', ...rest }) {
  return <div className={cn('px-6 py-5', className)} {...rest} />
}

export function Badge({ tone = 'slate', children }) {
  const tones = {
    slate: 'bg-slate-100 text-slate-700',
    green: 'bg-emerald-100 text-emerald-700',
    red: 'bg-rose-100 text-rose-700',
    indigo: 'bg-indigo-100 text-indigo-700',
    amber: 'bg-amber-100 text-amber-700',
  }
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        tones[tone],
      )}
    >
      {children}
    </span>
  )
}

export function StatCard({ label, value, hint, tone = 'indigo' }) {
  const tones = {
    indigo: 'from-indigo-500 to-indigo-600',
    emerald: 'from-emerald-500 to-emerald-600',
    rose: 'from-rose-500 to-rose-600',
    amber: 'from-amber-500 to-amber-600',
    slate: 'from-slate-500 to-slate-600',
  }
  return (
    <Card className="overflow-hidden">
      <div className={cn('h-1 bg-gradient-to-r', tones[tone])} />
      <CardBody>
        <p className="text-sm font-medium text-slate-500">{label}</p>
        <p className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
          {value}
        </p>
        {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
      </CardBody>
    </Card>
  )
}

export function PageHeader({ title, subtitle, right }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 mb-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          {title}
        </h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {right}
    </div>
  )
}

export function EmptyState({ title, body }) {
  return (
    <div className="text-center py-10">
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {body && <p className="mt-1 text-xs text-slate-500">{body}</p>}
    </div>
  )
}
