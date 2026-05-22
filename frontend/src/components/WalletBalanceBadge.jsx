import { formatRupees } from '../lib/wallet.js'

// WalletBalanceBadge — the prominent navbar pill that surfaces the
// operator's current wallet balance. Click → opens the Deposit modal
// (the click handler is wired by the parent WalletWidget).
//
// Three visual tiers based on balance:
//
//   • empty   (balance == 0)        → rose / danger
//   • low     (< 5 lookups left)    → amber / warning
//   • healthy (≥ 5 lookups left)    → emerald / safe
//
// A "5 lookups left" threshold = balance < (feePaise * 5). For a
// ₹5/lookup fee, that's ₹25 — the operator gets early warning before
// they hit the hard 402 wall.
//
// The whole pill is a <button> so keyboard users can tab to it. Hover
// + focus rings are styled per-tier.

export default function WalletBalanceBadge({ balancePaise, feePaise = 500, onClick }) {
  const tier =
    balancePaise <= 0          ? 'empty' :
    balancePaise < feePaise * 5 ? 'low'  :
                                  'healthy'

  // Tailwind classes per tier. Each tier picks (bg, text, border, ring,
  // hover-bg) so the whole pill flips colour atomically.
  const tones = {
    healthy: 'bg-emerald-50 text-emerald-800 border-emerald-200 hover:bg-emerald-100 focus:ring-emerald-500',
    low:     'bg-amber-50  text-amber-800  border-amber-200  hover:bg-amber-100  focus:ring-amber-500',
    empty:   'bg-rose-50   text-rose-800   border-rose-200   hover:bg-rose-100   focus:ring-rose-500',
  }
  const iconTones = {
    healthy: 'text-emerald-600',
    low:     'text-amber-600',
    empty:   'text-rose-600',
  }
  const titles = {
    healthy: `Wallet — click to top up. Each candidate lookup costs ${formatRupees(feePaise)}.`,
    low:     `Wallet running low — top up soon. Each candidate lookup costs ${formatRupees(feePaise)}.`,
    empty:   `Wallet empty — top up to continue. Each candidate lookup costs ${formatRupees(feePaise)}.`,
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title={titles[tier]}
      aria-label={`Wallet balance ${formatRupees(balancePaise)}. ${titles[tier]}`}
      className={
        'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 ' +
        'text-sm font-semibold tabular-nums transition ' +
        'focus:outline-none focus:ring-2 focus:ring-offset-1 ' +
        tones[tier]
      }
    >
      <WalletIcon className={`h-4 w-4 shrink-0 ${iconTones[tier]}`} />
      <span className="leading-none">{formatRupees(balancePaise)}</span>
    </button>
  )
}

// Inline SVG so we don't need an icon library. 24x24 viewBox, single-
// path wallet glyph. The parent caller passes className (sizing + color).
function WalletIcon({ className }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {/* Wallet body */}
      <path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3h-4a3 3 0 0 0 0 6h4v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
      {/* Card slot indicator */}
      <circle cx="17" cy="13" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  )
}
