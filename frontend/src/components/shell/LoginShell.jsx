import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useAuth } from '../../lib/auth.jsx'
import { requestForgotPassword } from '../../lib/onboarding/register.js'
import { Input, Label } from '../ui/ui.jsx'
import { PRODUCT_NAME, BrandMark } from '../ui/brand.jsx'
import { BiometricStrip } from '../ui/biometrics.jsx'
import { Icon } from '../ui/icons.jsx'

// LoginShell — a two-panel sign-in.
//
// Left (>=lg only): a navy brand panel stating what the product does.
// Sign-in is the one screen every stakeholder sees, so it carries the
// positioning rather than dropping straight into a form.
// Right: the card — gold role eyebrow, "Sign in" title, two fields,
// azure submit. Optional register link (admin login only) sits below.
// Includes integrated "Forgot password?" reset link dispatch.
//
// The panel is hidden below lg, where the card centres on its own — an
// operator signing in on a centre tablet gets the form and nothing else.

const ROLE_LABEL = {
  client:          'Verification Agent',
  admin:           'Administrator',
  superadmin:      'Superadmin',
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
      // Session-alive marker: set in sessionStorage the moment login
      // succeeds. Any per-role in-flight state (Dashboard's
      // nv_verify_state_v1, etc.) is gated on this marker being
      // present, so if a browser session-restore drops the operator
      // into the app WITHOUT going through this login handler, the
      // stale mid-flow state gets cleared instead of resumed.
      // Refresh preserves sessionStorage → marker + state both stay,
      // so mid-flow still survives a legitimate F5.
      try { sessionStorage.setItem('nv_session_alive_' + u.role, '1') } catch {}
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
    <div className="min-h-screen grid lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      {/* ── Brand panel — lg and up ───────────────────────────────── */}
      <aside className="relative hidden lg:flex flex-col justify-between bg-ink-chrome p-12 xl:p-16 overflow-hidden">
        <div
          className="absolute -inset-y-16 inset-x-0 bg-dot-grid opacity-[0.13] pointer-events-none"
          style={{ animation: 'bio-drift 24s ease-in-out infinite' }}
        />

        <div className="relative flex items-center gap-3">
          <BrandMark size={34} tone="inverse" />
          <span className="font-display text-lg font-extrabold text-white tracking-[-0.025em]">
            {PRODUCT_NAME}
          </span>
        </div>

        <div className="relative max-w-lg">
          <h2 className="font-display text-[40px] xl:text-[46px] font-extrabold leading-[1.08] tracking-[-0.035em] text-white text-balance">
            Identity, verified at admission.
          </h2>
          <p className="mt-5 text-[15px] leading-relaxed text-slate-300">
            Biometric verification at admission and joining, matched
            against the identity captured when the candidate sat the
            exam.
          </p>

          {/* The three capture modalities, animating. Shown rather than
              described — it is what the product does, and it is the
              first thing a visiting stakeholder should understand. */}
          <BiometricStrip className="mt-8" />

          <ul className="mt-7 space-y-3.5">
            {[
              ['Face, fingerprint and iris', 'Matched against the exam enrolment. Modalities set per exam.'],
              ['Liveness-checked', 'A printed photograph does not pass the gate.'],
              ['Fully auditable', 'Match scores, device and operator on every record.'],
            ].map(([head, sub]) => (
              <li key={head} className="flex gap-3.5">
                <span
                  aria-hidden="true"
                  className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-amber-300"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-white">{head}</span>
                  <span className="block text-[13px] text-slate-400 mt-0.5">{sub}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-[11px] text-slate-500">
          Authorised access only. All sign-in attempts are logged.
        </p>
      </aside>

      {/* ── Sign-in panel ─────────────────────────────────────────── */}
      <div className="relative flex items-center justify-center bg-slate-50 p-6 sm:p-10">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className="relative w-full max-w-[400px]"
        >
          {/* Wordmark — carries the mark on small screens, where the
              brand panel above is hidden. */}
          <div className="flex items-center justify-center gap-2.5 mb-7 lg:hidden">
            <BrandMark size={28} />
            <span className="font-display text-lg font-extrabold text-slate-900 tracking-[-0.025em]">
              {PRODUCT_NAME}
            </span>
          </div>

        {/* Card */}
        <div className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-lg p-8">
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-600 mb-2">
            {roleLabel}
          </p>

          {view === 'login' ? (
            <>
              <h1 className="font-display text-[26px] font-extrabold text-slate-900 tracking-[-0.03em]">
                Sign in
              </h1>
              <p className="mt-1 text-sm text-slate-500">
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
                      // Drop out of the tab sequence so Tab from
                      // Username lands on Password, not this link.
                      // Users still reach it by click — the intended
                      // flow anyway; keyboard-only users get the
                      // password field on the very next keystroke.
                      tabIndex={-1}
                      className="text-xs font-semibold text-brand-700 hover:text-brand-800 hover:underline"
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
                       className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-700">
                    {err}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={busy}
                  className="w-full inline-flex items-center justify-center rounded-lg
                             bg-brand-600 hover:bg-brand-700 text-white font-semibold
                             px-4 py-2.5 text-sm shadow-sm transition-colors
                             focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500
                             disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {busy ? 'Signing in…' : 'Sign in'}
                </button>
              </form>
            </>
          ) : (
            <>
              <h1 className="font-display text-[26px] font-extrabold text-slate-900 tracking-[-0.03em]">
                Reset password
              </h1>
              <p className="mt-1 text-sm text-slate-500">
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
                               bg-brand-600 hover:bg-brand-700 text-white font-semibold
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
                               bg-brand-600 hover:bg-brand-700 text-white font-semibold
                               px-4 py-2.5 text-sm shadow-sm transition-colors
                               focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500
                               disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {forgotBusy ? 'Sending reset link…' : 'Send reset link'}
                  </button>

                  <div className="text-center pt-2">
                    <button
                      type="button"
                      onClick={() => setView('login')}
                      className="text-xs font-medium text-slate-500 hover:text-slate-800 hover:underline"
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
          <p className="mt-5 text-center text-xs text-slate-500">
            Not yet onboarded?{' '}
            <a href="/register/institution" className="font-semibold text-brand-700 hover:underline">
              Register your institution →
            </a>
          </p>
        )}
        </motion.div>
      </div>
    </div>
  )
}
