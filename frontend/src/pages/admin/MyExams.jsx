import BoardMark from '../../components/fv/BoardMark.jsx'
import { ArtCalendar, ArtBoard, ArtAgent, GlyphSheet, GlyphWindow, GlyphPeople } from '../../components/fv/FvArt.jsx'
import WritingScene from '../../components/fv/WritingScene.jsx'
import FvEmpty from '../../components/fv/FvEmpty.jsx'
import { Link } from 'react-router-dom'
import { useCallback, useEffect, useState } from 'react'
import AdminShell from '../../components/fv/FvAdminShell.jsx'
import { PageHead } from '../../components/shell/AdminShell.jsx'
import { Card, CardBody } from '../../components/ui/ui.jsx'
import { Pill } from '../../components/ui/extras.jsx'
import { FadeIn } from '../../components/ui/motion.jsx'
import { getSubscriptions } from '../../lib/admin/examSubscriptions.js'
import { dateRange } from '../../lib/dates.js'

// Admin > Exams — read-only view of every exam this org has access to.
//
// Under the V15 flow exam access is minted automatically when the org's
// KYC is approved: the superadmin (or client reviewer, per mode) fires
// approveApplication, which fans out organization_exam_subscriptions
// rows for every visible + open exam under the destination client. The
// admin doesn't pick and doesn't unsubscribe — this page just tells
// them which exams their verification agents can be assigned to.
//
// Expired / closed exams are filtered out so the page reads as
// "what can my agents actually verify against right now"; the
// underlying rows still exist for audit + history views.
export default function MyExams() {
  const [subs, setSubs] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      setSubs(await getSubscriptions())
    } catch (e) {
      setErr(e.message || 'Could not load exams')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // Active = exam not closed AND today is within its verification window.
  // Uses verification_to as the past-cutoff so an archived exam whose
  // window ended yesterday drops off automatically without needing the
  // superadmin to also mark it closed=1.
  const isExamActive = (s) => {
    if (s.exam_closed) return false
    if (s.verification_to && new Date() > new Date(s.verification_to)) return false
    return true
  }

  const activeSubs = subs.filter(isExamActive)

  return (
    <AdminShell>
      {/* The page's living background: the companion writing his paper. */}
      <WritingScene className="fixed bottom-[30px] right-[3%] z-0 h-[min(62vh,560px)] aspect-[400/300] opacity-[0.18]" />
      <div className="fv-bold relative z-[1]">
      <FadeIn>
        <PageHead eyebrow="Access" title="My exams" art={ArtCalendar} subtitle="Open exams your agents can verify." />
        {err && (
          <div role="alert" className="mb-4 rounded-[12px] bg-fv-card-focus px-4 py-3 text-[14px] text-fv-accent-deep">{err}</div>
        )}
        {loading ? (
          <div className="p-10 text-center text-[14px] text-fv-muted">Loading…</div>
        ) : activeSubs.length === 0 ? (
          <div className="rounded-[12px] border border-fv-line bg-fv-card">
            <FvEmpty title="No open exams yet" body="Approved exams land here." />
          </div>
        ) : (
          <div className="fv-stagger grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {activeSubs.map((s) => <ExamCard key={s.exam_id} s={s} />)}
          </div>
        )}
      </FadeIn>
      </div>
    </AdminShell>
  )
}

// One exam: the paper up top, its board, three numbers with pictures,
// and a stamp for its status.
function ExamCard({ s }) {
  const closed = !!s.exam_closed
  const n = (v) => (v != null ? Number(v).toLocaleString('en-IN') : '—')
  return (
    <article className="relative overflow-hidden rounded-[12px] border border-fv-line bg-fv-card"
             data-guide-title={s.exam_name} data-guide="An exam your agents can verify now.">
      {/* the paper band */}
      <div className="relative flex items-center gap-4 bg-fv-card-focus px-5 pt-5 pb-4">
        <GlyphSheet className="h-16 w-16 shrink-0" />
        <div className="min-w-0 flex-1">
          <h3 className="fv-display text-[21px] leading-tight tracking-[-0.02em] text-fv-ink truncate">{s.exam_name}</h3>
          <div className="mt-2 text-[13.5px] text-fv-accent-deep">
            <BoardMark name={s.client_name} />
          </div>
        </div>
        {/* status stamp */}
        <svg viewBox="0 0 64 64" className="h-16 w-16 shrink-0 -rotate-12" aria-label={closed ? 'Closed' : 'Active'}>
          <circle cx="32" cy="32" r="27" fill="none" stroke={closed ? '#A8711F' : '#5B3FA6'} strokeWidth="3.5" />
          <circle cx="32" cy="32" r="21" fill="none" stroke={closed ? '#A8711F' : '#5B3FA6'} strokeWidth="1.4" strokeDasharray="3 3" />
          {closed
            ? <path d="M24 24l16 16M40 24 24 40" stroke="#A8711F" strokeWidth="4" strokeLinecap="round" />
            : <path d="M22 33l7 7 13-15" fill="none" stroke="#5B3FA6" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />}
        </svg>
      </div>
      {/* three numbers */}
      <div className="grid grid-cols-3 divide-x divide-fv-line">
        <Stat glyph={GlyphWindow} label="Window" value={dateRange(s.verification_from, s.verification_to) || 'Not set'} small />
        <Stat glyph={GlyphPeople} label="Candidates" value={n(s.candidate_count)} />
        <Stat glyph={AgentGlyph} label="Agents" value={n(s.operator_count)} />
      </div>
      <Link to="/admin/operators"
            className="flex items-center justify-center gap-2 border-t border-fv-line py-3 text-[14px] text-fv-accent hover:bg-fv-card-focus transition-colors">
        <ArtAgent className="h-7 w-7" />Give to agents
      </Link>
    </article>
  )
}
function Stat({ glyph: G, label, value, small }) {
  return (
    <div className="flex flex-col items-center px-3 py-4 text-center">
      <G className="h-7 w-7" />
      <p className={`fv-display mt-1.5 leading-tight text-fv-ink tabular-nums ${small ? 'text-[14px]' : 'text-[24px]'}`}>{value}</p>
      <p className="text-[12.5px] text-fv-muted">{label}</p>
    </div>
  )
}
function AgentGlyph({ className }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <circle cx="12" cy="8" r="4" fill="#C68B59" />
      <path d="M7.6 7.6a4.4 4.4 0 0 1 8.8 0c-.8-1.4-2-2.1-3.4-2.3-1 .9-3 1.5-5.4 2.3z" fill="#211E33" />
      <path d="M4 21c0-4.4 3.6-7.4 8-7.4s8 3 8 7.4z" fill="#5B3FA6" />
      <path d="M10.3 14l1.7 4 1.7-4" stroke="#F28C28" strokeWidth="1.2" fill="none" />
    </svg>
  )
}
