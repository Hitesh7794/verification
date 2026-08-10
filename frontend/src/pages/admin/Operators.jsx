import { useCallback, useEffect, useState } from 'react'
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
import { Pill } from '../../components/ui/extras.jsx'
import { FadeIn } from '../../components/ui/motion.jsx'
import {
  listOperators,
  createOperator,
  patchOperator,
  disableOperator,
  enableOperator,
  getSubscriptions,
} from '../../lib/admin/examSubscriptions.js'

// Admin > Operators — per-operator management (Phase 2). Each operator
// has: username, password, display name, optional spending cap,
// optional date window, and a subset of the college's subscribed
// exams they're allowed to verify against.
export default function Operators() {
  const [operators, setOperators] = useState([])
  const [subs, setSubs] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState(null) // operator id currently being edited

  const refresh = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      const [ops, sb] = await Promise.all([listOperators(), getSubscriptions()])
      setOperators(ops)
      setSubs(sb)
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
                          <td className="px-4 py-3 text-slate-900">{o.display_name}</td>
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

// ── Create / edit form ────────────────────────────────────────────────

function OperatorForm({ subs, mode, operator, onCancel, onSaved }) {
  const isEdit = mode === 'edit'
  const [username, setUsername] = useState(operator?.username || '')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState(operator?.display_name || '')
  const [capRupees, setCapRupees] = useState(operator?.spending_cap_paise ? String(operator.spending_cap_paise / 100) : '')
  const [validFrom, setValidFrom] = useState(operator?.valid_from || '')
  const [validTo, setValidTo] = useState(operator?.valid_to || '')
  const [examIds, setExamIds] = useState(operator?.assigned_exam_ids || [])
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  function toggleExam(id) {
    setExamIds(cur => cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id])
  }

  async function onSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setErr('')
    try {
      const capPaise = capRupees.trim() ? Math.round(Number(capRupees) * 100) : null
      if (isEdit) {
        const patch = { exam_ids: examIds }
        if (displayName !== operator.display_name) patch.display_name = displayName
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
          <Label>{isEdit ? 'New password (leave blank to keep)' : 'Password'}</Label>
          <Input type="text" value={password} onChange={(e) => setPassword(e.target.value)} required={!isEdit} minLength={10} />
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
        </div>
        <div>
          <Label>Valid from (optional)</Label>
          <Input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
        </div>
        <div>
          <Label>Valid to (optional)</Label>
          <Input type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} />
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-48 overflow-y-auto p-1">
            {subs.map((s) => (
              <label key={s.exam_id} className="flex items-center gap-2 p-2 rounded hover:bg-slate-100 cursor-pointer">
                <input
                  type="checkbox"
                  checked={examIds.includes(s.exam_id)}
                  onChange={() => toggleExam(s.exam_id)}
                  className="rounded border-slate-300"
                />
                <div className="text-sm">
                  <div className="font-mono text-xs text-slate-700">{s.exam_code}</div>
                  <div className="text-slate-500 text-xs">{s.exam_name}</div>
                </div>
              </label>
            ))}
          </div>
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
