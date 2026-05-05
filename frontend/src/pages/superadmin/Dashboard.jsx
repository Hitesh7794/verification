import { useEffect, useState } from 'react'
import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  BarChart,
  Bar,
  CartesianGrid,
  XAxis,
  YAxis,
  Legend,
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

const PIE_COLORS = ['#059669', '#e11d48']

export default function SuperDashboard() {
  const [stats, setStats] = useState(null)
  const [orgs, setOrgs] = useState([])
  const [topCenters, setTopCenters] = useState([])
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    async function load() {
      try {
        const [s, o, t] = await Promise.all([
          api('/super/stats'),
          api('/super/organizations'),
          api('/super/top-centers'),
        ])
        if (!alive) return
        setStats(s)
        setOrgs(o)
        setTopCenters(t)
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

  const pieData = stats
    ? [
        { name: 'Verified', value: stats.verified },
        { name: 'Denied', value: stats.denied },
      ]
    : []

  return (
    <AppShell title="Platform Superadmin" subtitle="Cross-organization oversight">
      <PageHeader
        title="Platform overview"
        subtitle="System-wide telemetry across every organization, center and operator."
      />

      {err && (
        <div className="mb-6 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
          {err}
        </div>
      )}

      {stats && (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-5 mb-8">
          <StatCard label="Organizations" value={stats.organizations} tone="indigo" />
          <StatCard label="Centers" value={stats.centers} tone="emerald" />
          <StatCard
            label="Enrolled candidates"
            value={(stats.enrolled || 0).toLocaleString()}
            tone="amber"
          />
          <StatCard label="Users" value={stats.users} tone="slate" />
          <StatCard
            label="Verifications"
            value={stats.total.toLocaleString()}
            hint={`${stats.verified.toLocaleString()} verified · ${stats.denied.toLocaleString()} denied`}
            tone="rose"
          />
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3 mb-8">
        <Card>
          <CardHeader>
            <CardTitle>Outcome split</CardTitle>
          </CardHeader>
          <CardBody>
            <div className="h-64">
              <ResponsiveContainer>
                <PieChart>
                  <Pie
                    data={pieData}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={50}
                    outerRadius={85}
                    paddingAngle={2}
                  >
                    {pieData.map((_, i) => (
                      <Cell key={i} fill={PIE_COLORS[i]} />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </CardBody>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Top centers (platform-wide)</CardTitle>
          </CardHeader>
          <CardBody>
            <div className="h-64">
              <ResponsiveContainer>
                <BarChart data={topCenters}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="org_code" stroke="#64748b" fontSize={12} />
                  <YAxis stroke="#64748b" fontSize={12} />
                  <Tooltip />
                  <Bar dataKey="total" fill="#6366f1" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardBody>
        </Card>
      </div>

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
                  <th className="text-right px-6 py-3 font-medium">Centers</th>
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
                        <Badge tone="indigo">{o.code}</Badge>
                      </td>
                      <td className="px-6 py-3 font-medium text-slate-900">{o.name}</td>
                      <td className="px-6 py-3 text-right text-slate-700">{o.centers}</td>
                      <td className="px-6 py-3 text-right text-slate-700">{o.total.toLocaleString()}</td>
                      <td className="px-6 py-3 text-right text-emerald-700">{o.verified.toLocaleString()}</td>
                      <td className="px-6 py-3 text-right text-rose-700">{o.denied.toLocaleString()}</td>
                      <td className="px-6 py-3 text-right text-slate-700">{pct.toFixed(1)}%</td>
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
