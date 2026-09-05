import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import ReviewerShell from '../../components/reviewer/ReviewerShell.jsx'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Label,
} from '../../components/ui/ui.jsx'
import { Icon, SectionTitle } from '../../components/ui/extras.jsx'
import {
  getReviewerApplication,
  approveReviewerApplication,
  rejectReviewerApplication,
  revokeReviewerApplication,
} from '../../lib/reviewer/api.js'
import { getStoredToken } from '../../lib/authStorage.js'

// Reviewer's per-application view. Layout mirrors the superadmin
// ApplicationDetail so a superadmin who is also a reviewer at another
// board sees the same shape both places.
//
// One deliberate difference: the "Admin account created" success card
// includes the shared operator credential (username + one-time
// password) since the reviewer, not the superadmin, is who hands
// these to the institution now. Also, "Back to queue" links to the
// reviewer inbox rather than the superadmin queue.

const STATUS_LABELS = {
  draft:    { label: 'Draft',          tone: 'slate',   dot: 'bg-slate-400' },
  pending:  { label: 'Pending review', tone: 'amber',   dot: 'bg-amber-500' },
  approved: { label: 'Approved',       tone: 'emerald', dot: 'bg-emerald-500' },
  rejected: { label: 'Rejected',       tone: 'rose',    dot: 'bg-rose-500' },
}

const DOC_META = {
  recognition_letter:   { label: 'Recognition letter',   icon: Icon.ShieldCheck },
  pan_card:             { label: 'PAN / TAN card',       icon: Icon.File },
  authorization_letter: { label: 'Authorization letter', icon: Icon.FileText },
  naac_certificate:     { label: 'NAAC / NBA certificate', icon: Icon.Sparkles },
  other:                { label: 'Other',                icon: Icon.File },
}

// A govt commission / recruitment body files different paperwork under
// the same doc_kind values, so the review screen has to label them the
// way the applicant saw them on the registration form
// (REQUIRED_DOCS_RECRUITMENT in pages/register/Register.jsx).
const DOC_META_RECRUITMENT = {
  recognition_letter:   { label: 'Gazette / Establishment / Mandate proof', icon: Icon.ShieldCheck },
  pan_card:             { label: 'Organization PAN / TAN',                  icon: Icon.File },
  authorization_letter: { label: 'Nodal officer authorization letter',      icon: Icon.FileText },
}

// Register.jsx offers three types — college, university, and "Govt
// Commission / Recruitment Body" (value 'other'). On submit it REPLACES
// 'other' with the free-text body name, so the stored institution_type
// reads e.g. "Staff Selection Commission" and testing for === 'other'
// would miss almost every real one. Anything that is not a college or a
// university is therefore a recruitment body.
const ACADEMIC_TYPES = ['college', 'university']

function isRecruiterType(t) {
  return !ACADEMIC_TYPES.includes(String(t || '').trim().toLowerCase())
}

export default function ReviewerApplicationDetail() {
  const { id } = useParams()
  const [app, setApp] = useState(null)
  const [err, setErr] = useState('')
  const [actionErr, setActionErr] = useState('')
  const [reviewing, setReviewing] = useState(false)
  const [note, setNote] = useState('')
  const [approvalResult, setApprovalResult] = useState(null)

  // Inline preview state — which doc is showing.
  const [activeDocId, setActiveDocId] = useState(null)
  const [docBlobUrl, setDocBlobUrl] = useState(null)
  const [docLoading, setDocLoading] = useState(false)
  const [docErr, setDocErr] = useState('')

  useEffect(() => {
    let alive = true
    getReviewerApplication(id)
      .then((d) => {
        if (!alive) return
        setApp(d)
        if (d.docs?.length > 0) setActiveDocId(d.docs[0].doc_id)
      })
      .catch((e) => alive && setErr(e.message))
    return () => { alive = false }
  }, [id])

  useEffect(() => {
    if (!app || !activeDocId) return
    const doc = app.docs.find((d) => d.doc_id === activeDocId)
    if (!doc) return

    let cancelled = false
    let blobUrl = null
    setDocLoading(true)
    setDocErr('')
    setDocBlobUrl(null)

    // Reviewer session is stored under the 'reviewer' scope — pass it
    // explicitly rather than deriving from the URL so we're immune to
    // future URL renames. See lib/authStorage.js for the scope map.
    const token = getStoredToken('reviewer')
    fetch(doc.download_url, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => null)
          throw new Error(body?.error || `HTTP ${res.status}`)
        }
        return res.blob()
      })
      .then((blob) => {
        if (cancelled) return
        blobUrl = URL.createObjectURL(blob)
        setDocBlobUrl(blobUrl)
      })
      .catch((e) => { if (!cancelled) setDocErr(e.message) })
      .finally(() => { if (!cancelled) setDocLoading(false) })

    return () => {
      cancelled = true
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    }
  }, [app, activeDocId])

  async function approve() {
    if (!confirm('Approve this institution? This creates an admin account and emails them an activation link. The verification agent credential is shown once — save it before you close this page.')) return
    setReviewing(true)
    setActionErr('')
    try {
      const res = await approveReviewerApplication(id, note)
      setApprovalResult(res)
      const d = await getReviewerApplication(id)
      setApp(d)
    } catch (e) {
      setActionErr(e.message)
    } finally {
      setReviewing(false)
    }
  }

  async function reject() {
    if (!note.trim()) {
      setActionErr('Please write a short reason in the note field — it goes to the applicant.')
      return
    }
    if (!confirm('Reject this application? The applicant will receive an email with your note.')) return
    setReviewing(true)
    setActionErr('')
    try {
      await rejectReviewerApplication(id, note.trim())
      const d = await getReviewerApplication(id)
      setApp(d)
    } catch (e) {
      setActionErr(e.message)
    } finally {
      setReviewing(false)
    }
  }

  async function revoke() {
    if (!confirm('Revoke this rejected application back to Pending review? It will move back to the pending queue and allow re-reviewing.')) return
    setReviewing(true)
    setActionErr('')
    try {
      await revokeReviewerApplication(id, note)
      const d = await getReviewerApplication(id)
      setApp(d)
      setNote('')
    } catch (e) {
      setActionErr(e.message)
    } finally {
      setReviewing(false)
    }
  }


  if (err) {
    return (
      <ReviewerShell>
        <div className="rounded-lg bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-800">{err}</div>
        <div className="mt-4">
          <Link to="/reviewer" className="text-sm text-stone-800 hover:underline">← Back to inbox</Link>
        </div>
      </ReviewerShell>
    )
  }

  if (!app) {
    return (
      <ReviewerShell>
        <div className="animate-pulse text-sm text-slate-500">Loading application…</div>
      </ReviewerShell>
    )
  }

  const meta = STATUS_LABELS[app.status] || STATUS_LABELS.draft
  const isPending = app.status === 'pending'
  // Drives the field labels below. A recruitment body files a gazette /
  // CIN reference where a college files an AISHE code, so showing the
  // academic labels for one misnames its paperwork on the review screen.
  const isRecruiter = isRecruiterType(app.institution_type)
  const activeDoc = app.docs.find((d) => d.doc_id === activeDocId)

  return (
    <ReviewerShell>
      <div className="mb-4 flex items-center justify-between">
        <Link
          to="/reviewer"
          className="inline-flex items-center gap-1 text-sm font-medium text-slate-600 hover:text-slate-900"
        >
          <Icon.ChevronLeft className="h-4 w-4" />
          Back to inbox
        </Link>
        <div className="text-xs text-slate-500 font-mono">Application #{app.id}</div>
      </div>

      <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(15,23,42,0.08)] mb-6">
        <div className="px-6 py-6 flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4 min-w-0">
            <span className="h-12 w-12 rounded-xl bg-brand-600 text-white flex items-center justify-center text-lg font-semibold shrink-0">
              {(app.institution_name || '?').slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-slate-900 truncate">
                  {app.institution_name}
                </h1>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700">
                  <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                  {meta.label}
                </span>
              </div>
              <p className="mt-1 text-sm text-slate-600">
                {cap(app.institution_type)}
                {app.aishe_code && ` · ${isRecruiter ? 'Govt / CIN Ref' : 'AISHE'} ${app.aishe_code}`}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                Submitted {formatRelative(app.created_at)}
              </p>
            </div>
          </div>
          {approvalResult && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 text-emerald-800 px-3 py-1 text-xs font-medium">
              <Icon.Check className="h-3.5 w-3.5" />
              Approved
            </span>
          )}
        </div>
      </div>

      {actionErr && (
        <div className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-800">{actionErr}</div>
      )}

      {approvalResult && (
        <ApprovalResultCard result={approvalResult} />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 mb-32">
        {/* LEFT: applicant data */}
        <div className="lg:col-span-2 space-y-5">
          <div>
            <SectionTitle icon={Icon.Building}>{isRecruiter ? 'Organization' : 'Institution'}</SectionTitle>
            <Card>
              <CardBody>
                <DefList rows={[
                  ['Type', cap(app.institution_type)],
                  [isRecruiter ? 'Govt / CIN Ref' : 'AISHE code', app.aishe_code || '—'],
                  [isRecruiter ? 'Organization PAN / TAN' : 'PAN / TAN', app.pan || '—'],
                  ['Year established', app.year_established || '—'],
                  [isRecruiter ? 'Sector / Category' : 'Affiliation', app.affiliation_body || '—'],
                  // Student headcount is an academic-only field; the
                  // registration form never asks a recruitment body for it,
                  // so showing it here only ever rendered a dash.
                  !isRecruiter
                    ? ['Approx. students', app.approx_student_count ? app.approx_student_count.toLocaleString() : '—']
                    : null,
                ].filter(Boolean)} />
              </CardBody>
            </Card>
          </div>

          <div>
            <SectionTitle icon={Icon.MapPin}>{isRecruiter ? 'Registered office' : 'Address'}</SectionTitle>
            <Card>
              <CardBody>
                <p className="text-sm text-slate-900 leading-relaxed">
                  {app.address_line1}
                  {app.address_line2 && <>, {app.address_line2}</>}
                  <br />
                  {[app.city, app.district].filter(Boolean).join(', ')}<br />
                  {app.state} — <span className="font-mono">{app.pin_code}</span>
                </p>
              </CardBody>
            </Card>
          </div>

          <div>
            <SectionTitle icon={Icon.Mail}>{isRecruiter ? 'Nodal verification officer' : 'Head of institution'}</SectionTitle>
            <Card>
              <CardBody>
                <DefList rows={[
                  ['Name', app.head_name],
                  ['Designation', app.head_designation],
                  ['Email', <a key="em" href={`mailto:${app.head_email}`} className="text-stone-800 hover:underline inline-flex items-center gap-1"><Icon.Mail className="h-3.5 w-3.5" />{app.head_email}</a>],
                  ['Mobile', <a key="m" href={`tel:${app.head_mobile}`} className="text-stone-800 hover:underline inline-flex items-center gap-1"><Icon.Phone className="h-3.5 w-3.5" />{app.head_mobile}</a>],
                ]} />
              </CardBody>
            </Card>
          </div>

          {app.review_note && (
            <div>
              <SectionTitle icon={Icon.FileText}>Previous review note</SectionTitle>
              <Card>
                <CardBody>
                  <div className="rounded-lg bg-slate-50 border border-slate-200 p-3">
                    <p className="text-sm text-slate-700 whitespace-pre-wrap">{app.review_note}</p>
                    {app.reviewed_at && (
                      <p className="mt-2 text-xs text-slate-500">{formatRelative(app.reviewed_at)}</p>
                    )}
                  </div>
                </CardBody>
              </Card>
            </div>
          )}
        </div>

        {/* RIGHT: doc previewer */}
        <div className="lg:col-span-3">
          <SectionTitle
            icon={Icon.FileText}
            action={<span className="text-xs text-slate-500">{app.docs.length} document{app.docs.length === 1 ? '' : 's'}</span>}
          >
            Documents
          </SectionTitle>
          <Card className="overflow-hidden">
            <CardHeader className="!py-0 !px-0 !border-b-0">
              <div className="flex items-center gap-1 px-2 bg-slate-50/50 border-b border-slate-200 overflow-x-auto">
                {app.docs.map((d) => {
                  const active = d.doc_id === activeDocId
                  const docMeta = (isRecruiter && DOC_META_RECRUITMENT[d.doc_kind])
                    || DOC_META[d.doc_kind] || DOC_META.other
                  const DocIcon = docMeta.icon
                  return (
                    <button
                      key={d.doc_id}
                      onClick={() => setActiveDocId(d.doc_id)}
                      className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-3 text-sm font-medium border-b-2 transition-colors ${
                        active
                          ? 'border-stone-900 text-stone-900'
                          : 'border-transparent text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      <DocIcon className={`h-4 w-4 ${active ? 'text-stone-900' : 'text-slate-400'}`} />
                      {docMeta.label}
                    </button>
                  )
                })}
                {app.docs.length === 0 && (
                  <div className="px-4 py-3 text-sm text-slate-500">No documents uploaded</div>
                )}
              </div>
            </CardHeader>
            <CardBody className="!p-0">
              {activeDoc && (
                <div className="px-4 py-2 border-b border-slate-100 flex items-center justify-between text-xs text-slate-500">
                  <div className="truncate">
                    <span className="text-slate-700">{activeDoc.original_name}</span>
                    {' · '}{activeDoc.mime} · {(activeDoc.size_bytes / 1024).toFixed(0)} KB
                  </div>
                  {docBlobUrl && (
                    <a
                      href={docBlobUrl}
                      target="_blank"
                      rel="noopener"
                      download={activeDoc.original_name}
                      className="inline-flex items-center gap-1 text-stone-800 hover:text-stone-900 shrink-0 ml-3 font-medium"
                    >
                      Open
                      <Icon.ArrowRight className="h-3 w-3" />
                    </a>
                  )}
                </div>
              )}
              <div className="bg-slate-50" style={{ minHeight: '600px' }}>
                {docLoading && (
                  <div className="h-[600px] flex items-center justify-center text-sm text-slate-500">
                    Loading document…
                  </div>
                )}
                {docErr && (
                  <div className="h-[600px] flex items-center justify-center px-6">
                    <div className="rounded-lg bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-800">
                      Couldn't load document: {docErr}
                    </div>
                  </div>
                )}
                {!docLoading && !docErr && docBlobUrl && activeDoc && (
                  <DocPreview blobUrl={docBlobUrl} mime={activeDoc.mime} />
                )}
                {!activeDoc && app.docs.length === 0 && (
                  <div className="h-[600px] flex items-center justify-center text-sm text-slate-500">
                    No documents to preview
                  </div>
                )}
              </div>
              {activeDoc && (
                <div className="px-4 py-2 border-t border-slate-100 flex items-center justify-between text-xs text-slate-400">
                  <span>sha256: <code className="text-slate-500">{activeDoc.sha256.slice(0, 16)}…</code></span>
                  <span>uploaded {formatRelative(activeDoc.uploaded_at)}</span>
                </div>
              )}
            </CardBody>
          </Card>
        </div>
      </div>

      {isPending && (
        <div className="fixed bottom-0 left-0 right-0 bg-white/95 backdrop-blur border-t border-slate-200 shadow-[0_-8px_24px_rgba(15,23,42,0.06)] z-40">
          <div className="mx-auto max-w-6xl px-6 py-4 flex flex-wrap items-end gap-4">
            <div className="flex-1 min-w-[280px]">
              <Label className="!mb-1 !text-xs">
                Review note
                <span className="ml-1.5 text-slate-400 font-normal">
                  (required to reject, optional to approve)
                </span>
              </Label>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={1}
                placeholder="What did you verify? Any concerns? This note is emailed to the applicant on reject."
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-stone-500 focus:outline-none focus:ring-2 focus:ring-stone-200 resize-y min-h-[40px]"
              />
            </div>
            <div className="flex gap-2 shrink-0">
              <Button variant="danger" disabled={reviewing} onClick={reject} size="lg">
                <Icon.X className="h-4 w-4 mr-1.5" />
                {reviewing ? 'Working…' : 'Reject'}
              </Button>
              <Button variant="success" disabled={reviewing} onClick={approve} size="lg">
                <Icon.Check className="h-4 w-4 mr-1.5" />
                {reviewing ? 'Working…' : 'Approve & activate'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {app.status === 'rejected' && (
        <div className="fixed bottom-0 left-0 right-0 bg-white/95 backdrop-blur border-t border-slate-200 shadow-[0_-8px_24px_rgba(15,23,42,0.06)] z-40">
          <div className="mx-auto max-w-6xl px-6 py-4 flex flex-wrap items-center justify-between gap-4">
            <div className="text-xs text-slate-600">
              <span className="font-semibold text-rose-700">Application Rejected</span>
              {app.review_note && <span className="ml-1 text-slate-500"> — Reason: {app.review_note}</span>}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                disabled={reviewing}
                onClick={revoke}
                size="md"
                className="!text-amber-700 !border-amber-300 hover:!bg-amber-50 hover:!border-amber-400 font-semibold"
              >
                <Icon.RefreshCw className={`h-4 w-4 mr-1.5 ${reviewing ? 'animate-spin' : ''}`} />
                {reviewing ? 'Revoking…' : 'Revoke to Pending'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </ReviewerShell>
  )
}

// Approval-success card. Post-2026-08-25 rebuild: the admin account +
// magic link were minted at register-submit time, not at approval, so
// there are no fresh credentials to hand out here. Card is now a
// short confirmation — the applicant already got the welcome email
// with their username, and they'll get an "approved" email now.
function ApprovalResultCard({ result }) {
  return (
    <div className="mb-6 rounded-xl bg-emerald-50 border border-emerald-200 p-4">
      <div className="flex items-start gap-3">
        <span className="h-9 w-9 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0">
          <Icon.Check className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-emerald-900">Application approved</p>
          <p className="mt-1 text-xs text-emerald-800">
            The institution's admin dashboard is now unlocked. They received their sign-in
            credentials by email at registration time and will get an approval notification now.
          </p>
        </div>
      </div>
    </div>
  )
}

function CredBlock({ label, value, mono, link, warn }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    try {
      navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {}
  }
  return (
    <div className={`rounded-lg bg-white px-3 py-2 ring-1 ${warn ? 'ring-amber-300' : 'ring-emerald-200'}`}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[10px] uppercase tracking-wider text-slate-500">{label}</p>
        <button
          onClick={copy}
          className="text-[11px] font-semibold text-stone-800 hover:text-stone-900"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {link ? (
        <a
          href={value}
          className={`mt-0.5 block text-sm break-all ${mono ? 'font-mono' : ''} text-emerald-900 underline`}
          target="_blank"
          rel="noopener"
        >
          {value}
        </a>
      ) : (
        <p className={`mt-0.5 text-sm text-slate-900 truncate ${mono ? 'font-mono' : ''}`}>
          {value}
        </p>
      )}
      {warn && (
        <p className="mt-1 text-[10px] text-amber-700">Shown once. Not retrievable later.</p>
      )}
    </div>
  )
}

function DocPreview({ blobUrl, mime }) {
  if (mime.startsWith('image/')) {
    return (
      <div className="flex items-center justify-center p-4" style={{ minHeight: '600px' }}>
        <img
          src={blobUrl}
          alt="document preview"
          className="max-w-full max-h-[700px] object-contain shadow-sm border border-slate-200 bg-white"
        />
      </div>
    )
  }
  return (
    <iframe
      src={blobUrl}
      title="document preview"
      className="w-full bg-white border-0"
      style={{ height: '700px' }}
    />
  )
}

function DefList({ rows }) {
  return (
    <dl className="space-y-2">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-baseline gap-3 text-sm">
          <dt className="w-32 shrink-0 text-slate-500">{k}</dt>
          <dd className="flex-1 text-slate-900 break-words">{v || <span className="text-slate-400">—</span>}</dd>
        </div>
      ))}
    </dl>
  )
}

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : '' }
function formatRelative(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const diffMin = (now - d) / 60000
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${Math.round(diffMin)}m ago`
  if (diffMin < 60 * 24) return `${Math.round(diffMin / 60)}h ago`
  return d.toLocaleString()
}
