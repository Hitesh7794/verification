import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth.jsx'
import { Button } from './ui.jsx'

export default function AppShell({ title, subtitle, children }) {
  const { user, logout } = useAuth()
  const nav = useNavigate()

  function handleLogout() {
    const role = user?.role
    logout()
    nav(`/${role || ''}/login`)
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-7xl px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-indigo-600 flex items-center justify-center">
              <span className="text-white font-bold">NV</span>
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-900">{title}</p>
              {subtitle && (
                <p className="text-xs text-slate-500">{subtitle}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <p className="text-sm font-medium text-slate-900">
                {user?.display_name}
              </p>
              <p className="text-xs text-slate-500 capitalize">{user?.role}</p>
            </div>
            <Button variant="secondary" size="sm" onClick={handleLogout}>
              Sign out
            </Button>
          </div>
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
