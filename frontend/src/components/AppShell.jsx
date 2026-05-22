import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth.jsx'
import WalletWidget from './WalletWidget.jsx'
import AvatarMenu from './AvatarMenu.jsx'

// AppShell — page chrome shared across client / admin / superadmin pages.
//
// Header is intentionally minimal: nothing on the left, wallet widget +
// avatar dropdown on the right. The avatar dropdown holds the operator's
// display name, role, username, and the sign-out button. This keeps the
// navbar tight regardless of how long an operator's display_name is
// (real-world center names run 50-80 chars).
//
// The `title` / `subtitle` props are accepted for backwards compatibility
// with existing callers (client, admin, superadmin dashboards still pass
// them) but are no longer rendered in the chrome — page-level titles
// live in the PageHeader component inside each page's body.
export default function AppShell({ children, walletRefreshKey, onWalletBalanceChange }) {
  const { user, logout } = useAuth()
  const nav = useNavigate()

  function handleLogout() {
    const role = user?.role
    logout()
    nav(`/${role || ''}/login`)
  }

  // Wallet widget only renders for client role — admin/superadmin don't
  // have wallets in this design. The widget self-disables (returns null)
  // if /api/wallet/config errors out, so deployments that have the
  // feature off get a clean header automatically.
  const showWallet = user?.role === 'client'

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-7xl px-6 py-3 flex items-center justify-end gap-4">
          {showWallet && (
            <WalletWidget
              refreshKey={walletRefreshKey || 0}
              onBalanceChange={onWalletBalanceChange}
            />
          )}
          <AvatarMenu user={user} onLogout={handleLogout} />
        </div>
      </header>
      <main className="flex-1">
        <div className="mx-auto max-w-7xl px-6 py-8">{children}</div>
      </main>
      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto max-w-7xl px-6 py-4 text-xs text-slate-500">
          NEET Verification Portal · Mock build for development
        </div>
      </footer>
    </div>
  )
}
