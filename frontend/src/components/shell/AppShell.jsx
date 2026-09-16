import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../lib/auth.jsx'
import WalletWidget from '../wallet/WalletWidget.jsx'
import AvatarMenu from './AvatarMenu.jsx'
import { Brand, PRODUCT_NAME } from '../ui/brand.jsx'
import ReportProblem from '../support/ReportProblem.jsx'
import SignOutConfirm from './SignOutConfirm.jsx'

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
//
// V30 (2026-09-14): every sign-out affordance runs through
// <SignOutConfirm>. Callers passing a `customHeader` get a
// `requestSignOut` in the render slot — invoking it opens the same
// confirmation dialog the default header uses, so no header variant
// can accidentally sign a user out without asking.
export default function AppShell({
  children,
  walletRefreshKey,
  onWalletBalanceChange,
  fullWidth = false,
  customHeader = null,
  customFooter = null,
}) {
  const { user, logout } = useAuth()
  const nav = useNavigate()
  const [confirmingSignOut, setConfirmingSignOut] = useState(false)

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

  const requestSignOut = () => setConfirmingSignOut(true)

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
    <div className="min-h-screen flex flex-col justify-between bg-[#F1F4F8] text-[#0B1F3A]">
      {customHeader ? (
        typeof customHeader === 'function' ? (
          customHeader({ user, handleLogout: requestSignOut, ReportProblem, AvatarMenu })
        ) : (
          customHeader
        )
      ) : (
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
              <ReportProblem />
              <AvatarMenu user={user} onLogout={requestSignOut} />
            </div>
          </div>
          <div className="h-[2px] rule-gold" />
        </header>
      )}

      <main className="flex-1 w-full">
        <div className={fullWidth ? 'w-full px-4 sm:px-8 lg:px-10 py-5 space-y-5 animate-surface-in' : 'mx-auto max-w-7xl px-6 py-8 animate-surface-in'}>
          {children}
        </div>
      </main>

      {customFooter ? (
        typeof customFooter === 'function' ? (
          customFooter({ user, handleLogout: requestSignOut, ReportProblem, AvatarMenu })
        ) : (
          customFooter
        )
      ) : (
        <footer className="border-t border-slate-200 bg-white">
          <div className="mx-auto max-w-7xl px-6 py-4 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-600">{PRODUCT_NAME}</span>
            <span className="text-[11px] text-slate-400">
              Candidate identity verification for examination boards and institutions
            </span>
          </div>
        </footer>
      )}

      <SignOutConfirm
        open={confirmingSignOut}
        onCancel={() => setConfirmingSignOut(false)}
        onConfirm={() => { setConfirmingSignOut(false); handleLogout() }}
      />
    </div>
  )
}
