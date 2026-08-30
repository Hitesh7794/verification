// Brand chip + portal header — a single source of truth for the
// product name & logo. Used by Landing, login screens, and the public
// registration flow so a rename is one-file.
//
// "Verification Portal" replaces the earlier "NEET Verification"
// wording — generic enough to fit any high-stakes-exam deployment
// without the NEET-specific framing.

import { Link } from 'react-router-dom'

export const PRODUCT_NAME = 'Verification Portal'

// Brand — the wordmark. Text-only, no leading icon.
// Uses a subtle two-tone treatment so the wordmark reads as a
// designed mark rather than plain UI text.
//   size:  'sm' (mini, for tight chrome) | 'md' (default)
//   subtitle: optional small secondary text under the name
//   linkTo:   wraps in a router Link when set
export function Brand({ size = 'md', subtitle, linkTo }) {
  const sizes = {
    sm: { text: 'text-[15px]', sub: 'text-[11px]' },
    md: { text: 'text-base',   sub: 'text-xs' },
    lg: { text: 'text-xl',     sub: 'text-xs' },
  }
  const s = sizes[size] || sizes.md
  const content = (
    <div className="flex flex-col leading-tight">
      <div className={`font-bold tracking-tight ${s.text}`}>
        <span className="text-stone-950">Verification</span>
        <span className="text-warm-accent ml-1 font-semibold">Portal</span>
      </div>
      {subtitle && (
        <div className={`text-stone-500 ${s.sub} mt-0.5`}>{subtitle}</div>
      )}
    </div>
  )
  if (linkTo) {
    return (
      <Link to={linkTo} className="block hover:opacity-80 transition-opacity">
        {content}
      </Link>
    )
  }
  return content
}

// PortalHeader — full-width sticky top bar used by stand-alone pages
// (registration flow, set-password landing). Includes the Brand chip
// on the left and slots a freely-composed right action (e.g., a
// "Back to home" link or context-specific button).
//
// `tagLabel` renders a small subtle chip next to the brand (e.g.
// "Institution Registration") so the user knows which surface they're
// looking at without it dominating the bar.
export function PortalHeader({ subtitle, tagLabel, right }) {
  return (
    <header className="sticky top-0 z-30 bg-[#FFFDF8]/90 backdrop-blur-md border-b border-[#EDE4D3] shadow-xs">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Brand size="lg" subtitle={subtitle} linkTo="/" />
          {tagLabel && (
            <span className="hidden sm:inline-flex items-center rounded-full
                             bg-[#F5EEDF] px-2.5 py-1 text-[11px] font-semibold text-amber-900
                             border border-[#EDE4D3]">
              {tagLabel}
            </span>
          )}
        </div>
        {right && <div className="shrink-0">{right}</div>}
      </div>
      {/* Warm amber / gold hairline accent under the header */}
      <div className="h-[2px] bg-gradient-to-r from-amber-700/70 via-amber-500/80 to-amber-800/70" />
    </header>
  )
}
