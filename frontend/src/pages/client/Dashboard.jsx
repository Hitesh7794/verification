import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import AppShell from '../../components/shell/AppShell.jsx'
import ExamWindowReminderModal from '../../components/verify/ExamWindowReminderModal.jsx'
import { BrandMark } from '../../components/ui/brand.jsx'
import {
  api,
  fetchFPTemplate,
  fetchPhotoBlob,
  isWalletEmptyError,
  getCandidateAttempts,
  downloadVerificationPDF,
  printVerificationPDF,
  postFaceMatch,
  getCurrentExamId,
  setCurrentExamId,
  postLivenessClientVerified,
  postIrisMatch,
} from '../../lib/api.js'
import { getWalletSummary, formatRupees } from '../../lib/wallet/wallet.js'
import ntaLogo from '../../assets/nta-logo.png'
import emblemSvg from '../../assets/emblem.svg'
import ntaWatermark from '../../assets/nta-watermark.png'
// Real biometric-vendor SDKs. The mock capture handlers below used to
// fake progress bars and hardcode device serials; the SDKs plumb the
// actual USB scanner + local daemon on the operator laptop and post
// the captured probe to the backend's match orchestrator.
import { pollConnected, DefaultThresholds } from '../../lib/verify/fingerprint/registry.js'
import { tmpFormatFromString } from '../../lib/verify/morfin.js'
import { iris as irisSdk, IrisError, isIrisServiceReachable } from '../../lib/verify/iris.js'

function newIdempotencyKey() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return 'k-' + Date.now() + '-' + Math.random().toString(36).slice(2)
}

const APP_VERSION = '0.2.0'
const STATE_KEY = 'nv_verify_state_v1'

function loadPersistedState() {
  try {
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
  try {
    sessionStorage.setItem(STATE_KEY, JSON.stringify(state))
  } catch {}
}

function clearPersistedState() {
  try {
    sessionStorage.removeItem(STATE_KEY)
  } catch {}
}

// Biometric glyphs sharing the login page's detection frames, loop ridges, and iris optics
function InteractiveFingerprintGlyph({ status, size = 64 }) {
  const isPass = status === 'pass'
  const isFail = status === 'fail'
  const isScanning = status === 'scanning'

  const strokeColor = isPass
    ? '#0F6B45'
    : isFail
    ? '#DC2626'
    : isScanning
    ? '#0B4F8F'
    : '#94A3B8'

  const frameColor = isPass
    ? '#0F6B45'
    : isFail
    ? '#DC2626'
    : isScanning
    ? '#0B4F8F'
    : '#94A3B8'

  const ridges = [
    { d: 'M12.4 35.2C11.1 22.4 15.4 12.4 24 12.4s12.9 10 11.6 22.8', len: 57.6, delay: '0s' },
    { d: 'M16.1 35.6C15.3 25.2 18.5 17.6 24 17.6s8.7 7.6 7.9 18', len: 43.5, delay: '0.12s' },
    { d: 'M19.6 35.8C19.2 28.4 20.8 22.8 24 22.8s4.8 5.6 4.4 13', len: 29.7, delay: '0.24s' },
    { d: 'M22.1 33.6c-.4-4.2.4-7.2 1.9-7.2s2.3 3 1.9 7.2', len: 16, delay: '0.36s' },
  ]

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className="overflow-visible transition-all duration-200"
      fill="none"
    >
      {/* Corner Detection Frame */}
      <g
        stroke={frameColor}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={isScanning ? 'animate-pulse' : ''}
      >
        <path d="M4 15V8.6A4.6 4.6 0 0 1 8.6 4H15" />
        <path d="M33 4h6.4A4.6 4.6 0 0 1 44 8.6V15" />
        <path d="M44 33v6.4a4.6 4.6 0 0 1-4.6 4.6H33" />
        <path d="M15 44H8.6A4.6 4.6 0 0 1 4 39.4V33" />
      </g>

      {/* Scaled Fingerprint Ridges */}
      <g transform="translate(24 21) scale(0.92) translate(-24 -24)">
        {/* Resting Print */}
        <g stroke={strokeColor} strokeWidth="1.6" strokeLinecap="round" fill="none" opacity={isScanning ? 0.35 : 0.85}>
          {ridges.map((r) => (
            <path key={r.d} d={r.d} />
          ))}
          <path d="M27.9 31.2c.5-2.8.4-5.2-.2-7" />
          <path d="M20.4 20.4c-1.3 1.5-2.2 3.5-2.6 5.9" />
        </g>

        {/* Dynamic Scanning Read Wave */}
        {isScanning && (
          <g stroke="#0B4F8F" strokeWidth="1.9" strokeLinecap="round" fill="none">
            {ridges.map((r) => (
              <path
                key={r.d}
                d={r.d}
                style={{
                  strokeDasharray: r.len,
                  strokeDashoffset: r.len,
                  animation: `bio-draw 1.4s ease-in-out infinite ${r.delay}`,
                }}
              />
            ))}
          </g>
        )}
      </g>

      {/* Verification Checkmark (Pass) */}
      {isPass && (
        <path
          d="M18.8 35.4l3.4 3.4 7-7.2"
          stroke="#0F6B45"
          strokeWidth="2.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}

      {/* Verification Cross (Fail) */}
      {isFail && (
        <path
          d="M20 31l8 8M28 31l-8 8"
          stroke="#DC2626"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  )
}

function InteractiveIrisGlyph({ status, size = 64 }) {
  const isPass = status === 'pass'
  const isFail = status === 'fail'
  const isScanning = status === 'scanning'

  const strokeColor = isPass
    ? '#0F6B45'
    : isFail
    ? '#DC2626'
    : isScanning
    ? '#0B4F8F'
    : '#94A3B8'

  const frameColor = isPass
    ? '#0F6B45'
    : isFail
    ? '#DC2626'
    : isScanning
    ? '#0B4F8F'
    : '#94A3B8'

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className="overflow-visible transition-all duration-200"
      fill="none"
    >
      {/* Corner Detection Frame */}
      <g
        stroke={frameColor}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={isScanning ? 'animate-pulse' : ''}
      >
        <path d="M4 15V8.6A4.6 4.6 0 0 1 8.6 4H15" />
        <path d="M33 4h6.4A4.6 4.6 0 0 1 44 8.6V15" />
        <path d="M44 33v6.4a4.6 4.6 0 0 1-4.6 4.6H33" />
        <path d="M15 44H8.6A4.6 4.6 0 0 1 4 39.4V33" />
      </g>

      {/* Scaled Iris Aperture & Measuring Ring */}
      <g transform="translate(24 21) scale(0.86) translate(-24 -24)">
        {/* Eye contour aperture */}
        <path
          d="M9 24c3.9-5.8 9-8.8 15-8.8S35.1 18.2 39 24c-3.9 5.8-9 8.8-15 8.8S12.9 29.8 9 24Z"
          stroke={strokeColor}
          strokeWidth="1.8"
          strokeLinejoin="round"
          opacity={0.9}
        />

        {/* Pulse Ring */}
        <circle
          cx="24"
          cy="24"
          r="7.6"
          stroke={strokeColor}
          strokeWidth="1.4"
          fill="none"
          opacity={isScanning ? 0.7 : 0.25}
          className={isScanning ? 'animate-ping' : ''}
          style={isScanning ? { transformOrigin: '24px 24px' } : {}}
        />

        {/* Measuring Dashed Ring */}
        <circle
          cx="24"
          cy="24"
          r="6"
          stroke={strokeColor}
          strokeWidth="1.8"
          fill="none"
          strokeDasharray="3.8 3.8"
          strokeLinecap="round"
          className={isScanning ? 'animate-spin' : ''}
          style={isScanning ? { transformOrigin: '24px 24px', animationDuration: '2.4s' } : {}}
        />

        {/* Pupil */}
        <circle cx="24" cy="24" r="2.4" fill={strokeColor} />
      </g>

      {/* Verification Checkmark (Pass) */}
      {isPass && (
        <path
          d="M18.8 35.4l3.4 3.4 7-7.2"
          stroke="#0F6B45"
          strokeWidth="2.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}

      {/* Verification Cross (Fail) */}
      {isFail && (
        <path
          d="M20 31l8 8M28 31l-8 8"
          stroke="#DC2626"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  )
}

// One row on the Stage-4 receipt for a single biometric modality.
// Three states: matched (green), skipped (grey, "NOT CAPTURED"), or
// failed (rose, "NOT MATCHED"). Keeps the certificate honest — a
// hardcoded "VERIFIED (MATCHED)" was the previous bug that made a
// clearly-failed face read as passing.
function ModalityRow({ label, matched, skipped, error }) {
  if (matched) {
    return (
      <div className="p-2.5 rounded-lg bg-[#E8F5EE] border border-[#B4DCC7] text-[#0F6B45] flex justify-between items-center font-semibold">
        <span className="flex items-center gap-1.5">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7" />
          </svg>
          {label}:
        </span>
        <span>VERIFIED (MATCHED)</span>
      </div>
    )
  }
  if (skipped) {
    return (
      <div className="p-2.5 rounded-lg bg-slate-100 border border-slate-200 text-slate-600 flex justify-between items-center font-semibold">
        <span className="flex items-center gap-1.5">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="9" strokeWidth="2" />
            <path strokeLinecap="round" strokeWidth="2" d="M8 12h8" />
          </svg>
          {label}:
        </span>
        <span>NOT CAPTURED</span>
      </div>
    )
  }
  return (
    <div className="p-2.5 rounded-lg bg-[#FBEAEC] border border-[#EFC0C7] text-[#DC2626] flex justify-between items-center font-semibold">
      <span className="flex items-center gap-1.5">
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9" strokeWidth="2" />
          <path strokeLinecap="round" strokeWidth="2" d="M9 9l6 6M15 9l-6 6" />
        </svg>
        {label}:
      </span>
      <span>{error ? 'NOT MATCHED' : 'NOT MATCHED'}</span>
    </div>
  )
}

export default function ClientDashboard() {
  // Reload safety: `candidate` is never persisted (contains a photo
  // blob among other bulky/session-bound fields), so if the operator
  // reloads mid-flow we came back with `roll` + `currentStage`
  // restored but no candidate object. That rendered the search card
  // AND the Stage-2 canvas at the same time — the "glitchy" reload
  // state. Simplest safe recovery: drop the persisted flow entirely
  // when the persisted stage is beyond the search step, so the
  // operator re-enters the roll and starts fresh. No wallet
  // double-debit that way either.
  const rawPersisted = loadPersistedState()
  const staleReload  = (rawPersisted?.currentStage ?? 0) > 0
  if (staleReload) {
    clearPersistedState()
  }
  const persisted = staleReload ? null : rawPersisted

  // Stage state: 0 (Standby), 1 (Retrieved Record), 2 (Liveness/Face), 3 (Biometrics FP+Iris), 4 (Final Certificate)
  const [currentStage, setCurrentStage] = useState(persisted?.currentStage ?? 0)
  const [roll, setRoll] = useState(persisted?.roll ?? '')
  const [candidate, setCandidate] = useState(null)
  const [photoBlob, setPhotoBlob] = useState(null)
  const [gallery, setGallery] = useState(null)
  const [attempts, setAttempts] = useState(null)
  const [lookupErr, setLookupErr] = useState('')
  const [isSearching, setIsSearching] = useState(false)
  
  // Face & Liveness
  const [snap, setSnap] = useState(persisted?.snap ?? null)
  const [faceResult, setFaceResult] = useState(persisted?.faceResult ?? null)
  const [livenessResult, setLivenessResult] = useState(null)
  const [livenessPassing, setLivenessPassing] = useState(false)
  const [livenessPassed, setLivenessPassed] = useState(false)
  // Distinct from livenessPassed. `livenessOK` = the server-side liveness
  // gate row was successfully written (blink + Luxand pass); it survives
  // a face-match miss so the sidebar's "LIVENESS CHECK" reads PASS and
  // the camera can shut off. `livenessPassed` on the other hand tracks
  // the entire liveness+face stage and only flips true when face-match
  // also clears — that's what gates the "Proceed to Biometric Scan"
  // button and the stage-advance.
  const [livenessOK, setLivenessOK] = useState(false)
  const [livenessConfidence, setLivenessConfidence] = useState('0%')
  const [faceDetected, setFaceDetected] = useState(false)
  const [faceOrientationStatus, setFaceOrientationStatus] = useState('LOOK AT CAMERA')
  const [blinkState, setBlinkState] = useState('LOOK AT CAMERA')
  const [blinkProgress, setBlinkProgress] = useState(15)
  const [livenessError, setLivenessError] = useState('')
  
  // Biometrics
  const [fpStatus, setFpStatus] = useState('idle') // 'idle' | 'scanning' | 'pass' | 'fail'
  const [fpScore, setFpScore] = useState(0)
  const [fpResult, setFpResult] = useState(persisted?.fpResult ?? null)
  
  const [irisStatus, setIrisStatus] = useState('idle') // 'idle' | 'scanning' | 'pass' | 'fail'
  const [irisResult, setIrisResult] = useState(persisted?.irisResult ?? null)
  

  // Video / Live Stream
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const [cameraActive, setCameraActive] = useState(false)
  // livenessArmed = the operator has explicitly clicked "Capture &
  // Verify Face". Before this the camera is open + streaming but
  // MediaPipe (window.seqrFaceGuide) is NOT running — so the blink-
  // detection status pills stay neutral instead of racing to
  // "BLINK DETECTED — READY" the instant the operator glances at
  // the lens. The MediaPipe detector starts here on click and
  // fires the burst capture when it sees the first real blink.
  const [livenessArmed, setLivenessArmed] = useState(false)

  // Submitting & Verification
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState(null)
  const [verificationId, setVerificationId] = useState(null)
  const [verificationStartedAt, setVerificationStartedAt] = useState(persisted?.verificationStartedAt ?? null)
  const [idempotencyKey, setIdempotencyKey] = useState(persisted?.idempotencyKey ?? null)
  const [walletEmpty, setWalletEmpty] = useState(false)
  const [windowReminder, setWindowReminder] = useState(null)

  // Wallet
  const [wallet, setWallet] = useState(null)
  const refreshWallet = () => {
    getWalletSummary().then(setWallet).catch(() => {})
  }
  useEffect(() => {
    // Initial pull, then a light heartbeat every 20s so the header
    // pill catches any debit that happened outside this tab (another
    // operator on the same wallet, an admin top-up, refund reversal
    // from support tooling, etc.). 20s is far below face-match cadence
    // yet cheap enough not to matter for a single-operator laptop.
    refreshWallet()
    const id = setInterval(refreshWallet, 20_000)
    return () => clearInterval(id)
  }, [])

  // Exams
  const [assignedExams, setAssignedExams] = useState([])
  const [currentExamId, setCurrentExamIdState] = useState(() => getCurrentExamId())
  
  useEffect(() => {
    api('/operator/exams')
      .then((r) => {
        const list = r?.exams || []
        setAssignedExams(list)
        const stored = getCurrentExamId()
        if (stored && !list.some((e) => String(e.id) === String(stored))) {
          setCurrentExamId(null)
          setCurrentExamIdState(null)
        }
        if (list.length === 1 && !getCurrentExamId()) {
          setCurrentExamId(list[0].id)
          setCurrentExamIdState(String(list[0].id))
          refreshWallet()
        }
      })
      .catch(() => setAssignedExams([]))
  }, [])

  // Exam countdown timer was removed 2026-09-14 — the header pill is
  // gone, so this state + heartbeat aren't wired to anything any more.

  // Persist State
  useEffect(() => {
    if (currentStage === 0 && !roll && !candidate && !faceResult && !fpResult) {
      clearPersistedState()
      return
    }
    persistState({
      currentStage,
      roll,
      faceResult,
      fpResult,
      irisResult,
      verificationStartedAt,
      idempotencyKey,
      snap,
    })
  }, [currentStage, roll, faceResult, fpResult, irisResult, verificationStartedAt, idempotencyKey, candidate, snap])

  // Camera stream — kept alive only while (currentStage === 2 &&
  // !livenessOK). Deliberately does NOT start MediaPipe here: the
  // client-side blink detector runs in the separate effect below
  // that fires ONLY after the operator explicitly clicks
  // "Capture & Verify Face" (see livenessArmed). Before that click
  // the camera shows a raw preview with no blink guidance racing
  // ahead — matches the "liveness runs after the button, not
  // before" flow the operator asked for.
  useEffect(() => {
    if (currentStage === 2 && !livenessOK) {
      let stream = null
      let isMounted = true

      async function startCam() {
        try {
          if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            stream = await navigator.mediaDevices.getUserMedia({
              video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
              audio: false,
            })
            if (!isMounted) {
              stream.getTracks().forEach((t) => t.stop())
              return
            }
            streamRef.current = stream
            if (videoRef.current) {
              videoRef.current.srcObject = stream
              videoRef.current.onloadedmetadata = () => {
                if (videoRef.current && isMounted) {
                  videoRef.current.play().catch(() => {})
                  setCameraActive(true)
                  setFaceDetected(true)
                }
              }
              videoRef.current.play().catch(() => {})
              setCameraActive(true)
              setFaceDetected(true)
            }
          }
        } catch (e) {
          console.warn('Webcam stream unavailable:', e)
          if (isMounted) {
            setCameraActive(true)
            setFaceDetected(true)
            setLivenessError('')
          }
        }
      }

      startCam()

      return () => {
        isMounted = false
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((t) => t.stop())
          streamRef.current = null
        }
        setCameraActive(false)
      }
    }
  }, [currentStage, idempotencyKey, candidate, livenessOK])

  // MediaPipe blink detector — starts ONLY once livenessArmed flips
  // true (via the "Capture & Verify Face" click). Before that the
  // detector is dormant and the "Blink Detection" pill stays neutral.
  // On blink the callback grabs the burst + POSTs + runs face-match,
  // then dis-arms so a second blink doesn't retrigger.
  useEffect(() => {
    if (!(currentStage === 2 && livenessArmed && !livenessOK)) return
    let isMounted = true
    if (!window.seqrFaceGuide) {
      // No detector available — the manual button in handleCaptureLiveness
      // still fires completeLivenessPass directly, so we don't need to
      // block the flow here.
      return
    }
    try {
      window.seqrFaceGuide.start(
        // 1st param: onStatus(state, level) — guidance HUD updates.
        (state, level) => {
          if (!isMounted) return
          if (state === '__error__') {
            setFaceDetected(true)
            setFaceOrientationStatus('OPTIMAL')
            setBlinkState('PLEASE BLINK ONCE')
            setLivenessConfidence('80%')
            return
          }
          if (state === 'blink') {
            setFaceDetected(true)
            setFaceOrientationStatus('OPTIMAL')
            setBlinkState('PLEASE BLINK ONCE')
            setLivenessConfidence('90%')
            setBlinkProgress(85)
            setLivenessError('')
          } else if (state === 'hold') {
            setFaceDetected(true)
            setFaceOrientationStatus('OPTIMAL')
            setBlinkState('HOLD STILL')
            setLivenessConfidence('80%')
            setBlinkProgress(65)
            setLivenessError('')
          } else if (state === 'closer') {
            setFaceDetected(true)
            setFaceOrientationStatus('MOVE CLOSER')
            setBlinkState('MOVE A BIT CLOSER')
            setLivenessConfidence('50%')
            setBlinkProgress(40)
            setLivenessError('')
          } else if (state === 'back') {
            setFaceDetected(true)
            setFaceOrientationStatus('STEP BACK')
            setBlinkState('STEP A BIT BACK')
            setLivenessConfidence('50%')
            setBlinkProgress(40)
            setLivenessError('')
          } else if (state === 'center') {
            if (level === 'none') {
              setFaceDetected(false)
              setFaceOrientationStatus('LOOK AT CAMERA')
              setBlinkState('LOOK AT CAMERA')
              setLivenessConfidence('30%')
              setBlinkProgress(20)
            } else {
              setFaceDetected(true)
              setFaceOrientationStatus('CENTER FACE')
              setBlinkState('KEEP HEAD CENTERED')
              setLivenessConfidence('60%')
              setBlinkProgress(50)
              setLivenessError('')
            }
          }
        },
        // 2nd param: onBlink — fires when the detector sees a real
        // blink. Since livenessArmed is what gated this effect, the
        // operator has already clicked the button — so it's now safe
        // to advance the flow. Stop the detector first so a second
        // blink during the same burst doesn't retrigger, then run
        // the burst POST + face-match.
        () => {
          if (!isMounted) return
          setBlinkState('BLINK DETECTED — CAPTURING')
          setBlinkProgress(90)
          setLivenessConfidence('99%')
          try { window.seqrFaceGuide?.stop?.() } catch (_) {}
          completeLivenessPass()
        }
      )
    } catch (e) {
      console.warn('Face guide error:', e)
      setFaceDetected(true)
    }
    return () => {
      isMounted = false
      try { window.seqrFaceGuide?.stop?.() } catch (_) {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStage, livenessArmed, livenessOK])

  // Check if biometrics complete (either or both verified)
  // Dynamic modality — a candidate is only required to clear the
  // biometric checks that were actually enrolled for them. The backend
  // returns has_photo / has_fp_image / has_iris_bytes on the candidate
  // lookup so we can drive the UI off the same source of truth. If the
  // enrolment CSV only carried a face photo, the operator never sees
  // fingerprint or iris bays; if it carried face + fingerprint, iris
  // stays hidden, and so on.
  const hasEnrolledFace        = !!candidate?.has_photo
  // Backend surfaces two fingerprint flags:
  //   has_iso_template — the ISO 19794-2 / FMR template SourceAFIS
  //                      matches against (the enrolment CSV upload).
  //   has_fp_image     — a raw BMP fingerprint image (legacy path).
  // Either one is enough to say the candidate has fingerprint on file,
  // so accept both. This is what the pre-Rahul dashboard did.
  const hasEnrolledFingerprint = !!candidate?.has_iso_template || !!candidate?.has_fp_image
  const hasEnrolledIris        = !!candidate?.has_iris_bytes
  const needsBiometric         = hasEnrolledFingerprint || hasEnrolledIris

  const isBiometricComplete = () => {
    // No fp/iris enrolled → nothing to prove at stage 3.
    if (!needsBiometric) return true
    // Every enrolled modality must PASS. Matches the pre-Rahul
    // dashboard's strict-AND submit logic. Any enrolled modality
    // still awaiting a capture (idle/scanning) keeps the biometric
    // stage locked so the operator can't advance a half-done row.
    const fpDone   = !hasEnrolledFingerprint || fpStatus   === 'pass'
    const irisDone = !hasEnrolledIris        || irisStatus === 'pass'
    return fpDone && irisDone
  }

  // True if any enrolled biometric explicitly failed. Drives the
  // Retake/Continue footer variant so the operator can either try
  // the scan again or push through with a denied verdict — a fail
  // must NEVER be a dead end that traps them on stage 3.
  const anyEnrolledFailed = () => {
    const fpFailed   = hasEnrolledFingerprint && fpStatus   === 'fail'
    const irisFailed = hasEnrolledIris        && irisStatus === 'fail'
    return fpFailed || irisFailed
  }

  // Reset the failed pods back to idle so the operator can rescan.
  // Passed pods stay passed — retake only clears the failure, not
  // the modalities that already matched.
  function retakeFailedBiometrics() {
    if (fpStatus === 'fail') {
      setFpStatus('idle')
      setFpScore(0)
      setFpResult(null)
    }
    if (irisStatus === 'fail') {
      setIrisStatus('idle')
      setIrisResult(null)
    }
  }

  // Auto-advance Stage 2 → Stage 3 once liveness + face-match have
  // both passed. Previously the operator had to click a big "Proceed
  // to Biometric Scan →" button that just moved the pipeline forward —
  // no data was captured on that click. Redundant tap on every
  // verification. A short 700 ms hold on the green "LIVENESS VERIFIED"
  // confirmation gives visual acknowledgement, then we advance.
  useEffect(() => {
    if (currentStage !== 2 || !livenessPassed) return
    const target = needsBiometric ? 3 : 4
    const id = setTimeout(() => setCurrentStage(target), 700)
    return () => clearTimeout(id)
  }, [currentStage, livenessPassed, needsBiometric])

  // Grab Live Video Frame from Webcam Viewport
  function grabLiveVideoSnapshot() {
    try {
      if (videoRef.current && (videoRef.current.videoWidth > 0 || videoRef.current.readyState >= 2)) {
        const video = videoRef.current
        const canvas = document.createElement('canvas')
        canvas.width = video.videoWidth || 640
        canvas.height = video.videoHeight || 480
        const ctx = canvas.getContext('2d')
        ctx.translate(canvas.width, 0)
        ctx.scale(-1, 1)
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        return canvas.toDataURL('image/jpeg', 0.85)
      }
    } catch (_) {}
    return null
  }

  // Grab a burst of raw base64 JPEGs from the webcam so we can send it
  // to /api/candidates/:roll/liveness-client-verified. The backend rejects
  // an empty frames array (it wants Luxand to do a passive anti-spoof
  // pass on top of the client's MediaPipe blink challenge), so we take
  // ~15 frames at ~90ms intervals here — matches the burst size the
  // web SPA used to send. Strips the data-URL prefix that
  // grabLiveVideoSnapshot bakes in so the wire payload is a bare
  // base64 body per frame, which is what the Luxand client expects.
  async function grabLiveVideoBurst(count = 15, intervalMs = 90) {
    const frames = []
    for (let i = 0; i < count; i++) {
      const dataUrl = grabLiveVideoSnapshot()
      if (dataUrl && dataUrl.startsWith('data:image/')) {
        const comma = dataUrl.indexOf(',')
        if (comma > 0) frames.push(dataUrl.slice(comma + 1))
      }
      // Await between frames so the video element actually advances.
      if (i < count - 1) {
        await new Promise((r) => setTimeout(r, intervalMs))
      }
    }
    return frames
  }

  // Handle Candidate Roll Lookup — real backend only. No local dev
  // fixture fallback: if the exam manifest doesn't have this roll,
  // we surface the real error instead of fabricating a fake candidate.
  async function handleRollSubmit(e, customRoll) {
    if (e) e.preventDefault()
    if (isSearching || (candidate && currentStage > 0)) return
    const targetRoll = (customRoll || roll).trim()
    if (!targetRoll) return
    if (customRoll && customRoll !== roll) {
      setRoll(customRoll)
    }

    setLookupErr('')
    setWalletEmpty(false)
    setIsSearching(true)

    try {
      const c = await api(`/candidates/${encodeURIComponent(targetRoll)}`)
      if (!c || !c.roll_no) {
        throw new Error(`Candidate with roll number "${targetRoll}" not found.`)
      }

      setCandidate(c)
      setVerificationStartedAt(Date.now())
      setIdempotencyKey(newIdempotencyKey())

      try {
        const url = await fetchPhotoBlob(targetRoll)
        setPhotoBlob(url || null)
      } catch {
        setPhotoBlob(null)
      }

      if (c.has_iso_template || c.has_fp_image) {
        try {
          const tpl = await fetchFPTemplate(targetRoll)
          setGallery(tpl)
        } catch {
          setGallery(null)
        }
      }

      try {
        setAttempts(await getCandidateAttempts(targetRoll))
      } catch {
        setAttempts({ roll_no: targetRoll, count: 1 })
      }

      setCurrentStage(1)
    } catch (e) {
      setCandidate(null)
      if (isWalletEmptyError(e)) {
        setWalletEmpty(true)
      } else {
        setLookupErr(e.message || `No candidate record found for roll "${targetRoll}"`)
      }
    } finally {
      setIsSearching(false)
    }
  }

  // Complete Liveness & Face Match upon real blink or manual trigger.
  //
  // Order matters: liveness FIRST, then the still photo, then face-match.
  // The previous version grabbed the photo before the liveness POST,
  // which made the dossier tile show the "CAPTURED" candidate picture
  // while the blink challenge was still in flight — visually reads as
  // "photo taken before liveness verified", which the operator called
  // out. Now we:
  //   1. POST the liveness burst (Luxand anti-spoof on top of MediaPipe).
  //   2. Wait for the gate to pass.
  //   3. Grab a fresh snapshot — this is the shot that appears in the
  //      dossier tile.
  //   4. POST face-match against the enrolled gallery.
  async function completeLivenessPass() {
    if (livenessPassed) return
    setLivenessPassing(true)
    setBlinkState('PASSED')
    setBlinkProgress(100)
    setLivenessConfidence('99.8%')
    setFaceOrientationStatus('OPTIMAL')
    setFaceDetected(true)
    setLivenessError('')
    // Clear any stale mismatch result so the retake path doesn't
    // still render the "Retake / Continue anyway" dual buttons while
    // the new capture is in flight.
    setFaceResult(null)
    // Clear the dossier "CAPTURED" tile so the operator sees a fresh
    // capture happen at the right moment (after liveness), not the
    // ghost of the previous shot.
    setSnap(null)

    // STEP 1 — server-side liveness gate. The face-match endpoint
    // below refuses to run (412) unless a passing liveness_checks row
    // exists for this (org, roll, session_id) tuple. The burst is
    // rapid frames from the webcam so Luxand can do a passive anti-
    // spoof pass on top of the client's MediaPipe blink verdict.
    if (candidate) {
      try {
        const frames = await grabLiveVideoBurst()
        if (!frames.length) throw new Error('Could not read camera frames')
        const resp = await postLivenessClientVerified(candidate.roll_no, idempotencyKey, frames)
        // A 200 with pass:false means the server accepted the payload
        // but Luxand rejected it (today: multi-face). No liveness_checks
        // row was written and no wallet debit fired, so the face-match
        // 412 that follows is misleading — treat it as a liveness fail
        // with a specific message so the sidebar and error text agree.
        if (resp?.pass === false) {
          const msg = resp?.multi_face_rejected
            ? 'Multiple faces detected — only the candidate can be visible in frame. Please move others out of view and retry.'
            : 'Liveness check did not pass. Please retry.'
          setLivenessError(msg)
          setLivenessPassing(false)
          setLivenessPassed(false)
          setLivenessOK(false)
          setLivenessArmed(false)
          refreshWallet()
          return
        }
        // Gate row is written server-side — liveness itself has cleared
        // even if the face-match below misses. Refresh the wallet
        // right away because the backend's wallet middleware debits
        // on the liveness-verified endpoint, and the operator wants
        // to see the pill drop in real time (this used to only fire
        // at the very end of the whole flow, so the header showed a
        // stale balance until the next reload).
        setLivenessOK(true)
        refreshWallet()
      } catch (e) {
        setLivenessError(e?.body?.error || e?.message || 'Liveness step failed — please retry.')
        setLivenessPassing(false)
        setLivenessPassed(false)
        setLivenessOK(false)
        // Dis-arm the detector so the operator can click again to
        // re-run liveness; otherwise the effect thinks MediaPipe is
        // still active and won't restart it.
        setLivenessArmed(false)
        return
      }
    }

    // STEP 2 — now that liveness is verified, take the still photo
    // that will be sent for face-match AND shown in the dossier tile.
    const liveSnap = grabLiveVideoSnapshot() || photoBlob
    if (liveSnap) setSnap(liveSnap)

    // STEP 3 — real face-match against the enrolled photo. Backend
    // returns {roll_no, face_found, score, threshold, status} where
    // `status: true` means the score cleared the threshold. A miss
    // (status: false) does NOT advance the stage — the operator
    // decides via the Retake / Continue-anyway buttons below.
    if (candidate?.has_photo && liveSnap) {
      try {
        const resp = await postFaceMatch(candidate.roll_no, liveSnap, idempotencyKey)
        // Face-match POST is the wallet-chargeable event on the backend
        // (see verify_face_handlers.go). Refresh even on a miss so the
        // pill reflects the debit regardless of outcome.
        refreshWallet()
        const matched = resp?.status === true || resp?.matched === true || resp?.ok === true
        setFaceResult({ ...resp, ok: matched, snapshot: liveSnap })
        if (!matched) {
          // Miss is surfaced only by the sidebar's FAILED pill and the
          // Retake / Continue Anyway button pair — no verbose banner.
          setLivenessError('')
          setLivenessPassing(false)
          setLivenessPassed(false)
          return
        }
      } catch (e) {
        setLivenessError(e?.body?.error || e?.message || 'Face-match failed. Please retry.')
        setFaceResult({ ok: false, error: e?.message || 'face-match failed', snapshot: liveSnap })
        setLivenessPassing(false)
        setLivenessPassed(false)
        return
      }
    } else if (!candidate?.has_photo) {
      // No enrolled photo — face isn't in scope for this candidate.
      // Mark the face slot as "not required" so submit / verdict / UI
      // don't wait on it. Also skip the face-match wallet debit.
      setFaceResult({ ok: true, notRequired: true, snapshot: liveSnap })
    } else {
      setLivenessError('No live snapshot captured — try again.')
      setLivenessPassing(false)
      setLivenessPassed(false)
      return
    }

    setLivenessPassing(false)
    setLivenessPassed(true)
    setLivenessResult({ pass: true })
    refreshWallet()
  }

  // Manual Trigger Button for Capture & Verify (takes picture from camera).
  //
  // Arms the MediaPipe detector (via livenessArmed) which — the moment
  // the operator blinks — auto-fires completeLivenessPass. If the
  // MediaPipe module isn't loaded (offline / self-hosted assets 404 /
  // browser refused wasm) we fall back to running the burst capture
  // immediately so the flow still works without the client-side blink
  // gate. Backend Luxand path still gets a burst either way.
  async function handleCaptureLiveness() {
    if (livenessPassing || livenessPassed) return
    setLivenessError('')
    if (window.seqrFaceGuide) {
      // Prime the guidance HUD copy while we wait for the operator to
      // blink; the onStatus callback will overwrite it as soon as the
      // detector produces its first frame.
      setBlinkState('PLEASE BLINK ONCE')
      setBlinkProgress(30)
      setLivenessArmed(true)
      return
    }
    // No MediaPipe — go straight to the burst POST.
    await completeLivenessPass()
  }

  // Retake JUST the still photo after a face-match miss. Turns the
  // camera back on (livenessOK → false makes the useEffect restart the
  // stream) and clears the previous shot. The liveness gate row is
  // already valid for this idempotency_key so we don't need another
  // burst — the operator just clicks "Capture & Verify Face" again
  // once they've repositioned the candidate, and completeLivenessPass
  // will re-run face-match (backend's same-roll wallet cache absorbs
  // the second POST so no double debit).
  function handleRetakePhoto() {
    setLivenessError('')
    setSnap(null)
    setFaceResult(null)
    setLivenessOK(false)       // <-- restarts the camera effect
    setLivenessPassing(false)
    setLivenessPassed(false)
    // Dis-arm the MediaPipe detector so the retake reads as a fresh
    // pre-click state — the operator has to press the button again
    // for blink detection to run.
    setLivenessArmed(false)
    setBlinkState('LOOK AT CAMERA')
    setBlinkProgress(15)
  }

  // Real fingerprint capture. Talks to the vendor daemon on the operator
  // laptop (Mantra MorFin or Startek ACPL — detected at capture time),
  // triggers a scan on the USB device, and posts the resulting probe
  // template to /api/candidates/:roll/fp-match. The backend runs the
  // 1:1 SourceAFIS match and returns a score + threshold. All device
  // metadata (model, serial, template format) comes from the SDK — no
  // hardcoded strings any more.
  async function handleCaptureFingerprint() {
    if (fpStatus === 'pass' || fpStatus === 'scanning') return
    if (!candidate?.roll_no) return

    setFpStatus('scanning')
    setFpScore(0)
    setFpResult(null)

    try {
      // Detect an active vendor + device. pollConnected() returns
      // { active, serviceErrors } — active is either null (no vendor
      // daemon replied with a connected device) or a
      // { vendor, name, client, threshold, label } record naming the
      // first ready device. Object shape, not an array — the earlier
      // `(probes || []).find(...)` crashed here because Objects have
      // no `.find`.
      const { active } = await pollConnected()
      if (!active || !active.client) {
        // No physical scanner present or the vendor daemon isn't
        // running. Bounce fpStatus back to idle so the pod stays quiet
        // (not a red "Verification Failed") and surface the reason on
        // the score line.
        setFpStatus('idle')
        setFpResult({ ok: false, error: 'No fingerprint scanner detected. Please connect the device and try again.' })
        return
      }

      // Look up gallery format (Mantra needs the FMR/ANSI enum; Startek
      // ignores it) so the vendor client can wire the match call.
      let galleryFormat = 'FMR_V2005'
      try {
        const tpl = await fetchFPTemplate(candidate.roll_no)
        if (tpl?.format) galleryFormat = tpl.format
      } catch (_) { /* fall back to default */ }

      // The client's match() handles capture + local match + backend POST
      // in one round trip. Returns the vendor SDK envelope.
      const r = await active.client.match({
        rollNo: candidate.roll_no,
        format: tmpFormatFromString(galleryFormat),
      })
      const score = typeof r.MatchScore === 'number' ? r.MatchScore : Number(r.MatchScore || 0)
      const threshold = active.threshold ?? DefaultThresholds[active.vendor] ?? 50
      const passed = !!r.Status && score >= threshold

      const out = {
        ok: passed,
        score,
        threshold,
        vendor: active.vendor,
        deviceModel:  r.DeviceModel  || active.name || '',
        deviceSerial: r.DeviceSerial || '',
        quality:  r.Quality ?? null,
        nfiq:     r.Nfiq    ?? null,
        liveness: typeof r.LiveNess_Result === 'number' ? r.LiveNess_Result : null,
        templateFormat: galleryFormat,
      }
      setFpResult(out)
      setFpScore(score)
      setFpStatus(passed ? 'pass' : 'fail')
    } catch (e) {
      // Surface the reason on the pod so the operator can retry —
      // fpResult stays null so submit still refuses to advance.
      setFpStatus('fail')
      setFpResult({ ok: false, error: e?.message || 'Fingerprint capture failed' })
    }
  }

  // Real iris capture. Triggers a single-eye capture through the local
  // Marvis daemon on the operator laptop, then posts the resulting BMP
  // to /api/candidates/:roll/iris-match. The backend forwards the probe
  // to TrustView's compare API and returns the match verdict. No
  // hardcoded device strings — everything comes from the SDK response.
  async function handleCaptureIris() {
    if (irisStatus === 'pass' || irisStatus === 'scanning') return
    if (!candidate?.roll_no) return

    setIrisStatus('scanning')
    setIrisResult(null)
    try {
      // Reachability probe so an operator whose Marvis service isn't
      // running gets a specific message instead of a mysterious timeout.
      const reachable = await isIrisServiceReachable()
      if (!reachable) {
        setIrisStatus('idle')
        setIrisResult({ ok: false, error: 'Iris service unreachable. Start the Marvis daemon on this laptop and try again.' })
        return
      }
      const cap = await irisSdk.capture({ quality: 55, timeoutSec: 15 })
      if (!cap?.BitmapData) {
        throw new Error('Iris capture returned no image')
      }
      const resp = await postIrisMatch(candidate.roll_no, cap.BitmapData, {
        serial: cap.DeviceSerial || '',
        model:  cap.DeviceModel  || '',
      })
      const out = {
        ok: !!resp?.matched,
        leftScore:   typeof resp?.score     === 'number' ? resp.score     : null,
        leftQuality: typeof cap?.Quality    === 'number' ? cap.Quality    : null,
        threshold:   typeof resp?.threshold === 'number' ? resp.threshold : null,
        engine:      resp?.engine || '',
        galleryMissing: !!resp?.gallery_missing,
        deviceModel:  resp?.device_model  || cap?.DeviceModel  || '',
        deviceSerial: resp?.device_serial || cap?.DeviceSerial || '',
      }
      setIrisResult(out)
      // Treat gallery-missing as a soft pass — the audit row still
      // gets the capture but the match wasn't scoreable server-side.
      setIrisStatus(out.ok || out.galleryMissing ? 'pass' : 'fail')
    } catch (e) {
      setIrisStatus('fail')
      const msg = e instanceof IrisError ? `${e.code}: ${e.description}` : (e?.message || 'Iris capture failed')
      setIrisResult({ ok: false, error: msg })
    }
  }

  // Submit Final Verification to Backend.
  //
  // Builds a submit body that carries the ACTUAL captured scores and
  // metadata for each modality — matches the shape the pre-Rahul
  // dashboard sent, which is what the /verifications handler and the
  // PDF-report generator both expect. No hardcoded fallbacks any more;
  // if a modality wasn't captured, its columns stay unset and the
  // backend records NULL. Optionally accepts a status override
  // (e.g. 'denied' for an operator reject) — defaults to 'verified'.
  async function submitFinalVerification(overrideStatus) {
    if (submitting) return
    setSubmitting(true)
    setResult(null)

    const decisionMs = verificationStartedAt ? Date.now() - verificationStartedAt : 2400
    const fpMatched = fpStatus === 'pass'
    const irisMatched = irisStatus === 'pass'
    const faceMatched = faceResult?.ok === true

    // Strict AND on every enrolled modality — matches the pre-Rahul
    // dashboard's auto-decide logic. A candidate enrolled with
    // face+fp+iris needs ALL THREE to pass to end up "verified"; if
    // any required modality misses the verdict is "denied" so a
    // partial match can never be spoofed into a pass. Face-mismatch
    // Continue-anyway overrides show up here as faceMatched=false
    // and correctly flip the verdict to denied.
    const facePass   = !hasEnrolledFace        || faceMatched
    const fpPass     = !hasEnrolledFingerprint || fpMatched
    const irisPass   = !hasEnrolledIris        || irisMatched
    const anyModality = hasEnrolledFace || hasEnrolledFingerprint || hasEnrolledIris
    const status = overrideStatus ||
      (anyModality && facePass && fpPass && irisPass ? 'verified' : 'denied')

    let via = 'manual'
    if (status === 'verified') {
      if (fpMatched) via = 'fingerprint'
      else if (irisMatched) via = 'iris'
      else if (faceMatched) via = 'face'
    }

    const body = {
      roll_no: candidate?.roll_no || roll,
      status,
      face_match: faceMatched,
      fp_match: fpMatched,
      via,
      match_threshold: fpResult?.threshold ?? null,
      decision_ms: decisionMs,
      client_app_version: APP_VERSION,
      idempotency_key: idempotencyKey || newIdempotencyKey(),
    }
    if (fpResult) {
      Object.assign(body, {
        fp_vendor:          fpResult.vendor || null,
        device_serial:      fpResult.deviceSerial || null,
        device_model:       fpResult.deviceModel  || null,
        fp_template_format: fpResult.templateFormat || null,
        fp_quality:         fpResult.quality,
        fp_nfiq:            fpResult.nfiq,
        // Backend column is INTEGER — Mantra returns ints, SourceAFIS
        // returns doubles (215.09) that Go rejects against *int.
        // Rounding costs ~0.5 in precision on a 0..300 scale, negligible.
        fp_match_score:     typeof fpResult.score === 'number' ? Math.round(fpResult.score) : null,
        fp_liveness:        fpResult.liveness,
      })
    }
    if (irisResult) {
      Object.assign(body, {
        iris_left_score:    typeof irisResult.leftScore === 'number' ? irisResult.leftScore : null,
        iris_right_score:   typeof irisResult.rightScore === 'number' ? irisResult.rightScore : null,
        iris_left_quality:  typeof irisResult.leftQuality === 'number' ? irisResult.leftQuality : null,
        iris_right_quality: typeof irisResult.rightQuality === 'number' ? irisResult.rightQuality : null,
      })
    }
    if (faceResult && typeof faceResult.score === 'number') {
      body.face_match_score = faceResult.score
    }

    try {
      let saved
      if (verificationId) {
        saved = await api(`/verifications/${verificationId}`, { method: 'PATCH', body })
      } else {
        saved = await api('/verifications', { method: 'POST', body })
        if (saved?.id) setVerificationId(saved.id)
      }
      // Trust the server-computed status (PATCH may have flipped it
      // based on the fresh biometric flags), not the frontend's guess.
      setResult(saved?.status || status)
      setCurrentStage(4)
      clearPersistedState()
    } catch (e) {
      // Real error — surface it. Do NOT fabricate a fake verification
      // ID or mark the row verified when it never left the client. The
      // operator can retry; wallet was already charged at face-match.
      setLookupErr(e?.body?.error || e?.message || 'Could not save the verification. Please retry.')
    } finally {
      setSubmitting(false)
    }
  }

  function resetDesk() {
    if (photoBlob && typeof photoBlob === 'string' && photoBlob.startsWith('blob:')) {
      URL.revokeObjectURL(photoBlob)
    }
    setCurrentStage(0)
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
    setLivenessPassed(false)
    setLivenessOK(false)
    setLivenessPassing(false)
    setLivenessArmed(false)
    setFaceDetected(false)
    setFaceOrientationStatus('LOOK AT CAMERA')
    setBlinkState('LOOK AT CAMERA')
    setBlinkProgress(15)
    setLivenessConfidence('0%')
    setLivenessError('')
    setFpStatus('idle')
    setFpScore(0)
    setFpResult(null)
    setIrisStatus('idle')
    setIrisResult(null)
    setResult(null)
    setVerificationId(null)
    setLookupErr('')
    setVerificationStartedAt(null)
  }

  // Stepper Stage Labels
  const pipelineStepLabels = [
    'STAGE 1 OF 4: CANDIDATE LOOKUP',
    'STAGE 2 OF 4: LIVE FACE CAPTURE',
    'STAGE 2 OF 4: FACE MATCHING',
    'STAGE 3 OF 4: BIOMETRIC SCAN',
    'STAGE 4 OF 4: VERIFICATION RESULT',
  ]

  const activeStep = currentStage === 0 || currentStage === 1 ? 1 : currentStage
  const isSearchLocked = Boolean(candidate) || currentStage > 0 || isSearching

  // Custom Sovereign Verification Desk Header in signature Navy Chrome
  const renderSovereignHeader = ({ user, handleLogout, ReportProblem, AvatarMenu }) => {
    const fee = wallet?.fee_per_lookup_paise || 500
    const capPaise = wallet?.cap_paise
    const spent = wallet?.spent_paise || 0
    const orgBal = wallet?.org_balance_paise ?? 0
    const capped = typeof capPaise === 'number' && capPaise > 0
    // Personal-purse pill: only meaningful when the admin gave this
    // operator a spending_cap_paise. Then the denominator is that
    // cap and the numerator is what's left in the personal purse.
    // For an uncapped operator, `allocated` would have to be either
    // a fabricated number (past dashboards used orgBal + spent, which
    // meant "you have ₹42 left of ₹267" even though nobody ever
    // deposited ₹267 — a misleading synthesis) or the org's total-ever
    // deposits (not surfaced by the API). Neither is honest. In that
    // case surface only the live org balance and hide the denominator.
    const allocated = capped ? capPaise : null
    const remaining = capped ? Math.max(0, capPaise - spent) : orgBal

    return (
      <div className="w-full shrink-0">
        {/* Sovereign Gold Ribbon */}
        <div className="h-[3px] rule-gold w-full" />

        <header className="sticky top-0 z-30 bg-ink-chrome w-full py-3 px-4 sm:px-8 lg:px-10 flex flex-wrap items-center justify-between gap-4 shadow-md">
          {/* Official Brand Lockup */}
          <div className="flex items-center gap-3">
            <BrandMark size={28} tone="inverse" className="shrink-0 drop-shadow-sm" />
            <div>
              <div className="text-base font-bold text-white leading-tight flex items-center gap-2">
                <span>Verification</span>
                <span className="text-amber-300 font-extrabold">Portal</span>
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-white/10 text-amber-300 ring-1 ring-inset ring-amber-300/30 tracking-wider">
                  VERIFICATION DESK
                </span>
              </div>
              {/* Subtitle line pulls from the wallet's assigned exam +
                  the candidate's center. Both were previously hardcoded
                  fake ("DELHI CENTRAL", "DEL-04B") which looked like
                  seeded demo data. Empty parts collapse quietly. */}
              {(wallet?.assigned_exam_name || candidate?.center_name) && (
                <div className="text-xs text-slate-300 mt-0.5 font-normal">
                  {candidate?.center_name && <>Center: <span className="text-slate-200">{candidate.center_name}</span></>}
                  {candidate?.center_name && wallet?.assigned_exam_name && <span className="mx-1.5 text-slate-500">·</span>}
                  {wallet?.assigned_exam_name && <>Exam: <span className="text-slate-200">{wallet.assigned_exam_name}</span></>}
                </div>
              )}
            </div>
          </div>

          {/* Center Status & Operator Allocation */}
          <div className="flex items-center gap-3 sm:gap-4 flex-wrap">
            {/* Wallet pill. Two shapes:
                • Capped operator (spending_cap_paise > 0) — shows the
                  personal purse as remaining/cap. Real numbers, both
                  meaningful.
                • Uncapped operator — draws from the shared org wallet;
                  there's no personal ceiling to divide by, so surface
                  just the org balance. (See renderSovereignHeader for
                  why we no longer fake a denominator.) */}
            <div
              className="flex items-center gap-2 px-3.5 py-1.5 rounded-lg bg-white/8 border border-white/15 text-xs shadow-xs"
              title={capped
                ? `Remaining: ${formatRupees(remaining)} | Allocated Purse: ${formatRupees(allocated)}`
                : `Organisation wallet balance`}
            >
              <svg className="w-3.5 h-3.5 text-amber-300 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"
                />
              </svg>
              <span className="text-slate-300">{capped ? 'Purse:' : 'Balance:'}</span>
              <span className="font-bold text-white tabular-nums">{formatRupees(remaining)}</span>
              {capped && (
                <span className="text-slate-400">/ <span className="text-slate-300 font-medium tabular-nums">{formatRupees(allocated)}</span></span>
              )}
            </div>

            {/* Downloads or Start Over Action */}
            {currentStage === 0 ? (
              <Link
                to="/institute/operator/downloads"
                title="Download the install bundle for a new verification agent laptop"
                className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/20 bg-white/10 hover:bg-white/20 text-white text-xs font-semibold transition shadow-xs"
              >
                <svg className="w-3.5 h-3.5 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                <span>Downloads</span>
              </Link>
            ) : (
              <button
                type="button"
                onClick={resetDesk}
                className="px-3 py-1.5 rounded-lg border border-white/20 bg-white/10 hover:bg-white/20 text-white text-xs font-semibold transition shadow-xs cursor-pointer"
              >
                Start over
              </button>
            )}

            <ReportProblem />
            <AvatarMenu user={user} onLogout={handleLogout} />
          </div>
        </header>
        <div className="h-[2px] rule-gold" />
      </div>
    )
  }

  const renderDeskFooter = (
    <footer className="w-full py-3 bg-white border-t border-[#D5DDE7] text-center text-xs text-slate-500 shrink-0">
      Verification Portal v{APP_VERSION} · Dedicated Biometric Verification Desk
    </footer>
  )

  return (
    <AppShell
      fullWidth={true}
      customHeader={renderSovereignHeader}
      customFooter={renderDeskFooter}
    >
      {walletEmpty && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900 flex items-start gap-3 shadow-2xs">
          <span className="text-base text-amber-700">⚠</span>
          <div className="flex-1">
            <p className="font-semibold text-sm text-amber-900">Organisation Wallet is Empty</p>
            <p className="mt-0.5 text-amber-800 leading-relaxed">
              Candidate lookups are paused until your administrator tops up the institution wallet. Please contact your admin.
            </p>
          </div>
        </div>
      )}

      {/* TOP STRETCHED PROGRESS BAR: STRICTLY SINGLE UNIFIED ROW (NEVER WRAPS) */}
      <section className="w-full p-4 sm:p-5 rounded-xl bg-white border border-[#D5DDE7] shadow-xs">
        <div className="flex items-center justify-between text-xs mb-3 px-1">
          <span className="text-[#0B4F8F] font-semibold tracking-wide uppercase text-[11px] flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[#0B4F8F]" />
            Candidate Verification Pipeline
          </span>
          <span className="text-slate-500 font-medium text-[11px] uppercase tracking-wider">
            {pipelineStepLabels[currentStage] || pipelineStepLabels[0]}
          </span>
        </div>

        {/* Single-Row Flexbox Stepper: Never Wraps */}
        <div className="flex items-center w-full justify-between flex-nowrap gap-1">
          
          {/* Step 1: Candidate Roll Number */}
          <div className="flex items-center gap-2 sm:gap-2.5 shrink-0">
            <div
              className={`w-8 h-8 rounded-full font-bold text-xs flex items-center justify-center shrink-0 shadow-sm transition-all duration-300 ${
                activeStep > 1 || currentStage === 4
                  ? 'bg-[#0F6B45] text-white'
                  : 'bg-[#0B4F8F] text-white'
              }`}
            >
              {activeStep > 1 || currentStage === 4 ? (
                <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="3">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                '1'
              )}
            </div>
            <div className="min-w-0">
              <span className={`text-xs font-semibold block whitespace-nowrap ${activeStep > 1 || currentStage === 4 ? 'text-[#0F6B45]' : 'text-[#0B4F8F]'}`}>
                Roll Number
              </span>
              <span className="text-[11px] text-slate-500 block whitespace-nowrap hidden sm:block">
                Identification
              </span>
            </div>
          </div>

          {/* Connector Line 1-2 */}
          <div className="stepper-connector">
            <div
              className={`stepper-fill ${
                activeStep > 1 || currentStage === 4
                  ? 'stepper-fill-active'
                  : activeStep === 1
                  ? 'stepper-fill-pulse'
                  : ''
              }`}
            />
          </div>

          {/* Step 2: Liveness & Face Match */}
          <div className={`flex items-center gap-2 sm:gap-2.5 shrink-0 transition-all duration-300 ${activeStep < 2 && currentStage !== 4 ? 'opacity-50' : ''}`}>
            <div
              className={`w-8 h-8 rounded-full font-bold text-xs flex items-center justify-center shrink-0 transition-all duration-300 ${
                activeStep > 2 || currentStage === 4
                  ? 'bg-[#0F6B45] text-white shadow-sm'
                  : activeStep === 2
                  ? 'bg-[#0B4F8F] text-white shadow-sm'
                  : 'bg-[#ECEEF1] text-slate-600 border border-[#D5DDE7]'
              }`}
            >
              {activeStep > 2 || currentStage === 4 ? (
                <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="3">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                '2'
              )}
            </div>
            <div className="min-w-0">
              <span className={`text-xs font-semibold block whitespace-nowrap ${
                activeStep > 2 || currentStage === 4
                  ? 'text-[#0F6B45]'
                  : activeStep === 2
                  ? 'text-[#0B4F8F]'
                  : 'text-slate-600'
              }`}>
                Liveness & Face
              </span>
              <span className="text-[11px] text-slate-500 block whitespace-nowrap hidden sm:block">
                Anti-Spoof Gate
              </span>
            </div>
          </div>

          {/* Connector Line 2-3 */}
          <div className="stepper-connector">
            <div
              className={`stepper-fill ${
                activeStep > 2 || currentStage === 4
                  ? 'stepper-fill-active'
                  : activeStep === 2
                  ? 'stepper-fill-pulse'
                  : ''
              }`}
            />
          </div>

          {/* Step 3: Fingerprint & Iris Hardware Match */}
          <div className={`flex items-center gap-2 sm:gap-2.5 shrink-0 transition-all duration-300 ${activeStep < 3 && currentStage !== 4 ? 'opacity-50' : ''}`}>
            <div
              className={`w-8 h-8 rounded-full font-bold text-xs flex items-center justify-center shrink-0 transition-all duration-300 ${
                activeStep > 3 || currentStage === 4
                  ? 'bg-[#0F6B45] text-white shadow-sm'
                  : activeStep === 3
                  ? 'bg-[#0B4F8F] text-white shadow-sm'
                  : 'bg-[#ECEEF1] text-slate-600 border border-[#D5DDE7]'
              }`}
            >
              {activeStep > 3 || currentStage === 4 ? (
                <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="3">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                '3'
              )}
            </div>
            <div className="min-w-0">
              <span className={`text-xs font-semibold block whitespace-nowrap ${
                activeStep > 3 || currentStage === 4
                  ? 'text-[#0F6B45]'
                  : activeStep === 3
                  ? 'text-[#0B4F8F]'
                  : 'text-slate-600'
              }`}>
                Fingerprint & Iris
              </span>
              <span className="text-[11px] text-slate-500 block whitespace-nowrap hidden sm:block">
                Hardware Match
              </span>
            </div>
          </div>

          {/* Connector Line 3-4 */}
          <div className="stepper-connector">
            <div
              className={`stepper-fill ${
                currentStage === 4
                  ? 'stepper-fill-active'
                  : activeStep === 3
                  ? 'stepper-fill-pulse'
                  : ''
              }`}
            />
          </div>

          {/* Step 4: Final Verdict & Sovereign Seal */}
          <div className={`flex items-center gap-2 sm:gap-2.5 shrink-0 transition-all duration-300 ${currentStage !== 4 ? 'opacity-50' : ''}`}>
            <div
              className={`w-8 h-8 rounded-full font-bold text-xs flex items-center justify-center shrink-0 transition-all duration-300 ${
                currentStage === 4
                  ? 'bg-[#0F6B45] text-white shadow-sm'
                  : 'bg-[#ECEEF1] text-slate-600 border border-[#D5DDE7]'
              }`}
            >
              {currentStage === 4 ? (
                <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="3">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                '4'
              )}
            </div>
            <div className="min-w-0">
              <span className={`text-xs font-semibold block whitespace-nowrap ${
                currentStage === 4 ? 'text-[#0F6B45]' : 'text-slate-600'
              }`}>
                Final Decision
              </span>
              <span className="text-[11px] text-slate-500 block whitespace-nowrap hidden sm:block">
                Official Seal
              </span>
            </div>
          </div>

        </div>
      </section>

      {/* TWO-COLUMN WORK SURFACE (LEFT SEARCH CARD + DYNAMIC RIGHT STAGE CANVAS) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
        
        {/* ================= LEFT RAIL: CANDIDATE SEARCH & REGISTERED DOSSIER ================= */}
        <div className="lg:col-span-4 xl:col-span-4 flex flex-col space-y-4 h-full">
          
          {/* Step 1: Candidate Roll Search Card (Visible when no candidate is active) */}
          {!candidate && (
            <div className="p-5 rounded-xl bg-white border border-[#D5DDE7] shadow-xs space-y-4 animate-surface-in">
              <div className="flex items-center justify-between border-b border-[#E7EDF4] pb-2.5">
                <h2 className="text-sm font-semibold text-[#0B1F3A] flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-[#0B4F8F]" />
                  Candidate Search
                </h2>
              </div>

              <form onSubmit={handleRollSubmit} className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Candidate Roll Number
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      value={roll}
                      onChange={(e) => setRoll(e.target.value)}
                      placeholder="e.g. 10001"
                      disabled={isSearchLocked}
                      className="w-full px-3 py-2.5 rounded-lg border border-[#D5DDE7] bg-[#F8FAFC] text-[#0B1F3A] font-mono text-base font-bold focus:bg-white focus:outline-none focus:border-[#0B4F8F] focus:ring-2 focus:ring-[#0B4F8F]/20 transition placeholder:font-sans placeholder:font-normal placeholder:text-slate-400 disabled:opacity-60 disabled:cursor-not-allowed"
                      autoFocus={!isSearchLocked}
                    />
                  </div>
                </div>

                {lookupErr && !isSearchLocked && (
                  <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-700 font-medium">
                    {lookupErr}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={isSearchLocked || isSearching || !roll.trim()}
                  className="w-full py-2.5 px-4 rounded-lg bg-[#0B4F8F] hover:bg-[#083E72] disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold text-xs tracking-wide uppercase transition shadow-xs flex items-center justify-center gap-2 cursor-pointer"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  <span>{isSearching ? 'Looking Up Database…' : 'Look Up Record'}</span>
                </button>
              </form>
            </div>
          )}

          {/* Enrolled Registration Record Card (Revealed Once Searched, Takes Full Left Column) */}
          {candidate && (
            <div className="p-5 rounded-xl bg-white border border-[#D5DDE7] shadow-xs space-y-3.5 transition-all duration-300 flex-1 flex flex-col justify-between animate-surface-in">
              <div>
                {/* Photo Area: Always uniform Dual-Photo Grid (Enrolled + Captured / Awaiting Capture) */}
                <div className="space-y-3 animate-surface-in">
                  {/* Dual Photos Side-by-Side */}
                  <div className="grid grid-cols-2 gap-2.5">
                    {/* Enrolled Photo */}
                    <div className="rounded-lg overflow-hidden border border-[#D5DDE7] bg-slate-100 aspect-[4/5] relative flex items-center justify-center shadow-2xs">
                      {photoBlob ? (
                        <img
                          src={photoBlob}
                          alt="Enrolled Candidate"
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex flex-col items-center justify-center bg-[#EEF5FD] text-[#0B4F8F] p-2 text-center">
                          <svg className="w-7 h-7 opacity-60 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                          </svg>
                          <span className="text-[8px] font-semibold leading-tight">PHOTO ON FILE</span>
                        </div>
                      )}
                      <div className="absolute bottom-0 inset-x-0 bg-[#0B2545]/90 text-white text-[9px] font-semibold py-0.5 text-center tracking-wider">
                        ENROLLED
                      </div>
                    </div>

                    {/* Tile paint mirrors the verdict — a captured photo
                        alone is not proof of match. */}
                    {snap ? (() => {
                      const facePassed = faceResult?.ok === true
                      const faceFailed = faceResult?.ok === false
                      const border = facePassed
                        ? 'border-[#0F6B45]'
                        : faceFailed
                        ? 'border-[#DC2626]'
                        : 'border-[#0B4F8F]'
                      const bar = facePassed
                        ? 'bg-[#0F6B45]'
                        : faceFailed
                        ? 'bg-[#DC2626]'
                        : 'bg-[#0B4F8F]'
                      return (
                        <div className={`rounded-lg overflow-hidden border-2 ${border} bg-slate-100 aspect-[4/5] relative flex items-center justify-center shadow-2xs animate-surface-in`}>
                          <img
                            src={snap}
                            alt="Captured Candidate"
                            className="w-full h-full object-cover contrast-105"
                          />
                          <div className={`absolute bottom-0 inset-x-0 ${bar} text-white text-[9px] font-semibold py-0.5 text-center flex items-center justify-center gap-1 tracking-wider`}>
                            {facePassed ? (
                              <>
                                <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="3">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                </svg>
                                CAPTURED
                              </>
                            ) : faceFailed ? (
                              <>
                                <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="3">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                                NOT MATCHED
                              </>
                            ) : (
                              <>CAPTURED</>
                            )}
                          </div>
                        </div>
                      )
                    })() : (
                      <div className="rounded-lg border-2 border-dashed border-[#83B3E9]/70 bg-[#EEF5FD]/40 aspect-[4/5] relative flex flex-col items-center justify-center text-center p-2.5 transition-all">
                        <div className="w-10 h-10 rounded-full bg-white border border-[#83B3E9] flex items-center justify-center text-[#0B4F8F] mb-1.5 shadow-2xs">
                          <svg className="w-5 h-5 text-[#0B4F8F] animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                            <circle cx="12" cy="13" r="3" strokeWidth="1.8" />
                          </svg>
                        </div>
                        <span className="text-[10px] font-bold text-[#0B4F8F] leading-tight">Live Camera</span>
                        <span className="text-[9px] text-slate-500 mt-0.5 leading-tight">Awaiting Capture</span>
                        <div className="absolute bottom-0 inset-x-0 bg-[#EEF5FD] border-t border-[#83B3E9]/60 text-[#0B4F8F] text-[9px] font-semibold py-0.5 text-center tracking-wider">
                          STAGE 2 CAMERA
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Candidate Details Grid Card */}
                  <div className="p-3 rounded-lg bg-[#F8FAFC] border border-[#E7EDF4] space-y-1.5 text-xs">
                    <div className="flex items-center justify-between border-b border-[#E7EDF4] pb-1.5">
                      <div className="font-bold text-sm text-[#0B1F3A] truncate">
                        {candidate.name || 'Candidate Record'}
                      </div>
                      <span className="font-mono text-[11px] font-bold text-[#0B4F8F] bg-[#EEF5FD] px-2 py-0.5 rounded border border-[#83B3E9]/50">
                        #{candidate.roll_no}
                      </span>
                    </div>

                    <div className="space-y-1 text-[11.5px] pt-0.5">
                      <div className="flex items-center justify-between text-slate-600">
                        <span className="text-slate-500">Exam:</span>
                        <span className="font-medium text-[#0B1F3A] truncate max-w-[190px]">
                          {candidate.exam_name || wallet?.assigned_exam_name || '—'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-slate-600">
                        <span className="text-slate-500">Center:</span>
                        <span className="font-medium text-[#0B1F3A] truncate max-w-[190px]" title={candidate.center_name || '—'}>
                          {candidate.center_name || '—'}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Modality Status Strip */}
              <div className="pt-2 border-t border-[#E7EDF4] space-y-1.5 text-xs">
                <div className="flex justify-between items-center text-[11px]">
                  <span className="text-slate-500 font-medium">1. LIVENESS CHECK:</span>
                  <span className={`font-semibold ${livenessOK ? 'text-[#0F6B45]' : 'text-slate-400'}`}>
                    {livenessOK ? 'PASS' : 'WAITING'}
                  </span>
                </div>
                {hasEnrolledFace && (
                <div className="flex justify-between items-center text-[11px]">
                  <span className="text-slate-500 font-medium">2. FACE 1:1 MATCH:</span>
                  <span className={`font-semibold ${
                    faceResult?.ok
                      ? 'text-[#0F6B45]'
                      : faceResult && faceResult.ok === false
                      ? 'text-[#DC2626]'
                      : 'text-slate-400'
                  }`}>
                    {faceResult?.ok
                      ? 'MATCHED'
                      : faceResult && faceResult.ok === false
                      ? 'FAILED'
                      : 'WAITING'}
                  </span>
                </div>
                )}
                {hasEnrolledFingerprint && (
                <div className="flex justify-between items-center text-[11px]">
                  <span className="text-slate-500 font-medium">3. FINGERPRINT 1:1:</span>
                  <span className={`font-semibold ${
                    fpStatus === 'pass'
                      ? 'text-[#0F6B45]'
                      : fpStatus === 'fail'
                      ? 'text-[#DC2626]'
                      : 'text-slate-400'
                  }`}>
                    {fpStatus === 'pass'
                      ? 'MATCHED'
                      : fpStatus === 'fail'
                      ? 'FAILED'
                      : 'WAITING'}
                  </span>
                </div>
                )}
                {hasEnrolledIris && (
                <div className="flex justify-between items-center text-[11px]">
                  <span className="text-slate-500 font-medium">4. IRIS 1:1 MATCH:</span>
                  <span className={`font-semibold ${
                    irisStatus === 'pass'
                      ? 'text-[#0F6B45]'
                      : irisStatus === 'fail'
                      ? 'text-[#DC2626]'
                      : 'text-slate-400'
                  }`}>
                    {irisStatus === 'pass'
                      ? 'MATCHED'
                      : irisStatus === 'fail'
                      ? 'FAILED'
                      : 'WAITING'}
                  </span>
                </div>
                )}
                <div className="flex justify-between items-center text-[11px]">
                  <span className="text-slate-500 font-medium">5. FINAL VERDICT:</span>
                  <span className={`font-semibold ${
                    result === 'verified'
                      ? 'text-[#0F6B45]'
                      : result === 'denied'
                      ? 'text-[#DC2626]'
                      : isBiometricComplete()
                      ? 'text-[#0B4F8F]'
                      : 'text-slate-400'
                  }`}>
                    {result === 'verified'
                      ? 'VERIFIED (PASS)'
                      : result === 'denied'
                      ? 'DENIED'
                      : isBiometricComplete()
                      ? 'READY'
                      : 'PENDING'}
                  </span>
                </div>
              </div>
            </div>
          )}

        </div>

        {/* ================= RIGHT WORK CANVAS: PROGRESSIVE STAGES (UPDATES IN-PLACE) ================= */}
        <div className="lg:col-span-8 xl:col-span-8 flex flex-col h-full">
          <div className="min-h-[580px] h-full flex-1 rounded-xl bg-white border border-[#D5DDE7] shadow-xs p-6 relative overflow-hidden flex flex-col justify-between">
            
            {/* STAGE 0: STANDBY (WAITING FOR SEARCH) */}
            {currentStage === 0 && (
              <div className="h-full flex-1 flex flex-col items-center justify-center text-center my-auto py-16 animate-surface-in">
                <div className="w-16 h-16 rounded-full bg-[#EEF5FD] border border-[#83B3E9] flex items-center justify-center text-[#0B4F8F] mb-4">
                  <svg className="w-8 h-8 text-[#0B4F8F]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="16" y1="13" x2="8" y2="13"></line>
                    <line x1="16" y1="17" x2="8" y2="17"></line>
                    <polyline points="10 9 9 9 8 9"></polyline>
                  </svg>
                </div>
                <h3 className="text-lg font-bold text-[#0B1F3A] tracking-tight font-display">Desk Ready for Candidate Verification</h3>
                <p className="text-xs text-slate-500 max-w-md mt-1.5 leading-relaxed">
                  Enter candidate roll number in the search panel to begin biometric verification.
                </p>
              </div>
            )}

            {/* STAGE 1: CANDIDATE LOADED -> START LIVENESS */}
            {currentStage === 1 && candidate && (
              <div className="h-full flex-1 flex flex-col justify-between space-y-6 animate-surface-in">
                <div className="flex items-center justify-between border-b border-[#E7EDF4] pb-4">
                  <div>
                    <span className="text-[10px] font-semibold text-[#0B4F8F] uppercase tracking-widest">STAGE 1 OF 4</span>
                    <h3 className="text-xl font-bold text-[#0B1F3A] tracking-tight font-display">Candidate Record Retrieved</h3>
                  </div>
                  <span className="text-xs px-3 py-1 rounded bg-[#E8F5EE] border border-[#B4DCC7] text-[#0F6B45] font-semibold">
                    STATUS: READY
                  </span>
                </div>

                <div className="p-6 rounded-xl bg-[#F8FAFC] border border-[#E7EDF4] space-y-4">
                  <div className="flex items-start gap-4">
                    <div className="w-12 h-12 rounded-xl bg-[#EEF5FD] border border-[#83B3E9] flex items-center justify-center text-[#0B4F8F] shrink-0 shadow-xs">
                      <svg className="w-6 h-6 eye-blink-anim text-[#0B4F8F]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M2 12s3.5-6.5 10-6.5 10 6.5-3.5 6.5-10 6.5S2 12 2 12Z" />
                        <circle cx="12" cy="12" r="3.5" fill="#0B4F8F" fillOpacity="0.2" />
                        <circle cx="12" cy="12" r="1.5" fill="#0B4F8F" />
                      </svg>
                    </div>
                    <div>
                      <h4 className="text-base font-bold text-[#0B1F3A]">Live Face & Liveness Check</h4>
                      <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                        Position candidate in front of the camera to verify live presence and match against admit card photo.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="pt-4 border-t border-[#E7EDF4] flex justify-end">
                  <button
                    type="button"
                    onClick={() => setCurrentStage(2)}
                    className="px-6 py-3 rounded-lg bg-[#0B4F8F] hover:bg-[#083E72] text-white font-semibold text-xs uppercase tracking-wider transition shadow-sm flex items-center gap-2 cursor-pointer"
                  >
                    <span>Start Face & Liveness Check</span>
                    <span>→</span>
                  </button>
                </div>
              </div>
            )}

            {/* STAGE 2: LIVE CAMERA HUD RETICLE & BLINK CHALLENGE */}
            {currentStage === 2 && (
              <div className="h-full flex-1 flex flex-col space-y-5 animate-surface-in">
                <div className="flex items-center justify-between border-b border-[#E7EDF4] pb-3">
                  <div>
                    <span className="text-[10px] font-semibold text-[#0B4F8F] uppercase tracking-widest">STAGE 2 OF 4</span>
                    <h3 className="text-lg font-bold text-[#0B1F3A] tracking-tight font-display">Face Match & Liveness Check</h3>
                  </div>
                  <span className={`text-xs flex items-center gap-1.5 font-semibold ${
                    livenessOK ? 'text-[#0F6B45]' : 'text-[#0B4F8F]'
                  }`}>
                    <span className={`w-2 h-2 rounded-full ${
                      livenessOK ? 'bg-[#0F6B45]' : 'bg-[#0B4F8F] animate-pulse'
                    }`} />
                    {livenessOK ? 'Liveness Verified' : 'Camera Ready'}
                  </span>
                </div>

                {/* Central HUD Camera Viewport — the flex-1 wrapper
                    consumes the remaining vertical space in the stage
                    card and centers the viewport + guidance panel
                    together (was previously `justify-between` on the
                    outer column, which pinned the grid to the bottom
                    edge and left a big empty band up top). */}
                <div className="flex-1 flex items-center min-h-0">
                <div className="grid grid-cols-1 md:grid-cols-12 gap-5 items-center w-full">
                  
                  {/* Video Viewport */}
                  <div className="md:col-span-7 flex justify-center">
                    <div className={`w-full max-w-[280px] aspect-square rounded-2xl bg-slate-900 border-2 relative overflow-hidden shadow-md flex items-center justify-center ${
                      livenessOK ? 'border-[#0F6B45]' : 'border-[#0B4F8F]'
                    }`}>
                      {livenessOK && snap ? (
                        // Camera stopped, show the frozen still that was
                        // sent for face-match. Same shot as the dossier
                        // tile, framed in green so it reads as the
                        // decided capture rather than a live feed.
                        <img
                          src={snap}
                          alt="Captured"
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <video
                          ref={videoRef}
                          autoPlay
                          playsInline
                          muted
                          className="w-full h-full object-cover"
                          style={{ transform: 'scaleX(-1)' }}
                        />
                      )}
                      {!cameraActive && !livenessOK && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-900 text-slate-400 p-4 text-center text-xs">
                          <svg className="w-10 h-10 mb-2 opacity-40 text-cyan-400 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                          </svg>
                          <span className="text-white font-semibold">Starting camera…</span>
                          <span className="text-[11px] text-slate-400 mt-1">Please allow access if prompted.</span>
                        </div>
                      )}

                      {/* Live HUD (laser beam + bracket reticle + blink
                          status pill) is only meaningful while the
                          camera is still running. Once the server-side
                          liveness gate has been written (livenessOK)
                          the viewport swaps in the frozen still — the
                          overlays must disappear too or the operator
                          sees a scanning laser sweeping across a
                          static photo, which was the "animation still
                          going on" bug. */}
                      {!livenessOK && (
                        <>
                          {/* Scanning Laser Line */}
                          <div className="laser-hud-beam absolute left-3 right-3 h-[2px] bg-cyan-400 z-20 pointer-events-none" />

                          {/* Overlay Reticle */}
                          <div className="absolute inset-0 pointer-events-none p-3.5 flex flex-col justify-between z-10 text-[10px]">
                            {/* Brackets */}
                            <div className="relative w-44 h-52 self-center flex items-center justify-center">
                              <div className={`absolute top-0 left-0 w-5 h-5 border-t-2 border-l-2 transition-colors duration-300 ${faceDetected ? 'border-cyan-400' : 'border-amber-400/70'}`} />
                              <div className={`absolute top-0 right-0 w-5 h-5 border-t-2 border-r-2 transition-colors duration-300 ${faceDetected ? 'border-cyan-400' : 'border-amber-400/70'}`} />
                              <div className={`absolute bottom-0 left-0 w-5 h-5 border-b-2 border-l-2 transition-colors duration-300 ${faceDetected ? 'border-cyan-400' : 'border-amber-400/70'}`} />
                              <div className={`absolute bottom-0 right-0 w-5 h-5 border-b-2 border-r-2 transition-colors duration-300 ${faceDetected ? 'border-cyan-400' : 'border-amber-400/70'}`} />
                            </div>

                            <div className="self-center bg-[#0B2545]/90 text-white px-3 py-1 rounded border border-white/20 font-semibold tracking-wide animate-pulse">
                              {livenessPassed ? 'LIVENESS CONFIRMED' : blinkState}
                            </div>
                          </div>
                        </>
                      )}

                      {/* Passed Overlay */}
                      {livenessPassed && (
                        <div className="absolute inset-0 bg-[#0F6B45]/90 backdrop-blur-xs flex items-center justify-center z-30 text-white text-center p-4">
                          <div>
                            <div className="w-12 h-12 mx-auto rounded-full bg-white text-[#0F6B45] flex items-center justify-center mb-2 shadow-md">
                              <svg className="w-6 h-6 text-[#0F6B45]" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="3">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                              </svg>
                            </div>
                            <div className="text-sm font-bold uppercase tracking-wide">Liveness Verified</div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Diagnostic Checklist */}
                  <div className="md:col-span-5 space-y-4 text-xs">
                    <div className="p-4 rounded-lg bg-[#F8FAFC] border border-[#E7EDF4] space-y-2.5">
                      <div className="flex justify-between items-center">
                        <span className="text-slate-500 font-medium">Liveness Status</span>
                        <span className={`font-semibold text-xs ${livenessPassed ? 'text-[#0F6B45]' : 'text-[#0B4F8F]'}`}>
                          {livenessPassed ? 'VERIFIED' : 'ACTIVE CHECK'}
                        </span>
                      </div>
                      <div>
                        <div className="flex justify-between text-xs text-slate-700 mb-1">
                          <span className="font-medium">Face Alignment</span>
                          <span className={`font-semibold text-[11px] ${
                            faceOrientationStatus === 'OPTIMAL' ? 'text-[#0F6B45]' : faceDetected ? 'text-[#0B4F8F]' : 'text-rose-600'
                          }`}>
                            {faceOrientationStatus}
                          </span>
                        </div>
                        <div className="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full transition-all duration-300 ${
                            faceOrientationStatus === 'OPTIMAL' ? 'bg-[#0F6B45] w-full' : faceDetected ? 'bg-[#0B4F8F] w-2/3' : 'bg-slate-300 w-0'
                          }`} />
                        </div>
                      </div>
                      <div>
                        <div className="flex justify-between text-xs text-slate-700 mb-1">
                          <span className="font-medium">Blink Detection</span>
                          <span className={`font-semibold text-xs ${livenessPassed ? 'text-[#0F6B45]' : faceDetected ? 'text-amber-600' : 'text-slate-400'}`}>
                            {blinkState}
                          </span>
                        </div>
                        <div className="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-300 ${
                              livenessPassed ? 'bg-[#0F6B45] w-full' : faceDetected ? 'bg-amber-500' : 'bg-slate-300'
                            }`}
                            style={{ width: `${blinkProgress}%` }}
                          />
                        </div>
                      </div>
                    </div>

                    {livenessError && (
                      <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-700 font-medium leading-relaxed">
                        {livenessError}
                      </div>
                    )}

                    {!livenessPassed && faceResult && faceResult.ok === false && !faceResult.error ? (
                      // Face-match ran and cleanly returned a MISS (as
                      // opposed to a network/gate error). Mirror the old
                      // dashboard's affordance: operator can retake JUST
                      // the still photo (no new blink challenge needed —
                      // the liveness gate row is already valid for this
                      // idempotency_key), or continue anyway if they
                      // have visually verified the candidate.
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={handleRetakePhoto}
                          disabled={livenessPassing}
                          className="w-full py-2.5 px-4 rounded-lg bg-white border border-[#0F6B45] text-[#0F6B45] hover:bg-[#F0FDF4] disabled:opacity-50 font-semibold text-xs uppercase tracking-wider transition shadow-xs flex items-center justify-center gap-2 cursor-pointer"
                        >
                          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="1 4 1 10 7 10" />
                            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                          </svg>
                          <span>Retake Photo</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            // Operator override — the visual check is
                            // their responsibility. Advance the stage;
                            // faceResult.ok stays false so submit records
                            // face_match=false for the audit trail.
                            setLivenessError('')
                            setLivenessPassing(false)
                            setLivenessPassed(true)
                            setLivenessResult({ pass: true, faceOverride: true })
                          }}
                          className="w-full py-2.5 px-4 rounded-lg bg-[#0B4F8F] hover:bg-[#083E72] text-white font-semibold text-xs uppercase tracking-wider transition shadow-xs flex items-center justify-center gap-2 cursor-pointer"
                        >
                          <span>Continue Anyway →</span>
                        </button>
                      </div>
                    ) : !livenessPassed && (
                      <button
                        type="button"
                        onClick={handleCaptureLiveness}
                        disabled={livenessPassing}
                        className="w-full py-2.5 px-4 rounded-lg bg-[#0F6B45] hover:bg-[#0c5938] disabled:opacity-50 text-white font-semibold text-xs uppercase tracking-wider transition shadow-xs flex items-center justify-center gap-2 cursor-pointer"
                      >
                        <svg className="w-4 h-4 eye-blink-anim" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M2 12s3.5-6.5 10-6.5 10 6.5-3.5 6.5-10 6.5S2 12 2 12Z" />
                          <circle cx="12" cy="12" r="3" fill="currentColor" fillOpacity="0.3" />
                          <circle cx="12" cy="12" r="1.5" fill="currentColor" />
                        </svg>
                        <span>{livenessPassing ? 'Checking Blink…' : 'Capture & Verify Face'}</span>
                      </button>
                    )}

                    {/* No manual Proceed button here — the auto-advance
                        useEffect above moves to Stage 3 (or Stage 4 for
                        face-only candidates) 700 ms after livenessPassed
                        flips true, so the operator sees a brief
                        confirmation and then transitions cleanly
                        without an extra tap. */}
                  </div>

                </div>
                </div>
              </div>
            )}

            {/* STAGE 3: BIOMETRIC VERIFICATION (FP & IRIS) */}
            {currentStage === 3 && (
              <div className="h-full flex-1 flex flex-col justify-between space-y-4 animate-surface-in">
                
                {/* Stage Header */}
                <div className="flex items-center justify-between border-b border-[#E7EDF4] pb-3">
                  <div>
                    <span className="text-[10px] font-semibold text-[#0B4F8F] uppercase tracking-widest">STAGE 3 OF 4</span>
                    <h3 className="text-lg font-bold text-[#0B1F3A] tracking-tight font-display">Fingerprint & Iris Verification</h3>
                    <div className="text-xs text-slate-500 mt-0.5">Scan candidate biometrics using connected devices</div>
                  </div>
                </div>

                {/* Dual Biometric Sensor Bays. Collapses to a single
                    column when only one modality is enrolled for this
                    candidate so the visible bay uses the full stage
                    width instead of leaving an empty column of grey. */}
                <div className={`grid gap-4 my-auto flex-1 items-stretch py-1 grid-cols-1 ${
                  hasEnrolledFingerprint && hasEnrolledIris ? 'md:grid-cols-2' : ''
                }`}>

                  {/* BAY 1: FINGERPRINT SENSOR — only when this candidate
                      actually has a fingerprint template on file. */}
                  {hasEnrolledFingerprint && (
                  <div className="p-4 rounded-xl bg-[#F8FAFC] border border-[#D5DDE7] transition-all flex flex-col justify-between flex-1">
                    {/* Pod Header */}
                    <div className="flex items-center justify-between border-b border-[#E7EDF4] pb-2 text-xs">
                      <div className="flex items-center gap-2">
                        <span className={`w-2.5 h-2.5 rounded-full ${
                          fpStatus === 'pass' ? 'bg-[#0F6B45]' : fpStatus === 'fail' ? 'bg-[#DC2626]' : 'bg-[#0B4F8F]'
                        }`} />
                        <span className="font-semibold text-[#0B1F3A]">1. Fingerprint Sensor (L1)</span>
                      </div>
                    </div>

                    {/* Sensor Box */}
                    <div className="my-auto py-2 flex flex-col items-center justify-center">
                      <div
                        onClick={handleCaptureFingerprint}
                        className={`w-36 h-40 rounded-xl flex flex-col items-center justify-center cursor-pointer transition-all duration-200 relative overflow-hidden bg-white border ${
                          fpStatus === 'pass'
                            ? 'border-[#0F6B45] bg-[#E8F5EE]/40'
                            : fpStatus === 'fail'
                            ? 'border-[#DC2626] bg-[#FBEAEC]/40'
                            : fpStatus === 'scanning'
                            ? 'border-[#0B4F8F] bg-[#EEF5FD]/40 shadow-xs'
                            : 'border-[#D5DDE7] hover:border-[#0B4F8F] hover:shadow-xs'
                        }`}
                      >
                        {/* Fingerprint Glyph styled identically to login page */}
                        <div className="relative flex items-center justify-center p-2">
                          <InteractiveFingerprintGlyph status={fpStatus} size={68} />
                        </div>

                        <span className={`text-xs font-semibold mt-1 text-center px-2 ${
                          fpStatus === 'pass'
                            ? 'text-[#0F6B45]'
                            : fpStatus === 'fail'
                            ? 'text-[#DC2626]'
                            : fpStatus === 'scanning'
                            ? 'text-[#0B4F8F]'
                            : 'text-slate-600'
                        }`}>
                          {fpStatus === 'pass'
                            ? 'Fingerprint Matched'
                            : fpStatus === 'fail'
                            ? 'Verification Failed'
                            : fpStatus === 'scanning'
                            ? 'Scanning…'
                            : 'Click to Scan'}
                        </span>
                      </div>
                    </div>

                    {/* Status Strip without scores */}
                    <div className="p-2.5 rounded-lg bg-white border border-[#E7EDF4] flex items-center justify-between text-xs mb-3">
                      <span className="text-slate-600 font-medium">Match Status</span>
                      <span className={`px-2.5 py-1 rounded-md font-semibold text-xs ${
                        fpStatus === 'pass'
                          ? 'bg-[#E8F5EE] border border-[#B4DCC7] text-[#0F6B45]'
                          : fpStatus === 'fail'
                          ? 'bg-[#FBEAEC] border border-[#EFC0C7] text-[#DC2626]'
                          : fpStatus === 'scanning'
                          ? 'bg-[#EEF5FD] border border-[#83B3E9] text-[#0B4F8F] animate-pulse'
                          : 'bg-slate-100 text-slate-500'
                      }`}>
                        {fpStatus === 'pass'
                          ? 'VERIFIED (PASS)'
                          : fpStatus === 'fail'
                          ? 'VERIFICATION FAILED'
                          : fpStatus === 'scanning'
                          ? 'SCANNING RIDGES…'
                          : 'AWAITING SCAN'}
                      </span>
                    </div>

                    {/* Real-error banner. Used to surface a missing
                        scanner or a failed match so the operator gets a
                        specific reason rather than a bare red pod. */}
                    {fpResult?.error && (
                      <div className="mb-3 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-[11px] text-rose-700 leading-relaxed">
                        {fpResult.error}
                      </div>
                    )}

                    {/* Pod Action Button. Locks + goes slate while a
                        scan is in progress so the operator can't queue
                        a duplicate capture on top of the running one.
                        Pass state stays disabled as before. */}
                    <button
                      type="button"
                      onClick={handleCaptureFingerprint}
                      disabled={fpStatus === 'pass' || fpStatus === 'scanning'}
                      className={`w-full py-2.5 px-3 rounded-lg text-white font-semibold text-xs uppercase tracking-wider transition shadow-xs flex items-center justify-center gap-2 ${
                        fpStatus === 'scanning'
                          ? 'bg-slate-500 cursor-not-allowed'
                          : 'bg-[#0B4F8F] hover:bg-[#083E72] disabled:opacity-50 cursor-pointer'
                      }`}
                    >
                      <svg className="w-4 h-4 text-cyan-200" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 2a10 10 0 0 0-10 10c0 2.85 1.2 5.41 3.12 7.23M12 6a6 6 0 0 0-6 6c0 1.94.92 3.66 2.36 4.77M12 10a2 2 0 0 0-2 2c0 .8.47 1.48 1.15 1.8M12 14c-.55 0-1 .45-1 1M18.88 19.23A10 10 0 0 0 22 12c0-5.52-4.48-10-10-10M17.64 16.77A6 6 0 0 0 20 12c0-4.42-3.58-8-8-8M14.85 13.8A2 2 0 0 0 16 12c0-2.21-1.79-4-4-4" />
                      </svg>
                      <span>{fpStatus === 'scanning' ? 'Scanning…' : 'Capture Fingerprint (L1)'}</span>
                    </button>
                  </div>
                  )}

                  {/* BAY 2: IRIS SCANNER — only when the candidate has
                      an enrolled iris template. */}
                  {hasEnrolledIris && (
                  <div className="p-4 rounded-xl bg-[#F8FAFC] border border-[#D5DDE7] transition-all flex flex-col justify-between flex-1">
                    {/* Pod Header */}
                    <div className="flex items-center justify-between border-b border-[#E7EDF4] pb-2 text-xs">
                      <div className="flex items-center gap-2">
                        <span className={`w-2.5 h-2.5 rounded-full ${irisStatus === 'pass' ? 'bg-[#0F6B45]' : 'bg-[#0B4F8F]'}`} />
                        <span className="font-semibold text-[#0B1F3A]">2. Iris Scanner (L1)</span>
                      </div>
                    </div>

                    {/* Iris Viewfinder Box */}
                    <div className="my-auto py-2 flex flex-col items-center justify-center">
                      <div
                        onClick={handleCaptureIris}
                        className={`w-36 h-40 rounded-xl flex flex-col items-center justify-center cursor-pointer transition-all duration-200 relative overflow-hidden bg-white border ${
                          irisStatus === 'pass'
                            ? 'border-[#0F6B45] bg-[#E8F5EE]/40'
                            : irisStatus === 'scanning'
                            ? 'border-[#0B4F8F] bg-[#EEF5FD]/40 shadow-xs'
                            : 'border-[#D5DDE7] hover:border-[#0B4F8F] hover:shadow-xs'
                        }`}
                      >
                        {/* Iris Glyph styled identically to login page */}
                        <div className="relative flex items-center justify-center p-2">
                          <InteractiveIrisGlyph status={irisStatus} size={68} />
                        </div>

                        <span className={`text-xs font-semibold mt-1 text-center px-2 ${
                          irisStatus === 'pass'
                            ? 'text-[#0F6B45]'
                            : irisStatus === 'scanning'
                            ? 'text-[#0B4F8F]'
                            : 'text-slate-600'
                        }`}>
                          {irisStatus === 'pass'
                            ? 'Iris Matched'
                            : irisStatus === 'scanning'
                            ? 'Scanning…'
                            : 'Click to Scan'}
                        </span>
                      </div>
                    </div>

                    {/* Status Strip without scores */}
                    <div className="p-2.5 rounded-lg bg-white border border-[#E7EDF4] flex items-center justify-between text-xs mb-3">
                      <span className="text-slate-600 font-medium">Match Status</span>
                      <span className={`px-2.5 py-1 rounded-md font-semibold text-xs ${
                        irisStatus === 'pass'
                          ? 'bg-[#E8F5EE] border border-[#B4DCC7] text-[#0F6B45]'
                          : irisStatus === 'scanning'
                          ? 'bg-[#EEF5FD] border border-[#83B3E9] text-[#0B4F8F] animate-pulse'
                          : 'bg-slate-100 text-slate-500'
                      }`}>
                        {irisStatus === 'pass'
                          ? 'VERIFIED (PASS)'
                          : irisStatus === 'scanning'
                          ? 'ANALYZING PATTERN…'
                          : irisStatus === 'fail'
                          ? 'VERIFICATION FAILED'
                          : 'AWAITING SCAN'}
                      </span>
                    </div>

                    {irisResult?.error && (
                      <div className="mb-3 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-[11px] text-rose-700 leading-relaxed">
                        {irisResult.error}
                      </div>
                    )}

                    {/* Pod Action Button. Same lock-during-scan
                        treatment as the fingerprint bay. */}
                    <button
                      type="button"
                      onClick={handleCaptureIris}
                      disabled={irisStatus === 'pass' || irisStatus === 'scanning'}
                      className={`w-full py-2.5 px-3 rounded-lg text-white font-semibold text-xs uppercase tracking-wider transition shadow-xs flex items-center justify-center gap-2 ${
                        irisStatus === 'scanning'
                          ? 'bg-slate-500 cursor-not-allowed'
                          : 'bg-[#0B4F8F] hover:bg-[#083E72] disabled:opacity-50 cursor-pointer'
                      }`}
                    >
                      <svg className="w-4 h-4 text-cyan-200" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M2 12s3.5-6.5 10-6.5 10 6.5-3.5 6.5-10 6.5S2 12 2 12Z" />
                        <circle cx="12" cy="12" r="3" fill="currentColor" fillOpacity="0.25" />
                        <circle cx="12" cy="12" r="1.5" fill="currentColor" />
                      </svg>
                      <span>{irisStatus === 'scanning' ? 'Scanning…' : 'Capture Iris (L1)'}</span>
                    </button>
                  </div>
                  )}
                </div>

                {/* Master Action Footer. Three shapes:
                    • all enrolled biometrics passed → "Complete Verification"
                    • any enrolled biometric FAILED → "Retake" + "Continue"
                      (Continue submits with the denied verdict so a
                      hard fail can still reach Stage 4 for the result
                      screen instead of dead-ending on this stage).
                    • otherwise (idle/scanning) → status label only. */}
                <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-3 border-t border-[#E7EDF4] text-xs">
                  <div className="flex items-center gap-2 text-slate-600 text-xs">
                    <span className={`w-2 h-2 rounded-full ${
                      isBiometricComplete() ? 'bg-[#0F6B45]'
                        : anyEnrolledFailed() ? 'bg-[#DC2626]'
                        : 'bg-[#0B4F8F]'
                    }`} />
                    <span className="font-semibold">
                      {isBiometricComplete() ? 'Biometric Criteria Satisfied'
                        : anyEnrolledFailed() ? 'Biometric Match Failed'
                        : 'Awaiting Hardware Capture'}
                    </span>
                  </div>

                  {isBiometricComplete() && (
                    <button
                      type="button"
                      onClick={() => submitFinalVerification()}
                      disabled={submitting}
                      className="w-full sm:w-auto px-5 py-2.5 rounded-lg bg-[#0F6B45] hover:bg-[#0c5938] text-white font-semibold uppercase tracking-wider transition shadow-md flex items-center justify-center gap-2 cursor-pointer animate-surface-in text-xs"
                    >
                      <span>{submitting ? 'Completing Verification…' : 'Complete Verification →'}</span>
                    </button>
                  )}

                  {!isBiometricComplete() && anyEnrolledFailed() && (
                    <div className="flex flex-col sm:flex-row items-center gap-2 w-full sm:w-auto animate-surface-in">
                      <button
                        type="button"
                        onClick={retakeFailedBiometrics}
                        disabled={submitting}
                        className="w-full sm:w-auto px-5 py-2.5 rounded-lg bg-white border border-[#D5DDE7] text-[#0B1F3A] hover:bg-slate-50 font-semibold uppercase tracking-wider transition shadow-xs text-xs"
                      >
                        Retake
                      </button>
                      <button
                        type="button"
                        onClick={() => submitFinalVerification('denied')}
                        disabled={submitting}
                        className="w-full sm:w-auto px-5 py-2.5 rounded-lg bg-[#DC2626] hover:bg-[#B91C1C] text-white font-semibold uppercase tracking-wider transition shadow-md text-xs"
                      >
                        {submitting ? 'Submitting…' : 'Continue →'}
                      </button>
                    </div>
                  )}
                </div>

              </div>
            )}

            {/* STAGE 4: OFFICIAL CERTIFICATE & SOVEREIGN SEAL STAMP */}
            {currentStage === 4 && (
              <div className={`h-full flex-1 -m-6 p-6 sm:p-7 bg-white border-2 rounded-xl shadow-md security-watermark-grid relative overflow-hidden flex flex-col justify-between animate-surface-in ${
                result === 'denied' ? 'border-[#DC2626]' : 'border-[#0F6B45]'
              }`}>
                
                {/* Subtle Background Watermark */}
                <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-72 sm:w-96 opacity-[0.06] pointer-events-none select-none z-0">
                  <img src={ntaWatermark} alt="" className="w-full h-auto object-contain" />
                </div>

                {/* Top Header & Official Sovereign Masthead */}
                <div className="relative z-1 flex flex-col md:flex-row md:items-center justify-between gap-5 border-b border-[#D5DDE7] pb-4 bg-gradient-to-b from-[#F8FAFC] to-white -mx-6 -mt-6 sm:-mx-7 sm:-mt-7 p-5 sm:p-6 rounded-t-xl">
                  
                  {/* Sovereign Marks: Ashoka Lion Capital + NTA Official Mark */}
                  <div className="flex flex-wrap items-center gap-4 sm:gap-6">
                    
                    {/* Left: Ashoka Lion Capital */}
                    <div className="flex items-center gap-2 shrink-0">
                      <img
                        src={emblemSvg}
                        alt="State Emblem of India - Satyameva Jayate"
                        className="h-16 sm:h-18 w-auto object-contain drop-shadow-xs"
                      />
                    </div>

                    {/* Divider */}
                    <div className="hidden sm:block h-12 w-[1px] bg-slate-300" />

                    {/* Right: NTA Logo + Central Candidate Biometric Verification System */}
                    <div className="flex flex-col justify-center">
                      <img
                        src={ntaLogo}
                        alt="National Testing Agency - Excellence in Assessment"
                        className="h-8 sm:h-10 w-auto object-contain self-start"
                      />
                      <div className="text-xs sm:text-[13px] font-semibold text-slate-600 tracking-tight mt-1 font-sans">
                        Central Candidate Biometric Verification System
                      </div>
                    </div>
                  </div>

                  {/* 3D Embossed Seal — reflects the actual verdict.
                      Verified → green seal; denied → rose seal with
                      "DENIED" text. No hardcoded "VERIFIED PASS". */}
                  <div className="relative flex items-center justify-center w-18 h-18 self-center sm:self-auto shrink-0">
                    <div className={`shockwave-ring absolute w-18 h-18 rounded-full border-2 pointer-events-none ${
                      result === 'denied' ? 'border-[#DC2626]' : 'border-[#0F6B45]'
                    }`} />

                    <div className={`seal-stamp-anim w-16 h-16 rounded-full p-[2px] shadow-lg flex items-center justify-center ${
                      result === 'denied'
                        ? 'bg-gradient-to-br from-[#DC2626] to-[#7F1D1D]'
                        : 'bg-gradient-to-br from-[#0F6B45] to-[#0A4A30]'
                    }`}>
                      <div className="w-full h-full rounded-full border border-white/40 flex flex-col items-center justify-center text-center p-1 text-white">
                        <span className={`font-seal text-[8px] font-black tracking-wider leading-none ${
                          result === 'denied' ? 'text-rose-200' : 'text-amber-200'
                        }`}>
                          {result === 'denied' ? 'DENIED' : 'VERIFIED'}
                        </span>
                        <span className="font-bold text-[10px] mt-0.5">
                          {result === 'denied' ? 'FAIL' : 'PASS'}
                        </span>
                        <span className={`text-[6.5px] font-semibold tracking-wider ${
                          result === 'denied' ? 'text-rose-100' : 'text-emerald-200'
                        }`}>BOARD AUTH</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Certificate Title & Exam Metadata Sub-Header.
                    The "Official Verification Certificate & Admit
                    Clearance" eyebrow and the "SESSION: FORENOON"
                    hardcoded shift text were removed on operator
                    request — neither reflects real data. */}
                <div className="relative z-1 pt-3 pb-3 border-b border-dashed border-[#D5DDE7] flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <h2 className="text-lg sm:text-xl font-bold text-[#0B1F3A] tracking-tight font-display">
                      Examination Hall Candidate Biometric Verification Record
                    </h2>
                  </div>
                  <div className="text-left sm:text-right text-xs text-slate-500">
                    <div><span className="font-semibold text-[#0B1F3A]">EXAM:</span> {candidate?.exam_name || wallet?.assigned_exam_name || '—'}</div>
                  </div>
                </div>

                {/* Side by Side Photos & Audit Grid */}
                <div className="relative z-1 grid grid-cols-1 sm:grid-cols-12 gap-5 my-auto py-3 items-center flex-1">
                  {/* Dual Photos */}
                  <div className="sm:col-span-5 grid grid-cols-2 gap-2.5">
                    <div className="rounded-lg overflow-hidden border border-[#D5DDE7] bg-slate-100 aspect-[4/5] relative flex items-center justify-center shadow-xs">
                      {photoBlob ? (
                        <img
                          src={photoBlob}
                          alt="Enrolled"
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex flex-col items-center justify-center bg-[#EEF5FD] text-[#0B4F8F] p-2 text-center">
                          <svg className="w-8 h-8 opacity-60 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                          </svg>
                          <span className="text-[9px] font-semibold">ENROLLED</span>
                        </div>
                      )}
                      <div className="absolute bottom-0 inset-x-0 bg-[#0B2545]/90 text-white text-[9px] font-semibold py-0.5 text-center">
                        ENROLLED
                      </div>
                    </div>
                    <div className="rounded-lg overflow-hidden border-2 border-[#0F6B45] bg-slate-100 aspect-[4/5] relative flex items-center justify-center shadow-xs">
                      {snap ? (
                        <img
                          src={snap}
                          alt="Live Match"
                          className="w-full h-full object-cover contrast-110"
                        />
                      ) : (
                        <div className="w-full h-full flex flex-col items-center justify-center bg-[#E8F5EE] text-[#0F6B45] p-2 text-center">
                          <svg className="w-8 h-8 opacity-70 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                          <span className="text-[9px] font-semibold">LIVE MATCH</span>
                        </div>
                      )}
                      <div className="absolute bottom-0 inset-x-0 bg-[#0F6B45] text-white text-[9px] font-semibold py-0.5 text-center flex items-center justify-center gap-1">
                        <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="3">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                        LIVE MATCH
                      </div>
                    </div>
                  </div>

                  {/* Audit & Verification Clearance Fields */}
                  <div className="sm:col-span-7 space-y-2 text-xs">
                    <div className="p-2.5 rounded-lg bg-[#F8FAFC] border border-[#E7EDF4] flex justify-between items-center">
                      <span className="text-slate-500 font-medium">Candidate:</span>
                      <span className="text-[#0B1F3A] font-bold">
                        {(candidate?.name || 'VERIFIED CANDIDATE').toUpperCase()} (<span className="font-mono text-[#0B4F8F]">{candidate?.roll_no || roll}</span>)
                      </span>
                    </div>
                    {/* Gate Clearance box removed on operator
                        request — the verdict already shows on the
                        seal + the per-modality rows below. Verification
                        Station stays as a single full-width row. */}
                    <div className="p-2 rounded-lg bg-[#F8FAFC] border border-[#E7EDF4] text-[11px]">
                      <span className="text-slate-500 block">Verification Station:</span>
                      <span className="font-semibold text-[#0B1F3A] truncate block">{candidate?.center_name || '—'}</span>
                    </div>
                    {/* Real per-modality rows. Only render the rows for
                        modalities that were actually enrolled + captured
                        for this candidate — otherwise the receipt reads
                        like an over-promise. Each row's tint reflects
                        the real match verdict, not a hardcoded pass. */}
                    {hasEnrolledFace && (
                      <ModalityRow
                        label="Face Match (1:1)"
                        matched={faceResult?.ok === true}
                        skipped={!!faceResult?.notRequired}
                        error={!!faceResult?.error}
                      />
                    )}
                    {hasEnrolledFingerprint && (
                      <ModalityRow
                        label="Fingerprint Match"
                        matched={fpStatus === 'pass'}
                        skipped={fpStatus === 'idle' && !fpResult}
                        error={fpStatus === 'fail'}
                      />
                    )}
                    {hasEnrolledIris && (
                      <ModalityRow
                        label="Iris Match"
                        matched={irisStatus === 'pass'}
                        skipped={irisStatus === 'idle' && !irisResult}
                        error={irisStatus === 'fail'}
                      />
                    )}
                  </div>
                </div>

                {/* Action Bar */}
                <div className="relative z-1 pt-3.5 border-t border-[#D5DDE7] flex flex-wrap items-center justify-between gap-3 text-xs -mx-6 -mb-6 sm:-mx-7 sm:-mb-7 p-4 sm:p-5 bg-[#F8FAFC] rounded-b-xl">
                  <div className="text-[11px] text-slate-500 flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-[#0F6B45] animate-pulse" />
                    <span>Digital record cryptographically sealed</span>
                  </div>

                  <div className="flex items-center gap-2">
                    {/* PDF actions only appear when the backend actually
                        saved the row and gave us a numeric verification
                        id. Prevents the old `window.print()` fallback
                        which printed the browser view (with the sidebar,
                        stage bar, etc.) instead of the proper backend
                        receipt PDF. Both buttons hit the real
                        /api/verifications/:id/pdf endpoint. */}
                    {verificationId && typeof verificationId === 'number' ? (
                      <>
                        <button
                          type="button"
                          onClick={() => printVerificationPDF(verificationId)}
                          className="px-4 py-2.5 rounded-lg bg-[#0F6B45] hover:bg-[#0c5938] text-white font-semibold transition shadow-xs flex items-center justify-center gap-1.5 cursor-pointer text-xs"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                          </svg>
                          <span>Print PDF Receipt</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => downloadVerificationPDF(verificationId)}
                          className="px-3.5 py-2.5 rounded-lg border border-[#D5DDE7] bg-white hover:bg-slate-50 text-[#0B1F3A] font-semibold transition shadow-2xs cursor-pointer text-xs"
                        >
                          Download
                        </button>
                      </>
                    ) : (
                      <span className="text-[11px] text-slate-400 italic">PDF receipt unavailable — verification not saved.</span>
                    )}
                    <button
                      type="button"
                      onClick={resetDesk}
                      className="px-4 py-2.5 rounded-lg bg-[#0B4F8F] hover:bg-[#083E72] text-white font-semibold transition shadow-xs cursor-pointer text-xs"
                    >
                      Next Candidate →
                    </button>
                  </div>
                </div>

              </div>
            )}

          </div>
        </div>

      </div>

      <ExamWindowReminderModal
        open={Boolean(windowReminder)}
        onClose={() => setWindowReminder(null)}
        {...windowReminder}
      />
    </AppShell>
  )
}
