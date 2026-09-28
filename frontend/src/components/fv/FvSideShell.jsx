import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import SignOutConfirm from '../shell/SignOutConfirm.jsx'
import FvBackdrop from './FvBackdrop.jsx'
import FvGuide from './FvGuide.jsx'
import { AdminAvatar, IconOut } from './FvAdminShell.jsx'

// FvSideShell — the FlatViolet frame for every signed-in role that works
// from a sidebar (super admin, reviewer; the institution admin has its own
// FvAdminShell with the wallet). Same bones as the admin frame:
//
//   · white sidebar: the product name set large, the role/organisation
//     under it, the menu, an optional `extra` block, who's signed in
//   · the State Emblem, faint, behind the menu
//   · the living background (the chakra and the checkpoint queue)
//   · the guide, who pops out beside anything marked data-guide
//
// Props
//   title      big line in the brand block (default "Verification Portal")
//   subtitle   the line under it (an organisation or a role)
//   brandArt   optional node shown above the title (a board's lockup)
//   nav        [{ to, label, end, icon, guide }]
//   extra      optional node between the menu and the profile row
//   user       { name, role }
//   onSignOut  called after the sign-out is confirmed
//   actions    optional node beside the sign-out button (e.g. support)

export default function FvSideShell({
  children, title = 'Verification Portal', subtitle, brandArt, nav = [], extra, user = {}, onSignOut, actions,
  bold = false, scene = null, guide = true, guideTour = false, backdrop = 'queue',
}) {
  const [confirmOut, setConfirmOut] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const name = user.name || 'Signed in'

  return (
    <div className="fv fv-shell tricolour-top min-h-screen overflow-x-clip">
      <FvBackdrop variant={backdrop} />
      {scene}
      <div className="relative z-[1] grid min-h-screen grid-cols-1 lg:grid-cols-[248px_minmax(0,1fr)] xl:grid-cols-[264px_minmax(0,1fr)]">
        <aside className="hidden lg:flex sticky top-0 isolate h-screen flex-col overflow-hidden bg-fv-card border-r border-fv-line px-4 pt-5 pb-3">
          <span aria-hidden="true" className="fv-emblem pointer-events-none absolute left-1/2 top-[44%] -z-10 h-[62%] -translate-x-1/2 -translate-y-1/2 opacity-[0.045]" />
          <div className="px-2" data-guide-title={title} data-guide="The portal that confirms every candidate is who they say they are.">
            {brandArt && <div className="mb-3">{brandArt}</div>}
            <p className="fv-display text-[21px] font-bold leading-[1.05] tracking-[-0.02em] text-fv-ink">{title}</p>
            {subtitle && <p className="mt-1 text-[14px] font-medium leading-tight text-fv-accent-deep truncate">{subtitle}</p>}
          </div>

          <nav className="mt-5 flex flex-col gap-0.5" aria-label="Main">
            {nav.map(({ to, label, end, icon: Ic, guide }) => (
              <NavLink
                key={to} to={to} end={end} data-guide={guide} data-guide-title={guide ? label : undefined}
                className={({ isActive }) =>
                  `group relative flex items-center gap-3 rounded-[10px] px-3 py-2 text-[15px] font-medium transition-colors
                   ${isActive ? 'bg-fv-card-focus text-fv-accent-deep' : 'text-fv-muted hover:bg-fv-page hover:text-fv-ink'}`}
              >
                {({ isActive }) => (
                  <>
                    {isActive && <span aria-hidden="true" className="absolute -left-4 top-2 bottom-2 w-[3px] rounded-r bg-fv-accent" />}
                    {Ic && <Ic className={`h-[18px] w-[18px] shrink-0 ${isActive ? 'text-fv-accent' : 'text-fv-faint group-hover:text-fv-muted'}`} />}
                    {label}
                  </>
                )}
              </NavLink>
            ))}
          </nav>

          <div className="flex-1" />
          {extra}

          <div className="mt-2 flex items-center gap-3 rounded-[10px] px-2 py-1.5"
               data-guide={`You're signed in as ${name}. The arrow signs you out.`} data-guide-title={name}>
            <AdminAvatar className="h-10 w-10 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="fv-display text-[15.5px] font-bold leading-tight tracking-[-0.01em] text-fv-ink truncate">{name}</p>
              {user.role && <p className="text-[12.5px] font-medium leading-tight text-fv-accent truncate">{user.role}</p>}
            </div>
            {actions}
            <button type="button" onClick={() => setConfirmOut(true)} aria-label="Sign out"
                    className="grid h-8 w-8 place-items-center rounded-full text-fv-faint hover:bg-fv-page hover:text-fv-ink transition-colors">
              <IconOut className="h-[18px] w-[18px]" />
            </button>
          </div>
        </aside>

        <main className="relative min-w-0 px-4 pt-5 pb-12 sm:px-7 lg:pt-7 xl:px-9">
                  {/* Narrow screens: a bar with the menu behind a button. */}
<div className="lg:hidden -mx-4 -mt-5 mb-5 sticky top-0 z-30 flex items-center gap-3 border-b border-fv-line bg-fv-card px-4 py-3">
          <button type="button" onClick={() => setMenuOpen(true)} aria-label="Open menu"
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] border border-fv-line text-fv-accent-deep">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
          </button>
          <div className="min-w-0 flex-1">
            <p className="fv-display text-[17px] font-bold leading-tight tracking-[-0.02em] text-fv-ink truncate">{title}</p>
          </div>
        </div>

          <div className={`relative z-[1] mx-auto max-w-[1320px] fv-page-enter ${bold ? 'fv-bold' : ''}`}>{children}</div>
        </main>
      </div>

      {/* The menu, as a drawer on narrow screens. */}
      {menuOpen && (
        <div className="lg:hidden fixed inset-0 z-50" role="dialog" aria-label="Menu">
          <button type="button" aria-label="Close menu" onClick={() => setMenuOpen(false)}
                  className="absolute inset-0 bg-fv-ink/35" />
          <div className="absolute inset-y-0 left-0 w-[290px] max-w-[85vw] overflow-y-auto bg-fv-card p-4">
            <p className="fv-display mb-1 px-2 text-[19px] font-bold tracking-[-0.02em] text-fv-ink">{title}</p>
            {subtitle && <p className="mb-4 px-2 text-[14px] font-medium text-fv-accent-deep">{subtitle}</p>}
            <nav className="flex flex-col gap-0.5" aria-label="Main">
              {nav.map(({ to, label, end, icon: Ic }) => (
                <NavLink key={to} to={to} end={end} onClick={() => setMenuOpen(false)}
                  className={({ isActive }) => `flex items-center gap-3 rounded-[10px] px-3 py-2.5 text-[15px] font-medium ${isActive ? 'bg-fv-card-focus text-fv-accent-deep' : 'text-fv-muted'}`}>
                  {Ic && <Ic className="h-[18px] w-[18px] shrink-0" />}{label}
                </NavLink>
              ))}
            </nav>
          </div>
        </div>
      )}

      {guide && <FvGuide tour={guideTour} />}
      <SignOutConfirm
        open={confirmOut}
        onCancel={() => setConfirmOut(false)}
        onConfirm={() => { setConfirmOut(false); onSignOut?.() }}
      />
    </div>
  )
}

// A page head in the same voice everywhere: the title in the display cut,
// a plain-language line under it, an optional illustration beside it.
export function FvPageHead({ title, subtitle, art: Art, right, eyebrow }) {
  return (
    <div className="mb-6 flex items-center justify-between gap-5">
      <div className="flex min-w-0 items-center gap-4">
        {Art && <Art className="h-14 w-14 shrink-0" />}
        <div className="min-w-0">
          {eyebrow && <p className="mb-0.5 text-[13.5px] font-semibold text-fv-accent">{eyebrow}</p>}
          <h1 className="fv-display text-[30px] font-bold leading-[1.05] tracking-[-0.03em] text-fv-ink">{title}</h1>
          {subtitle && <p className="mt-1 max-w-2xl text-[15px] leading-snug text-fv-muted">{subtitle}</p>}
        </div>
      </div>
      {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
    </div>
  )
}
