import { useState } from 'react'
import {
  Area, AreaChart, CartesianGrid,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { motion } from 'framer-motion'
import { Link } from 'react-router-dom'

import AdminShell, { PageHead } from '../../components/shell/AdminShell.jsx'
import { CountUp } from '../../components/shell/SuperUI.jsx'
import { Button } from '../../components/ui/ui.jsx'
import { api } from '../../lib/api.js'
import { usePolling } from '../../lib/usePolling.js'
import DepositModal from '../../components/wallet/DepositModal.jsx'
import { getWallet, getWalletConfig, formatRupees } from '../../lib/wallet/wallet.js'

// Warm admin dashboard — mirrors the superadmin treatment.
//   PageHead
//   Bento hero  (ring hero + 3 KPI tiles)
//   Wallet strip
//   Trend chart (2/3) + Top exams (1/3)
//   Recent activity table

const STATUS_GOOD = '#127A53'
const STATUS_BAD  = '#9B2437'
const AXIS_MUTED  = '#93A2B5'
const GRID_LINE   = '#DDE4EC'

const nf = new Intl.NumberFormat('en-IN')

// Categorical chart palette. Six hues at a matched lightness and chroma
// so no single series shouts louder than the rest, and each stays
// distinguishable in greyscale for a printed board report.
const SERIES = ['#1A57A3', '#A96D15', '#127A53', '#9B2437', '#5B4B8A', '#0E6E7D']

function fmtTime(s) {
  try { return new Date(s).toLocaleString() } catch { return s }
}

export default function AdminDashboard() {
  const [stats, setStats] = useState(null)
  const [recent, setRecent] = useState([])
  const [byCenter, setByCenter] = useState([])
  const [timeline, setTimeline] = useState([])
  const [wallet, setWallet] = useState(null)
  const [walletCfg, setWalletCfg] = useState(null)
  const [depositOpen, setDepositOpen] = useState(false)
  const [err, setErr] = useState('')
  const [loaded, setLoaded] = useState(false)

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
      setStats(s); setRecent(r); setByCenter(c); setTimeline(t)
      setWallet(w); setWalletCfg(wc); setErr(''); setLoaded(true)
    } catch (e) { setErr(e.message) }
  }, 4000)

  const total    = stats?.total ?? 0
  const verified = stats?.verified ?? 0
  const denied   = stats?.denied ?? 0
  const enrolled = stats?.enrolled ?? 0
  const exams    = stats?.exams ?? 0
  const today    = stats?.today ?? 0
  // Today's verified/denied breakdown from the timeline (last entry
  // is today when timeline includes today). Best-effort — falls back
  // to blanks if timeline is empty.
  const todayRow      = timeline.length > 0 ? timeline[timeline.length - 1] : null
  const todayVerified = todayRow?.verified ?? 0
  const todayDenied   = todayRow?.denied ?? 0

  return (
    <AdminShell walletRefreshKey={0}>
      <PageHead
        eyebrow="Overview"
        title="Verification overview"
        right={
          <Link to="/admin/history">
            <Button variant="secondary">History →</Button>
          </Link>
        }
      />

      {err && (
        <div className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
          {err}
        </div>
      )}

      {/* Wallet strip — admin's primary daily concern goes first */}
      {wallet && walletCfg && (
        <WalletStrip
          wallet={wallet}
          cfg={walletCfg}
          onTopUp={() => setDepositOpen(true)}
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
            getWallet().then(setWallet).catch(() => {})
          }}
        />
      )}

      {/* KPI row — 4 compact tiles */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <TodayTile      today={today} verified={todayVerified} denied={todayDenied} loaded={loaded} delay={0} />
        <BigStat label="Total verifications" value={total}    loaded={loaded} delay={0.05} />
        <BigStat label="Enrolled candidates" value={enrolled} loaded={loaded} delay={0.10} />
        <BigStat label="Subscribed exams"    value={exams}    loaded={loaded} delay={0.15}
          onClick={() => document.getElementById('activity')?.scrollIntoView({ behavior: 'smooth' })}
          hint="See activity ↓" />
      </div>

      {/* Trend chart — full width for one clear focus */}
      <div className="mb-6">
        <TrendCard timeline={timeline} />
      </div>

      {/* Two-column detail row — top exams (left) + recent (right) */}
      <div className="grid gap-4 lg:grid-cols-2 mb-8" id="activity">
        <TopExamsCard rows={byCenter} />
        <RecentTable recent={recent} loaded={loaded} />
      </div>
    </AdminShell>
  )
}

// ── TodayTile ────────────────────────────────────────────────────────
// Featured tile — how many verifications happened today, split
// verified/denied. Amber-accented label so it visually anchors as
// "current" against the three neutral scale metrics.
function TodayTile({ today, verified, denied, loaded, delay = 0 }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay, ease: [0.22, 1, 0.36, 1] }}
      whileHover={{ y: -2 }}
      className="flex flex-col rounded-xl border border-warm bg-warm-surface px-5 py-4 shadow-sm hover:shadow-md transition-shadow"
    >
      <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-600 mb-1.5">
        Today
      </p>
      <p className="text-2xl font-semibold text-ink-900 tracking-tight tabular-nums leading-none">
        {loaded ? <CountUp value={today} /> : <span className="text-stone-300">—</span>}
      </p>
      <div className="mt-2 flex items-center gap-2.5 text-[11px] text-stone-500">
        <span className="tabular-nums"><span className="text-emerald-700 font-semibold">{nf.format(verified)}</span> ok</span>
        <span className="text-stone-300">·</span>
        <span className="tabular-nums"><span className="text-rose-700 font-semibold">{nf.format(denied)}</span> denied</span>
      </div>
    </motion.div>
  )
}

// ── BigStat ──────────────────────────────────────────────────────────
// Compact scale-metric tile — small caps label on top, big number
// below. Sized to match TodayTile's footprint so the KPI row aligns.
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
      className={`group text-left w-full flex flex-col rounded-xl border border-warm bg-warm-surface px-5 py-4 shadow-sm hover:shadow-md transition-shadow ${clickable ? 'cursor-pointer focus:outline-none focus:ring-2 focus:ring-stone-400 hover:border-warm-strong' : 'cursor-default'}`}
    >
      <p className="text-[10px] font-semibold uppercase tracking-widest text-stone-500 mb-1.5">
        {label}
      </p>
      <p className="text-2xl font-semibold text-ink-900 tracking-tight tabular-nums leading-none">
        {loaded ? <CountUp value={value} /> : <span className="text-stone-300">—</span>}
      </p>
      <p className={`mt-2 text-[11px] ${clickable ? 'font-medium text-brand-700 opacity-0 group-hover:opacity-100 transition-opacity' : 'text-stone-400 italic'}`}>
        {clickable && hint ? hint : 'Across the platform'}
      </p>
    </motion.button>
  )
}

// ── Wallet strip ─────────────────────────────────────────────────────
function WalletStrip({ wallet, cfg, onTopUp }) {
  const balance = wallet.balance_paise || 0
  const feePerLookup = cfg.fee_per_lookup_paise || 0
  const remainingLookups = feePerLookup > 0 ? Math.floor(balance / feePerLookup) : Infinity
  const low = balance < feePerLookup * 20
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.2 }}
      className={`mb-6 rounded-2xl border ${low ? 'border-amber-200 bg-amber-50/40' : 'border-warm bg-warm-surface'} px-6 py-5 shadow-sm flex flex-wrap items-center gap-6`}
    >
      <div className="flex-1 min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-600 mb-2">
          Wallet balance
        </p>
        <div className="flex items-baseline gap-3 flex-wrap">
          <span className="text-3xl font-semibold text-ink-900 tabular-nums leading-none">
            {formatRupees(balance)}
          </span>
          {feePerLookup > 0 && (
            <span className="text-[11px] text-stone-500 tabular-nums">
              ≈ <span className={low ? 'text-amber-800 font-semibold' : 'text-stone-700 font-semibold'}>{remainingLookups.toLocaleString('en-IN')}</span> lookups remaining
              &nbsp;·&nbsp;{formatRupees(feePerLookup)} / lookup
            </span>
          )}
        </div>
        {low && (
          <p className="mt-2 text-[11px] text-amber-800">
            Balance is running low — top up to keep operators uninterrupted.
          </p>
        )}
      </div>
      <Button onClick={onTopUp}>Top up</Button>
    </motion.div>
  )
}

// ── TrendCard ────────────────────────────────────────────────────────
function TrendCard({ timeline }) {
  const trend = timeline.map((d) => ({ ...d, label: (d.date || '').slice(5) }))
  return (
    <div className="rounded-2xl border border-warm bg-warm-surface shadow-sm overflow-hidden">
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
                  <linearGradient id="admVerified" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%"   stopColor={STATUS_GOOD} stopOpacity={0.30} />
                    <stop offset="100%" stopColor={STATUS_GOOD} stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="admDenied" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%"   stopColor={STATUS_BAD} stopOpacity={0.28} />
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
                  stroke={STATUS_GOOD} strokeWidth={2} fill="url(#admVerified)" />
                <Area type="monotone" dataKey="denied" stackId="1"
                  stroke={STATUS_BAD} strokeWidth={2} fill="url(#admDenied)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  )
}

// ── TopExamsCard ─────────────────────────────────────────────────────
function TopExamsCard({ rows }) {
  const top = rows.slice(0, 6)
  const busiest = Math.max(...top.map((r) => r.total || 0), 1)
  return (
    <div className="rounded-2xl border border-warm bg-warm-surface shadow-sm overflow-hidden">
      <div className="px-5 pt-4 pb-3 border-b border-warm">
        <h3 className="text-[13px] font-semibold text-ink-900 tracking-tight">Top exams</h3>
        <p className="text-[11px] text-stone-500 mt-0.5">By verification volume</p>
      </div>
      {top.length === 0 ? (
        <div className="p-5"><ChartEmpty /></div>
      ) : (
        <ul className="divide-y divide-warm">
          {top.map((r, i) => {
            const share  = ((r.total || 0) / busiest) * 100
            const success = r.total ? (r.verified / r.total) * 100 : 0
            const color = SERIES[i % SERIES.length]
            return (
              <li key={r.id} className="px-5 py-3 hover:bg-[#F6F8FA] transition-colors">
                <div className="flex items-center gap-3 text-xs">
                  <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: color }} />
                  <span className="font-medium text-stone-800 truncate flex-1">{r.name}</span>
                  <span className="tabular-nums text-stone-700">{nf.format(r.total || 0)}</span>
                  <span className="tabular-nums text-stone-500 w-12 text-right">{success.toFixed(1)}%</span>
                </div>
                <div className="mt-1.5 h-[3px] rounded-full bg-[#ECF0F5] overflow-hidden">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${share}%` }}
                    transition={{ duration: 0.7, ease: 'easeOut' }}
                    className="h-full rounded-full"
                    style={{ background: color }}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// ── RecentTable ──────────────────────────────────────────────────────
function RecentTable({ recent, loaded }) {
  return (
    <div className="rounded-2xl border border-warm bg-warm-surface shadow-sm overflow-hidden">
      <div className="flex items-baseline justify-between px-5 pt-4 pb-3 border-b border-warm">
        <div>
          <h3 className="text-[13px] font-semibold text-ink-900 tracking-tight">Recent activity</h3>
          <p className="text-[11px] text-stone-500 mt-0.5">Latest 25 verifications</p>
        </div>
        <Link to="/admin/history" className="text-[11px] font-medium text-brand-700 hover:underline">
          Full history →
        </Link>
      </div>
      {!loaded ? (
        <div className="p-5 text-sm text-stone-500 italic">Loading…</div>
      ) : recent.length === 0 ? (
        <div className="p-10 text-center text-sm text-stone-500 italic">No recent activity</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-warm bg-[#F6F8FA]">
                <th className="text-left px-5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-stone-500">Roll</th>
                <th className="text-left px-3 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-stone-500">Exam / centre</th>
                <th className="text-left px-3 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-stone-500">Verification Agent</th>
                <th className="text-left px-3 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-stone-500">Status</th>
                <th className="text-right px-5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-stone-500">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-warm">
              {recent.map((r) => (
                <tr key={r.id} className="hover:bg-[#F6F8FA] transition-colors">
                  <td className="px-5 py-3 font-medium text-ink-900 tabular-nums">{r.roll_no}</td>
                  <td className="px-3 py-3 text-stone-700 truncate max-w-[240px]">{r.center_name || '—'}</td>
                  <td className="px-3 py-3 text-stone-700 truncate max-w-[180px]">{r.operator || '—'}</td>
                  <td className="px-3 py-3">
                    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-semibold border ${r.status === 'verified' ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 'bg-rose-50 text-rose-800 border-rose-200'}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${r.status === 'verified' ? 'bg-emerald-600' : 'bg-rose-600'}`} />
                      {r.status}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right text-stone-500 tabular-nums text-xs">{fmtTime(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function TrendTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  const verified = payload.find((p) => p.dataKey === 'verified')?.value ?? 0
  const denied   = payload.find((p) => p.dataKey === 'denied')?.value ?? 0
  const total = verified + denied
  return (
    <div className="rounded-lg bg-brand-600 text-white shadow-lg px-3 py-2 text-xs border border-stone-700">
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
