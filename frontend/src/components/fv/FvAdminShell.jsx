import { useEffect, useRef, useState } from 'react'
import { NavLink } from 'react-router-dom'
import AdminShell from '../shell/AdminShell.jsx'
import SignOutConfirm from '../shell/SignOutConfirm.jsx'
import DepositModal from '../wallet/DepositModal.jsx'
import { useAuth } from '../../lib/auth.jsx'
import { api } from '../../lib/api.js'
import { getWallet, getWalletConfig, formatRupees } from '../../lib/wallet/wallet.js'
import FvGuide from './FvGuide.jsx'
import FvBackdrop from './FvBackdrop.jsx'
import ReportProblem from '../support/ReportProblem.jsx'

// FvAdminShell — the institution admin's frame in the FlatViolet redesign.
//
// A white sidebar on the left: the State Emblem and product name, the seven
// sections in plain words, the wallet (always in view, with Top up), and who
// is signed in. The page sits on the flat page colour to the right, under
// the tiranga ribbon. Flat: hairlines, 12px corners, no shadows.
//
// KYC: until the institution is approved this defers to the existing
// AdminShell, which owns the locked-screen flow.

// Module-level cache for the KYC + wallet + agents responses. The
// shell re-mounts every time the admin switches route (Overview ⇄ My
// exams ⇄ …), so without this each hop restarts the fetch and the
// sidebar's institution name briefly falls back to
// `user.organization_name` ("Institute") before the real value
// ("SSC") lands — a visible flicker. Keeping the last-known values in
// module scope lets the next mount hydrate synchronously; the fetches
// still run in the background to pick up server-side changes.
let kycCache = undefined
let walletCache = null
let cfgCache = null
let agentsCache = null
let cachedFor = null   // the user id/username the cache belongs to
function clearShellCache() { kycCache = undefined; walletCache = null; cfgCache = null; agentsCache = null; cachedFor = null }

const NAV = [
  { to: '/admin', label: 'Overview', end: true, icon: IconGrid, guide: 'Your institution at a glance: today\'s checks, totals and the latest verifications.' },
  { to: '/admin/catalog', label: 'Exam catalog', icon: IconBook, guide: 'Every exam running on the platform, from every exam board.' },
  { to: '/admin/my-exams', label: 'My exams', icon: IconFile, guide: 'The exams your institution is approved to verify candidates for.' },
  { to: '/admin/operators', label: 'Agents', icon: IconPeople, guide: 'Your verification agents. Add them, give them exams and set how much they can spend.' },
  { to: '/admin/history', label: 'History', icon: IconClock, guide: 'Every verification your agents have run, with the report for each one.' },
  { to: '/admin/products', label: 'Devices', icon: IconDevice, guide: 'The fingerprint scanners, iris scanners and cameras that work with the portal.' },
  { to: '/admin/downloads', label: 'Downloads', icon: IconDownload, guide: 'The desktop app and drivers your agents\' laptops need.' },
]

export default function FvAdminShell({ children, onWallet, fit = false }) {
  const { user, logout } = useAuth()
  // Drop the cache the moment a different user is seen — otherwise a
  // re-login as another institution would show the previous
  // institution's name until the fetches came back. Runs before
  // useState so this render sees the cleared values.
  const userKey = user?.id ?? user?.username ?? null
  if (cachedFor && cachedFor !== userKey) clearShellCache()
  cachedFor = userKey

  // Seed each piece of shell state from the module cache so a route
  // switch has the previous values immediately — no flicker while the
  // background refetch resolves.
  const [kyc, setKyc] = useState(kycCache)
  const [wallet, setWallet] = useState(walletCache)
  const [cfg, setCfg] = useState(cfgCache)
  const [depositOpen, setDepositOpen] = useState(false)
  const [confirmOut, setConfirmOut] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [agents, setAgents] = useState(agentsCache)

  useEffect(() => {
    api('/admin/kyc-status').then((r) => { kycCache = r; setKyc(r) }).catch(() => {
      const fallback = { state: 'approved' }
      kycCache = kycCache || fallback
      setKyc(kycCache)
    })
    getWallet().then((r) => { walletCache = r; setWallet(r) }).catch(() => {})
    getWalletConfig().then((r) => { cfgCache = r; setCfg(r) }).catch(() => {})
    api('/admin/operators').then((r) => {
      const list = r?.operators || []
      agentsCache = list; setAgents(list)
    }).catch(() => { if (!agentsCache) { agentsCache = []; setAgents([]) } })
  }, [])
  useEffect(() => { if (wallet) onWallet?.(wallet) }, [wallet, onWallet])

  if (kyc && kyc.state !== 'approved') return <AdminShell>{children}</AdminShell>

  const name = user?.name || user?.username || 'Administrator'
  const org = kyc?.institution_name || user?.organization_name || 'Your institution'
  const balance = wallet?.balance_paise || 0
  const fee = cfg?.fee_per_lookup_paise || 0
  const lookups = fee > 0 ? Math.floor(balance / fee) : null
  const low = fee > 0 && balance < fee * 20

  return (
    <div className={`fv fv-shell tricolour-top ${fit ? 'min-h-screen lg:h-screen lg:overflow-hidden' : 'min-h-screen'} overflow-x-clip`}>
      {/* The living background, over the whole screen. */}
      <FvBackdrop />
      {/* The page. Nothing in it moves to make room for the guide. */}
      <div className="relative z-[1] grid min-h-screen grid-cols-1 lg:grid-cols-[248px_minmax(0,1fr)] xl:grid-cols-[264px_minmax(0,1fr)]">
      {/* ── Sidebar ─────────────────────────────────────────────── */}
      <aside className="hidden lg:flex sticky top-0 isolate h-screen flex-col overflow-hidden bg-fv-card border-r border-fv-line px-4 pt-5 pb-3">
        {/* The State Emblem, faint behind the menu, like the chakra behind the page. */}
        <span aria-hidden="true" className="fv-emblem pointer-events-none absolute left-1/2 top-[44%] -z-10 h-[62%] -translate-x-1/2 -translate-y-1/2 opacity-[0.045]" />
        <div className="px-2" data-guide-title="Verification Portal"
             data-guide="The portal your institution uses to confirm every candidate is who they say they are.">
          <p className="fv-display text-[21px] font-bold leading-[1.05] tracking-[-0.02em] text-fv-ink">Verification Portal</p>
          <p className="mt-1 text-[14px] font-medium leading-tight text-fv-accent-deep truncate">{org}</p>
        </div>

        <nav className="mt-5 flex flex-col gap-0.5" aria-label="Admin">
          {NAV.map(({ to, label, end, icon: Ic, guide }) => (
            <NavLink
              key={to} to={to} end={end} data-guide={guide} data-guide-title={label}
              className={({ isActive }) =>
                `group relative flex items-center gap-3 rounded-[10px] px-3 py-2 text-[15px] font-medium transition-colors
                 ${isActive ? 'bg-fv-card-focus text-fv-accent-deep' : 'text-fv-muted hover:bg-fv-page hover:text-fv-ink'}`}
            >
              {({ isActive }) => (
                <>
                  {isActive && <span aria-hidden="true" className="absolute -left-4 top-2 bottom-2 w-[3px] rounded-r bg-fv-accent" />}
                  <Ic className={`h-[18px] w-[18px] shrink-0 ${isActive ? 'text-fv-accent' : 'text-fv-faint group-hover:text-fv-muted'}`} />
                  {label}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        {/* Your agents, filling the strip between the menu and the wallet. */}
        <AgentsStrip agents={agents} />

        {/* Wallet, always in view. */}
        <WalletBlock
          wallet={wallet} balance={balance} fee={fee} lookups={lookups} low={low}
          canTopUp={!!cfg} onTopUp={() => setDepositOpen(true)}
        />

        {/* User card + action cluster. Sign-out picks up the same
            ringed chip style as the support button so the two read as
            one matched pair, not a chip and an orphaned icon. A
            hairline above separates the card from the wallet. */}
        <div className="mt-3 flex items-center gap-3 rounded-[10px] border-t border-fv-line px-2 pt-3 pb-1.5"
             data-guide="You're signed in as the administrator. The headset reports a problem; the arrow signs you out." data-guide-title={name}>
          <AdminAvatar className="h-10 w-10 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="fv-display text-[15.5px] font-bold leading-tight tracking-[-0.01em] text-fv-ink truncate">{name}</p>
            <p className="text-[12.5px] font-medium leading-tight text-fv-accent">Administrator</p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <ReportProblem />
            <button
              type="button"
              onClick={() => setConfirmOut(true)}
              aria-label="Sign out"
              title="Sign out"
              className="grid h-9 w-9 place-items-center rounded-full bg-fv-card ring-1 ring-inset ring-fv-line text-fv-faint transition-colors hover:bg-fv-page hover:text-fv-ink hover:ring-fv-accent-soft focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fv-accent"
            >
              <IconOut className="h-[18px] w-[18px]" />
            </button>
          </div>
        </div>
      </aside>

      {/* ── Page ─────────────────────────────────────────────────── */}
      {fit ? (
        <main className="relative min-w-0 px-4 pt-5 pb-4 lg:h-screen lg:overflow-hidden xl:px-5">
                  {/* Narrow screens: a bar with the menu behind a button. */}
<div className="lg:hidden -mx-4 -mt-5 mb-4 sticky top-0 z-30 flex items-center gap-3 border-b border-fv-line bg-fv-card px-4 py-3">
          <button type="button" onClick={() => setMenuOpen(true)} aria-label="Open menu"
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] border border-fv-line text-fv-accent-deep">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
          </button>
          <div className="min-w-0 flex-1">
            <p className="fv-display text-[17px] font-bold leading-tight tracking-[-0.02em] text-fv-ink truncate">Verification Portal</p>
          </div>
        </div>

          <div className="relative z-[1] lg:h-full">{children}</div>
        </main>
      ) : (
        <main className="relative min-w-0 px-4 pt-5 pb-14 sm:px-7 lg:pt-9 xl:px-10">
                  {/* Narrow screens: a bar with the menu behind a button. */}
<div className="lg:hidden -mx-4 -mt-5 mb-5 sticky top-0 z-30 flex items-center gap-3 border-b border-fv-line bg-fv-card px-4 py-3">
          <button type="button" onClick={() => setMenuOpen(true)} aria-label="Open menu"
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] border border-fv-line text-fv-accent-deep">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
          </button>
          <div className="min-w-0 flex-1">
            <p className="fv-display text-[17px] font-bold leading-tight tracking-[-0.02em] text-fv-ink truncate">Verification Portal</p>
          </div>
        </div>

          <div className="relative z-[1] mx-auto max-w-[1240px]">{children}</div>
        </main>
      )}

      </div>

      {/* The menu, as a drawer on narrow screens. */}
      {menuOpen && (
        <div className="lg:hidden fixed inset-0 z-50" role="dialog" aria-label="Menu">
          <button type="button" aria-label="Close menu" onClick={() => setMenuOpen(false)}
                  className="absolute inset-0 bg-fv-ink/35" />
          <div className="absolute inset-y-0 left-0 w-[290px] max-w-[85vw] overflow-y-auto bg-fv-card p-4">
            <p className="fv-display mb-4 px-2 text-[19px] font-bold tracking-[-0.02em] text-fv-ink">Verification Portal</p>
            <nav className="flex flex-col gap-0.5" aria-label="Admin">
              {NAV.map(({ to, label, end, icon: Ic }) => (
                <NavLink key={to} to={to} end={end} onClick={() => setMenuOpen(false)}
                  className={({ isActive }) => `flex items-center gap-3 rounded-[10px] px-3 py-2.5 text-[15px] font-medium ${isActive ? 'bg-fv-card-focus text-fv-accent-deep' : 'text-fv-muted'}`}>
                  {Ic && <Ic className="h-[18px] w-[18px] shrink-0" />}{label}
                </NavLink>
              ))}
            </nav>
            <div className="mt-4">
              <WalletBlock wallet={wallet} balance={balance} fee={fee} lookups={lookups} low={low}
                           canTopUp={!!cfg} onTopUp={() => { setMenuOpen(false); setDepositOpen(true) }} />
            </div>
          </div>
        </div>
      )}

      {/* First-login tour only: after it plays once (localStorage-gated),
          the guide goes dormant, so no more hover-to-blur on the admin. */}
      <FvGuide tour />

      {depositOpen && cfg && (
        <DepositModal
          config={cfg}
          currentBalance={balance}
          onClose={() => setDepositOpen(false)}
          onSuccess={(nb) => { setWallet((w) => (w ? { ...w, balance_paise: nb } : w)); setDepositOpen(false); getWallet().then(setWallet).catch(() => {}) }}
        />
      )}
      <SignOutConfirm open={confirmOut} onCancel={() => setConfirmOut(false)}
                      onConfirm={() => { setConfirmOut(false); logout() }} />
    </div>
  )
}

// ── Icons (24px grid, 1.8 stroke, round) ─────────────────────────────
export function svg(props, children) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {children}
    </svg>
  )
}
export function IconGrid(p) { return svg(p, <><rect x="3.5" y="3.5" width="7" height="7" rx="2" /><rect x="13.5" y="3.5" width="7" height="7" rx="2" /><rect x="3.5" y="13.5" width="7" height="7" rx="2" /><rect x="13.5" y="13.5" width="7" height="7" rx="2" /></>) }
export function IconBook(p) { return svg(p, <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z" /><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20v3H6.5" /></>) }
export function IconFile(p) { return svg(p, <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></>) }
export function IconPeople(p) { return svg(p, <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.8-3.4 3.4-5.5 6.5-5.5s5.7 2.1 6.5 5.5" /><circle cx="17" cy="9" r="2.6" /><path d="M16.5 14.6c2.4.2 4.2 2 4.9 4.9" /></>) }
export function IconClock(p) { return svg(p, <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>) }
export function IconDevice(p) { return svg(p, <><rect x="6" y="3" width="12" height="18" rx="3" /><circle cx="12" cy="11" r="3" /><path d="M10 17.5h4" /></>) }
export function IconDownload(p) { return svg(p, <><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5" /><path d="M4.5 19.5h15" /></>) }
export function IconOut(p) { return svg(p, <><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" /><path d="M9 16l-4-4 4-4M5 12h10" /></>) }


// ── Agents strip ──────────────────────────────────────────────────────
// Who works for you: each agent with how much of their spending limit is
// used. Shows as many as fit in the strip; the rest are counted.
function AgentsStrip({ agents }) {
  const ref = useRef(null)
  const [fit, setFit] = useState(3)
  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const ro = new ResizeObserver(() => setFit(Math.max(0, Math.floor((el.clientHeight - 30) / 42))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const list = agents || []
  const shown = list.slice(0, fit)
  return (
    <div ref={ref} className="mt-4 flex min-h-[40px] flex-1 flex-col overflow-hidden border-t border-fv-line px-2 pt-3"
         data-guide-title="Your agents" data-guide="The people who verify candidates for you, and how much of their spending limit each has used.">
      <div className="flex items-baseline justify-between">
        <p className="text-[12.5px] font-semibold text-fv-muted">Your agents</p>
        <NavLink to="/admin/operators" className="text-[12.5px] font-semibold text-fv-accent hover:text-fv-accent-deep">Manage</NavLink>
      </div>
      <ul className="mt-1.5">
        {shown.map((a) => {
          const nm = a.display_name || a.username
          const used = a.spending_cap_paise ? Math.min(1, (a.spent_paise || 0) / a.spending_cap_paise) : 0
          const ini = nm.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()
          return (
            <li key={a.id} className="flex h-[42px] items-center gap-2.5">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-fv-card-focus text-[11.5px] font-bold text-fv-accent-deep">{ini}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="truncate text-[13px] font-semibold text-fv-ink">{nm}</p>
                  <p className="shrink-0 text-[11.5px] tabular-nums text-fv-faint">{Math.round(used * 100)}%</p>
                </div>
                <div className="mt-1 h-[5px] rounded-full bg-fv-card-focus">
                  <div className="h-full rounded-full" style={{ width: `${used * 100}%`, background: used > 0.85 ? '#A8711F' : '#5B3FA6' }} />
                </div>
              </div>
            </li>
          )
        })}
      </ul>
      {list.length > shown.length && (
        <p className="text-[12px] text-fv-muted">{list.length - shown.length} more</p>
      )}
    </div>
  )
}

// ── The administrator, drawn ──────────────────────────────────────────
// A bust in the portal's flat style: violet blazer over a white collar, an
// ID lanyard with its card, on the tint disc.
export function AdminAvatar({ className }) {
  return (
    <svg viewBox="0 0 40 40" className={className} aria-hidden="true">
      <circle cx="20" cy="20" r="20" fill="#DDD5F2" />
      <clipPath id="fv-admin-clip"><circle cx="20" cy="20" r="20" /></clipPath>
      <g clipPath="url(#fv-admin-clip)"><g transform="translate(20 24) scale(1.28) translate(-20 -20)">
        {/* blazer and collar */}
        <path d="M5 42c0-8.5 6.5-13 15-13s15 4.5 15 13z" fill="#5B3FA6" />
        <path d="M15.5 29.6 20 35l4.5-5.4c-1.4-.4-2.9-.6-4.5-.6s-3.1.2-4.5.6z" fill="#FFFFFF" />
        <path d="M15.5 29.6 18 36l2-1-4.5-5.4zM24.5 29.6 22 36l-2-1 4.5-5.4z" fill="#43307D" />
        {/* lanyard and card */}
        <path d="M17.6 30.4 20 37.2l2.4-6.8" fill="none" stroke="#F28C28" strokeWidth="1.3" />
        <rect x="17.6" y="36" width="4.8" height="5" rx="1" fill="#FFFFFF" />
        <rect x="18.4" y="37" width="3.2" height="1" rx=".5" fill="#138808" />
        {/* neck and head */}
        <rect x="17.8" y="24" width="4.4" height="6" rx="2" fill="#C48D66" />
        <circle cx="20" cy="18" r="7.4" fill="#D9A47C" />
        <path d="M12.4 17.6c0-5 3.4-8.2 7.6-8.2s7.6 3.2 7.6 8.2c-1-2.6-3.2-4.4-5.4-4.8-1.4 1.6-5.6 2.6-9.8 4.8z" fill="#211E33" />
        <circle cx="17.3" cy="18.9" r=".9" fill="#211E33" />
        <circle cx="22.7" cy="18.9" r=".9" fill="#211E33" />
        <path d="M17.8 21.8c1.3 1 3.1 1 4.4 0" fill="none" stroke="#211E33" strokeWidth=".9" strokeLinecap="round" />
        <circle cx="12.7" cy="19" r="1.3" fill="#C48D66" />
        <circle cx="27.3" cy="19" r="1.3" fill="#C48D66" /></g>
      </g>
    </svg>
  )
}

// A rupee coin with a plus — "add money".
function CoinPlus({ className }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <circle cx="10.5" cy="12.5" r="8.5" fill="#99641B" />
      <circle cx="10.5" cy="11.5" r="8.5" fill="#F2B04A" />
      <circle cx="10.5" cy="11.5" r="6.2" fill="none" stroke="#FFFFFF" strokeOpacity=".55" strokeWidth="1" />
      <path d="M7.6 8h5.8M7.6 10.2h5.8M9 8c2.6 0 3.4 1 3.4 2.2S11.4 12.5 9 12.5l3.8 3.6" fill="none" stroke="#7A4F12" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="18.5" cy="17.5" r="5" fill="#5B3FA6" stroke="#FFFFFF" strokeWidth="1.5" />
      <path d="M18.5 15.3v4.4M16.3 17.5h4.4" stroke="#FFFFFF" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

// ── Wallet block ──────────────────────────────────────────────────────
// Drawn as a wallet: a violet body with stitching round its edge, a strap
// with a snap on the side, and two rupee notes (saffron and green) peeking
// out of the top — they rise a little on hover. On it: the balance, and
// what it buys, candidates you can still check, as ten small figures that
// fill in (each a tenth of a 200-check exam day). Amber when running low.
function WalletBlock({ wallet, balance, fee, lookups, low, canTopUp, onTopUp }) {
  const DAY = 200
  const filled = lookups == null ? 0 : Math.min(10, Math.round((Math.min(lookups, DAY) / DAY) * 10))
  const body = low ? '#99641B' : '#5B3FA6'
  const strap = low ? '#7A4F12' : '#43307D'
  return (
    <div
      className="group -mx-1 pt-6"
      data-guide={fee ? `Each candidate check costs ${formatRupees(fee)} from this balance. Top up before exam day so your agents never stop.` : 'Your institution\'s balance for candidate checks.'}
      data-guide-title="Wallet"
    >
      <div className="relative">
        {/* Notes, tucked in behind the body. */}
        <Note className="left-5 -top-5 rotate-[-6deg] group-hover:-translate-y-1.5" bg="#F28C28" />
        <Note className="left-14 -top-4 rotate-[4deg] group-hover:-translate-y-2.5" bg="#138808" />

        {/* The body. */}
        <div className="relative rounded-[16px] px-5 pt-5 pb-5 text-white" style={{ background: body }}>
          <span aria-hidden="true" className="pointer-events-none absolute inset-[6px] rounded-[11px] border-[1.5px] border-dashed border-white/35" />
          {/* The strap and its snap, across the right edge. */}
          <span aria-hidden="true" className="absolute -right-1 top-7 h-12 w-12 rounded-l-[12px] rounded-r-[6px]" style={{ background: strap }}>
            <span className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-white/90">
              <span className="absolute inset-[4px] rounded-full" style={{ background: strap }} />
            </span>
          </span>

          <p className="relative text-[13px] font-semibold text-white/80">Wallet</p>
          <p className="relative fv-display mt-1 text-[28px] font-bold leading-none tracking-[-0.02em] tabular-nums">
            {wallet ? formatRupees(balance) : '—'}
          </p>
          {lookups != null && (
            <div className="relative mt-4">
              <div className="flex items-end gap-[5px]" aria-hidden="true">
                {Array.from({ length: 10 }).map((_, i) => <PersonGlyph key={i} on={i < filled} delay={i * 60} />)}
              </div>
              <p className="mt-2 text-[13px] leading-snug text-white/85">
                <span className="font-bold text-white tabular-nums">{lookups.toLocaleString('en-IN')}</span> candidates you can still check, {formatRupees(fee)} each
              </p>
            </div>
          )}
        </div>
      </div>
      <button
        type="button" onClick={onTopUp} disabled={!canTopUp}
        className="group/top mt-3 flex w-full h-11 items-center justify-center gap-2.5 rounded-[12px] border border-fv-line bg-fv-card fv-display text-[16px] font-bold tracking-[-0.015em] text-fv-accent-deep hover:bg-fv-card-focus hover:border-fv-tint transition-colors disabled:opacity-60"
      >
        <CoinPlus className="h-[22px] w-[22px] transition-transform duration-300 group-hover/top:-translate-y-0.5 group-hover/top:rotate-[-8deg]" />
        Top up wallet
      </button>
    </div>
  )
}
function Note({ className = '', bg }) {
  return (
    <span aria-hidden="true"
          className={`absolute h-10 w-[104px] rounded-[4px] transition-transform duration-300 ease-out ${className}`}
          style={{ background: bg }}>
      <span className="absolute inset-[3px] rounded-[2px] border border-white/40" />
      <span className="absolute right-2.5 top-1 fv-display text-[13px] font-bold text-white/85">₹</span>
      <span className="absolute left-2.5 top-2 h-3 w-3 rounded-full border border-white/50" />
    </span>
  )
}
function PersonGlyph({ on, delay }) {
  return (
    <svg viewBox="0 0 12 18" className="h-[18px] w-[12px] transition-opacity duration-500"
         style={{ opacity: on ? 1 : 0.28, transitionDelay: `${delay}ms` }}>
      <circle cx="6" cy="4" r="3.2" fill="white" />
      <path d="M1 17.5c0-4.2 2.2-7 5-7s5 2.8 5 7z" fill="white" />
    </svg>
  )
}
