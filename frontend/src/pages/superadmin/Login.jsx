import LoginShell from '../../components/shell/LoginShell.jsx'

export default function SuperLogin() {
  return (
    <LoginShell
      portalTitle="Platform Superadmin"
      portalSubtitle="Cross-organization oversight: organizations, exams, operators and verification telemetry."
      expectedRole="superadmin"
      redirectTo="/superadmin"
      accent="slate"
      demo="super / super123"
    />
  )
}
