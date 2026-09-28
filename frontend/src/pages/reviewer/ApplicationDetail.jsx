import FvEmpty from '../../components/fv/FvEmpty.jsx'
import { RvSeal, RvPhoto, RvStamp, HindiName } from '../../components/fv/FvReviewer.jsx'
import { ArtCollege, AgentPortrait, InstitutionArt } from '../../components/fv/FvArt.jsx'
import { hi } from '../../components/fv/hindi.jsx'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
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
  const nav = useNavigate()
  const [app, setApp] = useState(null)
  const [err, setErr] = useState('')
  const [actionErr, setActionErr] = useState('')
  const [reviewing, setReviewing] = useState(false)
  const [note, setNote] = useState('')
  const [approvalResult, setApprovalResult] = useState(null)
  // Post-decision overlay (mirrors the superadmin app detail page).
  //   kind: 'approved' | 'rejected' | 'revoked'
  const [decisionResult, setDecisionResult] = useState(null)

  // Auto-redirect after a decision. Reviewer can click "Back to
  // inbox now" for immediate return; this timer is the walk-away
  // fallback so a decision doesn't just leave them staring at the
  // same detail page wondering if it went through.
  useEffect(() => {
    if (!decisionResult) return
    const t = setTimeout(() => nav('/reviewer'), 2000)
    return () => clearTimeout(t)
  }, [decisionResult, nav])

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
      setDecisionResult({
        kind: 'approved',
        title: 'Application approved',
        body: `${app?.institution_name || 'The institution'}'s admin dashboard is now unlocked. Activation email fires now.`,
      })
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
      setDecisionResult({
        kind: 'rejected',
        title: 'Application rejected',
        body: `${app?.institution_name || 'The applicant'} was notified by email with your note.`,
      })
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
      setDecisionResult({
        kind: 'revoked',
        title: 'Application revoked to Pending',
        body: `${app?.institution_name || 'The application'} is back in the pending queue.`,
      })
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
      {/* Post-decision popup — same shape the superadmin app-detail
          page uses. Auto-dismisses via nav to /reviewer 2 s after
          appearing; explicit "Back to inbox now" button skips the
          wait. Kept here so the reviewer gets clear confirmation
          instead of staring at the same page after clicking Approve
          or Reject. */}
      {decisionResult && (
        <DecisionResultCard
          result={decisionResult}
          onBack={() => nav('/reviewer')}
        />
      )}
      <div className="mb-4 flex items-center justify-between">
        <Link
          to="/reviewer"
          className="inline-flex items-center gap-1.5 rounded-[10px] border border-fv-line bg-fv-card px-3 py-2 text-[13.5px] font-bold text-fv-accent-deep transition-colors hover:bg-fv-card-focus"
        >
          <Icon.ChevronLeft className="h-4 w-4" />
          Back to inbox
        </Link>
        <div className="text-[13px] font-bold text-fv-muted tabular-nums">Application {app.id}</div>
      </div>

      <div className="relative mb-5 overflow-hidden rounded-[12px] border border-fv-line bg-fv-card">
        {/* the institution itself: a banner, drifting very slowly */}
        <div className="relative h-[168px] overflow-hidden bg-fv-card-focus">
          <span aria-hidden="true" className="fv-kenburns absolute inset-0 opacity-[0.5]">
            <InstitutionArt name={app.institution_name} photo={app.photo_url || app.logo_url} className="h-full w-full" />
          </span>
          <span aria-hidden="true" className="absolute inset-0"
                style={{ background: 'linear-gradient(to top, rgba(255,255,255,.96), rgba(255,255,255,.45) 55%, rgba(255,255,255,.18))' }} />
          <RvStamp status={app.status === 'approved' ? 'approved' : app.status === 'rejected' ? 'rejected' : null}
                   right="5%" className="h-16 w-44" />
        </div>

        {/* who they are, on a plate over the banner */}
        <div className="relative -mt-14 px-6 pb-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="flex min-w-0 items-end gap-4">
              <span className="grid h-24 w-24 shrink-0 place-items-center rounded-[16px] border border-fv-line bg-fv-card">
                <ArtCollege className="h-16 w-16" />
              </span>
              <div className="min-w-0 pb-1">
                <h1 className="fv-display text-[28px] leading-tight tracking-[-0.03em] text-fv-ink">
                  {app.institution_name}
                  <HindiName name={app.institution_name} given={app.institution_name_hi} className="text-[15px] font-medium" />
                </h1>
                <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13.5px] font-bold text-fv-ink">
                  <span>{cap(app.institution_type)}
                    {hi(cap(app.institution_type)) && <span className="fv-hi ml-1.5 text-[12px] font-medium text-fv-faint">{hi(cap(app.institution_type))}</span>}
                  </span>
                  {app.aishe_code && <span className="text-fv-muted">{isRecruiter ? 'Govt / CIN' : 'AISHE'} {app.aishe_code}</span>}
                  <span className="text-fv-muted">Submitted {formatRelative(app.created_at)}</span>
                </p>
              </div>
            </div>
            <div className="flex items-center gap-4 pb-1">
              <RvSeal status={app.status === 'approved' ? 'approved' : app.status === 'rejected' ? 'rejected' : 'pending'} />
            </div>
          </div>

          {/* where this application stands */}
          <ReviewSteps status={app.status} docCount={(app.docs || []).length} />
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
            <RvSection art={ArtCollege} title={isRecruiter ? 'Organization' : 'Institution'} />
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
            <RvSection art={PinArt} title={isRecruiter ? 'Registered office' : 'Address'} />
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
            <RvSection art={HeadArt} title={isRecruiter ? 'Nodal verification officer' : 'Head of institution'} />
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
                  <div className="px-4 py-3 text-[14px] font-bold text-fv-muted">Nothing uploaded yet</div>
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
                  <div className="flex h-[600px] items-center justify-center">
                    <FvEmpty title="No papers to read" body="Their scans appear here the moment they upload them."
                             mood="waiting" quip="Nothing to read yet. I checked." />
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
    <dl className="divide-y divide-fv-line">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-center gap-3 py-2.5 text-[14px]">
          <FactIcon label={k} />
          <dt className="w-36 shrink-0 text-fv-muted">
            {k}
            {hi(k) && <span className="fv-hi ml-1.5 text-[11.5px] text-fv-faint">{hi(k)}</span>}
          </dt>
          <dd className="flex-1 break-words text-fv-ink">{v || <span className="text-fv-faint">Not given</span>}</dd>
        </div>
      ))}
    </dl>
  )
}

// A small picture for whatever the row is about.
function FactIcon({ label = '' }) {
  const l = label.toLowerCase()
  const d = /type|category|sector/.test(l) ? <><rect x="4" y="9" width="16" height="11" rx="2" /><path d="M9 9V6h6v3M4 14h16" /></>
    : /aishe|cin|code/.test(l) ? <><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10h4M7 14h8M15 10h2" /></>
    : /pan|tan/.test(l) ? <><rect x="3" y="5" width="18" height="14" rx="2.5" /><circle cx="9" cy="11" r="2.2" /><path d="M6 16c.6-1.6 1.7-2.4 3-2.4s2.4.8 3 2.4M14.5 10h4M14.5 13.5h3" /></>
    : /year/.test(l) ? <><rect x="3" y="5" width="18" height="16" rx="2.5" /><path d="M8 3v4M16 3v4M3 10h18" /></>
    : /affiliation|body/.test(l) ? <><path d="M4 10l8-5 8 5" /><path d="M6 10v9M18 10v9M4 19h16" /></>
    : /student|approx/.test(l) ? <><circle cx="9" cy="9" r="3" /><path d="M3 19c0-3.4 2.6-5.6 6-5.6s6 2.2 6 5.6" /><circle cx="17" cy="8" r="2.4" /><path d="M16 13.4c2.4.2 4 1.9 4.6 4.6" /></>
    : /name|designation|head|officer/.test(l) ? <><circle cx="12" cy="8" r="4" /><path d="M5 20c0-3.9 3.1-6.4 7-6.4s7 2.5 7 6.4" /></>
    : /email|mail/.test(l) ? <><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M3.5 7 12 13l8.5-6" /></>
    : /mobile|phone/.test(l) ? <><rect x="7" y="3" width="10" height="18" rx="2.5" /><path d="M10.5 18h3" /></>
    : <><circle cx="12" cy="12" r="8.5" /><path d="M12 8v.01M12 11v5" /></>
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0 text-fv-accent" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
  )
}

// Where this application stands: papers in, your decision, their email.
function ReviewSteps({ status, docCount }) {
  const decided = status === 'approved' || status === 'rejected'
  const steps = [
    { title: 'Papers in', done: true, note: docCount ? `${docCount} document${docCount === 1 ? '' : 's'}` : 'None uploaded' },
    { title: 'Your decision', done: decided, note: decided ? (status === 'approved' ? 'Approved' : 'Rejected') : 'Waiting on you' },
    { title: 'They hear back', done: decided, note: decided ? 'Emailed' : 'After you decide' },
  ]
  return (
    <ol className="mt-5 flex flex-wrap items-center gap-2">
      {steps.map((st, i) => (
        <li key={st.title} className="flex items-center gap-2">
          <span className={`flex items-center gap-2 rounded-[10px] border px-3 py-2 ${
            st.done ? 'border-fv-line bg-fv-card' : 'border-dashed border-fv-disabled bg-transparent'}`}>
            <span className={`grid h-6 w-6 place-items-center rounded-full ${st.done ? 'bg-fv-accent text-white' : 'bg-fv-card-focus text-fv-accent'}`}>
              {st.done
                ? <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7" /></svg>
                : <span className="text-[12px] font-bold tabular-nums">{i + 1}</span>}
            </span>
            <span className="leading-tight">
              <span className="block text-[13.5px] text-fv-ink">{st.title}</span>
              <span className="block text-[12px] text-fv-muted">{st.note}</span>
            </span>
          </span>
          {i < steps.length - 1 && (
            <svg viewBox="0 0 24 12" className="h-3 w-6 shrink-0" aria-hidden="true">
              <path d="M1 6h16" stroke="#C3B6E8" strokeWidth="2" strokeDasharray="4 4" strokeLinecap="round" />
              <path d="M16 2l5 4-5 4" fill="none" stroke="#9A86D6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </li>
      ))}
    </ol>
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

// Post-decision lightbox. Mirror of the same component on the
// superadmin ApplicationDetail — kept as a per-file copy rather
// than a shared import because the two live in different frontend
// bundles (reviewer + client shell in /frontend, superadmin CP in
// /frontend-control-plane), so a shared file would need cross-
// bundle plumbing. Change both in lockstep if the visual changes.
function DecisionResultCard({ result, onBack }) {
  const palette = {
    approved: {
      bg: 'bg-emerald-50', ring: 'ring-emerald-200',
      iconBg: 'bg-emerald-100', iconFg: 'text-emerald-700',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
             strokeLinecap="round" strokeLinejoin="round" className="h-8 w-8" aria-hidden="true">
          <polyline points="5 12 10 17 20 7" />
        </svg>
      ),
    },
    rejected: {
      bg: 'bg-rose-50', ring: 'ring-rose-200',
      iconBg: 'bg-rose-100', iconFg: 'text-rose-700',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
             strokeLinecap="round" strokeLinejoin="round" className="h-8 w-8" aria-hidden="true">
          <path d="M6 6l12 12" /><path d="M6 18L18 6" />
        </svg>
      ),
    },
    revoked: {
      bg: 'bg-amber-50', ring: 'ring-amber-200',
      iconBg: 'bg-amber-100', iconFg: 'text-amber-700',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
             strokeLinecap="round" strokeLinejoin="round" className="h-8 w-8" aria-hidden="true">
          <path d="M3 12a9 9 0 1 0 3-6.7" /><polyline points="3 4 3 10 9 10" />
        </svg>
      ),
    },
  }[result.kind] || {
    bg: 'bg-slate-50', ring: 'ring-slate-200',
    iconBg: 'bg-slate-100', iconFg: 'text-slate-700',
    icon: null,
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
      <div className={`w-full max-w-md rounded-2xl ring-1 ${palette.ring} ${palette.bg} shadow-2xl p-6 text-center`}>
        <div className={`mx-auto h-14 w-14 rounded-full ${palette.iconBg} ${palette.iconFg} flex items-center justify-center`}>
          {palette.icon}
        </div>
        <h3 className="mt-4 text-lg font-semibold text-slate-900 tracking-tight">
          {result.title}
        </h3>
        <p className="mt-1 text-sm text-slate-600">{result.body}</p>
        <p className="mt-3 text-xs text-slate-500">Returning to your inbox…</p>
        <button
          type="button"
          onClick={onBack}
          className="mt-5 w-full rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 transition-colors"
        >
          Back to inbox now
        </button>
      </div>
    </div>
  )
}

// A section heading: its drawing, the word, and the word in Hindi.
function RvSection({ art: Art, title }) {
  const h = hi(title)
  return (
    <div className="mb-2.5 flex items-center gap-2.5">
      <Art className="h-8 w-8 shrink-0" />
      <h2 className="fv-display text-[17px] tracking-[-0.015em] text-fv-ink">{title}</h2>
      {h && <span className="fv-hi text-[13px] text-fv-faint">{h}</span>}
    </div>
  )
}
function PinArt({ className }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <path d="M16 3c-5 0-9 3.8-9 8.6C7 18 16 28 16 28s9-10 9-16.4C25 6.8 21 3 16 3z" fill="#F28C28" />
      <circle cx="16" cy="11.5" r="3.6" fill="#FFFFFF" />
      <ellipse cx="16" cy="29" rx="7" ry="1.8" fill="#EFEBF9" />
    </svg>
  )
}
function HeadArt({ className }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <circle cx="16" cy="16" r="16" fill="#EFEBF9" />
      <circle cx="16" cy="13" r="5.6" fill="#D9A47C" />
      <path d="M10.2 12.6c0-3.6 2.6-5.8 5.8-5.8s5.8 2.2 5.8 5.8c-1-1.8-2.4-2.9-4-3.2-1.2 1.1-4 1.9-7.6 3.2z" fill="#211E33" />
      <path d="M6 30c0-5.2 4.6-8.4 10-8.4S26 24.8 26 30z" fill="#5B3FA6" />
      <path d="M13.4 21.8 16 25l2.6-3.2" fill="#FFFFFF" />
    </svg>
  )
}
function DocsArt({ className }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect x="5" y="4" width="17" height="22" rx="2.4" fill="#FFFFFF" stroke="#DDD5F2" strokeWidth="1.6" transform="rotate(-7 13 15)" />
      <rect x="9" y="5" width="17" height="22" rx="2.4" fill="#FFFFFF" stroke="#9A86D6" strokeWidth="1.6" />
      <rect x="9" y="5" width="17" height="5" rx="2.4" fill="#5B3FA6" />
      <rect x="12" y="14" width="11" height="2" rx="1" fill="#DDD5F2" />
      <rect x="12" y="18" width="8" height="2" rx="1" fill="#EFEBF9" />
      <circle cx="24" cy="24" r="5" fill="#138808" />
      <path d="M21.8 24.1l1.5 1.5 2.9-3.2" fill="none" stroke="#FFFFFF" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
