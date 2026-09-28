import Verifier from '../login/Verifier.jsx'

// FvEmpty — an empty state with a little personality. The companion sits
// beside the message in a mood that fits (the detective when filters find
// nothing, patient when nothing has happened yet) and says one small,
// friendly line. The title and body still do the real work: what's
// missing and what to do.

const QUIPS = {
  waiting: ['All quiet. I’ll keep watch.', 'Nothing yet. I’m very good at waiting.', 'Clean slate. My favourite kind.', 'The desk is ready when they are.'],
  detective: ['I looked everywhere. Try a wider date range?', 'No luck with those filters. Loosen one?'],
  noDevice: ['Nothing to download yet. I’ll shout when there is.'],
  thumbsUp: ['All done here. Nicely handled.', 'Queue clear. Time for chai.'],
}

function pick(list, seed) {
  let h = 0
  for (const c of seed || '') h = (h * 31 + c.charCodeAt(0)) | 0
  return list[Math.abs(h) % list.length]
}

export function moodFor(title = '') {
  const t = title.toLowerCase()
  if (/match|found|no result/.test(t)) return 'detective'
  if (/install|download|device/.test(t)) return 'noDevice'
  if (/clear|all done|caught up/.test(t)) return 'thumbsUp'
  return 'waiting'
}

export default function FvEmpty({ title, body, mood, quip, children, className = '' }) {
  const m = mood || moodFor(title)
  const line = quip === false ? null : (quip || pick(QUIPS[m] || QUIPS.waiting, title))
  return (
    <div className={`flex items-center justify-center gap-5 px-6 py-8 ${className}`}>
      <div className="relative h-[112px] w-[112px] shrink-0">
        <Verifier mood={{ type: m }} className="h-full w-full" />
      </div>
      <div className="max-w-sm text-left">
        {line && (
          <p className="relative mb-2.5 inline-block rounded-[12px] border border-fv-line bg-fv-card px-3 py-1.5 text-[13px] font-medium text-fv-accent-deep">
            {line}
            <span aria-hidden="true" className="absolute -left-[6px] top-1/2 h-2.5 w-2.5 -translate-y-1/2 rotate-45 border-b border-l border-fv-line bg-fv-card" />
          </p>
        )}
        <p className="fv-display text-[17px] font-bold leading-tight text-fv-ink">{title}</p>
        {body && <p className="mt-1 text-[14px] leading-snug text-fv-muted">{body}</p>}
        {children && <div className="mt-3">{children}</div>}
      </div>
    </div>
  )
}
