import LoginShell from '../../components/shell/LoginShell.jsx'

// AdminLogin — verification-org admin sign-in. The ops_admin role
// that used to share this screen was retired 2026-08-27, so the
// role list is now admin-only regardless of MODE.
export default function AdminLogin() {
  const MODE = (typeof import.meta.env !== 'undefined' && import.meta.env.VITE_APP_MODE) || 'all'
  return (
    <LoginShell
      portalTitle="Exam Administrator Portal"
      expectedRoles={['admin']}
      redirectByRole={{
        admin: '/admin',
      }}
      accent={MODE === 'ops' ? 'violet' : 'emerald'}
      demo="admin / admin123"
      showRegisterLink={MODE !== 'ops'}
    />
  )
}
