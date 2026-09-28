import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../lib/auth.jsx'
import { requestForgotPassword } from '../../lib/onboarding/register.js'

// Shared sign-in state for both login versions (A: companion, B: panel),
// so the two designs behave identically and differ only in layout.

export const ROLE_LABEL = {
  client:          'Verification Agent',
  admin:           'Administrator',
  superadmin:      'Superadmin',
  client_reviewer: 'Reviewer',
}

export function useLoginForm({
  expectedRole,
  expectedRoles,
  redirectTo,
  redirectByRole,
  rememberKey,
  celebrateMs = 0, // hold on the success state before navigating (companion cheer)
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
  const [focus, setFocus] = useState(null) // 'user' | 'pass' | 'forgot' | null
  const [success, setSuccess] = useState(false)

  const [forgotInput, setForgotInput] = useState('')
  const [forgotSent, setForgotSent] = useState(false)
  const [forgotErr, setForgotErr] = useState('')
  const [forgotBusy, setForgotBusy] = useState(false)

  const allowedRoles = expectedRoles || (expectedRole ? [expectedRole] : [])

  async function onSubmit(e) {
    e.preventDefault()
    setErr('')
    setBusy(true)
    try {
      const u = await login(username, password)
      if (allowedRoles.length && !allowedRoles.includes(u.role)) {
        const humanRole = ROLE_LABEL[u.role] || u.role
        setErr(`This account is a ${humanRole}. Please sign in from the ${humanRole} portal instead.`)
        return
      }
      if (rememberKey) {
        try { localStorage.setItem(rememberKey, username) } catch {}
      }
      // Session-alive marker — gates any resumable per-role flow state
      // (see Dashboard's nv_verify_state_v1). Refresh keeps it.
      try { sessionStorage.setItem('nv_session_alive_' + u.role, '1') } catch {}
      const dest = redirectByRole?.[u.role] || redirectTo || '/'
      setSuccess(true)
      if (celebrateMs) await new Promise((r) => setTimeout(r, celebrateMs))
      nav(dest)
    } catch (e2) {
      setErr(e2.message || 'Login failed')
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
    } catch (e2) {
      setForgotErr(e2.message || 'Failed to dispatch reset request')
    } finally {
      setForgotBusy(false)
    }
  }

  function openForgot() {
    setView('forgot'); setForgotInput(username); setForgotErr(''); setForgotSent(false)
  }
  function backToLogin() {
    setView('login'); setForgotSent(false)
  }

  // What the companion should be doing — the same rules as the app's
  // LoginScreen. ?mood=<type> freezes it for design review
  // (idle, typing, covered, peek, waiting, confused, right, wave, …).
  const forced = params.get('mood')
  const len = (focus === 'forgot' ? forgotInput : username).length
  const mood = forced
    ? (forced === 'peek' ? { type: 'covered', peek: true }
      : forced === 'covered' ? { type: 'covered', peek: false }
      : forced === 'typing' ? { type: 'typing', caret: 0.5, count: 0 }
      : { type: forced })
    : success ? { type: 'right' }
    : (err || forgotErr) ? { type: 'confused' }
    : (busy || forgotBusy) ? { type: 'waiting' }
    : focus === 'pass' ? { type: 'covered', peek: showPw }
    : (focus === 'user' || focus === 'forgot') ? { type: 'typing', caret: Math.min(1, len / 16), count: len }
    : { type: 'idle' }

  return {
    view, openForgot, backToLogin,
    username, setUsername: (v) => { setUsername(v); if (err) setErr('') },
    password, setPassword: (v) => { setPassword(v); if (err) setErr('') },
    showPw, toggleShowPw: () => setShowPw((v) => !v),
    err, busy, success, focus, setFocus,
    canSubmit: !!(username.trim() && password && !busy),
    onSubmit,
    forgotInput, setForgotInput: (v) => { setForgotInput(v); if (forgotErr) setForgotErr('') },
    forgotSent, forgotErr, forgotBusy, onForgotSubmit,
    roleLabel: ROLE_LABEL[allowedRoles[0]] || 'Portal',
    isSuper: allowedRoles.includes('superadmin'),
    mood,
    notices: {
      sessionExpired: params.get('session_expired') === '1',
      justActivated:  params.get('just_activated')  === '1',
      passwordReset:  params.get('password_reset')  === '1',
      portalDisabled: params.get('portal_disabled') === '1',
    },
  }
}
