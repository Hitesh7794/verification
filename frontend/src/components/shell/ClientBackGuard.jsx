import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../lib/auth.jsx'
import ConfirmDialog from './ConfirmDialog.jsx'

// Verification-agent back-button guard — React half.
//
// The popstate INTERCEPTION lives in main.jsx, installed at module
// load BEFORE BrowserRouter mounts, so our handler fires first (window
// listeners fire in registration order for same-target events). That
// handler pushes the URL back to /institute/operator before Router
// reads window.location, so Router doesn't transition away — then
// dispatches a 'nv-agent-back-guard-show' custom event that this
// component listens for to show the dialog.
//
// Earlier per-component versions couldn't be reliable because Router
// registered its popstate listener before any of them mounted, so
// Router always won the race to transition. Only a module-load-time
// listener beats Router.
export default function ClientBackGuard() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [showDialog, setShowDialog] = useState(false)

  useEffect(() => {
    if (user?.role !== 'client') return
    const onShow = () => setShowDialog(true)
    window.addEventListener('nv-agent-back-guard-show', onShow)
    return () => window.removeEventListener('nv-agent-back-guard-show', onShow)
  }, [user?.role])

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
