import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth.jsx'
import { api } from '../lib/api.js'
import { Input, Label } from '../components/ui/ui.jsx'
import { Brand } from '../components/ui/brand.jsx'
import { Icon } from '../components/ui/icons.jsx'

// Forced password rotation screen — shown when the backend flags
// password_change_required=true on /api/auth/login or /api/me. Today
// the only accounts that hit this are the seeded super / ops users
// (defaults are public knowledge). The user cannot navigate away
// without changing their password; sign-out is the only escape.
//
// We deliberately don't use AppShell here — the AppShell's navbar
// has links that would feel like an escape hatch. A focused single-
// card layout makes the path forward unambiguous.

export default function ForcePasswordChange() {
  const { user, logout } = useAuth()
  const nav = useNavigate()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showCurrent, setShowCurrent] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // Per-rule checks so the user can see exactly which requirement is
  // unmet — "Save" stays disabled until all four turn green, and
  // the live indicators tell them which one is still red.
  const checks = {
    length: next.length >= 10,
    letter: /[A-Za-z]/.test(next),
    digit:  /[0-9]/.test(next),
    match:  next.length > 0 && next === confirm,
  }
  const strong = checks.length && checks.letter && checks.digit
  const matches = checks.match

  // If the user isn't actually flagged — or isn't logged in — bounce
  // home so this screen can never be deep-linked into.
  if (!user) return <Navigate to="/" replace />
  if (!user.password_change_required) return <Navigate to="/" replace />

  async function submit(e) {
    e.preventDefault()
    setErr('')
    if (!strong) {
      setErr('Password must be at least 10 characters with one letter and one digit.')
      return
    }
    if (!matches) {
      setErr('Passwords do not match.')
      return
    }
    setBusy(true)
    try {
      await api('/me/change-password', {
        method: 'POST',
        body: { current_password: current, new_password: next },
      })
      // After a successful change, log out so the next sign-in pulls
      // a fresh /api/me (with password_change_required=false) and
      // routes the user into their actual dashboard. Simpler and
      // more reliable than mutating the cached user object in place.
      logout()
      nav(`/${user.role === 'ops_admin' ? 'admin' : user.role}/login?just_activated=1`)
    } catch (e) {
      setErr(e.message || 'failed to update password')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="flex justify-center mb-6">
          <Brand />
        </div>
        <div className="rounded-xl bg-white shadow-sm ring-1 ring-slate-200 p-7">
          <h1 className="text-lg font-semibold text-slate-900">Set a new password</h1>
          <p className="mt-2 text-sm text-slate-600">
            Hi <span className="font-medium text-slate-900">{user.display_name || user.username}</span>.
            Your account is using the default password that ships with the platform. For security,
            please choose a new password before continuing.
          </p>

          <form onSubmit={submit} className="mt-5 space-y-4">
            <div>
              <Label>Current password</Label>
              <div className="relative">
                <Input
                  type={showCurrent ? 'text' : 'password'}
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                  autoFocus
                  required
                  disabled={busy}
                  autoComplete="current-password"
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowCurrent((v) => !v)}
                  className="absolute inset-y-0 right-0 px-3 flex items-center text-slate-400 hover:text-slate-700 transition-colors"
                  aria-label={showCurrent ? 'Hide password' : 'Show password'}
                  tabIndex={-1}
                >
                  <Icon.Eye className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div>
              <Label>New password</Label>
              {/* Single show/hide controls both new + confirm so the user
                  doesn't get a visible/masked mismatch between them. */}
              <div className="relative">
                <Input
                  type={showNew ? 'text' : 'password'}
                  value={next}
                  onChange={(e) => setNext(e.target.value)}
                  required
                  disabled={busy}
                  autoComplete="new-password"
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowNew((v) => !v)}
                  className="absolute inset-y-0 right-0 px-3 flex items-center text-slate-400 hover:text-slate-700 transition-colors"
                  aria-label={showNew ? 'Hide password' : 'Show password'}
                  tabIndex={-1}
                >
                  <Icon.Eye className="h-4 w-4" />
                </button>
              </div>
              {/* Per-rule live feedback so a stuck Save button is never
                  a mystery — the unmet check is highlighted in red. */}
              <ul className="mt-2 text-xs space-y-0.5">
                <RuleItem ok={checks.length} text="At least 10 characters" />
                <RuleItem ok={checks.letter} text="Includes a letter" />
                <RuleItem ok={checks.digit}  text="Includes a digit" />
              </ul>
            </div>
            <div>
              <Label>Confirm new password</Label>
              <Input
                type={showNew ? 'text' : 'password'}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                disabled={busy}
                autoComplete="new-password"
              />
              {confirm.length > 0 ? (
                <p className={`mt-1 text-xs ${matches ? 'text-emerald-700' : 'text-rose-600'}`}>
                  {matches ? '✓ Passwords match' : "Doesn't match the new password."}
                </p>
              ) : (
                <p className="mt-1 text-xs text-slate-500">Re-type the new password to confirm.</p>
              )}
            </div>

            {err && (
              <div role="alert"
                   className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
                {err}
              </div>
            )}

            <div className="flex items-center justify-between gap-2 pt-1">
              <button
                type="button"
                onClick={() => { logout(); nav('/') }}
                disabled={busy}
                className="text-sm text-slate-500 hover:text-slate-800"
              >
                Sign out instead
              </button>
              <button
                type="submit"
                disabled={busy || !strong || !matches}
                className="inline-flex items-center justify-center rounded-lg
                           bg-indigo-600 hover:bg-indigo-700 text-white font-medium
                           px-4 py-2.5 text-sm shadow-sm disabled:opacity-60"
              >
                {busy ? 'Saving…' : 'Save and continue'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}

// One-line rule indicator with a tick on the left. Green when met,
// muted-grey when not — same visual language as the change-password
// modal so the two flows feel consistent.
function RuleItem({ ok, text }) {
  return (
    <li className={ok ? 'text-emerald-700' : 'text-slate-500'}>
      <span className="inline-block w-3">{ok ? '✓' : '•'}</span>
      <span className="ml-1">{text}</span>
    </li>
  )
}
