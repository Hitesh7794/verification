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
  StatCard,
} from '../../components/ui/ui.jsx'
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
        subtitle="Live activity across all centers under your organization."
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

      {stats && (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-5 mb-8">
          <StatCard
            label="Enrolled candidates"
            value={(stats.enrolled || 0).toLocaleString()}
            hint={`${stats.centers} centers`}
            tone="indigo"
          />
          <StatCard label="Total verifications" value={stats.total.toLocaleString()} tone="slate" />
          <StatCard
            label="Verified"
            value={stats.verified.toLocaleString()}
            hint={stats.total ? `${stats.success_rate.toFixed(1)}% success` : 'no data yet'}
            tone="emerald"
          />
          <StatCard label="Denied" value={stats.denied.toLocaleString()} tone="rose" />
          <StatCard label="Today" value={stats.today.toLocaleString()} tone="amber" />
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3 mb-8">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Verifications — last 14 days</CardTitle>
          </CardHeader>
          <CardBody>
            <div className="h-72">
              <ResponsiveContainer>
                <LineChart data={timeline}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="date" stroke="#64748b" fontSize={12} />
                  <YAxis stroke="#64748b" fontSize={12} />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="verified" stroke="#059669" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="denied" stroke="#e11d48" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Top centers</CardTitle>
          </CardHeader>
          <CardBody>
            <div className="space-y-3">
              {byCenter.slice(0, 6).map((c) => {
                const pct = c.total ? (c.verified / c.total) * 100 : 0
                return (
                  <div key={c.id}>
                    <div className="flex justify-between text-sm">
                      <span className="font-medium text-slate-800 truncate pr-2">{c.name}</span>
                      <span className="text-slate-500">{c.total.toLocaleString()}</span>
                    </div>
                    <div className="mt-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-emerald-500"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Verifications by center</CardTitle>
          </CardHeader>
          <CardBody>
            <div className="h-72">
              <ResponsiveContainer>
                <BarChart data={byCenter.slice(0, 8)}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="name" hide />
                  <YAxis stroke="#64748b" fontSize={12} />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="verified" stackId="a" fill="#059669" />
                  <Bar dataKey="denied" stackId="a" fill="#e11d48" />
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
