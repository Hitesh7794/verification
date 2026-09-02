import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { MotionConfig } from 'framer-motion'
import App from './App.jsx'
import ErrorBoundary from './components/ui/ErrorBoundary.jsx'
import { AuthProvider } from './lib/auth.jsx'
import './index.css'

// One-shot: wipe the operator's in-flight verification state when the
// page arrives via anything OTHER than a refresh. Covers new-tab URL,
// Ctrl+Shift+T reopen, browser session restore, external back/forward.
// Only 'reload' preserves (the mid-flow-survives-refresh case).
try {
  const navEntry = typeof performance !== 'undefined'
    ? performance.getEntriesByType?.('navigation')?.[0]
    : null
  if (!navEntry || navEntry.type !== 'reload') {
    try { sessionStorage.removeItem('nv_verify_state_v1') } catch {}
    try { sessionStorage.removeItem('nv_session_alive_client') } catch {}
  }
} catch {}

// Verification-agent back-button guard, installed at module load
// BEFORE BrowserRouter mounts. Listener registration order on window
// determines fire order for popstate — Router registers its listener
// when BrowserRouter mounts, so if we install first, our handler
// runs first. That lets us push the URL back to /institute/operator
// BEFORE Router reads window.location in its own handler; Router
// then sees the guard URL and doesn't transition away.
//
// The earlier attempts (v1-v3) all registered inside React components
// which mount after BrowserRouter — so Router's handler fired first,
// transitioned Router's internal location to the popped URL, and
// rendered whatever route matched (usually LoginPage). Anything the
// React handler did afterward was cosmetic — the URL bar snapped
// back but Router stayed on LoginPage. This module-level install
// fixes that ordering.
//
// Dialog rendering is still the React component's job (below in
// ClientBackGuard.jsx) — we just fire a custom event to poke it.
try {
  window.addEventListener('popstate', function agentBackGuard() {
    // Role check via storage — AuthProvider isn't up when this
    // fires. If the operator's stored session exists AND we're on
    // an operator URL, we're guarding.
    let scopeIsClient = false
    try {
      scopeIsClient =
        window.location.pathname.startsWith('/institute/operator') &&
        !window.location.pathname.startsWith('/institute/operator/login') &&
        !!localStorage.getItem('nv_token_client')
    } catch (_) {}
    if (!scopeIsClient) return

    // Guard state already on the entry we've landed on → this is our
    // own re-armed entry or forward-to-guard; skip.
    if (window.history.state && window.history.state.__agentBackGuard === true) return

    // Push a fresh guard entry at the CURRENT URL (window.location
    // already reflects the popped-to URL by the time popstate fires
    // — using that keeps in-app navigation state intact). Must happen
    // synchronously inside this handler, before Router's own popstate
    // handler runs and reads window.location; Router will then read
    // the pushed URL and stay put instead of transitioning to whatever
    // was popped from.
    try {
      window.history.pushState(
        { __agentBackGuard: true },
        '',
        window.location.pathname + window.location.search,
      )
    } catch (_) {}

    // Poke the React component to show the dialog.
    try {
      window.dispatchEvent(new CustomEvent('nv-agent-back-guard-show'))
    } catch (_) {}
  })
  // Arm the initial guard entry once so the FIRST back-press pops
  // it and triggers the handler above. Only fire on operator URLs.
  const shouldArm =
    window.location.pathname.startsWith('/institute/operator') &&
    !window.location.pathname.startsWith('/institute/operator/login') &&
    (function () { try { return !!localStorage.getItem('nv_token_client') } catch (_) { return false } })() &&
    !(window.history.state && window.history.state.__agentBackGuard === true)
  if (shouldArm) {
    try {
      window.history.pushState(
        { __agentBackGuard: true },
        '',
        window.location.pathname + window.location.search,
      )
    } catch (_) {}
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
