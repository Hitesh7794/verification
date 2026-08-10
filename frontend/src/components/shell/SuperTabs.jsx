import { NavLink } from 'react-router-dom'

// Sub-navigation strip for superadmin pages. Mirrors AdminTabs styling
// so the two role dashboards feel like the same product.
//
//   Overview      → /superadmin           (verification metrics)
//   Clients       → /superadmin/clients   (exam catalog root — Phase 1)
//   Applications  → /superadmin/applications (institution KYC queue)

const tabs = [
  { to: '/superadmin',              label: 'Overview',     end: true  },
  { to: '/superadmin/clients',      label: 'Clients',      end: false },
  { to: '/superadmin/applications', label: 'Applications', end: false },
]

export default function SuperTabs() {
  return (
    <nav className="mb-6 border-b border-slate-200">
      <ul className="flex gap-6">
        {tabs.map((t) => (
          <li key={t.to}>
            <NavLink
              to={t.to}
              end={t.end}
              className={({ isActive }) =>
                'inline-flex items-center px-1 py-2.5 text-sm font-medium border-b-2 transition ' +
                (isActive
                  ? 'border-indigo-600 text-indigo-700'
                  : 'border-transparent text-slate-500 hover:text-slate-800 hover:border-slate-300')
              }
            >
              {t.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}
