import { useState } from 'react'
import {
  Bar, BarChart, CartesianGrid, Cell,
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

// Categorical chart palette. Six hues at a matched lightness and chroma
// so no single series shouts louder than the rest, and each stays
// distinguishable in greyscale for a printed board report.
const SERIES = ['#1A57A3', '#A96D15', '#127A53', '#9B2437', '#5B4B8A', '#0E6E7D']
const AXIS_MUTED = '#93A2B5'
const GRID_LINE  = '#DDE4EC'

const nf = new Intl.NumberFormat('en-IN')

export default function SuperDashboard() {
  const [stats, setStats] = useState(null)
  const [orgs, setOrgs] = useState([])
  const [err, setErr] = useState('')
  const [loaded, setLoaded] = useState(false)

  usePolling(async () => {
    try {
      const [s, o] = await Promise.all([
        api('/super/stats'),
        api('/super/organizations'),
      ])
      setStats(s)
      setOrgs(o)
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
            label="Verification agents & staff"
            value={userCount}
            loaded={loaded}
            delay={0.15}
          />
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-3 mb-8">
        <OrgBarsCard orgs={orgs} loaded={loaded} colourFor={colourFor} />
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
      <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-600 mb-4">
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
        fill="none" stroke="#DDE4EC" strokeWidth={stroke}
      />
      <motion.circle
        cx={size / 2} cy={size / 2} r={r}
        fill="none" stroke="#127A53" strokeWidth={stroke}
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
          <p className="mt-1 text-[11px] font-medium text-brand-700 opacity-0 group-hover:opacity-100 transition-opacity">
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

// ── OrgBarsCard ──────────────────────────────────────────────────────
// Horizontal bar chart of top-N organizations by verification volume.
// Replaces the "Daily volume" area chart (2026-08-24) — with few
// orgs and low throughput, per-org rank is the story that reads at
// a glance, not day-over-day trend.
function OrgBarsCard({ orgs, loaded, colourFor }) {
  const top = [...(orgs || [])]
    .filter((o) => o.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 6)
    .map((o) => {
      const label = (o.name || o.code || '—').trim()
      return {
        name: label.length > 22 ? label.slice(0, 21) + '…' : label,
        fullName: o.name || o.code || '—',
        code: o.code,
        total: o.total,
        verified: o.verified,
        denied: o.denied,
        color: colourFor(o.id),
      }
    })

  return (
    <div className="lg:col-span-2 rounded-2xl border border-warm bg-warm-surface shadow-sm overflow-hidden">
      <div className="px-5 pt-4 pb-3 border-b border-warm">
        <h3 className="text-[13px] font-semibold text-ink-900 tracking-tight">Volume by organization</h3>
        <p className="text-[11px] text-stone-500 mt-0.5">
          {top.length > 0 ? `Top ${top.length} — total verifications lifetime` : 'Ranked by verification count'}
        </p>
      </div>
      {!loaded ? (
        <div className="p-5"><LoadingSkeleton rows={4} height="h-6" /></div>
      ) : top.length === 0 ? (
        <div className="h-56 flex items-center justify-center text-sm text-stone-400 italic">
          No verifications yet
        </div>
      ) : (
        <div className="p-4">
          <div style={{ height: Math.max(200, top.length * 44) }}>
            <ResponsiveContainer>
              <BarChart data={top} layout="vertical" margin={{ top: 8, right: 24, left: 8, bottom: 4 }}>
                <CartesianGrid stroke={GRID_LINE} horizontal={false} />
                <XAxis type="number" stroke={GRID_LINE}
                  tick={{ fill: AXIS_MUTED, fontSize: 11 }}
                  tickLine={false} axisLine={false}
                  allowDecimals={false} />
                <YAxis type="category" dataKey="name" stroke={GRID_LINE}
                  tick={{ fill: '#4C5C71', fontSize: 12, fontWeight: 600 }}
                  tickLine={false} axisLine={false} width={170} />
                <Tooltip content={<OrgBarTooltip />} cursor={{ fill: '#F6F8FA' }} />
                <Bar dataKey="total" radius={[0, 6, 6, 0]} barSize={20}>
                  {top.map((row) => (
                    <Cell key={row.name} fill={row.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  )
}

function OrgBarTooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  const row = payload[0].payload
  const pct = row.total ? (row.verified / row.total) * 100 : 0
  return (
    <div className="rounded-lg bg-brand-600 text-white shadow-lg px-3 py-2 text-xs border border-stone-700 min-w-[160px] max-w-[280px]">
      <p className="font-medium mb-0.5 text-stone-100 break-words">{row.fullName || row.name}</p>
      {row.code && row.code !== row.fullName && (
        <p className="text-[10px] font-mono text-stone-400 mb-1">{row.code}</p>
      )}
      <p className="tabular-nums text-stone-200">{nf.format(row.total)} verifications</p>
      <p className="tabular-nums text-emerald-300 text-[11px]">{nf.format(row.verified)} verified</p>
      <p className="tabular-nums text-rose-300 text-[11px]">{nf.format(row.denied)} denied</p>
      <p className="tabular-nums text-stone-400 text-[11px] border-t border-stone-700 pt-1 mt-1">
        {pct.toFixed(1)}% success
      </p>
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
              <li key={o.id} className="px-5 py-3 hover:bg-[#F6F8FA] transition-colors">
                <div className="flex items-center gap-3 text-xs">
                  <span className="h-2.5 w-2.5 rounded-sm shrink-0"
                    style={{ background: colourFor(o.id) }} />
                  <span className="font-medium text-stone-800 truncate flex-1">{o.name}</span>
                  <span className="tabular-nums text-stone-500 w-12 text-right">{pct.toFixed(1)}%</span>
                </div>
                <div className="mt-1.5 h-[3px] rounded-full bg-[#ECF0F5] overflow-hidden">
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
            <tr className="border-b border-warm bg-[#F6F8FA]">
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
              // A negative count means the board's Data Plane could not
              // be reached, so the number is unknown rather than zero.
              // Rendering 0 there would read as "nobody was verified",
              // which is indistinguishable from a genuinely quiet
              // institute. Same -1 sentinel the client list uses.
              const unknown = o.total < 0
              const pct = !unknown && o.total ? (o.verified / o.total) * 100 : 0
              const pctTone = unknown ? 'text-stone-400'
                           : pct >= 95 ? 'text-emerald-700'
                           : pct >= 85 ? 'text-amber-700'
                           :             'text-rose-700'
              return (
                <tr key={o.id} className="hover:bg-[#F6F8FA] transition-colors">
                  <td className="px-5 py-3">
                    <span className="inline-flex items-center gap-2">
                      <span className="h-2.5 w-2.5 rounded-sm shrink-0"
                        style={{ background: colourFor(o.id) }} />
                      <span className="text-[11px] font-semibold text-stone-700 uppercase tracking-wider">{o.code}</span>
                    </span>
                  </td>
                  <td className="px-3 py-3 font-medium text-ink-900">{o.name}</td>
                  <td className="px-3 py-3 text-right text-stone-700 tabular-nums">{unknown ? '—' : nf.format(o.total)}</td>
                  <td className="px-3 py-3 text-right text-emerald-700 tabular-nums font-medium">{unknown ? '—' : nf.format(o.verified)}</td>
                  <td className="px-3 py-3 text-right text-rose-700 tabular-nums font-medium">{unknown ? '—' : nf.format(o.denied)}</td>
                  <td className="px-5 py-3 text-right tabular-nums font-semibold">
                    <span className={pctTone} title={unknown ? 'Data Plane unreachable — counts unavailable' : undefined}>
                      {unknown ? '—' : pct.toFixed(1) + '%'}
                    </span>
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

function ChartEmpty() {
  return (
    <div className="h-48 flex items-center justify-center text-sm text-stone-400 italic">
      No data yet
    </div>
  )
}
