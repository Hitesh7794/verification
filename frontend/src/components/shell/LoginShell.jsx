import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useAuth } from '../../lib/auth.jsx'
import { requestForgotPassword } from '../../lib/onboarding/register.js'
import { Input, Label } from '../ui/ui.jsx'
import { PRODUCT_NAME } from '../ui/brand.jsx'
import { Icon } from '../ui/icons.jsx'

// LoginShell — single centered card on a soft warm ground.
//
// Layout: logo mark + wordmark above the card, amber role eyebrow +
// "Sign in" title inside, two fields, ink-black submit. Optional
// register link (admin login only) sits below the card. Includes
// integrated "Forgot password?" reset link dispatch.

const ROLE_LABEL = {
  client:          'Verification Agent',
  admin:           'Administrator',
  superadmin:      'Superadmin',
  ops_admin:       'Operations',
  client_reviewer: 'Review portal',
}

export default function LoginShell({
  expectedRole,
  expectedRoles,
  redirectTo,
  redirectByRole,
  rememberKey,
  showRegisterLink = false,
}) {
  const { login } = useAuth()
  const nav = useNavigate()
  const [params] = useSearchParams()

  const [view, setView] = useState('login') // 'login' | 'forgot'
  const [username, setUsername] = useState(() => {
    if (!rememberKey || typeof window === 'undefined') return ''
    try { return localStorage.getItem(rememberKey) || '' } catch { return '' }
  })
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  // Forgot password state
  const [forgotInput, setForgotInput] = useState('')
  const [forgotSent, setForgotSent] = useState(false)
  const [forgotErr, setForgotErr] = useState('')
  const [forgotBusy, setForgotBusy] = useState(false)

  const sessionExpired = params.get('session_expired') === '1'
  const justActivated  = params.get('just_activated')  === '1'
  const passwordReset  = params.get('password_reset')  === '1'
  const portalDisabled = params.get('portal_disabled') === '1'

  const allowedRoles = expectedRoles || (expectedRole ? [expectedRole] : [])
  const roleLabel = ROLE_LABEL[allowedRoles[0]] || 'Portal'

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
      if (rememberKey) {
        try { localStorage.setItem(rememberKey, username) } catch {}
      }
      const dest = redirectByRole?.[u.role] || redirectTo || '/'
      nav(dest)
    } catch (e) {
      setErr(e.message || 'Login failed')
    } finally {
      setBusy(false)
    }
  }

  async function onForgotSubmit(e) {
    e.preventDefault()
    setForgotErr('')
    setForgotBusy(true)
    try {
      await requestForgotPassword(forgotInput, allowedRoles[0] || '')
      setForgotSent(true)
    } catch (err) {
      setForgotErr(err.message || 'Failed to dispatch reset request')
    } finally {
      setForgotBusy(false)
    }
  }

  return (
    <div className="relative min-h-screen bg-warm-page flex items-center justify-center p-4 overflow-hidden">
      {/* Ambient warm gradient washes */}
      <div className="absolute -top-40 -left-20 h-96 w-96 rounded-full bg-amber-100/40 blur-3xl pointer-events-none" />
      <div className="absolute -bottom-32 -right-20 h-96 w-96 rounded-full bg-[#F5EEDF]/60 blur-3xl pointer-events-none" />

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="relative w-full max-w-md"
      >
        {/* Wordmark above the card */}
        <div className="text-center mb-6">
          <span className="text-xl font-bold text-stone-900 tracking-tight">
            {PRODUCT_NAME}
          </span>
        </div>

        {/* Card */}
        <div className="rounded-2xl bg-warm-surface ring-1 ring-warm shadow-lg shadow-stone-900/[0.04] p-8">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-warm-accent mb-2">
            {roleLabel}
          </p>

          {view === 'login' ? (
            <>
              <h1 className="text-2xl font-semibold text-ink-900 tracking-tight">
                Sign in
              </h1>
              <p className="mt-1 text-sm text-stone-500">
                Enter your credentials to continue.
              </p>

              {portalDisabled && !err && (
                <div role="status"
                     className="mt-5 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-800">
                  This board's review portal has been disabled by the platform team.
                  You've been signed out. Please contact them if you believe this is
                  a mistake.
                </div>
              )}
              {sessionExpired && !err && !portalDisabled && (
                <div role="status"
                     className="mt-5 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
                  Your session ended. Sign in again.
                </div>
              )}
              {justActivated && !err && (
                <div role="status"
                     className="mt-5 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-xs text-emerald-800">
                  Password set. Sign in to continue.
                </div>
              )}
              {passwordReset && !err && (
                <div role="status"
                     className="mt-5 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-xs text-emerald-800">
                  Password successfully reset. Sign in with your new password.
                </div>
              )}

              <form onSubmit={onSubmit} className="mt-6 space-y-4" autoComplete="on">
                <div>
                  <Label>
                    {allowedRoles.includes('superadmin') ? 'Username' : 'Username or email'}
                  </Label>
                  <Input
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="username"
                    autoFocus
                    required
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between">
                    <Label>Password</Label>
                    <button
                      type="button"
                      onClick={() => {
                        setView('forgot')
                        setForgotInput(username)
                        setForgotErr('')
                        setForgotSent(false)
                      }}
                      className="text-xs font-medium text-amber-800 hover:text-amber-900 hover:underline"
                    >
                      Forgot password?
                    </button>
                  </div>
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
                      className="absolute inset-y-0 right-0 px-3 flex items-center text-stone-400 hover:text-stone-700 transition-colors"
                      aria-label={showPw ? 'Hide password' : 'Show password'}
                      tabIndex={-1}
                    >
                      <Icon.Eye className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {err && (
                  <div role="alert"
                       className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-700">
                    {err}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={busy}
                  className="w-full inline-flex items-center justify-center rounded-lg
                             bg-stone-900 hover:bg-stone-800 text-white font-medium
                             px-4 py-2.5 text-sm shadow-sm transition-colors
                             focus:outline-none focus:ring-2 focus:ring-stone-700 focus:ring-offset-1
                             disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {busy ? 'Signing in…' : 'Sign in'}
                </button>
              </form>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-semibold text-ink-900 tracking-tight">
                Reset password
              </h1>
              <p className="mt-1 text-sm text-stone-500">
                Enter your registered email address or username to receive a secure reset link.
              </p>

              {forgotSent ? (
                <div className="mt-6 space-y-5">
                  <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-4 text-xs text-emerald-800 flex items-start gap-3">
                    <Icon.CheckCircle className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-semibold text-emerald-900 text-sm">Reset link dispatched</p>
                      <p className="mt-1 leading-relaxed text-emerald-800">
                        If an account matching <span className="font-mono font-semibold">{forgotInput}</span> exists, we’ve sent instructions to reset your password. Please check your inbox.
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setView('login')
                      setForgotSent(false)
                    }}
                    className="w-full inline-flex items-center justify-center rounded-lg
                               bg-stone-900 hover:bg-stone-800 text-white font-medium
                               px-4 py-2.5 text-sm shadow-sm transition-colors"
                  >
                    Return to sign in
                  </button>
                </div>
              ) : (
                <form onSubmit={onForgotSubmit} className="mt-6 space-y-4">
                  <div>
                    <Label>Registered email or username</Label>
                    <Input
                      type="text"
                      value={forgotInput}
                      onChange={(e) => setForgotInput(e.target.value)}
                      placeholder="e.g. admin@university.edu or username"
                      autoFocus
                      required
                    />
                  </div>

                  {forgotErr && (
                    <div role="alert" className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-700">
                      {forgotErr}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={forgotBusy}
                    className="w-full inline-flex items-center justify-center rounded-lg
                               bg-stone-900 hover:bg-stone-800 text-white font-medium
                               px-4 py-2.5 text-sm shadow-sm transition-colors
                               focus:outline-none focus:ring-2 focus:ring-stone-700 focus:ring-offset-1
                               disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {forgotBusy ? 'Sending reset link…' : 'Send reset link'}
                  </button>

                  <div className="text-center pt-2">
                    <button
                      type="button"
                      onClick={() => setView('login')}
                      className="text-xs font-medium text-stone-500 hover:text-stone-800 hover:underline"
                    >
                      ← Back to sign in
                    </button>
                  </div>
                </form>
              )}
            </>
          )}
        </div>

        {showRegisterLink && view === 'login' && (
          <p className="mt-5 text-center text-xs text-stone-500">
            Not yet onboarded?{' '}
            <a href="/register/institution" className="font-semibold text-warm-accent hover:underline">
              Register your institution →
            </a>
          </p>
        )}
      </motion.div>
    </div>
  )
}
