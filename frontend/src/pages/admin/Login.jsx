import LoginShell from '../../components/shell/LoginShell.jsx'

// AdminLogin accepts both 'admin' (verification org admin) and
// 'ops_admin' (institution onboarding admin) accounts, because the
// ops mode build reuses this screen as its login. Routes per role:
//   admin     → /admin (verification dashboards)
//   ops_admin → /superadmin/applications (registration queue)
// The role mismatch error is suppressed when *either* role logs in.
export default function AdminLogin() {
  const MODE = (typeof import.meta.env !== 'undefined' && import.meta.env.VITE_APP_MODE) || 'all'
  // In ops mode only ops_admin should sign in here. In other modes
  // (verify, dev), this stays the admin login screen.
  const expectedRoles = MODE === 'ops'
    ? ['ops_admin']
    : MODE === 'verify'
    ? ['admin']
    : ['admin', 'ops_admin'] // dev mode: be permissive
  const demo = MODE === 'ops' ? 'ops / ops123' : 'admin / admin123'
  return (
    <LoginShell
      portalTitle="Exam Administrator Portal"
      expectedRoles={expectedRoles}
      redirectByRole={{
        admin: '/admin',
        ops_admin: '/superadmin/applications',
      }}
      accent={MODE === 'ops' ? 'violet' : 'emerald'}
      demo={demo}
      showRegisterLink={MODE !== 'ops'}
    />
  )
}
