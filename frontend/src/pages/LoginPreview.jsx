import { useParams } from 'react-router-dom'
import LoginShell from '../components/shell/LoginShell.jsx'
import LoginShellPanel from '../components/login/LoginShellPanel.jsx'

// Design preview: /preview/login/a/admin, /preview/login/b/operator, …
// A = companion version, B = panel version. Same form, same behaviour.
const ROLES = {
  admin:      { expectedRoles: ['admin'], redirectByRole: { admin: '/admin' }, showRegisterLink: true },
  operator:   { expectedRoles: ['client'], redirectByRole: { client: '/institute/operator' } },
  reviewer:   { expectedRoles: ['client_reviewer'], redirectByRole: { client_reviewer: '/reviewer' } },
  superadmin: { expectedRoles: ['superadmin'], redirectByRole: { superadmin: '/superadmin' } },
}

export default function LoginPreview() {
  const { version, role } = useParams()
  const cfg = ROLES[role] || ROLES.admin
  const Shell = version === 'b' ? LoginShellPanel : LoginShell
  return <Shell {...cfg} />
}
