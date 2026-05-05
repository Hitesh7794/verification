import LoginShell from '../../components/LoginShell.jsx'

export default function AdminLogin() {
  return (
    <LoginShell
      portalTitle="Exam Administrator Portal"
      portalSubtitle="Monitor verification activity, success rates and center performance across your organization."
      expectedRole="admin"
      redirectTo="/admin"
      accent="emerald"
      demo="admin / admin123"
    />
  )
}
