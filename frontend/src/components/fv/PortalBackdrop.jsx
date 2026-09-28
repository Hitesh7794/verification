// PortalBackdrop — the tricolour, very faint, behind every page.
//
// Three bands sweeping across the sheet with the chakra resting on them,
// all at a few percent so it reads as paper rather than decoration. It is
// fixed, so it does not move with the content, and it draws nothing the
// eye can catch while reading.

export default function PortalBackdrop() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      <svg viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice" className="h-full w-full">
        <g opacity=".055">
          <path d="M-200 700L760 -40l150 120L-50 820z" fill="#F28C28" />
          <path d="M-50 820L910 80l150 120L100 940z" fill="#8A8AA0" />
          <path d="M100 940L1060 200l150 120L250 1060z" fill="#138808" />
        </g>
        <g opacity=".05" transform="translate(1290 250)">
          <circle r="210" fill="none" stroke="#0A0A5A" strokeWidth="7" />
          <circle r="182" fill="none" stroke="#0A0A5A" strokeWidth="3" />
          <circle r="20" fill="#0A0A5A" />
          {Array.from({ length: 24 }).map((_, i) => {
            const a = (i / 24) * Math.PI * 2
            return (
              <line key={i} x1={Math.cos(a) * 20} y1={Math.sin(a) * 20}
                    x2={Math.cos(a) * 206} y2={Math.sin(a) * 206} stroke="#0A0A5A" strokeWidth="4" />
            )
          })}
        </g>
      </svg>
    </div>
  )
}
