import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { MotionConfig } from 'framer-motion'
import App from './App.jsx'
import ErrorBoundary from './components/ui/ErrorBoundary.jsx'
import { AuthProvider } from './lib/auth.jsx'
import './index.css'

// Verification-agent back-button guard, installed at module load
// BEFORE BrowserRouter mounts so this handler runs before Router's
// on popstate. Diagnostics behind window.__navGuardDebug — set that
// to true in the browser console to see [nv-guard] logs.
try {
  // Debug flag: either window.__navGuardDebug OR sessionStorage
  // 'nv_guard_debug' == '1'. sessionStorage persists across reloads
  // in the same tab; window global does not.
  const isDbgOn = () => {
    try {
      if (window.__navGuardDebug) return true
      if (sessionStorage.getItem('nv_guard_debug') === '1') return true
    } catch (_) {}
    return false
  }
  const dbg = (...m) => { try { if (isDbgOn()) console.log('[nv-guard]', ...m) } catch (_) {} }
  window.addEventListener('popstate', function agentBackGuard(ev) {
    let hasClientSession = false
    try { hasClientSession = !!localStorage.getItem('nv_token_client') } catch (_) {}
    dbg('popstate fired', {
      url: window.location.pathname + window.location.search,
      state: window.history.state,
      hasClientSession,
    })
    if (!hasClientSession) { dbg('  → no client session, skip'); return }
    if (window.history.state && window.history.state.__agentBackGuard === true) {
      dbg('  → landed on our own guard entry, skip')
      return
    }
    dbg('  → NON-guard entry, pushing guard + firing event')
    try {
      window.history.pushState(
        { __agentBackGuard: true },
        '',
        '/institute/operator',
      )
    } catch (_) {}
    try {
      window.dispatchEvent(new CustomEvent('nv-agent-back-guard-show'))
    } catch (_) {}
  }, { capture: true }) // capture:true so we fire before Router even at same target
} catch (_) {}

// beforeunload backstop — catches tab close / actual page-unload
// navigation attempts (external URL, hard nav). SPA back-nav to a
// same-origin URL does NOT fire beforeunload, so this is not the
// primary guard, just a belt for the "close the tab" scenario.
try {
  window.addEventListener('beforeunload', function (e) {
    let hasClientSession = false
    try { hasClientSession = !!localStorage.getItem('nv_token_client') } catch (_) {}
    if (!hasClientSession) return
    const onOperator =
      window.location.pathname.startsWith('/institute/operator') &&
      !window.location.pathname.startsWith('/institute/operator/login')
    if (!onOperator) return
    // Setting returnValue triggers the browser's native "Leave site?"
    // confirm. Modern Chrome / Firefox ignore custom text and show
    // their own copy.
    e.preventDefault()
    e.returnValue = ''
    return ''
  })
} catch (_) {}

// Logout on RETURN via back/forward. Two cases:
//   (1) bfcache restore  → pageshow event fires with `persisted: true`
//   (2) full reload triggered by back/forward → PerformanceNavigationTiming
//       has type === 'back_forward' (nav-type 'reload' means F5 —
//       DO NOT logout on those, that would break mid-flow reload).
// In both cases we wipe the client session + rehydration state and
// hard-nav to /institute/operator/login so the operator lands on the
// login screen, not on their in-flight verification.
function wipeClientSessionAndBounceToLogin() {
  try { localStorage.removeItem('nv_token_client') } catch (_) {}
  try { localStorage.removeItem('nv_user_client') } catch (_) {}
  try { sessionStorage.removeItem('nv_verify_state_v1') } catch (_) {}
  try { sessionStorage.removeItem('nv_session_alive_client') } catch (_) {}
  // Hard nav (window.location.href) — full document swap so React /
  // any in-flight timers reset cleanly and the auth boot lands on
  // LoginShell.
  window.location.href = '/institute/operator/login'
}
function onOperatorRoute() {
  const p = window.location.pathname
  return p.startsWith('/institute/operator') && !p.startsWith('/institute/operator/login')
}
try {
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return
    if (!onOperatorRoute()) return
    if (!localStorage.getItem('nv_token_client')) return
    wipeClientSessionAndBounceToLogin()
  })
} catch (_) {}
try {
  const runBackForwardCheck = () => {
    try {
      const nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0]
      if (!nav) return
      if (nav.type !== 'back_forward') return
      if (!onOperatorRoute()) return
      if (!localStorage.getItem('nv_token_client')) return
      wipeClientSessionAndBounceToLogin()
    } catch (_) {}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runBackForwardCheck, { once: true })
  } else {
    runBackForwardCheck()
  }
} catch (_) {}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      {/* Global animation config:
          - reducedMotion='user' honours the OS Reduce Motion setting
            (macOS Accessibility / Windows Show Animations). Disables
            all non-essential motion for users who've asked for less.
          - transition default = smooth cubic ease, 280ms. Override per
            component if you need something else. */}
      <MotionConfig
        reducedMotion="user"
        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      >
        <BrowserRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
      </MotionConfig>
    </ErrorBoundary>
  </React.StrictMode>,
)
