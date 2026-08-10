import { useEffect, useState } from 'react'
import AppShell from '../../components/shell/AppShell.jsx'
import AdminTabs from '../../components/shell/AdminTabs.jsx'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Input,
  Label,
  PageHeader,
} from '../../components/ui/ui.jsx'
import {
  getOperatorAccess,
  resetOperatorPassword,
  setOperatorPassword,
  disableOperatorAccess,
  enableOperatorAccess,
} from '../../lib/admin/orgmgmt.js'

// /admin/operator-access — the admin's view of the single shared
// operator credential. Every operator machine at this college signs in
// with this username + password. The admin can:
//
//   • read the current creds (already visible in the dashboard by
//     deliberate product choice — the customer accepted the trade-off
//     in exchange for no per-operator email onboarding)
//   • reset the password (rotates the bcrypt hash AND the recoverable
//     plaintext; old sessions stay logged in until their 12h JWT
//     expires — to force immediate logout, disable + re-enable)
//   • disable / enable to lock out the credential during incidents

export default function AdminOperatorAccess() {
  const [creds, setCreds] = useState(null) // { username, password, display_name, status }
  const [loadErr, setLoadErr] = useState('')
  const [busy, setBusy] = useState(null)   // 'reset' | 'set' | 'disable' | 'enable' | null
  const [actionErr, setActionErr] = useState('')
  const [copiedField, setCopiedField] = useState(null) // 'username' | 'password' | null
  const [revealPw, setRevealPw] = useState(false)
  const [justReset, setJustReset] = useState(false)    // banner shown immediately after reset/set

  // Custom-password form state. Separate "showForm" so the admin sees
  // the form only when they click Change password — keeps the
  // credentials card uncluttered the rest of the time.
  const [showSetForm, setShowSetForm] = useState(false)
  const [customPw, setCustomPw] = useState('')
  const [revealCustomPw, setRevealCustomPw] = useState(false)
  const [setFormErr, setSetFormErr] = useState('')

  async function reload() {
    setLoadErr('')
    try {
      const c = await getOperatorAccess()
      setCreds(c)
    } catch (e) {
      setLoadErr(e.message || 'failed to load operator credentials')
    }
  }

  useEffect(() => {
    reload()
  }, [])

  async function doAction(action, fn) {
    setBusy(action)
    setActionErr('')
    try {
      const res = await fn()
      setCreds(res)
      if (action === 'reset' || action === 'set') {
        setRevealPw(true)
        setJustReset(true)
      }
    } catch (e) {
      setActionErr(e.message || 'action failed')
    } finally {
      setBusy(null)
    }
  }

  async function submitCustomPassword(e) {
    e.preventDefault()
    setSetFormErr('')
    if (customPw.length < 10) {
      setSetFormErr('Password must be at least 10 characters.')
      return
    }
    setBusy('set')
    try {
      const res = await setOperatorPassword(customPw)
      setCreds(res)
      setCustomPw('')
      setShowSetForm(false)
      setRevealPw(true)
      setJustReset(true)
    } catch (err) {
      setSetFormErr(err.message || 'failed to update password')
    } finally {
      setBusy(null)
    }
  }

  async function copy(field, value) {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedField(field)
      setTimeout(() => setCopiedField((cur) => (cur === field ? null : cur)), 1500)
    } catch {
      // Clipboard API blocked (insecure context); silently swallow —
      // the value is shown on screen anyway.
    }
  }

  return (
    <AppShell title="Operator access" subtitle="Shared login for every operator machine at your institution">
      <PageHeader
        title="Operator access"
        subtitle="Every operator at your centre signs in with the same credentials. Reset the password whenever a machine is reassigned or staff changes."
      />
      <AdminTabs />

      {loadErr && (
        <div className="mb-6 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
          {loadErr}
        </div>
      )}

      {justReset && (
        <div className="mb-6 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-900">
          <strong>Password reset.</strong> Operators using the old password will be signed out at their next request.
          Existing sessions stay logged in until their 12-hour token expires — to force immediate logout, use{' '}
          <em>Disable</em> then <em>Enable</em>.
          <button
            type="button"
            className="float-right text-emerald-700 hover:text-emerald-900 text-lg leading-none"
            onClick={() => setJustReset(false)}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {creds && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>
              Current credentials{' '}
              <Badge tone={creds.status === 'active' ? 'green' : 'slate'}>
                {creds.status === 'active' ? 'Active' : 'Disabled'}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardBody>
            <div className="grid gap-4 sm:grid-cols-2">
              <CredField
                label="Username"
                value={creds.username}
                onCopy={() => copy('username', creds.username)}
                copied={copiedField === 'username'}
                mono
              />
              <CredField
                label="Password"
                value={creds.password}
                onCopy={() => copy('password', creds.password)}
                copied={copiedField === 'password'}
                mono
                masked={!revealPw}
                onToggleReveal={() => setRevealPw((v) => !v)}
                revealed={revealPw}
              />
            </div>

            <p className="mt-4 text-xs text-slate-500">
              Distribute these credentials to every operator machine at your centre. Bookmark{' '}
              <code className="px-1 py-0.5 rounded bg-slate-100 text-slate-700">/client/login</code>{' '}
              on each machine.
            </p>

            <div className="mt-5 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setShowSetForm((v) => !v)
                  setSetFormErr('')
                  setCustomPw('')
                }}
                disabled={busy !== null}
              >
                {showSetForm ? 'Cancel' : 'Change password'}
              </Button>
              <Button
                onClick={() => doAction('reset', resetOperatorPassword)}
                disabled={busy !== null}
              >
                {busy === 'reset' ? 'Resetting…' : 'Generate random'}
              </Button>
              {creds.status === 'active' ? (
                <Button
                  variant="danger"
                  onClick={() => doAction('disable', disableOperatorAccess)}
                  disabled={busy !== null}
                >
                  {busy === 'disable' ? 'Disabling…' : 'Disable access'}
                </Button>
              ) : (
                <Button
                  onClick={() => doAction('enable', enableOperatorAccess)}
                  disabled={busy !== null}
                >
                  {busy === 'enable' ? 'Enabling…' : 'Enable access'}
                </Button>
              )}
            </div>

            {showSetForm && (
              <form onSubmit={submitCustomPassword} className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-4">
                <Label>New password</Label>
                <div className="mt-1 flex items-center gap-2">
                  <Input
                    type={revealCustomPw ? 'text' : 'password'}
                    value={customPw}
                    onChange={(e) => setCustomPw(e.target.value)}
                    placeholder="e.g. CentreNorth-2026"
                    autoFocus
                    disabled={busy !== null}
                    required
                  />
                  <button
                    type="button"
                    className="px-3 py-2 rounded-md border border-slate-300 bg-white text-sm text-slate-700 hover:bg-slate-50"
                    onClick={() => setRevealCustomPw((v) => !v)}
                  >
                    {revealCustomPw ? 'Hide' : 'Show'}
                  </button>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  At least 10 characters with one letter and one digit. The operators will sign in with this password on every machine.
                </p>
                {setFormErr && (
                  <div className="mt-3 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
                    {setFormErr}
                  </div>
                )}
                <div className="mt-4 flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => { setShowSetForm(false); setSetFormErr(''); setCustomPw('') }}
                    disabled={busy !== null}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={busy !== null || customPw.length < 10}>
                    {busy === 'set' ? 'Saving…' : 'Save password'}
                  </Button>
                </div>
              </form>
            )}

            {actionErr && (
              <div className="mt-3 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
                {actionErr}
              </div>
            )}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardBody>
          <h3 className="text-sm font-semibold text-slate-900 mb-2">How this works</h3>
          <ul className="text-sm text-slate-600 list-disc pl-5 space-y-1">
            <li>One shared username/password for every operator at your institution.</li>
            <li>Every machine logs in once with these credentials at <code className="px-1 py-0.5 rounded bg-slate-100">/client/login</code>.</li>
            <li>Every candidate lookup deducts ₹5 from your wallet (top up under <em>Overview</em>).</li>
            <li>If you suspect a credential leak, click <em>Reset password</em> — operators must re-enter the new password on their next login attempt.</li>
            <li>To pause all operator access immediately (e.g. emergency), use <em>Disable access</em>. Disabling does not refund any in-progress verifications.</li>
          </ul>
        </CardBody>
      </Card>
    </AppShell>
  )
}

function CredField({ label, value, onCopy, copied, mono, masked, onToggleReveal, revealed }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">{label}</div>
      <div className="flex items-center gap-2">
        <code
          className={`flex-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm ${
            mono ? 'font-mono' : ''
          } text-slate-900 break-all`}
        >
          {masked ? '••••••••••••' : value}
        </code>
        {onToggleReveal && (
          <button
            type="button"
            onClick={onToggleReveal}
            className="px-3 py-2 rounded-md border border-slate-300 bg-white text-sm text-slate-700 hover:bg-slate-50"
            aria-label={revealed ? 'Hide password' : 'Show password'}
          >
            {revealed ? 'Hide' : 'Show'}
          </button>
        )}
        <button
          type="button"
          onClick={onCopy}
          className="px-3 py-2 rounded-md border border-slate-300 bg-white text-sm text-slate-700 hover:bg-slate-50"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
    </div>
  )
}
