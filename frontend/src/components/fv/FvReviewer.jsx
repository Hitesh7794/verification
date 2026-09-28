import Bi, { hi, HindiName } from './hindi.jsx'
import { InstitutionArt, DecisionStamp, ArtCollege } from './FvArt.jsx'

// FvReviewer — the pieces every page of an exam board's portal is built
// from, so a queue of institutions, a list of exams and a roster of agents
// all read the same way:
//
//   RvTile      a figure that is also a filter, with its own picture
//   RvSeal      a status, sealed, in both languages
//   RvPhoto     the institution's real photo (or its drawn campus),
//               faint across the right of a row
//   RvStamp     the decision, stamped over that photo
//   RvHead      a page title with its Hindi under it
//
// Hindi sits under the English on the few words that carry a decision —
// never on every label, which would make the page twice as long to read.

const V = '#5B3FA6', VD = '#43307D', VS = '#9A86D6', T = '#DDD5F2', L = '#EFEBF9'
const W = '#FFFFFF', SAF = '#F28C28', KH = '#EDD9B8', KHD = '#DDBB85', MARK = '#A8711F', RED = '#C62828'

// ── The tile pictures: one file, at the four moments of its life ─────
function FileBody({ x = 10, y = 12, w = 44, h = 44 }) {
  return (
    <g>
      <rect x={x + 3} y={y + 2} width={w} height={h} rx="3" fill={KHD} />
      <rect x={x + 2} y={y - 1} width={w - 4} height={h} rx="2" fill={W} stroke={T} strokeWidth="1.4" />
      <rect x={x} y={y} width={w} height={h} rx="3" fill={KH} stroke={KHD} strokeWidth="1.6" />
      <rect x={x + 7} y={y + 7} width={w - 22} height="9" rx="2" fill={W} stroke={T} strokeWidth="1.2" />
      <rect x={x + 10} y={y + 10} width="10" height="2.4" rx="1.2" fill={V} />
      <path d={`M${x} ${y + h * 0.6}h${w}`} stroke={SAF} strokeWidth="2.6" />
      <path d={`M${x + w / 2} ${y}v${h}`} stroke={SAF} strokeWidth="2.6" opacity=".9" />
      <circle cx={x + w / 2} cy={y + h * 0.6} r="3.4" fill={SAF} />
    </g>
  )
}
const Box = ({ className, children }) => <svg viewBox="0 0 64 64" className={className} aria-hidden="true">{children}</svg>
const ART = {
  pending: ({ className }) => (
    <Box className={className}>
      <rect x="4" y="22" width="42" height="36" rx="3" fill={KHD} transform="rotate(-6 25 40)" />
      <FileBody x={12} y={10} w={40} h={42} />
      <circle cx="49" cy="49" r="12" fill={SAF} />
      <path d="M49 42.5V49l4.5 3" fill="none" stroke={W} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </Box>
  ),
  approved: ({ className }) => (
    <Box className={className}>
      <FileBody x={8} y={10} w={42} h={44} />
      <g transform="translate(45 44) rotate(-14)">
        <circle r="15" fill="none" stroke={V} strokeWidth="3.6" />
        <circle r="10.5" fill="none" stroke={V} strokeWidth="1.2" strokeDasharray="2.6 2.6" />
        <path d="M-5.6 .2l3.8 3.8 7.4-8" fill="none" stroke={V} strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </Box>
  ),
  rejected: ({ className }) => (
    <Box className={className}>
      <FileBody x={8} y={12} w={42} h={42} />
      <path d="M50 20a20 20 0 0 0-30-6" fill="none" stroke={RED} strokeWidth="3" strokeLinecap="round" />
      <path d="M20 6l-4 8 9 1z" fill={RED} />
      <g transform="translate(44 44) rotate(12)">
        <circle r="13" fill="none" stroke={RED} strokeWidth="3.4" />
        <path d="M-5 -5l10 10M5 -5l-10 10" stroke={RED} strokeWidth="3.4" strokeLinecap="round" />
      </g>
    </Box>
  ),
  total: ({ className }) => (
    <Box className={className}>
      <rect x="4" y="50" width="56" height="6" rx="2" fill={VD} />
      <g transform="translate(0 -2)">
        <rect x="8" y="22" width="14" height="28" rx="2" fill={KH} stroke={KHD} strokeWidth="1.4" />
        <rect x="24" y="16" width="14" height="34" rx="2" fill={VS} />
        <rect x="40" y="26" width="14" height="24" rx="2" fill={KH} stroke={KHD} strokeWidth="1.4" />
        <path d="M8 40h14M24 40h14M40 40h14" stroke={SAF} strokeWidth="2.2" />
      </g>
    </Box>
  ),
  institutes: ({ className }) => <ArtCollege className={className} />,
  exams: ({ className }) => (
    <Box className={className}>
      <rect x="10" y="8" width="44" height="48" rx="4" fill={W} stroke={T} strokeWidth="2" />
      <rect x="10" y="8" width="44" height="10" rx="4" fill={V} />
      {[26, 34, 42, 50].map((y, r) => (
        <g key={y}>{[20, 28, 36, 44].map((x, c) => (
          <circle key={x} cx={x} cy={y} r="2.6" fill={c === (r + 1) % 4 ? V : W} stroke={VS} strokeWidth="1.1" />
        ))}</g>
      ))}
    </Box>
  ),
  agents: ({ className }) => (
    <Box className={className}>
      <path d="M12 58c0-10 9-16 20-16s20 6 20 16z" fill={V} />
      <circle cx="32" cy="26" r="11" fill="#E8C39E" />
      <path d="M20.6 25c0-7 5-11.4 11.4-11.4S43.4 18 43.4 25c-1.8-3.6-4.4-5.8-8-6.4-2.4 2.2-7.8 3.6-14.8 6.4z" fill="#211E33" />
      <circle cx="28" cy="27" r="1.3" fill="#211E33" /><circle cx="36" cy="27" r="1.3" fill="#211E33" />
      <path d="M27.5 42 32 48l4.5-6" fill={W} />
      <path d="M28 43l4 10 4-10" stroke={SAF} strokeWidth="1.8" fill="none" />
    </Box>
  ),
}

// A figure that is also a filter: the number leads, the picture sits
// behind it, the Hindi under the label.
export function RvTile({ kind = 'total', label, value, hint, active, onClick, guide, mood, prop }) {
  const Art = ART[kind] || ART.total
  const h = hi(label)
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
            data-guide-title={label} data-guide={guide} data-guide-mood={mood} data-guide-prop={prop}
            className={`fv-lift relative flex items-center gap-3 overflow-hidden rounded-[12px] border bg-fv-card px-4 py-3 text-left transition-colors ${
              active ? 'border-fv-accent bg-fv-card-focus' : 'border-fv-line hover:bg-fv-card-focus'}`}>
      <Art className={`absolute right-2 top-1/2 h-[68px] w-[68px] -translate-y-1/2 opacity-90 ${
        kind === 'pending' && value > 0 ? 'fv-breathe' : ''}`} />
      <div className="relative min-w-0 flex-1 pr-[62px]">
        <p className="fv-display text-[44px] leading-[0.9] tracking-[-0.045em] text-fv-ink tabular-nums">{value ?? '—'}</p>
        <p className="mt-1.5 truncate text-[13.5px] leading-tight text-fv-muted">{label}</p>
        {h && <p className="fv-hi truncate text-[12px] leading-tight text-fv-faint">{h}</p>}
        {hint && <p className="mt-0.5 truncate text-[12px] leading-tight text-fv-faint">{hint}</p>}
      </div>
    </button>
  )
}

// A status, sealed, in both languages.
export function RvSeal({ status, className = '' }) {
  const map = {
    approved: ['Approved', V], rejected: ['Rejected', RED], pending: ['Waiting on you', MARK],
    active: ['Active', V], disabled: ['Disabled', '#A29EB3'], locked: ['Locked', MARK],
    verified: ['Verified', V], denied: ['Denied', MARK], abandoned: ['Abandoned', '#A29EB3'],
  }
  const [title, c] = map[status] || map.pending
  const mark = {
    approved: <path d="M8 12.3l2.6 2.6 5.2-6" fill="none" stroke={c} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />,
    verified: <path d="M8 12.3l2.6 2.6 5.2-6" fill="none" stroke={c} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />,
    active: <path d="M8 12.3l2.6 2.6 5.2-6" fill="none" stroke={c} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />,
    rejected: <path d="M9 9l6 6M15 9l-6 6" stroke={c} strokeWidth="2.2" strokeLinecap="round" />,
    denied: <path d="M9 9l6 6M15 9l-6 6" stroke={c} strokeWidth="2.2" strokeLinecap="round" />,
    pending: <path d="M12 7.5V12l3 2" fill="none" stroke={c} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />,
    disabled: <path d="M7.5 12h9" stroke={c} strokeWidth="2.2" strokeLinecap="round" />,
    abandoned: <path d="M7.5 12h9" stroke={c} strokeWidth="2.2" strokeLinecap="round" />,
    locked: <><rect x="8" y="11.5" width="8" height="6" rx="1.6" fill={c} /><path d="M9.6 11.5V10a2.4 2.4 0 0 1 4.8 0v1.5" fill="none" stroke={c} strokeWidth="1.8" /></>,
  }[status] || null
  return (
    <span className={`inline-flex items-center gap-1.5 text-[12.5px] leading-tight text-fv-muted ${className}`} title={title}>
      <svg viewBox="0 0 24 24" className={`h-6 w-6 shrink-0 ${status === 'pending' ? 'fv-breathe' : ''}`} aria-label={title}>
        <circle cx="12" cy="12" r="10.5" fill="none" stroke={c} strokeWidth="2" />
        <circle cx="12" cy="12" r="7.5" fill="none" stroke={c} strokeWidth=".9" strokeDasharray="2.4 2.4" />
        {mark}
      </svg>
      <Bi en={title} />
    </span>
  )
}

// The institution across the right of a row: its real photo when one can
// be found, else its drawn campus, faded in from the left.
export function RvPhoto({ name, photo, width = '42%' }) {
  return (
    <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 opacity-[0.09]"
          style={{ width, maskImage: 'linear-gradient(to right, transparent, #000 55%)', WebkitMaskImage: 'linear-gradient(to right, transparent, #000 55%)' }}>
      <InstitutionArt name={name} photo={photo} className="h-full w-full" />
    </span>
  )
}

// The decision, stamped over that photo.
export function RvStamp({ status, className = 'h-16 w-44', right = '19%' }) {
  if (status !== 'approved' && status !== 'rejected') return null
  return (
    <span aria-hidden="true" className="fv-stamp pointer-events-none absolute top-1/2 hidden -translate-y-1/2 lg:block" style={{ right }}>
      <DecisionStamp status={status} className={className} />
    </span>
  )
}

// A page title, with its Hindi under it.
export function RvHead({ title, subtitle, art: Art, right, hindi }) {
  const h = hindi || hi(title)
  return (
    <div className="mb-5 flex items-center justify-between gap-5">
      <div className="flex min-w-0 items-center gap-4">
        {Art && <Art className="h-14 w-14 shrink-0" />}
        <div className="min-w-0">
          <h1 className="fv-display text-[30px] leading-[1.05] tracking-[-0.03em] text-fv-ink">{title}</h1>
          {h && <p className="fv-hi text-[15px] leading-tight text-fv-faint">{h}</p>}
          {subtitle && <p className="mt-1 max-w-2xl text-[14.5px] leading-snug text-fv-muted">{subtitle}</p>}
        </div>
      </div>
      {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
    </div>
  )
}

export { HindiName }
