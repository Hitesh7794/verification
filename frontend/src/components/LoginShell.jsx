import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth.jsx'
import { Button, Card, CardBody, Input, Label } from './ui.jsx'

export default function LoginShell({ portalTitle, portalSubtitle, expectedRole, redirectTo, accent = 'indigo', demo }) {
  const { login } = useAuth()
  const nav = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function onSubmit(e) {
    e.preventDefault()
    setErr('')
    setBusy(true)
    try {
      const u = await login(username, password)
      if (u.role !== expectedRole) {
        setErr(`This account is a ${u.role}. Use the ${expectedRole} portal.`)
        return
      }
      nav(redirectTo)
    } catch (e) {
      setErr(e.message || 'Login failed')
    } finally {
      setBusy(false)
    }
  }

  const accents = {
    indigo: 'from-indigo-600 to-indigo-800',
    emerald: 'from-emerald-600 to-emerald-800',
    slate: 'from-slate-700 to-slate-900',
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-2">
      <div className={`hidden lg:flex bg-gradient-to-br ${accents[accent]} text-white p-12 flex-col justify-between`}>
        <div>
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-white/15 backdrop-blur flex items-center justify-center">
              <span className="font-bold">NV</span>
            </div>
            <span className="font-semibold">NEET Verification Portal</span>
          </div>
        </div>
        <div className="max-w-md">
          <h1 className="text-4xl font-semibold tracking-tight">{portalTitle}</h1>
          <p className="mt-4 text-white/80 leading-relaxed">{portalSubtitle}</p>
        </div>
        <p className="text-xs text-white/60">© {new Date().getFullYear()} NEET Verification Systems</p>
      </div>

      <div className="flex items-center justify-center p-6 bg-slate-50">
        <Card className="w-full max-w-md">
          <CardBody className="p-8">
            <h2 className="text-2xl font-semibold text-slate-900">Sign in</h2>
            <p className="mt-1 text-sm text-slate-500">
              Access the {expectedRole} portal with your credentials.
            </p>

            <form onSubmit={onSubmit} className="mt-6 space-y-4">
              <div>
                <Label>Username</Label>
                <Input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  required
                />
              </div>
              <div>
                <Label>Password</Label>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </div>

              {err && (
                <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
                  {err}
                </div>
              )}

              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? 'Signing in...' : 'Sign in'}
              </Button>
            </form>

            {demo && (
              <div className="mt-6 rounded-lg border border-dashed border-slate-300 p-3 text-xs text-slate-500">
                <p className="font-medium text-slate-700 mb-1">Demo credentials</p>
                <code className="font-mono">{demo}</code>
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  )
}
