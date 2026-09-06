import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Link, useNavigate } from 'react-router-dom'
import AdminTabs from './AdminTabs.jsx'
import { BrandMark } from '../ui/brand.jsx'
import { api } from '../../lib/api.js'
import { useAuth } from '../../lib/auth.jsx'
import { Icon, Pill } from '../ui/extras.jsx'

// AdminShell — page chrome for every /admin/* surface.
//
// Two responsibilities:
//   1. Render AdminTabs + a max-width main region with page fade-in.
//   2. Gate every admin page on the org's KYC review state. On mount
//      we fetch /api/admin/kyc-status; if the state isn't 'approved'
//      (or 'unknown' — legacy orgs), we render the lock screen INSTEAD
//      of the child page. AdminTabs and the wallet widget stay hidden
//      too — the applicant sees a single-purpose status page.
//
// Usage:
//
//   <AdminShell>
//     <PageHead eyebrow="Overview" title="My dashboard" right={...} />
//     ...page content
//   </AdminShell>

export default function AdminShell({ children, walletRefreshKey, onWalletBalanceChange }) {
  const [kyc, setKyc] = useState(null)   // null while loading; then object
  const [kycErr, setKycErr] = useState(false)

  useEffect(() => {
    let alive = true
    api('/admin/kyc-status')
      .then((r) => { if (alive) setKyc(r) })
      .catch(() => { if (alive) setKycErr(true) })
    return () => { alive = false }
  }, [])

  // While the status is loading, render a neutral page so we don't
  // flash the (potentially blocked) child content for a moment.
  if (kyc === null && !kycErr) {
    return (
      <div className="min-h-full bg-warm-page flex items-center justify-center">
        <div className="text-sm text-slate-500 animate-pulse">Loading your portal…</div>
      </div>
    )
  }

  // Belt-and-braces: if the status probe itself failed (network, 5xx),
  // fall through to the full shell — the underlying page requests will
  // fail loudly anyway, and locking on a transient blip is worse UX.
  const state = kycErr ? 'approved' : (kyc?.state || 'unknown')
  const showLock = state === 'pending' || state === 'rejected'

  if (showLock) {
    return <KYCLockScreen kyc={kyc} />
  }

  return (
    <div className="min-h-full bg-warm-page">
      <AdminTabs
        walletRefreshKey={walletRefreshKey}
        onWalletBalanceChange={onWalletBalanceChange}
      />
      <motion.main
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        className="mx-auto max-w-7xl px-6 py-8"
      >
        {children}
      </motion.main>
    </div>
  )
}

// KYCLockScreen — the whole viewport when the admin's KYC isn't yet
// approved. No AdminTabs, no nav, just a single-purpose status card
// with a sign-out affordance. Copy adapts based on state:
//   - 'pending'  → 'we're reviewing, you'll get an email'
//   - 'rejected' → shows the reviewer's note + 'contact the platform team'
function KYCLockScreen({ kyc }) {
  const { user, logout } = useAuth()
  const nav = useNavigate()
  const isPending  = kyc?.state === 'pending'
  const isRejected = kyc?.state === 'rejected'

  function onLogout() {
    logout()
    nav('/admin/login', { replace: true })
  }

  return (
    <div className="min-h-full bg-warm-page">
      <header className="sticky top-0 z-40 bg-ink-chrome">
        <div className="mx-auto max-w-7xl px-6 h-16 flex items-center gap-4">
          <div className="flex items-center gap-2.5">
            <BrandMark size={26} tone="inverse" />
            <div className="flex flex-col leading-tight">
              <span className="font-display text-[14px] font-extrabold text-white tracking-[-0.02em]">Verification Portal</span>
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-300/90">Admin</span>
            </div>
          </div>
          <div className="flex-1" />
          {user?.display_name && (
            <span className="hidden md:inline text-[12px] text-slate-300 truncate max-w-[220px]">
              {user.display_name}
            </span>
          )}
          <button
            onClick={onLogout}
            className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-slate-200 hover:text-white bg-white/8 hover:bg-white/16 ring-1 ring-inset ring-white/15 px-3 py-1.5 rounded-lg transition-colors"
          >
            Sign out
          </button>
        </div>
      </header>

      <motion.main
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
        className="mx-auto max-w-2xl px-6 py-16"
      >
        <div className="rounded-2xl bg-warm-surface ring-1 ring-warm shadow-sm overflow-hidden">
          <div className={`h-1 ${isRejected ? 'bg-rose-600' : 'bg-amber-500'}`} />
          <div className="p-8 sm:p-10">
            <div className="flex items-start gap-4">
              <span className={`h-12 w-12 rounded-xl flex items-center justify-center shrink-0 ${
                isRejected
                  ? 'bg-rose-50 text-rose-700 border border-rose-200'
                  : 'bg-amber-50 text-amber-700 border border-amber-200'
              }`}>
                {isRejected ? <Icon.X className="h-6 w-6" /> : <Icon.ShieldCheck className="h-6 w-6" />}
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="text-xl sm:text-2xl font-semibold text-ink-900 tracking-tight">
                    {isRejected ? 'Registration not approved' : 'Registration under review'}
                  </h1>
                  <Pill tone={isRejected ? 'rose' : 'amber'} dot>
                    {isRejected ? 'Rejected' : 'Pending review'}
                  </Pill>
                </div>
                {kyc?.institution_name && (
                  <p className="mt-1 text-sm text-stone-600">
                    Institution: <span className="font-medium text-stone-900">{kyc.institution_name}</span>
                  </p>
                )}
              </div>
            </div>

            <div className="mt-6 space-y-4 text-sm text-stone-700 leading-relaxed">
              {isPending && (
                <>
                  <p>
                    Your KYC application is in the review queue. We'll email you the moment the review lands
                    — usually within 48 hours.
                  </p>
                  <p>
                    Access to verification agents, exams, wallet, and downloads unlocks automatically after
                    approval. Nothing you need to do right now.
                  </p>
                  {kyc?.submitted_at && (
                    <p className="text-xs text-stone-500">
                      Submitted on {new Date(kyc.submitted_at).toLocaleString('en-IN')}.
                    </p>
                  )}
                </>
              )}
              {isRejected && (
                <>
                  <p>
                    Your registration was reviewed and not approved. The reviewer's note:
                  </p>
                  <blockquote className="rounded-lg bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-800">
                    {kyc?.review_note?.trim() ? kyc.review_note : '(no reason provided)'}
                  </blockquote>
                  <p>
                    You can edit the details the reviewer flagged, replace or re-upload documents,
                    and re-submit the same application below. Your account stays the same — no need to
                    register again.
                  </p>
                  {kyc?.reviewed_at && (
                    <p className="text-xs text-stone-500">
                      Reviewed on {new Date(kyc.reviewed_at).toLocaleString('en-IN')}.
                    </p>
                  )}
                  <div className="pt-2">
                    <Link
                      to="/admin/kyc-resubmit"
                      className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 text-white text-sm font-semibold px-4 py-2 hover:bg-brand-700 transition-colors"
                    >
                      Re-submit application
                      <Icon.ChevronRight className="h-4 w-4" />
                    </Link>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-stone-500">
          Have a different account? <Link to="/admin/login" className="text-stone-900 font-semibold hover:underline">Sign in with another user</Link>.
        </p>
      </motion.main>
    </div>
  )
}

// PageHead — title strip used at the top of each admin page. Matches
// the SuperShell PageHead visually so the two portals feel like one
// family, differentiated only by the tab strip up top.
export function PageHead({ eyebrow, title, subtitle, right }) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        {eyebrow && (
          <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-600 mb-1.5">
            {eyebrow}
          </p>
        )}
        <h1 className="text-2xl font-semibold text-ink-900 tracking-tight">
          {title}
        </h1>
        {subtitle && (
          <p className="text-sm text-stone-500 mt-1 max-w-2xl">{subtitle}</p>
        )}
      </div>
      {right && <div className="flex items-center gap-2 shrink-0">{right}</div>}
    </div>
  )
}
