import { useEffect, useRef } from 'react'

// SignOutConfirm — small confirmation dialog before an actual logout.
//
// Every shell that has a Sign out button (AdminShell, AppShell,
// ReviewerShell, SuperTabs, AvatarMenu) mounts one of these and calls
// `open` on click instead of calling logout() directly. Cancel returns
// to the shell; Confirm fires the caller's real onLogout handler.
//
// Deliberately not a portal — a fixed overlay + a centered card is
// enough. Traps focus on the primary action and honours Escape /
// backdrop click as "Cancel", so a mis-click never signs anyone out.

export default function SignOutConfirm({ open, onCancel, onConfirm }) {
  const confirmRef = useRef(null)

  // Wire Escape to cancel + auto-focus the primary action once the
  // dialog appears. `open` gating keeps the effect a no-op when we're
  // not showing anything, so tab order in the rest of the page stays
  // untouched.
  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel?.() }
    }
    document.addEventListener('keydown', onKey)
    const t = setTimeout(() => confirmRef.current?.focus(), 20)
    // Prevent background scroll while the dialog is open. Same-page
    // logout dialogs feel like a modal decision — locking scroll
    // clarifies that.
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      clearTimeout(t)
      document.body.style.overflow = prevOverflow
    }
  }, [open, onCancel])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="signout-title"
      className="fixed inset-0 z-[70] flex items-center justify-center p-4"
    >
      {/* Backdrop — click to cancel. Fades in with the dialog card. */}
      <div
        aria-hidden="true"
        onClick={onCancel}
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px] animate-[fade-in_140ms_ease-out]"
      />

      <div
        className="
          relative w-full max-w-sm rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200/70 overflow-hidden
          animate-[dialog-in_180ms_cubic-bezier(0.22,1,0.36,1)]
        "
      >
        <div className="h-[3px] rule-gold" />
        <div className="p-5 sm:p-6">
          <div className="flex items-start gap-3">
            {/* Icon tile — subtle rose-tint so the action reads as a
                real decision without shouting alarm. */}
            <div
              aria-hidden="true"
              className="h-11 w-11 shrink-0 rounded-xl bg-rose-50 text-rose-600 flex items-center justify-center"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <h2 id="signout-title" className="text-[15px] font-semibold text-slate-900">
                Sign out?
              </h2>
              <p className="mt-1 text-[13px] text-slate-500">
                You&rsquo;ll need to sign in again to continue where you
                left off.
              </p>
            </div>
          </div>

          <div className="mt-5 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="
                inline-flex items-center rounded-lg
                bg-white text-slate-700 text-[13px] font-semibold
                border border-slate-200 px-3.5 py-2
                transition-[background-color,border-color,transform] duration-150
                hover:bg-slate-50 hover:border-slate-300 active:translate-y-px
                focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400
              "
            >
              Cancel
            </button>
            <button
              ref={confirmRef}
              type="button"
              onClick={onConfirm}
              className="
                inline-flex items-center gap-1.5 rounded-lg
                bg-rose-600 text-white text-[13px] font-semibold
                px-3.5 py-2 shadow-sm
                transition-[background-color,box-shadow,transform] duration-150
                hover:bg-rose-700 hover:shadow-md active:translate-y-px
                focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-500
              "
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
              Sign out
            </button>
          </div>
        </div>
      </div>

      {/* Keyframes for the two entry animations. Scoped globally
          (index.css) would work too, but co-locating here keeps this
          component self-contained. */}
      <style>{`
        @keyframes fade-in    { from { opacity: 0 } to { opacity: 1 } }
        @keyframes dialog-in  {
          from { opacity: 0; transform: translateY(6px) scale(0.98); }
          to   { opacity: 1; transform: translateY(0)   scale(1);    }
        }
      `}</style>
    </div>
  )
}
