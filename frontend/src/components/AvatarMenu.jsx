import { useEffect, useRef, useState } from 'react'
import { Button } from './ui.jsx'

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
  const rootRef = useRef(null)

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
        className="h-9 w-9 rounded-full bg-indigo-600 text-white text-sm font-semibold
                   flex items-center justify-center
                   hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500
                   focus:ring-offset-2 transition"
      >
        {initial}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-72 origin-top-right rounded-xl bg-white
                     shadow-lg ring-1 ring-slate-200 z-50 overflow-hidden"
        >
          {/* Header: who's signed in */}
          <div className="px-4 py-3 border-b border-slate-100">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
              Signed in as
            </p>
            <p className="mt-1 text-sm font-semibold text-slate-900 break-words">
              {user?.display_name || user?.username || '—'}
            </p>
            <p className="text-xs text-slate-500 capitalize mt-0.5">
              {user?.role || 'unknown role'}
              {user?.username ? ` · ${user.username}` : ''}
            </p>
          </div>

          {/* Sign out */}
          <div className="px-3 py-3">
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
    </div>
  )
}
