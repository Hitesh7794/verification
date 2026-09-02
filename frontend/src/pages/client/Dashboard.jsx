import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import AppShell from '../../components/shell/AppShell.jsx'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Label,
  PageHeader,
} from '../../components/ui/ui.jsx'
import FingerprintCapture from '../../components/verify/FingerprintCapture.jsx'
import IrisCapture from '../../components/verify/IrisCapture.jsx'
import LivenessPanel from '../../components/verify/LivenessPanel.jsx'
import ExamWindowReminderModal from '../../components/verify/ExamWindowReminderModal.jsx'
import { api, fetchFPTemplate, fetchPhotoBlob, isWalletEmptyError, getCandidateAttempts, downloadVerificationPDF, printVerificationPDF, postFaceMatch, getCurrentExamId, setCurrentExamId } from '../../lib/api.js'
import { getWalletSummary, formatRupees } from '../../lib/wallet/wallet.js'
import { formatDateTime } from '../../lib/dates.js'

// Generate an idempotency key per verification attempt so a network retry
// of the submit doesn't create two rows. crypto.randomUUID is available in
// every browser this app supports (Vite targets evergreen).
function newIdempotencyKey() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return 'k-' + Date.now() + '-' + Math.random().toString(36).slice(2)
}

// Short "how long ago" string for the attempt-counter chip. Coarse on
// purpose — the exact minute doesn't matter, only the recency.
function relativeAgo(iso) {
  const then = new Date(iso).getTime()
  if (!then) return ''
  const secs = Math.max(1, Math.floor((Date.now() - then) / 1000))
  if (secs < 60)       return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60)       return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24)        return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

const APP_VERSION = '0.2.0'

// sessionStorage key for per-tab verification-in-progress state.
// Persisted so an accidental refresh / power blip / network reconnect
// doesn't throw an operator back to step 1 with their captures lost.
// Scoped per-tab (sessionStorage, not localStorage) so two operators
// sharing one machine across browser windows don't see each other's
// in-flight verification.
const STATE_KEY = 'nv_verify_state_v1'

function loadPersistedState() {
  try {
    // Session-alive gate: only rehydrate when the login handler set
    // `nv_session_alive_client` in THIS sessionStorage. Refresh
    // preserves both (state + marker) → mid-flow rehydrates. Close-
    // tab-then-reopen (including Chrome's "continue where you left
    // off" / "reopen closed tab" that restores sessionStorage) →
    // the marker is missing because login never fired in the
    // restored context → we clear the state and start clean.
    if (!sessionStorage.getItem('nv_session_alive_client')) {
      sessionStorage.removeItem(STATE_KEY)
      return null
    }
    const raw = sessionStorage.getItem(STATE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !parsed.roll) {
      sessionStorage.removeItem(STATE_KEY)
      return null
    }
    return parsed
  } catch {
    return null
  }
}
function persistState(state) {
  try { sessionStorage.setItem(STATE_KEY, JSON.stringify(state)) } catch {}
}
function clearPersistedState() {
  try { sessionStorage.removeItem(STATE_KEY) } catch {}
}

// Face-first flow (Aug 2026): the operator captures the candidate's
// face BEFORE the enrolled record is revealed. Face capture is what
// charges the wallet — a commitment to spending. Only after face-match
// completes do we show the enrolled photo + details, then run the
// fingerprint verification if the candidate has one on file. The final
// verified/not-verified verdict is computed from the match thresholds;
// no manual button any more.
// Aug 2026 update: added Liveness step in front of Face Capture.
// Luxand active anti-spoof gate (blink challenge) — must pass before
// the paid /face-match runs. See LivenessPanel.jsx for the flow.
const STEPS = ['Roll Number', 'Liveness', 'Face Capture', 'Fingerprint', 'Result']

// Step index constants so the mount / gating logic doesn't have to
// count positions. Same convention S_INSTITUTION etc use in Register.jsx.
const S_ROLL = 0
const S_LIVENESS = 1
const S_FACE = 2
const S_FINGERPRINT = 3
const S_RESULT = 4

function Stepper({ step }) {
  return (
    <ol className="flex items-center w-full">
      {STEPS.map((s, i) => {
        const active = i === step
        const done = i < step
        return (
          <li
            key={s}
            className={`flex-1 flex items-center ${i < STEPS.length - 1 ? 'after:content-[""] after:flex-1 after:h-0.5 after:mx-3 after:bg-slate-200' : ''}`}
          >
            <div className="flex items-center gap-2">
              <span
                className={`h-7 w-7 rounded-full flex items-center justify-center text-xs font-semibold ${
                  done
                    ? 'bg-emerald-600 text-white'
                    : active
                    ? 'bg-indigo-600 text-white'
                    : 'bg-slate-200 text-slate-600'
                }`}
              >
                {i + 1}
              </span>
              <span
                className={`text-sm font-medium ${
                  active ? 'text-slate-900' : 'text-slate-500'
                }`}
              >
                {s}
              </span>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function WebcamCapture({ onCapture }) {
  const videoRef = useRef(null)
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState('')
  const [snap, setSnap] = useState(null)

  useEffect(() => {
    let stream
    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          setStreaming(true)
        }
      } catch (e) {
        setError('Unable to access webcam. ' + e.message)
      }
    }
    start()
    return () => {
      if (stream) stream.getTracks().forEach((t) => t.stop())
    }
  }, [])

  function capture() {
    const v = videoRef.current
    if (!v) return
    const canvas = document.createElement('canvas')
    canvas.width = v.videoWidth
    canvas.height = v.videoHeight
    canvas.getContext('2d').drawImage(v, 0, 0)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
    setSnap(dataUrl)
    onCapture(dataUrl)
  }

  function retake() {
    setSnap(null)
    onCapture(null)
  }

  return (
    <div className="space-y-3">
      <div className="aspect-video w-full rounded-lg bg-slate-900 overflow-hidden border border-slate-200">
        {snap ? (
          <img src={snap} alt="captured" className="w-full h-full object-cover" />
        ) : (
          <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
        )}
      </div>
      {error && <p className="text-xs text-rose-600">{error}</p>}
      <div className="flex gap-2">
        {snap ? (
          <Button variant="secondary" onClick={retake}>Retake</Button>
        ) : (
          <Button onClick={capture} disabled={!streaming}>Capture photo</Button>
        )}
      </div>
    </div>
  )
}


export default function ClientDashboard() {
  // Lazy initialisers read sessionStorage so a refresh in the middle
  // of a flow restores the operator to where they were. Photo blob,
  // gallery template, and the snap data URL are intentionally NOT
  // persisted (binary data, easy to refetch from roll); we hydrate
  // those via re-lookup in the mount effect below.
  const persisted = loadPersistedState()
  const [step, setStep] = useState(persisted?.step ?? 0)
  const [roll, setRoll] = useState(persisted?.roll ?? '')
  const [candidate, setCandidate] = useState(null)
  const [photoBlob, setPhotoBlob] = useState(null)
  const [gallery, setGallery] = useState(null) // {template_b64, format}
  const [attempts, setAttempts] = useState(null) // {count, last_at?} — Phase 3c
  const [lookupErr, setLookupErr] = useState('')
  const [snap, setSnap] = useState(persisted?.snap ?? null)
  const [faceResult, setFaceResult] = useState(persisted?.faceResult ?? null)
  // Liveness gate result. Non-null with .pass === true unlocks the
  // face-capture step. Deliberately NOT persisted — a page refresh
  // means we make the operator re-prove liveness for the current
  // session, since the backend's liveness_checks row expires quickly
  // (LivenessMaxAgeSeconds, default 90s) and there's no way for us to
  // know from client-side whether the gate is still live.
  const [livenessResult, setLivenessResult] = useState(null)
  const [fpResult, setFpResult] = useState(persisted?.fpResult ?? null)
  const [irisResult, setIrisResult] = useState(persisted?.irisResult ?? null)
  const [showIris, setShowIris] = useState(persisted?.showIris ?? false)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState(null)
  // Verification id echoed back by the POST — powers the "Download PDF"
  // button on the result panel. Cleared by reset() so a new flow doesn't
  // download the previous candidate's receipt.
  const [verificationId, setVerificationId] = useState(null)
  const [verificationStartedAt, setVerificationStartedAt] = useState(persisted?.verificationStartedAt ?? null)
  // Idempotency key is generated ONCE per verification (on first
  // successful lookup) and reused across any submit retries. This
  // way: network retry → backend sees same key → returns the same
  // existing row (no duplicate). Browser-back + resubmit on the
  // same flow → same key → idempotent. New "Start over" → fresh key.
  const [idempotencyKey, setIdempotencyKey] = useState(persisted?.idempotencyKey ?? null)
  // When the org's wallet is empty, the candidate-lookup endpoint
  // returns HTTP 402. Operators can't top up themselves — this is
  // surfaced as a passive banner directing them to their admin.
  const [walletEmpty, setWalletEmpty] = useState(false)
  // When an operator attempts to verify a candidate for an exam whose
  // verification window is in the future (or closed), windowReminder triggers
  // a prominent date reminder modal with examination details and start date.
  const [windowReminder, setWindowReminder] = useState(null)

  // Live wallet-balance pill in the page header. Fetched once on mount
  // (no polling — the balance only moves when THIS operator submits a
  // face-match, so we refresh right after each of those). null while
  // loading; { balance_paise, fee_per_lookup_paise } once loaded.
  const [wallet, setWallet] = useState(null)
  useEffect(() => {
    getWalletSummary().then(setWallet).catch(() => {})
  }, [])
  const refreshWallet = () => {
    getWalletSummary().then(setWallet).catch(() => {})
  }

  // Multi-exam operator picker. Fetch the operator's assigned exams
  // once on mount; if they have >1 and no selection yet, force them
  // to pick before anything else works. If they have exactly 1 and
  // no selection yet, auto-select so single-exam operators don't see
  // any change from before.
  const [assignedExams, setAssignedExams] = useState([])
  const [currentExamId, setCurrentExamIdState] = useState(() => getCurrentExamId())
  useEffect(() => {
    api('/operator/exams')
      .then((r) => {
        const list = r?.exams || []
        setAssignedExams(list)
        // Prune a stored selection that no longer matches an assigned
        // exam (admin revoked it, exam deleted, etc.) so the header
        // doesn't get sent an id the operator no longer owns.
        const stored = getCurrentExamId()
        if (stored && !list.some((e) => String(e.id) === String(stored))) {
          setCurrentExamId(null)
          setCurrentExamIdState(null)
        }
        // Auto-select the single option so single-exam operators
        // never see a picker.
        if (list.length === 1 && !getCurrentExamId()) {
          setCurrentExamId(list[0].id)
          setCurrentExamIdState(String(list[0].id))
          // Re-fetch wallet so the "next window opens on" banner
          // reflects the (only) assigned exam.
          refreshWallet()
        }
      })
      .catch(() => setAssignedExams([]))
  }, [])

  // Switching exam mid-flow would leave probes, idempotency keys,
  // and any in-progress capture pointing at the wrong exam's data.
  // The simplest safe answer is to reset() back to step 0 on any
  // switch — the operator can start the new candidate fresh.
  const onSwitchExam = (nextId) => {
    if (String(nextId) === String(currentExamId)) return
    setCurrentExamId(nextId)
    setCurrentExamIdState(String(nextId))
    // Wallet fields (assigned_exam_*) depend on the header we just changed.
    refreshWallet()
    // Wipe in-progress flow so no probe/idempotency key carries across.
    reset()
  }

  // ── Auto-decide + auto-submit ────────────────────────────────────
  // As soon as every enrolled modality has produced a result, we submit
  // the verification automatically — no manual button.
  //
  //   • Face is always required (already gates enrolment lookup).
  //   • Fingerprint is required when the candidate has an ISO template.
  //   • Iris is required when the candidate has iris bytes enrolled.
  //   • Every required modality must PASS for "verified" (strict AND).
  //
  // Guarded by `result` and `submitting` so it fires exactly once per
  // verification flow. `reset()` clears result and puts us back to
  // step 0, ready for the next candidate.
  useEffect(() => {
    // Only guard against a re-entrant fire while a request is in
    // flight. Once the initial submission returns, subsequent
    // recaptures should PATCH the existing row -- submitVerification
    // routes internally based on whether verificationId is set.
    if (submitting) return
    if (!candidate) return
    // Gating rule (migration 022): a modality is "needed" only if the
    // EXAM requires it AND the candidate actually has enrolment for
    // it. If either is false, the panel is hidden + not gated on.
    // Face defaults to required for safety (existing behaviour + the
    // wallet-charged event), so exam.requires_face missing = true.
    const needsFace = candidate.requires_face !== false && !!candidate.has_photo
    const needsFP   = !!candidate.requires_fp   && !!candidate.has_iso_template
    const needsIris = !!candidate.requires_iris && !!candidate.has_iris_bytes
    if (needsFace && !faceResult) return
    if (needsFP   && !fpResult)   return
    if (needsIris && !irisResult) return
    const facePass = !needsFace || (faceResult && faceResult.ok === true)
    const fpPass   = !needsFP   || (fpResult   && fpResult.ok   === true)
    const irisPass = !needsIris || (irisResult && irisResult.ok === true)
    const finalStatus = facePass && fpPass && irisPass ? 'verified' : 'denied'
    if (step < S_RESULT) setStep(S_RESULT)
    submitVerification(finalStatus)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidate, faceResult, fpResult, irisResult, submitting])

  // Persist whenever the meaningful state changes, so an unexpected
  // refresh doesn't lose the operator's in-flight verification.
  // photoBlob/gallery are excluded — they're large and re-fetchable
  // from `roll`. `snap` (the captured face frame) IS persisted so the
  // enrolled+captured side-by-side view survives a refresh; it's a
  // single JPEG at 0.85 quality, well within sessionStorage's ~5MB cap.
  useEffect(() => {
    if (step === 0 && !roll && !candidate && !faceResult && !fpResult) {
      // Idle / cleared state — drop the persisted record entirely.
      clearPersistedState()
      return
    }
    persistState({
      step, roll, faceResult, fpResult, irisResult, showIris,
      verificationStartedAt, idempotencyKey, snap,
    })
  }, [step, roll, faceResult, fpResult, irisResult, showIris,
      verificationStartedAt, idempotencyKey, candidate, snap])

  // On mount, if we restored a flow past step 0, re-fetch the
  // candidate so photo + template are available again. The wallet
  // middleware's same-roll cache (5 min window) means this re-lookup
  // doesn't double-charge.
  useEffect(() => {
    if (persisted && persisted.step > 0 && persisted.roll && !candidate) {
      ;(async () => {
        try {
          const c = await api(`/candidates/${encodeURIComponent(persisted.roll)}`)
          setCandidate(c)
          try {
            const url = await fetchPhotoBlob(persisted.roll)
            setPhotoBlob(url)
          } catch {}
          if (c.has_iso_template) {
            try {
              const tpl = await fetchFPTemplate(persisted.roll)
              setGallery(tpl)
            } catch {}
          }
        } catch (e) {
          // If the re-lookup fails (wallet empty / candidate gone),
          // reset cleanly so the operator isn't stuck in a half-loaded
          // step 2 with no candidate object.
          if (isWalletEmptyError(e)) {
            setWalletEmpty(true)
          } else {
            setLookupErr(e.message || 'Could not restore verification')
          }
          clearPersistedState()
          setStep(0)
        }
      })()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Compute verification window status
  const now = new Date()
  const examFromStr = wallet?.assigned_exam_verification_from
  const examToStr = wallet?.assigned_exam_verification_to
  const opFromStr = wallet?.operator_valid_from
  const opToStr = wallet?.operator_valid_to

  const isExamFuture = !!(examFromStr && !isNaN(new Date(examFromStr).getTime()) && now < new Date(examFromStr))
  const isExamExpired = !!(examToStr && !isNaN(new Date(examToStr).getTime()) && now > new Date(examToStr))
  const isOpFuture = !!(opFromStr && !isNaN(new Date(opFromStr).getTime()) && now < new Date(opFromStr))
  const isOpExpired = !!(opToStr && !isNaN(new Date(opToStr).getTime()) && now > new Date(opToStr))
  const isWindowClosed = isExamFuture || isExamExpired || isOpFuture || isOpExpired

  async function lookupRoll(e) {
    e?.preventDefault()
    setLookupErr('')
    setWalletEmpty(false)
    if (!roll.trim()) return

    if (isExamFuture) {
      setWindowReminder({
        type: 'future',
        examName: wallet.assigned_exam_name,
        examCode: wallet.assigned_exam_code,
        verificationFrom: examFromStr,
        verificationTo: examToStr,
        message: `Candidate verification for ${wallet.assigned_exam_name || wallet.assigned_exam_code} is scheduled to start on ${formatDateTime(examFromStr)}. Live biometric verifications cannot be started before this time.`,
      })
      return
    }
    if (isExamExpired) {
      setWindowReminder({
        type: 'expired',
        examName: wallet.assigned_exam_name,
        examCode: wallet.assigned_exam_code,
        verificationFrom: examFromStr,
        verificationTo: examToStr,
        message: `The verification window for ${wallet.assigned_exam_name || wallet.assigned_exam_code} closed on ${formatDateTime(examToStr)}. Verifications are no longer accepted.`,
      })
      return
    }
    if (isOpFuture) {
      setWindowReminder({
        type: 'future',
        examName: wallet.assigned_exam_name,
        examCode: wallet.assigned_exam_code,
        verificationFrom: opFromStr,
        verificationTo: opToStr,
        message: `Your agent account is scheduled to activate on ${formatDateTime(opFromStr)}. Verifications cannot be started yet.`,
      })
      return
    }
    if (isOpExpired) {
      setWindowReminder({
        type: 'expired',
        examName: wallet.assigned_exam_name,
        examCode: wallet.assigned_exam_code,
        verificationFrom: opFromStr,
        verificationTo: opToStr,
        message: `Your agent account access expired on ${formatDateTime(opToStr)}. Please contact your administrator.`,
      })
      return
    }

    try {
      const c = await api(`/candidates/${encodeURIComponent(roll.trim())}`)
      setCandidate(c)
      setVerificationStartedAt(Date.now())
      // Mint a fresh idempotency key for this verification. It will
      // be reused across any submit retries within the same flow.
      setIdempotencyKey(newIdempotencyKey())
      // Photo and fingerprint template can fetch in parallel; either
      // failure is non-fatal — operator can still complete a manual
      // verification, so we just surface the absence in the UI.
      try {
        const url = await fetchPhotoBlob(roll.trim())
        setPhotoBlob(url)
      } catch {
        setPhotoBlob(null)
      }
      if (c.has_iso_template) {
        try {
          const tpl = await fetchFPTemplate(roll.trim())
          setGallery(tpl)
        } catch {
          setGallery(null)
        }
      } else {
        setGallery(null)
      }
      // Attempt-counter fetch — non-fatal; if it fails, we just hide
      // the chip. Kept off the critical path (parallel-safe).
      try {
        setAttempts(await getCandidateAttempts(roll.trim()))
      } catch {
        setAttempts(null)
      }
      setStep(S_LIVENESS)
    } catch (e) {
      // HTTP 402 from the wallet middleware → org wallet is empty.
      // Operator cannot self-serve; show a banner with the resolution
      // path (notify admin to top up).
      if (isWalletEmptyError(e)) {
        setWalletEmpty(true)
        return
      }

      // Check for 403 Forbidden verification window errors
      if (
        e.status === 403 &&
        (e.body?.code === 'EXAM_WINDOW_FUTURE' ||
          e.body?.code === 'EXAM_WINDOW_EXPIRED' ||
          e.body?.code === 'OPERATOR_WINDOW_FUTURE' ||
          e.body?.code === 'OPERATOR_WINDOW_EXPIRED' ||
          e.body?.verification_from ||
          e.body?.verification_to ||
          e.body?.valid_from ||
          e.body?.valid_to)
      ) {
        setWindowReminder({
          type: e.body?.code?.includes('EXPIRED') ? 'expired' : 'future',
          examName: e.body?.exam_name || wallet?.assigned_exam_name || '',
          examCode: e.body?.exam_code || wallet?.assigned_exam_code || '',
          verificationFrom: e.body?.verification_from || e.body?.valid_from || '',
          verificationTo: e.body?.verification_to || e.body?.valid_to || '',
          message: e.body?.error || e.message,
        })
        return
      }

      if (
        e.status === 403 &&
        (e.message?.toLowerCase().includes('will start') ||
          e.message?.toLowerCase().includes('opens on') ||
          e.message?.toLowerCase().includes('closed on'))
      ) {
        const isFuture = !e.message?.toLowerCase().includes('closed on')
        setWindowReminder({
          type: isFuture ? 'future' : 'expired',
          examName: wallet?.assigned_exam_name || '',
          examCode: wallet?.assigned_exam_code || '',
          verificationFrom: wallet?.assigned_exam_verification_from || '',
          verificationTo: wallet?.assigned_exam_verification_to || '',
          message: e.message,
        })
        return
      }

      setLookupErr(e.message || 'lookup failed')
    }
  }

  async function submitVerification(status) {
    setSubmitting(true)
    try {
      const decisionMs = verificationStartedAt
        ? Date.now() - verificationStartedAt
        : null

      // Decide which channel to attribute the decision to. Priority order
      // is "the strongest biometric that actually passed":
      //   1. fingerprint matched   → via=fingerprint  (highest assurance)
      //   2. iris matched          → via=iris         (fallback succeeded)
      //   3. face matched          → via=face         (lower assurance, but better than nothing)
      //   4. nothing matched but operator clicked Verified → via=manual
      // Face match alone isn't enough for "verified" without an additional
      // biometric in the operator workflow, but it lands on the audit row
      // either way so an investigator can reconstruct what happened.
      const fpMatched = !!(fpResult && fpResult.ok === true)
      const irisMatched = !!(irisResult && irisResult.ok === true)
      const faceMatched = !!(faceResult && faceResult.ok === true)
      let via = 'manual'
      if (status === 'verified') {
        if (fpMatched) via = 'fingerprint'
        else if (irisMatched) via = 'iris'
        else if (faceMatched) via = 'face'
      }

      const body = {
        roll_no: candidate.roll_no,
        status,
        face_match: faceMatched,
        fp_match: fpMatched,
        via,
        match_threshold: fpResult?.threshold ?? null,
        decision_ms: decisionMs,
        client_app_version: APP_VERSION,
        // Stable across resubmits within this verification flow. The
        // key was generated at lookup time and persisted, so a retry
        // (network, browser back) reuses it; the backend's UNIQUE
        // index returns the original row instead of inserting a dup.
        idempotency_key: idempotencyKey || newIdempotencyKey(),
      }
      if (fpResult) {
        Object.assign(body, {
          fp_vendor: fpResult.vendor || null,
          device_serial: fpResult.deviceSerial || null,
          device_model: fpResult.deviceModel || null,
          fp_template_format: fpResult.templateFormat || null,
          fp_quality: fpResult.quality,
          fp_nfiq: fpResult.nfiq,
          // Round to integer before sending: the backend's fp_match_score
          // column is INTEGER. Mantra returns ints natively, but SourceAFIS
          // returns doubles like 215.0914 — Go's JSON decoder would reject
          // those against `*int`. Audit precision loss (215.09 → 215) is
          // negligible because the gap between match (>100) and non-match
          // (<5) is two orders of magnitude.
          fp_match_score: typeof fpResult.score === 'number'
            ? Math.round(fpResult.score)
            : null,
          fp_liveness: fpResult.liveness,
        })
      }
      if (irisResult) {
        Object.assign(body, {
          iris_left_score: irisResult.leftScore,
          iris_right_score: irisResult.rightScore,
          iris_left_quality: irisResult.leftQuality,
          iris_right_quality: irisResult.rightQuality,
        })
      }
      if (faceResult) {
        body.face_match_score = faceResult.score
      }

      // First submission = POST (creates the row + charges the wallet
      // if not already charged by face-match). Any subsequent submission
      // in the SAME verification session (verificationId set) is a PATCH
      // that overwrites the biometric flags + recomputes status/via
      // server-side. Wallet is not re-charged on PATCH.
      let saved
      if (verificationId) {
        saved = await api(`/verifications/${verificationId}`, { method: 'PATCH', body })
      } else {
        saved = await api('/verifications', { method: 'POST', body })
        if (saved && saved.id) setVerificationId(saved.id)
      }
      // Use the server-computed status (PATCH may have flipped it based
      // on the fresh biometric flags), not the frontend's guess.
      setResult(saved?.status || status)
      // Flow is complete -- discard the persisted state so a refresh
      // lands the operator on a clean Step 1 ready for the next
      // candidate, not on an old completed verification.
      clearPersistedState()
    } catch (e) {
      setLookupErr(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  function reset() {
    if (photoBlob) URL.revokeObjectURL(photoBlob)
    setStep(0)
    setRoll('')
    setCandidate(null)
    setPhotoBlob(null)
    setGallery(null)
    setSnap(null)
    setAttempts(null)
    setIdempotencyKey(null)
    clearPersistedState()
    setFaceResult(null)
    setLivenessResult(null)
    setFpResult(null)
    setIrisResult(null)
    setShowIris(false)
    setResult(null)
    setVerificationId(null)
    setLookupErr('')
    setVerificationStartedAt(null)
  }

  return (
    <AppShell
      title="Center Verification Agent Portal"
      subtitle="Biometric verification workstation"
    >
      {walletEmpty && (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 flex items-start gap-3">
          <span className="mt-0.5">⚠</span>
          <div className="flex-1">
            <p className="font-semibold">Organisation wallet is empty</p>
            <p className="mt-0.5 text-amber-700">
              Candidate lookups are paused until your administrator tops up the
              institution wallet. Please contact your admin and try again
              shortly.
            </p>
          </div>
          <button
            type="button"
            className="text-amber-700 hover:text-amber-900 text-lg leading-none"
            onClick={() => setWalletEmpty(false)}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}
      <PageHeader
        title="New verification"
        subtitle="Enter the candidate roll number, capture face and fingerprint, then record the decision."
        right={
          // Header right slot: wallet pill always visible + a
          // context-dependent action:
          //   step === 0  → "Download installer"
          //   step >  0   → "Start over"
          <div className="flex items-center gap-3">
            <WalletPill wallet={wallet} />
            {step === 0 ? (
              <Link
                to="/institute/operator/downloads"
                title="Download the install bundle for a new verification agent laptop"
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-300 focus:ring-offset-1"
              >
                <svg
                  className="h-4 w-4 text-slate-500"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Download installer
              </Link>
            ) : (
              <Button variant="secondary" onClick={reset}>
                Start over
              </Button>
            )}
          </div>
        }
      />

      <Card className="mb-3">
        <CardBody className="py-3">
          <Stepper step={step} />
        </CardBody>
      </Card>

      {/* Current-exam picker — shown when the operator holds more
          than one exam. Data isolation: the picked id becomes the
          X-Exam-Id header on every request, and the backend scopes
          candidate/photo/face-match queries by that id so an operator
          with e.g. NEET + JEE can't accidentally pull a JEE roll
          while NEET is selected. Single-exam operators never see it. */}
      {assignedExams.length > 1 && (
        <ExamPicker
          exams={assignedExams}
          currentId={currentExamId}
          onChange={onSwitchExam}
        />
      )}

      {/* Multi-exam operator hasn't picked yet — block the roll lookup
          with a prompt. Prevents the ambiguous-exam 400 the backend
          would otherwise return on the first candidate fetch. */}
      {step === 0 && assignedExams.length > 1 && !currentExamId && (
        <Card className="border-indigo-200 bg-indigo-50">
          <CardBody>
            <div className="flex items-start gap-3">
              <svg className="h-6 w-6 text-indigo-600 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
              <div>
                <p className="text-base font-semibold text-indigo-900">Pick an exam to start</p>
                <p className="mt-1 text-sm text-indigo-800">
                  You're assigned to {assignedExams.length} exams. Use the picker above to choose which one you're verifying for right now — every candidate lookup will be scoped to that exam.
                </p>
              </div>
            </div>
          </CardBody>
        </Card>
      )}

      {/* No exam assigned to this operator — replace the roll input card
          with a persistent instruction banner. Zero-exam operators would
          otherwise get 404 "no data" on every lookup with no clue why. */}
      {step === 0 && wallet && !wallet.assigned_exam_id && assignedExams.length === 0 && (
        <Card className="border-amber-200 bg-amber-50">
          <CardBody>
            <div className="flex items-start gap-3">
              <svg className="h-6 w-6 text-amber-600 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <div>
                <p className="text-base font-semibold text-amber-900">No exam assigned to your account</p>
                <p className="mt-1 text-sm text-amber-800">
                  Your admin hasn't assigned you an exam yet. Ask your admin to
                  assign one before you can look up and verify candidates.
                </p>
              </div>
            </div>
          </CardBody>
        </Card>
      )}

      {step === 0 && (!wallet || wallet.assigned_exam_id) && (
        <Card>
          <CardHeader>
            <CardTitle>Step 1 — Roll number</CardTitle>
          </CardHeader>
          <CardBody>
            {isExamFuture && (
              <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50/80 p-4 text-xs text-amber-900 flex items-start gap-3 shadow-2xs">
                <div className="h-7 w-7 rounded-lg bg-amber-100 text-amber-800 flex items-center justify-center shrink-0">
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                </div>
                <div>
                  <p className="font-semibold text-amber-900 text-sm">
                    Upcoming Examination Verification Window
                  </p>
                  <p className="mt-0.5 text-amber-800 leading-relaxed">
                    Verification for <strong>{wallet?.assigned_exam_name || wallet?.assigned_exam_code}</strong> is scheduled to begin on <strong>{formatDateTime(examFromStr)}</strong>. Candidate biometric lookups will unlock at that time.
                  </p>
                </div>
              </div>
            )}

            {isExamExpired && (
              <div className="mb-5 rounded-xl border border-rose-200 bg-rose-50/80 p-4 text-xs text-rose-900 flex items-start gap-3 shadow-2xs">
                <div className="h-7 w-7 rounded-lg bg-rose-100 text-rose-800 flex items-center justify-center shrink-0">
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                </div>
                <div>
                  <p className="font-semibold text-rose-900 text-sm">
                    Examination Verification Window Closed
                  </p>
                  <p className="mt-0.5 text-rose-800 leading-relaxed">
                    The verification window for <strong>{wallet?.assigned_exam_name || wallet?.assigned_exam_code}</strong> closed on <strong>{formatDateTime(examToStr)}</strong>. Verifications are no longer accepted for this exam.
                  </p>
                </div>
              </div>
            )}

            {isOpFuture && !isExamFuture && (
              <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50/80 p-4 text-xs text-amber-900 flex items-start gap-3 shadow-2xs">
                <div className="h-7 w-7 rounded-lg bg-amber-100 text-amber-800 flex items-center justify-center shrink-0">
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                </div>
                <div>
                  <p className="font-semibold text-amber-900 text-sm">
                    Operator Account Not Active Yet
                  </p>
                  <p className="mt-0.5 text-amber-800 leading-relaxed">
                    Your agent account is scheduled to activate on <strong>{formatDateTime(opFromStr)}</strong>. Candidate lookups will unlock once your account window begins.
                  </p>
                </div>
              </div>
            )}

            {isOpExpired && !isExamExpired && (
              <div className="mb-5 rounded-xl border border-rose-200 bg-rose-50/80 p-4 text-xs text-rose-900 flex items-start gap-3 shadow-2xs">
                <div className="h-7 w-7 rounded-lg bg-rose-100 text-rose-800 flex items-center justify-center shrink-0">
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                </div>
                <div>
                  <p className="font-semibold text-rose-900 text-sm">
                    Operator Account Access Expired
                  </p>
                  <p className="mt-0.5 text-rose-800 leading-relaxed">
                    Your agent account access expired on <strong>{formatDateTime(opToStr)}</strong>. Please contact your college administrator.
                  </p>
                </div>
              </div>
            )}

            <form onSubmit={lookupRoll} className="max-w-md space-y-4">
              <div>
                <Label>Candidate roll number</Label>
                <Input
                  value={roll}
                  onChange={(e) => setRoll(e.target.value)}
                  placeholder={isWindowClosed ? 'Verification window is currently closed' : 'e.g. 10001'}
                  disabled={isWindowClosed}
                  autoFocus={!isWindowClosed}
                />
              </div>
              {lookupErr && (
                <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
                  {lookupErr}
                </div>
              )}
              <Button type="submit" disabled={isWindowClosed || !roll.trim()}>
                {isWindowClosed ? 'Window closed' : 'Look up candidate'}
              </Button>
            </form>
          </CardBody>
        </Card>
      )}

      {/* Recovery card — if a session was restored past step 0 but
          candidate is not yet loaded, park the operator with a
          spinner + Start over. Prevents rendering the liveness card
          with a null candidate after a reload. Added on the rahul-FE
          side of the merge; kept because it's a real UX guard. */}
      {step > 0 && !candidate && (
        <Card>
          <CardBody className="py-12 text-center text-slate-500">
            <div className="flex flex-col items-center justify-center gap-3">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-stone-800" />
              <p className="text-sm">Restoring verification session...</p>
              <Button variant="secondary" size="sm" onClick={reset}>
                Start over
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      {/* Step 2 — active liveness + face capture, one continuous flow.
          Operator clicks "Start liveness check" ONCE. The blink burst
          runs, wallet debits on pass, and the final frame from the same
          burst is reused as the TrustView probe — no second camera
          panel, no second click. Backend keys /face-match on the
          liveness_checks row (same idempotency_key), so it accepts. */}
      {step === S_LIVENESS && candidate && (
        <Card>
          <CardHeader>
            <CardTitle>Step 2 — Liveness &amp; face match</CardTitle>
          </CardHeader>
          <CardBody className="py-3">
            <LivenessPanel
              rollNo={candidate.roll_no}
              sessionId={idempotencyKey}
              onPass={async ({ faceFrame }) => {
                setLivenessResult({ pass: true })
                // Wallet debits on the liveness pass — refresh the
                // header pill so the operator sees the debited balance.
                refreshWallet()
                // Reuse the last liveness burst frame as the TrustView
                // probe. No second camera panel, no second click.
                if (faceFrame) {
                  try {
                    const resp = await postFaceMatch(candidate.roll_no, faceFrame, idempotencyKey)
                    const out = {
                      ok: !!resp.status,
                      captured: true,
                      faceFound: !!resp.face_found,
                      score: typeof resp.score === 'number' ? resp.score : 0,
                      threshold: typeof resp.threshold === 'number' ? resp.threshold : 0,
                      snapshot: faceFrame,
                      raw: resp,
                    }
                    setFaceResult(out)
                    setSnap(faceFrame)
                  } catch (e) {
                    setFaceResult({
                      ok: false, captured: false, faceFound: false,
                      score: 0, threshold: 0, snapshot: null,
                      error: e?.message || 'face match failed',
                    })
                  }
                } else {
                  // No frame captured (should not happen on pass, but be
                  // defensive) — mark face as skipped so downstream flow
                  // still advances to fingerprint.
                  setFaceResult({ ok: false, captured: false, faceFound: false, score: 0, threshold: 0, snapshot: null, skipped: true })
                }
                setStep(S_FINGERPRINT)
              }}
            />
          </CardBody>
        </Card>
      )}

      {step >= S_FINGERPRINT && candidate && (
        <div className="grid gap-3 lg:grid-cols-3">
          <Card className="lg:col-span-1 self-start">
            <CardHeader>
              <CardTitle>Candidate on file</CardTitle>
            </CardHeader>
            <CardBody className="py-3">
              {/* Once the liveness burst has produced a probe frame we
                  show enrolled + captured side by side so the operator
                  can eyeball the match without leaving this step. The
                  captured tile borrows the same aspect + rounding as the
                  enrolled tile; when no snap exists yet (e.g. fingerprint
                  stage jumped in early), we fall back to the single
                  enrolled tile that was here before. */}
              {snap ? (
                // Side-by-side, but with a PORTRAIT (3:4) aspect ratio
                // per tile so the head fits without object-cover
                // chopping the top and bottom off the enrolled photo.
                // Passport-style enrolled photos and the liveness burst
                // frame are both taller than wide; a landscape 4:3 tile
                // was cropping the crown of the head and the chin.
                // gap-1.5 (6 px) claws back a bit more per-tile width.
                <div className="grid grid-cols-2 gap-1.5 mb-3">
                  <div>
                    <div className="aspect-[3/4] w-full rounded-lg bg-slate-100 overflow-hidden">
                      {photoBlob ? (
                        <img src={photoBlob} alt="enrolled" className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-slate-400 text-[11px] text-center px-1">
                          No photo on file
                        </div>
                      )}
                    </div>
                    <div className="mt-1 text-[10px] uppercase tracking-wide text-slate-500 text-center">
                      Enrolled
                    </div>
                  </div>
                  <div>
                    <div className="aspect-[3/4] w-full rounded-lg bg-slate-100 overflow-hidden">
                      <img src={snap} alt="captured" className="w-full h-full object-cover" />
                    </div>
                    <div className="mt-1 text-[10px] uppercase tracking-wide text-slate-500 text-center">
                      Captured
                    </div>
                  </div>
                </div>
              ) : (
                <div className="aspect-[4/3] w-full rounded-lg bg-slate-100 overflow-hidden mb-3">
                  {photoBlob ? (
                    <img src={photoBlob} alt="enrolled" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-slate-400 text-sm">
                      No photo on file
                    </div>
                  )}
                </div>
              )}
              <div className="flex items-baseline justify-between">
                <span className="text-xs uppercase tracking-wide text-slate-500">Roll number</span>
                <span className="text-lg font-semibold text-slate-900 tabular-nums">
                  {candidate.roll_no}
                </span>
              </div>
              {faceResult && (
                <div className="mt-3 text-xs text-slate-600 flex items-baseline justify-between">
                  <span className="uppercase tracking-wide text-slate-500">Face match</span>
                  {/* Numeric score removed — operators get pass/fail;
                      raw match figures were internal debugging visible
                      to the field. */}
                  <span className={`font-semibold tabular-nums ${faceResult.ok ? 'text-emerald-700' : 'text-rose-700'}`}>
                    {faceResult.ok ? 'PASS' : 'FAIL'}
                  </span>
                </div>
              )}

              {/* Compact per-modality status rows. Mirror the FACE MATCH
                  row above so the whole card reads as one "biometric
                  summary" — small, dense, no cartoon tiles. We tried
                  enrolled/captured pairs for FP + Iris but there's no
                  real image on either side (no server-side FP photo, no
                  UI-side capture image); the pair metaphor only makes
                  sense for face. Status pills are all the operator
                  actually needs to see. */}
              {candidate?.requires_fp && (
                <ModalityStatusRow
                  label="Fingerprint"
                  state={
                    fpResult
                      ? (fpResult.ok ? 'pass' : 'fail')
                      : (step >= S_FINGERPRINT ? 'active' : 'pending')
                  }
                />
              )}
              {candidate?.requires_iris && (
                <ModalityStatusRow
                  label="Iris"
                  state={
                    irisResult
                      ? (irisResult.galleryMissing ? 'audit' : (irisResult.ok ? 'pass' : 'fail'))
                      : (step >= S_FINGERPRINT ? 'active' : 'pending')
                  }
                />
              )}
            </CardBody>
          </Card>

          {/* Right column. Outer container always stacks (space-y-3).
              When BOTH fp + iris are required, the FP + Iris capture
              cards are wrapped in a nested `lg:grid-cols-2` row so they
              stay locked side-by-side regardless of step / result
              state. The Result card, when it appears, renders BELOW
              that row at full column-2 width. Single-modality exams
              render the single required card inline. */}
          <div className="lg:col-span-2 space-y-3">

            {(() => {
              // Compute once — both required and both actually
              // capturable (gallery on file for each). When true, FP
              // + Iris cards are wrapped in a nested 2-col grid so
              // they stay locked side-by-side across capture, result
              // landing, and step transitions. When false (single-
              // modality exam OR one gallery missing), just render
              // whichever card applies inline.
              const bothSideBySide =
                step >= S_FINGERPRINT &&
                !!candidate?.requires_fp && !!candidate?.has_iso_template &&
                !!candidate?.requires_iris && !!candidate?.has_iris_bytes
              const fpCard = step >= S_FINGERPRINT && !!candidate?.requires_fp && !!candidate?.has_iso_template && (
                <Card>
                  <CardHeader>
                    <CardTitle>Step 3 — Fingerprint scan</CardTitle>
                  </CardHeader>
                  <CardBody>
                    {gallery ? (
                      <FingerprintCapture
                        rollNo={candidate.roll_no}
                        galleryTemplate={gallery.template_b64}
                        galleryFormat={gallery.format}
                        onResult={(r) => {
                          // Do NOT bump step to S_RESULT here — the
                          // auto-submit useEffect flips it only when
                          // every required modality has a result.
                          setFpResult(r)
                        }}
                      />
                    ) : (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                        No fingerprint template on file for this candidate. Proceed with manual verification.
                        <div className="mt-3">
                          <Button onClick={() => step < S_RESULT && setStep(S_RESULT)}>Skip fingerprint step</Button>
                        </div>
                      </div>
                    )}
                  </CardBody>
                </Card>
              )
              const irisCard = step >= S_FINGERPRINT && !!candidate?.requires_iris && !!candidate?.has_iris_bytes && (
                <Card>
                  <CardHeader>
                    <CardTitle>Iris capture</CardTitle>
                  </CardHeader>
                  <CardBody>
                    <IrisCapture
                      rollNo={candidate?.roll_no}
                      matchThreshold={50}
                      onResult={(r) => {
                        setIrisResult(r)
                      }}
                    />
                  </CardBody>
                </Card>
              )
              return bothSideBySide ? (
                <div className="grid gap-3 lg:grid-cols-2 items-start">
                  {fpCard}
                  {irisCard}
                </div>
              ) : (
                <>
                  {fpCard}
                  {irisCard}
                </>
              )
            })()}

            {step >= S_RESULT && (
              <Card>
                <CardHeader>
                  <CardTitle>Step 4 — Result</CardTitle>
                </CardHeader>
                <CardBody>
                  {result ? (
                    <div
                      className={`rounded-lg border p-4 ${
                        result === 'verified'
                          ? 'border-emerald-200 bg-emerald-50'
                          : 'border-rose-200 bg-rose-50'
                      }`}
                    >
                      <p
                        className={`text-base font-semibold ${
                          result === 'verified' ? 'text-emerald-800' : 'text-rose-800'
                        }`}
                      >
                        Candidate {result === 'verified' ? 'VERIFIED' : 'NOT VERIFIED'}
                      </p>
                      <p className="text-sm text-slate-600 mt-1">
                        Decision recorded for roll {candidate.roll_no}.
                      </p>
                      <div className="mt-3 text-xs text-slate-600 space-y-0.5">
                        {faceResult && (
                          <div>Face match: <b className={faceResult.ok ? 'text-emerald-700' : 'text-rose-700'}>{faceResult.ok ? 'PASS' : 'FAIL'}</b></div>
                        )}
                        {fpResult && (
                          <div>Fingerprint: <b className={fpResult.ok ? 'text-emerald-700' : 'text-rose-700'}>{fpResult.ok ? 'PASS' : 'FAIL'}</b></div>
                        )}
                        {irisResult && !irisResult.galleryMissing && (
                          <div>Iris: <b className={irisResult.ok ? 'text-emerald-700' : 'text-rose-700'}>{irisResult.ok ? 'PASS' : 'FAIL'}</b></div>
                        )}
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <Button onClick={reset}>Next verification</Button>
                        {verificationId && (
                          <>
                            <Button
                              variant="secondary"
                              onClick={() => printVerificationPDF(verificationId)}
                            >
                              Print PDF
                            </Button>
                            <Button
                              variant="secondary"
                              onClick={() => downloadVerificationPDF(verificationId)}
                            >
                              Download PDF
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  ) : (
                    <>
                      {lookupErr && (
                        <div className="mb-3 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
                          {lookupErr}
                        </div>
                      )}
                      <div className="flex items-center gap-3 text-sm text-slate-600">
                        <span className="inline-block h-3 w-3 rounded-full bg-indigo-500 animate-pulse" />
                        {submitting ? 'Recording verification…' : 'Finalising decision…'}
                      </div>
                    </>
                  )}
                </CardBody>
              </Card>
            )}
          </div>
        </div>
      )}

      {step === 0 && !candidate && (
        <div className="mt-10">
          <EmptyState
            title="No active verification"
            body="Enter a candidate roll number above to begin."
          />
        </div>
      )}

      <ExamWindowReminderModal
        open={Boolean(windowReminder)}
        onClose={() => setWindowReminder(null)}
        {...windowReminder}
      />
    </AppShell>
  )
}

// WalletPill — operator-scoped allocation chip in the header.
//
// Prefers the operator's PERSONAL allocation (cap - spent) when a cap
// has been set by the admin. Falls back to the shared org wallet
// balance when the operator is uncapped -- the admin can still see
// the shared pool that way.
//
// Color states based on remaining lookups (remaining / fee):
//   >= 100 lookups   → slate (plenty of runway)
//   30 - 99 lookups  → amber (heads-up)
//   <  30 lookups    → rose (ask admin to raise the cap or top up)
// ModalityStatusRow — compact status line for fingerprint / iris in
// the "Candidate on file" card. Mirrors the FACE MATCH row's exact
// visual (uppercase label left, coloured status right) so the summary
// reads as one dense strip instead of a stack of card-shaped tiles.
//
// state:
//   'pending' → slate "Waiting" (before capture starts)
//   'active'  → indigo "Capturing…" (while operator is capturing)
//   'pass'    → emerald "PASS"
//   'fail'    → rose "FAIL"
//   'audit'   → amber "AUDIT" (iris capture with no enrolled template)
function ModalityStatusRow({ label, state }) {
  const tone = ({
    pending: { fg: 'text-slate-500',  text: 'Waiting',    pulse: false },
    active:  { fg: 'text-indigo-600', text: 'Capturing…', pulse: true  },
    pass:    { fg: 'text-emerald-700',text: 'PASS',       pulse: false },
    fail:    { fg: 'text-rose-700',   text: 'FAIL',       pulse: false },
    audit:   { fg: 'text-amber-800',  text: 'AUDIT',      pulse: false },
  })[state] || { fg: 'text-slate-500', text: '—', pulse: false }
  return (
    <div className="mt-2 text-xs text-slate-600 flex items-baseline justify-between">
      <span className="uppercase tracking-wide text-slate-500">{label}</span>
      <span className={`font-semibold tabular-nums ${tone.fg} ${tone.pulse ? 'animate-pulse' : ''}`}>
        {tone.text}
      </span>
    </div>
  )
}

function WalletPill({ wallet }) {
  if (!wallet) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500">
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" /><path d="M3 5v14a2 2 0 0 0 2 2h16v-5" /><path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
        </svg>
        Wallet…
      </span>
    )
  }
  const fee = wallet.fee_per_lookup_paise || 100
  const capPaise = wallet.cap_paise
  const spent = wallet.spent_paise || 0
  const orgBal = wallet.org_balance_paise || 0

  // Per-op mode when the admin set a cap; otherwise fall back to the
  // shared-wallet view.
  const capped = typeof capPaise === 'number' && capPaise > 0
  const remaining = capped ? Math.max(0, capPaise - spent) : orgBal
  const lookupsLeft = Math.floor(remaining / Math.max(fee, 1))
  const label = capped ? 'Your allocation' : 'Shared wallet'

  let tone = 'slate'
  if (lookupsLeft < 30) tone = 'rose'
  else if (lookupsLeft < 100) tone = 'amber'
  const toneClass = {
    slate: 'border-slate-200 bg-slate-50 text-slate-700',
    amber: 'border-amber-300 bg-amber-50 text-amber-900',
    rose:  'border-rose-300 bg-rose-50 text-rose-900',
  }[tone]
  const iconTone = { slate: 'text-slate-500', amber: 'text-amber-600', rose: 'text-rose-600' }[tone]

  const title = capped
    ? (lookupsLeft > 0
        ? `${label}: ${formatRupees(remaining)} left of ${formatRupees(capPaise)} (spent ${formatRupees(spent)}) · ~${lookupsLeft} lookups at ${formatRupees(fee)} each. Ask your admin to raise your cap if this runs low.`
        : `You've used your entire ${formatRupees(capPaise)} allocation. Ask your admin to raise your cap before running more verifications.`)
    : (lookupsLeft > 0
        ? `No personal cap set — spending against the shared org wallet (${formatRupees(orgBal)}). Ask your admin to set your own allocation for tighter control.`
        : `Org wallet empty. Ask your admin to top up before running more verifications.`)

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium ${toneClass}`} title={title}>
      <svg className={`h-4 w-4 ${iconTone}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" /><path d="M3 5v14a2 2 0 0 0 2 2h16v-5" /><path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
      </svg>
      <span className="text-xs opacity-70">{label}</span>
      <span>{formatRupees(remaining)}</span>
      <span className="text-xs opacity-75">· {lookupsLeft} left</span>
    </span>
  )
}

// Compact chip-row picker for the multi-exam operator. Renders one
// pill per assigned exam; the currently-selected one gets the filled
// treatment. Sits directly under the stepper so it reads as part of
// the "which context am I in" strip.
function ExamPicker({ exams, currentId, onChange }) {
  return (
    <Card className="mb-3 border-slate-200 bg-white">
      <CardBody className="py-3">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 shrink-0 flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" />
            Verifying for
          </div>
          <div className="flex flex-wrap gap-1.5">
            {exams.map((e) => {
              const active = String(e.id) === String(currentId)
              return (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => onChange(e.id)}
                  className={[
                    'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                    active
                      ? 'bg-stone-900 text-white border-stone-900'
                      : 'bg-white text-slate-700 border-slate-200 hover:border-slate-400',
                  ].join(' ')}
                  title={`${e.name} (${e.exam_code}) — ${e.candidate_count.toLocaleString()} candidates`}
                >
                  <span>{e.name}</span>
                  <span className={active ? 'text-white/70' : 'text-slate-400'}>·</span>
                  <span className="tabular-nums">{e.exam_code}</span>
                  {active && (
                    <svg className="h-3 w-3 -mr-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="5 12 10 17 20 7" />
                    </svg>
                  )}
                </button>
              )
            })}
          </div>
          {!currentId && (
            <span className="text-xs text-rose-700 font-medium">Pick one to unlock lookup</span>
          )}
        </div>
      </CardBody>
    </Card>
  )
}
