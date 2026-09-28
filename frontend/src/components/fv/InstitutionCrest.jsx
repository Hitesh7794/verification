import { useMemo } from 'react'

// InstitutionCrest — a crest drawn for one institution, and only that one.
//
// Every row in the applications queue used to wear the same stock
// building icon, so a hundred colleges looked like one college a hundred
// times. A real institution has a crest, so this draws one: the seed is
// the institution's own name, and it decides the roof, how many columns
// the facade has, whether a dome or a flag sits on top, what is written
// on the ribbon, and which of the two violets the field takes.
//
// A university gets a dome and rays; a college gets a pediment and an
// open book; anything else gets the plain house. Nothing here is random
// at runtime — the same name always draws the same crest, so an operator
// learns to recognise one by its shape.
//
// props: name, type ('university' | 'college' | …), className, style

const INK = '#2B1F52'
const V = '#5B3FA6'
const VD = '#43307D'
const VS = '#9A86D6'
const L = '#EFEBF9'
const LL = '#F7F4FE'
const GOLD = '#E4A54B'
const W = '#FFFFFF'

const hash = (s) => {
  let h = 2166136261
  for (let i = 0; i < String(s).length; i++) { h ^= String(s).charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}

// Two or three letters, the way a crest carries them: first letters of
// the words that matter, skipping the joining words.
function initials(name) {
  const skip = new Set(['of', 'the', 'and', 'for', 'de', 'ka', 'ki', 'ke'])
  const words = String(name || '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !skip.has(w.toLowerCase()))
  if (words.length === 0) return '??'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return words.slice(0, 3).map((w) => w[0].toUpperCase()).join('')
}

export default function InstitutionCrest({ name = '', type = '', className = '', style }) {
  const g = useMemo(() => {
    const h = hash(name || type || 'x')
    const kind = /univ/i.test(type) ? 'university' : /college|institute|school/i.test(type) ? 'college' : 'body'
    return {
      kind,
      columns: 3 + (h % 3),                 // 3, 4 or 5
      deep: ((h >> 3) & 1) === 1,           // which violet the field takes
      rays: ((h >> 5) & 1) === 1 || kind === 'university',
      steps: 2 + ((h >> 7) % 2),
      letters: initials(name),
    }
  }, [name, type])

  const field = g.deep ? VD : V
  const cols = Array.from({ length: g.columns })
  const span = 30 / g.columns

  return (
    <svg viewBox="0 0 64 72" className={className} style={style} role="img" aria-label={`${name} crest`}>
      <defs>
        <linearGradient id={`ic-f-${g.letters}-${g.columns}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={LL} />
          <stop offset="1" stopColor={L} />
        </linearGradient>
      </defs>

      {/* the shield */}
      <path d="M32 2 60 9v28c0 16-11 26-28 33C15 63 4 53 4 37V9z" fill={field} />
      <path d="M32 6 56 12v25c0 13.6-9.4 22.4-24 28.6C17.4 59.4 8 50.6 8 37V12z"
            fill={`url(#ic-f-${g.letters}-${g.columns})`} />

      {/* the light behind the building */}
      {g.rays && (
        <g opacity=".5">
          {Array.from({ length: 9 }).map((_, i) => {
            const a = (-90 + (i - 4) * 13) * (Math.PI / 180)
            return (
              <line key={i} x1="32" y1="31" x2={32 + Math.cos(a) * 22} y2={31 + Math.sin(a) * 22}
                    stroke={VS} strokeWidth="1.1" strokeLinecap="round" opacity={i % 2 ? '.5' : '.85'} />
            )
          })}
        </g>
      )}

      {/* what sits on the roof */}
      {g.kind === 'university' ? (
        <g>
          <path d="M26 20a6 6 0 0112 0z" fill={field} />
          <rect x="31.2" y="12" width="1.6" height="6" rx=".8" fill={GOLD} />
          <circle cx="32" cy="11" r="1.6" fill={GOLD} />
        </g>
      ) : (
        <g>
          <path d="M22 20l10-7 10 7z" fill={field} />
          <rect x="31.2" y="9.5" width="1.4" height="5" rx=".7" fill={GOLD} />
          <path d="M32.6 9.8l6 1.6-6 1.6z" fill={GOLD} />
        </g>
      )}

      {/* the facade */}
      <rect x="17" y="20" width="30" height="2.6" rx="1.3" fill={field} />
      {cols.map((_, i) => (
        <g key={i}>
          <rect x={18.5 + i * span + span / 2 - 1.5} y="23.4" width="3" height="13" rx="1.2" fill={field} opacity=".92" />
          <rect x={18.5 + i * span + span / 2 - 2.1} y="23.4" width="4.2" height="1.4" rx=".7" fill={field} />
        </g>
      ))}
      {Array.from({ length: g.steps }).map((_, i) => (
        <rect key={i} x={17 - i * 1.6} y={36.6 + i * 2} width={30 + i * 3.2} height="2" rx="1" fill={field}
              opacity={(0.95 - i * 0.12).toFixed(2)} />
      ))}

      {/* what the place does */}
      {g.kind === 'college' && (
        <g transform="translate(32 47.5)">
          <path d="M-8 -3.2c3-1.6 5.6-1.6 8 0 2.4-1.6 5-1.6 8 0v6.4c-3-1.6-5.6-1.6-8 0-2.4-1.6-5-1.6-8 0z"
                fill={W} stroke={field} strokeWidth="1.1" strokeLinejoin="round" />
          <path d="M0 -3.2v6.4" stroke={field} strokeWidth="1.1" />
        </g>
      )}
      {g.kind === 'university' && (
        <g transform="translate(32 47)">
          <path d="M-9 -1.6L0 -5l9 3.4L0 2z" fill={W} stroke={field} strokeWidth="1.1" strokeLinejoin="round" />
          <path d="M5.4 -.2v4.2" stroke={field} strokeWidth="1.1" strokeLinecap="round" />
        </g>
      )}
      {g.kind === 'body' && (
        <g transform="translate(32 47)">
          <circle r="5" fill={W} stroke={field} strokeWidth="1.1" />
          <path d="M-2.2 .2l1.7 1.7 3-3.4" fill="none" stroke={field} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      )}

      {/* the ribbon, and the letters on it */}
      <path d="M11 53h42l-4 5 4 5H11l4-5z" fill={GOLD} opacity=".22" />
      <path d="M13 53.5h38l-3.4 4.5 3.4 4.5H13l3.4-4.5z" fill={field} />
      <text x="32" y="59.6" textAnchor="middle" fill={W}
            style={{ font: '700 7.4px "Bricolage Grotesque", system-ui, sans-serif', letterSpacing: '.6px' }}>
        {g.letters}
      </text>

      {/* a hairline so the crest reads on a white sheet */}
      <path d="M32 2 60 9v28c0 16-11 26-28 33C15 63 4 53 4 37V9z" fill="none" stroke={INK} strokeWidth="1" opacity=".14" />
    </svg>
  )
}
