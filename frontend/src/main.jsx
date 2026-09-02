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
  const dbg = (...m) => { try { if (window.__navGuardDebug) console.log('[nv-guard]', ...m) } catch (_) {} }
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
