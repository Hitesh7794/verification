import { useState } from 'react'
import {
  Area, AreaChart, CartesianGrid,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'

import SuperShell, { PageHead, SectionHead } from '../../components/shell/SuperShell.jsx'
import { LoadingSkeleton, CountUp } from '../../components/shell/SuperUI.jsx'
import { Button } from '../../components/ui/ui.jsx'
import { api } from '../../lib/api.js'
import { usePolling } from '../../lib/usePolling.js'

// Overview — bento hero + trend + share + orgs table.
//
// Design intent:
//   - The featured moment is a circular progress ring for the success
//     rate — one visual anchor that reads at a glance, no card-shaped
//     wall of tiles.
//   - Three scale KPIs sit in a nested 1+2 bento grid to the right of
//     the ring, arranged so total (the biggest number) reads first.
//   - Trend chart and share list share a row underneath.
//   - Organizations table is the source-of-truth at the bottom.

const SERIES = ['#B45309', '#4D7C0F', '#9F1239', '#5B21B6', '#0F766E', '#CA8A04']
const STATUS_GOOD = '#059669'
const STATUS_BAD  = '#B91C1C'
const AXIS_MUTED  = '#A8A29E'
const GRID_LINE   = '#E7E5E4'

const nf = new Intl.NumberFormat('en-IN')

export default function SuperDashboard() {
  const [stats, setStats] = useState(null)
  const [orgs, setOrgs] = useState([])
  const [timeline, setTimeline] = useState([])
  const [err, setErr] = useState('')
  const [loaded, setLoaded] = useState(false)

  usePolling(async () => {
    try {
      const [s, o, tl] = await Promise.all([
        api('/super/stats'),
        api('/super/organizations'),
        api('/admin/timeline'),
      ])
      setStats(s)
      setOrgs(o)
      setTimeline(tl)
      setErr('')
      setLoaded(true)
    } catch (e) {
      setErr(e.message)
    }
  }, 4000)

  const total      = stats?.total ?? 0
  const verified   = stats?.verified ?? 0
  const denied     = stats?.denied ?? 0
  const successPct = total ? (verified / total) * 100 : 0
  const orgCount   = stats?.organizations ?? 0
  const userCount  = stats?.users ?? 0

  const colourFor = (id) => {
    const stable = [...orgs].map((o) => o.id).sort((a, b) => a - b)
    return SERIES[stable.indexOf(id) % SERIES.length]
  }

  const trend = timeline.map((d) => ({
    date: d.date,
    label: (d.date || '').slice(5),
    verified: d.verified,
    denied: d.denied,
  }))

  const rankedOrgs = [...orgs].sort((a, b) => b.total - a.total)

  return (
    <SuperShell>
      <PageHead
        eyebrow="Overview"
        title="Platform dashboard"
        right={
          <Link to="/superadmin/applications">
            <Button variant="secondary">Applications queue →</Button>
          </Link>
        }
      />

      {err && (
        <div className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
          {err}
        </div>
      )}

      {/* Bento hero — ring + nested KPI grid on the right. */}
      <section className="grid gap-4 lg:grid-cols-3 mb-8">
        <RingHero
          pct={successPct}
          verified={verified}
          denied={denied}
          loaded={loaded}
        />
        <div className="lg:col-span-1 grid gap-4 lg:grid-rows-3">
          <BigStat
            label="Total verifications"
            value={total}
            loaded={loaded}
            delay={0.05}
          />
          <BigStat
            label="Organizations"
            value={orgCount}
            loaded={loaded}
            delay={0.10}
            onClick={() => {
              document.getElementById('orgs-section')
                ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }}
            hint="View list ↓"
          />
          <BigStat
            label="Operators & staff"
            value={userCount}
            loaded={loaded}
            delay={0.15}
          />
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-3 mb-8">
        <TrendCard trend={trend} />
        <ShareCard orgs={rankedOrgs} total={total} loaded={loaded} colourFor={colourFor} />
      </div>

      <div id="orgs-section" style={{ scrollMarginTop: '5rem' }}>
        <SectionHead title="Organizations" count={orgs.length} />
        <OrgsTable orgs={rankedOrgs} loaded={loaded} colourFor={colourFor} />
      </div>
    </SuperShell>
  )
}

// ── RingHero ─────────────────────────────────────────────────────────
// Circular progress ring for the success rate. 2 cols wide. The ring
// gives the metric visual weight without needing colour blocks or
// heavy chrome — the geometry does the work.
function RingHero({ pct, verified, denied, loaded }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="lg:col-span-2 rounded-2xl border border-warm bg-warm-surface p-6 shadow-sm"
    >
      <p className="text-[11px] font-semibold uppercase tracking-widest text-warm-accent mb-4">
        Verification success rate
      </p>
      <div className="flex items-center gap-6">
        <div className="relative shrink-0">
          <Ring pct={pct} size={148} stroke={12} />
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-3xl font-semibold text-ink-900 tracking-tight tabular-nums leading-none">
              {loaded ? <CountUp value={pct} format="pct" /> : '—'}
            </span>
            <span className="text-[10px] uppercase tracking-widest text-stone-500 mt-1">success</span>
          </div>
        </div>
        <ul className="flex-1 space-y-3">
          <li className="flex items-baseline justify-between border-b border-warm pb-2">
            <span className="inline-flex items-center gap-2 text-[11px] uppercase tracking-widest text-stone-500">
              <span className="h-2 w-2 rounded-full bg-emerald-600" />
              Verified
            </span>
            <span className="tabular-nums text-lg font-semibold text-emerald-800">
              {nf.format(verified)}
            </span>
          </li>
          <li className="flex items-baseline justify-between border-b border-warm pb-2">
            <span className="inline-flex items-center gap-2 text-[11px] uppercase tracking-widest text-stone-500">
              <span className="h-2 w-2 rounded-full bg-rose-600" />
              Denied
            </span>
            <span className="tabular-nums text-lg font-semibold text-rose-800">
              {nf.format(denied)}
            </span>
          </li>
          <li className="flex items-baseline justify-between">
            <span className="text-[11px] uppercase tracking-widest text-stone-500">Processed</span>
            <span className="tabular-nums text-lg font-semibold text-ink-900">
              {nf.format(verified + denied)}
            </span>
          </li>
        </ul>
      </div>
    </motion.div>
  )
}

// SVG circular progress. Emerald arc on a warm track. Animated draw.
function Ring({ pct, size = 148, stroke = 12 }) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const clamped = Math.min(100, Math.max(0, pct))
  const offset = c * (1 - clamped / 100)
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
      <circle
        cx={size / 2} cy={size / 2} r={r}
        fill="none" stroke="#EDE4D3" strokeWidth={stroke}
      />
      <motion.circle
        cx={size / 2} cy={size / 2} r={r}
        fill="none" stroke="#059669" strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        initial={{ strokeDashoffset: c }}
        animate={{ strokeDashoffset: offset }}
        transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }}
      />
    </svg>
  )
}

// ── BigStat ──────────────────────────────────────────────────────────
// Clean stat tile. Optional onClick makes the whole card interactive
// with a subtle "view list" hint on hover.
function BigStat({ label, value, loaded, delay = 0, onClick, hint }) {
  const clickable = !!onClick
  return (
    <motion.button
      type={clickable ? 'button' : undefined}
      onClick={onClick}
      disabled={!clickable}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay, ease: [0.22, 1, 0.36, 1] }}
      whileHover={{ y: -2 }}
      className={`group text-left w-full flex items-center justify-between gap-4 rounded-2xl border border-warm bg-warm-surface px-6 py-5 shadow-sm hover:shadow-md transition-shadow ${clickable ? 'cursor-pointer focus:outline-none focus:ring-2 focus:ring-stone-400 hover:border-warm-strong' : 'cursor-default'}`}
    >
      <div className="flex-1 min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-stone-500">
          {label}
        </p>
        {clickable && hint && (
          <p className="mt-1 text-[11px] font-medium text-warm-accent opacity-0 group-hover:opacity-100 transition-opacity">
            {hint}
          </p>
        )}
      </div>
      <p className="text-4xl font-semibold text-ink-900 tracking-tight tabular-nums leading-none shrink-0">
        {loaded ? <CountUp value={value} /> : <span className="text-stone-300">—</span>}
      </p>
    </motion.button>
  )
}

// ── TrendCard ────────────────────────────────────────────────────────
function TrendCard({ trend }) {
  return (
    <div className="lg:col-span-2 rounded-2xl border border-warm bg-warm-surface shadow-sm overflow-hidden">
      <div className="flex items-baseline justify-between px-5 pt-4 pb-2">
        <div>
          <h3 className="text-[13px] font-semibold text-ink-900 tracking-tight">Daily volume</h3>
          <p className="text-[11px] text-stone-500 mt-0.5">Last {trend.length || 14} days · stacked by outcome</p>
        </div>
        <div className="flex items-center gap-4 text-[11px]">
          <span className="inline-flex items-center gap-1.5 text-stone-600">
            <span className="h-2 w-2 rounded-full" style={{ background: STATUS_GOOD }} />
            Verified
          </span>
          <span className="inline-flex items-center gap-1.5 text-stone-600">
            <span className="h-2 w-2 rounded-full" style={{ background: STATUS_BAD }} />
            Denied
          </span>
        </div>
      </div>
      <div className="p-5 pt-1">
        {trend.length === 0 ? (
          <ChartEmpty />
        ) : (
          <div className="h-56">
            <ResponsiveContainer>
              <AreaChart data={trend} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <defs>
                  <linearGradient id="gVerified" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={STATUS_GOOD} stopOpacity={0.30} />
                    <stop offset="100%" stopColor={STATUS_GOOD} stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="gDenied" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={STATUS_BAD} stopOpacity={0.28} />
                    <stop offset="100%" stopColor={STATUS_BAD} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={GRID_LINE} vertical={false} />
                <XAxis dataKey="label" stroke={GRID_LINE}
                  tick={{ fill: AXIS_MUTED, fontSize: 11 }}
                  tickLine={false} interval="preserveStartEnd" minTickGap={16} />
                <YAxis stroke={GRID_LINE}
                  tick={{ fill: AXIS_MUTED, fontSize: 11 }}
                  tickLine={false} axisLine={false} width={48} />
                <Tooltip content={<TrendTooltip />} cursor={{ stroke: GRID_LINE }} />
                <Area type="monotone" dataKey="verified" stackId="1"
                  stroke={STATUS_GOOD} strokeWidth={2}
                  fill="url(#gVerified)" />
                <Area type="monotone" dataKey="denied" stackId="1"
                  stroke={STATUS_BAD} strokeWidth={2}
                  fill="url(#gDenied)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  )
}

// ── ShareCard ────────────────────────────────────────────────────────
function ShareCard({ orgs, total, loaded, colourFor }) {
  const active = orgs.filter((o) => o.total > 0)
  return (
    <div className="rounded-2xl border border-warm bg-warm-surface shadow-sm overflow-hidden">
      <div className="px-5 pt-4 pb-3 border-b border-warm">
        <h3 className="text-[13px] font-semibold text-ink-900 tracking-tight">Volume share</h3>
        <p className="text-[11px] text-stone-500 mt-0.5">By organization</p>
      </div>
      {!loaded ? (
        <div className="p-5"><LoadingSkeleton rows={4} height="h-6" /></div>
      ) : active.length === 0 ? (
        <div className="p-5"><ChartEmpty /></div>
      ) : (
        <ul className="divide-y divide-warm">
          {active.map((o) => {
            const pct = total ? (o.total / total) * 100 : 0
            return (
              <li key={o.id} className="px-5 py-3 hover:bg-[#FBF7F0] transition-colors">
                <div className="flex items-center gap-3 text-xs">
                  <span className="h-2.5 w-2.5 rounded-sm shrink-0"
                    style={{ background: colourFor(o.id) }} />
                  <span className="font-medium text-stone-800 truncate flex-1">{o.name}</span>
                  <span className="tabular-nums text-stone-500 w-12 text-right">{pct.toFixed(1)}%</span>
                </div>
                <div className="mt-1.5 h-[3px] rounded-full bg-[#F5EEDF] overflow-hidden">
                  <div className="h-full rounded-full transition-all duration-700 ease-out"
                    style={{ width: `${pct}%`, background: colourFor(o.id) }} />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// ── OrgsTable ────────────────────────────────────────────────────────
function OrgsTable({ orgs, loaded, colourFor }) {
  if (!loaded) {
    return (
      <div className="rounded-2xl border border-warm bg-warm-surface shadow-sm p-6">
        <LoadingSkeleton rows={5} height="h-5" />
      </div>
    )
  }
  if (orgs.length === 0) {
    return (
      <div className="rounded-2xl border border-warm bg-warm-surface shadow-sm text-center py-10 text-sm text-stone-500 italic">
        No organizations yet — an approved institution registration will appear here.
      </div>
    )
  }
  return (
    <div className="rounded-2xl border border-warm bg-warm-surface shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-warm bg-[#FBF7F0]">
              <th className="text-left px-5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-stone-500">Code</th>
              <th className="text-left px-3 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-stone-500">Organization</th>
              <th className="text-right px-3 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-stone-500">Verifications</th>
              <th className="text-right px-3 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-stone-500">Verified</th>
              <th className="text-right px-3 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-stone-500">Denied</th>
              <th className="text-right px-5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-stone-500">Success</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-warm">
            {orgs.map((o) => {
              const pct = o.total ? (o.verified / o.total) * 100 : 0
              const pctTone = pct >= 95 ? 'text-emerald-700'
                           : pct >= 85 ? 'text-amber-700'
                           :             'text-rose-700'
              return (
                <tr key={o.id} className="hover:bg-[#FBF7F0] transition-colors">
                  <td className="px-5 py-3">
                    <span className="inline-flex items-center gap-2">
                      <span className="h-2.5 w-2.5 rounded-sm shrink-0"
                        style={{ background: colourFor(o.id) }} />
                      <span className="text-[11px] font-semibold text-stone-700 uppercase tracking-wider">{o.code}</span>
                    </span>
                  </td>
                  <td className="px-3 py-3 font-medium text-ink-900">{o.name}</td>
                  <td className="px-3 py-3 text-right text-stone-700 tabular-nums">{nf.format(o.total)}</td>
                  <td className="px-3 py-3 text-right text-emerald-700 tabular-nums font-medium">{nf.format(o.verified)}</td>
                  <td className="px-3 py-3 text-right text-rose-700 tabular-nums font-medium">{nf.format(o.denied)}</td>
                  <td className="px-5 py-3 text-right tabular-nums font-semibold">
                    <span className={pctTone}>{pct.toFixed(1)}%</span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function TrendTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  const verified = payload.find((p) => p.dataKey === 'verified')?.value ?? 0
  const denied   = payload.find((p) => p.dataKey === 'denied')?.value ?? 0
  const total = verified + denied
  return (
    <div className="rounded-lg bg-stone-900 text-white shadow-lg px-3 py-2 text-xs border border-stone-700">
      <p className="font-medium mb-1 text-stone-200">{label}</p>
      <p className="tabular-nums"><span className="text-emerald-300">■</span> {nf.format(verified)} verified</p>
      <p className="tabular-nums"><span className="text-rose-300">■</span> {nf.format(denied)} denied</p>
      <p className="tabular-nums text-stone-400 border-t border-stone-700 pt-1 mt-1">{nf.format(total)} total</p>
    </div>
  )
}

function ChartEmpty() {
  return (
    <div className="h-48 flex items-center justify-center text-sm text-stone-400 italic">
      No data yet
    </div>
  )
}
