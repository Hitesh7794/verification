import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth.jsx'
import { Input, Label } from './ui.jsx'

// LoginShell — single centered card on a neutral background. Same shape
// every real-world product auth screen uses (Stripe, GitHub, Linear) —
// the page job is to authenticate, not to market. The role chip is the
// only place the per-portal accent shows; everything else stays neutral.
//
// The `portalTitle` / `portalSubtitle` props are still accepted by the
// three Login pages but are no longer rendered as giant copy.

// Per-role accent — used only on the role chip + primary button. Kept
// muted so the page reads as "tool" not "advertisement".
const ACCENTS = {
  indigo: {
    chip:   'bg-indigo-50 text-indigo-700 border-indigo-200',
    button: 'bg-indigo-600 hover:bg-indigo-700 focus:ring-indigo-500',
  },
  emerald: {
    chip:   'bg-emerald-50 text-emerald-700 border-emerald-200',
    button: 'bg-emerald-600 hover:bg-emerald-700 focus:ring-emerald-500',
  },
  slate: {
    chip:   'bg-slate-100 text-slate-700 border-slate-300',
    button: 'bg-slate-800 hover:bg-slate-900 focus:ring-slate-500',
  },
}

const ROLE_LABELS = {
  client:     'Operator portal',
  admin:      'Admin portal',
  superadmin: 'Superadmin portal',
}

export default function LoginShell({ expectedRole, redirectTo, accent = 'indigo', demo }) {
  const { login } = useAuth()
  const nav = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const a = ACCENTS[accent] || ACCENTS.indigo
  const roleLabel = ROLE_LABELS[expectedRole] || 'Sign in'

  async function onSubmit(e) {
    e.preventDefault()
    setErr('')
    setBusy(true)
    try {
      const u = await login(username, password)
      if (u.role !== expectedRole) {
        setErr(`This account is a ${u.role}. Use the ${expectedRole} portal.`)
        return
      }
      nav(redirectTo)
    } catch (e) {
      setErr(e.message || 'Login failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Brand sits above the card, not inside — keeps the card pure
            form so the eye lands on Username first. */}
        <div className="flex items-center justify-center gap-2 mb-6 text-slate-700">
          <div className="h-8 w-8 rounded-md bg-slate-900 text-white flex items-center justify-center text-xs font-bold">
            NV
          </div>
          <span className="text-sm font-medium">NEET Verification</span>
        </div>

        {/* Card */}
        <div className="rounded-xl bg-white shadow-sm ring-1 ring-slate-200 p-7">
          <div className="flex items-center justify-between mb-5">
            <h1 className="text-lg font-semibold text-slate-900">Sign in</h1>
            <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5
                              text-xs font-medium ${a.chip}`}>
              {roleLabel}
            </span>
          </div>

          <form onSubmit={onSubmit} className="space-y-4" autoComplete="on">
            <div>
              <Label>Username</Label>
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
                required
              />
            </div>
            <div>
              <Label>Password</Label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>

            {err && (
              <div role="alert"
                   className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
                {err}
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className={`w-full inline-flex items-center justify-center rounded-lg
                          text-white font-medium px-4 py-2.5 text-sm shadow-sm
                          transition focus:outline-none focus:ring-2 focus:ring-offset-1
                          disabled:opacity-60 disabled:cursor-not-allowed ${a.button}`}
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          {demo && (
            <div className="mt-6 pt-5 border-t border-slate-100">
              <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
                Demo credentials
              </p>
              <code className="mt-1 block font-mono text-xs text-slate-600">{demo}</code>
            </div>
          )}
        </div>

        <p className="mt-6 text-center text-[11px] text-slate-400">
          © {new Date().getFullYear()} NEET Verification Portal
        </p>
      </div>
    </div>
  )
}
