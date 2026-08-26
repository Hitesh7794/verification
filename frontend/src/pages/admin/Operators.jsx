import React, { useCallback, useEffect, useRef, useState } from 'react'
import AdminShell, { PageHead } from '../../components/shell/AdminShell.jsx'
import {
  Button,
  Card,
  CardBody,
  Input,
  Label,
} from '../../components/ui/ui.jsx'
import { Icon, Pill } from '../../components/ui/extras.jsx'
import { FadeIn } from '../../components/ui/motion.jsx'
import {
  listOperators,
  createOperator,
  bulkCreateOperatorsCSV,
  downloadSampleOperatorCSV,
  patchOperator,
  disableOperator,
  enableOperator,
  getSubscriptions,
} from '../../lib/admin/examSubscriptions.js'
import { getWallet, formatRupees } from '../../lib/wallet/wallet.js'
import { dateRange, formatDateTime, toDatetimeLocal } from '../../lib/dates.js'

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
  const [createMode, setCreateMode] = useState('single') // 'single' | 'bulk'
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
    <AdminShell>
      <FadeIn>
        <PageHead
          eyebrow="Team"
          title="Verification Agents"
          right={
            <div className="flex gap-2">
              <Button
                variant={creating && createMode === 'bulk' ? 'primary' : 'secondary'}
                onClick={() => {
                  if (creating && createMode === 'bulk') {
                    setCreating(false)
                  } else {
                    setCreating(true)
                    setCreateMode('bulk')
                    setEditing(null)
                  }
                }}
              >
                <Icon.Upload className="h-4 w-4 mr-1.5" />
                {creating && createMode === 'bulk' ? 'Close bulk upload' : 'Bulk upload CSV'}
              </Button>
              <Button
                onClick={() => {
                  if (creating && createMode === 'single') {
                    setCreating(false)
                  } else {
                    setCreating(true)
                    setCreateMode('single')
                    setEditing(null)
                  }
                }}
              >
                <Icon.Plus className="h-4 w-4 mr-1.5" />
                {creating && createMode === 'single' ? 'Cancel' : '+ New verification agent'}
              </Button>
            </div>
          }
        />

        {subs.length === 0 && (
          <div className="mb-4 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
            You don't have any exams yet — verification agents need at least one exam to verify against.
            Ask your platform contact to route your institution to the right exam board.
          </div>
        )}
        {err && (
          <div role="alert" className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
            {err}
          </div>
        )}

        {creating && (
          <div className="mb-6 rounded-xl bg-warm-surface ring-1 ring-warm shadow-sm overflow-hidden">
            <div className="h-1 bg-stone-900" />
            <div className="p-5 sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
                <div className="flex items-start gap-3">
                  <div className="h-9 w-9 rounded-lg bg-stone-100 text-stone-800 flex items-center justify-center shrink-0">
                    {createMode === 'single' ? <Icon.Plus className="h-5 w-5" /> : <Icon.Upload className="h-5 w-5" />}
                  </div>
                  <div>
                    <h3 className="text-base font-semibold text-slate-900">
                      {createMode === 'single' ? 'New verification agent' : 'Bulk create verification agents'}
                    </h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {createMode === 'single'
                        ? 'A per-agent login with spending cap, date window, and assigned exams.'
                        : 'Upload a CSV file to create multiple verification agents at once.'}
                    </p>
                  </div>
                </div>

                {/* Mode Switcher Tabs */}
                <div className="inline-flex rounded-lg bg-slate-100 p-1 text-xs font-semibold">
                  <button
                    type="button"
                    onClick={() => setCreateMode('single')}
                    className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 transition-all ${
                      createMode === 'single'
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    <Icon.FileText className="h-3.5 w-3.5" />
                    <span>Single agent</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setCreateMode('bulk')}
                    className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 transition-all ${
                      createMode === 'bulk'
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    <Icon.Upload className="h-3.5 w-3.5" />
                    <span>Bulk upload (CSV)</span>
                  </button>
                </div>
              </div>

              {createMode === 'single' ? (
                <OperatorForm
                  subs={subs}
                  walletBalancePaise={walletBalancePaise}
                  mode="create"
                  onCancel={() => setCreating(false)}
                  onSaved={async () => { setCreating(false); await refresh() }}
                />
              ) : (
                <BulkOperatorForm
                  subs={subs}
                  onCancel={() => setCreating(false)}
                  onSaved={async () => { setCreating(false); await refresh() }}
                />
              )}
            </div>
          </div>
        )}

        {loading ? (
          <div className="p-10 text-center text-sm text-slate-500">Loading…</div>
        ) : operators.length === 0 && !creating ? (
          <Card><CardBody>
            <div className="p-6 text-center">
              <p className="text-sm text-slate-500">No verification agents yet.</p>
              <p className="text-xs text-slate-400 mt-1">Click <b>New verification agent</b> to add one.</p>
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
                      // Fragment wraps the row + its inline edit row so
                      // React can render both children under <tbody>
                      // without introducing an invalid element.
                      <React.Fragment key={o.id}>
                        <tr className="border-b border-warm last:border-none hover:bg-[#FBF7F0]">
                          <td className="px-4 py-3 font-mono text-xs text-slate-700">{o.username}</td>
                          <td className="px-4 py-3">
                            <div className="text-slate-900">{o.display_name}</div>
                            {o.email && <div className="text-xs text-slate-500 mt-0.5">{o.email}</div>}
                            {o.phone && <div className="text-xs text-slate-500">{o.phone}</div>}
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
                              ? `${formatDateTime(o.valid_from) || '…'} → ${formatDateTime(o.valid_to) || '…'}`
                              : <span className="text-slate-400">no window</span>}
                          </td>
                          <td className="px-4 py-3 text-slate-700 tabular-nums">{(o.assigned_exam_ids || []).length}</td>
                          <td className="px-4 py-3">
                            {o.status === 'active' ? <Pill tone="emerald" dot>Active</Pill> : <Pill tone="slate" dot>Disabled</Pill>}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="inline-flex gap-2">
                              <Button variant="secondary" size="sm" onClick={() => setEditing(editing === o.id ? null : o.id)}>
                                {editing === o.id ? 'Close' : 'Edit'}
                              </Button>
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => onToggle(o.id, o.status === 'disabled')}
                                className={o.status === 'disabled'
                                  ? ''
                                  : '!text-rose-700 !border-rose-200 hover:!bg-rose-50 hover:!border-rose-300'}
                              >
                                {o.status === 'disabled' ? 'Enable' : 'Disable'}
                              </Button>
                            </div>
                          </td>
                        </tr>
                        {editing === o.id && (
                          <tr>
                            <td colSpan={7} className="bg-[#FBF7F0] border-b border-warm p-5">
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
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardBody>
          </Card>
        )}
      </FadeIn>
    </AdminShell>
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
function ExamMultiSelect({ subs, value, onChange, single = false }) {
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

  const activeSubs = subs.filter((s) => {
    if (s.exam_closed) return false
    if (s.verification_to && new Date() > new Date(s.verification_to)) return false
    return true
  })

  const selected = subs.filter((s) => value.includes(s.exam_id))
  const allSelected = activeSubs.length > 0 && selected.length === activeSubs.length

  // single mode: clicking any exam replaces the selection with just that
  // exam (one operator = one exam per policy migrated in 022). Clicking
  // the already-selected exam clears the assignment.
  const toggle = (id) => {
    if (single) {
      onChange(value.includes(id) ? [] : [id])
    } else {
      onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])
    }
  }

  const summary =
    selected.length === 0
      ? (single ? 'No exam assigned' : 'No exams assigned')
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
        className="w-full flex items-center justify-between gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-left text-sm text-slate-900 hover:bg-slate-50 focus:border-stone-700 focus:outline-none focus:ring-2 focus:ring-stone-300"
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
              {single
                ? (selected.length ? 'Assigned' : 'Pick one exam')
                : `${selected.length} of ${activeSubs.length} selected`}
            </span>
            <div className="flex gap-1">
              {!single && (
                <>
                  <button
                    type="button"
                    className="text-xs font-medium text-emerald-700 hover:underline disabled:text-slate-400 disabled:no-underline"
                    disabled={allSelected}
                    onClick={() => onChange(activeSubs.map((s) => s.exam_id))}
                  >
                    Select all
                  </button>
                  <span className="text-slate-300">·</span>
                </>
              )}
              <button
                type="button"
                className="text-xs font-medium text-emerald-700 hover:underline disabled:text-slate-400 disabled:no-underline"
                disabled={selected.length === 0}
                onClick={() => onChange([])}
              >
                Clear
              </button>
            </div>
          </div>

          <div className="max-h-56 overflow-y-auto py-1" role="listbox" aria-multiselectable={!single}>
            {activeSubs.length === 0 ? (
              <div className="px-3 py-3 text-xs text-slate-500 text-center">
                No active exams available.
              </div>
            ) : (
              activeSubs.map((s) => {
                const checked = value.includes(s.exam_id)
                return (
                  <label
                    key={s.exam_id}
                    role="option"
                    aria-selected={checked}
                    className={`flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors ${
                      checked ? 'bg-emerald-50/60 hover:bg-emerald-50' : 'hover:bg-slate-50'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(s.exam_id)}
                      className="rounded border-slate-300 text-emerald-700 focus:ring-emerald-500"
                    />
                    <span className="min-w-0">
                      <span className="block font-mono text-xs text-slate-700">{s.exam_code}</span>
                      <span className="block truncate text-xs text-slate-500">{s.exam_name}</span>
                    </span>
                  </label>
                )
              })
            )}
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
              className="inline-flex items-center gap-1 rounded-full bg-stone-100 py-0.5 pl-2.5 pr-1 text-xs font-medium text-stone-800"
            >
              {s.exam_code}
              <button
                type="button"
                onClick={() => toggle(s.exam_id)}
                aria-label={`Remove ${s.exam_code}`}
                className="rounded-full p-0.5 text-stone-400 hover:bg-stone-200 hover:text-stone-800"
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
  const initialEmail = (operator?.email || '').trim().toLowerCase()
  const [email, setEmail] = useState(initialEmail)
  const initialPhone = (operator?.phone || '').trim()
  const [phone, setPhone] = useState(initialPhone)
  const [capRupees, setCapRupees] = useState(operator?.spending_cap_paise ? String(operator.spending_cap_paise / 100) : '')
  const [validFrom, setValidFrom] = useState(toDatetimeLocal(operator?.valid_from, '00:00'))
  const [validTo, setValidTo] = useState(toDatetimeLocal(operator?.valid_to, '23:59'))
  const [examIds, setExamIds] = useState(operator?.assigned_exam_ids || [])
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  // Indian mobile only — 10 digits starting 6/7/8/9, with optional
  // +91 or 91 prefix. Mirrors backend isPlausiblePhone; the FE check
  // just keeps the Save button honest and gives a live inline hint.
  const phoneClean = phone.replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '')
  const phoneCore  = phoneClean.replace(/^\+?91/, '').replace(/^\+/, '')
  const isPhoneValid = /^[6-9]\d{9}$/.test(phoneCore)

  // Date validation — mirrors backend parseDateWindow. valid_from must
  // not be in the past; valid_to must be strictly after valid_from AND
  // in the future. A 2-minute skew matches the backend so a form the
  // admin filled a couple minutes ago still submits.
  const now = new Date()
  const fromDate = validFrom ? new Date(validFrom) : null
  const toDate   = validTo   ? new Date(validTo)   : null
  const fromInPast  = fromDate && !isNaN(fromDate) && (fromDate.getTime() + 2 * 60_000) < now.getTime()
  const toInPast    = toDate   && !isNaN(toDate)   &&  toDate.getTime() < now.getTime()
  const fromAfterTo = fromDate && toDate && !isNaN(fromDate) && !isNaN(toDate) && fromDate >= toDate
  const dateInvalid = fromInPast || toInPast || fromAfterTo
  const dateErrMsg = fromInPast ? 'Valid from cannot be in the past.'
    : toInPast ? 'Valid to cannot be in the past.'
    : fromAfterTo ? 'Valid from must be strictly before Valid to.'
    : ''

  // Exam window validation — operator's window must be inside the superadmin-defined exam window
  const selectedExam = subs.find((s) => examIds.includes(s.exam_id))
  const examFromDate = selectedExam?.verification_from ? new Date(selectedExam.verification_from) : null
  const examToDate   = selectedExam?.verification_to   ? new Date(selectedExam.verification_to)   : null

  const beforeExamStart = selectedExam && examFromDate && !isNaN(examFromDate.getTime()) && fromDate && !isNaN(fromDate.getTime()) && fromDate < examFromDate
  const afterExamEnd    = selectedExam && examToDate   && !isNaN(examToDate.getTime())   && toDate   && !isNaN(toDate.getTime())   && toDate > examToDate
  const examWindowInvalid = beforeExamStart || afterExamEnd
  const examWindowErrMsg = beforeExamStart
    ? `Valid from cannot be earlier than the exam start time (${formatDateTime(selectedExam.verification_from)}).`
    : afterExamEnd
    ? `Valid to cannot be later than the exam end time (${formatDateTime(selectedExam.verification_to)}).`
    : ''

  // Live cap validation — the wallet middleware enforces the runtime
  // limits anyway (see /liveness-check), but blocking obviously-broken
  // caps at form-submit surfaces the mistake before Save.
  //
  //   capOverWallet — cap > current wallet balance (admin needs to top
  //                   up first, or lower the cap)
  //   capBelowFee   — cap < ₹1 fee-per-lookup (operator can't verify
  //                   even one candidate — pointless "half-rupee" caps
  //                   like 0.10 used to slip past the min="0"/step="0.01"
  //                   input constraints; caught here now).
  const FEE_PAISE = 100 // matches WalletFeePerLookupPaise default; UI-only.
  const capPaiseLive = capRupees.trim() ? Math.round(Number(capRupees) * 100) : null
  const capOverWallet =
    walletBalancePaise != null && capPaiseLive != null && capPaiseLive > walletBalancePaise
  const capBelowFee = capPaiseLive != null && capPaiseLive < FEE_PAISE
  const capInvalid = capOverWallet || capBelowFee

  async function onSubmit(e) {
    e.preventDefault()
    if (capBelowFee) {
      setErr("Spending cap must be at least ₹1 (one verification). Leave blank for no cap.")
      return
    }
    if (capOverWallet) {
      setErr(`Spending cap can't exceed the wallet balance (${formatRupees(walletBalancePaise)}). Top up the wallet first or lower the cap.`)
      return
    }
    if (!isPhoneValid) {
      setErr('Enter a valid 10-digit Indian mobile number (starting 6/7/8/9, +91 optional).')
      return
    }
    if (dateInvalid) {
      setErr(dateErrMsg)
      return
    }
    if (examWindowInvalid) {
      setErr(examWindowErrMsg)
      return
    }
    setSaving(true)
    setErr('')
    try {
      const capPaise = capRupees.trim() ? Math.round(Number(capRupees) * 100) : null
      if (isEdit) {
        const patch = { exam_ids: examIds }
        if (displayName !== operator.display_name) patch.display_name = displayName
        if (email.trim().toLowerCase() !== initialEmail) patch.email = email.trim()
        if (phone.trim() !== initialPhone) patch.phone = phone.trim()
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
          email: email.trim(),
          phone: phone.trim(),
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
    <form onSubmit={onSubmit} className="space-y-4">
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
            placeholder="agent@college.edu"
            required
            autoComplete="email"
          />
        </div>
        <div>
          <Label>Phone number</Label>
          <Input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+91 98765 43210"
            required
            autoComplete="tel"
            inputMode="tel"
          />
          {phone.trim() && !isPhoneValid && (
            <p className="text-[11px] text-rose-600 mt-1">
              Enter a valid 10-digit Indian mobile (starting <b>6/7/8/9</b>). <code>+91</code> or <code>91</code> prefix is optional.
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
          <Label>Spending cap (₹, whole rupees; leave blank = no cap)</Label>
          <Input
            type="number"
            min="1"
            step="1"
            value={capRupees}
            onChange={(e) => setCapRupees(e.target.value)}
            placeholder="e.g. 10"
          />
          {(() => {
            const showHint = walletBalancePaise != null || capBelowFee
            if (!showHint) return null
            let msg = ''
            let tone = 'text-slate-500'
            if (capBelowFee) {
              msg = 'Cap must be at least ₹1 — one verification costs ₹1.'
              tone = 'text-rose-600 font-medium'
            } else if (capOverWallet) {
              msg = `Cap exceeds wallet balance ${formatRupees(walletBalancePaise)}. Top up the wallet first, or lower the cap.`
              tone = 'text-rose-600 font-medium'
            } else if (walletBalancePaise != null) {
              msg = `Wallet balance: ${formatRupees(walletBalancePaise)} — cap must be ≤ this.`
            }
            return <p className={`text-[11px] mt-1 ${tone}`}>{msg}</p>
          })()}
        </div>
        <div>
          <Label>Valid from (date & time)</Label>
          <Input
            type="datetime-local"
            value={validFrom}
            onChange={(e) => setValidFrom(e.target.value)}
            required
            min={selectedExam?.verification_from ? selectedExam.verification_from.slice(0, 16) : undefined}
            max={validTo || (selectedExam?.verification_to ? selectedExam.verification_to.slice(0, 16) : undefined)}
          />
          {fromInPast && (
            <p className="text-[11px] text-rose-600 mt-1">Valid from cannot be in the past.</p>
          )}
          {beforeExamStart && (
            <p className="text-[11px] text-rose-600 font-medium mt-1">
              Valid from cannot be earlier than exam start ({formatDateTime(selectedExam.verification_from)}).
            </p>
          )}
        </div>
        <div>
          <Label>Valid to (date & time)</Label>
          <Input
            type="datetime-local"
            value={validTo}
            onChange={(e) => setValidTo(e.target.value)}
            required
            min={validFrom || (selectedExam?.verification_from ? selectedExam.verification_from.slice(0, 16) : undefined)}
            max={selectedExam?.verification_to ? selectedExam.verification_to.slice(0, 16) : undefined}
          />
          {(toInPast || fromAfterTo) && (
            <p className="text-[11px] text-rose-600 mt-1">
              {toInPast ? 'Valid to cannot be in the past.' : 'Valid to must be after Valid from.'}
            </p>
          )}
          {afterExamEnd && (
            <p className="text-[11px] text-rose-600 font-medium mt-1">
              Valid to cannot be later than exam end ({formatDateTime(selectedExam.verification_to)}).
            </p>
          )}
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
          <>
            <ExamMultiSelect subs={subs} value={examIds} onChange={setExamIds} single />
            {examIds.length === 0 && (
              <p className="mt-1 text-xs text-rose-600">
                Assigning one exam is required.
              </p>
            )}
            {selectedExam && (selectedExam.verification_from || selectedExam.verification_to) && (
              <div className="mt-2 flex items-center gap-2 text-xs text-indigo-700 bg-indigo-50 border border-indigo-200/70 rounded-md px-2.5 py-1.5">
                <Icon.Clock className="h-3.5 w-3.5 shrink-0 text-indigo-600" />
                <span>
                  <b>Exam Window:</b>{' '}
                  {selectedExam.verification_from ? formatDateTime(selectedExam.verification_from) : 'Open'}
                  {' → '}
                  {selectedExam.verification_to ? formatDateTime(selectedExam.verification_to) : 'Open'}
                  {' '}(Agent validity must be within this window)
                </span>
              </div>
            )}
          </>
        )}
      </div>

      {err && (
        <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
          {err}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={saving || examIds.length === 0 || !isPhoneValid || capInvalid || dateInvalid || examWindowInvalid}>
          {saving ? 'Saving…' : (isEdit ? 'Save changes' : 'Create verification agent')}
        </Button>
      </div>
    </form>
  )
}

function BulkOperatorForm({ subs, onCancel, onSaved }) {
  const [csvFile, setCsvFile] = useState(null)
  const [selectedExamId, setSelectedExamId] = useState(subs[0]?.exam_id ? String(subs[0].exam_id) : '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [validationErrors, setValidationErrors] = useState([])
  const [success, setSuccess] = useState(null)
  const [dragOver, setDragOver] = useState(false)

  // sync default selected exam if subs change
  useEffect(() => {
    if (subs?.length && !selectedExamId) {
      setSelectedExamId(String(subs[0].exam_id))
    }
  }, [subs, selectedExamId])

  const selectedSub = subs.find((s) => String(s.exam_id) === String(selectedExamId)) || subs[0]

  function handleFileDrop(e) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer?.files?.[0]
    if (file && (file.name.endsWith('.csv') || file.type.includes('csv') || file.type.includes('text'))) {
      setCsvFile(file)
      setErr('')
      setValidationErrors([])
    } else if (file) {
      setErr('Please upload a valid .csv file.')
    }
  }

  async function onSubmit(e) {
    e.preventDefault()
    if (!csvFile) return
    setSaving(true)
    setErr('')
    setValidationErrors([])
    setSuccess(null)
    try {
      const res = await bulkCreateOperatorsCSV(csvFile, selectedExamId ? [selectedExamId] : [])
      setSuccess(res.rows_created || res.operators?.length || 'Multiple')
      setTimeout(() => {
        if (onSaved) onSaved()
      }, 1200)
    } catch (e) {
      if (e.body?.validation_errors?.length) {
        setValidationErrors(e.body.validation_errors)
      } else {
        setErr(e.message || 'Bulk upload failed. Please check the CSV format.')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      {/* 1. CSV Template & Guidelines */}
      <div className="rounded-xl border border-slate-200/80 bg-slate-50/50 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <h4 className="text-sm font-semibold text-slate-900">1. CSV Template & Required Fields</h4>
            <p className="text-xs text-slate-500 mt-1 max-w-2xl leading-relaxed">
              Required headers: <code className="bg-slate-200/80 px-1 py-0.5 rounded text-slate-800 font-mono text-[11px]">username</code>, <code className="bg-slate-200/80 px-1 py-0.5 rounded text-slate-800 font-mono text-[11px]">password</code>, <code className="bg-slate-200/80 px-1 py-0.5 rounded text-slate-800 font-mono text-[11px]">display_name</code>, <code className="bg-slate-200/80 px-1 py-0.5 rounded text-slate-800 font-mono text-[11px]">email</code>, <code className="bg-slate-200/80 px-1 py-0.5 rounded text-slate-800 font-mono text-[11px]">phone</code>.
              <br />
              Optional columns: <code className="bg-slate-200/80 px-1 py-0.5 rounded text-slate-800 font-mono text-[11px]">cap_amount</code> (in ₹ rupees, e.g. <code className="text-slate-700">500</code>), <code className="bg-slate-200/80 px-1 py-0.5 rounded text-slate-800 font-mono text-[11px]">valid_from</code>, <code className="bg-slate-200/80 px-1 py-0.5 rounded text-slate-800 font-mono text-[11px]">valid_to</code>, <code className="bg-slate-200/80 px-1 py-0.5 rounded text-slate-800 font-mono text-[11px]">exam_codes</code>.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => downloadSampleOperatorCSV(selectedSub)}
            className="bg-white hover:bg-slate-100 text-slate-800 shadow-sm shrink-0"
          >
            <Icon.Download className="h-4 w-4 mr-1.5 text-slate-600" />
            Download sample CSV
          </Button>
        </div>
      </div>

      {/* 2. Default Exam Scope */}
      {subs.length > 0 && (
        <div className="rounded-xl border border-slate-200/80 bg-white p-4">
          <h4 className="text-sm font-semibold text-slate-900 mb-1">2. Default Assigned Exam</h4>
          <p className="text-xs text-slate-500 mb-3">
            If an agent's row does not specify an explicit <code>exam_codes</code> column in the CSV, they will be assigned to this selected exam:
          </p>
          <select
            value={selectedExamId}
            onChange={(e) => setSelectedExamId(e.target.value)}
            className="block w-full max-w-md rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-stone-900 focus:ring-1 focus:ring-stone-900 bg-white"
          >
            {subs.map((s) => (
              <option key={s.exam_id} value={s.exam_id}>
                {s.exam_code} — {s.exam_name}
              </option>
            ))}
          </select>
          {selectedSub && (selectedSub.verification_from || selectedSub.verification_to) && (
            <div className="mt-2.5 flex items-center gap-2 text-xs text-indigo-700 bg-indigo-50/80 border border-indigo-200/80 rounded-lg px-3 py-1.5">
              <Icon.Clock className="h-3.5 w-3.5 shrink-0 text-indigo-600" />
              <span>
                <b>Superadmin Exam Window:</b>{' '}
                {selectedSub.verification_from ? formatDateTime(selectedSub.verification_from) : 'Open'}
                {' → '}
                {selectedSub.verification_to ? formatDateTime(selectedSub.verification_to) : 'Open'}.
                {' '}(All CSV agent validity windows must fall within this range).
              </span>
            </div>
          )}
        </div>
      )}

      {/* 3. Dropzone */}
      <div>
        <h4 className="text-sm font-semibold text-slate-900 mb-2">3. Upload your CSV file</h4>
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleFileDrop}
          className={`relative flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 transition-colors text-center ${
            dragOver
              ? 'border-stone-900 bg-stone-50/50'
              : 'border-slate-300 hover:border-slate-400 bg-white'
          }`}
        >
          <input
            type="file"
            accept=".csv,.txt,.tsv,text/csv,text/tab-separated-values"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) {
                setCsvFile(file)
                setErr('')
                setValidationErrors([])
              }
            }}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-600 mb-3">
            <Icon.Upload className="h-6 w-6" />
          </div>
          <p className="text-sm font-semibold text-slate-800">
            {csvFile ? csvFile.name : 'Choose an agents CSV file or drag and drop here'}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            {csvFile
              ? `${(csvFile.size / 1024).toFixed(1)} KB — Click or drop another file to replace`
              : 'Only .csv, .tsv files up to 20 MB are supported'}
          </p>
          {csvFile && (
            <div className="mt-3 flex items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-600/20">
                <Icon.Check className="h-3.5 w-3.5" />
                Ready to upload
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  setCsvFile(null)
                  setValidationErrors([])
                  setErr('')
                }}
                className="text-xs text-slate-500 hover:text-rose-600 underline ml-2"
              >
                Remove
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Validation errors */}
      {validationErrors.length > 0 && (
        <div className="rounded-xl border border-rose-200 bg-rose-50/80 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-rose-800 mb-2">
            <Icon.X className="h-4 w-4" />
            <span>Validation errors found in CSV ({validationErrors.length})</span>
          </div>
          <div className="max-h-48 overflow-y-auto space-y-1.5 pr-2">
            {validationErrors.map((v, i) => (
              <div key={i} className="text-xs text-rose-700 flex items-start gap-2 bg-white/70 rounded-md p-2 border border-rose-100">
                <span className="font-mono font-semibold text-rose-900 bg-rose-100 px-1.5 py-0.5 rounded shrink-0">
                  Line {v.line}
                </span>
                <span>{v.msg}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* General error */}
      {err && (
        <div role="alert" className="rounded-lg bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-700">
          {err}
        </div>
      )}

      {/* Success */}
      {success && (
        <div role="status" className="rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-800 flex items-center gap-2">
          <Icon.Check className="h-4 w-4 shrink-0 text-emerald-600" />
          <span>Successfully created {success} verification agents! Refreshing list…</span>
        </div>
      )}

      {/* Actions */}
      <div className="flex justify-end gap-2 pt-4 border-t border-slate-100">
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={saving || !csvFile}>
          {saving ? 'Creating agents…' : 'Upload & create agents'}
        </Button>
      </div>
    </form>
  )
}

