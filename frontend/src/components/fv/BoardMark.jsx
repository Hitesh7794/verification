import ntaLogo from '../../assets/nta-logo.png'
import { ArtBoard } from './FvArt.jsx'

// BoardMark — an exam board's identity. Boards we hold official artwork
// for show it exactly as supplied (the name is part of the lockup, so it
// isn't typed again); every other board gets the flat crest and its name.
// Same matching as the reviewer portal's board lockups.
const MARKS = [
  { test: /national testing agency|\bnta\b/i, src: ntaLogo, alt: 'National Testing Agency, Excellence in Assessment' },
]

export function boardMarkFor(name = '') {
  return MARKS.find((m) => m.test.test(name)) || null
}

// size: 'sm' for inline lines, 'lg' for section headers
export default function BoardMark({ name, size = 'sm', nameClass = '' }) {
  const mark = boardMarkFor(name)
  if (mark) {
    return (
      <span className="inline-flex rounded-[10px] border border-fv-line bg-white px-2.5 py-1.5">
        <img src={mark.src} alt={mark.alt} className={`${size === 'lg' ? 'h-10' : 'h-7'} w-auto object-contain`} />
      </span>
    )
  }
  return (
    <span className="flex min-w-0 items-center gap-2">
      <ArtBoard className={`${size === 'lg' ? 'h-12 w-12' : 'h-6 w-6'} shrink-0`} />
      <span className={`truncate ${nameClass}`}>{name || '—'}</span>
    </span>
  )
}
