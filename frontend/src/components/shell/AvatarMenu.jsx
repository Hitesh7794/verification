import { useEffect, useRef, useState } from 'react'
import { Button } from '../ui/ui.jsx'
import ChangePasswordModal from './ChangePasswordModal.jsx'

// AvatarMenu — a circular initial-badge in the navbar that opens a
// dropdown with the operator's details + a sign-out button.
//
// Behaviour:
//   • Click the circle           → open / close dropdown
//   • Click anywhere outside     → close
//   • Press Escape               → close
//   • Tab navigation             → focus inside the menu when open
//
// Why this replaces the inline name + role + sign-out block:
//   • The previous design dumped the full center name into the navbar,
//     which on rolls with a 60-char center looked like a runaway label.
//     Collapsing the metadata behind an avatar keeps the header tight
//     regardless of how long the operator's center name is.

export default function AvatarMenu({ user, onLogout }) {
  const [open, setOpen] = useState(false)
  const [showChangePw, setShowChangePw] = useState(false)
  const [changedOk, setChangedOk] = useState(false)
  const rootRef = useRef(null)

  // Auto-dismiss the success banner after 4s so the dropdown returns
  // to its normal state without an extra click.
  useEffect(() => {
    if (!changedOk) return
    const t = setTimeout(() => setChangedOk(false), 4000)
    return () => clearTimeout(t)
  }, [changedOk])

  // Initial letter for the circle. Prefer the username (always short)
  // over display_name (which can be the full center name + "Operator").
  // Fall back to "?" if neither is available — defensive against
  // pre-login renders.
  const initial = (user?.username || user?.display_name || '?')
    .trim()
    .charAt(0)
    .toUpperCase()

  // Close-on-outside-click + close-on-Escape. One useEffect handles both.
  useEffect(() => {
    if (!open) return
    function onDocClick(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    function onKey(e) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        onClick={() => setOpen((v) => !v)}
        className="h-9 w-9 rounded-full bg-white/12 ring-1 ring-inset ring-white/25
                   text-white text-sm font-bold flex items-center justify-center
                   hover:bg-white/20 transition-colors
                   focus-visible:outline-2 focus-visible:outline-offset-2
                   focus-visible:outline-amber-300"
      >
        {initial}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-72 origin-top-right rounded-xl bg-white
                     shadow-lg ring-1 ring-slate-200 z-50 overflow-hidden
                     animate-surface-in"
        >
          {/* Header: who's signed in */}
          <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
            <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-500">
              Signed in as
            </p>
            <p className="mt-1 font-display text-sm font-bold text-slate-900 break-words">
              {user?.display_name || user?.username || '—'}
            </p>
            <p className="text-xs text-slate-500 capitalize mt-0.5">
              {user?.role || 'unknown role'}
              {user?.username ? ` · ${user.username}` : ''}
            </p>
          </div>

          {changedOk && (
            <div className="mx-3 mt-3 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-xs text-emerald-800">
              Password updated. Use the new one next time you sign in.
            </div>
          )}

          {/* Actions */}
          <div className="px-3 py-3 space-y-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setOpen(false)
                setChangedOk(false)
                setShowChangePw(true)
              }}
              className="w-full justify-center"
            >
              Change password
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setOpen(false)
                onLogout?.()
              }}
              className="w-full justify-center"
            >
              Sign out
            </Button>
          </div>
        </div>
      )}

      {showChangePw && (
        <ChangePasswordModal
          onClose={() => setShowChangePw(false)}
          onSuccess={() => {
            // Banner shows briefly in-place. No menu re-opening
            // dance — that flashed badly on slow renders. The
            // banner auto-dismisses after 4s via the useEffect
            // above so the dropdown returns to its quiet state.
            setChangedOk(true)
            setOpen(true)
          }}
        />
      )}
    </div>
  )
}
