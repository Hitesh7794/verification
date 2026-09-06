import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../lib/auth.jsx'
import WalletWidget from '../wallet/WalletWidget.jsx'
import AvatarMenu from './AvatarMenu.jsx'
import { Brand, PRODUCT_NAME } from '../ui/brand.jsx'

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
    // Wipe the in-flight verification state on explicit sign-out.
    // Refresh + reconnect paths still rehydrate from this key (that's
    // the whole point of persisting it), so a mid-flow reload still
    // resumes — but sign-out now genuinely resets the operator to
    // Step 1, so the next login doesn't drop them mid-fingerprint.
    // Also drop the session-alive marker so the NEXT login sets a
    // fresh one and the load-guard in Dashboard.loadPersistedState
    // correctly reads it as a new session.
    try { sessionStorage.removeItem('nv_verify_state_v1') } catch (_) {}
    try { sessionStorage.removeItem('nv_session_alive_' + (user?.role || '')) } catch (_) {}
    logout()
    nav(`/${role || ''}/login`)
  }

  // Browser-back guard for verification-agent sessions lives in
  // <ClientBackGuard /> at App root (see App.jsx) — that survives
  // Router transitions, which AppShell doesn't. Do NOT reintroduce
  // a per-AppShell popstate handler here; it stops working the
  // instant AppShell unmounts, which is exactly what happens when
  // Router transitions to a route below the guard entry.

  // Wallet widget renders for admin role only — wallets are owned by
  // the institution (org-level) and managed by its admin. Operators
  // (client role) don't see balances or top-ups; if their org's wallet
  // runs out, they get a "contact your administrator" banner. Superadmin
  // has no implicit org context so the navbar widget hides for them too
  // — they manage org wallets via a dedicated support flow.
  const showWallet = user?.role === 'admin'

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      {/* Navy chrome + gold rule — the same authority band the superadmin
          and reviewer desks carry, so an operator, a reviewer and the
          platform team are visibly inside one product. */}
      <header className="sticky top-0 z-30 bg-ink-chrome">
        <div className="mx-auto max-w-7xl px-6 h-16 flex items-center justify-between gap-4">
          <Brand linkTo="/" tone="inverse" />
          <div className="flex items-center gap-4">
            {showWallet && (
              <WalletWidget
                refreshKey={walletRefreshKey || 0}
                onBalanceChange={onWalletBalanceChange}
              />
            )}
            <AvatarMenu user={user} onLogout={handleLogout} />
          </div>
        </div>
        <div className="h-[2px] rule-gold" />
      </header>
      <main className="flex-1">
        <div className="mx-auto max-w-7xl px-6 py-8 animate-surface-in">{children}</div>
      </main>
      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto max-w-7xl px-6 py-4 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-semibold text-slate-600">{PRODUCT_NAME}</span>
          <span className="text-[11px] text-slate-400">
            Candidate identity verification for examination boards and institutions
          </span>
        </div>
      </footer>
    </div>
  )
}
