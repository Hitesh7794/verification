import { useEffect, useState } from 'react'
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

import AppShell from '../../components/AppShell.jsx'
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  PageHeader,
  StatCard,
} from '../../components/ui.jsx'
import { api } from '../../lib/api.js'

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
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    async function load() {
      try {
        const [s, r, c, t] = await Promise.all([
          api('/admin/stats'),
          api('/admin/recent'),
          api('/admin/by-center'),
          api('/admin/timeline'),
        ])
        if (!alive) return
        setStats(s)
        setRecent(r)
        setByCenter(c)
        setTimeline(t)
        setErr('')
      } catch (e) {
        if (alive) setErr(e.message)
      }
    }
    load()
    const id = setInterval(load, 4000) // live refresh
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  return (
    <AppShell title="Exam Administrator Portal" subtitle="Verification operations dashboard">
      <PageHeader
        title="Verification overview"
        subtitle="Live activity across all centers under your organization."
      />

      {err && (
        <div className="mb-6 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
          {err}
        </div>
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
