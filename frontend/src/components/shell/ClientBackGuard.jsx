import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../lib/auth.jsx'
import ConfirmDialog from './ConfirmDialog.jsx'

// Verification-agent browser-back guard, mounted at App root so it
// survives every Router transition. The earlier per-AppShell version
// was fragile: when the operator hit back, Router's popstate handler
// transitioned to whatever URL sat below the guard entry (usually the
// login page), which UNMOUNTED AppShell. The dialog state set on the
// unmounting shell was immediately lost, so the popup only showed
// intermittently — depending on whether Router happened to unmount
// AppShell in the same tick.
//
// This version:
//   - Lives outside <Routes>, so it never unmounts as long as the
//     app is running. Dialog state is stable across any Router
//     transition.
//   - Activates only when user.role === 'client'.
//   - Arms exactly one guard history entry (skips push if the
//     current entry is already ours — hard refresh preserves
//     history.state, stacking would produce flaky pop behaviour).
//   - On popstate that lands on a non-guard entry, IMMEDIATELY
//     pushes a fresh guard at the known operator entry URL. That
//     forces Router to transition back to the operator surface if
//     the popped-to URL was outside it (e.g. /institute/operator/login),
//     so the operator can never actually leave without confirming.
//   - Renders the "Sign out?" dialog. Confirm → clears the in-flight
//     verification state + logs out. Cancel → dialog closes; the
//     guard is already re-armed so the next back-press asks again.
export default function ClientBackGuard() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [showDialog, setShowDialog] = useState(false)

  useEffect(() => {
    if (user?.role !== 'client') return

    const OPERATOR_URL = '/institute/operator'

    // Arm — only if not already armed. Hard refresh preserves the
    // history entry's state, so pushing again would just stack a
    // duplicate.
    if (window.history.state?.__agentBackGuard !== true) {
      try {
        window.history.pushState(
          { __agentBackGuard: true },
          '',
          window.location.pathname + window.location.search,
        )
      } catch (_) {}
    }

    const onPop = () => {
      // We're back on our own guard entry — this popstate came from
      // an in-app forward-nav or from our own re-push below. Ignore.
      if (window.history.state?.__agentBackGuard === true) return

      // Real back-press: the operator has popped OUT of the guard.
      // Push a fresh guard back onto the stack at OPERATOR_URL so
      // Router's transition (which reads the current URL) snaps back
      // to the operator surface even if the popped-to URL was
      // /institute/operator/login. Router will then re-render the
      // operator dashboard under this dialog.
      try {
        window.history.pushState(
          { __agentBackGuard: true },
          '',
          OPERATOR_URL,
        )
      } catch (_) {}
      setShowDialog(true)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [user?.role])

  function handleConfirm() {
    setShowDialog(false)
    // Wipe the in-flight verification state on explicit sign-out so
    // the next login starts at Step 1 (mirror of AppShell's logout).
    try { sessionStorage.removeItem('nv_verify_state_v1') } catch (_) {}
    logout()
    navigate('/institute/operator/login', { replace: true })
  }

  // No dialog for non-client sessions.
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
