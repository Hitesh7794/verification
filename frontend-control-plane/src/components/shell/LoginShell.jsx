import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useAuth } from '../../lib/auth.jsx'
import { requestForgotPassword } from '../../lib/onboarding/register.js'
import { Input, Label } from '../ui/ui.jsx'
import { PRODUCT_NAME, BrandMark } from '../ui/brand.jsx'
import { BiometricStrip, BiometricRail } from '../ui/biometrics.jsx'
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
        {/* Decoration layer — everything here is inert to the pointer. */}
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          <div
            className="absolute -inset-y-16 inset-x-0 bg-dot-grid opacity-[0.13]"
            style={{ animation: 'bio-drift 24s ease-in-out infinite' }}
          />
          <div className="aurora-a absolute -top-32 -left-24 h-[34rem] w-[34rem] rounded-full bg-brand-500/18 blur-[120px]" />
          <div className="aurora-b absolute -bottom-40 -right-16 h-[30rem] w-[30rem] rounded-full bg-amber-400/10 blur-[130px]" />
          {/* Oversized mark, barely visible — gives the lower half of the
              panel something to hold without adding another element to read. */}
          <BrandMark
            size={520}
            tone="inverse"
            className="absolute -bottom-44 -right-40 opacity-[0.03]"
          />
        </div>
        {/* Seam down the inner edge */}
        <div className="panel-seam absolute inset-y-0 right-0 w-px pointer-events-none" />

        <div className="relative flex items-center gap-3 rise-in" style={{ '--i': 0 }}>
          <BrandMark size={34} tone="inverse" />
          <span className="font-display text-lg font-extrabold text-white tracking-[-0.025em]">
            {PRODUCT_NAME}
          </span>
        </div>

        <div className="relative max-w-lg">
          <h2 className="font-display text-[40px] xl:text-[46px] font-extrabold leading-[1.08] tracking-[-0.035em] text-white text-balance rise-in" style={{ '--i': 1 }}>
            From exam hall to admission desk.
          </h2>
          <p className="mt-6 text-[16px] leading-relaxed text-slate-300 max-w-lg text-balance rise-in" style={{ '--i': 2 }}>
            One identity, months apart. Verified before a seat is granted.
          </p>

          {/* The three capture modalities, animating. Shown rather than
              described — it is what the product does, and it is the
              first thing a visiting stakeholder should understand. */}
          <BiometricRail size={124} className="mt-20 max-w-2xl rise-in" style={{ '--i': 3 }} />

        </div>

        <p className="relative text-[11px] text-slate-500 rise-in" style={{ '--i': 4 }}>
          Authorised access only. All sign-in attempts are logged.
        </p>
      </aside>

      {/* ── Sign-in panel ─────────────────────────────────────────── */}
      <div className="relative flex flex-col bg-white">
        {/* Below lg the brand panel is hidden, so small screens get a
            condensed version of it rather than a card alone on grey.
            Navy, so the glyphs keep the palette they were drawn for. */}
        <div className="lg:hidden bg-ink-chrome px-6 pt-9 pb-7 flex flex-col items-center text-center">
          <div className="flex items-center gap-2.5 rise-in" style={{ '--i': 0 }}>
            <BrandMark size={28} tone="inverse" />
            <span className="font-display text-[17px] font-extrabold text-white tracking-[-0.025em]">
              {PRODUCT_NAME}
            </span>
          </div>
          <p className="mt-3 text-[13px] text-slate-300 max-w-xs rise-in" style={{ '--i': 1 }}>
            One identity, months apart. Verified before a seat is granted.
          </p>
          <BiometricStrip size={44} gap="gap-7" className="mt-6 rise-in" style={{ '--i': 2 }} />
        </div>
        <div className="lg:hidden h-[2px] rule-gold" />

        <div className="flex-1 flex items-center justify-center p-6 sm:p-10">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1], delay: 0.12 }}
          className="relative w-full max-w-[400px]"
        >

        {/* No card. The right half is white and the form sits directly
            on it — a boxed card floating on grey is the stock sign-in
            shape, and the split itself already frames this side. */}
        <div>
          <div>
          {/* The desk, as a kicker with a gold rule running off it —
              the same authority mark the chrome carries. */}
          <div className="flex items-center gap-3 mb-5">
            <span className="text-[10.5px] font-bold uppercase tracking-[0.16em] text-slate-500 whitespace-nowrap">
              {roleLabel}
            </span>
            <span aria-hidden="true" className="h-[1.5px] flex-1 rule-gold" />
          </div>

          {view === 'login' ? (
            <>
              <h1 className="font-display text-[34px] leading-none font-extrabold text-slate-900 tracking-[-0.035em]">
                Sign in
              </h1>

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

              <form onSubmit={onSubmit} className="mt-8 space-y-6" autoComplete="on">
                <div>
                  <label className="block text-[10.5px] font-bold uppercase tracking-[0.14em] text-slate-500 mb-1">
                    {allowedRoles.includes('superadmin') ? 'Username' : 'Username or email'}
                  </label>
                  <div className="relative">
                    <input
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      autoComplete="username"
                      autoFocus
                      required
                      className="peer w-full bg-transparent border-0 border-b border-slate-300 rounded-none px-0 py-2.5 text-[15px] text-slate-900 placeholder-slate-300 focus:outline-none focus:border-slate-300 focus:ring-0 transition-colors"
                    />
                    <span aria-hidden="true" className="pointer-events-none absolute bottom-0 left-0 h-[2px] w-full origin-left scale-x-0 bg-brand-600 transition-transform duration-300 ease-[cubic-bezier(.22,1,.36,1)] peer-focus:scale-x-100" />
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between">
                    <label className="block text-[10.5px] font-bold uppercase tracking-[0.14em] text-slate-500 mb-1">Password</label>
                    <button
                      type="button"
                      onClick={() => {
                        setView('forgot')
                        setForgotInput(username)
                        setForgotErr('')
                        setForgotSent(false)
                      }}
                      className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-slate-400 hover:text-brand-700 transition-colors"
                    >
                      Forgot password?
                    </button>
                  </div>
                  <div className="relative">
                    <input
                      type={showPw ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="current-password"
                      required
                      className="peer w-full bg-transparent border-0 border-b border-slate-300 rounded-none px-0 py-2.5 text-[15px] text-slate-900 placeholder-slate-300 focus:outline-none focus:border-slate-300 focus:ring-0 transition-colors pr-9"
                    />
                    <span aria-hidden="true" className="pointer-events-none absolute bottom-0 left-0 h-[2px] w-full origin-left scale-x-0 bg-brand-600 transition-transform duration-300 ease-[cubic-bezier(.22,1,.36,1)] peer-focus:scale-x-100" />
                    <button
                      type="button"
                      onClick={() => setShowPw((v) => !v)}
                      className="absolute right-0 inset-y-0 px-1 flex items-center text-slate-400 hover:text-slate-700 transition-colors"
                      aria-label={showPw ? 'Hide password' : 'Show password'}
                      tabIndex={-1}
                    >
                      <Icon.Eye className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {err && (
                  <div role="alert"
                       className="alert-in flex items-start gap-2 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-700">
                    <Icon.AlertCircle className="h-4 w-4 shrink-0 mt-px" />
                    <span>{err}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={busy}
                  className="group w-full inline-flex items-center justify-center rounded-md
                             bg-ink-800 hover:bg-ink-700 text-white font-semibold
                             px-4 py-3.5 text-[13px] uppercase tracking-[0.1em]
                             transition-colors duration-150
                             focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500
                             disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {busy ? (
                    <>
                      <span
                        aria-hidden="true"
                        className="spin-ring mr-2 h-4 w-4 rounded-full border-2 border-white/35 border-t-white"
                      />
                      Signing in&hellip;
                    </>
                  ) : (
                    <>
                      Sign in
                      <Icon.ArrowRight className="ml-2 h-4 w-4 transition-transform duration-150 group-hover:translate-x-0.5" />
                    </>
                  )}
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
            <div className="mt-9 pt-5 border-t border-slate-200">
              <p className="text-[13px] text-slate-500">
                Not yet onboarded?{' '}
                <a href="/register/institution" className="font-semibold text-brand-700 hover:text-brand-800 underline underline-offset-4 decoration-brand-300 hover:decoration-brand-600 transition-colors">
                  Register your institution
                </a>
              </p>
            </div>
          )}
        </div>
        </motion.div>
        </div>
      </div>
    </div>
  )
}
