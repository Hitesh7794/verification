// The card that sits under or beside a reviewer page's tiles: charts,
// panels and the page's action. The tiles themselves are StatTile from
// ui/extras — the superadmin Applications page's component — not
// anything defined here.
//
// It lives here rather than in a page because the KYC inbox and the
// exams desk both need it, and the two had already drifted apart once.
//
// Shape is deliberately a single row. Stacking left a hole beside the
// figures on a desk monitor, because whatever sat to the right was
// always the taller column. Board identity is not here at all — it sits
// in the navy chrome, once, instead of on every card.

// Rule — the divider between zones. A hairline while the zones sit side
// by side, nothing once they stack.
export function Rule() {
  return <span aria-hidden="true" className="hidden xl:block self-stretch w-px bg-slate-100" />
}

// Band — the card beside the tiles: gold rule on top, one row of zones
// inside, stretched to the tiles' height.
export function Band({ children, className = '' }) {
  return (
    <div className={`flex flex-col rounded-2xl bg-warm-surface border border-warm overflow-hidden shadow-sm ${className}`}>
      <div className="h-[3px] rule-gold" />
      <div className="flex-1 px-5 py-4 flex flex-col xl:flex-row xl:items-center gap-5 xl:gap-6">
        {children}
      </div>
    </div>
  )
}
