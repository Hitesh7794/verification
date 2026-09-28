import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import FvAdminShell from '../../components/fv/FvAdminShell.jsx'
import { api } from '../../lib/api.js'
import { usePolling } from '../../lib/usePolling.js'
import { ArtClipboard, ArtRecords, ArtStudents, ArtExam, ArtCalendar, ArtQueue } from '../../components/fv/FvArt.jsx'

// Admin overview — FlatViolet redesign. Everything on one screen, no scroll:
//
//   [ today: 204, split | three standing figures ]  [ busiest exams ]
//   [ daily volume (fills the height)            ]  [ recent, on a time rail ]
//
// Lists show only whole rows that fit; the chart stretches to the space left.
//
// Same data and polling as before (/admin/stats, /recent, /by-center,
// /timeline every 4 s). Status is shown by colour, not words: violet with a
// tick is verified, amber with a cross is denied (colour-blind checked).

const VERIFIED = '#5B3FA6'      // violet: verified
const DENIED = '#A8711F'        // amber: denied
const VERIFIED_INK = '#43307D'  // the same, dark enough for text
const DENIED_INK = '#7A4F12'
const GRID = '#E3E1EA'
const AXIS = '#A29EB3'
const nf = new Intl.NumberFormat('en-IN')

function ago(s) {
  const d = (Date.now() - new Date(s).getTime()) / 1000
  if (!isFinite(d)) return ''
  if (d < 60) return 'just now'
  if (d < 3600) return `${Math.floor(d / 60)} min ago`
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`
  return new Date(s).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

export default function AdminDashboard() {
  const [stats, setStats] = useState(null)
  const [recent, setRecent] = useState([])
  const [byCenter, setByCenter] = useState([])
  const [timeline, setTimeline] = useState([])
  const [err, setErr] = useState('')
  const [loaded, setLoaded] = useState(false)

  usePolling(async () => {
    try {
      const [s, r, c, t] = await Promise.all([
        api('/admin/stats'), api('/admin/recent'), api('/admin/by-center'), api('/admin/timeline'),
      ])
      setStats(s); setRecent(Array.isArray(r) ? r.slice(0, 20) : []); setByCenter(Array.isArray(c) ? c : [])
      setTimeline(Array.isArray(t) ? t : []); setErr(''); setLoaded(true)
    } catch (e) { setErr(e.message) }
  }, 4000)

  const today = stats?.today ?? 0
  const todayRow = timeline.length ? timeline[timeline.length - 1] : null
  const tv = todayRow?.verified ?? 0
  const td = todayRow?.denied ?? 0
  const now = useNow()

  return (
    <FvAdminShell fit>
      <div className="flex flex-col gap-3 lg:h-full">
        {err && <p role="alert" className="shrink-0 rounded-[12px] bg-fv-card-focus px-4 py-2 text-[14px] font-medium text-fv-accent-deep">{err}</p>}

        {/* ── One screen: today + glance, centres / volume, recent ── */}
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)] lg:grid-rows-[auto_minmax(0,1fr)]">
          <section className="grid grid-cols-1 divide-y divide-fv-line rounded-[12px] border border-fv-line bg-fv-card md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] md:divide-x md:divide-y-0" aria-labelledby="today-h">
            <div className="px-6 pt-4 pb-5" data-guide-title="Checked today" data-guide="How many candidates your agents checked today. The bar splits them into verified and denied.">
              <div className="flex items-center gap-2.5">
                <ArtClipboard className="h-10 w-10" />
                <div>
                  <h2 id="today-h" className="text-[15px] font-semibold leading-tight text-fv-muted">Checked today</h2>
                  <p className="text-[12.5px] leading-tight text-fv-faint">{now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
                </div>
              </div>
              <p className="fv-display mt-1 text-[68px] leading-[0.92] font-bold tracking-[-0.045em] text-fv-ink tabular-nums">
                {loaded ? nf.format(today) : '—'}
              </p>
              <SplitBar verified={tv} denied={td} />
              <div className="mt-3 grid grid-cols-2 gap-4">
                <Figure ok value={tv} />
                <Figure ok={false} value={td} />
              </div>
            </div>
            <div className="flex flex-col divide-y divide-fv-line">
              <Glance art={ArtRecords} label="Verifications so far" value={stats?.total} to="/admin/history" action="Open history" guide="Every verification your agents have run since your institution joined." />
              <Glance art={ArtStudents} label="Candidates enrolled" value={stats?.enrolled} note="Across your exams" guide="Candidates registered for the exams your institution verifies." />
              <Glance art={ArtExam} label="Exams assigned" value={stats?.exams} to="/admin/my-exams" action="See exams" guide="The exams you can verify candidates for right now." />
            </div>
          </section>
          <ExamsCard rows={byCenter} />
          <VolumeCard timeline={timeline} />
          <RecentCard rows={recent} loaded={loaded} now={now} />
        </div>
      </div>
    </FvAdminShell>
  )
}

// ── Pieces ────────────────────────────────────────────────────────────

// The current time, ticking every second.
function useNow() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(id) }, [])
  return now
}
const hhmm = (d) => d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })

function SplitBar({ verified, denied }) {
  const total = verified + denied
  const vw = total ? (verified / total) * 100 : 0
  return (
    <div className="mt-3">
      <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-full bg-fv-card-focus">
        <span className="h-full rounded-l-full transition-[width] duration-700" style={{ width: `${vw}%`, background: VERIFIED }} />
        <span className="h-full rounded-r-full transition-[width] duration-700" style={{ width: `${100 - vw}%`, background: total ? DENIED : 'transparent' }} />
      </div>
      <p className="hidden">
        <span className="font-semibold text-fv-ink">{nf.format(verified)}</span> verified, <span className="font-semibold text-fv-ink">{nf.format(denied)}</span> denied
      </p>
    </div>
  )
}

// A number in its status colour, with a tick (verified) or cross (denied).
function Figure({ ok, value }) {
  return (
    <div className="flex items-center gap-2.5" aria-label={`${nf.format(value)} ${ok ? 'verified' : 'denied'}`}>
      <StatusMark ok={ok} size={26} />
      <span className="fv-display text-[28px] leading-none font-bold tabular-nums" style={{ color: ok ? VERIFIED_INK : DENIED_INK }}>{nf.format(value)}</span>
    </div>
  )
}
function StatusMark({ ok, size = 18 }) {
  return (
    <span aria-hidden="true" className="grid shrink-0 place-items-center rounded-full text-white"
          style={{ width: size, height: size, background: ok ? VERIFIED : DENIED }}>
      <svg viewBox="0 0 12 12" style={{ width: size * 0.56, height: size * 0.56 }} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        {ok ? <path d="M2.5 6.3 5 8.6l4.5-5" /> : <path d="M3.5 3.5l5 5M8.5 3.5l-5 5" />}
      </svg>
    </span>
  )
}

function Glance({ label, value, note, to, action, guide, art: ArtC }) {
  return (
    <div className="flex flex-1 items-center gap-3 px-4 py-2.5 sm:gap-4 sm:px-5" data-guide={guide} data-guide-title={label}>
      {ArtC && <ArtC className="h-12 w-12 shrink-0" />}
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] leading-tight text-fv-muted">{label}</p>
        {to ? (
          <Link to={to} className="text-[13px] font-semibold text-fv-accent hover:text-fv-accent-deep">{action}</Link>
        ) : (
          <p className="text-[13px] text-fv-faint">{note}</p>
        )}
      </div>
      <p className="fv-display shrink-0 text-[26px] leading-none font-bold tracking-[-0.03em] text-fv-ink tabular-nums xl:text-[30px]">
        {value != null ? nf.format(value) : '—'}
      </p>
    </div>
  )
}

function Card({ title, sub, right, children, className = '', guide, art: ArtC }) {
  return (
    <section className={`flex min-h-0 flex-col rounded-[12px] border border-fv-line bg-fv-card ${className}`} data-guide={guide} data-guide-title={guide ? title : undefined}>
      <div className="flex shrink-0 items-start justify-between gap-4 px-5 pt-4">
        <div className="flex items-center gap-3">
          {ArtC && <ArtC className="h-10 w-10 shrink-0" />}
          <div>
            <h2 className="fv-display text-[18px] leading-tight font-bold tracking-[-0.015em] text-fv-ink">{title}</h2>
            {sub && <p className="text-[13px] text-fv-muted">{sub}</p>}
          </div>
        </div>
        {right}
      </div>
      {children}
    </section>
  )
}

function VolumeCard({ timeline }) {
  const data = timeline.map((d) => ({
    ...d,
    label: new Date(d.date).toLocaleDateString('en-IN', { weekday: 'short' }),
  }))
  return (
    <Card
      guide="Checks per day this week. Violet is verified, amber is denied. Hover a bar for that day's numbers."
      art={ArtCalendar}
      title="Daily volume"
      sub={`Last ${data.length || 7} days`}
    >
      <div className="min-h-[260px] flex-1 px-3 pb-3 pt-3">
        {data.length === 0 ? (
          <p className="grid h-full place-items-center text-[14px] text-fv-muted">Each day your agents verify candidates, this fills in.</p>
        ) : (
          <ResponsiveContainer>
            <BarChart data={data} margin={{ top: 6, right: 12, left: -8, bottom: 0 }} barCategoryGap="28%">
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: AXIS, fontSize: 13 }} dy={6} />
              <YAxis tickLine={false} axisLine={false} tick={{ fill: AXIS, fontSize: 13 }} width={44} />
              <Tooltip cursor={{ fill: '#EFEBF9' }} content={<VolumeTip />} />
              <Bar dataKey="verified" stackId="d" fill={VERIFIED} stroke="#FFFFFF" strokeWidth={2} radius={[0, 0, 4, 4]} />
              <Bar dataKey="denied" stackId="d" fill={DENIED} stroke="#FFFFFF" strokeWidth={2} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </Card>
  )
}
function VolumeTip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  const v = payload.find((p) => p.dataKey === 'verified')?.value ?? 0
  const d = payload.find((p) => p.dataKey === 'denied')?.value ?? 0
  return (
    <div className="rounded-[10px] border border-fv-line bg-fv-card px-3.5 py-2.5 text-[13.5px] text-fv-ink">
      <p className="font-semibold">{label}</p>
      <p className="mt-1 flex items-center gap-2 tabular-nums"><span className="h-2 w-2 rounded-[2px]" style={{ background: VERIFIED }} />{nf.format(v)} verified</p>
      <p className="flex items-center gap-2 tabular-nums"><span className="h-2 w-2 rounded-[2px]" style={{ background: DENIED }} />{nf.format(d)} denied</p>
      <p className="mt-1 border-t border-fv-line pt-1 text-fv-muted tabular-nums">{nf.format(v + d)} in all</p>
    </div>
  )
}

// How many fixed-height rows fit in a box (so nothing is ever cut in half).
function useFit(rowH, min = 1, pad = 0) {
  const ref = useRef(null)
  const [n, setN] = useState(min)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const ro = new ResizeObserver(() => setN(Math.max(min, Math.floor((el.clientHeight - pad) / rowH))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [rowH, min, pad])
  return [ref, n]
}

function ExamsCard({ rows }) {
  const [ref, fit] = useFit(52, 1, 4)
  const top = rows.slice(0, fit)
  const max = Math.max(1, ...rows.map((r) => r.total || 0))
  return (
    <Card art={ArtExam} title="Busiest exams" sub="By verifications" guide="Your exams with the most checks, and how many were verified and denied on each.">
      {/* Pinned inside, so the list never makes its row taller than the Today card. */}
      <div ref={ref} className="relative min-h-[52px] flex-1 overflow-hidden">
        <div className="absolute inset-0 px-5 pt-1">
        {rows.length === 0 ? (
          <p className="py-6 text-[14px] text-fv-muted">Your exams appear here once verifications start.</p>
        ) : (
          <ul>
            {top.map((r) => {
              const tot = r.total || 0
              const vw = tot ? (r.verified / tot) * 100 : 0
              return (
                <li key={r.name} className="flex h-[52px] flex-col justify-center border-b border-fv-line last:border-0">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-[14px] font-semibold text-fv-ink">{r.name}</span>
                    <span className="flex shrink-0 items-center text-[12.5px] tabular-nums">
                      <span className="inline-flex items-center gap-1 font-semibold" style={{ color: VERIFIED_INK }} aria-label={`${r.verified || 0} verified`}><StatusMark ok size={13} />{nf.format(r.verified || 0)}</span>
                      <span className="ml-2.5 inline-flex items-center gap-1 font-semibold" style={{ color: DENIED_INK }} aria-label={`${r.denied || 0} denied`}><StatusMark ok={false} size={13} />{nf.format(r.denied || 0)}</span>
                      <span className="ml-3 fv-display text-[16px] font-bold text-fv-ink">{nf.format(tot)}</span>
                    </span>
                  </div>
                  <div className="mt-1.5 flex h-[7px] rounded-full bg-fv-card-focus" style={{ width: `${Math.max(8, (tot / max) * 100)}%` }}>
                    <span className="h-full rounded-l-full" style={{ width: `${vw}%`, background: VERIFIED }} />
                    <span className="ml-[2px] h-full flex-1 rounded-r-full" style={{ background: DENIED }} />
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        </div>
      </div>
      {rows.length > top.length && (
        <Link to="/admin/my-exams" className="shrink-0 px-5 pb-3 text-[13px] font-semibold text-fv-accent hover:text-fv-accent-deep">
          {rows.length - top.length} more {rows.length - top.length === 1 ? 'exam' : 'exams'}
        </Link>
      )}
    </Card>
  )
}

function RecentCard({ rows, loaded, now }) {
  const [ref, fit] = useFit(46, 1, 34)
  return (
    <Card
      guide="The latest candidates your agents checked, on a timeline from now back. Violet tick is verified, amber cross is denied."
      art={ArtQueue}
      title="Recent verifications"
      sub="Newest first"
      right={<Link to="/admin/history" className="pt-1 text-[13.5px] font-semibold text-fv-accent hover:text-fv-accent-deep">See all</Link>}
    >
      <div ref={ref} className="relative mt-2 min-h-0 flex-1 overflow-hidden border-t border-fv-line">
        {/* The rail. */}
        <span aria-hidden="true" className="absolute top-0 bottom-0 left-[78px] w-[2px] bg-fv-card-focus" />
        {/* Now, live. */}
        <div className="relative flex h-[34px] items-center">
          <span className="w-[62px] shrink-0 pr-2 text-right fv-display text-[14px] font-bold tabular-nums text-fv-accent-deep">{hhmm(now)}</span>
          <span className="relative z-[1] ml-[10px] grid h-3.5 w-3.5 place-items-center">
            <span className="absolute inset-0 animate-ping rounded-full bg-fv-accent-soft opacity-60" />
            <span className="h-2.5 w-2.5 rounded-full bg-fv-accent" />
          </span>
          <span className="ml-3 text-[12.5px] font-semibold text-fv-accent">Now</span>
        </div>
        {!loaded ? (
          <p className="pl-[100px] pr-5 py-3 text-[14px] text-fv-muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="pl-[100px] pr-5 py-3 text-[14px] text-fv-muted">Verifications appear here as your agents run them.</p>
        ) : (
          <ul>
            {rows.slice(0, fit).map((r) => {
              const ok = r.status === 'verified'
              const at = new Date(r.created_at)
              return (
                <li key={r.id} className="group relative flex h-[46px] items-center pr-5 hover:bg-fv-page transition-colors" title={ago(r.created_at)}>
                  <span className="w-[62px] shrink-0 pr-2 text-right text-[12.5px] tabular-nums text-fv-faint group-hover:text-fv-muted">
                    {isFinite(at) ? hhmm(at) : ''}
                  </span>
                  <span className="relative z-[1] ml-[7px] rounded-full ring-[3px] ring-white" aria-label={ok ? 'Verified' : 'Denied'}>
                    <StatusMark ok={ok} size={20} />
                  </span>
                  <div className="ml-3 min-w-0 flex-1">
                    <p className="truncate text-[14px] font-semibold leading-tight text-fv-ink">{r.name || 'Candidate'}</p>
                    <p className="truncate text-[12px] leading-tight text-fv-muted">Roll {r.roll_no}, {r.center_name || 'no centre'}</p>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Card>
  )
}
