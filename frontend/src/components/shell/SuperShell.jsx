import { useNavigate } from 'react-router-dom'
import FvSideShell, { FvPageHead } from '../fv/FvSideShell.jsx'
import { IconGrid, IconFile, IconBook } from '../fv/FvAdminShell.jsx'
import { useAuth } from '../../lib/auth.jsx'

// SuperShell — the super admin's frame, in the FlatViolet redesign: the
// shared sidebar (FvSideShell) with the three super admin sections.
// Sign-out clears the stored session the same way the old top bar did.
//
// Route surface (kept in sync with server.go /api/super* + /api/superadmin/*):
//   Overview      → /superadmin               (verification metrics)
//   Applications  → /superadmin/applications  (institution KYC queue)
//   Clients       → /superadmin/clients       (exam catalog root)

const NAV = [
  { to: '/superadmin', label: 'Overview', end: true, icon: IconGrid, guide: 'Checks across every institution on the portal.' },
  { to: '/superadmin/applications', label: 'Applications', icon: IconFile, guide: 'Institutions waiting for their KYC to be reviewed.' },
  { to: '/superadmin/clients', label: 'Clients', icon: IconBook, guide: 'Exam boards and the exams they run on the portal.' },
]

export default function SuperShell({ children }) {
  const nav = useNavigate()
  const { user } = useAuth() || {}

  function onLogout() {
    try {
      localStorage.removeItem('token')
      localStorage.removeItem('role_scope')
      sessionStorage.clear()
    } catch { /* ignore quota / privacy-mode errors */ }
    nav('/superadmin/login', { replace: true })
  }

  return (
    <FvSideShell
      bold
      guide={false}
      // One scene, not two, and not as a ghost: the crowd canvas used to
      // run underneath the country board and the pair read as smudges.
      // The board is now a panel on the overview, where it can be seen.
      // Every page keeps the turning chakra.
      backdrop="none"
      subtitle="Super admin"
      nav={NAV}
      user={{ name: user?.name || user?.username || 'Super admin', role: 'Super admin' }}
      onSignOut={onLogout}
    >
      {children}
    </FvSideShell>
  )
}

// Kept for the pages that import it: the FlatViolet page head. The old
// all-caps eyebrow becomes a small plain line in the accent.
export function PageHead({ eyebrow, title, subtitle, right, art }) {
  return <FvPageHead eyebrow={eyebrow} title={title} subtitle={subtitle} right={right} art={art} />
}

// A section title inside a page: sentence case, a hairline under it.
export function SectionHead({ title, count, right }) {
  return (
    <div className="mb-3.5 flex items-baseline justify-between gap-4 border-b border-fv-line pb-2.5">
      <div className="flex items-baseline gap-2.5">
        <h2 className="fv-display text-[18px] font-bold tracking-[-0.015em] text-fv-ink">{title}</h2>
        {typeof count === 'number' && (
          <span className="rounded-full bg-fv-card-focus px-2 py-0.5 text-[12px] font-semibold text-fv-accent-deep tabular-nums">
            {count}
          </span>
        )}
      </div>
      {right && <div className="flex items-center gap-2">{right}</div>}
    </div>
  )
}
