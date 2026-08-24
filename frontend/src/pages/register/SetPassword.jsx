import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Button, Input, Label } from '../../components/ui/ui.jsx'
import { EnhancedCard, Icon, Pill } from '../../components/ui/extras.jsx'
import { PRODUCT_NAME } from '../../components/ui/brand.jsx'
import { verifyMagicLink, setPassword } from '../../lib/onboarding/register.js'

// Magic-link landing page styled as a focused single-card auth screen
// (Stripe / Linear pattern). Includes a 4-bar password strength meter
// — bars fill as the password meets each requirement so the user gets
// real-time guidance without inline error noise.

export default function SetPassword() {
  const [params] = useSearchParams()
  const nav = useNavigate()
  const token = params.get('token') || ''

  const [phase, setPhase] = useState('checking')
  const [identity, setIdentity] = useState(null)
  const [password, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    if (!token) {
      setPhase('invalid')
      return
    }
    verifyMagicLink(token)
      .then((res) => {
        if (!alive) return
        if (res?.valid) {
          setIdentity({
            username: res.username,
            displayName: res.display_name,
            role: res.role,
            purpose: res.purpose,
          })
          setPhase('ready')
        } else {
          setPhase('invalid')
        }
      })
      .catch(() => alive && setPhase('invalid'))
    return () => { alive = false }
  }, [token])

  const strength = useMemo(() => evalStrength(password), [password])

  async function submit(e) {
    e.preventDefault()
    setErr('')
    if (password !== confirm) {
      setErr('Passwords do not match')
      return
    }
    setPhase('submitting')
    try {
      const res = await setPassword(token, password)
      setPhase('done')
      const targetRole = res?.role || identity?.role
      const targetPath = targetRole === 'client_reviewer'
        ? '/reviewer/login?password_reset=1'
        : '/admin/login?password_reset=1'
      setTimeout(() => nav(targetPath), 1800)
    } catch (e) {
      setErr(e.message || 'Failed to set password')
      setPhase('ready')
    }
  }

  const isReset = identity?.purpose === 'reset_password'

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        {/* Brand chip above card */}
        <div className="flex items-center justify-center gap-2 mb-6 text-slate-700">
          <span className="h-10 w-10 rounded-xl bg-gradient-to-br from-indigo-600 to-violet-600 text-white flex items-center justify-center shadow-sm">
            <Icon.ShieldCheck className="h-5 w-5" />
          </span>
          <span className="text-sm font-medium">
            {isReset ? 'Reset Your Password' : 'Set Account Password'}
          </span>
        </div>

        <EnhancedCard accent="indigo">
          <div className="px-6 py-7">
            {phase === 'checking' && (
              <div className="text-center py-8">
                <div className="inline-block h-6 w-6 rounded-full border-2 border-slate-200 border-t-indigo-600 animate-spin" />
                <p className="mt-3 text-sm text-slate-500">Verifying link security token…</p>
              </div>
            )}

            {phase === 'invalid' && (
              <div className="py-2">
                <div className="mx-auto h-12 w-12 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center mb-4">
                  <Icon.X className="h-6 w-6" />
                </div>
                <h2 className="text-center text-lg font-semibold text-slate-900 mb-2">
                  Link no longer valid
                </h2>
                <p className="text-center text-sm text-slate-600 max-w-sm mx-auto">
                  Password reset links are time-limited for security and can only be used once.
                  Please request a fresh reset link from your portal sign-in page.
                </p>
                <div className="mt-6 text-center">
                  <Link to="/" className="text-sm font-medium text-indigo-600 hover:underline">
                    Back to home
                  </Link>
                </div>
              </div>
            )}

            {(phase === 'ready' || phase === 'submitting') && identity && (
              <form onSubmit={submit} className="space-y-5">
                <div>
                  <h1 className="text-xl font-semibold text-slate-900">
                    {isReset ? 'Create New Password' : `Welcome, ${firstName(identity.displayName)}`}
                  </h1>
                  <p className="mt-1 text-sm text-slate-600">
                    {isReset
                      ? `Choose a new secure password for your account.`
                      : 'Choose a strong password for your admin account.'}
                  </p>
                  <div className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-700">
                    Account username: <code className="font-mono text-slate-900 font-semibold">{identity.username}</code>
                  </div>
                </div>

                <div>
                  <Label>New password</Label>
                  <div className="relative">
                    <Input
                      type={showPw ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPw(e.target.value)}
                      placeholder="At least 10 chars, with a letter and a digit"
                      autoFocus
                      required
                      className="pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPw((v) => !v)}
                      className="absolute inset-y-0 right-0 px-3 flex items-center text-slate-400 hover:text-slate-600"
                      aria-label={showPw ? 'Hide password' : 'Show password'}
                    >
                      <Icon.Eye className="h-4 w-4" />
                    </button>
                  </div>
                  <StrengthMeter strength={strength} />
                </div>

                <div>
                  <Label>Confirm new password</Label>
                  <Input
                    type={showPw ? 'text' : 'password'}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    required
                  />
                </div>

                {err && (
                  <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700 flex items-start gap-2">
                    <Icon.X className="h-4 w-4 mt-0.5 text-rose-600 shrink-0" />
                    {err}
                  </div>
                )}

                <Button
                  type="submit"
                  disabled={phase === 'submitting' || strength.score < 3}
                  className="w-full"
                  size="lg"
                >
                  {phase === 'submitting' ? 'Updating…' : (isReset ? 'Reset password & sign in' : 'Set password & sign in')}
                </Button>

                <p className="text-center text-xs text-slate-500">
                  Encrypted at rest with bcrypt. We never see your password.
                </p>
              </form>
            )}

            {phase === 'done' && (
              <div className="py-6 text-center">
                <div className="mx-auto h-14 w-14 rounded-full bg-gradient-to-br from-emerald-400 to-teal-600 text-white flex items-center justify-center shadow-lg">
                  <Icon.Check className="h-7 w-7" />
                </div>
                <h2 className="mt-4 text-lg font-semibold text-slate-900">Password updated!</h2>
                <p className="mt-1 text-sm text-slate-500">Redirecting to sign in screen…</p>
              </div>
            )}
          </div>
        </EnhancedCard>

        <p className="mt-6 text-center text-[11px] text-slate-400">
          © {new Date().getFullYear()} {PRODUCT_NAME}
        </p>
      </div>
    </div>
  )
}

function StrengthMeter({ strength }) {
  // 4-bar visual meter — 1 bar lit per criterion met. Colour shifts
  // through rose → amber → indigo → emerald as score climbs.
  const tones = ['bg-slate-200', 'bg-rose-400', 'bg-amber-400', 'bg-indigo-500', 'bg-emerald-500']
  const labels = ['', 'Too weak', 'OK', 'Good', 'Strong']
  return (
    <div className="mt-2">
      <div className="flex gap-1.5">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={`h-1 flex-1 rounded-full transition-colors ${
              i < strength.score ? tones[strength.score] : tones[0]
            }`}
          />
        ))}
      </div>
      <p className="mt-1.5 text-xs text-slate-500 min-h-[1rem]">
        {strength.message || (strength.score > 0 ? labels[strength.score] : '')}
      </p>
    </div>
  )
}

function evalStrength(pw) {
  if (!pw) return { score: 0, message: '' }
  let score = 0
  if (pw.length >= 10) score++
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++
  if (/[0-9]/.test(pw)) score++
  if (/[^A-Za-z0-9]/.test(pw) || pw.length >= 16) score++
  // Friendly suggestion text for what's missing.
  if (pw.length < 10) return { score: 1, message: `Need ${10 - pw.length} more character${10 - pw.length === 1 ? '' : 's'}` }
  if (!/[A-Za-z]/.test(pw)) return { score: 1, message: 'Add a letter' }
  if (!/[0-9]/.test(pw)) return { score: 1, message: 'Add a digit' }
  return { score, message: '' }
}

function firstName(displayName) {
  if (!displayName) return ''
  // "Dr. Rajesh Kumar (Principal)" → "Dr. Rajesh"
  const beforeParen = displayName.split('(')[0].trim()
  const words = beforeParen.split(/\s+/)
  return words.slice(0, 2).join(' ')
}
