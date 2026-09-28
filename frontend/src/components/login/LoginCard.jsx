import { Icon } from '../ui/icons.jsx'

// The sign-in card — a web port of the Android LoginScreen
// (ui/login/LoginScreen.kt), FlatViolet scheme, shared by both login
// versions.
//
//   • White card, 1px dash hairline, 10px corners, no shadow (Modifier.glass).
//   • State Emblem tinted ink, then "Welcome to the Verification Portal"
//     in Bricolage's display cut.
//   • Fields are a line, not a box: a hairline that turns accent and
//     thickens on focus; label and icon take the accent.
//   • One solid block of accent: the Login button (12px corners, Flat).
//     Disabled it's a tonal card with faint text.
//   • A miss sits on the lit tint in the deep hue. Never red, never green.
//
// The web adds what the app doesn't need: which desk you're signing in
// to, "Forgot password?", and the institution-registration link.

export default function LoginCard({ f, showRegisterLink = false, bare = false }) {
  const { notices: n } = f
  return (
    <div className={bare
      ? 'w-full max-w-[400px] flex flex-col items-center'
      : 'w-full max-w-[560px] rounded-[10px] border border-fv-line bg-fv-card px-6 py-7 sm:px-11 sm:py-10 flex flex-col items-center'}>
      <div aria-hidden="true" className="fv-emblem fv-enter h-[60px] sm:h-[84px]" style={{ '--i': 0 }} />
      <h1 className="fv-display fv-enter mt-5 text-center text-[24px] leading-[30px] sm:text-[30px] sm:leading-[36px] font-bold tracking-[-0.3px] text-fv-ink"
          style={{ '--i': 0 }}>
        {f.view === 'login' ? 'Welcome to the Verification Portal' : 'Reset your password'}
      </h1>
      <p className="fv-enter mt-2 text-center text-[15px] sm:text-[17px] text-fv-muted" style={{ '--i': 1 }}>
        {f.view === 'login'
          ? `${f.roleLabel} sign-in`
          : "Enter your registered email or username and we'll send a reset link."}
      </p>

      <div className="w-full mt-9 sm:mt-11">
        {f.view === 'login' ? (
          <>
            {(n.portalDisabled || n.sessionExpired || n.justActivated || n.passwordReset) && !f.err && (
              <div className="mb-4 space-y-2">
                {n.portalDisabled && (
                  <MissCard>This board's review portal has been disabled by the platform team, so you've been signed out. Contact them if you think this is a mistake.</MissCard>
                )}
                {n.sessionExpired && !n.portalDisabled && <MissCard>Your session ended. Sign in again.</MissCard>}
                {n.justActivated && <MissCard>Password set. Sign in to continue.</MissCard>}
                {n.passwordReset && <MissCard>Password reset. Sign in with your new password.</MissCard>}
              </div>
            )}

            <form onSubmit={f.onSubmit} autoComplete="on">
              <LineField
                i={2}
                label="Username"
                focused={f.focus === 'user'}
                value={f.username}
                onChange={(e) => f.setUsername(e.target.value)}
                onFocus={() => f.setFocus('user')}
                onBlur={() => f.setFocus(null)}
                autoComplete="username"
                disabled={f.busy}
                
              />
              <div className="h-2" />
              <LineField
                i={3}
                label="Password"
                focused={f.focus === 'pass'}
                type={f.showPw ? 'text' : 'password'}
                value={f.password}
                onChange={(e) => f.setPassword(e.target.value)}
                onFocus={() => f.setFocus('pass')}
                onBlur={() => f.setFocus(null)}
                autoComplete="current-password"
                disabled={f.busy}
                trailing={
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()} // keep focus so he keeps peeking
                    onClick={f.toggleShowPw}
                    aria-label={f.showPw ? 'Hide password' : 'Show password'}
                    className="grid h-10 w-10 place-items-center rounded-full text-fv-muted hover:text-fv-ink transition-colors"
                  >
                    {f.showPw ? <VisibilityOff /> : <Visibility />}
                  </button>
                }
              />

              <div className="mt-2.5 flex justify-end">
                <button type="button" onClick={f.openForgot}
                        className="text-[13.5px] font-medium text-fv-muted hover:text-fv-accent transition-colors">
                  Forgot password?
                </button>
              </div>

              {f.err && <div className="mt-3"><MissCard role="alert">{f.err}</MissCard></div>}

              <div className="fv-enter mt-7 sm:mt-8" style={{ '--i': 4 }}>
                <LoginButton loading={f.busy && !f.success} enabled={f.canSubmit}>
                  {f.success ? 'Signed in' : 'Login'}
                </LoginButton>
              </div>
            </form>

            <p className="fv-enter mt-5 sm:mt-6 text-center text-[13px] sm:text-[14px] font-medium text-fv-muted" style={{ '--i': 5 }}>
              {showRegisterLink ? (
                <>
                  Not yet onboarded?{' '}
                  <a href="/register/institution" className="font-semibold text-fv-accent hover:text-fv-accent-deep transition-colors">
                    Register your institution
                  </a>
                </>
              ) : 'Need an account? Ask your administrator.'}
            </p>
          </>
        ) : f.forgotSent ? (
          <div className="space-y-6">
            <MissCard>If an account matching <span className="font-semibold">{f.forgotInput}</span> exists, a reset link is on its way. Check your inbox.</MissCard>
            <LoginButton type="button" enabled onClick={f.backToLogin}>Return to sign in</LoginButton>
          </div>
        ) : (
          <form onSubmit={f.onForgotSubmit}>
            <LineField
              label="Email or username"
              focused={f.focus === 'forgot'}
              value={f.forgotInput}
              onChange={(e) => f.setForgotInput(e.target.value)}
              onFocus={() => f.setFocus('forgot')}
              onBlur={() => f.setFocus(null)}
              autoFocus
            />
            {f.forgotErr && <div className="mt-3.5"><MissCard role="alert">{f.forgotErr}</MissCard></div>}
            <div className="mt-7 sm:mt-8">
              <LoginButton loading={f.forgotBusy} enabled={!!f.forgotInput.trim()}>Send reset link</LoginButton>
            </div>
            <button type="button" onClick={f.backToLogin}
                    className="mt-5 w-full text-center text-[14px] font-medium text-fv-muted hover:text-fv-ink transition-colors">
              Back to sign in
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

// ── Parts ─────────────────────────────────────────────────────────────

// The field: a single word sits on the line ("Username"); on focus or once
// filled it lifts and shrinks above the text. No icon, no placeholder, no
// repeated label. The line darkens and thickens with focus.
export function LineField({ label, focused, trailing, i, value, id, ...inputProps }) {
  const raised = focused || (value != null && String(value).length > 0)
  const fid = id || `f-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`
  return (
    <div className={i != null ? 'fv-enter' : ''} style={i != null ? { '--i': i } : undefined}>
      <div className="relative flex h-[62px] sm:h-[66px] items-end">
        <label
          htmlFor={fid}
          className={`pointer-events-none absolute left-0 origin-left transition-all duration-[240ms] ease-[cubic-bezier(.22,.9,.28,1)]
            ${raised
              ? `top-[6px] text-[12.5px] font-semibold tracking-[0.01em] ${focused ? 'text-fv-accent' : 'text-fv-muted'}`
              : 'top-[30px] sm:top-[32px] text-[17px] sm:text-[18px] font-medium text-fv-faint'}`}
        >
          {label}
        </label>
        <input
          id={fid}
          value={value}
          {...inputProps}
          className="min-w-0 flex-1 bg-transparent pb-3 pt-6 text-[17px] sm:text-[18px] font-medium tracking-[-0.005em] text-fv-ink caret-fv-accent
                     focus:outline-none disabled:opacity-70"
        />
        {trailing ? <div className="pb-2">{trailing}</div> : null}
        <span aria-hidden="true"
              className={`pointer-events-none absolute inset-x-0 bottom-0 transition-all duration-[210ms]
                          ${focused ? 'h-[2px] bg-fv-accent' : 'h-px bg-fv-faint/60'}`} />
      </div>
    </div>
  )
}

export function LoginButton({ loading = false, enabled = true, children, type = 'submit', ...rest }) {
  const on = enabled && !loading
  return (
    <button
      type={type}
      disabled={!on}
      {...rest}
      className={`group flex h-[58px] sm:h-[64px] w-full items-center justify-center gap-2.5 rounded-[12px]
                  text-[16px] sm:text-[17px] font-semibold tracking-[0.2px] transition-[background-color,transform] duration-[260ms]
                  focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fv-accent-deep
                  active:scale-[0.97]
                  ${on || loading ? 'bg-fv-accent text-fv-on-accent hover:bg-fv-accent-deep' : 'bg-fv-disabled text-fv-faint cursor-not-allowed'}`}
    >
      {loading ? (
        <span aria-label="Signing in" className="spin-ring h-[22px] w-[22px] rounded-full border-2 border-white/35 border-t-white" />
      ) : (
        <>
          {children}
          <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="currentColor" aria-hidden="true">
            <path d="M5 13h11.17l-4.88 4.88c-.39.39-.39 1.03 0 1.42.39.39 1.02.39 1.41 0l6.59-6.59a.996.996 0 0 0 0-1.41l-6.58-6.6a.996.996 0 1 0-1.41 1.41L16.17 11H5c-.55 0-1 .45-1 1s.45 1 1 1z" />
          </svg>
        </>
      )}
    </button>
  )
}

// ErrorCard: a miss sits on the lit tint, in the deep hue. Never red.
export function MissCard({ role = 'status', children }) {
  return (
    <div role={role} className="w-full rounded-[14px] bg-fv-card-focus px-4 py-3 text-[14px] leading-5 font-medium text-fv-accent-deep">
      {children}
    </div>
  )
}

// Material "rounded" visibility icons, as the app uses.
function Visibility() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor" aria-hidden="true">
      <path d="M12 4C7 4 2.73 7.11 1 11.5 2.73 15.89 7 19 12 19s9.27-3.11 11-7.5C21.27 7.11 17 4 12 4zm0 12.5c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" />
    </svg>
  )
}
function VisibilityOff() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor" aria-hidden="true">
      <path d="M12 6.5c2.76 0 5 2.24 5 5 0 .51-.1 1-.24 1.46l3.06 3.06c1.39-1.23 2.49-2.77 3.18-4.53C21.27 7.11 17 4 12 4c-1.27 0-2.49.2-3.64.57l2.17 2.17c.47-.14.96-.24 1.47-.24zM2.71 3.16a.996.996 0 0 0 0 1.41l1.97 1.97A11.892 11.892 0 0 0 1 11.5C2.73 15.89 7 19 12 19c1.52 0 2.97-.3 4.31-.82l2.72 2.72a.996.996 0 1 0 1.41-1.41L4.13 3.16c-.39-.39-1.03-.39-1.42 0zM12 16.5c-2.76 0-5-2.24-5-5 0-.77.18-1.5.49-2.14l1.57 1.57c-.03.18-.06.37-.06.57 0 1.66 1.34 3 3 3 .2 0 .38-.03.57-.07L14.14 16c-.65.32-1.37.5-2.14.5zm2.97-5.33a2.97 2.97 0 0 0-2.64-2.64l2.64 2.64z" />
    </svg>
  )
}

export function FvMark({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path d="M16 2.5 4.5 7v9.2c0 6.4 4.7 11.4 11.5 13.3 6.8-1.9 11.5-6.9 11.5-13.3V7L16 2.5Z" fill="#5B3FA6" />
      <path d="M10.6 16.1l3.7 3.8 7.1-7.6" stroke="#FFFFFF" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  )
}
