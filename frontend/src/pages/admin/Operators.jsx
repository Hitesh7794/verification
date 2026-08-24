import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
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
import OtpVerificationField from '../../components/ui/OtpVerificationField.jsx'
import { sendEmailOTP, verifyEmailOTP } from '../../lib/otp/api.js'
import {
  listOperators,
  createOperator,
  patchOperator,
  disableOperator,
  enableOperator,
  getSubscriptions,
} from '../../lib/admin/examSubscriptions.js'
import { getWallet, formatRupees } from '../../lib/wallet/wallet.js'
import { uploadExamCSV } from '../../lib/api.js'

// Admin > Operators — per-operator management (Phase 2). Each operator
// has: username, password, display name, optional spending cap,
// optional date window, and a subset of the college's subscribed
// exams they're allowed to verify against.

// Sample CSV content — one row per required column plus one example
// operator row using safe placeholder values. Kept as a module-level
// constant so the download and any future inline preview can share
// the same source of truth.
const OPERATOR_SAMPLE_CSV =
`username,password,first_name,last_name,email,phone
jdoe.op,ChangeMe123!,John,Doe,jdoe@example.com,+919999999999
asharma.op,ChangeMe123!,Aditi,Sharma,asharma@example.com,+919888888888`

function downloadOperatorSampleCsv() {
  // Excel-friendly UTF-8 BOM so the file opens with the right
  // encoding on double-click. Purely cosmetic — the backend parser
  // strips it — but standard for CSV downloads.
  const blob = new Blob(['﻿' + OPERATOR_SAMPLE_CSV], {
    type: 'text/csv;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'verification-agents-sample.csv'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function Operators() {
  const [operators, setOperators] = useState([])
  const [subs, setSubs] = useState([])
  const [walletBalancePaise, setWalletBalancePaise] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState(null) // operator id currently being edited
  const [bulking, setBulking] = useState(false)
  const [bulkExamID, setBulkExamID] = useState('')
  const [bulkFile, setBulkFile] = useState(null)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkResult, setBulkResult] = useState(null) // last response body

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

  async function onBulkUpload(e) {
    e?.preventDefault()
    if (!bulkExamID || !bulkFile) return
    setBulkBusy(true)
    setBulkResult(null)
    try {
      const { status, body } = await uploadExamCSV(bulkExamID, 'operators', bulkFile)
      setBulkResult({ status, body })
      if (status < 400) await refresh()
    } catch (err) {
      setBulkResult({ status: 0, body: { error: err.message || 'Bulk upload failed' } })
    } finally {
      setBulkBusy(false)
    }
  }

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
              <Button variant="secondary" onClick={() => { setBulking(v => !v); setCreating(false); setEditing(null) }}>
                {bulking ? 'Cancel bulk' : 'Bulk upload CSV'}
              </Button>
              <Button onClick={() => { setCreating(v => !v); setBulking(false); setEditing(null) }}>
                {creating ? 'Cancel' : '+ New verification agent'}
              </Button>
            </div>
          }
        />

        {bulking && (
          <Card className="mb-4">
            <CardBody>
              <div className="flex items-start justify-between gap-3 mb-1">
                <h3 className="text-sm font-semibold text-slate-900">Bulk-upload verification agents from CSV</h3>
                <button
                  type="button"
                  onClick={downloadOperatorSampleCsv}
                  className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 hover:border-slate-400 transition-colors shrink-0"
                  title="Download a ready-to-edit sample CSV with the required columns"
                >
                  Sample CSV
                </button>
              </div>
              <p className="text-xs text-slate-500 mb-3">
                Required columns: <code>username</code>, <code>password</code>, <code>first_name</code>,
                {' '}<code>last_name</code>, <code>email</code>. Extra columns (<code>phone</code>,
                {' '}<code>centre_code</code>, <code>lab_code</code>, <code>config_name</code>,
                {' '}<code>max_sessions</code>) are recognised but not stored. Comma OR tab-separated
                files both work — pick whichever your spreadsheet exports.
              </p>
              <form onSubmit={onBulkUpload} className="grid gap-3 sm:grid-cols-3 sm:items-end">
                <div>
                  <Label>Assign to exam</Label>
                  <select
                    value={bulkExamID}
                    onChange={(e) => setBulkExamID(e.target.value)}
                    className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                  >
                    <option value="">Pick a subscribed exam…</option>
                    {subs.map((s) => (
                      <option key={s.exam_id} value={s.exam_id}>
                        {s.exam_code} — {s.exam_name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="sm:col-span-1">
                  <Label>CSV file</Label>
                  <input
                    type="file"
                    accept=".csv,.txt,.tsv,text/csv,text/tab-separated-values"
                    onChange={(e) => setBulkFile(e.target.files?.[0] || null)}
                    className="block w-full text-sm text-slate-700 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200"
                  />
                </div>
                <div>
                  <Button type="submit" disabled={!bulkExamID || !bulkFile || bulkBusy}>
                    {bulkBusy ? 'Uploading…' : 'Upload'}
                  </Button>
                </div>
              </form>

              {bulkResult && (
                <div
                  className={`mt-3 rounded-lg px-3 py-2 text-sm border ${
                    bulkResult.status >= 200 && bulkResult.status < 300
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                      : 'bg-rose-50 border-rose-200 text-rose-700'
                  }`}
                >
                  {bulkResult.body?.error ? (
                    <p>{bulkResult.body.error}</p>
                  ) : (
                    <>
                      <p className="font-medium">
                        {bulkResult.body?.rows_created || 0} created ·{' '}
                        {bulkResult.body?.rows_assigned || 0} linked ·{' '}
                        {bulkResult.body?.rows_failed || 0} failed
                      </p>
                      {bulkResult.body?.skipped_columns?.length > 0 && (
                        <p className="text-xs mt-1 opacity-80">
                          Ignored columns: {bulkResult.body.skipped_columns.join(', ')}
                        </p>
                      )}
                      {bulkResult.body?.row_errors?.length > 0 && (
                        <ul className="mt-2 text-xs list-disc list-inside space-y-0.5">
                          {bulkResult.body.row_errors.slice(0, 10).map((e, i) => (
                            <li key={i}>{e.line ? `Line ${e.line}: ` : ''}{e.msg}</li>
                          ))}
                          {bulkResult.body.row_errors.length > 10 && (
                            <li>… {bulkResult.body.row_errors.length - 10} more</li>
                          )}
                        </ul>
                      )}
                    </>
                  )}
                </div>
              )}
            </CardBody>
          </Card>
        )}

        {subs.length === 0 && (
          <div className="mb-4 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
            You haven't subscribed to any exams yet — verification agents need at least one subscribed exam to verify against.{' '}
            <Link to="/admin/catalog" className="font-medium text-amber-900 hover:underline">Open catalog →</Link>
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
              <div className="flex items-start gap-3 mb-5">
                <div className="h-9 w-9 rounded-lg bg-stone-100 text-stone-800 flex items-center justify-center shrink-0">
                  <Icon.Plus className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-ink-900">New verification agent</h3>
                  <p className="text-xs text-stone-500 mt-0.5">
                    A per-agent login with an optional spending cap, date window, and one assigned exam.
                  </p>
                </div>
              </div>
              <OperatorForm
                subs={subs}
                walletBalancePaise={walletBalancePaise}
                mode="create"
                onCancel={() => setCreating(false)}
                onSaved={async () => { setCreating(false); await refresh() }}
              />
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

  const selected = subs.filter((s) => value.includes(s.exam_id))
  const allSelected = subs.length > 0 && selected.length === subs.length

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
                : `${selected.length} of ${subs.length} selected`}
            </span>
            <div className="flex gap-1">
              {!single && (
                <>
                  <button
                    type="button"
                    className="text-xs font-medium text-emerald-700 hover:underline disabled:text-slate-400 disabled:no-underline"
                    disabled={allSelected}
                    onClick={() => onChange(subs.map((s) => s.exam_id))}
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
            {subs.map((s) => {
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
  const [emailOtpToken, setEmailOtpToken] = useState('')
  const [capRupees, setCapRupees] = useState(operator?.spending_cap_paise ? String(operator.spending_cap_paise / 100) : '')
  const [validFrom, setValidFrom] = useState(operator?.valid_from || '')
  const [validTo, setValidTo] = useState(operator?.valid_to || '')
  const [examIds, setExamIds] = useState(operator?.assigned_exam_ids || [])
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const isEmailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  const emailUnchanged = isEdit && Boolean(initialEmail) && email.trim().toLowerCase() === initialEmail
  const isEmailVerified = emailUnchanged || Boolean(emailOtpToken)

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
    setSaving(true)
    setErr('')
    try {
      const capPaise = capRupees.trim() ? Math.round(Number(capRupees) * 100) : null
      if (isEdit) {
        if (!isEmailVerified) {
          setErr('Please verify the verification agent email with OTP before saving.')
          setSaving(false)
          return
        }
        const patch = { exam_ids: examIds }
        if (displayName !== operator.display_name) patch.display_name = displayName
        if (email.trim().toLowerCase() !== initialEmail) {
          patch.email = email.trim()
          patch.email_otp_token = emailOtpToken
        }
        if (password.trim()) patch.password = password
        if (validFrom !== (operator.valid_from || '')) patch.valid_from = validFrom
        if (validTo !== (operator.valid_to || '')) patch.valid_to = validTo
        if (capPaise === null && operator.spending_cap_paise) patch.clear_spending_cap = true
        else if (capPaise !== null && capPaise !== operator.spending_cap_paise) patch.spending_cap_paise = capPaise
        await patchOperator(operator.id, patch)
      } else {
        if (!isEmailVerified) {
          setErr('Please verify the verification agent email with OTP before creating.')
          setSaving(false)
          return
        }
        await createOperator({
          username: username.trim(),
          password,
          display_name: displayName.trim() || username.trim(),
          email: email.trim() || undefined,
          email_otp_token: emailOtpToken,
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
        <div className="sm:col-span-2">
          <OtpVerificationField
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="agent@college.edu"
            required
            isVerified={isEmailVerified}
            onVerified={(token) => {
              setEmailOtpToken(token)
              setErr('')
            }}
            onResetVerification={() => {
              setEmailOtpToken('')
            }}
            sendOtpFn={() => sendEmailOTP(email.trim(), 'operator_creation')}
            verifyOtpFn={(code) => verifyEmailOTP(email.trim(), code, 'operator_creation')}
            canSendOtp={isEmailValid && !emailUnchanged}
          />
          {!isEmailVerified && (
            <p className="text-[11px] text-slate-500 mt-1">
              Verify operator's email with OTP. Enter email and click <strong>Send OTP</strong> to verify.
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
          <>
            <ExamMultiSelect subs={subs} value={examIds} onChange={setExamIds} single />
            {examIds.length === 0 && (
              <p className="mt-1 text-xs text-rose-600">
                Assigning one exam is required.
              </p>
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
        <Button type="submit" disabled={saving || examIds.length === 0 || !isEmailVerified || capInvalid}>
          {saving ? 'Saving…' : (isEdit ? 'Save changes' : 'Create operator')}
        </Button>
      </div>
    </form>
  )
}
