import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import AppShell from '../../components/shell/AppShell.jsx'
import AdminTabs from '../../components/shell/AdminTabs.jsx'
import {
  Button,
  Card,
  CardBody,
  Input,
  Label,
  PageHeader,
} from '../../components/ui/ui.jsx'
import { Icon, Pill } from '../../components/ui/extras.jsx'
import { FadeIn } from '../../components/ui/motion.jsx'
import {
  listOperators,
  createOperator,
  patchOperator,
  disableOperator,
  enableOperator,
  getSubscriptions,
} from '../../lib/admin/examSubscriptions.js'
import { getWallet, formatRupees } from '../../lib/wallet/wallet.js'

// Admin > Operators — per-operator management (Phase 2). Each operator
// has: username, password, display name, optional spending cap,
// optional date window, and a subset of the college's subscribed
// exams they're allowed to verify against.
export default function Operators() {
  const [operators, setOperators] = useState([])
  const [subs, setSubs] = useState([])
  const [walletBalancePaise, setWalletBalancePaise] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState(null) // operator id currently being edited

  const refresh = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      const [ops, sb, wallet] = await Promise.all([
        listOperators(),
        getSubscriptions(),
        getWallet().catch(() => null), // wallet is best-effort; don't fail the page
      ])
      setOperators(ops)
      setSubs(sb)
      setWalletBalancePaise(wallet?.balance_paise ?? null)
    } catch (e) {
      setErr(e.message || 'Load failed')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  async function onToggle(id, currentlyDisabled) {
    try {
      if (currentlyDisabled) {
        await enableOperator(id)
      } else {
        await disableOperator(id)
      }
      await refresh()
    } catch (e) {
      setErr(e.message)
    }
  }

  return (
    <AppShell>
      <AdminTabs />
      <FadeIn>
        <PageHeader
          title="Operators"
          subtitle="Per-operator credentials, spending caps, date windows, and assigned exams."
          right={
            <Button onClick={() => { setCreating(v => !v); setEditing(null) }}>
              {creating ? 'Cancel' : '+ New operator'}
            </Button>
          }
        />
        {subs.length === 0 && (
          <div className="mb-4 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
            You haven't subscribed to any exams yet — operators need at least one subscribed exam to verify against.{' '}
            <Link to="/admin/catalog" className="font-medium text-amber-900 hover:underline">Open catalog →</Link>
          </div>
        )}
        {err && (
          <div role="alert" className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
            {err}
          </div>
        )}

        {creating && (
          <OperatorForm
            subs={subs}
            walletBalancePaise={walletBalancePaise}
            mode="create"
            onCancel={() => setCreating(false)}
            onSaved={async () => { setCreating(false); await refresh() }}
          />
        )}

        {loading ? (
          <div className="p-10 text-center text-sm text-slate-500">Loading…</div>
        ) : operators.length === 0 && !creating ? (
          <Card><CardBody>
            <div className="p-6 text-center">
              <p className="text-sm text-slate-500">No operators yet.</p>
              <p className="text-xs text-slate-400 mt-1">Click <b>New operator</b> to add one.</p>
            </div>
          </CardBody></Card>
        ) : (
          <Card>
            <CardBody className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wider text-slate-500 bg-slate-50">
                      <th className="px-4 py-2.5">Username</th>
                      <th className="px-4 py-2.5">Display name</th>
                      <th className="px-4 py-2.5">Cap / spent</th>
                      <th className="px-4 py-2.5">Window</th>
                      <th className="px-4 py-2.5">Exams</th>
                      <th className="px-4 py-2.5">Status</th>
                      <th className="px-4 py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {operators.map((o) => (
                      <>
                        <tr key={o.id} className="border-b border-slate-100 last:border-none hover:bg-slate-50/60">
                          <td className="px-4 py-3 font-mono text-xs text-slate-700">{o.username}</td>
                          <td className="px-4 py-3">
                            <div className="text-slate-900">{o.display_name}</div>
                            {o.email && <div className="text-xs text-slate-500 mt-0.5">{o.email}</div>}
                          </td>
                          <td className="px-4 py-3 text-xs text-slate-600 tabular-nums">
                            {o.spending_cap_paise ? (
                              <span>
                                ₹{(o.spent_paise / 100).toFixed(2)} / ₹{(o.spending_cap_paise / 100).toFixed(2)}
                                {o.spent_paise >= o.spending_cap_paise && (
                                  <Pill tone="rose" dot><span className="ml-1">Cap hit</span></Pill>
                                )}
                              </span>
                            ) : (
                              <span className="text-slate-400">no cap</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-xs text-slate-600 tabular-nums">
                            {o.valid_from || o.valid_to
                              ? `${o.valid_from || '…'} → ${o.valid_to || '…'}`
                              : <span className="text-slate-400">no window</span>}
                          </td>
                          <td className="px-4 py-3 text-slate-700 tabular-nums">{(o.assigned_exam_ids || []).length}</td>
                          <td className="px-4 py-3">
                            {o.status === 'active' ? <Pill tone="emerald" dot>Active</Pill> : <Pill tone="slate" dot>Disabled</Pill>}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="inline-flex gap-2">
                              <Button variant="ghost" size="sm" onClick={() => setEditing(editing === o.id ? null : o.id)}>
                                {editing === o.id ? 'Close' : 'Edit'}
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => onToggle(o.id, o.status === 'disabled')}>
                                {o.status === 'disabled' ? 'Enable' : 'Disable'}
                              </Button>
                            </div>
                          </td>
                        </tr>
                        {editing === o.id && (
                          <tr>
                            <td colSpan={7} className="bg-slate-50 border-b border-slate-100 p-4">
                              <OperatorForm
                                subs={subs}
                                walletBalancePaise={walletBalancePaise}
                                mode="edit"
                                operator={o}
                                onCancel={() => setEditing(null)}
                                onSaved={async () => { setEditing(null); await refresh() }}
                              />
                            </td>
                          </tr>
                        )}
                      </>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardBody>
          </Card>
        )}
      </FadeIn>
    </AppShell>
  )
}

// ── Assigned-exams dropdown ───────────────────────────────────────────
//
// Replaces the flat checkbox grid. With a college subscribed to more
// than a handful of exams the grid pushed the Save button off-screen,
// and there was no way to see at a glance which exams an operator
// already had — you had to scan every checkbox.
//
// The panel is rendered IN FLOW rather than absolutely positioned. The
// edit form lives inside a table cell whose ancestor is `overflow-x-auto`,
// and per CSS a non-visible overflow on one axis forces the other to
// `auto` too — so an absolute panel would be clipped or would spawn a
// scrollbar instead of floating over the row. Growing the row is the
// behaviour that actually works in both places this form is used.
function ExamMultiSelect({ subs, value, onChange }) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef(null)

  // Close on outside click or Escape — standard dropdown affordances.
  useEffect(() => {
    if (!open) return
    function onDocDown(e) {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false)
    }
    function onKey(e) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const selected = subs.filter((s) => value.includes(s.exam_id))
  const allSelected = subs.length > 0 && selected.length === subs.length

  const toggle = (id) =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])

  const summary =
    selected.length === 0
      ? 'No exams assigned'
      : selected.length === 1
      ? selected[0].exam_code
      : `${selected.length} exams assigned`

  return (
    <div ref={boxRef}>
      {/* Trigger — reads as a select control. type="button" matters:
          this sits inside a <form>, and a bare <button> would submit it. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="w-full flex items-center justify-between gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-left text-sm text-slate-900 hover:bg-slate-50 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
      >
        <span className={selected.length ? 'text-slate-900' : 'text-slate-400'}>
          {summary}
        </span>
        <Icon.ChevronRight
          className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`}
        />
      </button>

      {open && (
        <div className="mt-1 rounded-lg border border-slate-200 bg-white shadow-lg overflow-hidden">
          <div className="flex items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2">
            <span className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
              {selected.length} of {subs.length} selected
            </span>
            <div className="flex gap-1">
              <button
                type="button"
                className="text-xs font-medium text-indigo-600 hover:underline disabled:text-slate-400 disabled:no-underline"
                disabled={allSelected}
                onClick={() => onChange(subs.map((s) => s.exam_id))}
              >
                Select all
              </button>
              <span className="text-slate-300">·</span>
              <button
                type="button"
                className="text-xs font-medium text-indigo-600 hover:underline disabled:text-slate-400 disabled:no-underline"
                disabled={selected.length === 0}
                onClick={() => onChange([])}
              >
                Clear
              </button>
            </div>
          </div>

          <div className="max-h-56 overflow-y-auto py-1" role="listbox" aria-multiselectable="true">
            {subs.map((s) => {
              const checked = value.includes(s.exam_id)
              return (
                <label
                  key={s.exam_id}
                  role="option"
                  aria-selected={checked}
                  className={`flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors ${
                    checked ? 'bg-indigo-50/60 hover:bg-indigo-50' : 'hover:bg-slate-50'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(s.exam_id)}
                    className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span className="min-w-0">
                    <span className="block font-mono text-xs text-slate-700">{s.exam_code}</span>
                    <span className="block truncate text-xs text-slate-500">{s.exam_name}</span>
                  </span>
                </label>
              )
            })}
          </div>
        </div>
      )}

      {/* Selected shown as removable chips, so the admin can see and
          drop an assignment without opening the panel at all. */}
      {selected.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {selected.map((s) => (
            <span
              key={s.exam_id}
              className="inline-flex items-center gap-1 rounded-full bg-indigo-50 py-0.5 pl-2.5 pr-1 text-xs font-medium text-indigo-700"
            >
              {s.exam_code}
              <button
                type="button"
                onClick={() => toggle(s.exam_id)}
                aria-label={`Remove ${s.exam_code}`}
                className="rounded-full p-0.5 text-indigo-400 hover:bg-indigo-100 hover:text-indigo-700"
              >
                <Icon.X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Create / edit form ────────────────────────────────────────────────

function OperatorForm({ subs, walletBalancePaise, mode, operator, onCancel, onSaved }) {
  const isEdit = mode === 'edit'
  const [username, setUsername] = useState(operator?.username || '')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [displayName, setDisplayName] = useState(operator?.display_name || '')
  const [email, setEmail] = useState(operator?.email || '')
  const [capRupees, setCapRupees] = useState(operator?.spending_cap_paise ? String(operator.spending_cap_paise / 100) : '')
  const [validFrom, setValidFrom] = useState(operator?.valid_from || '')
  const [validTo, setValidTo] = useState(operator?.valid_to || '')
  const [examIds, setExamIds] = useState(operator?.assigned_exam_ids || [])
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  async function onSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setErr('')
    try {
      const capPaise = capRupees.trim() ? Math.round(Number(capRupees) * 100) : null
      if (isEdit) {
        const patch = { exam_ids: examIds }
        if (displayName !== operator.display_name) patch.display_name = displayName
        if (email !== (operator.email || '')) patch.email = email
        if (password.trim()) patch.password = password
        if (validFrom !== (operator.valid_from || '')) patch.valid_from = validFrom
        if (validTo !== (operator.valid_to || '')) patch.valid_to = validTo
        if (capPaise === null && operator.spending_cap_paise) patch.clear_spending_cap = true
        else if (capPaise !== null && capPaise !== operator.spending_cap_paise) patch.spending_cap_paise = capPaise
        await patchOperator(operator.id, patch)
      } else {
        await createOperator({
          username: username.trim(),
          password,
          display_name: displayName.trim() || username.trim(),
          email: email.trim() || undefined,
          spending_cap_paise: capPaise,
          valid_from: validFrom || undefined,
          valid_to: validTo || undefined,
          exam_ids: examIds,
        })
      }
      onSaved()
    } catch (e) {
      const status = e.status ? ` (HTTP ${e.status})` : ''
      const backend = e.body?.error ? `: ${e.body.error}` : ''
      setErr(`${e.message || 'Failed'}${status}${backend}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4 max-w-2xl">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {!isEdit && (
          <div>
            <Label>Username</Label>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus minLength={3} />
          </div>
        )}
        <div>
          <Label>Display name</Label>
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </div>
        <div>
          <Label>Email</Label>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="operator@college.edu"
            required
          />
          {!isEdit && (
            <p className="text-[11px] text-slate-500 mt-1">
              The operator will get an email with their username, password, and login link.
            </p>
          )}
        </div>
        <div>
          <Label>{isEdit ? 'New password (leave blank to keep)' : 'Password'}</Label>
          <div className="relative">
            <Input
              type={showPw ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required={!isEdit}
              minLength={10}
              autoComplete="new-password"
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => setShowPw(v => !v)}
              aria-label={showPw ? 'Hide password' : 'Show password'}
              tabIndex={-1}
              className="absolute inset-y-0 right-0 px-3 flex items-center text-slate-400 hover:text-slate-700 transition-colors"
            >
              <Icon.Eye className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div>
          <Label>Spending cap (₹, leave blank = no cap)</Label>
          <Input
            type="number"
            min="0"
            step="0.01"
            value={capRupees}
            onChange={(e) => setCapRupees(e.target.value)}
            placeholder="e.g. 10"
          />
          {walletBalancePaise != null && (
            (() => {
              const capPaise = capRupees.trim() ? Math.round(Number(capRupees) * 100) : null
              const overBalance = capPaise != null && capPaise > walletBalancePaise
              return (
                <p className={`text-[11px] mt-1 ${overBalance ? 'text-rose-600 font-medium' : 'text-slate-500'}`}>
                  {overBalance
                    ? `Cap exceeds wallet balance ${formatRupees(walletBalancePaise)}. Top up the wallet first, or lower the cap.`
                    : `Wallet balance: ${formatRupees(walletBalancePaise)} — cap must be ≤ this.`}
                </p>
              )
            })()
          )}
        </div>
        <div>
          <Label>Valid from</Label>
          <Input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} required />
        </div>
        <div>
          <Label>Valid to</Label>
          <Input type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} required min={validFrom || undefined} />
        </div>
      </div>
      <div>
        <Label>Assigned exams</Label>
        <p className="text-xs text-slate-500 mb-2">
          Pick from your college's subscribed exams. This operator will only be able to verify against these.
        </p>
        {subs.length === 0 ? (
          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
            Subscribe to at least one exam from the Exam catalog first.
          </p>
        ) : (
          <ExamMultiSelect subs={subs} value={examIds} onChange={setExamIds} />
        )}
      </div>

      {err && (
        <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
          {err}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : (isEdit ? 'Save changes' : 'Create operator')}
        </Button>
      </div>
    </form>
  )
}
