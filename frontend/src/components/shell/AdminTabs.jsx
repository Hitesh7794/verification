import { NavLink } from 'react-router-dom'

// Sub-navigation strip for admin pages. Rendered just under PageHeader
// inside each admin route. Two tabs: Overview (verification stats +
// wallet) and Operators (centre staff management).
//
// Underline-on-active styling lifts straight from Linear / Tailwind UI
// admin patterns — it's calmer than the pill-button alternative and
// reads as in-context navigation rather than a CTA.

const tabs = [
  { to: '/admin',                 label: 'Overview',        end: true  },
  { to: '/admin/catalog',         label: 'Exam catalog',    end: false },
  { to: '/admin/my-exams',        label: 'My exams',        end: false },
  { to: '/admin/operators',       label: 'Operators',       end: false },
  { to: '/admin/history',         label: 'History',         end: false },
  { to: '/admin/operator-access', label: 'Shared login',    end: false },
  { to: '/admin/downloads',       label: 'Downloads',       end: false },
]

export default function AdminTabs() {
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
