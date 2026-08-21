import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import ReviewerShell, { ReviewerPageHead } from '../../components/reviewer/ReviewerShell.jsx'
import { Button, Card, CardBody, Input, Label } from '../../components/ui/ui.jsx'
import { Icon, Pill, StatTile } from '../../components/ui/extras.jsx'
import { StaggerList, StaggerItem, FadeIn } from '../../components/ui/motion.jsx'
import {
  reviewerMe,
  listSubscriptionRequests,
  approveSubscriptionRequest,
  rejectSubscriptionRequest,
  bulkApproveSubscriptionRequests,
  bulkRejectSubscriptionRequests,
  resetSubscriptionRequestToPending,
} from '../../lib/reviewer/api.js'
import { usePolling } from '../../lib/usePolling.js'
import { dateRange } from '../../lib/dates.js'

export default function ReviewerDashboard() {
  const [me, setMe] = useState(null)

  // Subscription Requests state
  const [subItems, setSubItems] = useState([])
  const [clientExams, setClientExams] = useState([])
  const [subCounts, setSubCounts] = useState({ pending: 0, approved: 0, rejected: 0, total: 0 })
  const [subLoading, setSubLoading] = useState(true)

  // Exam-First Navigation & Sub-views (null = Exams list screen, 'all' or exam_id = Details screen)
  const [selectedExamId, setSelectedExamId] = useState(null)
  const [subStatus, setSubStatus] = useState('pending') // 'pending' | 'approved' | 'rejected' | 'all'
  const [searchQuery, setSearchQuery] = useState('')

  // Exams Table Search & Pagination State
  const [examSearchQuery, setExamSearchQuery] = useState('')
  const [examPage, setExamPage] = useState(1)
  const [examPageSize, setExamPageSize] = useState(5)

  // Approved Institutions Table Pagination State
  const [approvedPage, setApprovedPage] = useState(1)
  const [approvedPageSize, setApprovedPageSize] = useState(10)

  // Selection state for Mass Actions (Pending tab)
  const [selectedOrgIds, setSelectedOrgIds] = useState(new Set())

  // University Details Pop-up Modal State
  const [selectedUniversityForDetails, setSelectedUniversityForDetails] = useState(null)
  const [copiedKey, setCopiedKey] = useState(null)

  // Action Modals state (single or bulk approve/reject)
  const [modalState, setModalState] = useState(null)
  const [actionNote, setActionNote] = useState('')
  const [actionBusy, setActionBusy] = useState(false)
  const [actionErr, setActionErr] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    reviewerMe().then((r) => { if (alive) setMe(r) }).catch(() => { })
    return () => { alive = false }
  }, [])

  // Load Subscriptions (scoped to status & examId)
  const loadSubscriptions = useCallback(async () => {
    try {
      const res = await listSubscriptionRequests({
        status: subStatus,
        examId: (selectedExamId && selectedExamId !== 'all') ? selectedExamId : '',
      })
      setSubItems(res.items || [])
      setClientExams(res.client_exams || [])
      setSubCounts(res.counts || { pending: 0, approved: 0, rejected: 0, total: 0 })
      setErr('')
    } catch (e) {
      setErr(e.message || 'Could not load subscription requests')
    } finally {
      setSubLoading(false)
    }
  }, [subStatus, selectedExamId])

  usePolling(loadSubscriptions, 8000)

  useEffect(() => {
    setSelectedOrgIds(new Set())
    setSubLoading(true)
    loadSubscriptions()
  }, [subStatus, selectedExamId, loadSubscriptions])

  // Selected Exam Object
  const currentExam = useMemo(() => {
    if (selectedExamId === 'all') return null
    return clientExams.find((e) => String(e.id) === String(selectedExamId)) || null
  }, [clientExams, selectedExamId])

  // Filtered & Paginated Published Exams for the top Exams Table
  const filteredExams = useMemo(() => {
    if (!examSearchQuery.trim()) return clientExams
    const q = examSearchQuery.toLowerCase().trim()
    return clientExams.filter(
      (e) => e.exam_code?.toLowerCase().includes(q) || e.name?.toLowerCase().includes(q)
    )
  }, [clientExams, examSearchQuery])

  const totalExamPages = Math.max(1, Math.ceil(filteredExams.length / examPageSize))
  const currentExamPage = Math.min(examPage, totalExamPages)

  const paginatedExams = useMemo(() => {
    const start = (currentExamPage - 1) * examPageSize
    return filteredExams.slice(start, start + examPageSize)
  }, [filteredExams, currentExamPage, examPageSize])

  // Overall totals across all published client exams
  const globalExamTotals = useMemo(() => {
    let pending = 0
    let approved = 0
    let rejected = 0
    let candidates = 0
    for (const e of clientExams) {
      pending += e.pending_count || 0
      approved += e.approved_count || 0
      rejected += e.rejected_count || 0
      candidates += e.candidate_count || 0
    }
    return { pending, approved, rejected, total: pending + approved + rejected, candidates }
  }, [clientExams])

  // Current active sub-status counts for the active exam (or all exams)
  const activeTabCounts = useMemo(() => {
    if (currentExam) {
      return {
        pending: currentExam.pending_count || 0,
        approved: currentExam.approved_count || 0,
        rejected: currentExam.rejected_count || 0,
        total: currentExam.total_count || 0,
      }
    }
    return subCounts
  }, [currentExam, subCounts])

  // Group raw subscriptions into one entry per Institution for the current view
  const institutions = useMemo(() => {
    const map = new Map()
    for (const item of subItems) {
      if (!map.has(item.org_id)) {
        map.set(item.org_id, {
          org_id: item.org_id,
          org_name: item.org_name,
          org_slug: item.org_slug,
          institution_type: item.institution_type,
          aishe_code: item.aishe_code,
          pan: item.pan,
          state: item.state,
          city: item.city,
          head_name: item.head_name,
          head_email: item.head_email,
          head_mobile: item.head_mobile,
          approx_student_count: item.approx_student_count,
          client_blanket_approved: item.client_blanket_approved,
          pending_exams: [],
          approved_exams: [],
          rejected_exams: [],
          all_exams: [],
        })
      }
      const org = map.get(item.org_id)
      if (item.client_blanket_approved) {
        org.client_blanket_approved = true
      }
      org.all_exams.push(item)
      if (item.status === 'pending') {
        org.pending_exams.push(item)
      } else if (item.status === 'approved') {
        org.approved_exams.push(item)
      } else if (item.status === 'rejected') {
        org.rejected_exams.push(item)
      }
    }
    return Array.from(map.values())
  }, [subItems])

  // Filter institutions based on search query
  const filteredInstitutions = useMemo(() => {
    if (!searchQuery.trim()) return institutions

    const q = searchQuery.toLowerCase().trim()
    return institutions.filter((inst) => {
      const nameMatch = inst.org_name?.toLowerCase().includes(q)
      const cityMatch = inst.city?.toLowerCase().includes(q)
      const stateMatch = inst.state?.toLowerCase().includes(q)
      const aisheMatch = inst.aishe_code?.toLowerCase().includes(q)
      const emailMatch = inst.head_email?.toLowerCase().includes(q)
      const headMatch = inst.head_name?.toLowerCase().includes(q)
      const examMatch = inst.all_exams?.some(
        (e) => e.exam_code?.toLowerCase().includes(q) || e.exam_name?.toLowerCase().includes(q)
      )
      return nameMatch || cityMatch || stateMatch || aisheMatch || emailMatch || headMatch || examMatch
    })
  }, [institutions, searchQuery])

  // Selection Helpers for Pending tab
  const visibleOrgIds = useMemo(() => filteredInstitutions.map((i) => i.org_id), [filteredInstitutions])
  const isAllSelected = visibleOrgIds.length > 0 && visibleOrgIds.every((id) => selectedOrgIds.has(id))
  const isSomeSelected = selectedOrgIds.size > 0 && !isAllSelected

  function toggleSelectAll() {
    if (isAllSelected) {
      setSelectedOrgIds(new Set())
    } else {
      setSelectedOrgIds(new Set(visibleOrgIds))
    }
  }

  function toggleSelectOrg(orgId) {
    setSelectedOrgIds((prev) => {
      const next = new Set(prev)
      if (next.has(orgId)) next.delete(orgId)
      else next.add(orgId)
      return next
    })
  }

  // Count total pending requests among selected institutions
  const totalPendingInSelected = useMemo(() => {
    let count = 0
    for (const inst of filteredInstitutions) {
      if (selectedOrgIds.has(inst.org_id)) {
        count += inst.pending_exams.length
      }
    }
    return count
  }, [filteredInstitutions, selectedOrgIds])

  // Approved Institutions Pagination Calculation
  const totalApprovedPages = Math.max(1, Math.ceil(filteredInstitutions.length / approvedPageSize))
  const currentApprovedPage = Math.min(approvedPage, totalApprovedPages)

  const paginatedApprovedInstitutions = useMemo(() => {
    const start = (currentApprovedPage - 1) * approvedPageSize
    return filteredInstitutions.slice(start, start + approvedPageSize)
  }, [filteredInstitutions, currentApprovedPage, approvedPageSize])

  // Copy helper for modal
  function copyToClipboard(text, key) {
    if (!text) return
    navigator.clipboard.writeText(text)
    setCopiedKey(key)
    setTimeout(() => setCopiedKey(null), 2000)
  }

  // Modal open triggers
  function openSingleExamApprove(org, exam) {
    setActionErr('')
    setActionNote('')
    setModalState({ type: 'single_approve', org, exam })
  }

  function openSingleExamReject(org, exam) {
    setActionErr('')
    setActionNote('')
    setModalState({ type: 'single_reject', org, exam })
  }

  function openBlanketApprove(org) {
    setActionErr('')
    setActionNote('')
    setModalState({ type: 'blanket_approve', org })
  }

  // Reset rejected subscription request back to pending
  async function handleResetToPending(orgId, examId) {
    if (portalOff) return
    try {
      setActionBusy(true)
      await resetSubscriptionRequestToPending(orgId, examId)
      loadSubscriptions()
    } catch (e) {
      setErr(e.message || 'Failed to move request back to pending')
    } finally {
      setActionBusy(false)
    }
  }

  // Action Submission Handlers
  async function handleActionSubmit() {
    if (!modalState) return
    setActionBusy(true)
    setActionErr('')
    try {
      if (modalState.type === 'single_approve') {
        await approveSubscriptionRequest(modalState.org.org_id, modalState.exam.exam_id, {
          mode: 'per_exam',
          note: actionNote,
        })
      } else if (modalState.type === 'single_reject') {
        if (!actionNote.trim()) {
          setActionErr('Please provide a reason for rejection.')
          setActionBusy(false)
          return
        }
        await rejectSubscriptionRequest(modalState.org.org_id, modalState.exam.exam_id, {
          note: actionNote.trim(),
        })
      } else if (modalState.type === 'blanket_approve') {
        await bulkApproveSubscriptionRequests({
          orgIds: [modalState.org.org_id],
          mode: 'blanket_client',
          note: actionNote,
        })
      } else if (modalState.type === 'bulk_approve') {
        const ids = Array.from(selectedOrgIds)
        await bulkApproveSubscriptionRequests({
          orgIds: ids,
          mode: 'per_exam',
          note: actionNote,
        })
        setSelectedOrgIds(new Set())
      } else if (modalState.type === 'bulk_reject') {
        if (!actionNote.trim()) {
          setActionErr('Please provide a reason for rejection.')
          setActionBusy(false)
          return
        }
        const ids = Array.from(selectedOrgIds)
        await bulkRejectSubscriptionRequests({
          orgIds: ids,
          note: actionNote.trim(),
        })
        setSelectedOrgIds(new Set())
      }
      setModalState(null)
      setActionNote('')
      loadSubscriptions()
    } catch (e) {
      setActionErr(e.message || 'Action failed')
    } finally {
      setActionBusy(false)
    }
  }

  const portalOff = me && me.portal_enabled === false

  return (
    <ReviewerShell meOverride={me}>
      <ReviewerPageHead
        eyebrow="Reviewer Portal"
        title="Exam Subscription & Review Hub"
        subtitle={me?.name
          ? `Review and manage university exam subscription requests for ${me.name}.`
          : 'Review and manage university exam subscription requests.'}
        right={
          <button
            onClick={() => {
              setSubLoading(true)
              loadSubscriptions()
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors shadow-2xs"
          >
            <Icon.Refresh className="h-4 w-4" />
            Refresh
          </button>
        }
      />

      {portalOff && (
        <div className="mb-6 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 flex items-start gap-3">
          <span className="mt-0.5 h-8 w-8 rounded-lg bg-white text-rose-700 flex items-center justify-center shrink-0 ring-1 ring-rose-200">
            <Icon.AlertTriangle className="h-4 w-4" />
          </span>
          <div className="text-sm text-rose-900">
            <p className="font-semibold">Review portal disabled by the platform team.</p>
            <p className="mt-0.5 text-rose-800 text-xs">
              Approving or rejecting is temporarily disabled until the portal is re-enabled.
            </p>
          </div>
        </div>
      )}

      {err && (
        <div className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-800">
          {err}
        </div>
      )}

      {/* ========================================================================= */}
      {/* EXAM SUBSCRIPTIONS (SCREEN 1: EXAMS TABLE | SCREEN 2: WORKSPACE)          */}
      {/* ========================================================================= */}
      <FadeIn>
          {/* ───────────────────────────────────────────────────────────────────── */}
          {/* SCREEN 1: PUBLISHED EXAMS DIRECTORY TABLE (when selectedExamId is null) */}
          {/* ───────────────────────────────────────────────────────────────────── */}
          {selectedExamId === null ? (
            <div className="space-y-6">
              {/* Stat Tiles on Exams Screen */}
              <StaggerList className="grid gap-4 grid-cols-2 lg:grid-cols-4">
                <StaggerItem>
                  <StatTile
                    label="Published Exams"
                    value={clientExams.length}
                    accent="slate"
                    icon={Icon.FileText}
                    hint="Managed by your board"
                  />
                </StaggerItem>
                <StaggerItem>
                  <StatTile
                    label="Pending Requests"
                    value={globalExamTotals.pending}
                    accent="pending"
                    icon={Icon.Clock}
                    hint="Awaiting your review"
                    onClick={() => {
                      setSelectedExamId('all')
                      setSubStatus('pending')
                    }}
                  />
                </StaggerItem>
                <StaggerItem>
                  <StatTile
                    label="Approved Subscriptions"
                    value={globalExamTotals.approved}
                    accent="approved"
                    icon={Icon.Check}
                    hint="Verified institutions"
                    onClick={() => {
                      setSelectedExamId('all')
                      setSubStatus('approved')
                    }}
                  />
                </StaggerItem>
                <StaggerItem>
                  <StatTile
                    label="Total Registered Candidates"
                    value={globalExamTotals.candidates}
                    accent="slate"
                    icon={Icon.User}
                    hint="Candidate verification volume"
                  />
                </StaggerItem>
              </StaggerList>

              {/* Published Exams Table with Pagination */}
              <Card className="overflow-hidden shadow-xs border border-slate-200">
                {/* Table Header Controls */}
                <div className="p-4 border-b border-slate-200 bg-slate-50/70 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-bold text-slate-900 text-sm flex items-center gap-1.5">
                        <Icon.FileText className="h-4 w-4 text-sky-600" />
                        Published Exams Directory
                      </h3>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-slate-200 text-slate-700 font-bold tabular-nums">
                        {clientExams.length} Exams
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Select any exam to inspect and manage university subscription requests.
                    </p>
                  </div>

                  <div className="flex items-center gap-2.5 flex-wrap">
                    {/* Search Exam by Code or Name */}
                    <div className="relative w-full sm:w-64">
                      <Icon.Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
                      <input
                        type="text"
                        value={examSearchQuery}
                        onChange={(e) => {
                          setExamSearchQuery(e.target.value)
                          setExamPage(1)
                        }}
                        placeholder="Search exam code or title..."
                        className="w-full pl-8 pr-7 py-1.5 text-xs rounded-xl border border-slate-300 bg-white text-slate-900 placeholder:text-slate-400 focus:outline-hidden focus:ring-2 focus:ring-slate-900 transition-all"
                      />
                      {examSearchQuery && (
                        <button
                          type="button"
                          onClick={() => {
                            setExamSearchQuery('')
                            setExamPage(1)
                          }}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                        >
                          <Icon.X className="h-3 w-3" />
                        </button>
                      )}
                    </div>

                    {/* All Institutes Button */}
                    <Button
                      size="sm"
                      onClick={() => {
                        setSelectedExamId('all')
                        setSelectedOrgIds(new Set())
                      }}
                      className="!bg-slate-900 !text-white text-xs font-semibold shadow-2xs"
                    >
                      <Icon.Layers className="h-3.5 w-3.5 mr-1.5" />
                      All Institutes
                    </Button>
                  </div>
                </div>

                {/* Exams Table Body */}
                {clientExams.length === 0 ? (
                  <div className="py-16 text-center text-slate-500 text-sm">
                    No exams published for this client yet.
                  </div>
                ) : filteredExams.length === 0 ? (
                  <div className="py-16 text-center text-slate-500 text-sm">
                    No exams matched your search query "{examSearchQuery}".
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-100/80 text-slate-600 uppercase tracking-wider font-semibold border-b border-slate-200">
                        <tr className="text-left">
                          <th className="px-5 py-3.5 w-32">Exam Code</th>
                          <th className="px-5 py-3.5 min-w-[240px]">Exam Name</th>
                          <th className="px-5 py-3.5">Verification Window</th>
                          <th className="px-4 py-3.5 text-center">Candidates</th>
                          <th className="px-4 py-3.5 text-center">Pending</th>
                          <th className="px-4 py-3.5 text-center">Approved</th>
                          <th className="px-4 py-3.5 text-center">Rejected</th>
                          <th className="px-5 py-3.5 text-right">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {paginatedExams.map((exam) => {
                          const pendingCnt = exam.pending_count || 0
                          const approvedCnt = exam.approved_count || 0
                          const rejectedCnt = exam.rejected_count || 0

                          return (
                            <tr
                              key={exam.id}
                              onClick={() => {
                                setSelectedExamId(exam.id)
                                setSelectedOrgIds(new Set())
                              }}
                              className="border-b border-slate-100 last:border-none cursor-pointer hover:bg-sky-50/50 transition-colors group"
                            >
                              {/* Exam Code (Plain, clean font without background pill) */}
                              <td className="px-5 py-4 align-middle">
                                <span className="font-mono font-bold text-xs text-slate-900 tracking-tight">
                                  {exam.exam_code}
                                </span>
                              </td>

                              {/* Exam Name */}
                              <td className="px-5 py-4 align-middle">
                                <div className="font-semibold text-slate-900 text-xs leading-snug truncate max-w-sm" title={exam.name}>
                                  {exam.name}
                                </div>
                              </td>

                              {/* Verification Window (Start on line 1, End on line 2, No calendar icon) */}
                              <td className="px-5 py-4 align-middle">
                                {exam.verification_from ? (
                                  <div className="flex flex-col gap-0.5 text-[11px] font-mono leading-tight whitespace-nowrap">
                                    <span className="font-semibold text-slate-800">
                                      {new Date(exam.verification_from).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                                    </span>
                                    <span className="text-slate-500">
                                      {new Date(exam.verification_to).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                                    </span>
                                  </div>
                                ) : (
                                  <span className="text-slate-400">—</span>
                                )}
                              </td>

                              {/* Candidates */}
                              <td className="px-4 py-4 align-middle text-center font-mono font-semibold text-slate-700">
                                {exam.candidate_count || 0}
                              </td>

                              {/* Pending Requests Badge */}
                              <td className="px-4 py-4 align-middle text-center">
                                <span className={`inline-flex items-center justify-center px-2.5 py-0.5 rounded-full text-xs font-bold tabular-nums ${
                                  pendingCnt > 0
                                    ? 'bg-amber-100 text-amber-800 ring-1 ring-amber-300'
                                    : 'bg-slate-100 text-slate-500'
                                }`}>
                                  {pendingCnt}
                                </span>
                              </td>

                              {/* Approved Subscriptions Badge */}
                              <td className="px-4 py-4 align-middle text-center">
                                <span className={`inline-flex items-center justify-center px-2.5 py-0.5 rounded-full text-xs font-bold tabular-nums ${
                                  approvedCnt > 0
                                    ? 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-300'
                                    : 'bg-slate-100 text-slate-500'
                                }`}>
                                  {approvedCnt}
                                </span>
                              </td>

                              {/* Rejected Badge */}
                              <td className="px-4 py-4 align-middle text-center">
                                <span className={`inline-flex items-center justify-center px-2.5 py-0.5 rounded-full text-xs font-bold tabular-nums ${
                                  rejectedCnt > 0
                                    ? 'bg-rose-100 text-rose-800'
                                    : 'bg-slate-100 text-slate-500'
                                }`}>
                                  {rejectedCnt}
                                </span>
                              </td>

                              {/* Action Button */}
                              <td className="px-5 py-4 align-middle text-right whitespace-nowrap">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setSelectedExamId(exam.id)
                                    setSelectedOrgIds(new Set())
                                  }}
                                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white border border-slate-300 text-slate-700 hover:bg-slate-900 hover:text-white hover:border-slate-900 transition-all shadow-2xs inline-flex items-center gap-1"
                                >
                                  View Requests <Icon.ChevronRight className="h-3 w-3" />
                                </button>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Pagination Controls */}
                {filteredExams.length > 0 && (
                  <div className="p-3.5 border-t border-slate-200 bg-slate-50/60 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-600">
                    <div className="flex items-center gap-2">
                      <span>
                        Showing{' '}
                        <strong>
                          {(currentExamPage - 1) * examPageSize + 1}
                        </strong>{' '}
                        to{' '}
                        <strong>
                          {Math.min(currentExamPage * examPageSize, filteredExams.length)}
                        </strong>{' '}
                        of <strong>{filteredExams.length}</strong> exams
                      </span>

                      {/* Page Size Selector */}
                      <select
                        value={examPageSize}
                        onChange={(e) => {
                          setExamPageSize(Number(e.target.value))
                          setExamPage(1)
                        }}
                        className="ml-2 text-xs rounded-lg border border-slate-300 bg-white px-2 py-1 text-slate-700 font-medium focus:outline-hidden focus:ring-1 focus:ring-slate-900"
                      >
                        <option value={5}>5 per page</option>
                        <option value={10}>10 per page</option>
                        <option value={20}>20 per page</option>
                      </select>
                    </div>

                    {/* Page Navigation Buttons */}
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={currentExamPage <= 1}
                        onClick={() => setExamPage((p) => Math.max(1, p - 1))}
                        className="px-2.5 py-1 rounded-lg border border-slate-300 bg-white text-slate-700 font-medium hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                      >
                        Previous
                      </button>

                      <div className="flex items-center gap-1">
                        {Array.from({ length: totalExamPages }).map((_, idx) => {
                          const pageNum = idx + 1
                          return (
                            <button
                              key={pageNum}
                              type="button"
                              onClick={() => setExamPage(pageNum)}
                              className={`min-w-[28px] h-7 px-2 rounded-lg text-xs font-bold transition-all ${
                                currentExamPage === pageNum
                                  ? 'bg-slate-900 text-white shadow-2xs'
                                  : 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-100'
                              }`}
                            >
                              {pageNum}
                            </button>
                          )
                        })}
                      </div>

                      <button
                        type="button"
                        disabled={currentExamPage >= totalExamPages}
                        onClick={() => setExamPage((p) => Math.min(totalExamPages, p + 1))}
                        className="px-2.5 py-1 rounded-lg border border-slate-300 bg-white text-slate-700 font-medium hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                      >
                        Next
                      </button>
                    </div>
                  </div>
                )}
              </Card>
            </div>
          ) : (
            /* ───────────────────────────────────────────────────────────────────── */
            /* SCREEN 2: EXAM SUBSCRIPTION WORKSPACE (when an exam or 'all' is selected) */
            /* ───────────────────────────────────────────────────────────────────── */
            <div className="space-y-4">
              {/* Back to Exams Navigation Strip */}
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-white p-4 rounded-2xl border border-slate-200 shadow-2xs">
                <div className="flex items-center gap-3 min-w-0">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setSelectedExamId(null)
                      setSelectedOrgIds(new Set())
                      setSearchQuery('')
                    }}
                    className="!py-1.5 !px-3 text-xs font-semibold shrink-0 hover:!bg-slate-100"
                  >
                    <Icon.ArrowLeft className="h-3.5 w-3.5 mr-1.5" />
                    Back to All Exams
                  </Button>

                  <div className="h-6 w-px bg-slate-200 hidden sm:block" />

                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono font-bold text-sm text-slate-900">
                        {currentExam ? currentExam.exam_code : 'ALL EXAMS'}
                      </span>
                      {currentExam?.name && (
                        <>
                          <span className="text-slate-300 font-normal">•</span>
                          <h3 className="font-semibold text-slate-700 text-sm truncate" title={currentExam.name}>
                            {currentExam.name}
                          </h3>
                        </>
                      )}
                      {!currentExam && (
                        <>
                          <span className="text-slate-300 font-normal">•</span>
                          <h3 className="font-semibold text-slate-700 text-sm truncate">
                            All Published Exams (Consolidated)
                          </h3>
                        </>
                      )}
                    </div>
                    {currentExam?.verification_from && (
                      <p className="text-xs text-slate-500 mt-0.5 truncate">
                        📅 Window: {dateRange(currentExam.verification_from, currentExam.verification_to)} • {currentExam.candidate_count || 0} Candidates
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {/* Status Tabs Navigation Bar (Pending, Approved, Rejected, All) */}
              <Card className="p-4">
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                  {/* Status Tabs */}
                  <div className="flex items-center gap-1.5 rounded-xl bg-slate-100 p-1 overflow-x-auto">
                    {/* Tab 1: Pending */}
                    <button
                      type="button"
                      onClick={() => {
                        setSubStatus('pending')
                        setSelectedOrgIds(new Set())
                      }}
                      className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition-all ${
                        subStatus === 'pending'
                          ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200'
                          : 'text-slate-600 hover:text-slate-900 hover:bg-white/50'
                      }`}
                    >
                      <Icon.Clock className="h-4 w-4 text-amber-600" />
                      <span>Pending Requests</span>
                      <span className={`inline-flex items-center justify-center rounded-full px-2 py-0.5 text-xs font-bold tabular-nums ${
                        subStatus === 'pending' ? 'bg-amber-100 text-amber-800 ring-1 ring-amber-300' : 'bg-slate-200 text-slate-700'
                      }`}>
                        {activeTabCounts.pending}
                      </span>
                    </button>

                    {/* Tab 2: Approved */}
                    <button
                      type="button"
                      onClick={() => {
                        setSubStatus('approved')
                        setSelectedOrgIds(new Set())
                      }}
                      className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition-all ${
                        subStatus === 'approved'
                          ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200'
                          : 'text-slate-600 hover:text-slate-900 hover:bg-white/50'
                      }`}
                    >
                      <Icon.Check className="h-4 w-4 text-emerald-600" />
                      <span>Approved Subscriptions</span>
                      <span className={`inline-flex items-center justify-center rounded-full px-2 py-0.5 text-xs font-bold tabular-nums ${
                        subStatus === 'approved' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-700'
                      }`}>
                        {activeTabCounts.approved}
                      </span>
                    </button>

                    {/* Tab 3: Rejected */}
                    <button
                      type="button"
                      onClick={() => {
                        setSubStatus('rejected')
                        setSelectedOrgIds(new Set())
                      }}
                      className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition-all ${
                        subStatus === 'rejected'
                          ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200'
                          : 'text-slate-600 hover:text-slate-900 hover:bg-white/50'
                      }`}
                    >
                      <Icon.X className="h-4 w-4 text-rose-600" />
                      <span>Rejected</span>
                      <span className={`inline-flex items-center justify-center rounded-full px-2 py-0.5 text-xs font-bold tabular-nums ${
                        subStatus === 'rejected' ? 'bg-rose-100 text-rose-800' : 'bg-slate-200 text-slate-700'
                      }`}>
                        {activeTabCounts.rejected}
                      </span>
                    </button>

                    {/* Tab 4: All */}
                    <button
                      type="button"
                      onClick={() => {
                        setSubStatus('all')
                        setSelectedOrgIds(new Set())
                      }}
                      className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition-all ${
                        subStatus === 'all'
                          ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200'
                          : 'text-slate-600 hover:text-slate-900 hover:bg-white/50'
                      }`}
                    >
                      <Icon.FileText className="h-4 w-4 text-slate-500" />
                      <span>All Universities</span>
                      <span className={`inline-flex items-center justify-center rounded-full px-2 py-0.5 text-xs font-bold tabular-nums ${
                        subStatus === 'all' ? 'bg-slate-900 text-white' : 'bg-slate-200 text-slate-700'
                      }`}>
                        {activeTabCounts.total}
                      </span>
                    </button>
                  </div>

                  {/* Instant Search Bar */}
                  <div className="relative w-full md:w-80">
                    <Icon.Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search university, AISHE, city, email..."
                      className="w-full pl-9 pr-8 py-2 text-xs rounded-xl border border-slate-300 bg-slate-50/50 text-slate-900 placeholder:text-slate-400 focus:outline-hidden focus:ring-2 focus:ring-slate-900 focus:bg-white transition-all"
                    />
                    {searchQuery && (
                      <button
                        type="button"
                        onClick={() => setSearchQuery('')}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                      >
                        <Icon.X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Workspace Header Subtitle */}
                <div className="mt-3 pt-2.5 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-slate-700">
                      {currentExam ? `${currentExam.exam_code} — ${currentExam.name}` : 'All Published Exams Overview'}
                    </span>
                    {currentExam?.verification_from && (
                      <span>• Active Window: {dateRange(currentExam.verification_from, currentExam.verification_to)}</span>
                    )}
                  </div>
                  <div>
                    Showing <strong>{filteredInstitutions.length}</strong> {filteredInstitutions.length === 1 ? 'institution' : 'institutions'}
                    {searchQuery && ' (filtered)'}
                  </div>
                </div>
              </Card>

              {/* Mass Action Toolbar for Pending Checkboxes */}
              <AnimatePresence>
                {subStatus === 'pending' && selectedOrgIds.size > 0 && (
                  <motion.div
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    className="p-3.5 rounded-2xl bg-slate-900 text-white shadow-xl flex flex-wrap items-center justify-between gap-3 border border-slate-800"
                  >
                    <div className="flex items-center gap-3">
                      <span className="h-8 w-8 rounded-xl bg-amber-500 text-white flex items-center justify-center text-sm font-bold shadow-xs">
                        {selectedOrgIds.size}
                      </span>
                      <div className="text-sm">
                        <span className="font-bold">
                          {selectedOrgIds.size} university{selectedOrgIds.size > 1 ? 'ies' : ''} selected
                        </span>
                        {totalPendingInSelected > 0 && (
                          <span className="text-xs text-slate-300 ml-2 font-medium">
                            ({totalPendingInSelected} pending subscription request{totalPendingInSelected > 1 ? 's' : ''})
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        disabled={portalOff}
                        onClick={() => {
                          setActionErr('')
                          setActionNote('')
                          setModalState({ type: 'bulk_approve', mode: 'per_exam', orgIds: Array.from(selectedOrgIds) })
                        }}
                        className="!bg-emerald-600 hover:!bg-emerald-700 !text-white text-xs font-semibold shadow-xs"
                      >
                        <Icon.Check className="h-3.5 w-3.5 mr-1" />
                        Approve Selected ({selectedOrgIds.size})
                      </Button>

                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={portalOff}
                        onClick={() => {
                          setActionErr('')
                          setActionNote('')
                          setModalState({ type: 'bulk_reject', orgIds: Array.from(selectedOrgIds) })
                        }}
                        className="!bg-rose-900/80 !text-rose-100 hover:!bg-rose-900 !border-rose-700 text-xs"
                      >
                        <Icon.X className="h-3.5 w-3.5 mr-1" />
                        Reject Selected ({selectedOrgIds.size})
                      </Button>

                      <button
                        onClick={() => setSelectedOrgIds(new Set())}
                        className="text-xs text-slate-400 hover:text-white px-2 py-1 underline transition-colors"
                      >
                        Deselect
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

            {/* SECTION C: SUB-VIEW CONTENT (PENDING, APPROVED, REJECTED, ALL) */}
            <Card className="overflow-hidden">
              {subLoading && institutions.length === 0 ? (
                <div className="py-20 text-center">
                  <div className="inline-block h-8 w-8 rounded-full border-3 border-slate-200 border-t-slate-900 animate-spin" />
                  <p className="mt-3 text-sm text-slate-500 font-medium">Loading universities…</p>
                </div>
              ) : filteredInstitutions.length === 0 ? (
                /* Empty State */
                <div className="py-20 text-center px-4">
                  <div className="mx-auto h-12 w-12 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center mb-3">
                    {subStatus === 'pending' ? <Icon.Clock className="h-6 w-6" /> :
                      subStatus === 'approved' ? <Icon.Check className="h-6 w-6" /> :
                        subStatus === 'rejected' ? <Icon.X className="h-6 w-6" /> :
                          <Icon.Search className="h-6 w-6" />}
                  </div>
                  <p className="text-base font-bold text-slate-800">
                    {searchQuery
                      ? 'No universities match your search query'
                      : subStatus === 'pending'
                        ? currentExam ? `No pending requests for ${currentExam.exam_code}` : 'No pending subscription requests'
                        : subStatus === 'approved'
                          ? currentExam ? `0 universities approved for ${currentExam.exam_code}` : 'No approved universities'
                          : subStatus === 'rejected'
                            ? 'No rejected subscription requests'
                            : 'No university records found'}
                  </p>
                  <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
                    {searchQuery
                      ? 'Try adjusting your search criteria or clearing the search bar.'
                      : subStatus === 'pending'
                        ? 'When universities request access to this exam, their requests will appear here for review.'
                        : subStatus === 'approved'
                          ? 'Approve incoming requests from the Pending tab to grant universities candidate verification access.'
                          : 'No subscription requests currently match this status filter.'}
                  </p>
                  {subStatus === 'approved' && !searchQuery && activeTabCounts.pending > 0 && (
                    <div className="mt-4">
                      <Button
                        size="sm"
                        onClick={() => setSubStatus('pending')}
                        className="!bg-slate-900 !text-white text-xs font-semibold"
                      >
                        <Icon.Clock className="h-3.5 w-3.5 mr-1" />
                        View {activeTabCounts.pending} Pending Request{activeTabCounts.pending > 1 ? 's' : ''}
                      </Button>
                    </div>
                  )}
                </div>
              ) : (
                /* ========================================================================= */
                /* 1. SUB-VIEW: PENDING REQUESTS                                             */
                /* ========================================================================= */
                subStatus === 'pending' ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50/90 sticky top-0 z-10 border-b border-slate-200">
                        <tr className="text-left text-xs uppercase tracking-wider text-slate-500">
                          <th className="px-4 py-3.5 w-12 text-center">
                            <input
                              type="checkbox"
                              checked={isAllSelected}
                              ref={(el) => {
                                if (el) el.indeterminate = isSomeSelected
                              }}
                              onChange={toggleSelectAll}
                              className="h-4 w-4 rounded border-slate-300 text-amber-600 focus:ring-amber-500 cursor-pointer"
                              title="Select all universities"
                            />
                          </th>
                          <th className="px-5 py-3.5 font-bold text-slate-700">University Details</th>
                          {selectedExamId === 'all' && (
                            <th className="px-5 py-3.5 font-bold text-slate-700">Requested Exams & Window</th>
                          )}
                          <th className="px-5 py-3.5 text-right font-bold text-slate-700">Institutional Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredInstitutions.map((org, i) => {
                          const isSelected = selectedOrgIds.has(org.org_id)
                          const isBlanket = org.client_blanket_approved

                          return (
                            <motion.tr
                              key={org.org_id}
                              initial={{ opacity: 0, y: 4 }}
                              animate={{ opacity: 1, y: 0 }}
                              transition={{ duration: 0.18, delay: Math.min(i * 0.02, 0.3) }}
                              className={`border-b border-slate-100 last:border-none transition-colors ${
                                isSelected ? 'bg-amber-50/50' : 'hover:bg-slate-50/60'
                              }`}
                            >
                              {/* Row Checkbox */}
                              <td className="px-4 py-4 text-center align-top">
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() => toggleSelectOrg(org.org_id)}
                                  className="h-4 w-4 rounded border-slate-300 text-amber-600 focus:ring-amber-500 cursor-pointer mt-1"
                                />
                              </td>

                              {/* University Details */}
                              <td className="px-5 py-4 align-top max-w-[320px]">
                                <div className="flex items-start gap-3">
                                  <span className="h-10 w-10 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 flex items-center justify-center font-bold text-sm shrink-0 mt-0.5 shadow-2xs">
                                    {(org.org_name || '?').slice(0, 1).toUpperCase()}
                                  </span>
                                  <div className="min-w-0 flex-1 space-y-1">
                                    <div>
                                      <div className="font-bold text-slate-900 text-sm leading-snug">
                                        {org.org_name}
                                      </div>
                                      <div className="text-[11px] text-slate-500 font-medium capitalize mt-0.5">
                                        {org.institution_type || 'University'}
                                        {org.aishe_code && (
                                          <span className="text-slate-400">
                                            {' '}• AISHE: <code className="text-slate-700 font-mono font-semibold">{org.aishe_code}</code>
                                          </span>
                                        )}
                                      </div>
                                    </div>

                                    {/* Location & Contact Meta */}
                                    <div className="space-y-1 text-xs text-slate-600 border-t border-slate-100 pt-1.5">
                                      <div className="flex items-center gap-1.5 text-slate-700">
                                        <Icon.MapPin className="h-3 w-3 text-slate-400 shrink-0" />
                                        <span className="truncate">{org.city ? `${org.city}, ${org.state}` : org.state || '—'}</span>
                                      </div>
                                      {org.head_name && (
                                        <div className="flex items-center gap-1.5 text-slate-600">
                                          <Icon.User className="h-3 w-3 text-slate-400 shrink-0" />
                                          <span className="truncate text-slate-700">{org.head_name}</span>
                                        </div>
                                      )}
                                      {org.head_email && (
                                        <div className="flex items-center gap-1.5 text-slate-600">
                                          <Icon.Mail className="h-3 w-3 text-slate-400 shrink-0" />
                                          <span className="truncate font-mono text-[11px] text-slate-600" title={org.head_email}>
                                            {org.head_email}
                                          </span>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              </td>

                              {/* Requested Pending Exams (Rendered ONLY when in 'All Institutes' view) */}
                              {selectedExamId === 'all' && (
                                <td className="px-5 py-4 align-top">
                                  <div className="space-y-2 max-w-md">
                                    {org.pending_exams.map((e) => (
                                      <div
                                        key={e.exam_id}
                                        className="p-2.5 rounded-xl bg-amber-50/70 border border-amber-200 text-xs shadow-2xs"
                                      >
                                        <div className="flex items-center gap-1.5 font-bold text-slate-900 font-mono">
                                          <Icon.Clock className="h-3.5 w-3.5 text-amber-600 shrink-0" />
                                          <span>{e.exam_code} — {e.exam_name}</span>
                                        </div>
                                        {e.verification_from && (
                                          <div className="text-[11px] text-amber-900 font-medium pl-5 mt-0.5">
                                            📅 Window: {dateRange(e.verification_from, e.verification_to)}
                                          </div>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                </td>
                              )}

                              {/* Institutional Action (Blanket Approve on top, Approve/Reject stacked vertically below) */}
                              <td className="px-5 py-4 align-top text-right whitespace-nowrap">
                                <div className="flex flex-col items-end gap-2.5">
                                  {/* Blanket Approve Button */}
                                  <Button
                                    size="xs"
                                    disabled={portalOff || isBlanket}
                                    onClick={() => openBlanketApprove(org)}
                                    className="!bg-slate-900 hover:!bg-slate-800 !text-white text-xs font-semibold !py-1.5 !px-3 shadow-2xs w-36 justify-center"
                                    title="Authorizes this university for ALL present and future exams under your board"
                                  >
                                    {isBlanket ? 'Blanket Approved' : 'Blanket Approve'}
                                  </Button>

                                  {/* Per-Exam Action Buttons (Stacked Vertically below Blanket Approve) */}
                                  <div className="space-y-2 w-36">
                                    {org.pending_exams.map((e) => (
                                      <div key={e.exam_id} className="flex flex-col gap-1.5 border-t border-slate-100 pt-1.5">
                                        {selectedExamId === 'all' && (
                                          <span className="text-[10px] font-mono font-bold text-slate-500 text-center truncate" title={e.exam_code}>
                                            {e.exam_code}
                                          </span>
                                        )}
                                        <Button
                                          size="xs"
                                          disabled={portalOff}
                                          onClick={() => openSingleExamApprove(org, e)}
                                          className="!bg-emerald-600 hover:!bg-emerald-700 !text-white text-xs font-semibold !py-1 !px-2.5 w-full justify-center shadow-2xs"
                                          title={`Approve subscription for ${e.exam_code}`}
                                        >
                                          <Icon.Check className="h-3 w-3 mr-1" />
                                          Approve
                                        </Button>
                                        <Button
                                          size="xs"
                                          variant="secondary"
                                          disabled={portalOff}
                                          onClick={() => openSingleExamReject(org, e)}
                                          className="!text-rose-700 !border-rose-200 hover:!bg-rose-50 text-xs font-medium !py-1 !px-2.5 w-full justify-center"
                                          title={`Reject ${e.exam_code}`}
                                        >
                                          <Icon.X className="h-3 w-3 mr-1" />
                                          Reject
                                        </Button>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              </td>
                            </motion.tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : /* ========================================================================= */
                  /* 2. SUB-VIEW: APPROVED DIRECTORY (PAGINATED TABLE + POP-UP MODAL)           */
                  /* ========================================================================= */
                  subStatus === 'approved' ? (
                    <div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-slate-50/90 sticky top-0 z-10 border-b border-slate-200">
                            <tr className="text-left text-xs uppercase tracking-wider text-slate-500">
                              <th className="px-5 py-3.5 font-bold text-slate-700">Institution Details</th>
                              <th className="px-5 py-3.5 font-bold text-slate-700">Location</th>
                              <th className="px-5 py-3.5 font-bold text-slate-700">Head of Institution</th>
                              <th className="px-5 py-3.5 font-bold text-slate-700">Approved Subscriptions</th>
                              <th className="px-5 py-3.5 text-right font-bold text-slate-700">Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {paginatedApprovedInstitutions.map((org) => {
                              const isBlanket = org.client_blanket_approved
                              const approvedList = org.approved_exams || []

                              return (
                                <tr
                                  key={org.org_id}
                                  onClick={() => setSelectedUniversityForDetails(org)}
                                  className="border-b border-slate-100 last:border-none hover:bg-emerald-50/40 cursor-pointer transition-colors group"
                                >
                                  {/* Institution Details */}
                                  <td className="px-5 py-4 align-middle max-w-[280px]">
                                    <div className="flex items-center gap-3">
                                      <span className="h-10 w-10 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-900 flex items-center justify-center font-bold text-sm shrink-0 shadow-2xs group-hover:scale-105 transition-transform">
                                        {(org.org_name || '?').slice(0, 1).toUpperCase()}
                                      </span>
                                      <div className="min-w-0 flex-1">
                                        <div className="font-bold text-slate-900 text-sm leading-snug group-hover:text-emerald-900 transition-colors">
                                          {org.org_name}
                                        </div>
                                        <div className="text-[11px] text-slate-500 font-medium capitalize mt-0.5 flex items-center gap-1.5 flex-wrap">
                                          <span>{org.institution_type || 'University'}</span>
                                          {org.aishe_code && (
                                            <span className="text-slate-400">
                                              • AISHE: <code className="text-slate-700 font-mono font-semibold">{org.aishe_code}</code>
                                            </span>
                                          )}
                                        </div>
                                      </div>
                                    </div>
                                  </td>

                                  {/* Location */}
                                  <td className="px-5 py-4 align-middle text-xs text-slate-700">
                                    <div className="flex items-center gap-1.5">
                                      <Icon.MapPin className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                                      <span>{org.city ? `${org.city}, ${org.state}` : org.state || '—'}</span>
                                    </div>
                                  </td>

                                  {/* Head of Institution */}
                                  <td className="px-5 py-4 align-middle text-xs text-slate-700">
                                    <div className="font-semibold text-slate-900">{org.head_name || '—'}</div>
                                    {org.head_email && (
                                      <div className="font-mono text-[11px] text-slate-500 truncate max-w-xs">{org.head_email}</div>
                                    )}
                                  </td>

                                  {/* Approved Subscriptions */}
                                  <td className="px-5 py-4 align-middle">
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                      {isBlanket && (
                                        <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-sky-100 text-sky-800 ring-1 ring-sky-300">
                                          Blanket Authorized
                                        </span>
                                      )}
                                      {approvedList.map((e) => (
                                        <span
                                          key={e.exam_id}
                                          className="px-2 py-0.5 rounded-lg text-xs font-mono font-semibold bg-emerald-100 text-emerald-800"
                                          title={e.exam_name}
                                        >
                                          {e.exam_code}
                                        </span>
                                      ))}
                                    </div>
                                  </td>

                                  {/* Action */}
                                  <td className="px-5 py-4 align-middle text-right whitespace-nowrap">
                                    <Button
                                      size="xs"
                                      variant="secondary"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        setSelectedUniversityForDetails(org)
                                      }}
                                      className="text-xs font-semibold hover:!bg-emerald-600 hover:!text-white hover:!border-emerald-600 transition-all shadow-2xs"
                                    >
                                      <Icon.Eye className="h-3.5 w-3.5 mr-1" />
                                      Inspect Details
                                    </Button>
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>

                      {/* Approved Table Pagination Controls */}
                      {filteredInstitutions.length > 0 && (
                        <div className="p-4 border-t border-slate-200 bg-slate-50/60 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-600">
                          <div className="flex items-center gap-2">
                            <span>
                              Showing{' '}
                              <strong>{(currentApprovedPage - 1) * approvedPageSize + 1}</strong>{' '}
                              to{' '}
                              <strong>{Math.min(currentApprovedPage * approvedPageSize, filteredInstitutions.length)}</strong>{' '}
                              of <strong>{filteredInstitutions.length}</strong> approved institutions
                            </span>

                            <select
                              value={approvedPageSize}
                              onChange={(e) => {
                                setApprovedPageSize(Number(e.target.value))
                                setApprovedPage(1)
                              }}
                              className="ml-2 text-xs rounded-lg border border-slate-300 bg-white px-2 py-1 text-slate-700 font-medium focus:outline-hidden focus:ring-1 focus:ring-slate-900"
                            >
                              <option value={5}>5 per page</option>
                              <option value={10}>10 per page</option>
                              <option value={20}>20 per page</option>
                            </select>
                          </div>

                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={currentApprovedPage <= 1}
                              onClick={() => setApprovedPage((p) => Math.max(1, p - 1))}
                              className="px-2.5 py-1 rounded-lg border border-slate-300 bg-white text-slate-700 font-medium hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                            >
                              Previous
                            </button>

                            <div className="flex items-center gap-1">
                              {Array.from({ length: totalApprovedPages }).map((_, idx) => {
                                const pageNum = idx + 1
                                return (
                                  <button
                                    key={pageNum}
                                    type="button"
                                    onClick={() => setApprovedPage(pageNum)}
                                    className={`min-w-[28px] h-7 px-2 rounded-lg text-xs font-bold transition-all ${
                                      currentApprovedPage === pageNum
                                        ? 'bg-slate-900 text-white shadow-2xs'
                                        : 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-100'
                                    }`}
                                  >
                                    {pageNum}
                                  </button>
                                )
                              })}
                            </div>

                            <button
                              type="button"
                              disabled={currentApprovedPage >= totalApprovedPages}
                              onClick={() => setApprovedPage((p) => Math.min(totalApprovedPages, p + 1))}
                              className="px-2.5 py-1 rounded-lg border border-slate-300 bg-white text-slate-700 font-medium hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                            >
                              Next
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : /* ========================================================================= */
                    /* 3. SUB-VIEW: REJECTED SUBSCRIPTIONS                                       */
                    /* ========================================================================= */
                    subStatus === 'rejected' ? (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-slate-50/90 sticky top-0 z-10 border-b border-slate-200">
                            <tr className="text-left text-xs uppercase tracking-wider text-slate-500">
                              <th className="px-5 py-3.5 font-bold text-slate-700">University Details</th>
                              <th className="px-5 py-3.5 font-bold text-slate-700">Rejected Exam</th>
                              <th className="px-5 py-3.5 font-bold text-slate-700">Rejection Reason & Date</th>
                              <th className="px-5 py-3.5 text-right font-bold text-slate-700">Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredInstitutions.map((org) => (
                              <tr key={org.org_id} className="border-b border-slate-100 hover:bg-slate-50/50">
                                {/* University Details */}
                                <td className="px-5 py-4 align-top">
                                  <div className="font-bold text-slate-900">{org.org_name}</div>
                                  <div className="text-xs text-slate-500 mt-0.5">
                                    {org.institution_type || 'University'} • {org.city ? `${org.city}, ${org.state}` : org.state}
                                  </div>
                                </td>

                                {/* Rejected Exam Info */}
                                <td className="px-5 py-4 align-top">
                                  <div className="space-y-1">
                                    {org.rejected_exams.map((e) => (
                                      <div key={e.exam_id} className="font-mono text-xs font-bold text-rose-900">
                                        {e.exam_code} — {e.exam_name}
                                      </div>
                                    ))}
                                  </div>
                                </td>

                                {/* Rejection Reason */}
                                <td className="px-5 py-4 align-top">
                                  <div className="space-y-1">
                                    {org.rejected_exams.map((e) => (
                                      <div key={e.exam_id} className="text-xs text-slate-700 bg-rose-50 border border-rose-200 p-2 rounded-lg">
                                        <p className="italic">"{e.review_note || 'No rejection note specified.'}"</p>
                                        {e.reviewed_at && (
                                          <p className="text-[10px] text-slate-400 mt-1">
                                            Rejected on {new Date(e.reviewed_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                                          </p>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                </td>

                                {/* Move to Pending Action Button */}
                                <td className="px-5 py-4 align-top text-right">
                                  {org.rejected_exams.map((e) => (
                                    <Button
                                      key={e.exam_id}
                                      size="xs"
                                      disabled={portalOff}
                                      onClick={() => handleResetToPending(org.org_id, e.exam_id)}
                                      className="!bg-amber-600 hover:!bg-amber-700 !text-white text-xs font-semibold shadow-2xs"
                                      title={`Move ${e.exam_code} request back to Pending queue`}
                                    >
                                      <Icon.Clock className="h-3 w-3 mr-1" />
                                      Move to Pending
                                    </Button>
                                  ))}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      /* ========================================================================= */
                      /* 4. SUB-VIEW: ALL UNIVERSITIES CONSOLIDATED                                 */
                      /* ========================================================================= */
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-slate-50/90 sticky top-0 z-10 border-b border-slate-200">
                            <tr className="text-left text-xs uppercase tracking-wider text-slate-500">
                              <th className="px-5 py-3.5 font-bold text-slate-700">University Details</th>
                              <th className="px-5 py-3.5 font-bold text-slate-700">Exam Subscriptions & Status</th>
                              <th className="px-5 py-3.5 text-right font-bold text-slate-700">Details</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredInstitutions.map((org) => (
                              <tr key={org.org_id} className="border-b border-slate-100 hover:bg-slate-50/50">
                                {/* University Details */}
                                <td className="px-5 py-4 align-top max-w-[280px]">
                                  <div className="font-bold text-slate-900">{org.org_name}</div>
                                  <div className="text-xs text-slate-500 mt-0.5">
                                    {org.institution_type || 'University'} {org.aishe_code && `• AISHE: ${org.aishe_code}`}
                                  </div>
                                  <div className="text-xs text-slate-600 mt-1">
                                    {org.city ? `${org.city}, ${org.state}` : org.state}
                                  </div>
                                </td>

                                {/* Exam Status Chips */}
                                <td className="px-5 py-4 align-top">
                                  <div className="flex flex-wrap gap-2">
                                    {org.all_exams.map((e) => (
                                      <span
                                        key={e.exam_id}
                                        className={`px-2.5 py-1 rounded-lg text-xs font-mono font-medium flex items-center gap-1.5 ${e.status === 'approved' ? 'bg-emerald-100 text-emerald-800' :
                                            e.status === 'pending' ? 'bg-amber-100 text-amber-800 ring-1 ring-amber-300' :
                                              'bg-rose-100 text-rose-800'
                                          }`}
                                      >
                                        <span className="font-bold">{e.exam_code}</span>
                                        <span className="capitalize text-[11px] opacity-80">({e.status})</span>
                                      </span>
                                    ))}
                                  </div>
                                </td>

                                {/* View Details Button */}
                                <td className="px-5 py-4 align-top text-right">
                                  <Button
                                    size="xs"
                                    variant="secondary"
                                    onClick={() => setSelectedUniversityForDetails(org)}
                                    className="text-xs font-medium"
                                  >
                                    <Icon.Eye className="h-3 w-3 mr-1" />
                                    Inspect
                                  </Button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )
              )}
            </Card>
          </div>
        )}
      </FadeIn>

      {/* ========================================================================= */}
      {/* POP-UP MODAL: UNIVERSITY DETAILS INSPECTOR                                 */}
      {/* ========================================================================= */}
      <AnimatePresence>
        {selectedUniversityForDetails && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelectedUniversityForDetails(null)}
              className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs"
            />

            {/* Modal Card */}
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="relative w-full max-w-2xl rounded-2xl bg-white shadow-2xl overflow-hidden z-10 max-h-[90vh] flex flex-col"
            >
              {/* Modal Header */}
              <div className="p-6 bg-slate-900 text-white flex items-start justify-between gap-4">
                <div className="flex items-start gap-3.5">
                  <span className="h-12 w-12 rounded-xl bg-white/10 text-white flex items-center justify-center font-bold text-lg border border-white/20">
                    {(selectedUniversityForDetails.org_name || '?').slice(0, 1).toUpperCase()}
                  </span>
                  <div>
                    <h3 className="text-lg font-bold text-white leading-snug">
                      {selectedUniversityForDetails.org_name}
                    </h3>
                    <p className="text-xs text-slate-300 capitalize mt-0.5">
                      {selectedUniversityForDetails.institution_type || 'University'} • {selectedUniversityForDetails.city}, {selectedUniversityForDetails.state}
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setSelectedUniversityForDetails(null)}
                  className="rounded-lg p-1.5 text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
                >
                  <Icon.X className="h-5 w-5" />
                </button>
              </div>

              {/* Modal Body */}
              <div className="p-6 overflow-y-auto space-y-6 text-sm">
                {/* Section 1: Institutional Identifiers */}
                <div>
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3 flex items-center gap-1.5">
                    <Icon.Building className="h-3.5 w-3.5 text-slate-400" />
                    Institutional Profile & Regulatory Identifiers
                  </h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="p-3 rounded-xl bg-slate-50 border border-slate-200">
                      <span className="text-xs text-slate-500 font-medium block">AISHE Code:</span>
                      <div className="flex items-center justify-between gap-2 mt-0.5">
                        <code className="text-sm font-bold text-slate-900 font-mono">
                          {selectedUniversityForDetails.aishe_code || 'Not Registered'}
                        </code>
                        {selectedUniversityForDetails.aishe_code && (
                          <button
                            type="button"
                            onClick={() => copyToClipboard(selectedUniversityForDetails.aishe_code, 'aishe')}
                            className="text-xs text-slate-500 hover:text-slate-800"
                            title="Copy AISHE"
                          >
                            {copiedKey === 'aishe' ? <Icon.Check className="h-3.5 w-3.5 text-emerald-600" /> : <Icon.Copy className="h-3.5 w-3.5" />}
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="p-3 rounded-xl bg-slate-50 border border-slate-200">
                      <span className="text-xs text-slate-500 font-medium block">Institution Type:</span>
                      <span className="text-sm font-semibold text-slate-900 capitalize mt-0.5 block">
                        {selectedUniversityForDetails.institution_type || 'University'}
                      </span>
                    </div>

                    <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 sm:col-span-2">
                      <span className="text-xs text-slate-500 font-medium block">Registered Campus Location:</span>
                      <span className="text-sm text-slate-800 font-medium mt-0.5 block">
                        {selectedUniversityForDetails.city ? `${selectedUniversityForDetails.city}, ${selectedUniversityForDetails.state}` : selectedUniversityForDetails.state || '—'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Section 2: Leadership & Official Contact */}
                <div>
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3 flex items-center gap-1.5">
                    <Icon.User className="h-3.5 w-3.5 text-slate-400" />
                    Head of Institution / Authorized Signatory
                  </h4>
                  <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="font-bold text-slate-900 text-sm">
                          {selectedUniversityForDetails.head_name || 'Authorized Representative'}
                        </div>
                        <div className="text-xs text-slate-500">Vice Chancellor / Registrar / Principal</div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-slate-200/80">
                      <div>
                        <span className="text-xs text-slate-500 font-medium block">Official Email:</span>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-xs font-mono text-slate-800 truncate" title={selectedUniversityForDetails.head_email}>
                            {selectedUniversityForDetails.head_email || '—'}
                          </span>
                          {selectedUniversityForDetails.head_email && (
                            <button
                              type="button"
                              onClick={() => copyToClipboard(selectedUniversityForDetails.head_email, 'email')}
                              className="text-xs text-slate-400 hover:text-slate-700 shrink-0"
                              title="Copy Email"
                            >
                              {copiedKey === 'email' ? <Icon.Check className="h-3 w-3 text-emerald-600" /> : <Icon.Copy className="h-3 w-3" />}
                            </button>
                          )}
                        </div>
                      </div>

                      <div>
                        <span className="text-xs text-slate-500 font-medium block">Contact Number:</span>
                        <span className="text-xs font-mono text-slate-800 mt-0.5 block">
                          {selectedUniversityForDetails.head_mobile || '+91 ••••• •••••'}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Section 3: Exam Subscriptions & Authorization Status */}
                <div>
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3 flex items-center gap-1.5">
                    <Icon.CheckCircle className="h-3.5 w-3.5 text-emerald-600" />
                    Exam Subscriptions & Authorization Scope
                  </h4>
                  <div className="space-y-2">
                    {selectedUniversityForDetails.all_exams?.map((e) => (
                      <div
                        key={e.exam_id}
                        className="p-3 rounded-xl border flex items-center justify-between gap-3 text-xs bg-slate-50 border-slate-200"
                      >
                        <div>
                          <div className="font-bold text-slate-900 font-mono">
                            {e.exam_code} — {e.exam_name}
                          </div>
                          {e.verification_from && (
                            <div className="text-[11px] text-slate-500 mt-0.5">
                              📅 Window: {dateRange(e.verification_from, e.verification_to)}
                            </div>
                          )}
                        </div>

                        <span className={`px-2.5 py-1 rounded-full text-xs font-bold capitalize ${e.status === 'approved' ? 'bg-emerald-100 text-emerald-800' :
                            e.status === 'pending' ? 'bg-amber-100 text-amber-800' :
                              'bg-rose-100 text-rose-800'
                          }`}>
                          {e.status}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Modal Footer */}
              <div className="p-4 bg-slate-50 border-t border-slate-200 flex items-center justify-end">
                <Button
                  size="sm"
                  onClick={() => setSelectedUniversityForDetails(null)}
                  className="!bg-slate-900 !text-white text-xs font-semibold"
                >
                  Close Window
                </Button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ========================================================================= */}
      {/* ACTION CONFIRMATION MODALS (SINGLE / BULK / BLANKET)                      */}
      {/* ========================================================================= */}
      <AnimatePresence>
        {modalState && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => { if (!actionBusy) setModalState(null) }}
              className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl z-10"
            >
              <h3 className="text-lg font-bold text-slate-900 mb-2">
                {modalState.type === 'single_approve' && `Approve Subscription: ${modalState.exam.exam_code}`}
                {modalState.type === 'single_reject' && `Reject Subscription: ${modalState.exam.exam_code}`}
                {modalState.type === 'blanket_approve' && `Grant Blanket Authorization`}
                {modalState.type === 'bulk_approve' && `Approve ${modalState.orgIds.length} Institutions`}
                {modalState.type === 'bulk_reject' && `Reject ${modalState.orgIds.length} Institutions`}
              </h3>

              <div className="text-sm text-slate-600 space-y-2 mb-4">
                {modalState.type === 'single_approve' && (
                  <p>
                    You are approving <strong>{modalState.org.org_name}</strong> for <strong>{modalState.exam.exam_code}</strong> only.
                  </p>
                )}
                {modalState.type === 'single_reject' && (
                  <p>
                    Reject subscription request for <strong>{modalState.org.org_name}</strong> on <strong>{modalState.exam.exam_code}</strong>.
                  </p>
                )}
                {modalState.type === 'blanket_approve' && (
                  <p>
                    Grant <strong>Blanket Authorization</strong> to <strong>{modalState.org.org_name}</strong>. This will authorize this institution for <strong>ALL</strong> current and future exams under your board.
                  </p>
                )}
                {modalState.type === 'bulk_approve' && (
                  <p>
                    Approve pending subscription requests for all <strong>{modalState.orgIds.length}</strong> selected institutions.
                  </p>
                )}
                {modalState.type === 'bulk_reject' && (
                  <p>
                    Reject pending subscription requests for all <strong>{modalState.orgIds.length}</strong> selected institutions.
                  </p>
                )}
              </div>

              {/* Note / Reason Field */}
              <div className="mb-4">
                <Label className="text-xs font-semibold text-slate-700 block mb-1">
                  {modalState.type.includes('reject') ? 'Reason for Rejection (Required):' : 'Reviewer Note (Optional):'}
                </Label>
                <textarea
                  value={actionNote}
                  onChange={(e) => setActionNote(e.target.value)}
                  placeholder={
                    modalState.type.includes('reject')
                      ? 'e.g. Incomplete verification infrastructure or out of scope'
                      : 'e.g. Approved based on annual accreditation review'
                  }
                  rows={3}
                  className="w-full text-xs rounded-xl border border-slate-300 p-2.5 text-slate-900 focus:outline-hidden focus:ring-2 focus:ring-slate-900"
                />
              </div>

              {actionErr && (
                <div className="mb-4 text-xs text-rose-700 bg-rose-50 border border-rose-200 p-2.5 rounded-lg">
                  {actionErr}
                </div>
              )}

              <div className="flex items-center justify-end gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={actionBusy}
                  onClick={() => setModalState(null)}
                >
                  Cancel
                </Button>

                <Button
                  size="sm"
                  disabled={actionBusy}
                  onClick={handleActionSubmit}
                  className={`text-xs font-semibold !text-white ${modalState.type.includes('reject') ? '!bg-rose-600 hover:!bg-rose-700' : '!bg-emerald-600 hover:!bg-emerald-700'
                    }`}
                >
                  {actionBusy ? 'Processing…' : 'Confirm & Proceed'}
                </Button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </ReviewerShell>
  )
}
