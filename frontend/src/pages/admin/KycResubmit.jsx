import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Button, Card, CardBody, Input, Label } from '../../components/ui/ui.jsx'
import { Icon, Pill } from '../../components/ui/extras.jsx'
import { api } from '../../lib/api.js'
import { useAuth } from '../../lib/auth.jsx'
import { getStoredToken } from '../../lib/authStorage.js'

// Admin > KYC re-submit — the fix-and-resubmit surface for an
// application whose review landed as 'rejected'. Rendered outside the
// normal AdminShell chrome so the admin (who is still locked out) can
// reach it while every /api/admin/* endpoint (except the KYC-open
// ones we deliberately opened up) is 403.
//
// UX shape:
//   1. Fetch /api/admin/kyc-application → prefill.
//   2. Show reviewer's note at the top so applicant knows what to fix.
//   3. Editable field groups (institution / address / head) grouped
//      the same way as the register form.
//   4. Documents list with Replace / Remove per doc + Upload slots
//      for anything missing.
//   5. "Save & resubmit" button PATCHes then POSTs /resubmit; on
//      success bounces to /admin where the lock screen re-renders
//      as pending.
//
// Deliberately NOT a fork of Register.jsx — that file is huge and
// tightly coupled to the multi-step wizard. Rebuilding a simpler
// single-page form here keeps the resubmit path readable + easy to
// tweak without collateral risk on public registration.

const REQUIRED_DOCS = [
  { kind: 'recognition_letter',   label: 'Recognition letter',      hint: 'From UGC / AICTE / state education board' },
  { kind: 'pan_card',             label: 'PAN / TAN card',          hint: 'Institution or parent-trust PAN or TAN' },
  { kind: 'authorization_letter', label: 'Authorization letter',    hint: 'On letterhead, signed by the head' },
]
const OPTIONAL_DOCS = [
  { kind: 'naac_certificate',     label: 'NAAC / NBA certificate',  hint: 'Optional — strengthens the application' },
]

export default function KycResubmit() {
  const { user, logout } = useAuth()
  const nav = useNavigate()
  const [app, setApp] = useState(null)
  const [form, setForm] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [docsBusy, setDocsBusy] = useState({})   // { [kind]: true } for in-flight
  const [savedFlash, setSavedFlash] = useState(false)

  const load = useCallback(async () => {
    setErr('')
    try {
      const d = await api('/admin/kyc-application')
      setApp(d)
      // Snapshot editable fields into local form state so an in-flight
      // typo doesn't get PATCHed until Save.
      setForm({
        institution_name:      d.institution_name || '',
        institution_type:      d.institution_type || '',
        tier:                  d.tier || '',
        aishe_code:            d.aishe_code || '',
        pan:                   d.pan || '',
        year_established:      d.year_established || '',
        affiliation_body:      d.affiliation_body || '',
        address_line1:         d.address_line1 || '',
        address_line2:         d.address_line2 || '',
        city:                  d.city || '',
        district:              d.district || '',
        state:                 d.state || '',
        pin_code:              d.pin_code || '',
        approx_student_count:  d.approx_student_count || '',
        expected_centres:      d.expected_centres || 1,
        head_name:             d.head_name || '',
        head_designation:      d.head_designation || '',
        head_email:            d.head_email || '',
        head_mobile:           d.head_mobile || '',
      })
    } catch (e) {
      setErr(e?.body?.error || e?.message || 'Could not load your application')
    }
  }, [])

  useEffect(() => { load() }, [load])

  function set(k, v) {
    setForm((prev) => ({ ...prev, [k]: v }))
  }

  async function onReplaceOrUpload(kind, file) {
    if (!file) return
    setDocsBusy((b) => ({ ...b, [kind]: true }))
    setErr('')
    try {
      // If an existing doc of the same kind is on file, remove it
      // first so the DB doesn't accumulate duplicates. This matches
      // the register form's intent (one file per doc_kind).
      const existing = (app.docs || []).find((d) => d.doc_kind === kind)
      if (existing) {
        await api(`/admin/kyc-application/docs/${existing.doc_id}`, { method: 'DELETE' })
      }
      // Upload the fresh file via multipart. Reusing the raw fetch
      // path because our api() helper is JSON-only.
      const fd = new FormData()
      fd.append('doc_kind', kind)
      fd.append('file', file)
      const token = getStoredToken('admin')
      const res = await fetch('/api/admin/kyc-application/docs', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error || `HTTP ${res.status}`)
      }
      await load()
    } catch (e) {
      setErr(e?.message || 'Upload failed')
    } finally {
      setDocsBusy((b) => ({ ...b, [kind]: false }))
    }
  }

  async function onRemoveDoc(docID) {
    if (!confirm('Remove this document? You will need to upload a replacement before resubmitting.')) return
    setErr('')
    try {
      await api(`/admin/kyc-application/docs/${docID}`, { method: 'DELETE' })
      await load()
    } catch (e) {
      setErr(e?.body?.error || e?.message || 'Delete failed')
    }
  }

  async function onSaveOnly() {
    setBusy(true)
    setErr('')
    try {
      await api('/admin/kyc-application', { method: 'PATCH', body: form })
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 2000)
      await load()
    } catch (e) {
      setErr(e?.body?.error || e?.message || 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  async function onResubmit() {
    // Missing required docs are re-checked server-side; the FE guard
    // is just a nicer error surface.
    const haveKinds = new Set((app.docs || []).map((d) => d.doc_kind))
    const missing = REQUIRED_DOCS.filter((r) => !haveKinds.has(r.kind))
    if (missing.length) {
      setErr('Missing required documents: ' + missing.map((m) => m.label).join(', '))
      return
    }
    setBusy(true)
    setErr('')
    try {
      // Save any edits first, then flip to pending.
      await api('/admin/kyc-application', { method: 'PATCH', body: form })
      await api('/admin/kyc-application/resubmit', { method: 'POST' })
      nav('/admin', { replace: true })
    } catch (e) {
      setErr(e?.body?.error || e?.message || 'Resubmit failed')
    } finally {
      setBusy(false)
    }
  }

  function onLogout() {
    logout()
    nav('/admin/login', { replace: true })
  }

  if (!app || !form) {
    return (
      <div className="min-h-full bg-warm-page flex items-center justify-center">
        <div className="text-sm text-stone-500 animate-pulse">Loading your application…</div>
      </div>
    )
  }

  const haveKinds = new Set((app.docs || []).map((d) => d.doc_kind))
  const missingRequired = REQUIRED_DOCS.filter((r) => !haveKinds.has(r.kind))
  const canResubmit = missingRequired.length === 0

  return (
    <div className="min-h-full bg-warm-page">
      <header className="border-b border-warm bg-warm-surface/95 backdrop-blur sticky top-0 z-40">
        <div className="mx-auto max-w-4xl px-6 h-14 flex items-center gap-4">
          <div className="flex flex-col leading-tight">
            <span className="text-[13px] font-semibold text-stone-900 tracking-tight">Verification Portal</span>
            <span className="text-[10px] uppercase tracking-widest text-warm-accent">Admin · Re-submit</span>
          </div>
          <div className="flex-1" />
          <Link to="/admin" className="text-[12px] font-medium text-stone-600 hover:text-stone-900">
            ← Back to status
          </Link>
          {user?.display_name && (
            <span className="hidden md:inline text-[12px] text-stone-600 truncate max-w-[180px]">
              {user.display_name}
            </span>
          )}
          <button
            onClick={onLogout}
            className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-stone-800 hover:text-white bg-white hover:bg-stone-900 border border-warm-strong hover:border-stone-900 px-3 py-1.5 rounded-md shadow-sm transition-colors"
          >
            Sign out
          </button>
        </div>
      </header>

      <motion.main
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        className="mx-auto max-w-4xl px-6 py-10 space-y-6"
      >
        {/* Rejection note banner — first thing the applicant reads. */}
        {app.review_note && (
          <div className="rounded-xl bg-rose-50 border border-rose-200 p-4 flex items-start gap-3">
            <Icon.X className="h-5 w-5 text-rose-700 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-rose-900">Reviewer's note</p>
              <p className="mt-1 text-sm text-rose-800 whitespace-pre-wrap">{app.review_note}</p>
            </div>
          </div>
        )}

        <h1 className="text-2xl font-semibold text-ink-900 tracking-tight">Re-submit your application</h1>
        <p className="text-sm text-stone-600 -mt-4">
          Edit any fields the reviewer flagged, replace or re-upload documents, then hit
          <b> Save & resubmit for review</b>. Your account stays the same — no new
          password to set.
        </p>

        {err && (
          <div role="alert" className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
            {err}
          </div>
        )}
        {savedFlash && (
          <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-800">
            Changes saved.
          </div>
        )}

        <FormSection title="Institution" icon={Icon.Building}>
          <Row2>
            <Field label="Name">
              <Input value={form.institution_name} onChange={(e) => set('institution_name', e.target.value)} />
            </Field>
            <Field label="Type">
              <Input value={form.institution_type} onChange={(e) => set('institution_type', e.target.value)} />
            </Field>
          </Row2>
          <Row2>
            <Field label="AISHE code">
              <Input value={form.aishe_code} onChange={(e) => set('aishe_code', e.target.value)} />
            </Field>
            <Field label="PAN / TAN">
              <Input value={form.pan} onChange={(e) => set('pan', e.target.value.toUpperCase())} />
            </Field>
          </Row2>
          <Row2>
            <Field label="Year established">
              <Input type="number" value={form.year_established} onChange={(e) => set('year_established', e.target.value ? Number(e.target.value) : '')} />
            </Field>
            <Field label="Approx. student count">
              <Input type="number" value={form.approx_student_count} onChange={(e) => set('approx_student_count', e.target.value ? Number(e.target.value) : '')} />
            </Field>
          </Row2>
          <Field label="Affiliation body">
            <Input value={form.affiliation_body} onChange={(e) => set('affiliation_body', e.target.value)} />
          </Field>
        </FormSection>

        <FormSection title="Address" icon={Icon.MapPin}>
          <Field label="Address line 1">
            <Input value={form.address_line1} onChange={(e) => set('address_line1', e.target.value)} />
          </Field>
          <Field label="Address line 2">
            <Input value={form.address_line2} onChange={(e) => set('address_line2', e.target.value)} />
          </Field>
          <Row2>
            <Field label="City">
              <Input value={form.city} onChange={(e) => set('city', e.target.value)} />
            </Field>
            <Field label="District">
              <Input value={form.district} onChange={(e) => set('district', e.target.value)} />
            </Field>
          </Row2>
          <Row2>
            <Field label="State">
              <Input value={form.state} onChange={(e) => set('state', e.target.value)} />
            </Field>
            <Field label="PIN code">
              <Input value={form.pin_code} onChange={(e) => set('pin_code', e.target.value)} maxLength={6} />
            </Field>
          </Row2>
        </FormSection>

        <FormSection title="Head of institution" icon={Icon.Mail}>
          <Row2>
            <Field label="Name">
              <Input value={form.head_name} onChange={(e) => set('head_name', e.target.value)} />
            </Field>
            <Field label="Designation">
              <Input value={form.head_designation} onChange={(e) => set('head_designation', e.target.value)} />
            </Field>
          </Row2>
          <Row2>
            <Field label="Email">
              <Input type="email" value={form.head_email} onChange={(e) => set('head_email', e.target.value.toLowerCase())} />
            </Field>
            <Field label="Mobile (10-digit)">
              <Input value={form.head_mobile} onChange={(e) => set('head_mobile', e.target.value.replace(/\D/g, '').slice(0, 10))} />
            </Field>
          </Row2>
        </FormSection>

        <FormSection title="Documents" icon={Icon.FileText}>
          <DocsList
            docs={app.docs || []}
            docsBusy={docsBusy}
            onReplaceOrUpload={onReplaceOrUpload}
            onRemoveDoc={onRemoveDoc}
          />
          {missingRequired.length > 0 && (
            <p className="text-xs text-rose-600 mt-2">
              Missing required: {missingRequired.map((m) => m.label).join(', ')}.
            </p>
          )}
        </FormSection>

        <div className="flex flex-wrap items-center justify-end gap-3 pt-4 border-t border-warm">
          <Button variant="secondary" disabled={busy} onClick={onSaveOnly}>
            {busy ? 'Working…' : 'Save changes'}
          </Button>
          <Button disabled={busy || !canResubmit} onClick={onResubmit}>
            {busy ? 'Working…' : 'Save & resubmit for review'}
          </Button>
        </div>
      </motion.main>
    </div>
  )
}

function FormSection({ title, icon: I, children }) {
  return (
    <Card>
      <CardBody>
        <div className="flex items-center gap-2 mb-4">
          {I && <I className="h-4 w-4 text-warm-accent" />}
          <h3 className="text-sm font-semibold uppercase tracking-wider text-warm-accent">{title}</h3>
        </div>
        <div className="space-y-3">{children}</div>
      </CardBody>
    </Card>
  )
}

function Field({ label, children }) {
  return (
    <div>
      <Label>{label}</Label>
      {children}
    </div>
  )
}

function Row2({ children }) {
  return <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{children}</div>
}

function DocsList({ docs, docsBusy, onReplaceOrUpload, onRemoveDoc }) {
  const byKind = Object.fromEntries((docs || []).map((d) => [d.doc_kind, d]))
  return (
    <ul className="divide-y divide-warm rounded-lg border border-warm bg-white overflow-hidden">
      {[...REQUIRED_DOCS.map((r) => ({ ...r, required: true })),
        ...OPTIONAL_DOCS.map((o) => ({ ...o, required: false }))].map((slot) => {
        const doc = byKind[slot.kind]
        const busy = !!docsBusy[slot.kind]
        return (
          <li key={slot.kind} className="px-4 py-3 flex items-start gap-3">
            <span className="h-8 w-8 rounded-lg bg-stone-100 text-stone-700 flex items-center justify-center shrink-0">
              <Icon.FileText className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-stone-900">{slot.label}</span>
                {slot.required && !doc && <Pill tone="rose">required — missing</Pill>}
                {doc && <Pill tone="emerald" dot>On file</Pill>}
              </div>
              <p className="text-[11px] text-stone-500 mt-0.5">{slot.hint}</p>
              {doc && (
                <p className="text-[11px] text-stone-500 mt-1 font-mono truncate">
                  {doc.original_name} · {(doc.size_bytes / 1024).toFixed(0)} KB
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <label className="inline-flex items-center px-3 py-1.5 text-[12px] font-semibold rounded-md bg-white ring-1 ring-warm-strong text-stone-800 hover:bg-stone-100 cursor-pointer">
                {busy ? 'Uploading…' : doc ? 'Replace' : 'Upload'}
                <input
                  type="file"
                  className="hidden"
                  accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                  disabled={busy}
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    e.target.value = ''
                    onReplaceOrUpload(slot.kind, f)
                  }}
                />
              </label>
              {doc && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => onRemoveDoc(doc.doc_id)}
                  className="!text-rose-700"
                >
                  Remove
                </Button>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
