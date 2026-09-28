import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import useScene from './motion.js'
import Verifier from '../login/Verifier.jsx'
import BioHero from './BioHero.jsx'

// BioStage — the fingerprint and the iris take the whole screen.
//
// The desk is lit from above: the reader (or the tower) stands on the left
// under a pool of light with the finger coming down onto it, and the
// capture comes up on the plate beside it, ridge by ridge, under a bar
// that travels with the read. The companion stands at the bottom telling
// the operator what to do, and the step strip stays across the top so the
// operator never loses the thread.
//
// props: kind, status, src, seed, step, line, onScan, onCancel, onBack

const V = '#5B3FA6', W = '#FFFFFF', AMB_D = '#A8711F'

const STEPS = [
  ['Roll number', 'अनुक्रमांक'],
  ['Face', 'चेहरा'],
  ['Fingerprint', 'अंगुली'],
  ['Iris', 'पुतली'],
  ['Decision', 'निर्णय'],
]

function useMood({ status }) {
  const [beat, setBeat] = useState(0)
  useEffect(() => { setBeat(0) }, [status])
  useEffect(() => {
    const id = setInterval(() => setBeat((b) => b + 1), status === 'scanning' ? 1600 : 2400)
    return () => clearInterval(id)
  }, [status])
  if (status === 'pass') return [{ type: 'right' }, { type: 'matched' }, { type: 'thumbsUp' }][Math.min(beat, 2)]
  if (status === 'fail') return [{ type: 'confused' }, { type: 'waiting' }][beat % 2]
  if (status === 'scanning') return [{ type: 'waiting' }, { type: 'pointUp' }][beat % 2]
  return [{ type: 'point' }, { type: 'wave' }, { type: 'point' }][beat % 3]
}

// The strip the operator keeps an eye on, in the dark.
function DarkStrip({ step }) {
  return (
    <ol className="flex items-center gap-2">
      {STEPS.map(([title, hi], i) => {
        const n = i + 1
        const done = n < step
        const now = n === step
        return (
          <li key={title} className="flex items-center gap-2">
            <span className={`grid h-7 w-7 place-items-center rounded-full text-[12px] font-bold ${
              done || now ? 'bg-fv-accent text-white' : 'bg-white text-fv-faint ring-1 ring-fv-line'}`}>
              {done ? (
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12.5l4.5 4.5L19 7" />
                </svg>
              ) : n}
            </span>
            <span className={`hidden leading-tight lg:block ${now ? 'text-fv-ink' : 'text-fv-muted'}`}>
              <span className="block text-[13px] font-bold">{title}</span>
              <span className="fv-hi block text-[11.5px] font-bold opacity-80">{hi}</span>
            </span>
            {i < STEPS.length - 1 && (
              <span className={`mx-1 hidden h-[3px] w-8 rounded-full lg:block ${done ? 'bg-fv-accent' : 'bg-fv-line'}`} />
            )}
          </li>
        )
      })}
    </ol>
  )
}

export default function BioStage({
  kind = 'finger', status = 'idle', src, seed = '', step = 3, line = ['', ''],
  onScan, onBack, onCancel, onNext, nextLabel = ['Next', 'आगे'], error,
}) {
  const { t, v } = useScene({ done: status === 'pass' || status === 'fail' ? 1 : 0 }, 6)
  const scanning = status === 'scanning'
  const ok = status === 'pass'
  const bad = status === 'fail'
  const mood = useMood({ status })
  const glow = bad ? 'rgba(168,113,31,.35)' : 'rgba(91,63,166,.45)'

  // Escape closes the overlay when the caller has wired a cancel
  // path, so a reader that hangs mid-scan doesn't strand the operator
  // with only "reload the page" as an escape hatch. Ignored while a
  // scan is in flight to avoid interrupting a live read by accident.
  useEffect(() => {
    if (!onCancel) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape' && !scanning) { e.preventDefault(); onCancel() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel, scanning])

  return createPortal((
    <div className="fixed inset-0 z-[60] flex flex-col overflow-hidden backdrop-blur-[3px]"
         style={{ background: 'radial-gradient(92% 72% at 50% 46%, rgba(255,255,255,.70) 0%, rgba(245,242,253,.86) 55%, rgba(236,232,248,.93) 100%)' }}>
      {/* the portal is still there, under the glass */}
      <span aria-hidden="true" className="pointer-events-none absolute inset-0"
            style={{ background: `radial-gradient(46% 40% at 50% 46%, ${glow} 0%, rgba(255,255,255,0) 72%)`, opacity: 0.3 + v.done * 0.2 }} />

      {/* where the operator is */}
      <div className="relative flex items-center justify-between gap-4 px-6 py-3">
        <DarkStrip step={step} />
        <div className="flex items-center gap-2">
          {onBack && (
            <button type="button" onClick={onBack}
                    className="rounded-[12px] border border-fv-line bg-white/85 px-4 py-2 text-[14px] font-bold text-fv-ink backdrop-blur-sm transition hover:bg-white">
              Back <span className="fv-hi ml-1 text-[12.5px] font-bold text-fv-faint">वापस</span>
            </button>
          )}
          {onCancel && (
            /* Close chip in the top-right corner — the escape hatch
               when a reader stalls or the operator needs to step out
               of the flow. Disabled during an active scan so a
               mis-click doesn't cancel a reading in progress. */
            <button
              type="button"
              onClick={onCancel}
              disabled={scanning}
              aria-label="Close and go back"
              title="Close (Esc)"
              className="grid h-10 w-10 place-items-center rounded-full border border-fv-line bg-white/85 text-fv-muted backdrop-blur-sm transition hover:bg-white hover:text-fv-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 6l12 12M18 6l-12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* the device, and what it is lifting */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-8">
        <div className="relative h-full max-h-[78vh] w-[min(76vh,700px)]">
          <BioHero key={kind} kind={kind === 'iris' ? 'iris' : 'finger'} status={status} seed={seed} src={src}
                   theme="light" className="h-full w-full" />
          {/* the ring that closes while it reads */}
          <svg viewBox="0 0 100 100" className="pointer-events-none absolute -right-6 top-2 h-16 w-16">
            <circle cx="50" cy="50" r="34" fill="#FFFFFF" opacity=".9" />
            <circle cx="50" cy="50" r="34" fill="none" stroke="#DDD5F2" strokeWidth="5" />
            <circle cx="50" cy="50" r="34" fill="none" stroke={bad ? AMB_D : V} strokeWidth="5" strokeLinecap="round"
                    strokeDasharray={`${(2 * Math.PI * 34 * (scanning ? (t * 0.85) % 1 : v.done)).toFixed(1)} 999`}
                    transform="rotate(-90 50 50)" />
            {ok && <path d="M36 51l10 10 20-22" fill="none" stroke="#FFFFFF" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />}
          </svg>
        </div>
      </div>

      {/* him, and the action */}
      <div className="relative flex flex-wrap items-end justify-between gap-6 px-8 pb-5 pt-5"
           style={{ background: 'linear-gradient(to top, rgba(255,255,255,.94), rgba(255,255,255,.6) 60%, rgba(255,255,255,0))' }}>
        <div className="flex items-end gap-4">
          <span className="h-[clamp(84px,14vh,150px)] w-[clamp(84px,14vh,150px)] shrink-0">
            <Verifier mood={mood} className="h-full w-full" />
          </span>
          <span className="pb-3 leading-tight">
            <span className="block text-[clamp(18px,2.6vh,28px)] font-bold tracking-[-0.02em] text-fv-ink">{line[0]}</span>
            <span className="fv-hi mt-1 block text-[clamp(13px,1.9vh,18px)] font-bold text-fv-muted">{line[1]}</span>
            {error && (
              <span className="mt-3 block max-w-[48ch] rounded-[10px] border border-[#EDD9B8] bg-[#F6EDDD] px-3 py-2 text-[13.5px] font-bold text-[#A8711F]">
                {error}
              </span>
            )}
          </span>
        </div>

        {ok ? (
          <button type="button" onClick={onNext}
                  className="mb-3 rounded-[14px] bg-fv-accent px-8 py-3.5 text-[17px] font-bold text-white shadow-[0_10px_30px_rgba(91,63,166,.35)] transition hover:bg-fv-accent-deep">
            {nextLabel[0]}
            <span className="fv-hi ml-2 text-[14px] font-bold text-white/80">{nextLabel[1]}</span>
            <span aria-hidden="true" className="ml-2">&rarr;</span>
          </button>
        ) : (
          <button type="button" onClick={onScan} disabled={scanning}
                  className="mb-3 rounded-[14px] bg-fv-accent px-8 py-3.5 text-[17px] font-bold text-white shadow-[0_10px_30px_rgba(91,63,166,.35)] transition hover:bg-fv-accent-deep disabled:opacity-60">
            {scanning ? 'Reading…' : bad ? 'Try again' : kind === 'iris' ? 'Scan the eye' : 'Scan the finger'}
            {!scanning && <span aria-hidden="true" className="ml-2">&rarr;</span>}
          </button>
        )}
      </div>
    </div>
  ), document.body)
}
