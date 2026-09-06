// Brand chip + portal header — a single source of truth for the
// product name & logo. Used by Landing, login screens, and the public
// registration flow so a rename is one-file.
//
// "Verification Portal" replaces the earlier "NEET Verification"
// wording — generic enough to fit any high-stakes-exam deployment
// without the NEET-specific framing.
//
// ── Sentinel ────────────────────────────────────────────────────────
// The wordmark was previously text-only, which read as internal tooling
// rather than a product. It now carries a mark: a shield (custody of an
// identity) enclosing a check (the decision). Drawn as inline SVG so it
// stays crisp at every size, inherits currentColor, and costs no
// network request on the login screen's first paint.

import { Link } from 'react-router-dom'

export const PRODUCT_NAME = 'Verification Portal'

// BrandMark — the glyph on its own. Exported for surfaces that want the
// mark without the wordmark (favicon-alikes, compact chrome, loaders).
//   tone: 'brand' (azure on light) | 'inverse' (light on navy chrome)
export function BrandMark({ size = 28, tone = 'brand', className = '' }) {
  const inverse = tone === 'inverse'
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      role="img"
      aria-label="Verification Portal"
      className={className}
    >
      {/* Shield — custody of an identity. */}
      <path
        d="M16 2.5 4.5 7v9.2c0 6.4 4.7 11.4 11.5 13.3 6.8-1.9 11.5-6.9 11.5-13.3V7L16 2.5Z"
        fill={inverse ? 'rgba(255,255,255,0.10)' : '#EEF5FD'}
        stroke={inverse ? 'rgba(255,255,255,0.45)' : '#83B3E9'}
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      {/* Check — the decision. Gold: the one authoritative act. */}
      <path
        d="M10.6 16.1l3.7 3.8 7.1-7.6"
        stroke={inverse ? '#E8C55E' : '#A96D15'}
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// Brand — the wordmark. Mark + two-tone lockup.
//   size:  'sm' (mini, for tight chrome) | 'md' (default) | 'lg'
//   subtitle: optional small secondary text under the name
//   linkTo:   wraps in a router Link when set
//   tone:     'brand' (default) | 'inverse' for navy chrome
export function Brand({ size = 'md', subtitle, linkTo, tone = 'brand' }) {
  const sizes = {
    sm: { text: 'text-[15px]', sub: 'text-[11px]', mark: 22, gap: 'gap-2' },
    md: { text: 'text-base',   sub: 'text-xs',     mark: 26, gap: 'gap-2.5' },
    lg: { text: 'text-xl',     sub: 'text-xs',     mark: 30, gap: 'gap-3' },
  }
  const s = sizes[size] || sizes.md
  const inverse = tone === 'inverse'

  const content = (
    <div className={`flex items-center ${s.gap}`}>
      <BrandMark size={s.mark} tone={tone} className="shrink-0" />
      <div className="flex flex-col leading-tight min-w-0">
        <div className={`font-display font-extrabold tracking-[-0.025em] ${s.text}`}>
          <span className={inverse ? 'text-white' : 'text-slate-900'}>Verification</span>
          <span className={`ml-1.5 font-bold ${inverse ? 'text-amber-300' : 'text-warm-accent'}`}>
            Portal
          </span>
        </div>
        {subtitle && (
          <div className={`${inverse ? 'text-slate-300' : 'text-slate-500'} ${s.sub} mt-0.5 truncate`}>
            {subtitle}
          </div>
        )}
      </div>
    </div>
  )

  if (linkTo) {
    return (
      <Link
        to={linkTo}
        className="block rounded-lg transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-500"
      >
        {content}
      </Link>
    )
  }
  return content
}

// PortalHeader — full-width sticky top bar used by stand-alone pages
// (registration flow, set-password landing). Wears the same navy chrome
// and gold rule as every signed-in surface, so an institution's first
// screen already looks like the product it is joining. Includes the
// Brand chip on the left and slots a freely-composed right action
// (e.g., a "Back to home" link or context-specific button).
//
// `tagLabel` renders a small subtle chip next to the brand (e.g.
// "Institution Registration") so the user knows which surface they're
// looking at without it dominating the bar.
export function PortalHeader({ subtitle, tagLabel, right }) {
  return (
    <header className="sticky top-0 z-30 bg-ink-chrome">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Brand size="lg" subtitle={subtitle} linkTo="/" tone="inverse" />
          {tagLabel && (
            <span
              className="hidden sm:inline-flex items-center rounded-full bg-white/10
                         px-2.5 py-1 text-[11px] font-semibold text-slate-200
                         ring-1 ring-inset ring-white/20"
            >
              {tagLabel}
            </span>
          )}
        </div>
        {right && <div className="shrink-0">{right}</div>}
      </div>
      {/* Gold hairline — the authority rule under primary chrome. */}
      <div className="h-[2px] rule-gold" />
    </header>
  )
}
