import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import SuperShell, { PageHead } from '../../components/shell/SuperShell.jsx'
import { ArtClipboard } from '../../components/fv/FvArt.jsx'
import IndiaReachMap from '../../components/fv/IndiaReachMap.jsx'
import { CountUp } from '../../components/shell/SuperUI.jsx'
import { api } from '../../lib/api.js'
import { usePolling } from '../../lib/usePolling.js'

// Overview — what the platform is doing, on one screen.
//
// The owner of this page has two questions: is the platform healthy, and
// is anything waiting for me. So the page answers those two first — the
// pass rate and the review queue — and everything else is the list of
// institutions underneath.
//
// The old page said the same thing three times: a bar chart of volume by
// organisation, a share list of the same figures, and a table of the same
// figures again. They are now one list, where each row carries its own
// bar. Nothing here scrolls.

const nf = new Intl.NumberFormat('en-IN')
const pct = (n, d) => (d ? (n / d) * 100 : 0)

export default function SuperDashboard() {
  const [stats, setStats] = useState(null)
  const [orgs, setOrgs] = useState([])
  const [waiting, setWaiting] = useState(null)
  const [err, setErr] = useState('')

  usePolling(async () => {
    try {
      const [s, o, a] = await Promise.all([
        api('/super/stats'),
        api('/super/organizations'),
        api('/superadmin/applications?status=pending').catch(() => null),
      ])
      setStats(s)
      setOrgs(Array.isArray(o) ? o : o?.organizations || [])
      const rows = a?.applications || a?.items || a?.rows || (Array.isArray(a) ? a : null)
      setWaiting(rows ? rows.length : null)
      setErr('')
    } catch (e) {
      setErr(e.message)
    }
  }, 4000)

  const total = stats?.total ?? 0
  const verified = stats?.verified ?? 0
  const denied = stats?.denied ?? 0
  const today = stats?.today ?? 0
  const orgCount = stats?.organizations ?? orgs.length
  const ranked = [...orgs].sort((a, b) => b.total - a.total)
  const top = ranked[0]?.total || 1

  return (
    <SuperShell>
      <PageHead
        eyebrow="Overview"
        art={ArtClipboard}
        title={<>The platform <span className="fv-hi text-[20px] font-bold text-fv-faint">मंच</span></>}
        subtitle="Every institution on it, and every check they have run."
      />

      {err && (
        <p className="mb-4 rounded-[10px] border border-[#EDD9B8] bg-[#F6EDDD] px-3 py-2 text-[13.5px] font-semibold text-[#8A5A14]">
          {err}
        </p>
      )}

      <div className="flex flex-col gap-4 lg:h-[calc(100vh-208px)] lg:flex-row lg:items-stretch">
        <div className="flex min-w-0 flex-col gap-4 lg:flex-1 lg:self-start">
        {/* What the platform is doing. */}
        <section className="shrink-0">
          <Health total={total} verified={verified} denied={denied} today={today} />
        </section>

        {/* The institutions themselves — one row each, carrying its own bar. */}
        <section className="flex min-h-0 flex-col overflow-hidden rounded-[14px] border border-fv-line bg-fv-card">
          <div className="flex shrink-0 items-baseline justify-between gap-4 border-b border-fv-line px-5 py-3">
            <h2 className="fv-display text-[17px] font-bold tracking-[-0.015em] text-fv-ink">
              Who is running checks <span className="fv-hi text-[13.5px] font-bold text-fv-faint">कौन जाँच कर रहा है</span>
            </h2>
            <span className="text-[12.5px] font-bold text-fv-faint">Share of all {nf.format(total)} checks</span>
          </div>

          <ol className="min-h-0 flex-1 divide-y divide-fv-line overflow-y-auto">
            {ranked.length === 0 && (
              <li className="px-5 py-6 text-[14px] font-semibold text-fv-faint">No institutions yet.</li>
            )}
            {ranked.map((o, i) => (
              <OrgRow key={o.id} org={o} rank={i + 1} top={top} total={total} />
            ))}
          </ol>
        </section>
        </div>

        {/* What is waiting for me, and where the platform reaches. */}
        <div className="flex w-full flex-col gap-4 lg:h-full lg:w-[clamp(330px,33%,452px)]">
          <QueueTile waiting={waiting} />
          <Stat label="Institutions" hi="संस्थान" value={orgCount} note="Approved to verify candidates" />
          <ReachPanel orgs={ranked} />
        </div>
      </div>
    </SuperShell>
  )
}

// ── Where the platform has reached ───────────────────────────────────
// The board used to be a ghost behind the page at 13%, with a shape
// that only suggested India. This is the real border, projected from
// degrees, with a pin dropped on the city each institution actually
// works in.
function ReachPanel({ orgs }) {
  const places = orgs.map((o) => ({ id: o.id, name: o.name, city: o.city }))
  return (
    <section className="flex min-h-[300px] flex-1 flex-col overflow-hidden rounded-[14px] border border-fv-line bg-fv-card">
      <div className="flex shrink-0 items-baseline justify-between gap-3 px-5 pt-3">
        <h2 className="text-[13.5px] font-bold text-fv-ink">
          Where it reaches <span className="fv-hi text-[12.5px] font-bold text-fv-faint">कहाँ तक</span>
        </h2>
        <span className="text-[12.5px] font-bold tabular-nums text-fv-faint">
          {places.length} {places.length === 1 ? 'city' : 'cities'}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center px-2">
        <IndiaReachMap places={places} className="h-auto max-h-full w-full" />
      </div>

      <ul className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-fv-line px-5 py-2.5">
        {places.map((p) => (
          <li key={p.id} className="flex min-w-0 items-center gap-1.5">
            <svg viewBox="0 0 12 16" className="h-3.5 w-3 shrink-0" aria-hidden="true">
              <path d="M6 16c-3.6-5-6-7.6-6-10.6a6 6 0 0112 0C12 8.4 9.6 11 6 16z" fill="#5B3FA6" />
              <circle cx="6" cy="5.4" r="2.3" fill="#FFFFFF" />
            </svg>
            <span className="truncate text-[12.5px] font-bold text-fv-muted">{p.name}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

// ── The platform's health, as one picture ────────────────────────────
// The ring is the pass rate; the two figures under it are what the ring
// is made of; today's count sits beside it because it is the only number
// on the page that moves while you watch.
function Health({ total, verified, denied, today }) {
  const rate = pct(verified, total)
  return (
    <div className="flex items-center gap-6 rounded-[14px] border border-fv-line bg-fv-card px-6 py-5">
      <Ring pct={rate} />

      <div className="min-w-0 flex-1">
        <h2 className="fv-display text-[17px] font-bold tracking-[-0.015em] text-fv-ink">
          How many pass <span className="fv-hi text-[13.5px] font-bold text-fv-faint">कितने पास</span>
        </h2>

        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2.5">
          <Figure label="Verified" hi="सत्यापित" value={verified} tone="accent" />
          <Figure label="Not matched" hi="मेल नहीं" value={denied} tone="amber" />
          <Figure label="Checks, all time" hi="कुल जाँच" value={total} />
          <Figure label="Checks today" hi="आज" value={today} live />
        </dl>
      </div>
    </div>
  )
}

function Figure({ label, hi, value, tone, live }) {
  const ink = tone === 'accent' ? 'text-fv-accent-deep' : tone === 'amber' ? 'text-[#8A5A14]' : 'text-fv-ink'
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-fv-line pb-1.5">
      <dt className="truncate text-[13px] font-bold text-fv-faint">
        {live && <span aria-hidden="true" className="mr-1.5 inline-block h-[7px] w-[7px] rounded-full bg-fv-accent align-middle" />}
        {label} <span className="fv-hi font-bold">{hi}</span>
      </dt>
      <dd className={`shrink-0 text-[19px] font-bold tabular-nums ${ink}`}>
        <CountUp value={value} />
      </dd>
    </div>
  )
}

// The pass rate, drawn: a track, the arc, and the figure inside it.
function Ring({ pct: p, size = 132, stroke = 13 }) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const clamped = Math.min(100, Math.max(0, p))
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#EFEBF9" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#5B3FA6" strokeWidth={stroke}
                strokeLinecap="round" strokeDasharray={c}
                style={{ strokeDashoffset: c * (1 - clamped / 100), transition: 'stroke-dashoffset 1s cubic-bezier(.22,1,.36,1)' }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center leading-none">
        <span className="fv-display text-[26px] font-bold tabular-nums tracking-[-0.02em] text-fv-ink">
          {clamped.toFixed(1)}%
        </span>
        <span className="mt-1 text-[12px] font-bold text-fv-faint">pass</span>
      </div>
    </div>
  )
}

// ── The only thing on this page that asks for a decision ─────────────
function QueueTile({ waiting }) {
  const n = waiting ?? 0
  const has = n > 0
  return (
    <Link
      to="/superadmin/applications"
      className={`group flex shrink-0 items-center gap-4 rounded-[14px] border px-5 py-4 transition ${
        has ? 'border-fv-accent bg-fv-card-focus hover:bg-[#E6E0F8]' : 'border-fv-line bg-fv-card hover:bg-fv-page'
      }`}
    >
      <QueueGlyph className="h-11 w-11 shrink-0" busy={has} />
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-[13px] font-bold text-fv-faint">
          Waiting <span className="fv-hi font-bold">प्रतीक्षा</span>
        </span>
        <span className="mt-0.5 block text-[15px] font-bold leading-tight text-fv-ink">
          {waiting === null ? 'Applications queue'
            : has ? `${n} to review`
              : 'Nothing to review'}
        </span>
      </span>
      {has && (
        <span className="shrink-0 rounded-full bg-fv-accent px-2.5 py-1 text-[14px] font-bold tabular-nums text-white">
          {n}
        </span>
      )}
      <span aria-hidden="true" className="shrink-0 text-[18px] font-bold text-fv-accent transition-transform group-hover:translate-x-0.5">›</span>
    </Link>
  )
}

// A stamp waiting on a pile of papers.
function QueueGlyph({ className, busy }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <rect x="8" y="14" width="30" height="26" rx="4" fill="#EFEBF9" />
      <rect x="11" y="10" width="30" height="26" rx="4" fill="#FFFFFF" stroke="#DDD5F2" strokeWidth="1.6" />
      <path d="M17 18h18M17 23h18M17 28h11" stroke="#C9BDEF" strokeWidth="2" strokeLinecap="round" />
      {busy && (
        <g>
          <circle cx="35" cy="31" r="9" fill="#5B3FA6" />
          <path d="M31 31l3 3 6-6.5" fill="none" stroke="#FFFFFF" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      )}
    </svg>
  )
}

function Stat({ label, hi, value, note }) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-4 rounded-[14px] border border-fv-line bg-fv-card px-5 py-4">
      <span className="min-w-0 leading-tight">
        <span className="block text-[13px] font-bold text-fv-faint">
          {label} <span className="fv-hi font-bold">{hi}</span>
        </span>
        <span className="mt-0.5 block truncate text-[13px] font-semibold text-fv-muted">{note}</span>
      </span>
      <span className="fv-display shrink-0 text-[30px] font-bold tabular-nums leading-none text-fv-ink">
        <CountUp value={value} />
      </span>
    </div>
  )
}

// ── One institution ──────────────────────────────────────────────────
// The bar is the row's share of the busiest institution, so the list
// reads as a chart without being one.
function OrgRow({ org, rank, top, total }) {
  // The bar grows to its share on arrival rather than being painted at
  // full length, so the order of the list is visible as it settles.
  const [grown, setGrown] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setGrown(true), 60 + rank * 90)
    return () => clearTimeout(t)
  }, [rank])

  const share = pct(org.total, total)
  const width = Math.max(2, (org.total / top) * 100)
  const success = pct(org.verified, org.total)
  return (
    <li className="flex items-center gap-4 px-5 py-3.5">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-fv-page text-[13px] font-bold tabular-nums text-fv-faint">
        {rank}
      </span>

      <span className="w-[clamp(108px,13vw,184px)] shrink-0 leading-tight">
        <span className="block truncate text-[14.5px] font-bold text-fv-ink">{org.name}</span>
        <span className="block truncate text-[12px] font-bold tracking-wide text-fv-faint">{org.code}</span>
      </span>

      <span className="flex min-w-[150px] flex-1 items-center gap-3">
        <span className="h-[10px] min-w-[70px] flex-1 overflow-hidden rounded-full bg-fv-page">
          <span className="fv-bar-grow block h-full rounded-full bg-fv-accent"
                style={{ width: grown ? `${width}%` : '0%' }} />
        </span>
        <span className="w-[48px] shrink-0 text-right text-[13px] font-bold tabular-nums text-fv-muted">
          {share.toFixed(1)}%
        </span>
      </span>

      <span className="hidden w-[176px] shrink-0 items-baseline justify-end gap-3 lg:flex">
        <Cell label="checks" value={nf.format(org.total)} />
        <Cell label="not matched" value={nf.format(org.denied)} tone="amber" />
      </span>

      <span className="w-[58px] shrink-0 text-right text-[15px] font-bold tabular-nums text-fv-accent-deep">
        {success.toFixed(1)}%
      </span>
    </li>
  )
}

function Cell({ label, value, tone }) {
  return (
    <span className="leading-tight">
      <span className={`block text-right text-[14px] font-bold tabular-nums ${tone === 'amber' ? 'text-[#8A5A14]' : 'text-fv-ink'}`}>
        {value}
      </span>
      <span className="block text-right text-[11.5px] font-bold text-fv-faint">{label}</span>
    </span>
  )
}
