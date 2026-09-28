import { useEffect, useState } from 'react'
import { PRODUCT_NAME } from '../ui/brand.jsx'
import LoginCard, { FvMark } from './LoginCard.jsx'
import { useLoginForm } from './useLoginForm.js'

// LoginShellPanel — VERSION B · Panel. Same form and behaviour as
// version A (components/shell/LoginShell.jsx), no companion.
//
// Split layout: a flat lit-violet brand panel on the left says what the
// product does, and shows it — the three capture steps as nodes on a
// hairline, lighting face → fingerprint → iris in turn. The form card
// sits on the page colour to the right. Below lg the panel folds away
// and the card stands alone under the wordmark.

export default function LoginShellPanel({ showRegisterLink = false, ...config }) {
  const f = useLoginForm(config)

  return (
    <div className="fv min-h-screen grid lg:grid-cols-[minmax(0,1fr)_minmax(480px,44%)]">
      {/* ── Brand panel ──────────────────────────────────────────── */}
      <aside className="hidden lg:flex flex-col justify-between bg-fv-card-focus p-12 xl:p-16">
        <div className="flex items-center gap-2.5">
          <FvMark />
          <span className="text-[17px] font-semibold tracking-[-0.01em] text-fv-ink">{PRODUCT_NAME}</span>
        </div>

        <div className="max-w-[560px]">
          <h2 className="text-[48px] xl:text-[56px] leading-[1.02] font-bold tracking-[-0.035em] text-fv-ink text-balance">
            From exam hall to <span className="text-fv-accent">admission desk.</span>
          </h2>
          <p className="mt-5 max-w-[440px] text-[17px] leading-relaxed text-fv-muted">
            One identity, months apart. Verified before a seat is granted.
          </p>
          <CaptureChain className="mt-12" />
        </div>

        <p className="text-[12px] text-fv-faint">Authorised access only. All sign-in attempts are logged.</p>
      </aside>

      {/* ── Form ─────────────────────────────────────────────────── */}
      <div className="flex flex-col">
        <header className="lg:hidden px-6 pt-6 flex items-center gap-2.5">
          <FvMark />
          <span className="text-[17px] font-semibold tracking-[-0.01em] text-fv-ink">{PRODUCT_NAME}</span>
        </header>
        <main className="flex-1 flex items-center justify-center px-4 py-10 sm:px-10">
          <LoginCard f={f} showRegisterLink={showRegisterLink} />
        </main>
        <p className="lg:hidden px-6 pb-5 text-[12px] text-fv-faint">
          Authorised access only. All sign-in attempts are logged.
        </p>
      </div>
    </div>
  )
}

// ── Capture chain ─────────────────────────────────────────────────────

const STEPS = [
  { key: 'face',   label: 'Face',        note: 'Live capture',    Glyph: FaceGlyph },
  { key: 'finger', label: 'Fingerprint', note: '1:1 match',       Glyph: FingerGlyph },
  { key: 'iris',   label: 'Iris',        note: 'When prints fail', Glyph: IrisGlyph },
]

function useCycle(n, ms) {
  const [i, setI] = useState(0)
  useEffect(() => {
    const reduce = typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduce) return
    const id = setInterval(() => setI((v) => (v + 1) % (n + 1)), ms)
    return () => clearInterval(id)
  }, [n, ms])
  return i // 0..n-1 = active node, n = all done
}

function CaptureChain({ className = '' }) {
  const step = useCycle(STEPS.length, 1600)
  const allDone = step === STEPS.length

  return (
    <div className={`rounded-[12px] border border-fv-line bg-fv-card p-7 ${className}`}>
      <div className="relative grid grid-cols-3">
        {/* hairline behind the nodes: dashed, solid accent up to the active node */}
        <div aria-hidden="true" className="absolute left-[16.66%] right-[16.66%] top-8 h-0 border-t-2 border-dashed border-fv-line" />
        <div
          aria-hidden="true"
          className="absolute left-[16.66%] top-8 h-[2px] -translate-y-[1px] bg-fv-accent transition-[width] duration-500 ease-out"
          style={{ width: `${(Math.min(step, STEPS.length - 1) / (STEPS.length - 1)) * 66.68}%` }}
        />
        {STEPS.map(({ key, label, note, Glyph }, i) => {
          const state = allDone || i < step ? 'done' : i === step ? 'active' : 'idle'
          return (
            <div key={key} className="relative flex flex-col items-center text-center">
              <div
                className={`relative grid h-16 w-16 place-items-center rounded-full transition-colors duration-300
                  ${state === 'active' ? 'bg-fv-accent text-fv-on-accent'
                    : state === 'done' ? 'bg-fv-tint text-fv-accent-deep'
                    : 'bg-fv-card text-fv-faint border-2 border-fv-tint'}`}
              >
                <Glyph className="h-7 w-7" />
                {state === 'done' && (
                  <span className="absolute -right-0.5 -bottom-0.5 grid h-5 w-5 place-items-center rounded-full bg-fv-accent text-white">
                    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 6.2 5 8.5l4.5-5" /></svg>
                  </span>
                )}
              </div>
              <p className={`mt-3 text-[15px] font-semibold ${state === 'idle' ? 'text-fv-muted' : 'text-fv-ink'}`}>{label}</p>
              <p className="text-[13px] text-fv-faint">{note}</p>
            </div>
          )
        })}
      </div>
      <div className="mt-6 pt-4 border-t border-fv-line flex items-center justify-between text-[13px]">
        <span className="text-fv-muted">
          {allDone ? 'Identity confirmed' : `Step ${step + 1} of 3 · ${STEPS[step].note}`}
        </span>
        <span className={`font-semibold ${allDone ? 'text-fv-accent' : 'text-fv-faint'}`}>
          {allDone ? 'Seat granted' : 'Verifying…'}
        </span>
      </div>
    </div>
  )
}

function FaceGlyph(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
      <circle cx="12" cy="10" r="3" />
      <path d="M7.5 17.5c1-2 2.6-3 4.5-3s3.5 1 4.5 3" />
    </svg>
  )
}
function FingerGlyph(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M6.5 16.5c-.6-1.4-1-3-1-4.5a6.5 6.5 0 0 1 11.3-4.4" />
      <path d="M18.3 10.5c.1.5.2 1 .2 1.5 0 2.6-.5 5-1.5 7" />
      <path d="M9 18.5c-.6-1.8-1-3.8-1-6.5a4 4 0 0 1 8 0c0 2.3-.3 4.3-.9 6" />
      <path d="M12 12c0 3 .5 5.4 1.3 7.5" />
    </svg>
  )
}
function IrisGlyph(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3.2" />
      <circle cx="12" cy="12" r="0.9" fill="currentColor" />
    </svg>
  )
}
