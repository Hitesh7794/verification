import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import SuperShell, { PageHead } from '../../components/shell/SuperShell.jsx'
import { HindiName } from '../../components/fv/hindi.jsx'
import { ArtStamp } from '../../components/fv/FvArt.jsx'
import InstitutionCrest from '../../components/fv/InstitutionCrest.jsx'
import { Icon } from '../../components/ui/extras.jsx'
import { api } from '../../lib/api.js'
import { usePolling } from '../../lib/usePolling.js'

// Applications — the queue an institution sits in until someone decides.
//
// The page used to carry the same four filters twice: a row of stat
// tiles that set the filter, and a row of tabs underneath that set the
// same filter, with the same counts on both. One control now, and the
// space it gave back goes to the rows.
//
// Status is a stamp rather than a badge: dry and dashed while an
// application waits, inked and slightly off-square once someone has
// decided. Violet means it is in, amber means it went back.

const TABS = [
  { value: 'pending', label: 'Waiting', hi: 'प्रतीक्षा' },
  { value: 'approved', label: 'In', hi: 'शामिल' },
  { value: 'rejected', label: 'Sent back', hi: 'वापस' },
  { value: '', label: 'All', hi: 'सभी' },
]
const PAGE_SIZE = 25

export default function PendingApplications() {
  const nav = useNavigate()
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [counts, setCounts] = useState({ pending: 0, approved: 0, rejected: 0 })
  const [offset, setOffset] = useState(0)
  const [status, setStatus] = useState('pending')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)
  const [revokingId, setRevokingId] = useState(null)
  const [selId, setSelId] = useState(null)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(t)
  }, [search])

  // Clear the previous tab's rows so the user never sees approved rows
  // sitting briefly under a "waiting" header.
  useEffect(() => {
    setOffset(0)
    setItems([])
    setLoading(true)
  }, [status, debouncedSearch])

  const loadList = useCallback(async () => {
    try {
      const qs = new URLSearchParams()
      if (status) qs.set('status', status)
      if (debouncedSearch) qs.set('q', debouncedSearch)
      qs.set('limit', String(PAGE_SIZE))
      qs.set('offset', String(offset))
      const res = await api(`/superadmin/applications?${qs}`)
      setItems(res.items || [])
      setTotal(res.total || 0)
      setErr('')
    } catch (e) {
      setErr(e.message)
    } finally {
      setLoading(false)
    }
  }, [status, debouncedSearch, offset])

  // The counts are deliberately not keyed on the open tab: each query
  // pins its own status and asks for one row, so switching tabs cannot
  // move any of them.
  const loadCounts = useCallback(async () => {
    const countQs = new URLSearchParams()
    if (debouncedSearch) countQs.set('q', debouncedSearch)
    countQs.set('limit', '1')
    const [p, a, r] = await Promise.all(
      ['pending', 'approved', 'rejected'].map((st) =>
        api(`/superadmin/applications?${countQs}&status=${st}`).catch(() => ({ total: 0 })),
      ),
    )
    setCounts({ pending: p.total || 0, approved: a.total || 0, rejected: r.total || 0 })
  }, [debouncedSearch])

  const loadAll = useCallback(() => Promise.all([loadList(), loadCounts()]), [loadList, loadCounts])

  async function handleRevoke(e, id) {
    e.stopPropagation()
    e.preventDefault()
    if (!confirm('Send this application back to the waiting queue?')) return
    setRevokingId(id)
    try {
      await api(`/superadmin/applications/${id}/revoke`, { method: 'POST' })
      await loadAll()
    } catch (er) {
      setErr(er.message || 'Could not move that application')
    } finally {
      setRevokingId(null)
    }
  }

  usePolling(loadList, 8000)

  // usePolling ignores the identity of the function it is given, so a
  // filter change has to ask for the new rows itself. The mount run is
  // skipped because usePolling already fires once.
  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return }
    loadList()
  }, [loadList])
  useEffect(() => { loadCounts() }, [loadCounts])

  const countFor = (v) => (v === 'pending' ? counts.pending
    : v === 'approved' ? counts.approved
      : v === 'rejected' ? counts.rejected
        : counts.pending + counts.approved + counts.rejected)

  const selected = items.find((x) => x.id === selId) || items[0] || null

  const showingFrom = items.length > 0 ? offset + 1 : 0
  const showingTo = Math.min(offset + PAGE_SIZE, total)

  return (
    <SuperShell>
      <PageHead
        eyebrow="Applications"
        art={ArtStamp}
        title={<>Institution registrations <span className="fv-hi text-[20px] font-bold text-fv-faint">संस्थान पंजीकरण</span></>}
        subtitle="Every institution asking to come onto the platform, and where each one stands."
        right={
          <button
            type="button"
            onClick={() => { setLoading(true); loadAll() }}
            className="inline-flex cursor-pointer items-center gap-2 rounded-[10px] border border-fv-line bg-white px-3.5 py-2 text-[14px] font-bold text-fv-ink transition hover:bg-fv-page"
          >
            <Icon.Refresh className="h-4 w-4" />
            Refresh
          </button>
        }
      />

      {err && (
        <p className="mb-3 rounded-[10px] border border-[#EDD9B8] bg-[#F6EDDD] px-3 py-2 text-[13.5px] font-semibold text-[#8A5A14]">
          {err}
        </p>
      )}

      <div className="flex flex-col gap-4 lg:h-[calc(100vh-208px)] lg:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
        {/* One filter, and one way to search it. */}
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 rounded-[12px] border border-fv-line bg-white p-1">
            {TABS.map((t) => {
              const active = status === t.value
              return (
                <button
                  key={t.value || 'all'}
                  type="button"
                  onClick={() => setStatus(t.value)}
                  aria-pressed={active}
                  className={`inline-flex cursor-pointer items-baseline gap-2 rounded-[9px] px-3.5 py-1.5 text-[14px] font-bold transition ${
                    active ? 'bg-fv-accent text-white' : 'text-fv-muted hover:bg-fv-page'
                  }`}
                >
                  {t.label}
                  <span className={`fv-hi text-[12px] font-bold ${active ? 'text-white/70' : 'text-fv-faint'}`}>{t.hi}</span>
                  <span className={`rounded-full px-1.5 text-[12.5px] font-bold tabular-nums ${
                    active ? 'bg-white/20 text-white' : 'bg-fv-page text-fv-muted'
                  }`}>
                    {countFor(t.value)}
                  </span>
                </button>
              )
            })}
          </div>

          <div className="relative min-w-[220px] flex-1">
            <Icon.Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fv-faint" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search a name, AISHE code, PAN or email"
              className="h-[42px] w-full rounded-[12px] border border-fv-line bg-white pl-10 pr-3 text-[14.5px] font-semibold text-fv-ink placeholder:font-semibold placeholder:text-fv-faint focus:border-fv-accent focus:outline-none"
            />
          </div>
        </div>

        {/* The queue itself. */}
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[14px] border border-fv-line bg-fv-card">
          <div className="hidden shrink-0 items-center gap-4 border-b border-fv-line px-5 py-2.5 text-[12.5px] font-bold text-fv-faint lg:flex">
            <span className="min-w-0 flex-1">Institution <span className="fv-hi font-bold">संस्थान</span></span>
            <span className="w-[118px]">Where <span className="fv-hi font-bold">कहाँ</span></span>
            <span className="w-[62px] text-center">Papers</span>
            <span className="w-[86px]">Came in</span>
            <span className="w-[104px] text-right">Stands at</span>
          </div>

          <ul className="min-h-0 flex-1 divide-y divide-fv-line overflow-y-auto">
            {loading && items.length === 0 && (
              <li className="px-5 py-16 text-center">
                <span className="inline-block h-7 w-7 animate-spin rounded-full border-2 border-fv-line border-t-fv-accent" />
                <p className="mt-3 text-[14px] font-bold text-fv-faint">Fetching the queue…</p>
              </li>
            )}

            {!loading && items.length === 0 && (
              <li><EmptyQueue status={status} hasSearch={!!debouncedSearch} /></li>
            )}

            {items.map((it, i) => (
              <Row
                key={it.id}
                it={it}
                i={i}
                selected={selected?.id === it.id}
                onSelect={() => setSelId(it.id)}
                onOpen={() => nav(`/superadmin/applications/${it.id}`)}
              />
            ))}
          </ul>
        </section>

        </div>

        {/* The one the reviewer is looking at. */}
        <aside className="w-full shrink-0 lg:w-[clamp(310px,30%,400px)]">
          <Preview
            key={selected?.id || 'none'}
            it={selected}
            busy={revokingId === selected?.id}
            onOpen={() => selected && nav(`/superadmin/applications/${selected.id}`)}
            onRevoke={(e) => selected && handleRevoke(e, selected.id)}
          />
        </aside>
      </div>

      <div className="mt-3">
        {total > PAGE_SIZE && (
          <div className="flex shrink-0 items-center justify-between gap-4 text-[13.5px] font-bold text-fv-muted">
            <span className="tabular-nums">Showing {showingFrom} – {showingTo} of {total}</span>
            <div className="flex gap-2">
              <PageBtn disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                <Icon.ChevronLeft className="h-4 w-4" /> Previous
              </PageBtn>
              <PageBtn disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>
                Next <Icon.ChevronRight className="h-4 w-4" />
              </PageBtn>
            </div>
          </div>
        )}
      </div>
    </SuperShell>
  )
}

// ── One application ──────────────────────────────────────────────────
function Row({ it, i = 0, selected, onSelect, onOpen }) {
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onDoubleClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); onOpen() }
          if (e.key === ' ') { e.preventDefault(); onSelect() }
        }}
        className={`group relative flex cursor-pointer items-center gap-4 px-5 py-3.5 transition ${
          selected ? 'bg-fv-card-focus' : 'hover:bg-fv-page'
        } focus:outline-none focus-visible:bg-fv-page`}
      >
        {selected && <span aria-hidden="true" className="fv-edge-in absolute inset-y-0 left-0 w-[4px] bg-fv-accent" />}

        <InstitutionCrest name={it.institution_name} type={it.institution_type}
                          className="fv-press-in h-[52px] w-[46px] shrink-0 drop-shadow-[0_1px_2px_rgba(43,31,82,.12)] transition-transform duration-200 group-hover:-translate-y-[2px]"
                          style={{ '--i': i }} />

        <span className="min-w-0 flex-1 leading-tight">
          <span className="fv-display block truncate text-[17px] font-bold tracking-[-0.015em] text-fv-ink">
            {it.institution_name}
          </span>
          <HindiName name={it.institution_name} given={it.institution_name_hi}
                     className="fv-hi block truncate text-[13px] font-bold text-fv-faint" />
          <span className="mt-1 inline-flex items-center gap-1.5">
            <span className="rounded-[6px] bg-fv-page px-1.5 py-0.5 text-[11.5px] font-bold tabular-nums tracking-wide text-fv-muted">
              {it.aishe_code || 'No AISHE code'}
            </span>
            <span className="text-[11.5px] font-bold capitalize text-fv-faint">{it.institution_type}</span>
          </span>
        </span>

        <span className="hidden w-[118px] shrink-0 items-start gap-1.5 sm:flex">
          <PinMark className="mt-[2px] h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 leading-tight">
            <span className="block truncate text-[14px] font-bold text-fv-ink">{it.city || '—'}</span>
            <span className="block truncate text-[12.5px] font-bold text-fv-faint">{it.state || ''}</span>
          </span>
        </span>

        <span className="hidden w-[62px] shrink-0 justify-center sm:flex">
          <PaperStack n={it.doc_count ?? (it.docs?.length || 0)} />
        </span>

        <span className="hidden w-[86px] shrink-0 text-[12.5px] font-bold text-fv-faint sm:block"
              title={it.created_at ? new Date(it.created_at).toLocaleString() : ''}>
          {formatRelative(it.created_at)}
        </span>

        <span className="flex w-[104px] shrink-0 justify-end">
          <Status status={it.status} />
        </span>
      </div>
    </li>
  )
}

// ── The application the reviewer is looking at ───────────────────────
// The queue used to fill a third of the screen and leave the rest
// blank. The blank third is now the application itself: who it is, who
// signed it, and the way through to the decision.
function Preview({ it, busy, onOpen, onRevoke }) {
  if (!it) {
    return (
      <div className="flex h-full flex-col items-center justify-center rounded-[16px] border border-dashed border-fv-line bg-fv-card px-6 py-10 text-center">
        <ArtStamp className="h-16 w-16 opacity-50" />
        <p className="mt-3 text-[15px] font-bold text-fv-ink">
          Nothing selected <span className="fv-hi text-[13px] font-bold text-fv-faint">कुछ नहीं चुना</span>
        </p>
        <p className="mt-1 text-[13px] font-semibold text-fv-muted">Pick an institution from the queue.</p>
      </div>
    )
  }

  return (
    <div className="animate-surface-in flex h-full flex-col overflow-hidden rounded-[16px] border border-fv-line bg-fv-card">
      <div className="flex items-start gap-3.5 border-b border-fv-line bg-fv-page px-5 py-4">
        <InstitutionCrest name={it.institution_name} type={it.institution_type}
                          className="fv-press-in h-[72px] w-[64px] shrink-0 drop-shadow-[0_2px_4px_rgba(43,31,82,.16)]" />
        <span className="min-w-0 flex-1 leading-tight">
          <span className="fv-display block text-[18px] font-bold leading-[1.15] tracking-[-0.02em] text-fv-ink">
            {it.institution_name}
          </span>
          <HindiName name={it.institution_name} given={it.institution_name_hi}
                     className="fv-hi mt-0.5 block text-[13px] font-bold text-fv-faint" />
          <span className="mt-2 block"><Status status={it.status} big /></span>
        </span>
      </div>

      <dl className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
        <Fact label="Where" hi="कहाँ" value={[it.city, it.district && it.district !== it.city ? it.district : null, it.state].filter(Boolean).join(', ')} />
        <Fact label="Who signed" hi="किसने भेजा" value={it.head_name}
              sub={[it.head_designation, it.head_email, it.head_mobile].filter(Boolean)} />
        <Fact label="AISHE code" hi="कोड" value={it.aishe_code} mono />
        <Fact label="PAN" value={it.pan} mono />
        <Fact label="Came in" hi="कब आया" value={formatRelative(it.created_at)}
              sub={it.created_at ? [new Date(it.created_at).toLocaleString('en-IN')] : []} />
        <Fact label="Routed to" hi="भेजा गया" value={it.client_name} />

        <div className="mt-3 flex items-center gap-3 rounded-[12px] border border-fv-line bg-fv-page px-3.5 py-3">
          <PaperStack n={it.doc_count ?? (it.docs?.length || 0)} big />
          <span className="leading-tight">
            <span className="block text-[14px] font-bold text-fv-ink">
              {(it.doc_count ?? (it.docs?.length || 0)) || 'No'} paper{(it.doc_count ?? (it.docs?.length || 0)) === 1 ? '' : 's'} attached
            </span>
            <span className="block text-[12.5px] font-semibold text-fv-muted">Open the review to read them</span>
          </span>
        </div>

        {it.status === 'rejected' && it.review_note && (
          <p className="mt-3 rounded-[12px] border border-[#EDD9B8] bg-[#F6EDDD] px-3.5 py-3 text-[13px] font-semibold leading-snug text-[#8A5A14]">
            <span className="block text-[12.5px] font-bold">Sent back because</span>
            {it.review_note}
          </p>
        )}
      </dl>

      <div className="flex shrink-0 items-center gap-2 border-t border-fv-line px-5 py-3">
        <button
          type="button"
          onClick={onOpen}
          className="inline-flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-[11px] bg-fv-accent px-4 py-2.5 text-[14.5px] font-bold text-white transition hover:bg-fv-accent-deep"
        >
          {it.status === 'pending' ? 'Review this one' : 'Open the record'}
          <span aria-hidden="true">→</span>
        </button>
        {it.status === 'rejected' && (
          <button
            type="button"
            onClick={onRevoke}
            disabled={busy}
            className="cursor-pointer rounded-[11px] border border-[#EDD9B8] bg-[#F6EDDD] px-3 py-2.5 text-[13.5px] font-bold text-[#8A5A14] transition hover:bg-[#F0E4CE] disabled:opacity-50"
          >
            {busy ? '…' : 'Reopen'}
          </button>
        )}
      </div>
    </div>
  )
}

function Fact({ label, hi, value, sub = [], mono }) {
  if (!value) return null
  return (
    <div className="border-b border-fv-line py-2 last:border-none">
      <dt className="text-[12px] font-bold text-fv-faint">
        {label} {hi && <span className="fv-hi font-bold">{hi}</span>}
      </dt>
      <dd className={`mt-0.5 text-[14.5px] font-bold leading-tight text-fv-ink ${mono ? 'tabular-nums tracking-wide' : ''}`}>
        {value}
      </dd>
      {sub.filter(Boolean).map((line, i) => (
        <dd key={i} className="mt-0.5 truncate text-[12.5px] font-semibold text-fv-muted">{line}</dd>
      ))}
    </div>
  )
}

// A little stack of papers, drawn, with the count on the top sheet.
function PaperStack({ n = 0, big }) {
  const size = big ? 'h-11 w-11' : 'h-8 w-8'
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg viewBox="0 0 32 32" className={`${size} shrink-0`} aria-hidden="true">
        {n > 1 && <rect x="7" y="5" width="18" height="22" rx="2.6" fill="#EFEBF9" transform="rotate(-7 16 16)" />}
        {n > 2 && <rect x="7" y="5" width="18" height="22" rx="2.6" fill="#E3DCF7" transform="rotate(5 16 16)" />}
        <rect x="7" y="5" width="18" height="22" rx="2.6" fill="#FFFFFF" stroke={n ? '#9A86D6' : '#DDD5F2'} strokeWidth="1.4" />
        <path d="M11 11h10M11 15h10M11 19h6" stroke={n ? '#9A86D6' : '#E3E1EA'} strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      {!big && <span className={`text-[13px] font-bold tabular-nums ${n ? 'text-fv-ink' : 'text-fv-faint'}`}>{n}</span>}
    </span>
  )
}

// Where it is, drawn rather than a stock pin.
function PinMark({ className }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M12 2.5c4 0 7 3 7 6.9 0 5.1-7 12.1-7 12.1S5 14.5 5 9.4c0-3.9 3-6.9 7-6.9z" fill="#9A86D6" />
      <circle cx="12" cy="9.2" r="2.7" fill="#FFFFFF" />
    </svg>
  )
}

// ── The status, as a stamp ───────────────────────────────────────────
// Waiting is a stamp that has not been pressed: a dry outline, dashed,
// with the sand still running. A decision is a stamp that has — inked,
// sitting slightly off square the way a hand leaves it.
function Status({ status, big }) {
  const pressed = status === 'approved' || status === 'rejected'
  const back = status === 'approved'
  const pad = big ? 'px-3 py-1.5 text-[14px]' : 'px-2.5 py-1 text-[12.5px]'

  const skin = status === 'approved'
    ? 'border-fv-accent bg-fv-card-focus text-fv-accent-deep'
    : status === 'rejected'
      ? 'border-[#D9A860] bg-[#F6EDDD] text-[#8A5A14]'
      : 'border-dashed border-[#C9BDEF] bg-transparent text-fv-muted'

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-[7px] border-[1.5px] font-bold tracking-[0.01em] ${pad} ${skin}`}
      style={pressed ? { transform: 'rotate(-3deg)' } : undefined}
    >
      {status === 'approved' ? <TickMark /> : status === 'rejected' ? <BackMark /> : <SandMark />}
      {back ? 'In' : status === 'rejected' ? 'Sent back' : 'Waiting'}
    </span>
  )
}

// The tick a stamp leaves.
function TickMark() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor"
         strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8.6l3.2 3.2L13 4.4" />
    </svg>
  )
}

// Sent back where it came from.
function BackMark() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 9.5A4.5 4.5 0 008.5 5H3.5" />
      <path d="M6 2.2L3 5l3 2.8" />
    </svg>
  )
}

// Still running.
function SandMark() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="M4 2.2h8M4 13.8h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M5 2.6c0 3 3 3.9 3 5.4s-3 2.4-3 5.4M11 2.6c0 3-3 3.9-3 5.4s3 2.4 3 5.4"
            fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path className="fv-pile" d="M6.6 11.6c.5-1 2.3-1 2.8 0 .4.8-.5 1.2-1.4 1.2s-1.8-.4-1.4-1.2z" fill="#E4A54B" />
      <circle className="fv-grain" cx="8" cy="6.6" r=".9" fill="#E4A54B" />
    </svg>
  )
}

function PageBtn({ children, ...rest }) {
  return (
    <button
      type="button"
      {...rest}
      className="inline-flex cursor-pointer items-center gap-1.5 rounded-[10px] border border-fv-line bg-white px-3 py-1.5 text-[13.5px] font-bold text-fv-ink transition hover:bg-fv-page disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  )
}

function EmptyQueue({ status, hasSearch }) {
  const [line, hi] = hasSearch ? ['Nothing matches that search', 'कुछ नहीं मिला']
    : status === 'pending' ? ['Nothing is waiting', 'कुछ भी लंबित नहीं']
      : status === 'approved' ? ['No institutions are in yet', 'अभी कोई शामिल नहीं']
        : status === 'rejected' ? ['Nothing has been sent back', 'कुछ वापस नहीं भेजा']
          : ['No applications yet', 'अभी कोई आवेदन नहीं']
  return (
    <div className="px-5 py-16 text-center">
      <ArtStamp className="mx-auto h-14 w-14 opacity-60" />
      <p className="mt-3 text-[16px] font-bold text-fv-ink">
        {line} <span className="fv-hi text-[13.5px] font-bold text-fv-faint">{hi}</span>
      </p>
      <p className="mx-auto mt-1 max-w-md text-[13.5px] font-semibold text-fv-muted">
        {hasSearch
          ? 'Try the AISHE code, the PAN, or part of the name.'
          : status === 'pending'
            ? 'Registrations from the public form land here within seconds.'
            : 'Switch tabs above to see the other states.'}
      </p>
    </div>
  )
}

function formatRelative(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const mins = (Date.now() - d.getTime()) / 60000
  if (mins < 1) return 'just now'
  if (mins < 60) return `${Math.round(mins)} min ago`
  if (mins < 60 * 24) return `${Math.round(mins / 60)} hr ago`
  if (mins < 60 * 24 * 7) return `${Math.round(mins / (60 * 24))} days ago`
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}
