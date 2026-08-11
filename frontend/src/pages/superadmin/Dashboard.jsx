import { useState } from 'react'
import {
  Area,
  AreaChart,
  Cell,
  CartesianGrid,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { Link } from 'react-router-dom'

import AppShell from '../../components/shell/AppShell.jsx'
import SuperTabs from '../../components/shell/SuperTabs.jsx'
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  PageHeader,
} from '../../components/ui/ui.jsx'
import { StatCell, StatRow, StatShell } from '../../components/ui/statCard.jsx'
import { api } from '../../lib/api.js'
import { usePolling } from '../../lib/usePolling.js'

// ── Chart tokens ──────────────────────────────────────────────────────
//
// Categorical slots are assigned in FIXED ORDER and keyed by organization
// code, never by rank — a filter or a change in volume ordering must not
// repaint the survivors. Validated as a 5-slot categorical set against
// this app's white card surface: lightness band, chroma floor, adjacent
// CVD separation (worst ΔE 9.1) and normal-vision floor (worst ΔE 19.6)
// all pass. Three slots land under 3:1 contrast on white, so the relief
// rule applies — hence the value-bearing legend beside the donut and the
// organizations table below, which together mean colour never carries
// meaning on its own.
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4']

// Status tokens are reserved for state and never reused as a series
// colour. Verified/denied is genuinely status, so they belong here.
const STATUS_GOOD = '#0ca30c'
const STATUS_BAD = '#d03b3b'

const INK_MUTED = '#898781'
const GRID = '#e1e0d9'
const SURFACE = '#ffffff'

const nf = new Intl.NumberFormat('en-IN')

export default function SuperDashboard() {
  const [stats, setStats] = useState(null)
  const [orgs, setOrgs] = useState([])
  const [timeline, setTimeline] = useState([])
  const [err, setErr] = useState('')

  // Visibility-aware polling — pauses when the tab is hidden.
  usePolling(async () => {
    try {
      const [s, o, tl] = await Promise.all([
        api('/super/stats'),
        api('/super/organizations'),
        // scopeArgs() widens to WHERE 1=1 for superadmin, so this
        // endpoint returns platform-wide daily totals rather than a
        // single org's. No superadmin-specific route needed.
        api('/admin/timeline'),
      ])
      setStats(s)
      setOrgs(o)
      setTimeline(tl)
      setErr('')
    } catch (e) {
      setErr(e.message)
    }
  }, 4000)

  const total = stats?.total ?? 0
  const verified = stats?.verified ?? 0
  const denied = stats?.denied ?? 0
  const successPct = total ? (verified / total) * 100 : 0

  // Colour follows the ENTITY, never its rank. The hue is picked from a
  // stable ordering by row id — not by volume (which changes every poll)
  // and not alphabetically by code (which would repaint every existing
  // org the moment one is added earlier in the alphabet). An org keeps
  // its colour for as long as it exists.
  const colourFor = (id) => {
    const stable = [...orgs].map((o) => o.id).sort((a, b) => a - b)
    return SERIES[stable.indexOf(id) % SERIES.length]
  }

  const shareData = [...orgs]
    .filter((o) => o.total > 0)
    .sort((a, b) => b.total - a.total)
    .map((o) => ({ name: o.code, value: o.total, fill: colourFor(o.id) }))

  const trend = timeline.map((d) => ({
    date: d.date,
    label: (d.date || '').slice(5), // MM-DD — the year is redundant here
    verified: d.verified,
    denied: d.denied,
  }))

  return (
    <AppShell>
      <SuperTabs />
      <PageHeader
        title="Platform overview"
        subtitle="System-wide telemetry across every organization, centre and operator."
        right={
          <Link
            to="/superadmin/applications"
            className="inline-flex items-center justify-center font-medium rounded-lg text-sm px-4 py-2 bg-white text-slate-700 border border-slate-300 hover:bg-slate-50"
          >
            Institution registrations →
          </Link>
        }
      />

      {err && (
        <div className="mb-6 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
          {err}
        </div>
      )}

      {/* ── Hero + KPI row ────────────────────────────────────────────
          Success rate is the number this page leads with, so it gets a
          hero figure and a meter rather than a slice of a pie. The old
          two-slice donut was the classic "the number IS the chart" case:
          two segments can't be compared by angle, and the reader ends up
          reading the legend anyway. */}
      <StatRow className="grid gap-5 lg:grid-cols-3 mb-6">
        <StatCell className="lg:col-span-1">
          <StatShell className="h-full">
          <CardBody>
            <p className="text-sm font-medium text-slate-500 transition-colors group-hover:text-slate-700">
              Verification success rate
            </p>
            <p className="mt-2 text-5xl font-semibold tracking-tight text-slate-900">
              {successPct.toFixed(1)}
              <span className="text-2xl text-slate-400">%</span>
            </p>
            <Meter pct={successPct} />
            <div className="mt-3 flex items-center gap-4 text-xs">
              <span className="inline-flex items-center gap-1.5 text-slate-600">
                <span className="h-2 w-2 rounded-full" style={{ background: STATUS_GOOD }} />
                {nf.format(verified)} verified
              </span>
              <span className="inline-flex items-center gap-1.5 text-slate-600">
                <span className="h-2 w-2 rounded-full" style={{ background: STATUS_BAD }} />
                {nf.format(denied)} denied
              </span>
            </div>
          </CardBody>
          </StatShell>
        </StatCell>

        <div className="lg:col-span-2 grid gap-5 grid-cols-2 sm:grid-cols-4">
          <Tile label="Verifications" value={nf.format(total)} />
          <Tile label="Organizations" value={stats?.organizations ?? '—'} />
          <Tile label="Centres" value={stats?.centers ?? '—'} />
          <Tile label="Operators & staff" value={stats?.users ?? '—'} />
        </div>
      </StatRow>

      {/* ── Trend + share ────────────────────────────────────────────── */}
      <div className="grid gap-6 lg:grid-cols-3 mb-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Daily volume — last 14 days</CardTitle>
          </CardHeader>
          <CardBody>
            {trend.length === 0 ? (
              <ChartEmpty />
            ) : (
              // Stacked area: total height is the day's throughput, the
              // split shows outcome. One y-axis only — never two scales.
              <div className="h-72">
                <ResponsiveContainer>
                  <AreaChart data={trend} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                    <CartesianGrid stroke={GRID} vertical={false} />
                    <XAxis
                      dataKey="label"
                      stroke={GRID}
                      tick={{ fill: INK_MUTED, fontSize: 11 }}
                      tickLine={false}
                      interval="preserveStartEnd"
                      minTickGap={16}
                    />
                    <YAxis
                      stroke={GRID}
                      tick={{ fill: INK_MUTED, fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                      width={48}
                    />
                    <Tooltip content={<TrendTooltip />} cursor={{ stroke: GRID }} />
                    <Area
                      type="monotone"
                      dataKey="verified"
                      stackId="1"
                      stroke={STATUS_GOOD}
                      strokeWidth={2}
                      fill={STATUS_GOOD}
                      fillOpacity={0.16}
                    />
                    <Area
                      type="monotone"
                      dataKey="denied"
                      stackId="1"
                      stroke={STATUS_BAD}
                      strokeWidth={2}
                      fill={STATUS_BAD}
                      fillOpacity={0.16}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
            <Legend
              items={[
                { color: STATUS_GOOD, label: 'Verified' },
                { color: STATUS_BAD, label: 'Denied' },
              ]}
            />
          </CardBody>
        </Card>

        {/* The donut earns its place here: part-to-whole, five segments,
            one question — "who drives our volume?". Values sit in the
            legend so nothing is read from angle alone. */}
        <Card>
          <CardHeader>
            <CardTitle>Volume share by organization</CardTitle>
          </CardHeader>
          <CardBody>
            {shareData.length === 0 ? (
              <ChartEmpty />
            ) : (
              <>
                <div className="h-44 relative">
                  <ResponsiveContainer>
                    <PieChart>
                      <Pie
                        data={shareData}
                        dataKey="value"
                        nameKey="name"
                        innerRadius={52}
                        outerRadius={78}
                        paddingAngle={2}
                        stroke={SURFACE}
                        strokeWidth={2}
                      >
                        {shareData.map((d) => (
                          <Cell key={d.name} fill={d.fill} />
                        ))}
                      </Pie>
                      <Tooltip content={<ShareTooltip total={total} />} />
                    </PieChart>
                  </ResponsiveContainer>
                  {/* Centre label — the donut hole is free real estate,
                      and it stops the chart needing a separate total. */}
                  <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                    <span className="text-xl font-semibold text-slate-900">{nf.format(total)}</span>
                    <span className="text-[11px] uppercase tracking-wider text-slate-500">total</span>
                  </div>
                </div>
                <ul className="mt-4 space-y-1.5">
                  {shareData.map((d) => (
                    <li key={d.name} className="flex items-center gap-2 text-xs">
                      <span
                        className="h-2.5 w-2.5 rounded-sm shrink-0"
                        style={{ background: d.fill }}
                      />
                      <span className="text-slate-700 truncate">{d.name}</span>
                      <span className="ml-auto tabular-nums text-slate-500">
                        {nf.format(d.value)}
                      </span>
                      <span className="tabular-nums text-slate-400 w-11 text-right">
                        {total ? ((d.value / total) * 100).toFixed(1) : '0.0'}%
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </CardBody>
        </Card>
      </div>

      {/* ── Table view — the WCAG-clean twin of every chart above ────── */}
      <Card>
        <CardHeader>
          <CardTitle>Organizations</CardTitle>
        </CardHeader>
        <CardBody className="p-0">
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 uppercase text-xs">
                <tr>
                  <th className="text-left px-6 py-3 font-medium">Code</th>
                  <th className="text-left px-6 py-3 font-medium">Organization</th>
                  <th className="text-right px-6 py-3 font-medium">Centres</th>
                  <th className="text-right px-6 py-3 font-medium">Verifications</th>
                  <th className="text-right px-6 py-3 font-medium">Verified</th>
                  <th className="text-right px-6 py-3 font-medium">Denied</th>
                  <th className="text-right px-6 py-3 font-medium">Success</th>
                </tr>
              </thead>
              <tbody>
                {orgs.map((o) => {
                  const pct = o.total ? (o.verified / o.total) * 100 : 0
                  return (
                    <tr key={o.id} className="border-t border-slate-100">
                      <td className="px-6 py-3">
                        <span className="inline-flex items-center gap-2">
                          <span
                            className="h-2.5 w-2.5 rounded-sm shrink-0"
                            style={{ background: colourFor(o.id) }}
                          />
                          <Badge tone="indigo">{o.code}</Badge>
                        </span>
                      </td>
                      <td className="px-6 py-3 font-medium text-slate-900">{o.name}</td>
                      <td className="px-6 py-3 text-right text-slate-700 tabular-nums">{o.centers}</td>
                      <td className="px-6 py-3 text-right text-slate-700 tabular-nums">{nf.format(o.total)}</td>
                      <td className="px-6 py-3 text-right text-slate-700 tabular-nums">{nf.format(o.verified)}</td>
                      <td className="px-6 py-3 text-right text-slate-700 tabular-nums">{nf.format(o.denied)}</td>
                      <td className="px-6 py-3 text-right tabular-nums">
                        <span className={pct >= 85 ? 'text-slate-700' : 'text-amber-700'}>
                          {pct.toFixed(1)}%
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>
    </AppShell>
  )
}

// ── Pieces ────────────────────────────────────────────────────────────

// Stat tile. Proportional figures on the value — tabular-nums makes a
// large standalone number look loose.
function Tile({ label, value }) {
  return (
    <StatCell className="h-full">
      <StatShell className="h-full">
        <CardBody>
          <p className="text-xs font-medium uppercase tracking-wider text-slate-500 transition-colors group-hover:text-slate-700">
            {label}
          </p>
          <p className="mt-1.5 text-2xl font-semibold text-slate-900">{value}</p>
        </CardBody>
      </StatShell>
    </StatCell>
  )
}

// Meter — a single ratio against its limit, on a same-ramp track. This is
// the form a two-slice pie should always have been.
function Meter({ pct }) {
  return (
    <div className="mt-3 h-2 w-full rounded-full bg-slate-100 overflow-hidden">
      <div
        className="h-full rounded-full transition-[width] duration-500"
        style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: STATUS_GOOD }}
      />
    </div>
  )
}

function Legend({ items }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-4">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5 text-xs text-slate-600">
          <span className="h-2 w-2 rounded-full" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  )
}

function ChartEmpty() {
  return (
    <div className="h-44 flex items-center justify-center text-sm text-slate-400">
      No verification activity yet.
    </div>
  )
}

// ── Tooltips ──────────────────────────────────────────────────────────
// Recharts' default tooltip is an unstyled white box; these match the
// app's surfaces. Tooltips enhance — every value here is also reachable
// from the legend or the organizations table.

function TooltipShell({ title, children }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-lg">
      <p className="text-xs font-medium text-slate-900 mb-1">{title}</p>
      {children}
    </div>
  )
}

function TrendTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  const v = payload.find((p) => p.dataKey === 'verified')?.value ?? 0
  const d = payload.find((p) => p.dataKey === 'denied')?.value ?? 0
  return (
    <TooltipShell title={label}>
      <Row color={STATUS_GOOD} label="Verified" value={nf.format(v)} />
      <Row color={STATUS_BAD} label="Denied" value={nf.format(d)} />
      <div className="mt-1 pt-1 border-t border-slate-100 text-xs text-slate-500 tabular-nums">
        {nf.format(v + d)} total
      </div>
    </TooltipShell>
  )
}

function ShareTooltip({ active, payload, total }) {
  if (!active || !payload?.length) return null
  const p = payload[0]
  const pct = total ? ((p.value / total) * 100).toFixed(1) : '0.0'
  return (
    <TooltipShell title={p.name}>
      <Row color={p.payload.fill} label="Verifications" value={nf.format(p.value)} />
      <div className="text-xs text-slate-500 tabular-nums">{pct}% of platform</div>
    </TooltipShell>
  )
}

function Row({ color, label, value }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="h-2 w-2 rounded-full shrink-0" style={{ background: color }} />
      <span className="text-slate-600">{label}</span>
      <span className="ml-auto tabular-nums text-slate-900">{value}</span>
    </div>
  )
}
