import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../lib/auth.jsx'
import ConfirmDialog from './ConfirmDialog.jsx'

// Verification-agent back-button guard — React half.
//
// Popstate INTERCEPTION lives in main.jsx (module-load) so it fires
// before Router's own popstate listener. It pushes a fresh guard
// entry at /institute/operator (URL bar snaps back) and dispatches
// 'nv-agent-back-guard-show'.
//
// This component:
//   - Arms a guard entry whenever user.role becomes 'client' (post-
//     login). Without this, a page that first loaded on the login
//     page would have no guard above the operator entry and the
//     first back-press would escape.
//   - On the custom event: calls navigate('/institute/operator') so
//     Router actually renders Dashboard (Router doesn't listen to
//     raw pushState, so my URL push alone leaves Router on whatever
//     route the popstate transitioned it to — usually LoginPage).
//     Also shows the confirm dialog.
export default function ClientBackGuard() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [showDialog, setShowDialog] = useState(false)

  // Arm — pushes a guard entry once the role settles to 'client'.
  // Diagnostics behind window.__navGuardDebug.
  const dbg = (...m) => { try { if (window.__navGuardDebug) console.log('[nv-guard/react]', ...m) } catch (_) {} }
  useEffect(() => {
    if (user?.role !== 'client') return
    if (window.history.state?.__agentBackGuard === true) {
      dbg('arm: current entry already guarded, skip')
      return
    }
    dbg('arm: pushing guard at', window.location.pathname + window.location.search)
    try {
      window.history.pushState(
        { __agentBackGuard: true },
        '',
        window.location.pathname + window.location.search,
      )
    } catch (_) {}
  }, [user?.role])

  // Listen for the module-level handler's event. Force Router back
  // to the operator dashboard and show the dialog.
  useEffect(() => {
    if (user?.role !== 'client') return
    const onShow = () => {
      dbg('event received → navigate(/institute/operator) + show dialog')
      navigate('/institute/operator', { replace: false })
      setShowDialog(true)
    }
    window.addEventListener('nv-agent-back-guard-show', onShow)
    return () => window.removeEventListener('nv-agent-back-guard-show', onShow)
  }, [user?.role, navigate])

  function handleConfirm() {
    setShowDialog(false)
    // Wipe the in-flight verification state on explicit sign-out so
    // the next login starts at Step 1. Also drop the session-alive
    // marker so Dashboard.loadPersistedState sees the next login as
    // a fresh session.
    try { sessionStorage.removeItem('nv_verify_state_v1') } catch (_) {}
    try { sessionStorage.removeItem('nv_session_alive_client') } catch (_) {}
    logout()
    navigate('/institute/operator/login', { replace: true })
  }

  if (user?.role !== 'client') return null

  return (
    <ConfirmDialog
      open={showDialog}
      onCancel={() => setShowDialog(false)}
      onConfirm={handleConfirm}
      title="Sign out?"
      body="You pressed the browser back button. For safety on shared devices, we can sign you out. Cancel to stay signed in on this page."
      confirmLabel="Sign out"
      cancelLabel="Stay signed in"
      tone="warn"
    />
  )
}
