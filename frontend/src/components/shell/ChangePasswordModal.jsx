import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, Input, Label } from '../ui/ui.jsx'
import { api } from '../../lib/api.js'

// ChangePasswordModal — invoked from AvatarMenu, lets any logged-in
// user (admin, superadmin, operator) rotate their own
// password. Same validation rules as the magic-link set-password flow
// (≥10 chars, letter + digit) — the strength floor is consistent
// across the product so we never have an "easier" path that weakens
// the bar.
//
// Backend wiring: POST /api/me/change-password
//                 { current_password, new_password }
//
// Same portal pattern as DepositModal — render via createPortal so
// the modal escapes the AppShell header's backdrop-blur containing
// block; without that, fixed positioning is computed against the
// blurred navbar and the modal renders clipped.

export default function ChangePasswordModal({ onClose, onSuccess }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showCurrent, setShowCurrent] = useState(false)
  const [showNext, setShowNext] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // Lightweight client-side strength signal so the user knows whether
  // they'll pass server-side validation before they click Save. The
  // real source of truth is the backend; this is purely a UX hint.
  const strong =
    next.length >= 10 &&
    /[A-Za-z]/.test(next) &&
    /[0-9]/.test(next)
  const matches = next.length > 0 && next === confirm

  async function submit(e) {
    e.preventDefault()
    setErr('')
    if (!strong) {
      setErr('New password must be at least 10 characters with one letter and one digit.')
      return
    }
    if (!matches) {
      setErr('New password and confirmation do not match.')
      return
    }
    setBusy(true)
    try {
      await api('/me/change-password', {
        method: 'POST',
        body: { current_password: current, new_password: next },
      })
      onSuccess?.()
      onClose()
    } catch (e) {
      setErr(e.message || 'failed to change password')
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 overflow-y-auto py-6"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl max-w-md w-full mx-4 p-5 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-3">
          <h3 className="text-base font-semibold text-slate-900">Change password</h3>
          <button
            type="button"
            className="text-slate-400 hover:text-slate-600 text-xl leading-none"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <p className="text-sm text-slate-500 mb-4">
          Enter your current password and pick a new one. Other devices stay signed in until their session expires.
        </p>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <Label>Current password</Label>
            <div className="mt-1 flex items-center gap-2">
              <Input
                type={showCurrent ? 'text' : 'password'}
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                autoFocus
                required
                disabled={busy}
              />
              <button
                type="button"
                className="px-3 py-2 rounded-md border border-slate-300 bg-white text-sm text-slate-700 hover:bg-slate-50"
                onClick={() => setShowCurrent((v) => !v)}
              >
                {showCurrent ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>

          <div>
            <Label>New password</Label>
            <div className="mt-1 flex items-center gap-2">
              <Input
                type={showNext ? 'text' : 'password'}
                value={next}
                onChange={(e) => setNext(e.target.value)}
                required
                disabled={busy}
              />
              <button
                type="button"
                className="px-3 py-2 rounded-md border border-slate-300 bg-white text-sm text-slate-700 hover:bg-slate-50"
                onClick={() => setShowNext((v) => !v)}
              >
                {showNext ? 'Hide' : 'Show'}
              </button>
            </div>
            <p className={`mt-1 text-xs ${strong ? 'text-emerald-700' : 'text-slate-500'}`}>
              {strong ? '✓ Meets minimum requirements' : 'At least 10 characters, with one letter and one digit.'}
            </p>
          </div>

          <div>
            <Label>Confirm new password</Label>
            <Input
              type={showNext ? 'text' : 'password'}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              disabled={busy}
            />
            {confirm.length > 0 && !matches && (
              <p className="mt-1 text-xs text-rose-600">Doesn't match the new password.</p>
            )}
          </div>

          {err && (
            <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
              {err}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !strong || !matches}>
              {busy ? 'Saving…' : 'Save new password'}
            </Button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
}
