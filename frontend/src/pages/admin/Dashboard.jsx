import { useState } from 'react'
import {
  BarChart,
  Bar,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import AppShell from '../../components/shell/AppShell.jsx'
import AdminTabs from '../../components/shell/AdminTabs.jsx'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  PageHeader,
} from '../../components/ui/ui.jsx'
import { StatCell, StatRow, StatShell } from '../../components/ui/statCard.jsx'
import {
  GRID,
  INK_MUTED,
  SERIES,
  STATUS_BAD,
  STATUS_GOOD,
  nf,
} from '../../lib/chartTokens.js'
import { api } from '../../lib/api.js'
import { usePolling } from '../../lib/usePolling.js'
import DepositModal from '../../components/wallet/DepositModal.jsx'
import { getWallet, getWalletConfig, formatRupees } from '../../lib/wallet/wallet.js'

function fmtTime(s) {
  try {
    return new Date(s).toLocaleString()
  } catch {
    return s
  }
}

export default function AdminDashboard() {
  const [stats, setStats] = useState(null)
  const [recent, setRecent] = useState([])
  const [byCenter, setByCenter] = useState([])
  const [timeline, setTimeline] = useState([])
  const [wallet, setWallet] = useState(null)        // { balance_paise, transactions, next_cursor }
  const [walletCfg, setWalletCfg] = useState(null)
  const [walletMoreTxs, setWalletMoreTxs] = useState([]) // appended pages
  const [walletLoadingMore, setWalletLoadingMore] = useState(false)
  const [depositOpen, setDepositOpen] = useState(false)
  const [err, setErr] = useState('')

  async function loadMoreWallet(cursor) {
    setWalletLoadingMore(true)
    try {
      const more = await getWallet({ before: cursor })
      setWalletMoreTxs((prev) => [...prev, ...(more.transactions || [])])
      // Stash the new cursor on the head wallet object so the panel
      // knows whether another "Load more" is available.
      setWallet((cur) => cur ? { ...cur, next_cursor: more.next_cursor } : cur)
    } catch (e) {
      setErr(e.message)
    } finally {
      setWalletLoadingMore(false)
    }
  }

  // Visibility-aware polling — usePolling pauses while the tab is
  // hidden and force-refreshes the moment it becomes visible again.
  // Saves battery + backend load when the admin minimises the tab.
  usePolling(async () => {
    try {
      const [s, r, c, t, w, wc] = await Promise.all([
        api('/admin/stats'),
        api('/admin/recent'),
        api('/admin/by-center'),
        api('/admin/timeline'),
        getWallet().catch(() => null),
        getWalletConfig().catch(() => null),
      ])
      setStats(s)
      setRecent(r)
      setByCenter(c)
      setTimeline(t)
      setWallet(w)
      setWalletCfg(wc)
      setErr('')
    } catch (e) {
      setErr(e.message)
    }
  }, 4000)

  return (
    <AppShell title="Exam Administrator Portal" subtitle="Verification operations dashboard">
      <PageHeader
        title="Verification overview"
        subtitle="Live activity across the exams your organization is subscribed to."
      />
      <AdminTabs />

      {err && (
        <div className="mb-6 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
          {err}
        </div>
      )}

      {wallet && walletCfg && (
        <WalletPanel
          wallet={wallet}
          cfg={walletCfg}
          onTopUp={() => setDepositOpen(true)}
          onLoadMore={loadMoreWallet}
          loadingMore={walletLoadingMore}
          extraTxs={walletMoreTxs}
        />
      )}

      {depositOpen && walletCfg && (
        <DepositModal
          config={walletCfg}
          currentBalance={wallet?.balance_paise ?? 0}
          onClose={() => setDepositOpen(false)}
          onSuccess={(newBalance) => {
            setWallet((w) => w ? { ...w, balance_paise: newBalance } : w)
            setDepositOpen(false)
            // Trigger an immediate reload so the transactions list
            // includes the new deposit row without waiting for the 4s
            // polling interval.
            getWallet().then(setWallet).catch(() => {})
          }}
        />
      )}

      {stats && <StatsRow stats={stats} timeline={timeline} />}

      <div className="grid gap-6 lg:grid-cols-3 mb-8">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Verifications — last 14 days</CardTitle>
          </CardHeader>
          <CardBody>
            <div className="h-72">
              <ResponsiveContainer>
                {/* Solid hairline grid, horizontal only — dashed rules
                    read as "threshold" when they're just a grid. */}
                <LineChart data={timeline} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                  <CartesianGrid stroke={GRID} vertical={false} />
                  <XAxis
                    dataKey="date"
                    stroke={GRID}
                    tick={{ fill: INK_MUTED, fontSize: 11 }}
                    tickLine={false}
                    tickFormatter={(d) => String(d).slice(5)}
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
                  <Legend
                    iconType="plainline"
                    wrapperStyle={{ fontSize: 12, color: '#52514e' }}
                  />
                  <Line
                    type="monotone"
                    dataKey="verified"
                    name="Verified"
                    stroke={STATUS_GOOD}
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="denied"
                    name="Denied"
                    stroke={STATUS_BAD}
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardBody>
        </Card>

        <Card className="self-start">
          <CardHeader>
            <CardTitle>Top exams</CardTitle>
          </CardHeader>
          <CardBody>
            {/* Bar is scaled to the busiest exam's volume, which is the
                number printed beside it — so relative activity across
                exams reads at a glance. */}
            <div className="space-y-3">
              {(() => {
                const top = byCenter.slice(0, 6)
                const busiest = Math.max(...top.map((c) => c.total || 0), 1)
                return top.map((c) => {
                  const share = ((c.total || 0) / busiest) * 100
                  const success = c.total ? (c.verified / c.total) * 100 : 0
                  return (
                    <div key={c.id}>
                      <div className="flex justify-between text-sm gap-2">
                        <span className="font-medium text-slate-800 truncate">{c.name}</span>
                        <span className="text-slate-600 tabular-nums shrink-0">
                          {nf.format(c.total || 0)}
                        </span>
                      </div>
                      <div className="mt-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${share}%`, background: SERIES[0] }}
                        />
                      </div>
                      <p className="mt-1 text-xs text-slate-500 tabular-nums">
                        {success.toFixed(1)}% success
                      </p>
                    </div>
                  )
                })
              })()}
              {byCenter.length === 0 && (
                <p className="text-sm text-slate-400 text-center py-6">No centre activity yet.</p>
              )}
            </div>
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="self-start">
          <CardHeader>
            <CardTitle>Verifications by center</CardTitle>
          </CardHeader>
          <CardBody>
            {/* Height follows the row count instead of a fixed h-72 — an
                org with two centres was rendering two bars adrift in an
                empty 288px box. Floor keeps the axis band readable. */}
            <div style={{ height: Math.max(160, byCenter.slice(0, 8).length * 40 + 56) }}>
              <ResponsiveContainer>
                {/* Horizontal: centre names are long, and this reads them
                    without the hidden x-axis the vertical version needed. */}
                <BarChart
                  data={byCenter.slice(0, 8)}
                  layout="vertical"
                  margin={{ top: 0, right: 16, left: 8, bottom: 0 }}
                  barCategoryGap={8}
                >
                  <CartesianGrid stroke={GRID} horizontal={false} />
                  <XAxis
                    type="number"
                    stroke={GRID}
                    tick={{ fill: INK_MUTED, fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={150}
                    stroke={GRID}
                    tick={{ fill: INK_MUTED, fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip content={<CenterTooltip />} cursor={{ fill: '#f1f5f9' }} />
                  <Legend wrapperStyle={{ fontSize: 12, color: '#52514e' }} />
                  {/* 2px surface stroke gives the segment gap the spec
                      asks for, rather than a border around each mark. */}
                  <Bar dataKey="verified" name="Verified" stackId="a" fill={STATUS_GOOD}
                       stroke="#ffffff" strokeWidth={2} barSize={16} />
                  <Bar dataKey="denied" name="Denied" stackId="a" fill={STATUS_BAD}
                       stroke="#ffffff" strokeWidth={2} barSize={16} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
          </CardHeader>
          <CardBody className="p-0">
            <div className="max-h-72 overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-50 text-slate-500 uppercase text-xs">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium">Roll</th>
                    <th className="text-left px-4 py-2 font-medium">Center</th>
                    <th className="text-left px-4 py-2 font-medium">Status</th>
                    <th className="text-left px-4 py-2 font-medium">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((r) => (
                    <tr key={r.id} className="border-t border-slate-100">
                      <td className="px-4 py-2 font-medium text-slate-900">{r.roll_no}</td>
                      <td className="px-4 py-2 text-slate-600 truncate max-w-[180px]">{r.center_name}</td>
                      <td className="px-4 py-2">
                        <Badge tone={r.status === 'verified' ? 'green' : 'red'}>
                          {r.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-slate-500">{fmtTime(r.created_at)}</td>
                    </tr>
                  ))}
                  {recent.length === 0 && (
                    <tr>
                      <td colSpan={4} className="text-center text-slate-500 py-6">
                        No recent activity
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
      </div>
    </AppShell>
  )
}

// ── Tooltips ──────────────────────────────────────────────────────────
// Recharts' default tooltip is an unstyled white box that ignores the
// app's surfaces. These enhance rather than gate — every value is also
// reachable from the stat tiles, the legend, or Recent activity.

function TooltipShell({ title, children }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-lg">
      <p className="text-xs font-medium text-slate-900 mb-1">{title}</p>
      {children}
    </div>
  )
}

function TipRow({ color, label, value }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="h-2 w-2 rounded-full shrink-0" style={{ background: color }} />
      <span className="text-slate-600">{label}</span>
      <span className="ml-auto tabular-nums text-slate-900">{value}</span>
    </div>
  )
}

function TrendTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  const v = payload.find((p) => p.dataKey === 'verified')?.value ?? 0
  const d = payload.find((p) => p.dataKey === 'denied')?.value ?? 0
  return (
    <TooltipShell title={label}>
      <TipRow color={STATUS_GOOD} label="Verified" value={nf.format(v)} />
      <TipRow color={STATUS_BAD} label="Denied" value={nf.format(d)} />
      <div className="mt-1 pt-1 border-t border-slate-100 text-xs text-slate-500 tabular-nums">
        {nf.format(v + d)} total
      </div>
    </TooltipShell>
  )
}

function CenterTooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  const c = payload[0].payload
  const t = (c.verified || 0) + (c.denied || 0)
  const pct = t ? ((c.verified / t) * 100).toFixed(1) : '0.0'
  return (
    <TooltipShell title={c.name}>
      <TipRow color={STATUS_GOOD} label="Verified" value={nf.format(c.verified || 0)} />
      <TipRow color={STATUS_BAD} label="Denied" value={nf.format(c.denied || 0)} />
      <div className="mt-1 pt-1 border-t border-slate-100 text-xs text-slate-500 tabular-nums">
        {nf.format(t)} total · {pct}% success
      </div>
    </TooltipShell>
  )
}

// ── Stats row ─────────────────────────────────────────────────────────
//
// Replaces five equal-weight tiles that gave the reader no hierarchy and
// no baseline. Three of them ("Total verifications", "Verified",
// "Denied") were one number and its split spread across three cards, and
// "Today: 145" is unreadable without something to compare it against.
//
// Everything here comes from data the page already fetches — `timeline`
// (14 days of daily verified/denied) was being used only by the line
// chart, so the trend context is free.
function StatsRow({ stats, timeline }) {
  const total = stats.total || 0
  const verified = stats.verified || 0
  const denied = stats.denied || 0
  const pct = stats.success_rate || 0

  // Last 7 complete-ish days from the timeline. Guarded because the
  // endpoint returns only days that HAVE activity — a quiet org can hand
  // back fewer than 7 rows, or none at all.
  const last7 = timeline.slice(-7)
  const week = last7.reduce((s, d) => s + (d.verified || 0) + (d.denied || 0), 0)
  const perDay = last7.length ? Math.round(week / last7.length) : 0

  // Sparkline over whatever the timeline gave us.
  const spark = timeline.map((d) => (d.verified || 0) + (d.denied || 0))

  // Deliberately NOT showing a "vs yesterday" delta on Today: at 10am a
  // partial day compared against a complete one reads as a collapse in
  // volume when nothing is wrong. The daily average below gives an
  // honest baseline instead.
  return (
    <StatRow className="grid gap-5 lg:grid-cols-3 mb-8">
      <StatCell className="lg:col-span-1">
        <StatShell className="h-full">
        <CardBody>
          <p className="text-sm font-medium text-slate-500 transition-colors group-hover:text-slate-700">
            Verification success rate
          </p>
          {total === 0 ? (
            <>
              <p className="mt-2 text-4xl font-semibold tracking-tight text-slate-300">—</p>
              <p className="mt-2 text-xs text-slate-500">No verifications recorded yet.</p>
            </>
          ) : (
            <>
              <p className="mt-2 text-5xl font-semibold tracking-tight text-slate-900">
                {pct.toFixed(1)}
                <span className="text-2xl text-slate-400">%</span>
              </p>
              {/* Meter, not a two-slice pie: this is a single ratio
                  against a limit, and the number is the chart. */}
              <div className="mt-3 h-2 w-full rounded-full bg-slate-100 overflow-hidden">
                <div
                  className="h-full rounded-full transition-[width] duration-500"
                  style={{
                    width: `${Math.min(100, Math.max(0, pct))}%`,
                    background: STATUS_GOOD,
                  }}
                />
              </div>
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
            </>
          )}
        </CardBody>
        </StatShell>
      </StatCell>

      <div className="lg:col-span-2 grid gap-5 grid-cols-2 sm:grid-cols-4">
        <Tile
          label="Today"
          value={nf.format(stats.today || 0)}
          hint={perDay ? `${nf.format(perDay)}/day average` : 'no recent activity'}
          spark={spark}
        />
        <Tile
          label="Last 7 days"
          value={nf.format(week)}
          hint={last7.length ? `across ${last7.length} active day${last7.length === 1 ? '' : 's'}` : '—'}
        />
        <Tile label="All time" value={nf.format(total)} hint="verifications recorded" />
        <Tile
          label="Exams"
          value={nf.format(stats.exams || 0)}
          hint="subscribed by your organization"
        />
      </div>
    </StatRow>
  )
}

// Compact stat tile. Proportional figures on the value — tabular-nums
// makes a large standalone number look loose.
function Tile({ label, value, hint, spark }) {
  return (
    <StatCell className="h-full">
      <StatShell className="h-full">
        <CardBody className="flex flex-col h-full">
          <p className="text-xs font-medium uppercase tracking-wider text-slate-500 transition-colors group-hover:text-slate-700">
            {label}
          </p>
          <p className="mt-1.5 text-2xl font-semibold text-slate-900">{value}</p>
          {spark && spark.length > 1 && <Sparkline values={spark} />}
          {hint && <p className="mt-auto pt-2 text-xs text-slate-500">{hint}</p>}
        </CardBody>
      </StatShell>
    </StatCell>
  )
}

// Inline SVG sparkline — a hand-rolled polyline rather than a charting
// component, because at 36px tall a full chart library brings axes,
// margins and a tooltip layer we'd only have to switch back off.
// Decorative context for the number beside it, so it's aria-hidden; the
// same series is readable in the 14-day chart further down the page.
function Sparkline({ values }) {
  const w = 88
  const h = 26
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const span = max - min || 1
  const step = w / (values.length - 1)
  const points = values
    .map((v, i) => `${(i * step).toFixed(1)},${(h - ((v - min) / span) * h).toFixed(1)}`)
    .join(' ')

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="mt-2 w-full"
      style={{ height: h }}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <polyline
        points={points}
        fill="none"
        stroke={SERIES[0]}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

// WalletPanel — balance card on the left, recent transactions on the
// right. Transactions show operator name + roll for charges, and the
// admin's name for deposits / superadmin credits. Empty state if there
// are no transactions yet (fresh org).
//
// Pagination: `wallet.next_cursor` is non-zero when there are older
// transactions to fetch. "Load more" calls the parent-supplied
// onLoadMore(cursor) which extends the visible list.
function WalletPanel({ wallet, cfg, onTopUp, onLoadMore, loadingMore, extraTxs }) {
  const balance = wallet.balance_paise
  const fee = cfg.fee_per_lookup_paise || 500
  const lookupsRemaining = fee > 0 ? Math.floor(balance / fee) : null
  const tier =
    balance <= 0           ? 'empty'   :
    balance < fee * 5      ? 'low'     :
                             'healthy'
  const tones = {
    healthy: { ring: 'ring-emerald-200', dot: 'bg-emerald-500', label: 'text-emerald-700', subtitle: 'Plenty of headroom' },
    low:     { ring: 'ring-amber-200',   dot: 'bg-amber-500',   label: 'text-amber-700',   subtitle: 'Running low — top up soon' },
    empty:   { ring: 'ring-rose-200',    dot: 'bg-rose-500',    label: 'text-rose-700',    subtitle: 'Operators are blocked — top up now' },
  }
  const txs = [...(wallet.transactions || []), ...(extraTxs || [])]
  const nextCursor = wallet.next_cursor || 0

  return (
    <div className="mb-8 grid gap-6 lg:grid-cols-3">
      <Card className={`lg:col-span-1 ring-1 ${tones[tier].ring}`}>
        <CardBody>
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-slate-500">
            <span className={`h-2 w-2 rounded-full ${tones[tier].dot}`} />
            Wallet balance
          </div>
          <div className="mt-2 text-3xl font-semibold text-slate-900 tabular-nums">
            {formatRupees(balance)}
          </div>
          <p className={`mt-1 text-sm font-medium ${tones[tier].label}`}>
            {tones[tier].subtitle}
          </p>
          {lookupsRemaining !== null && (
            <p className="mt-1 text-xs text-slate-500">
              ≈ {lookupsRemaining.toLocaleString()} lookups remaining at{' '}
              {formatRupees(fee)} per candidate
            </p>
          )}
          <div className="mt-4">
            <Button onClick={onTopUp} disabled={!cfg.razorpay_enabled}>
              {cfg.razorpay_enabled ? 'Add money' : 'Razorpay not configured'}
            </Button>
          </div>
        </CardBody>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Wallet activity</CardTitle>
        </CardHeader>
        <CardBody className="p-0">
          <div className="max-h-64 overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-50 text-slate-500 uppercase text-xs">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">When</th>
                  <th className="text-left px-4 py-2 font-medium">Kind</th>
                  <th className="text-left px-4 py-2 font-medium">Detail</th>
                  <th className="text-right px-4 py-2 font-medium">Amount</th>
                  <th className="text-right px-4 py-2 font-medium">Balance after</th>
                </tr>
              </thead>
              <tbody>
                {txs.map((t) => (
                  <WalletTxRow key={t.id} t={t} />
                ))}
                {txs.length === 0 && (
                  <tr>
                    <td colSpan={5} className="text-center text-slate-500 py-8">
                      No wallet activity yet. Top up to get started.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {(nextCursor > 0 || (extraTxs && extraTxs.length > 0)) && (
            <div className="border-t border-slate-100 px-4 py-3 text-center">
              {nextCursor > 0 ? (
                <button
                  type="button"
                  onClick={() => onLoadMore(nextCursor)}
                  disabled={loadingMore}
                  className="text-sm font-medium text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
                >
                  {loadingMore ? 'Loading…' : 'Load older transactions'}
                </button>
              ) : (
                <span className="text-xs text-slate-400">No older transactions</span>
              )}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  )
}

function WalletTxRow({ t }) {
  const isCharge = t.kind === 'charge'
  const isDeposit = t.kind === 'deposit'
  const isAdminCredit = t.kind === 'admin_credit'
  const kindLabel = isDeposit ? 'Deposit' : isCharge ? 'Lookup' : isAdminCredit ? 'Admin credit' : t.kind
  const kindTone =
    isDeposit       ? 'green'  :
    isAdminCredit   ? 'indigo' :
                      'slate'

  // Build the "detail" cell. For a charge: operator name + roll. For
  // a deposit: the admin who initiated. For admin_credit: the
  // superadmin's note (description).
  let detail
  if (isCharge) {
    const who = t.actor_display_name || t.actor_username || 'Operator'
    detail = (
      <span>
        <span className="text-slate-900">{who}</span>
        {t.related_roll && (
          <span className="text-slate-500"> · roll {t.related_roll}</span>
        )}
      </span>
    )
  } else {
    const who = t.actor_display_name || t.actor_username
    detail = (
      <span className="text-slate-600">
        {who && <span>{who}</span>}
        {who && t.description && <span className="text-slate-400"> · </span>}
        {t.description && <span className="text-slate-500">{t.description}</span>}
      </span>
    )
  }

  const amtClass = t.amount_paise < 0 ? 'text-rose-700' : 'text-emerald-700'
  return (
    <tr className="border-t border-slate-100">
      <td className="px-4 py-2 text-slate-500 whitespace-nowrap">
        {new Date(t.created_at).toLocaleString()}
      </td>
      <td className="px-4 py-2">
        <Badge tone={kindTone}>{kindLabel}</Badge>
      </td>
      <td className="px-4 py-2">{detail}</td>
      <td className={`px-4 py-2 text-right tabular-nums font-medium ${amtClass}`}>
        {t.amount_paise > 0 ? '+' : ''}{formatRupees(t.amount_paise)}
      </td>
      <td className="px-4 py-2 text-right text-slate-700 tabular-nums">
        {formatRupees(t.balance_after_paise)}
      </td>
    </tr>
  )
}
