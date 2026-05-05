import LoginShell from '../../components/LoginShell.jsx'

export default function ClientLogin() {
  return (
    <LoginShell
      portalTitle="Center Operator Portal"
      portalSubtitle="Verify candidate identity at the examination center using face and fingerprint biometrics."
      expectedRole="client"
      redirectTo="/client"
      accent="indigo"
      demo="client / client123"
    />
  )
}
