import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../../lib/api.js'

// ReportProblem — the "Report a problem" affordance carried in the top
// bar of the admin, reviewer and agent shells.
//
// ── Why a form rather than a mailto: link ───────────────────────────
// Exam-centre machines are routinely locked down with no mail client
// configured. A mailto: on those machines opens nothing at all and the
// person gets no signal that their report went nowhere. Posting through
// the API works everywhere a browser does.
//
// It also lets the server attach who is reporting, in which role, from
// which organisation and which page — the details a support reply
// always needs and that nobody describing a problem thinks to include.
// Those fields come from the session on the server, never from this
// form, so a report can't be dressed up as someone else.
//
// The form used to list those attachments back to the reporter. It has
// been dropped: someone who has just hit a fault wants one box and a
// send button, and a panel of account metadata reads as paperwork in
// the way. Nothing about what the server sends has changed.
//
// ── The launcher ───────────────────────────────────────────────────
// A round chip in the header's right cluster, cut to the same 36px
// circle and the same white-on-navy tint as the avatar beside it, so
// the row reads as one set of controls rather than a widget parked on
// top of the chrome.
//
// The label arrives as a tooltip under the chip rather than by widening
// the button. In a fixed-width header an expanding pill would shove the
// clock, wallet and avatar sideways every time a pointer crossed it.
//
// Motion is rationed to two slow ambient beats — a halo that breathes
// once every 4s and the headset tipping once every 7s — plus the
// tooltip, which belongs to the pointer rather than a timer. The halo
// stops on hover so the two never run at once. This is a
// government-facing portal, so anything more insistent would read as a
// chat widget. Both beats collapse under prefers-reduced-motion.

const MIN_CHARS = 10
const MAX_CHARS = 4000

export default function ReportProblem() {
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [state, setState] = useState('idle') // idle | sending | sent | error
  const [err, setErr] = useState('')
  const areaRef = useRef(null)
  const triggerRef = useRef(null)

  // Focus the textarea on open, and hand focus back to the button on
  // close so a keyboard user isn't dropped at the top of the document.
  //
  // The `everOpened` guard matters: without it this effect's `open ===
  // false` branch runs on mount too, so simply loading any admin,
  // reviewer or agent page pulled focus onto the launcher. That stole
  // focus from the page for every user, and left the chip sitting under
  // a focus ring, tooltip open, before anyone had touched it.
  const everOpened = useRef(false)
  useEffect(() => {
    if (open) {
      everOpened.current = true
      const t = setTimeout(() => areaRef.current?.focus(), 60)
      return () => clearTimeout(t)
    }
    if (everOpened.current) triggerRef.current?.focus?.()
  }, [open])

  // Escape closes, but never mid-send — losing what they typed because
  // a key was brushed would be worse than making them wait.
  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape' && state !== 'sending') close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, state])

  function close() {
    setOpen(false)
    // Clear only after a successful send. If it failed, the text stays
    // so reopening doesn't mean retyping the whole thing.
    if (state === 'sent') {
      setMessage('')
      setState('idle')
    }
  }

  async function send(e) {
    e.preventDefault()
    if (state === 'sending') return
    const body = message.trim()
    if (body.length < MIN_CHARS) return
    setState('sending')
    setErr('')
    try {
      await api('/support/report', {
        method: 'POST',
        body: { message: body, page: window.location.pathname },
      })
      setState('sent')
    } catch (e2) {
      setState('error')
      setErr(e2?.body?.error || e2?.message || 'Could not send that. Please try again.')
    }
  }

  const chars = message.trim().length
  const tooShort = chars > 0 && chars < MIN_CHARS
  const canSend = chars >= MIN_CHARS && chars <= MAX_CHARS && state !== 'sending'

  return (
    <>
      {/* Sized and tinted to match AvatarMenu's circle, which sits
          immediately to its right in every header that carries it.
          Focus reveals the tooltip as well as hover, so a keyboard user
          gets the same affordance as a pointer. */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Report a problem"
        title="Report a problem"
        className="group support-launcher relative shrink-0 grid place-items-center
                   h-9 w-9 rounded-full
                   bg-white/12 ring-1 ring-inset ring-white/25 text-slate-200
                   hover:bg-white/20 hover:text-white
                   focus-visible:bg-white/20 focus-visible:text-white
                   transition-colors duration-200
                   focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2
                   focus-visible:outline-amber-300"
      >
        {/* Halo sits behind the mark, clipped by the button's own radius
            so it reads as the button breathing rather than a stray ring. */}
        {/* Stopping the pulse on hover is done in index.css, not here —
            see the .support-launcher rule. A keyframed opacity beats any
            utility, so it can't be expressed as a hover class. */}
        <span aria-hidden="true"
              className="pointer-events-none absolute inset-0 rounded-full
                         ring-1 ring-amber-300/70 support-halo
                         transition-opacity duration-200" />
        <HeadsetIcon />
        {/* Tooltip. aria-hidden because the button already carries the
            same string as its accessible name — a screen reader
            announcing it twice would be noise. */}
        <span aria-hidden="true"
              className="pointer-events-none absolute top-full right-0 mt-2 z-10
                         rounded-lg bg-ink-900 px-2.5 py-1.5 shadow-lg
                         ring-1 ring-inset ring-white/12
                         text-[11.5px] font-semibold text-white whitespace-nowrap
                         opacity-0 translate-y-1
                         transition-[opacity,transform] duration-200
                         ease-[cubic-bezier(0.22,1,0.36,1)]
                         group-hover:opacity-100 group-hover:translate-y-0
                         group-focus-visible:opacity-100 group-focus-visible:translate-y-0
                         motion-reduce:translate-y-0 motion-reduce:transition-none">
          Report a problem
        </span>
      </button>

      {open && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="report-problem-title"
        >
          <div
            aria-hidden="true"
            onClick={() => state !== 'sending' && close()}
            className="absolute inset-0 bg-slate-950/55 backdrop-blur-[2px]"
          />
          <div
            className="relative w-full sm:max-w-lg bg-white rounded-t-2xl sm:rounded-2xl
                       shadow-2xl overflow-hidden rise-in"
          >
            <div className="h-[3px] rule-gold" />

            {state === 'sent' ? (
              <Sent onClose={close} />
            ) : (
              <form onSubmit={send}>
                <div className="px-6 pt-5 pb-4 border-b border-slate-200/80 flex items-start justify-between gap-4">
                  <div>
                    <h2 id="report-problem-title"
                        className="font-display text-[17px] font-bold text-slate-900 tracking-[-0.015em]">
                      Report a problem
                    </h2>
                    <p className="mt-1 text-[13px] text-slate-500">
                      Tell us what went wrong and we'll look into it.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={close}
                    disabled={state === 'sending'}
                    aria-label="Close"
                    className="shrink-0 -mr-1 -mt-1 rounded-lg p-1.5 text-slate-400
                               hover:bg-slate-100 hover:text-slate-700 transition-colors
                               disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <CloseIcon />
                  </button>
                </div>

                <div className="px-6 py-5">
                  <label htmlFor="report-problem-text"
                         className="block text-[13px] font-semibold text-slate-700 mb-1.5">
                    What happened?
                  </label>
                  <textarea
                    id="report-problem-text"
                    ref={areaRef}
                    value={message}
                    onChange={(e) => setMessage(e.target.value.slice(0, MAX_CHARS))}
                    rows={5}
                    disabled={state === 'sending'}
                    placeholder="For example: the fingerprint scanner isn't detected on the verification screen since this morning."
                    // text-base below sm — iOS Safari zooms the viewport when
                    // an input under 16px takes focus and leaves it scaled.
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5
                               text-base sm:text-sm text-slate-900 placeholder-slate-400
                               shadow-xs resize-y
                               transition-[border-color,box-shadow] duration-150
                               hover:border-slate-400
                               focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-500/12
                               disabled:bg-slate-50 disabled:text-slate-500"
                  />
                  <div className="mt-1.5 flex items-center justify-between gap-3 min-h-[18px]">
                    <span className="text-[11.5px] text-rose-700">
                      {tooShort ? `A little more detail, please — ${MIN_CHARS - chars} more character${MIN_CHARS - chars === 1 ? '' : 's'}.` : ''}
                    </span>
                    <span className={`text-[11.5px] tabular-nums shrink-0 ${
                      chars > MAX_CHARS - 200 ? 'text-amber-700' : 'text-slate-400'}`}>
                      {chars}/{MAX_CHARS}
                    </span>
                  </div>

                  {state === 'error' && (
                    <div role="alert"
                         className="mt-4 rounded-lg bg-rose-50 border border-rose-200 px-3.5 py-2.5
                                    text-[13px] text-rose-800">
                      {err}
                    </div>
                  )}
                </div>

                <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex items-center justify-end gap-2.5">
                  <button
                    type="button"
                    onClick={close}
                    disabled={state === 'sending'}
                    className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-slate-700
                               border border-slate-300 shadow-xs hover:bg-slate-50
                               disabled:opacity-45 disabled:cursor-not-allowed transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={!canSend}
                    className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2
                               text-sm font-semibold text-white shadow-sm
                               hover:bg-brand-700 active:translate-y-px
                               disabled:opacity-45 disabled:cursor-not-allowed disabled:active:translate-y-0
                               transition-[background-color,transform] duration-150"
                  >
                    {state === 'sending' && <Spinner />}
                    {state === 'sending' ? 'Sending…' : 'Send report'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

function Sent({ onClose }) {
  return (
    <div className="px-6 py-9 text-center">
      <span className="mx-auto mb-4 grid h-11 w-11 place-items-center rounded-full
                       bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">
        <TickIcon />
      </span>
      <h2 className="font-display text-[17px] font-bold text-slate-900 tracking-[-0.015em]">
        Report sent
      </h2>
      <p className="mt-1.5 text-[13px] text-slate-500 max-w-sm mx-auto leading-relaxed">
        Thanks — it's with the support team along with your account and page details.
        They'll reply to the email address on your account.
      </p>
      <button
        type="button"
        onClick={onClose}
        className="mt-5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white
                   shadow-sm hover:bg-brand-700 transition-colors"
      >
        Close
      </button>
    </div>
  )
}

/* Inline SVG rather than an icon package — the product ships none, and
   three glyphs aren't worth a dependency. */
// A headset with its boom mic: the universally read mark for "there is
// a person on the other end of this". The boom is the half that carries
// the meaning — band and earcups alone are headphones, which say
// "listening", not "someone will answer".
//
// It draws in currentColor so it inherits the header's own slate-to-
// white, which keeps it in the navy chrome's palette instead of
// introducing a colour of its own.
//
// Band and earcups are one continuous path so the stroke joins cleanly
// at the corners at this size, where overlapping shapes would show a
// seam. The boom is the second path, sweeping down from the right cup
// and round to the mouth.
function HeadsetIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"
         className="relative support-nudge"
         stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 11h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H4a1 1 0 0 1-1-1v-6a9 9 0 0 1 18 0v6a1 1 0 0 1-1 1h-2a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3" />
      <path d="M21 16v2a4 4 0 0 1-4 4h-5" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"
         stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

function TickIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"
         stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12.6l4.4 4.4L19 7.4" />
    </svg>
  )
}

function Spinner() {
  return (
    <span aria-hidden="true"
          className="h-3.5 w-3.5 rounded-full border-2 border-white/35 border-t-white animate-spin" />
  )
}
