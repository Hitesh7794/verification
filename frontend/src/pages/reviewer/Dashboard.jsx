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
  revokeSubscription,
  downloadApprovedSubscriptionsCsv,
  bulkDecideSubscriptionsCsv,
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

  // Pending Requests Table Pagination State
  const [pendingPage, setPendingPage] = useState(1)
  const [pendingPageSize, setPendingPageSize] = useState(10)

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

  // Pending Institutions Pagination Calculation
  const totalPendingPages = Math.max(1, Math.ceil(filteredInstitutions.length / pendingPageSize))
  const currentPendingPage = Math.min(pendingPage, totalPendingPages)

  const paginatedPendingInstitutions = useMemo(() => {
    const start = (currentPendingPage - 1) * pendingPageSize
    return filteredInstitutions.slice(start, start + pendingPageSize)
  }, [filteredInstitutions, currentPendingPage, pendingPageSize])

  // Selection Helpers for Pending tab (current page visible orgs)
  const visibleOrgIds = useMemo(() => paginatedPendingInstitutions.map((i) => i.org_id), [paginatedPendingInstitutions])
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
          <div className="flex items-center gap-2">
            <BulkCsvUploadButton onDone={() => { setSubLoading(true); loadSubscriptions() }} />
            <ExportCsvButton />
            <RefreshButton onClick={loadSubscriptions} />
          </div>
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
                    label="Registered Candidates"
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
                        <tr>
                          <th className="px-5 py-3.5 w-32 text-center">Exam Code</th>
                          <th className="px-5 py-3.5 min-w-[240px] text-left">Exam Name</th>
                          <th className="px-5 py-3.5 text-center">Verification Window</th>
                          <th className="px-4 py-3.5 text-center">Candidates</th>
                          <th className="px-4 py-3.5 text-center">Pending</th>
                          <th className="px-4 py-3.5 text-center">Approved</th>
                          <th className="px-4 py-3.5 text-center">Rejected</th>
                          <th className="px-5 py-3.5 text-center">Action</th>
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
                              <td className="px-5 py-4 align-middle text-center">
                                <span className="font-mono font-bold text-xs text-slate-900 tracking-tight">
                                  {exam.exam_code}
                                </span>
                              </td>

                              {/* Exam Name */}
                              <td className="px-5 py-4 align-middle text-left">
                                <div className="font-semibold text-slate-900 text-xs leading-snug truncate max-w-sm" title={exam.name}>
                                  {exam.name}
                                </div>
                              </td>

                              {/* Verification Window (Start on line 1, End on line 2, No calendar icon) */}
                              <td className="px-5 py-4 align-middle text-center">
                                {exam.verification_from ? (
                                  <div className="flex flex-col items-center gap-0.5 text-[11px] font-mono leading-tight whitespace-nowrap">
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
                              <td className="px-5 py-4 align-middle text-center whitespace-nowrap">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setSelectedExamId(exam.id)
                                    setSelectedOrgIds(new Set())
                                  }}
                                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white border border-slate-300 text-slate-700 hover:bg-slate-900 hover:text-white hover:border-slate-900 transition-all shadow-2xs inline-flex items-center justify-center gap-1"
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
                        Window: {dateRange(currentExam.verification_from, currentExam.verification_to)} • {currentExam.candidate_count || 0} Candidates
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
                    {/* Tab 1: All Universities */}
                    <button
                      type="button"
                      onClick={() => {
                        setSubStatus('all')
                        setPendingPage(1)
                        setApprovedPage(1)
                        setSelectedOrgIds(new Set())
                      }}
                      className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold whitespace-nowrap transition-all ${
                        subStatus === 'all'
                          ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200'
                          : 'text-slate-600 hover:text-slate-900 hover:bg-white/50'
                      }`}
                    >
                      <span>All Universities</span>
                      <span className={`inline-flex items-center justify-center rounded-full px-2 py-0.5 text-xs font-bold tabular-nums ${
                        subStatus === 'all' ? 'bg-slate-900 text-white' : 'bg-slate-200 text-slate-700'
                      }`}>
                        {activeTabCounts.total}
                      </span>
                    </button>

                    {/* Tab 2: Pending Requests */}
                    <button
                      type="button"
                      onClick={() => {
                        setSubStatus('pending')
                        setPendingPage(1)
                        setApprovedPage(1)
                        setSelectedOrgIds(new Set())
                      }}
                      className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold whitespace-nowrap transition-all ${
                        subStatus === 'pending'
                          ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200'
                          : 'text-slate-600 hover:text-slate-900 hover:bg-white/50'
                      }`}
                    >
                      <span>Pending Requests</span>
                      <span className={`inline-flex items-center justify-center rounded-full px-2 py-0.5 text-xs font-bold tabular-nums ${
                        subStatus === 'pending' ? 'bg-amber-100 text-amber-800 ring-1 ring-amber-300' : 'bg-slate-200 text-slate-700'
                      }`}>
                        {activeTabCounts.pending}
                      </span>
                    </button>

                    {/* Tab 3: Approved */}
                    <button
                      type="button"
                      onClick={() => {
                        setSubStatus('approved')
                        setPendingPage(1)
                        setApprovedPage(1)
                        setSelectedOrgIds(new Set())
                      }}
                      className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold whitespace-nowrap transition-all ${
                        subStatus === 'approved'
                          ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200'
                          : 'text-slate-600 hover:text-slate-900 hover:bg-white/50'
                      }`}
                    >
                      <span>Approved Subscriptions</span>
                      <span className={`inline-flex items-center justify-center rounded-full px-2 py-0.5 text-xs font-bold tabular-nums ${
                        subStatus === 'approved' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-700'
                      }`}>
                        {activeTabCounts.approved}
                      </span>
                    </button>

                    {/* Tab 4: Rejected */}
                    <button
                      type="button"
                      onClick={() => {
                        setSubStatus('rejected')
                        setPendingPage(1)
                        setApprovedPage(1)
                        setSelectedOrgIds(new Set())
                      }}
                      className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold whitespace-nowrap transition-all ${
                        subStatus === 'rejected'
                          ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200'
                          : 'text-slate-600 hover:text-slate-900 hover:bg-white/50'
                      }`}
                    >
                      <span>Rejected</span>
                      <span className={`inline-flex items-center justify-center rounded-full px-2 py-0.5 text-xs font-bold tabular-nums ${
                        subStatus === 'rejected' ? 'bg-rose-100 text-rose-800' : 'bg-slate-200 text-slate-700'
                      }`}>
                        {activeTabCounts.rejected}
                      </span>
                    </button>
                  </div>

                  {/* Instant Search Bar */}
                  <div className="relative w-full md:w-80">
                    <Icon.Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => {
                        setSearchQuery(e.target.value)
                        setPendingPage(1)
                        setApprovedPage(1)
                      }}
                      placeholder="Search university, AISHE, city, email..."
                      className="w-full pl-9 pr-8 py-2 text-xs rounded-xl border border-slate-300 bg-slate-50/50 text-slate-900 placeholder:text-slate-400 focus:outline-hidden focus:ring-2 focus:ring-slate-900 focus:bg-white transition-all"
                    />
                    {searchQuery && (
                      <button
                        type="button"
                        onClick={() => {
                          setSearchQuery('')
                          setPendingPage(1)
                          setApprovedPage(1)
                        }}
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
                    {currentExam?.verification_from ? (
                      <span>Active Verification Window: <strong className="text-slate-700 font-medium">{dateRange(currentExam.verification_from, currentExam.verification_to)}</strong></span>
                    ) : (
                      <span>Review and manage institution subscription requests</span>
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
                  <div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50/90 sticky top-0 z-10 border-b border-slate-200">
                          <tr className="text-xs uppercase tracking-wider text-slate-500">
                            <th className="px-4 py-3.5 w-12 text-center">
                              <input
                                type="checkbox"
                                checked={isAllSelected}
                                ref={(el) => {
                                  if (el) el.indeterminate = isSomeSelected
                                }}
                                onChange={toggleSelectAll}
                                className="h-4 w-4 rounded border-slate-300 text-amber-600 focus:ring-amber-500 cursor-pointer"
                                title="Select all on this page"
                              />
                            </th>
                            <th className="px-6 py-3.5 text-left font-bold text-slate-700">University Details</th>
                            <th className="px-6 py-3.5 text-center font-bold text-slate-700 whitespace-nowrap w-[340px]">Institutional Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {paginatedPendingInstitutions.map((org, i) => {
                            const isSelected = selectedOrgIds.has(org.org_id)
                            const isBlanket = org.client_blanket_approved
                            const pendingExams = org.pending_exams || []
                            const targetExam = (pendingExams && pendingExams[0]) || currentExam

                            return (
                              <motion.tr
                                key={org.org_id}
                                initial={{ opacity: 0, y: 4 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ duration: 0.15, delay: Math.min(i * 0.02, 0.2) }}
                                className={`border-b border-slate-100 last:border-none transition-colors ${
                                  isSelected ? 'bg-amber-50/60' : 'hover:bg-slate-50/70'
                                }`}
                              >
                                {/* Row Checkbox */}
                                <td className="px-4 py-4 text-center align-middle">
                                  <input
                                    type="checkbox"
                                    checked={isSelected}
                                    onChange={() => toggleSelectOrg(org.org_id)}
                                    className="h-4 w-4 rounded border-slate-300 text-amber-600 focus:ring-amber-500 cursor-pointer"
                                  />
                                </td>

                                {/* University Details */}
                                <td className="px-6 py-4 align-middle text-left">
                                  <div
                                    onClick={() => setSelectedUniversityForDetails(org)}
                                    className="flex items-center gap-3 cursor-pointer group"
                                    title="Click to view institution profile & contact details"
                                  >
                                    <span className="h-10 w-10 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 flex items-center justify-center font-bold text-sm shrink-0 shadow-2xs group-hover:scale-105 transition-transform">
                                      {(org.org_name || '?').slice(0, 1).toUpperCase()}
                                    </span>
                                    <div className="min-w-0 flex-1">
                                      <div className="font-bold text-slate-900 text-sm leading-snug group-hover:text-amber-950 transition-colors">
                                        {org.org_name}
                                      </div>
                                      <div className="text-[11px] text-slate-500 font-medium capitalize mt-0.5 flex items-center gap-1.5 flex-wrap">
                                        <span>{org.institution_type || 'University'}</span>
                                        {org.aishe_code && (
                                          <span className="text-slate-400">
                                            • AISHE: <code className="text-slate-700 font-mono font-semibold">{org.aishe_code}</code>
                                          </span>
                                        )}
                                        {(org.city || org.state) && (
                                          <span className="text-slate-400">
                                            • {org.city ? `${org.city}, ${org.state}` : org.state}
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                </td>

                                {/* Institutional Action: Centered Horizontal Buttons matching Header */}
                                <td className="px-6 py-4 align-middle text-center whitespace-nowrap w-[340px]">
                                  <div className="flex items-center justify-center gap-2">
                                    {/* Approve Button */}
                                    <button
                                      type="button"
                                      disabled={portalOff}
                                      onClick={() => {
                                        if (targetExam) openSingleExamApprove(org, targetExam)
                                      }}
                                      className="h-8 px-3.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white shadow-2xs inline-flex items-center justify-center transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                      <span>Approve</span>
                                    </button>

                                    {/* Reject Button */}
                                    <button
                                      type="button"
                                      disabled={portalOff}
                                      onClick={() => {
                                        if (targetExam) openSingleExamReject(org, targetExam)
                                      }}
                                      className="h-8 px-3.5 rounded-lg text-xs font-semibold bg-rose-50 border border-rose-200 text-rose-700 hover:bg-rose-100 hover:border-rose-300 inline-flex items-center justify-center transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                      <span>Reject</span>
                                    </button>

                                    {/* Blanket Action Badge / Button */}
                                    {isBlanket ? (
                                      <span className="h-8 px-3.5 rounded-lg text-xs font-semibold bg-emerald-50 border border-emerald-200 text-emerald-800 inline-flex items-center justify-center">
                                        <span>Blanket Approved</span>
                                      </span>
                                    ) : (
                                      <button
                                        type="button"
                                        disabled={portalOff}
                                        onClick={() => openBlanketApprove(org)}
                                        className="h-8 px-3.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white shadow-2xs inline-flex items-center justify-center transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                                        title="Authorizes this university for ALL present and future exams under your board"
                                      >
                                        <span>Blanket Approve</span>
                                      </button>
                                    )}
                                  </div>
                                </td>
                              </motion.tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>

                    {/* Pending Requests Pagination Controls */}
                    {filteredInstitutions.length > 0 && (
                      <div className="p-3.5 border-t border-slate-200 bg-slate-50/60 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-600">
                        <div className="flex items-center gap-2">
                          <span>
                            Showing{' '}
                            <strong>{(currentPendingPage - 1) * pendingPageSize + 1}</strong>{' '}
                            to{' '}
                            <strong>{Math.min(currentPendingPage * pendingPageSize, filteredInstitutions.length)}</strong>{' '}
                            of <strong>{filteredInstitutions.length}</strong> pending requests
                          </span>

                          <select
                            value={pendingPageSize}
                            onChange={(e) => {
                              setPendingPageSize(Number(e.target.value))
                              setPendingPage(1)
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
                            disabled={currentPendingPage <= 1}
                            onClick={() => setPendingPage((p) => Math.max(1, p - 1))}
                            className="px-2.5 py-1 rounded-lg border border-slate-300 bg-white text-slate-700 font-medium hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                          >
                            Previous
                          </button>

                          <div className="flex items-center gap-1">
                            {Array.from({ length: totalPendingPages }).map((_, idx) => {
                              const pageNum = idx + 1
                              return (
                                <button
                                  key={pageNum}
                                  type="button"
                                  onClick={() => setPendingPage(pageNum)}
                                  className={`min-w-[28px] h-7 px-2 rounded-lg text-xs font-bold transition-all ${
                                    currentPendingPage === pageNum
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
                            disabled={currentPendingPage >= totalPendingPages}
                            onClick={() => setPendingPage((p) => Math.min(totalPendingPages, p + 1))}
                            className="px-2.5 py-1 rounded-lg border border-slate-300 bg-white text-slate-700 font-medium hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                          >
                            Next
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ) : /* ========================================================================= */
                  /* 2. SUB-VIEW: APPROVED DIRECTORY (PAGINATED TABLE + POP-UP MODAL)           */
                  /* ========================================================================= */
                  subStatus === 'approved' ? (
                    <div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-slate-50/90 sticky top-0 z-10 border-b border-slate-200">
                            <tr className="text-xs uppercase tracking-wider text-slate-500">
                              <th className="px-5 py-3.5 text-left font-bold text-slate-700">Institution Details</th>
                              <th className="px-5 py-3.5 text-left font-bold text-slate-700">Location</th>
                              <th className="px-5 py-3.5 text-left font-bold text-slate-700">Head of Institution</th>
                              <th className="px-5 py-3.5 text-center font-bold text-slate-700">Approved Subscriptions</th>
                              <th className="px-5 py-3.5 text-center font-bold text-slate-700">Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {paginatedApprovedInstitutions.map((org) => {
                              const approvedList = org.approved_exams || []

                              return (
                                <tr
                                  key={org.org_id}
                                  onClick={() => setSelectedUniversityForDetails(org)}
                                  className="border-b border-slate-100 last:border-none hover:bg-emerald-50/40 cursor-pointer transition-colors group"
                                >
                                  {/* Institution Details */}
                                  <td className="px-5 py-4 align-middle text-left max-w-[280px]">
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
                                  <td className="px-5 py-4 align-middle text-left text-xs text-slate-700">
                                    <div className="flex items-center gap-1.5">
                                      <Icon.MapPin className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                                      <span>{org.city ? `${org.city}, ${org.state}` : org.state || '—'}</span>
                                    </div>
                                  </td>

                                  {/* Head of Institution */}
                                  <td className="px-5 py-4 align-middle text-left text-xs text-slate-700">
                                    <div className="font-semibold text-slate-900">{org.head_name || '—'}</div>
                                    {org.head_email && (
                                      <div className="font-mono text-[11px] text-slate-500 truncate max-w-xs">{org.head_email}</div>
                                    )}
                                  </td>

                                  {/* Approved Subscriptions */}
                                  <td className="px-5 py-4 align-middle text-center">
                                    <div className="flex items-center justify-center gap-1.5 flex-wrap">
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
                                  <td className="px-5 py-4 align-middle text-center whitespace-nowrap">
                                    <Button
                                      size="xs"
                                      variant="secondary"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        setSelectedUniversityForDetails(org)
                                      }}
                                      className="text-xs font-semibold hover:!bg-emerald-600 hover:!text-white hover:!border-emerald-600 transition-all shadow-2xs inline-flex items-center justify-center"
                                    >
                                      <Icon.Eye className="h-3.5 w-3.5 mr-1" />
                                      View Details
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
                            <tr className="text-xs uppercase tracking-wider text-slate-500">
                              <th className="px-5 py-3.5 text-left font-bold text-slate-700">University Details</th>
                              <th className="px-5 py-3.5 text-left font-bold text-slate-700">Rejected Exam</th>
                              <th className="px-5 py-3.5 text-left font-bold text-slate-700">Rejection Reason & Date</th>
                              <th className="px-5 py-3.5 text-center font-bold text-slate-700">Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredInstitutions.map((org) => (
                              <tr key={org.org_id} className="border-b border-slate-100 hover:bg-slate-50/50">
                                {/* University Details */}
                                <td className="px-5 py-4 align-top text-left">
                                  <div className="font-bold text-slate-900">{org.org_name}</div>
                                  <div className="text-xs text-slate-500 mt-0.5">
                                    {org.institution_type || 'University'} • {org.city ? `${org.city}, ${org.state}` : org.state}
                                  </div>
                                </td>

                                {/* Rejected Exam Info */}
                                <td className="px-5 py-4 align-top text-left">
                                  <div className="space-y-1">
                                    {org.rejected_exams.map((e) => (
                                      <div key={e.exam_id} className="font-mono text-xs font-bold text-rose-900">
                                        {e.exam_code} — {e.exam_name}
                                      </div>
                                    ))}
                                  </div>
                                </td>

                                {/* Rejection Reason */}
                                <td className="px-5 py-4 align-top text-left">
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
                                <td className="px-5 py-4 align-top text-center">
                                  {org.rejected_exams.map((e) => (
                                    <Button
                                      key={e.exam_id}
                                      size="xs"
                                      disabled={portalOff}
                                      onClick={() => handleResetToPending(org.org_id, e.exam_id)}
                                      className="!bg-amber-600 hover:!bg-amber-700 !text-white text-xs font-semibold shadow-2xs inline-flex items-center justify-center"
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
                            <tr className="text-xs uppercase tracking-wider text-slate-500">
                              <th className="px-5 py-3.5 text-left font-bold text-slate-700">University Details</th>
                              <th className="px-5 py-3.5 text-center font-bold text-slate-700">Exam Subscriptions & Status</th>
                              <th className="px-5 py-3.5 text-center font-bold text-slate-700">Details</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredInstitutions.map((org) => (
                              <tr key={org.org_id} className="border-b border-slate-100 hover:bg-slate-50/50">
                                {/* University Details */}
                                <td className="px-5 py-4 align-top text-left max-w-[280px]">
                                  <div className="font-bold text-slate-900">{org.org_name}</div>
                                  <div className="text-xs text-slate-500 mt-0.5">
                                    {org.institution_type || 'University'} {org.aishe_code && `• AISHE: ${org.aishe_code}`}
                                  </div>
                                  <div className="text-xs text-slate-600 mt-1">
                                    {org.city ? `${org.city}, ${org.state}` : org.state}
                                  </div>
                                </td>

                                {/* Exam Status Chips */}
                                <td className="px-5 py-4 align-top text-center">
                                  <div className="flex items-center justify-center flex-wrap gap-2">
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
                                <td className="px-5 py-4 align-top text-center">
                                  <Button
                                    size="xs"
                                    variant="secondary"
                                    onClick={() => setSelectedUniversityForDetails(org)}
                                    className="text-xs font-medium inline-flex items-center justify-center"
                                  >
                                    <Icon.Eye className="h-3 w-3 mr-1" />
                                    View
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
                        <div className="text-xs text-slate-500">
                          {selectedUniversityForDetails.head_designation || 'Head of Institution'}
                        </div>
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
                        <div className="min-w-0">
                          <div className="font-bold text-slate-900 font-mono">
                            {e.exam_code} — {e.exam_name}
                          </div>
                          {e.verification_from && (
                            <div className="text-[11px] text-slate-500 mt-0.5">
                              Window: {dateRange(e.verification_from, e.verification_to)}
                            </div>
                          )}
                          {e.status === 'revoked' && e.review_note && (
                            <div className="text-[11px] text-rose-700 mt-1">
                              Revoke reason: {e.review_note}
                            </div>
                          )}
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <span className={`px-2.5 py-1 rounded-full text-xs font-bold capitalize ${
                              e.status === 'approved' ? 'bg-emerald-100 text-emerald-800' :
                              e.status === 'pending'  ? 'bg-amber-100 text-amber-800' :
                              e.status === 'revoked'  ? 'bg-orange-100 text-orange-800' :
                                                        'bg-rose-100 text-rose-800'
                            }`}>
                            {e.status}
                          </span>
                          {e.status === 'approved' && (
                            <button
                              type="button"
                              onClick={async (ev) => {
                                ev.stopPropagation()
                                const note = window.prompt(
                                  `Revoke ${selectedUniversityForDetails.org_name} access to ${e.exam_code}?\n\nEnter a note the college admin will see:`,
                                  '',
                                )
                                if (note === null) return
                                const trimmed = note.trim()
                                if (!trimmed) {
                                  alert('Revoke note is required.')
                                  return
                                }
                                try {
                                  await revokeSubscription(
                                    selectedUniversityForDetails.org_id,
                                    e.exam_id,
                                    { note: trimmed },
                                  )
                                  // Refresh the detail view + parent list.
                                  setSelectedUniversityForDetails(null)
                                  if (typeof loadSubscriptions === 'function') {
                                    loadSubscriptions()
                                  } else {
                                    window.location.reload()
                                  }
                                } catch (err) {
                                  alert(`Revoke failed: ${err.message || err}`)
                                }
                              }}
                              className="px-2 py-1 rounded-md text-[11px] font-semibold text-rose-700 hover:bg-rose-100 border border-rose-200 transition-colors"
                              title="Pull this org's access to this exam. They can resubscribe from their catalog."
                            >
                              Revoke
                            </button>
                          )}
                        </div>
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

// Compact "Download CSV" button rendered next to the approved-list
// count. Streams the /export.csv endpoint through the fetch+blob dance
// (the api() helper always JSON-parses so we call fetch directly via
// the downloadApprovedSubscriptionsCsv lib helper).
function ExportCsvButton() {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  async function onClick() {
    if (busy) return
    setBusy(true)
    setMsg('')
    try {
      const name = await downloadApprovedSubscriptionsCsv()
      setMsg(`Downloaded ${name}`)
      setTimeout(() => setMsg(''), 3000)
    } catch (e) {
      setMsg(`Failed: ${e.message || e}`)
      setTimeout(() => setMsg(''), 5000)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex items-center gap-2">
      {msg && (
        <span className={`text-xs font-medium ${msg.startsWith('Failed') ? 'text-rose-600' : 'text-emerald-700'}`}>
          {msg}
        </span>
      )}
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 hover:border-slate-400 transition-colors shadow-2xs disabled:opacity-60"
        title="Download every approved subscription with the institution's contact + address details"
      >
        <Icon.Download className="h-4 w-4" />
        {busy ? 'Preparing…' : 'Download CSV'}
      </button>
    </div>
  )
}

// ── BulkCsvUploadButton ────────────────────────────────────────────────
// Reviewer uploads a CSV of (aishe_code, institution_name, approve) rows
// and the backend approves/rejects pending subscription requests
// matching by aishe_code. Full response is shown in a modal so the
// reviewer can see exactly what changed vs. what was skipped.
//
// Single source of truth for the sample CSV text — used BOTH in the
// modal preview AND for the "Sample CSV" download so what the reviewer
// downloads is exactly what they see. Includes a mix of true/false/yes
// so the reviewer can see the accepted decision spellings at a glance.
const SAMPLE_CSV_TEXT =
`aishe_code,institution_name,approve
H-3454,Innovatiview,true
T-1234,Test College,false
C-12345,Some University,yes`

function downloadSampleCsv() {
  // Prepend a UTF-8 BOM so Excel opens the CSV in the correct encoding
  // without garbling accented characters. Purely cosmetic — the parser
  // strips it — but standard for Excel-friendly CSV downloads.
  const blob = new Blob(['﻿' + SAMPLE_CSV_TEXT], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'subscription-decisions-sample.csv'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function BulkCsvUploadButton({ onDone }) {
  const [open, setOpen] = useState(false)
  const [file, setFile] = useState(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null) // { total_rows, approved, rejected, skipped, rows }
  const [error, setError] = useState('')

  function reset() {
    setFile(null); setBusy(false); setResult(null); setError('')
  }
  function close() {
    if (busy) return
    reset(); setOpen(false)
  }

  async function submit() {
    if (!file || busy) return
    setBusy(true); setError('')
    try {
      const r = await bulkDecideSubscriptionsCsv(file)
      setResult(r)
      // Refresh the parent list so newly-approved rows appear.
      onDone?.()
    } catch (e) {
      setError(e.message || 'Upload failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => { reset(); setOpen(true) }}
        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 hover:border-slate-400 transition-colors shadow-2xs"
        title="Bulk approve or reject subscription requests via CSV upload"
      >
        <Icon.Upload className="h-4 w-4" />
        Bulk CSV
      </button>

      <AnimatePresence>
        {open && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-slate-900/50" onClick={close} />
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={{ duration: 0.18 }}
              className="relative w-full max-w-2xl rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden"
            >
              <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">
                    Bulk decide subscription requests
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Upload a CSV with three columns: aishe_code, institution_name, approve.
                  </p>
                </div>
                <button
                  onClick={close}
                  disabled={busy}
                  className="text-slate-400 hover:text-slate-600 disabled:opacity-50"
                  aria-label="Close"
                >
                  <Icon.X className="h-5 w-5" />
                </button>
              </div>

              {result == null ? (
                <div className="px-6 py-5 space-y-4">
                  <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-xs text-slate-600">
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <p className="font-semibold text-slate-700">Format</p>
                      <button
                        type="button"
                        onClick={downloadSampleCsv}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 hover:border-slate-400 transition-colors"
                        title="Download a ready-to-edit sample CSV"
                      >
                        <Icon.Download className="h-3 w-3" />
                        Sample CSV
                      </button>
                    </div>
                    <p className="mb-2">
                      One row per organisation. The <span className="font-mono">approve</span> column
                      accepts <span className="font-mono">true/false</span>, <span className="font-mono">yes/no</span>,
                      or <span className="font-mono">1/0</span>. A header row is optional (auto-detected).
                    </p>
                    <pre className="bg-white border border-slate-200 rounded p-2 overflow-x-auto text-[11px] text-slate-700">
{SAMPLE_CSV_TEXT}
                    </pre>
                  </div>

                  <div>
                    <Label htmlFor="csv-file">Choose CSV file</Label>
                    <input
                      id="csv-file"
                      type="file"
                      accept=".csv,.txt,text/csv"
                      disabled={busy}
                      onChange={(e) => { setFile(e.target.files?.[0] || null); setError('') }}
                      className="mt-1 block w-full text-sm text-slate-700 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200"
                    />
                    {file && (
                      <p className="text-xs text-slate-500 mt-1">
                        Selected: <span className="font-mono">{file.name}</span> ({Math.round(file.size / 1024)} KB)
                      </p>
                    )}
                  </div>

                  {error && (
                    <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                      {error}
                    </div>
                  )}

                  <div className="flex justify-end gap-2 pt-1">
                    <button
                      type="button"
                      onClick={close}
                      disabled={busy}
                      className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <Button onClick={submit} disabled={!file || busy}>
                      {busy ? 'Uploading…' : 'Upload & apply'}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="px-6 py-5 space-y-4">
                  <div className="grid grid-cols-4 gap-3">
                    <SummaryTile label="Rows"     value={result.total_rows} tone="slate" />
                    <SummaryTile label="Approved" value={result.approved}   tone="emerald" />
                    <SummaryTile label="Rejected" value={result.rejected}   tone="rose" />
                    <SummaryTile label="Skipped"  value={result.skipped}    tone="amber" />
                  </div>

                  <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-200">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50 sticky top-0">
                        <tr className="text-slate-600">
                          <th className="text-left px-3 py-2 font-medium">Line</th>
                          <th className="text-left px-3 py-2 font-medium">AISHE</th>
                          <th className="text-left px-3 py-2 font-medium">Institution</th>
                          <th className="text-left px-3 py-2 font-medium">Outcome</th>
                          <th className="text-left px-3 py-2 font-medium">Detail</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {(result.rows || []).map((row) => (
                          <tr key={row.line_no} className="hover:bg-slate-50">
                            <td className="px-3 py-1.5 tabular-nums text-slate-500">{row.line_no}</td>
                            <td className="px-3 py-1.5 font-mono text-slate-700">{row.aishe_code}</td>
                            <td className="px-3 py-1.5 text-slate-700 truncate max-w-[180px]">
                              {row.institution_name || '—'}
                            </td>
                            <td className="px-3 py-1.5">
                              <OutcomePill outcome={row.outcome} />
                            </td>
                            <td className="px-3 py-1.5 text-slate-500">
                              {row.detail || (row.subscriptions_affected
                                ? `${row.subscriptions_affected} subscription${row.subscriptions_affected === 1 ? '' : 's'}`
                                : '')}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => reset()}
                      className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Upload another
                    </button>
                    <Button onClick={close}>Done</Button>
                  </div>
                </div>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  )
}

function SummaryTile({ label, value, tone }) {
  const map = {
    slate:   'bg-slate-50 text-slate-700 ring-slate-200',
    emerald: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
    rose:    'bg-rose-50 text-rose-800 ring-rose-200',
    amber:   'bg-amber-50 text-amber-800 ring-amber-200',
  }
  return (
    <div className={`rounded-lg ring-1 px-3 py-2 ${map[tone] || map.slate}`}>
      <p className="text-[10px] uppercase tracking-widest font-semibold opacity-70">{label}</p>
      <p className="text-lg font-bold tabular-nums">{value}</p>
    </div>
  )
}

function OutcomePill({ outcome }) {
  const cfg = outcome === 'approved' ? { bg: 'bg-emerald-100', fg: 'text-emerald-800', dot: 'bg-emerald-500', label: 'Approved' }
            : outcome === 'rejected' ? { bg: 'bg-rose-100',    fg: 'text-rose-800',    dot: 'bg-rose-500',    label: 'Rejected' }
            :                          { bg: 'bg-amber-100',   fg: 'text-amber-800',   dot: 'bg-amber-500',   label: 'Skipped'  }
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${cfg.bg} ${cfg.fg}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  )
}

// ── RefreshButton ──────────────────────────────────────────────────────
// Wraps the parent's async loader so the button itself shows a spinner
// while the request is in flight. Previously the click called
// setSubLoading(true) + loadSubscriptions() but the loading UI only
// renders a skeleton when the list is EMPTY, so a refresh on a
// populated list felt like a no-op (bug reported 2026-08-24). Local
// busy state guarantees visible feedback even for a 50 ms round-trip.
function RefreshButton({ onClick }) {
  const [busy, setBusy] = useState(false)
  async function handle() {
    if (busy) return
    setBusy(true)
    try {
      await onClick?.()
    } finally {
      // Small min-visible window so a fast round-trip still flashes
      // the spinner instead of a jitter that reads as "click missed".
      setTimeout(() => setBusy(false), 250)
    }
  }
  return (
    <button
      onClick={handle}
      disabled={busy}
      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors shadow-2xs disabled:opacity-60"
    >
      <Icon.Refresh className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />
      {busy ? 'Refreshing…' : 'Refresh'}
    </button>
  )
}
