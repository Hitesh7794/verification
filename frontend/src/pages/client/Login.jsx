import LoginShell from '../../components/shell/LoginShell.jsx'

export default function ClientLogin() {
  return (
    <LoginShell
      portalTitle="Center Verification Agent Portal"
      portalSubtitle="Verify candidate identity at the examination center using face and fingerprint biometrics."
      expectedRole="client"
      redirectTo="/client"
      accent="indigo"
      demo="client / client123"
      rememberKey="nv_last_client_username"
    />
  )
}
