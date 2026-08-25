import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import SuperShell, { PageHead } from '../../components/shell/SuperShell.jsx'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Label,
} from '../../components/ui/ui.jsx'
import { Icon, Pill, SectionTitle } from '../../components/ui/extras.jsx'
import { api } from '../../lib/api.js'
import { getRoleScope, getStoredToken } from '../../lib/authStorage.js'

// Reviewer-first redesign.
//
// Layout (desktop):
//
//   ┌──────────────────────────────────────────────┐
//   │ ← Back   Status pill   Institution name      │
//   ├─────────────────────┬────────────────────────┤
//   │ Applicant data      │  Document preview      │
//   │ (scrolls)           │  ┌────────────────┐    │
//   │  - Institution      │  │ tabs: recogn / │    │
//   │  - Address          │  │ PAN / auth     │    │
//   │  - Head             │  ├────────────────┤    │
//   │  - Previous note    │  │                │    │
//   │                     │  │  PDF / image   │    │
//   │                     │  │  inline        │    │
//   │                     │  │                │    │
//   │                     │  └────────────────┘    │
//   ├─────────────────────┴────────────────────────┤
//   │ Sticky action bar: [note] [✗ Reject] [✓ Approve] │
//   └──────────────────────────────────────────────┘
//
// On mobile the doc preview stacks below the data. Action bar stays
// pinned at the bottom of the viewport on all sizes so the admin
// never has to scroll to act.

const STATUS_LABELS = {
  draft: { label: 'Draft', tone: 'slate', dot: 'bg-slate-400' },
  pending: { label: 'Pending review', tone: 'amber', dot: 'bg-amber-500' },
  approved: { label: 'Approved', tone: 'emerald', dot: 'bg-emerald-500' },
  rejected: { label: 'Rejected', tone: 'rose', dot: 'bg-rose-500' },
}

const DOC_META = {
  recognition_letter:   { label: 'Recognition letter',   icon: Icon.ShieldCheck },
  pan_card:             { label: 'PAN card',             icon: Icon.File },
  authorization_letter: { label: 'Authorization letter', icon: Icon.FileText },
  naac_certificate:     { label: 'NAAC certificate',     icon: Icon.Sparkles },
  other:                { label: 'Other',                icon: Icon.File },
}

export default function ApplicationDetail() {
  const { id } = useParams()
  const [app, setApp] = useState(null)
  const [err, setErr] = useState('')
  const [actionErr, setActionErr] = useState('')
  const [reviewing, setReviewing] = useState(false)
  const [note, setNote] = useState('')
  const [approvalResult, setApprovalResult] = useState(null)

  // Client-routing state (V15 flow). Applicants register without
  // specifying a target board, so the superadmin picks one here and
  // the app moves into the queue that client's kyc_review_mode dictates.
  const [clients, setClients] = useState([])
  const [routeClientId, setRouteClientId] = useState('')
  const [routing, setRouting] = useState(false)
  const [showRouteChanger, setShowRouteChanger] = useState(false)

  // Inline preview state — which doc is showing.
  const [activeDocId, setActiveDocId] = useState(null)
  const [docBlobUrl, setDocBlobUrl] = useState(null)
  const [docLoading, setDocLoading] = useState(false)
  const [docErr, setDocErr] = useState('')

  // Load application detail.
  useEffect(() => {
    let alive = true
    api(`/superadmin/applications/${id}`)
      .then((d) => {
        if (!alive) return
        setApp(d)
        // Auto-pick the first doc to preview when the page opens.
        if (d.docs?.length > 0) setActiveDocId(d.docs[0].doc_id)
      })
      .catch((e) => alive && setErr(e.message))
    return () => {
      alive = false
    }
  }, [id])

  // One-shot fetch of the visible+open clients for the route picker.
  // Cheap (<10 rows typical); no need to refresh on every mount action.
  useEffect(() => {
    let alive = true
    api('/superadmin/clients')
      .then((d) => {
        if (!alive) return
        const visible = (d.clients || []).filter((c) => c.visible && !c.closed)
        setClients(visible)
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  async function routeToClient() {
    if (!routeClientId) return
    setRouting(true)
    setActionErr('')
    try {
      await api(`/superadmin/applications/${id}/route`, {
        method: 'POST',
        body: { client_id: Number(routeClientId) },
      })
      const d = await api(`/superadmin/applications/${id}`)
      setApp(d)
      setShowRouteChanger(false)
      setRouteClientId('')
    } catch (e) {
      setActionErr(e?.body?.error || e.message || 'Could not route application')
    } finally {
      setRouting(false)
    }
  }

  // When the active doc changes, fetch + render it inline. We do this
  // via authenticated fetch → blob URL because the download endpoint
  // demands a Bearer token (so a plain <iframe src=…> wouldn't work).
  useEffect(() => {
    if (!app || !activeDocId) return
    const doc = app.docs.find((d) => d.doc_id === activeDocId)
    if (!doc) return

    let cancelled = false
    let blobUrl = null
    setDocLoading(true)
    setDocErr('')
    setDocBlobUrl(null)

    // Read the token from the path-scoped storage (superadmin's) so
    // this works regardless of which other portals the user has open
    // in other tabs. See lib/authStorage.js for the scoping rationale.
    const token = getStoredToken(getRoleScope())
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
      .catch((e) => {
        if (!cancelled) setDocErr(e.message)
      })
      .finally(() => {
        if (!cancelled) setDocLoading(false)
      })

    return () => {
      cancelled = true
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    }
  }, [app, activeDocId])

  async function approve() {
    if (!confirm('Approve this institution? This creates an admin account and emails them an activation link.')) return
    setReviewing(true)
    setActionErr('')
    try {
      const res = await api(`/superadmin/applications/${id}/approve`, {
        method: 'POST',
        body: { note },
      })
      setApprovalResult(res)
      const d = await api(`/superadmin/applications/${id}`)
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
      await api(`/superadmin/applications/${id}/reject`, {
        method: 'POST',
        body: { note: note.trim() },
      })
      const d = await api(`/superadmin/applications/${id}`)
      setApp(d)
    } catch (e) {
      setActionErr(e.message)
    } finally {
      setReviewing(false)
    }
  }

  if (err) {
    return (
      <SuperShell>
        <div className="rounded-lg bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-800">{err}</div>
        <div className="mt-4">
          <Link to="/superadmin/applications" className="text-sm text-indigo-600 hover:underline">← Back to queue</Link>
        </div>
      </SuperShell>
    )
  }

  if (!app) {
    return (
      <SuperShell>
        <div className="animate-pulse text-sm text-slate-500">Loading application…</div>
      </SuperShell>
    )
  }

  const meta = STATUS_LABELS[app.status] || STATUS_LABELS.draft
  const isPending = app.status === 'pending'
  const activeDoc = app.docs.find((d) => d.doc_id === activeDocId)
  // V15 gating: superadmin action bar only shows when THIS actor owns
  // the decision. If routed to a mode='client' board, the client
  // reviewer decides — superadmin's approve/reject buttons hide with
  // an explanatory strip in their place. NULL pending_reviewer on a
  // pending row (legacy pre-V15) is treated as admin-owned.
  const superadminOwnsDecision = isPending && (
    !app.pending_reviewer || app.pending_reviewer === 'admin'
  )
  const bothModeIntermediate =
    isPending && app.pending_reviewer === 'admin' && app.client_kyc_review_mode === 'both'

  return (
    <SuperShell>
      {/* HEADER: back link + status + hero card */}
      <div className="mb-4 flex items-center justify-between">
        <Link
          to="/superadmin/applications"
          className="inline-flex items-center gap-1 text-sm font-medium text-slate-600 hover:text-slate-900"
        >
          <Icon.ChevronLeft className="h-4 w-4" />
          Back to queue
        </Link>
        <div className="text-xs text-slate-500 font-mono">Application #{app.id}</div>
      </div>

      {/* Refined hero: dark slate card with a single subtle status
          dot. No saturated gradient. The brand "feel" stays
          minimalist + premium, not marketing-y. */}
      <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(15,23,42,0.08)] mb-6">
        <div className="px-6 py-6 flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4 min-w-0">
            <span className="h-12 w-12 rounded-xl bg-slate-900 text-white flex items-center justify-center text-lg font-semibold shrink-0">
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
                {app.tier && ` · ${tierLabel(app.tier)}`}
                {app.aishe_code && ` · AISHE ${app.aishe_code}`}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                Submitted {formatRelative(app.created_at)}
              </p>
            </div>
          </div>
          {approvalResult && approvalResult.admin_username && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 text-emerald-800 px-3 py-1 text-xs font-medium">
              <Icon.Check className="h-3.5 w-3.5" />
              Approved · magic link sent
            </span>
          )}
          {approvalResult && !approvalResult.admin_username && approvalResult.pending_reviewer === 'client' && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 text-indigo-800 px-3 py-1 text-xs font-medium">
              <Icon.ShieldCheck className="h-3.5 w-3.5" />
              Sent to client reviewer
            </span>
          )}
        </div>
      </div>

      {actionErr && (
        <div className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-800">{actionErr}</div>
      )}

      {approvalResult && (approvalResult.admin_username || approvalResult.magic_link_url) && (
        <div className="mb-6 rounded-xl bg-emerald-50 border border-emerald-200 p-4 flex items-start gap-3">
          <span className="h-9 w-9 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0">
            <Icon.Check className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-emerald-900">Admin account created</p>
            <p className="mt-1 text-xs text-emerald-800">
              Username: <code className="bg-white px-1.5 py-0.5 rounded text-xs font-mono ring-1 ring-emerald-200">{approvalResult.admin_username}</code>
            </p>
            <p className="mt-1 text-xs text-emerald-800 break-all">
              Magic link (also in backend logs):{' '}
              <a className="text-emerald-900 underline font-medium" href={approvalResult.magic_link_url}>{approvalResult.magic_link_url}</a>
            </p>
          </div>
        </div>
      )}
      {approvalResult && !approvalResult.admin_username && approvalResult.pending_reviewer === 'client' && (
        <div className="mb-6 rounded-xl bg-indigo-50 border border-indigo-200 p-4 flex items-start gap-3">
          <span className="h-9 w-9 rounded-lg bg-indigo-100 text-indigo-700 flex items-center justify-center shrink-0">
            <Icon.ShieldCheck className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-indigo-900">Sent to client reviewer for final approval</p>
            <p className="mt-1 text-xs text-indigo-800">
              Your approval was recorded (step 1 of 2). No admin account has been created yet — the client reviewer will do the final approve, which creates the admin + activation link.
            </p>
          </div>
        </div>
      )}

      {/* V15 routing panel — only for pending apps. Shows current
          client attachment + lets superadmin pick / change the client
          the KYC review is routed to. */}
      {isPending && (
        <RoutingPanel
          app={app}
          clients={clients}
          routeClientId={routeClientId}
          setRouteClientId={setRouteClientId}
          onRoute={routeToClient}
          routing={routing}
          showChanger={showRouteChanger}
          setShowChanger={setShowRouteChanger}
        />
      )}

      {/* MAIN GRID: data on the left, doc preview on the right */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 mb-32">
        {/* LEFT: applicant data — takes 2/5 of width on lg+ */}
        <div className="lg:col-span-2 space-y-5">
          <div>
            <SectionTitle icon={Icon.Building}>Institution</SectionTitle>
            <Card>
              <CardBody>
                <DefList rows={[
                  ['Type', cap(app.institution_type)],
                  ['Tier', tierLabel(app.tier)],
                  ['AISHE code', app.aishe_code || '—'],
                  ['PAN', app.pan || '—'],
                  ['Year established', app.year_established || '—'],
                  ['Affiliation', app.affiliation_body || '—'],
                  ['Approx. students', app.approx_student_count ? app.approx_student_count.toLocaleString() : '—'],
                ]} />
              </CardBody>
            </Card>
          </div>

          <div>
            <SectionTitle icon={Icon.MapPin}>Address</SectionTitle>
            <Card>
              <CardBody>
                <p className="text-sm text-slate-900 leading-relaxed">
                  {app.address_line1}
                  {app.address_line2 && <>, {app.address_line2}</>}
                  <br />
                  {app.city}{app.district && `, ${app.district}`}<br />
                  {app.state} — <span className="font-mono">{app.pin_code}</span>
                </p>
              </CardBody>
            </Card>
          </div>

          <div>
            <SectionTitle icon={Icon.Mail}>Head of institution</SectionTitle>
            <Card>
              <CardBody>
                <DefList rows={[
                  ['Name', app.head_name],
                  ['Designation', app.head_designation],
                  ['Email', <a key="em" href={`mailto:${app.head_email}`} className="text-indigo-600 hover:underline inline-flex items-center gap-1"><Icon.Mail className="h-3.5 w-3.5" />{app.head_email}</a>],
                  ['Mobile', <a key="m" href={`tel:${app.head_mobile}`} className="text-indigo-600 hover:underline inline-flex items-center gap-1"><Icon.Phone className="h-3.5 w-3.5" />{app.head_mobile}</a>],
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

        {/* RIGHT: doc previewer — 3/5 of width on lg+ */}
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
                  const docMeta = DOC_META[d.doc_kind] || DOC_META.other
                  const DocIcon = docMeta.icon
                  return (
                    <button
                      key={d.doc_id}
                      onClick={() => setActiveDocId(d.doc_id)}
                      className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-3 text-sm font-medium border-b-2 transition-colors ${
                        active
                          ? 'border-indigo-600 text-indigo-700'
                          : 'border-transparent text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      <DocIcon className={`h-4 w-4 ${active ? 'text-indigo-600' : 'text-slate-400'}`} />
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
                      className="inline-flex items-center gap-1 text-indigo-600 hover:text-indigo-700 shrink-0 ml-3 font-medium"
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

      {/* STICKY ACTION BAR — only when THIS actor owns the decision.
          If routed to a mode='client' board, the client reviewer decides
          and we swap the bar for an explanatory strip. */}
      {superadminOwnsDecision && (
        <div className="fixed bottom-0 left-0 right-0 bg-white/95 backdrop-blur border-t border-slate-200 shadow-[0_-8px_24px_rgba(15,23,42,0.06)] z-40">
          <div className="mx-auto max-w-7xl px-6 py-4 flex flex-wrap items-end gap-4">
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
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 resize-y min-h-[40px]"
              />
            </div>
            <div className="flex gap-2 shrink-0">
              <Button variant="danger" disabled={reviewing} onClick={reject} size="lg">
                <Icon.X className="h-4 w-4 mr-1.5" />
                {reviewing ? 'Working…' : 'Reject'}
              </Button>
              <Button variant="success" disabled={reviewing} onClick={approve} size="lg">
                <Icon.Check className="h-4 w-4 mr-1.5" />
                {reviewing
                  ? 'Working…'
                  : (bothModeIntermediate ? 'Approve — pass to client reviewer' : 'Approve & activate')}
              </Button>
            </div>
          </div>
        </div>
      )}
      {isPending && !superadminOwnsDecision && (
        <div className="fixed bottom-0 left-0 right-0 bg-amber-50/95 backdrop-blur border-t border-amber-200 z-40">
          <div className="mx-auto max-w-7xl px-6 py-3 flex items-center gap-3 text-sm text-amber-900">
            <Icon.ShieldCheck className="h-4 w-4 shrink-0" />
            <span>
              Handed off to <span className="font-semibold">{app.client_name || 'the client'}</span>'s reviewer for approval.
              This board's <code className="text-xs bg-amber-100 px-1 py-0.5 rounded">kyc_review_mode</code> is set to <b>{app.client_kyc_review_mode || 'client'}</b>.
            </span>
          </div>
        </div>
      )}
    </SuperShell>
  )
}

// RoutingPanel — inline "Route to client" widget shown at the top of
// every pending application. Two states:
//
//   - No client attached yet → picker + Route button.
//   - Already routed → shows current client + mode + a small "Change"
//     control (mistakes happen; re-routing before approval is cheap).
//
// Colours follow the reviewer-portal warm palette so the panel reads as
// a routing decision, not part of the KYC data blocks below.
function RoutingPanel({ app, clients, routeClientId, setRouteClientId, onRoute, routing, showChanger, setShowChanger }) {
  const hasClient = !!app.client_id
  const currentClient = hasClient
    ? { id: app.client_id, name: app.client_name, mode: app.client_kyc_review_mode }
    : null
  const modeLabel = (m) => m === 'both' ? 'Admin then Client' : m === 'client' ? 'Client only' : 'Admin only'

  return (
    <div className="mb-6 rounded-xl border border-slate-200 bg-slate-50/60 overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-200 flex items-center gap-3">
        <span className="h-8 w-8 rounded-lg bg-white text-slate-700 border border-slate-200 flex items-center justify-center shrink-0">
          <Icon.ArrowRight className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-slate-900">Route to client</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Applicants register without picking a board. Assign one so the KYC review flows to the right queue.
          </p>
        </div>
        {hasClient && !showChanger && (
          <div className="flex items-center gap-2 shrink-0">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white ring-1 ring-slate-200 px-2.5 py-1 text-xs">
              <span className="font-semibold text-slate-900">{currentClient.name}</span>
              <span className="text-slate-400">·</span>
              <span className="text-slate-600">{modeLabel(currentClient.mode)}</span>
            </span>
            <Button variant="secondary" size="sm" onClick={() => setShowChanger(true)}>
              Change
            </Button>
          </div>
        )}
      </div>
      {(!hasClient || showChanger) && (
        <div className="px-5 py-4 flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[240px]">
            <Label className="!text-xs !mb-1">Route to</Label>
            <select
              value={routeClientId}
              onChange={(e) => setRouteClientId(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
              disabled={routing}
            >
              <option value="">Pick a client…</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — review mode: {modeLabel(c.kyc_review_mode || 'admin')}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-slate-500 mt-1">
              Admin-only stays here. Client-only jumps to that reviewer's inbox. Both keeps it here until you approve, then hands off.
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            {hasClient && (
              <Button variant="ghost" size="sm" onClick={() => { setShowChanger(false); setRouteClientId('') }} disabled={routing}>
                Cancel
              </Button>
            )}
            <Button size="sm" onClick={onRoute} disabled={!routeClientId || routing}>
              {routing ? 'Routing…' : hasClient ? 'Change routing' : 'Route application'}
            </Button>
          </div>
        </div>
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
  // PDF + anything else — iframe is the most reliable cross-browser
  // preview for application/pdf and gracefully degrades to download
  // prompt for other MIME types.
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

function cap(s) {
  if (!s) return ''
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function tierLabel(t) {
  if (!t) return '—'
  return t.replace('tier_', 'Tier ')
}

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
