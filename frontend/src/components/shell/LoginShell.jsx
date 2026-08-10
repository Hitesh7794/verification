import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../lib/auth.jsx'
import { Input, Label } from '../ui/ui.jsx'
import { Brand, PRODUCT_NAME } from '../ui/brand.jsx'
import { Icon } from '../ui/icons.jsx'

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
  violet: {
    chip:   'bg-violet-50 text-violet-700 border-violet-200',
    button: 'bg-violet-600 hover:bg-violet-700 focus:ring-violet-500',
  },
}

const ROLE_LABELS = {
  client:     'Operator portal',
  admin:      'Admin portal',
  superadmin: 'Superadmin portal',
  ops_admin:  'Operations portal',
}

export default function LoginShell({ expectedRole, expectedRoles, redirectTo, redirectByRole, accent = 'indigo', demo, rememberKey, showRegisterLink = false }) {
  const { login } = useAuth()
  const nav = useNavigate()
  const [params] = useSearchParams()
  // rememberKey enables pre-filling the username field from
  // localStorage on subsequent visits. Operator portals use it
  // (operators type the org-shared username 100x a shift). Admin
  // and superadmin pages omit it — those logins are rare enough
  // that auto-fill is more annoying than helpful.
  const [username, setUsername] = useState(() => {
    if (!rememberKey || typeof window === 'undefined') return ''
    try { return localStorage.getItem(rememberKey) || '' } catch { return '' }
  })
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const a = ACCENTS[accent] || ACCENTS.indigo

  // /admin/login?session_expired=1 is set by api.js when a 401 forces
  // the user back to login. Show a clear hint so they understand why
  // they got bounced rather than seeing a blank login form.
  const sessionExpired = params.get('session_expired') === '1'
  const justActivated = params.get('just_activated') === '1'

  // expectedRole (single string) is the legacy API; expectedRoles
  // (array) lets one login screen accept multiple roles — used by the
  // ops mode build where admin AND ops_admin can both sign in here.
  const allowedRoles = expectedRoles || (expectedRole ? [expectedRole] : [])
  const roleLabel = ROLE_LABELS[allowedRoles[0]] || 'Sign in'

  async function onSubmit(e) {
    e.preventDefault()
    setErr('')
    setBusy(true)
    try {
      const u = await login(username, password)
      if (allowedRoles.length && !allowedRoles.includes(u.role)) {
        setErr(`This account is a ${u.role}. Use the ${allowedRoles.join(' or ')} portal.`)
        return
      }
      // Persist the username (NOT the password) for next visit so a
      // recurring operator doesn't retype it every shift. Scoped per
      // portal via rememberKey so logins on different portals don't
      // clobber each other.
      if (rememberKey) {
        try { localStorage.setItem(rememberKey, username) } catch {}
      }
      // redirectByRole: { admin: '/admin', ops_admin: '/superadmin/applications' }
      // lets a single login screen route different roles to different pages.
      const dest = redirectByRole?.[u.role] || redirectTo || '/'
      nav(dest)
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
        <div className="flex justify-center mb-6">
          <Brand />
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

          {sessionExpired && !err && (
            <div role="status"
                 className="mb-4 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
              Your session ended. Sign in again to continue.
            </div>
          )}
          {justActivated && !err && (
            <div role="status"
                 className="mb-4 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-800">
              Password set successfully. Sign in to continue.
            </div>
          )}

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
              <div className="relative">
                <Input
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  className="absolute inset-y-0 right-0 px-3 flex items-center text-slate-400 hover:text-slate-700 transition-colors"
                  aria-label={showPw ? 'Hide password' : 'Show password'}
                  tabIndex={-1}
                >
                  <Icon.Eye className="h-4 w-4" />
                </button>
              </div>
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

        </div>

        {showRegisterLink && (
          <div className="mt-4 rounded-xl bg-white shadow-sm ring-1 ring-slate-200 p-5">
            <p className="text-sm font-medium text-slate-900">New institution?</p>
            <p className="mt-1 text-xs text-slate-500">
              Register your institution and our team will activate your account within 48 hours.
            </p>
            <a
              href="/register/institution"
              className="mt-3 inline-flex items-center justify-center rounded-lg
                         bg-slate-900 hover:bg-slate-800 text-white text-sm font-medium
                         px-4 py-2 shadow-sm transition"
            >
              Register your institution →
            </a>
          </div>
        )}

        <p className="mt-6 text-center text-[11px] text-slate-400">
          © {new Date().getFullYear()} {PRODUCT_NAME}
        </p>
      </div>
    </div>
  )
}
