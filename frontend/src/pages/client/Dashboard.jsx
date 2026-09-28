import BioStage from '../../components/fv/BioStage.jsx'
import BlinkWipe from '../../components/fv/BlinkWipe.jsx'
import PrintPlate, { demoCapture } from '../../components/fv/PrintPlate.jsx'
import CaptureStage from '../../components/fv/CaptureStage.jsx'
import Verifier from '../../components/login/Verifier.jsx'
import { HindiName } from '../../components/fv/hindi.jsx'
import PhotoBoothScene from '../../components/fv/PhotoBoothScene.jsx'
import FaceHud from '../../components/fv/FaceHud.jsx'
import { FingerScene, IrisScene } from '../../components/fv/ScanScene.jsx'
import AgentDeskScene from '../../components/fv/AgentDeskScene.jsx'
import { hi } from '../../components/fv/hindi.jsx'
import { GlyphSheet, ArtScanner, DecisionStamp } from '../../components/fv/FvArt.jsx'
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

// An operator spends against the purse their admin allocated. No
// allocation means no spending: the API refuses both the roll lookup
// and the liveness charge, so the desk cannot verify anyone until an
// admin sets a cap.
function hasPurse(wallet) {
  return typeof wallet?.cap_paise === 'number' && wallet.cap_paise > 0
}

// The 402 that says "nothing allocated" rather than "wallet empty" or
// "cap exhausted" — marked by cap_paise 0 in the body.
function isNoPurseError(err) {
  return isWalletEmptyError(err) && err?.body?.cap_paise === 0
}
import ntaLogo from '../../assets/nta-logo.png'
import emblemSvg from '../../assets/emblem.svg'
// Real biometric-vendor SDKs. The mock capture handlers below used to
// fake progress bars and hardcode device serials; the SDKs plumb the
// actual USB scanner + local daemon on the operator laptop and post
// the captured probe to the backend's match orchestrator.
import { pollConnected, DefaultThresholds } from '../../lib/verify/fingerprint/registry.js'
import { DEMO, demoWait } from '../../lib/demo.js'
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
    ? '#5B3FA6'
    : isFail
    ? '#A8711F'
    : isScanning
    ? '#5B3FA6'
    : '#A29EB3'

  const frameColor = isPass
    ? '#5B3FA6'
    : isFail
    ? '#A8711F'
    : isScanning
    ? '#5B3FA6'
    : '#A29EB3'

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
          <g stroke="#5B3FA6" strokeWidth="1.9" strokeLinecap="round" fill="none">
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
          stroke="#5B3FA6"
          strokeWidth="2.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}

      {/* Verification Cross (Fail) */}
      {isFail && (
        <path
          d="M20 31l8 8M28 31l-8 8"
          stroke="#A8711F"
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
    ? '#5B3FA6'
    : isFail
    ? '#A8711F'
    : isScanning
    ? '#5B3FA6'
    : '#A29EB3'

  const frameColor = isPass
    ? '#5B3FA6'
    : isFail
    ? '#A8711F'
    : isScanning
    ? '#5B3FA6'
    : '#A29EB3'

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
          stroke="#5B3FA6"
          strokeWidth="2.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}

      {/* Verification Cross (Fail) */}
      {isFail && (
        <path
          d="M20 31l8 8M28 31l-8 8"
          stroke="#A8711F"
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
      <div className="p-2.5 rounded-lg bg-[#EFEBF9] border border-[#C3B6E8] text-[#5B3FA6] flex justify-between items-center font-semibold">
        <span className="flex items-center gap-1.5">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7" />
          </svg>
          {label}:
        </span>
        <span>Matched</span>
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
        <span>Not captured</span>
      </div>
    )
  }
  return (
    <div className="p-2.5 rounded-lg bg-[#F6EDDD] border border-[#EDD9B8] text-[#A8711F] flex justify-between items-center font-semibold">
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
  // No purse allocated to this operator. Distinct from walletEmpty:
  // the institution may be flush, but nothing has been allocated to
  // this desk, so the fix is an admin assigning a cap, not a top-up.
  const [noPurse, setNoPurse] = useState(false)
  const [windowReminder, setWindowReminder] = useState(null)

  // Wallet
  const [wallet, setWallet] = useState(null)
  const refreshWallet = () => {
    getWalletSummary().then((w) => {
      setWallet(w)
      // Admin allocated a purse while the operator was sitting on the
      // warning — clear it on the next heartbeat rather than making
      // them reload the page.
      if (hasPurse(w)) setNoPurse(false)
    }).catch(() => {})
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
  // No auto-advance here any more. The operator saw the photo step
  // flash past: liveness passes in a blink on a good capture, and the
  // stage moved itself on before they could read the result. They move
  // it on now, with the button on the capture screen.

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
    setNoPurse(false)

    // An operator with no purse can't finish a verification, and the
    // API refuses the lookup for the same reason. When the wallet
    // summary already told us that, say so on the spot instead of
    // spending a round trip to be told the same thing.
    if (wallet && !hasPurse(wallet)) {
      setCandidate(null)
      setNoPurse(true)
      return
    }

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
      if (isNoPurseError(e)) {
        // Don't refresh the wallet here: the summary and this 402 read
        // the same column, so a summary that still reports a purse is
        // stale, and letting it answer would wipe the warning the
        // server just issued. The 20s heartbeat clears it on its own
        // once a purse genuinely exists.
        setNoPurse(true)
      } else if (isWalletEmptyError(e)) {
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
    if (DEMO) {
      setLivenessPassing(true)
      setBlinkState('PLEASE BLINK ONCE'); setBlinkProgress(60)
      await demoWait(1200)
      const demoSnap = grabLiveVideoSnapshot() || photoBlob
      setSnap(demoSnap)
      setBlinkState('PASSED'); setBlinkProgress(100)
      setLivenessConfidence('99.8%'); setFaceOrientationStatus('OPTIMAL')
      setLivenessOK(true)
      setFaceResult({ ok: true, status: true, score: 0.97, threshold: 0.9, snapshot: demoSnap })
      setLivenessPassing(false)
      setLivenessPassed(true)
      setLivenessResult({ pass: true })
      return
    }
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
    if (DEMO) {
      await demoWait(1500)
      setFpResult({ ok: true, score: 212, threshold: 40, vendor: 'startek', deviceModel: 'FM220U (demo)',
        deviceSerial: 'DEMO-0001', quality: 82, nfiq: 2, liveness: 1, templateFormat: 'FMR_V2005',
        print: demoCapture('finger', candidate?.roll_no || '') })
      setFpScore(212)
      setFpStatus('pass')
      return
    }

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
        // the ridge picture the device lifted, when it gives us one
        print: r.BitmapDataUrl || (r.BitmapData ? `data:image/bmp;base64,${r.BitmapData}` : null),
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
    if (DEMO) {
      await demoWait(1500)
      setIrisResult({ ok: true, leftScore: 88, leftQuality: 76, threshold: 50, engine: 'demo',
        galleryMissing: false, deviceModel: 'MIS100V2 (demo)', deviceSerial: 'DEMO-IRIS-01',
        eye: demoCapture('iris', candidate?.roll_no || '') })
      setIrisStatus('pass')
      return
    }
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
        // the eye it photographed
        eye: cap?.BitmapData ? `data:image/bmp;base64,${cap.BitmapData}` : null,
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
    ['Find the candidate', 'अभ्यर्थी खोजें'],
    ['Take their photo', 'तस्वीर लें'],
    ['Match the face', 'चेहरा मिलाएँ'],
    ['Their fingerprint', 'अंगुली'],
    ['The decision', 'निर्णय'],
  ]

  // The two biometrics are taken one after the other, not side by side:
  // the fingerprint first, then the iris.
  const [bioStep, setBioStep] = useState('fp')
  // Landing gate for stage 3 (biometrics). Off means the operator
  // sees the dashboard-style prep card with a "Scan the …" button;
  // flipping it on opens the fullscreen BioStage overlay. Resets
  // whenever stage changes (new candidate) or the modality switches
  // (fp → iris), so every biometric starts on its own prep screen.
  const [bioOpen, setBioOpen] = useState(false)
  useEffect(() => { if (currentStage !== 3) setBioOpen(false) }, [currentStage])
  useEffect(() => { setBioOpen(false) }, [bioStep])
  // the eye was the last thing read, so the desk blinks on the way out
  const [blinking, setBlinking] = useState(false)
  useEffect(() => {
    if (currentStage !== 3) return
    // the eye only comes up on its own once the finger is done (or the
    // candidate has no finger on file) — it must never skip the finger
    if (!hasEnrolledFingerprint) setBioStep('iris')
    else if (fpStatus !== 'pass') setBioStep('fp')
  }, [currentStage, hasEnrolledFingerprint, hasEnrolledIris, fpStatus])
  // The eye does not come up by itself either — the operator reads the
  // fingerprint result, then moves on.

  const deskState = isSearching ? 'searching'
    : lookupErr ? 'error'
    : noPurse || walletEmpty ? 'error'
    : roll.trim().length >= 5 ? 'ready'
    : roll.trim().length > 0 ? 'typing'
    : 'idle'
  // Step 1 is done the moment the candidate is on screen, so the strip
  // points at what the operator does next, not at what just finished.
  // At the camera the companion carries the instruction, so the stage
  // needs no bars and no spinner.
  const bioNow = bioStep === 'iris' ? irisStatus : fpStatus
  const bioLine = bioNow === 'pass'
    ? (bioStep === 'iris' ? ['The iris matched', 'पुतली मिल गई'] : ['The fingerprint matched', 'अंगुली मिल गई'])
    : bioNow === 'fail'
      ? (bioStep === 'iris' ? ['The iris did not match', 'पुतली मेल नहीं खाई'] : ['The fingerprint did not match', 'अंगुली मेल नहीं खाई'])
      : bioNow === 'scanning'
        ? (bioStep === 'iris' ? ['Reading the iris…', 'पुतली पढ़ रहे हैं'] : ['Reading the ridges…', 'रेखाएँ पढ़ रहे हैं'])
        : (bioStep === 'iris'
            ? ['Bring their eye to the tower', 'उनकी आँख टावर तक लाएँ']
            : ['Put their finger on the reader', 'उनकी अंगुली रीडर पर रखें'])

  const camMood = livenessPassed ? { type: 'right' }
    : livenessPassing ? { type: 'waiting' }
    : faceDetected ? { type: 'namaste' }
    : { type: 'point' }
  const camLine = livenessPassed ? ['Live person', 'जीवित व्यक्ति']
    : livenessPassing ? ['Reading the blink…', 'पलक पढ़ रहे हैं']
    : faceDetected ? ['Blink once, slowly', 'एक बार धीरे पलक झपकाएँ']
    : ['Look straight at the camera', 'सीधे कैमरे को देखें']

  // The finger and the eye are their own steps now, so stage 3 is either.
  const activeStep = currentStage === 3
    ? (bioStep === 'iris' ? 4 : 3)
    : ([1, 2, 2, 3, 5][currentStage] || 1)
  const stepLabel = currentStage === 3
    ? (bioStep === 'iris' ? ['Their iris', 'पुतली'] : ['Their fingerprint', 'अंगुली'])
    : (pipelineStepLabels[currentStage] || pipelineStepLabels[0])
  const isSearchLocked = Boolean(candidate) || currentStage > 0 || isSearching

  // Custom Sovereign Verification Desk Header in signature Navy Chrome
  const renderSovereignHeader = ({ user, handleLogout, ReportProblem, AvatarMenu }) => {
    const fee = wallet?.fee_per_lookup_paise || 500
    const capPaise = wallet?.cap_paise
    const spent = wallet?.spent_paise || 0
    const capped = typeof capPaise === 'number' && capPaise > 0
    // Personal-purse pill. The operator spends against the cap their
    // admin allocated, and nothing else: with no cap assigned the
    // purse is zero, not the institution's balance. The API enforces
    // the same rule — a lookup without a cap comes back 402 — so the
    // pill reading ₹0.00 is the literal truth about what this
    // operator can spend, not a placeholder.
    const allocated = capped ? capPaise : 0
    const remaining = capped ? Math.max(0, capPaise - spent) : 0

    return (
      <div className="w-full shrink-0">
        {/* Sovereign Gold Ribbon */}
<div aria-hidden="true" className="w-full"><div className="h-[3px] bg-[#F28C28]" /><div className="h-[3px] bg-white" /><div className="h-[3px] bg-[#138808]" /></div>

        <header className="fv sticky top-0 z-30 bg-fv-card border-b border-fv-line w-full py-3 px-4 sm:px-8 lg:px-10 flex flex-wrap items-center justify-between gap-4">
          {/* Official Brand Lockup */}
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="fv-emblem h-10 shrink-0" />
            <div>
              <div className="fv-display text-[18px] font-bold text-fv-ink leading-tight flex items-center gap-2.5 tracking-[-0.02em]">
                <span>Verification Portal</span>
                <span className="text-[12px] font-semibold px-2 py-0.5 rounded-full bg-fv-card-focus text-fv-accent-deep tracking-normal">
                  Verification desk
                </span>
              </div>
              {/* Subtitle line pulls from the wallet's assigned exam +
                  the candidate's center. Both were previously hardcoded
                  fake ("DELHI CENTRAL", "DEL-04B") which looked like
                  seeded demo data. Empty parts collapse quietly. */}
              {(wallet?.assigned_exam_name || candidate?.center_name) && (
                <div className="text-[13px] text-fv-muted mt-0.5 font-normal">
                  {candidate?.center_name && <>Centre <span className="font-semibold text-fv-ink">{candidate.center_name}</span></>}
                  {candidate?.center_name && wallet?.assigned_exam_name && <span className="mx-2 text-fv-faint">/</span>}
                  {wallet?.assigned_exam_name && <>Exam <span className="font-semibold text-fv-ink">{wallet.assigned_exam_name}</span></>}
                </div>
              )}
            </div>
          </div>

          {/* Center Status & Operator Allocation */}
          <div className="flex items-center gap-3 sm:gap-4 flex-wrap">
            {/* Wallet pill — always remaining / allocated, because the
                allocation is the only money this operator commands.
                No cap assigned reads ₹0.00 / ₹0.00 and the pill turns
                amber: the desk is unfunded, lookups will be refused,
                and the admin needs to allocate a purse. */}
            <div
              className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg border text-xs shadow-xs ${
                capped
                  ? 'bg-fv-card-focus border-fv-line'
                  : 'bg-[#F6EDDD] border-[#EDD9B8]'
              }`}
              title={capped
                ? `Remaining: ${formatRupees(remaining)} | Allocated Purse: ${formatRupees(allocated)}`
                : 'No purse allocated — ask your admin to set a spending limit before verifying'}
            >
              <svg className="w-3.5 h-3.5 text-fv-accent shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"
                />
              </svg>
              <span className="text-fv-muted">Purse</span>
              <span className="font-bold text-fv-ink tabular-nums">{formatRupees(remaining)}</span>
              <span className="text-fv-faint">/ <span className="text-fv-muted font-medium tabular-nums">{formatRupees(allocated)}</span></span>
              {!capped && (
                <span className="font-semibold text-[#7A4F12]">not allocated</span>
              )}
            </div>

            {/* Downloads or Start Over Action */}
            {currentStage === 0 ? (
              <Link
                to="/institute/operator/downloads"
                title="Download the install bundle for a new verification agent laptop"
                className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-fv-line bg-fv-card hover:bg-fv-card-focus text-fv-accent-deep text-[13px] font-semibold transition"
              >
                <svg className="w-3.5 h-3.5 text-fv-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                <span>Downloads</span>
              </Link>
            ) : (
              <button
                type="button"
                onClick={resetDesk}
                className="px-3 py-1.5 rounded-lg border border-fv-line bg-fv-card hover:bg-fv-card-focus text-fv-accent-deep text-[13px] font-semibold transition cursor-pointer"
              >
                Start over
              </button>
            )}

            <ReportProblem />
            <AvatarMenu user={user} onLogout={handleLogout} />
          </div>
        </header>
      </div>
    )
  }

  const renderDeskFooter = (
    <footer className="w-full py-3 bg-white border-t border-[#E3E1EA] text-center text-xs text-slate-500 shrink-0">
      Verification Portal {APP_VERSION}
      <span className="fv-hi ml-2 text-fv-faint">सत्यापन डेस्क</span>
    </footer>
  )

  return (
    <>
      <BlinkWipe
        active={blinking}
        hold={currentStage !== 4}
        onShut={() => { if (currentStage !== 4) submitFinalVerification() }}
        onDone={() => setBlinking(false)}
      />
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
      <section className="w-full overflow-x-auto rounded-xl border border-fv-line bg-white p-2.5 sm:p-3">
        <div className="mb-2 flex items-center justify-between gap-4 px-1">
          <h2 className="fv-display text-[17px] font-bold tracking-[-0.015em] text-fv-ink">
            Checking a candidate
            <span className="fv-hi ml-2 text-[13px] font-bold text-fv-faint">अभ्यर्थी की जाँच</span>
          </h2>
          <span className="flex items-baseline gap-2 whitespace-nowrap">
            <span className="text-[13px] font-bold text-fv-muted">Step {activeStep} of 5</span>
            <span className="text-[14px] font-bold text-fv-ink">{stepLabel[0]}</span>
            <span className="fv-hi hidden text-[12.5px] font-bold text-fv-faint sm:inline">{stepLabel[1]}</span>
          </span>
        </div>

        {/* How far the check has got. Each step is drawn, not numbered. */}
        <ol className="flex w-full min-w-[700px] items-center gap-2.5">
          {PIPE.map((st, i) => {
            const n = i + 1
            const done = currentStage === 4 ? n < 5 : activeStep > n
            const now = currentStage === 4 ? n === 5 : activeStep === n
            const Art = st.art
            return (
              <li key={st.title} className={`flex items-center gap-2.5 ${i < 4 ? 'flex-1' : 'shrink-0'}`}>
                <span className={`relative grid h-[min(48px,5vh)] w-[min(48px,5vh)] shrink-0 place-items-center rounded-[15px] border-2 transition-colors duration-300 ${
                  done ? 'border-fv-accent bg-fv-accent'
                    : now ? 'border-fv-accent bg-fv-card-focus'
                    : 'border-fv-line bg-fv-page'}`}>
                  {done ? (
                    <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="#FFFFFF" strokeWidth="3.4"
                         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M5 12.5l4.5 4.5L19 7" />
                    </svg>
                  ) : (
                    <Art className={`h-[68%] w-[68%] transition-opacity duration-300 ${now ? 'opacity-100' : 'opacity-60'}`} />
                  )}
                  {now && <span aria-hidden="true" className="fv-breathe absolute -inset-1.5 rounded-[21px] border-2 border-fv-accent/40" />}
                </span>
                <span className="min-w-0 leading-tight">
                  <span className={`block whitespace-nowrap text-[15.5px] font-bold ${done || now ? 'text-fv-ink' : 'text-fv-faint'}`}>{st.title}</span>
                  <span className="fv-hi hidden whitespace-nowrap text-[12.5px] font-bold text-fv-faint sm:block">{st.hi}</span>
                </span>
                {i < 4 && (
                  <span className="relative ml-1 hidden h-[5px] flex-1 overflow-hidden rounded-full bg-fv-line sm:block">
                    <span className={`absolute inset-y-0 left-0 rounded-full bg-fv-accent transition-all duration-700 ${
                      done ? 'w-full' : now ? 'fv-flow w-1/3' : 'w-0'}`} />
                  </span>
                )}
              </li>
            )
          })}
        </ol>
      </section>

      {/* TWO-COLUMN WORK SURFACE (LEFT SEARCH CARD + DYNAMIC RIGHT STAGE CANVAS) */}
      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)] items-stretch gap-5 lg:grid-cols-12">
        
        {/* ================= LEFT RAIL: CANDIDATE SEARCH & REGISTERED DOSSIER ================= */}
        <div className="flex h-full min-h-0 flex-col space-y-4 overflow-hidden lg:col-span-4 xl:col-span-4">
          
          {/* Step 1: Candidate Roll Search Card (Visible when no candidate is active) */}
          {!candidate && (
            <div className="p-5 rounded-xl bg-white border border-[#E3E1EA] shadow-xs space-y-4 animate-surface-in">
              <div className="flex items-center gap-3 border-b border-fv-line pb-2.5">
                <RollCardArt className="h-10 w-10 shrink-0" />
                <h2 className="fv-display text-[17px] font-bold tracking-[-0.015em] text-fv-ink">
                  Find the candidate
                  <span className="fv-hi ml-2 text-[12.5px] font-bold text-fv-faint">अभ्यर्थी खोजें</span>
                </h2>
              </div>

              <form onSubmit={handleRollSubmit} className="space-y-3">
                <div>
                  <label className="mb-1.5 block text-[13.5px] font-bold text-fv-muted">
                    Roll number
                    <span className="fv-hi ml-1.5 text-[12px] font-bold text-fv-faint">अनुक्रमांक</span>
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      value={roll}
                      onChange={(e) => setRoll(e.target.value)}
                      placeholder="e.g. 10001"
                      disabled={isSearchLocked}
                      className="w-full rounded-[10px] border border-fv-line bg-fv-page px-4 py-2.5 text-[20px] font-bold tabular-nums tracking-[0.02em] text-fv-ink transition focus:border-fv-accent focus:bg-white focus:outline-none focus:ring-2 focus:ring-fv-accent/20 placeholder:text-[16px] placeholder:font-medium placeholder:text-fv-faint disabled:cursor-not-allowed disabled:opacity-60"
                      autoFocus={!isSearchLocked}
                    />
                  </div>
                </div>

                <RollKeypad
                  value={roll}
                  disabled={isSearchLocked}
                  onChange={setRoll}
                  onEnter={() => { if (!isSearchLocked && !isSearching && roll.trim()) handleRollSubmit() }}
                />

                {noPurse && (
                  <div role="alert" className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2.5 text-xs text-amber-900">
                    <p className="font-semibold">No verification purse allocated</p>
                    <p className="mt-0.5 leading-relaxed text-amber-800">
                      Your administrator hasn't set a spending limit for this
                      desk yet, so candidate lookups are on hold. Ask them to
                      allocate a purse, then search again.
                    </p>
                  </div>
                )}

                {lookupErr && !isSearchLocked && (
                  <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-700 font-medium">
                    {lookupErr}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={isSearchLocked || isSearching || !roll.trim()}
                  className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-[10px] bg-fv-accent px-4 py-2.5 text-[15px] font-bold text-white transition hover:bg-fv-accent-deep disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  <span>{isSearching ? 'Looking them up…' : 'Look up'}</span>
                </button>
              </form>
            </div>
          )}

          {/* Enrolled Registration Record Card (Revealed Once Searched, Takes Full Left Column) */}
          {candidate && (
            <div className="flex h-full min-h-0 flex-col gap-2 rounded-xl border border-fv-line bg-white p-3.5 shadow-xs transition-all duration-300 animate-surface-in">
              <div>
                {/* Photo Area: Always uniform Dual-Photo Grid (Enrolled + Captured / Awaiting Capture) */}
                <div className="space-y-3 animate-surface-in">
                  {/* Dual Photos Side-by-Side */}
                  <div className="flex h-[min(252px,19vh)] items-stretch justify-center gap-2.5">
                    {/* Enrolled Photo — held back until the live snap
                        is in. Before that the tile stays in place with
                        the "On file" label but shows the neutral
                        silhouette, so an operator can't glance-cheat
                        by comparing before they've captured. */}
                    <div className="relative aspect-[7/9] h-full w-auto shrink overflow-hidden rounded-lg border border-fv-line bg-slate-100 flex items-center justify-center shadow-2xs">
                      {(photoBlob && snap) ? (
                        <img
                          src={photoBlob}
                          alt="Enrolled Candidate"
                          className="w-full h-full object-cover"
                        />
                      ) : !photoBlob ? (
                        // Candidate genuinely has no enrolled photo.
                        <div className="w-full h-full flex flex-col items-center justify-center bg-[#EFEBF9] text-[#5B3FA6] p-2 text-center">
                          <svg className="w-7 h-7 opacity-60 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                          </svg>
                          <span className="text-[10px] font-bold leading-tight">No photo</span>
                        </div>
                      ) : (
                        // We HAVE the enrolled photo but hold it back
                        // until the live snap lands — friendlier
                        // "unlocks after the face check" placeholder
                        // than a misleading "No photo".
                        <div className="w-full h-full flex flex-col items-center justify-center bg-[#EFEBF9] text-[#5B3FA6] p-2 text-center">
                          <svg className="w-7 h-7 opacity-70 mb-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <rect x="5" y="11" width="14" height="9" rx="2" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M8 11V8a4 4 0 118 0v3" />
                            <circle cx="12" cy="15.5" r="1.2" />
                          </svg>
                          <span className="text-[10.5px] font-bold leading-tight">Reveals after face</span>
                          <span className="fv-hi mt-0.5 text-[10px] font-bold leading-tight opacity-80">फ़ेस के बाद</span>
                        </div>
                      )}
                      <div className="absolute inset-x-0 bottom-0 bg-fv-ink/85 py-1 text-center text-[11px] font-bold text-white">
                        On file <span className="fv-hi font-bold opacity-80">दर्ज</span>
                      </div>
                    </div>

                    {/* Tile paint mirrors the verdict — a captured photo
                        alone is not proof of match. */}
                    {snap ? (() => {
                      const facePassed = faceResult?.ok === true
                      const faceFailed = faceResult?.ok === false
                      const border = facePassed
                        ? 'border-[#5B3FA6]'
                        : faceFailed
                        ? 'border-[#A8711F]'
                        : 'border-[#5B3FA6]'
                      const bar = facePassed
                        ? 'bg-[#5B3FA6]'
                        : faceFailed
                        ? 'bg-[#A8711F]'
                        : 'bg-[#5B3FA6]'
                      return (
                        <div className={`relative aspect-[7/9] h-full w-auto shrink overflow-hidden rounded-lg border-2 ${border} bg-slate-100 flex items-center justify-center shadow-2xs animate-surface-in`}>
                          <img
                            src={snap}
                            alt="Captured Candidate"
                            className="w-full h-full object-cover contrast-105"
                          />
                          <div className={`absolute inset-x-0 bottom-0 ${bar} flex items-center justify-center gap-1.5 py-1 text-center text-[11px] font-bold text-white`}>
                            {facePassed ? (
                              <>
                                <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="3">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                </svg>
                                Matched
                              </>
                            ) : faceFailed ? (
                              <>
                                <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="3">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                                Not matched
                              </>
                            ) : (
                              <>Captured</>
                            )}
                          </div>
                        </div>
                      )
                    })() : (
                      <div className="relative aspect-[7/9] h-full w-auto shrink overflow-hidden rounded-lg border-2 border-dashed border-fv-accent-soft/70 bg-fv-card-focus/40 flex flex-col items-center justify-center text-center p-2.5 transition-all">
                        <div className="w-10 h-10 rounded-full bg-white border border-[#9A86D6] flex items-center justify-center text-[#5B3FA6] mb-1.5 shadow-2xs">
                          <svg className="w-5 h-5 text-[#5B3FA6] animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                            <circle cx="12" cy="13" r="3" strokeWidth="1.8" />
                          </svg>
                        </div>
                        <span className="text-[12px] font-bold leading-tight text-fv-accent-deep">Live photo</span>
                        <span className="fv-hi mt-0.5 text-[11px] font-bold leading-tight text-fv-faint">सीधी तस्वीर</span>
                        <div className="absolute inset-x-0 bottom-0 border-t border-fv-accent-soft/60 bg-fv-card-focus py-1 text-center text-[11px] font-bold text-fv-accent-deep">
                          Next step
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Candidate Details Grid Card */}
                  <div className="space-y-0.5 rounded-lg border border-fv-line bg-fv-page px-3 py-1 text-xs">
                    <div className="flex items-center justify-between gap-2 border-b border-fv-line pb-1">
                      <div className="fv-display truncate text-[17.5px] font-bold tracking-[-0.02em] text-fv-ink">
                        {candidate.name || 'This candidate'}
                        <HindiName name={candidate.name} className="ml-2 text-[13px] font-bold" />
                      </div>
                      <span className="shrink-0 rounded-[9px] border border-fv-accent-soft bg-fv-card-focus px-2.5 py-1 text-[13px] font-bold tabular-nums text-fv-accent-deep">
                        {candidate.roll_no}
                      </span>
                    </div>

                    <div className="space-y-0.5 pt-0.5 text-[11.5px]">
                      <div className="flex items-center justify-between text-slate-600">
                        <span className="text-[13.5px] font-bold text-fv-faint">
                          Exam <span className="fv-hi font-bold text-fv-faint">परीक्षा</span>
                        </span>
                        <span className="max-w-[190px] truncate text-[13.5px] font-bold text-fv-ink">
                          {candidate.exam_name || wallet?.assigned_exam_name || '—'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-slate-600">
                        <span className="text-[13.5px] font-bold text-fv-faint">
                          Centre <span className="fv-hi font-bold text-fv-faint">केंद्र</span>
                        </span>
                        <span className="max-w-[190px] truncate text-[13.5px] font-bold text-fv-ink" title={candidate.center_name || '—'}>
                          {candidate.center_name || '—'}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Where each check stands, on a rail that fills as it goes. */}
              <CheckRail
                rows={[
                  { key: 'live', title: 'Liveness', hi: 'जीवंतता', art: LivenessArt, ok: 'Passed', hiOk: 'पास',
                    bad: 'Failed', hiBad: 'फेल', state: livenessOK ? 'pass' : 'wait' },
                  { key: 'face', title: 'Face', hi: 'चेहरा', art: FaceStep, ok: 'Matched', hiOk: 'मिला',
                    bad: 'Not matched', hiBad: 'मेल नहीं', show: hasEnrolledFace,
                    state: faceResult?.ok ? 'pass' : faceResult && faceResult.ok === false ? 'fail' : 'wait' },
                  { key: 'fp', title: 'Fingerprint', hi: 'अंगुली', art: FingerArt, ok: 'Matched', hiOk: 'मिला',
                    bad: 'Not matched', hiBad: 'मेल नहीं', show: hasEnrolledFingerprint,
                    state: fpStatus === 'pass' ? 'pass' : fpStatus === 'fail' ? 'fail' : fpStatus === 'scanning' ? 'busy' : 'wait' },
                  { key: 'iris', title: 'Iris', hi: 'पुतली', art: IrisArt, ok: 'Matched', hiOk: 'मिला',
                    bad: 'Not matched', hiBad: 'मेल नहीं', show: hasEnrolledIris,
                    state: irisStatus === 'pass' ? 'pass' : irisStatus === 'fail' ? 'fail' : irisStatus === 'scanning' ? 'busy' : 'wait' },
                  { key: 'end', title: 'Decision', hi: 'निर्णय', art: SealStep, ok: 'Verified', hiOk: 'सत्यापित',
                    bad: 'Denied', hiBad: 'अस्वीकृत',
                    state: result === 'verified' ? 'pass' : result === 'denied' ? 'fail' : isBiometricComplete() ? 'ready' : 'wait' },
                ]}
              />
            </div>
          )}

        </div>

        {/* ================= RIGHT WORK CANVAS: PROGRESSIVE STAGES (UPDATES IN-PLACE) ================= */}
        <div className="lg:col-span-8 xl:col-span-8 flex flex-col h-full">
          <div className="relative flex h-full min-h-[min(440px,52vh)] flex-1 flex-col justify-between overflow-hidden rounded-xl border border-fv-line bg-white p-4 shadow-xs">
            
            {/* STAGE 0: STANDBY (WAITING FOR SEARCH) */}
            {currentStage === 0 && (
              <div className="flex h-0 min-h-0 w-full flex-1 items-center justify-center animate-surface-in">
                {/* The desk itself, answering every keystroke. No words. */}
                <AgentDeskScene
                  state={deskState}
                  roll={roll}
                  className="h-full max-h-full w-auto max-w-full"
                />
              </div>
            )}

            {/* STAGE 1: CANDIDATE LOADED -> START LIVENESS */}
            {currentStage === 1 && candidate && (
              <div className="flex h-full min-h-0 flex-1 flex-col animate-surface-in">
                <div className="flex items-center justify-between gap-4 border-b border-fv-line pb-3">
                  <div>
                    <span className="text-[12px] font-bold uppercase tracking-[0.14em] text-fv-faint">Step {activeStep} of 5</span>
                    <h3 className="fv-display mt-0.5 text-[clamp(22px,3vh,30px)] font-bold leading-[1.05] tracking-[-0.03em] text-fv-ink">
                      Take their photo
                      <span className="fv-hi ml-3 align-middle text-[18px] font-bold text-fv-muted">तस्वीर लें</span>
                    </h3>
                    <p className="mt-2 text-[15px] font-medium text-fv-muted">
                      <span className="font-bold text-fv-ink">{candidate.name || 'This candidate'}</span> is on screen,
                      roll number <span className="font-bold tabular-nums text-fv-ink">{candidate.roll_no || roll}</span>.
                    </p>
                  </div>
                  <span className="shrink-0 rounded-[12px] border-2 border-fv-accent-soft bg-fv-card-focus px-4 py-2 text-[15px] font-bold text-fv-accent-deep">
                    Ready <span className="fv-hi ml-1 text-[14px] font-bold text-fv-accent">तैयार</span>
                  </span>
                </div>

                <div className="flex h-0 min-h-0 w-full flex-1 items-center justify-center py-1">
                  <PhotoBoothScene className="h-full max-h-full w-auto max-w-full" />
                </div>

                <div className="flex justify-end border-t border-fv-line pt-3">
                  <button
                    type="button"
                    onClick={() => setCurrentStage(2)}
                    className="px-6 py-3 rounded-lg bg-[#5B3FA6] hover:bg-[#43307D] text-white font-bold text-[14px] transition shadow-sm flex items-center gap-2 cursor-pointer"
                  >
                    <span>Take the photo</span>
                    <span>→</span>
                  </button>
                </div>
              </div>
            )}

            {/* STAGE 2: the capture takes the whole screen — the
                companion guides the candidate through it there. */}
            {currentStage === 2 && (
              <CaptureStage
                videoRef={videoRef}
                snap={snap}
                cameraActive={cameraActive}
                faceDetected={faceDetected}
                blinkProgress={blinkProgress}
                passing={livenessPassing}
                passed={livenessPassed}
                frozen={livenessOK && !!snap}
                error={livenessError}
                line={camLine}
                showRetake={!livenessPassed && faceResult && faceResult.ok === false && !faceResult.error}
                onNext={() => setCurrentStage(needsBiometric ? 3 : 4)}
                nextLabel={needsBiometric ? ['Next: the fingerprint', 'आगे: अंगुली'] : ['Finish the check', 'जाँच पूरी करें']}
                onCapture={handleCaptureLiveness}
                onRetake={handleRetakePhoto}
                onCarryOn={() => {
                  // Operator override — the visual check is theirs. The
                  // stage advances; faceResult.ok stays false so submit
                  // records face_match=false for the audit trail.
                  setLivenessError('')
                  setLivenessPassing(false)
                  setLivenessPassed(true)
                  setLivenessResult({ pass: true, faceOverride: true })
                }}
                onCancel={() => setCurrentStage(1)}
              />
            )}

            {/* STAGE 3 prep — the operator lands on this dashboard-style
                card between face-capture and each biometric (fp / iris)
                so the frosted BioStage overlay doesn't auto-pop the
                instant the previous step ends. Same header + scene +
                CTA rhythm as stage 1's "Take the photo" card. */}
            {currentStage === 3 && !bioOpen && (
              <div className="flex h-full min-h-0 flex-1 flex-col animate-surface-in">
                <div className="flex items-center justify-between gap-4 border-b border-fv-line pb-3">
                  <div>
                    <span className="text-[12px] font-bold uppercase tracking-[0.14em] text-fv-faint">Step {activeStep} of 5</span>
                    <h3 className="fv-display mt-0.5 text-[clamp(22px,3vh,30px)] font-bold leading-[1.05] tracking-[-0.03em] text-fv-ink">
                      {bioStep === 'iris' ? 'Take their iris' : 'Take their fingerprint'}
                      <span className="fv-hi ml-3 align-middle text-[18px] font-bold text-fv-muted">
                        {bioStep === 'iris' ? 'पुतली लें' : 'अंगुली लें'}
                      </span>
                    </h3>
                    <p className="mt-2 text-[15px] font-medium text-fv-muted">
                      {bioStep === 'iris'
                        ? 'Bring their eye up to the tower and hold still.'
                        : 'Put their finger on the reader and hold it there.'}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-[12px] border-2 border-fv-accent-soft bg-fv-card-focus px-4 py-2 text-[15px] font-bold text-fv-accent-deep">
                    Ready <span className="fv-hi ml-1 text-[14px] font-bold text-fv-accent">तैयार</span>
                  </span>
                </div>

                <div className="flex h-0 min-h-0 w-full flex-1 items-center justify-center py-1">
                  {bioStep === 'iris'
                    ? <IrisScene status="idle" className="h-full max-h-full w-auto max-w-full" />
                    : <FingerScene status="idle" className="h-full max-h-full w-auto max-w-full" />}
                </div>

                <div className="flex justify-end border-t border-fv-line pt-3">
                  <button
                    type="button"
                    onClick={() => setBioOpen(true)}
                    className="px-6 py-3 rounded-lg bg-[#5B3FA6] hover:bg-[#43307D] text-white font-bold text-[14px] transition shadow-sm flex items-center gap-2 cursor-pointer"
                  >
                    <span>{bioStep === 'iris' ? 'Scan the iris' : 'Scan the fingerprint'}</span>
                    <span>→</span>
                  </button>
                </div>
              </div>
            )}

            {/* STAGE 3: the finger and the eye, each taking the whole
                screen while it is being read. Opens only after the
                operator hits "Scan the …" on the prep card above. */}
            {currentStage === 3 && bioOpen && (
              <BioStage
                kind={bioStep === 'iris' ? 'iris' : 'finger'}
                status={bioStep === 'iris' ? irisStatus : fpStatus}
                src={bioStep === 'iris' ? irisResult?.eye : fpResult?.print}
                seed={candidate?.roll_no || ''}
                step={bioStep === 'iris' ? 4 : 3}
                line={bioLine}
                error={(bioStep === 'iris' ? irisResult : fpResult)?.error}
                onScan={bioStep === 'iris' ? handleCaptureIris : handleCaptureFingerprint}
                onBack={bioStep === 'iris' && hasEnrolledFingerprint ? () => setBioStep('fp') : null}
                /* Close on the fingerprint/iris overlay drops the operator
                   back on the Stage-3 prep card (the dashboard-style
                   landing with "Scan the fingerprint →"), NOT all the
                   way back to the face-capture step. */
                onCancel={() => setBioOpen(false)}
                onNext={() => {
                  if (bioStep === 'fp' && hasEnrolledIris && irisStatus !== 'pass') { setBioStep('iris'); return }
                  setBlinking(true)
                }}
                nextLabel={bioStep === 'fp' && hasEnrolledIris && irisStatus !== 'pass'
                  ? ['Next: the iris', 'आगे: पुतली']
                  : ['Finish the check', 'जाँच पूरी करें']}
              />
            )}
            {false && currentStage === 3 && (
              <div className="flex h-full min-h-0 flex-1 flex-col justify-between gap-2.5 animate-surface-in">
                
                {/* Stage Header */}
                <div className="flex items-center justify-between border-b border-[#EFEDF4] pb-3">
                  <div>
                    <span className="text-[12.5px] font-bold text-fv-muted">Step {activeStep} of 5</span>
                    <h3 className="fv-display text-[clamp(17px,2.4vh,21px)] font-bold tracking-[-0.02em] text-fv-ink">
                      {bioStep === 'iris' ? 'Their iris' : 'Their fingerprint'}
                      <span className="fv-hi ml-2 text-[13.5px] font-bold text-fv-faint">
                        {bioStep === 'iris' ? 'पुतली' : 'अंगुली'}
                      </span>
                    </h3>
                    <p className="mt-0.5 text-[12.5px] font-bold text-fv-muted">
                      {bioStep === 'fp'
                        ? 'Put their finger on the reader and hold it there.'
                        : 'Bring their eye up to the tower and hold still.'}
                    </p>
                  </div>
                </div>

                {/* Dual Biometric Sensor Bays. Collapses to a single
                    column when only one modality is enrolled for this
                    candidate so the visible bay uses the full stage
                    width instead of leaving an empty column of grey. */}
                {bioStep === 'iris' && hasEnrolledFingerprint && (
                  <button type="button" onClick={() => setBioStep('fp')}
                          className="-mt-1 mr-auto flex items-center gap-1.5 rounded-[10px] px-2 py-1 text-[13px] font-bold text-fv-muted transition hover:bg-fv-card-focus hover:text-fv-accent-deep">
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M15 5l-7 7 7 7" />
                    </svg>
                    Back to the fingerprint
                    <span className="fv-hi text-[12px] font-bold text-fv-faint">अंगुली पर लौटें</span>
                  </button>
                )}

                <div className="flex h-0 min-h-0 flex-1 items-stretch gap-4 py-1">

                  {/* The fingerprint bay. The scene answers the scan:
                      the hand comes down, the ridges read across the
                      platen, the ring closes, and a badge lands. */}
                  {hasEnrolledFingerprint && bioStep === 'fp' && (
                  <div className="flex min-h-0 flex-1 flex-col gap-2 rounded-[14px] border border-fv-line bg-fv-page p-3">
                    <div className="flex items-center justify-between gap-3">
                      <h4 className="fv-display text-[19px] font-bold tracking-[-0.015em] text-fv-ink">
                        Fingerprint
                        <span className="fv-hi ml-2 text-[13px] font-bold text-fv-faint">अंगुली</span>
                      </h4>
                      <BayWord status={fpStatus} />
                    </div>

                    <button
                      type="button"
                      onClick={handleCaptureFingerprint}
                      disabled={fpStatus === 'pass' || fpStatus === 'scanning'}
                      className="fv-lift flex h-[clamp(140px,21vh,300px)] w-full items-stretch gap-3 rounded-[12px] border border-fv-line bg-white p-2 disabled:cursor-default"
                    >
                      <FingerScene status={fpStatus} className="h-full min-h-0 w-0 flex-[3]" />
                      <PrintPlate
                        src={fpResult?.print}
                        status={fpStatus}
                        kind="finger"
                        seed={candidate?.roll_no || ''}
                        className="h-full min-h-0 w-0 flex-[2]"
                      />
                    </button>

                    {fpResult?.error && (
                      <p className="rounded-[10px] border border-[#EDD9B8] bg-[#F6EDDD] px-3 py-2 text-[12.5px] font-bold leading-relaxed text-[#A8711F]">
                        {fpResult.error}
                      </p>
                    )}

                    <button
                      type="button"
                      onClick={handleCaptureFingerprint}
                      disabled={fpStatus === 'pass' || fpStatus === 'scanning'}
                      className={`mt-auto flex w-full items-center justify-center gap-2 rounded-[10px] px-3 py-2 text-[14px] font-bold text-white transition ${
                        fpStatus === 'scanning'
                          ? 'cursor-not-allowed bg-fv-accent-soft'
                          : 'cursor-pointer bg-fv-accent hover:bg-fv-accent-deep disabled:opacity-50'
                      }`}
                    >
                      <span>{fpStatus === 'scanning' ? 'Reading…' : fpStatus === 'pass' ? 'Done' : 'Scan the finger'}</span>
                    </button>
                  </div>
                  )}

                  {/* The iris bay. Same language: the eye comes to the
                      frame, a bar sweeps it, the ring closes. */}
                  {hasEnrolledIris && bioStep === 'iris' && (
                  <div className="flex min-h-0 flex-1 flex-col gap-2 rounded-[14px] border border-fv-line bg-fv-page p-3">
                    <div className="flex items-center justify-between gap-3">
                      <h4 className="fv-display text-[19px] font-bold tracking-[-0.015em] text-fv-ink">
                        Iris
                        <span className="fv-hi ml-2 text-[13px] font-bold text-fv-faint">पुतली</span>
                      </h4>
                      <BayWord status={irisStatus} />
                    </div>

                    <button
                      type="button"
                      onClick={handleCaptureIris}
                      disabled={irisStatus === 'pass' || irisStatus === 'scanning'}
                      className="fv-lift flex h-[clamp(140px,21vh,300px)] w-full items-stretch gap-3 rounded-[12px] border border-fv-line bg-white p-2 disabled:cursor-default"
                    >
                      <IrisScene status={irisStatus} className="h-full min-h-0 w-0 flex-[3]" />
                      <PrintPlate
                        src={irisResult?.eye}
                        status={irisStatus}
                        kind="iris"
                        seed={candidate?.roll_no || ''}
                        className="h-full min-h-0 w-0 flex-[2]"
                      />
                    </button>

                    {irisResult?.error && (
                      <p className="rounded-[10px] border border-[#EDD9B8] bg-[#F6EDDD] px-3 py-2 text-[12.5px] font-bold leading-relaxed text-[#A8711F]">
                        {irisResult.error}
                      </p>
                    )}

                    <button
                      type="button"
                      onClick={handleCaptureIris}
                      disabled={irisStatus === 'pass' || irisStatus === 'scanning'}
                      className={`mt-auto flex w-full items-center justify-center gap-2 rounded-[10px] px-3 py-2 text-[14px] font-bold text-white transition ${
                        irisStatus === 'scanning'
                          ? 'cursor-not-allowed bg-fv-accent-soft'
                          : 'cursor-pointer bg-fv-accent hover:bg-fv-accent-deep disabled:opacity-50'
                      }`}
                    >
                      <span>{irisStatus === 'scanning' ? 'Reading…' : irisStatus === 'pass' ? 'Done' : 'Scan the eye'}</span>
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
                <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-3 border-t border-[#EFEDF4] text-xs">
                  <div className="flex items-center gap-2.5">
                    <StepState state={isBiometricComplete() ? 'pass' : anyEnrolledFailed() ? 'fail' : 'wait'} />
                    <span className={`text-[14px] font-bold ${anyEnrolledFailed() ? 'text-[#A8711F]' : 'text-fv-ink'}`}>
                      {isBiometricComplete() ? 'Both checks matched'
                        : anyEnrolledFailed() ? 'A check did not match'
                        : fpStatus === 'pass' && hasEnrolledIris && irisStatus !== 'pass' ? 'Now the iris'
                        : irisStatus === 'pass' && hasEnrolledFingerprint && fpStatus !== 'pass' ? 'Now the fingerprint'
                        : 'Waiting for the scanners'}
                      <span className="fv-hi ml-2 text-[12.5px] font-bold text-fv-faint">
                        {isBiometricComplete() ? 'दोनों मिले'
                          : anyEnrolledFailed() ? 'मेल नहीं'
                          : fpStatus === 'pass' && hasEnrolledIris && irisStatus !== 'pass' ? 'अब पुतली'
                          : irisStatus === 'pass' && hasEnrolledFingerprint && fpStatus !== 'pass' ? 'अब अंगुली'
                          : 'प्रतीक्षा'}
                      </span>
                    </span>
                  </div>

                  {isBiometricComplete() && (
                    <button
                      type="button"
                      onClick={() => submitFinalVerification()}
                      disabled={submitting}
                      className="w-full sm:w-auto px-5 py-2.5 rounded-lg bg-[#5B3FA6] hover:bg-[#43307D] text-white font-bold text-[14px] transition shadow-md flex items-center justify-center gap-2 cursor-pointer animate-surface-in"
                    >
                      <span>{submitting ? 'Finishing…' : 'Finish the check'}</span>
                    </button>
                  )}

                  {!isBiometricComplete() && anyEnrolledFailed() && (
                    <div className="flex flex-col sm:flex-row items-center gap-2 w-full sm:w-auto animate-surface-in">
                      <button
                        type="button"
                        onClick={retakeFailedBiometrics}
                        disabled={submitting}
                        className="w-full sm:w-auto px-5 py-2.5 rounded-lg bg-white border border-[#E3E1EA] text-[#211E33] hover:bg-slate-50 font-bold text-[14px] transition shadow-xs"
                      >
                        Retake
                      </button>
                      <button
                        type="button"
                        onClick={() => submitFinalVerification('denied')}
                        disabled={submitting}
                        className="w-full sm:w-auto px-5 py-2.5 rounded-lg bg-[#A8711F] hover:bg-[#A8711F] text-white font-bold text-[14px] transition shadow-md"
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
              <div className={`animate-surface-in relative -m-4 flex h-full flex-1 flex-col justify-between overflow-hidden rounded-xl border-2 p-4 shadow-md sm:p-5 ${
                result === 'denied' ? 'border-[#A8711F]' : 'border-fv-accent'
              }`} style={{ background: 'linear-gradient(180deg, #FEFDFB 0%, #FBF9FF 52%, #F7F4FE 100%)' }}>
                
                <RecordWeave />
                <RecordFrame />

                {/* Top Header & Official Sovereign Masthead */}
                <div className="relative z-1 flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[#E3E1EA] pb-3 bg-gradient-to-b from-[#F5F4F8] to-white -mx-4 -mt-4 sm:-mx-5 sm:-mt-5 p-3 sm:p-4 rounded-t-xl">
                  
                  {/* Sovereign Marks: Ashoka Lion Capital + NTA Official Mark */}
                  <div className="flex flex-wrap items-center gap-4 sm:gap-6">
                    
                    {/* Left: Ashoka Lion Capital */}
                    <div className="flex items-center gap-2 shrink-0">
                      <img
                        src={emblemSvg}
                        alt="State Emblem of India - Satyameva Jayate"
                        className="h-[min(62px,6.2vh)] w-auto object-contain drop-shadow-xs"
                      />
                    </div>

                    {/* Divider */}
                    <div className="hidden sm:block h-12 w-[1px] bg-slate-300" />

                    {/* Right: NTA Logo + Central Candidate Biometric Verification System */}
                    <div className="flex flex-col justify-center">
                      <img
                        src={ntaLogo}
                        alt="National Testing Agency - Excellence in Assessment"
                        className="h-[min(34px,3.5vh)] w-auto self-start object-contain mix-blend-multiply"
                      />
                      <div className="mt-1 text-[12.5px] font-bold tracking-tight text-fv-muted">
                        Central Candidate Biometric Verification System
                        <span className="fv-hi ml-2 font-bold text-fv-faint">केंद्रीय अभ्यर्थी बायोमेट्रिक सत्यापन प्रणाली</span>
                      </div>
                    </div>
                  </div>

                  {/* 3D Embossed Seal — reflects the actual verdict.
                      Verified → green seal; denied → rose seal with
                      "DENIED" text. No hardcoded "VERIFIED PASS". */}
                  <div className="relative -mr-2 -mt-3 flex shrink-0 items-center justify-center self-center sm:-mr-4 sm:-mt-6 sm:self-auto">
                    <span className="fv-stamp-in block rotate-[-7deg]">
                      <DecisionStamp
                        status={result === 'denied' ? 'rejected' : 'approved'}
                        label={result === 'denied' ? 'DENIED' : 'VERIFIED'}
                        className="h-[70px] w-[186px]"
                      />
                    </span>
                  </div>
                </div>

                {/* Certificate Title & Exam Metadata Sub-Header.
                    The "Official Verification Certificate & Admit
                    Clearance" eyebrow and the "SESSION: FORENOON"
                    hardcoded shift text were removed on operator
                    request — neither reflects real data. */}
                <div className="relative z-1 flex flex-col gap-3 border-b border-dashed border-fv-line pb-2.5 pt-2.5 sm:flex-row sm:items-end sm:justify-between">
                  <div className="min-w-0">
                    <span className="block text-[13px] font-bold tracking-tight text-fv-faint">
                      Verification record <span className="fv-hi font-bold">सत्यापन रिकॉर्ड</span>
                    </span>
                    <span className="fv-display block truncate text-[clamp(20px,2.6vh,27px)] font-bold leading-[1.15] tracking-[-0.02em] text-fv-ink">
                      {candidate?.name || 'This candidate'}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-end gap-4 sm:gap-6">
                    <RecordField label="Roll" hi="अनुक्रमांक">
                      <span className="tabular-nums text-fv-accent-deep">{candidate?.roll_no || roll}</span>
                    </RecordField>
                    <RecordField label="Exam" hi="परीक्षा">
                      {candidate?.exam_name || wallet?.assigned_exam_name || '—'}
                    </RecordField>
                    <RecordField label="Centre" hi="केंद्र">
                      <span className="inline-flex items-center gap-1">
                        <PinGlyph className="h-3.5 w-3.5 shrink-0" />
                        {candidate?.center_name || '—'}
                      </span>
                    </RecordField>
                  </div>
                </div>

                {/* Side by Side Photos & Audit Grid */}
                <div className="relative z-1 flex min-h-0 flex-1 flex-col py-2">
                <div className="grid h-full min-h-0 grid-cols-1 items-stretch gap-5 sm:grid-cols-12">
                  {/* The two faces, and the mark where they met */}
                  <div className="relative mx-auto flex h-full max-h-[min(252px,23vh)] max-w-full items-stretch gap-3 self-center sm:col-span-5">
                    <Portrait src={photoBlob} label="On file" hi="दर्ज" />
                    <Portrait src={snap} label="Captured now" hi="अभी लिया" accent />
                    {faceResult?.ok === true && (
                      <span className="pointer-events-none absolute bottom-2 left-1/2 z-10 grid h-7 w-7 -translate-x-1/2 place-items-center rounded-full bg-fv-accent shadow-[0_2px_8px_rgba(67,48,125,.4)] ring-[3px] ring-white">
                        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="#fff" strokeWidth="3.6"
                             strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M5 13l4.5 4.5L19 7" />
                        </svg>
                      </span>
                    )}
                  </div>

                  {/* Audit & Verification Clearance Fields */}
                  <div className="flex min-h-0 flex-col justify-between gap-2.5 sm:col-span-7">
                    {/* Real per-modality rows. Only render the rows for
                        modalities that were actually enrolled + captured
                        for this candidate — otherwise the receipt reads
                        like an over-promise. Each row's tint reflects
                        the real match verdict, not a hardcoded pass. */}
                    {hasEnrolledFace && (
                      <RecordCheck
                        art={FaceStep} title="Face" hi="चेहरा"
                        matched={faceResult?.ok === true}
                        skipped={!!faceResult?.notRequired}
                        error={!!faceResult?.error || faceResult?.ok === false}
                        shot={snap}
                      />
                    )}
                    {hasEnrolledFingerprint && (
                      <RecordCheck
                        art={FingerArt} title="Fingerprint" hi="अंगुली"
                        matched={fpStatus === 'pass'}
                        skipped={fpStatus === 'idle' && !fpResult}
                        error={fpStatus === 'fail'}
                        plate={{ src: fpResult?.print, kind: 'finger' }}
                        seed={candidate?.roll_no || ''}
                      />
                    )}
                    {hasEnrolledIris && (
                      <RecordCheck
                        art={IrisArt} title="Iris" hi="पुतली"
                        matched={irisStatus === 'pass'}
                        skipped={irisStatus === 'idle' && !irisResult}
                        error={irisStatus === 'fail'}
                        plate={{ src: irisResult?.eye, kind: 'iris' }}
                        seed={candidate?.roll_no || ''}
                      />
                    )}
                  </div>
                </div>

                {/* What makes it a record: the block that carries the
                    number, and the line the centre signs. */}
                </div>

                <div className="relative z-1 mt-1 flex items-end justify-between gap-6 border-t border-dashed border-fv-line pt-2">
                  <div className="flex items-center gap-3">
                    <SecurityMatrix seed={`${candidate?.roll_no || roll}-${verificationStartedAt || ''}`} className="h-[clamp(42px,5.4vh,64px)] w-[clamp(42px,5.4vh,64px)]" />
                    <span className="leading-tight">
                      <span className="block text-[12.5px] font-bold text-fv-faint">
                        Record mark <span className="fv-hi font-bold">रिकॉर्ड चिह्न</span>
                      </span>
                      <span className="block text-[13.5px] font-bold tabular-nums text-fv-ink">
                        {candidate?.roll_no || roll} · {new Date().toLocaleDateString('en-IN')}
                      </span>
                    </span>
                  </div>

                  <SignBlock name={candidate?.center_name || ''} />
                </div>

                {/* Action Bar */}
                <div className="relative z-1 -mx-4 -mb-4 flex flex-wrap items-center justify-between gap-3 rounded-b-xl border-t border-fv-line bg-fv-page p-2.5 text-xs sm:-mx-5 sm:-mb-5 sm:p-3">
                  <div className="flex items-center gap-1.5">
                    <span className="flex items-center gap-2 text-[13.5px] font-bold text-fv-muted">
                      <SealedGlyph className="h-5 w-5" />
                      Sealed and saved
                      <span className="fv-hi text-[12.5px] font-bold text-fv-faint">दर्ज हो गया</span>
                    </span>
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
                          className="px-4 py-2 rounded-lg bg-[#5B3FA6] hover:bg-[#43307D] text-white font-semibold transition shadow-xs flex items-center justify-center gap-1.5 cursor-pointer text-xs"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                          </svg>
                          <span>Print receipt</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => downloadVerificationPDF(verificationId)}
                          className="px-3.5 py-2.5 rounded-lg border border-[#E3E1EA] bg-white hover:bg-slate-50 text-[#211E33] font-semibold transition shadow-2xs cursor-pointer text-xs"
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
                      className="px-4 py-2.5 rounded-lg bg-[#5B3FA6] hover:bg-[#43307D] text-white font-semibold transition shadow-xs cursor-pointer text-xs"
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
    </>
  )
}

// The candidate's admit card: what the agent is holding when they type.
// Step 1 — the admit card the roll number comes off.
function RollCardArt({ className }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <rect x="4" y="11" width="56" height="42" rx="7" fill="#FFFFFF" stroke="#43307D" strokeWidth="3.4" />
      <path d="M4 18a7 7 0 0 1 7-7h42a7 7 0 0 1 7 7v2H4z" fill="#F28C28" />
      <rect x="4" y="20" width="56" height="3.4" fill="#138808" />
      <rect x="11" y="29" width="17" height="19" rx="3" fill="#EFEBF9" stroke="#5B3FA6" strokeWidth="2.2" />
      <circle cx="19.5" cy="35.5" r="4.2" fill="#5B3FA6" />
      <path d="M12.6 47c1-4 3.6-6 6.9-6s5.9 2 6.9 6z" fill="#5B3FA6" />
      <rect x="34" y="30" width="20" height="4.2" rx="2.1" fill="#43307D" />
      <rect x="34" y="38" width="14" height="4.2" rx="2.1" fill="#9A86D6" />
      <rect x="34" y="44.6" width="20" height="3.4" rx="1.7" fill="#DDD5F2" />
    </svg>
  )
}

function RollKeypad({ value = '', onChange, onEnter, disabled }) {
  const press = (k) => {
    if (disabled) return
    if (k === 'del') return onChange(value.slice(0, -1))
    if (k === 'clr') return onChange('')
    if (value.length >= 12) return
    onChange(value + k)
  }
  const Key = ({ k, children, wide, tone = 'plain' }) => (
    <button type="button" disabled={disabled} onClick={() => press(k)}
            aria-label={k === 'del' ? 'Backspace' : k === 'clr' ? 'Clear' : `Digit ${k}`}
            className={`fv-key flex h-[min(48px,5.4vh)] items-center justify-center rounded-[10px] border text-[clamp(16px,2.4vh,19px)] font-bold tabular-nums transition-colors disabled:opacity-40
              ${wide ? 'col-span-1' : ''}
              ${tone === 'warm' ? 'border-fv-line bg-fv-page text-fv-accent-deep hover:bg-fv-card-focus'
                : 'border-fv-line bg-fv-card text-fv-ink hover:bg-fv-card-focus'}`}>
      {children ?? k}
    </button>
  )
  return (
    <div className="grid grid-cols-3 gap-2" role="group" aria-label="Roll number keypad">
      {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => <Key key={k} k={k} />)}
      <Key k="clr" tone="warm">
        <span className="text-[14px]">Clear</span>
      </Key>
      <Key k="0" />
      <Key k="del" tone="warm">
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 6H9l-5 6 5 6h11a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1zM17 9.5l-5 5M12 9.5l5 5" />
        </svg>
      </Key>
    </div>
  )
}

// The three checks, drawn.
// Step 2 — the live face, inside the capture frame.
function FaceStep({ className }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <circle cx="32" cy="30" r="13.5" fill="#F3EAD9" />
      <path d="M18.5 30c0-8.4 6-13.5 13.5-13.5S45.5 21.6 45.5 30c-2.2-4.4-5.4-6.9-9.6-7.6-2.8 2.6-8.8 4.4-17.4 7.6z" fill="#211E33" />
      <circle cx="27.4" cy="31.6" r="2.1" fill="#211E33" />
      <circle cx="36.6" cy="31.6" r="2.1" fill="#211E33" />
      <path d="M28.6 38.4a6 5 0 0 0 6.8 0" fill="none" stroke="#211E33" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M17 53c2.6-6.6 8.2-10 15-10s12.4 3.4 15 10z" fill="#5B3FA6" />
      <g fill="none" stroke="#5B3FA6" strokeWidth="4.6" strokeLinecap="round">
        <path d="M6 20V9h11M58 20V9H47M6 46v11h11M58 46v11H47" />
      </g>
    </svg>
  )
}

const PIPE = [
  { title: 'Roll number', hi: 'अनुक्रमांक', art: RollCardArt },
  { title: 'Face', hi: 'चेहरा', art: FaceStep },
  { title: 'Fingerprint', hi: 'अंगुली', art: FingerArt },
  { title: 'Iris', hi: 'पुतली', art: IrisArt },
  { title: 'Decision', hi: 'निर्णय', art: SealStep },
]

// A fingerprint and an iris, on one plate.
// Step 3 — the fingerprint, with the iris beside it.
function BioStep({ className }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <g fill="none" stroke="#5B3FA6" strokeWidth="3.6" strokeLinecap="round">
        <path d="M5 38c0-12.2 8.1-21 19-21s19 8.8 19 21v3" stroke="#43307D" />
        <path d="M10.5 39.5c0-9.4 6-16.4 13.5-16.4S37.5 30.1 37.5 39.5v5" />
        <path d="M16 41c0-6.2 3.6-11 8-11s8 4.8 8 11v9" stroke="#43307D" />
        <path d="M21.4 42.6c0-3 1.2-5.4 2.6-5.4s2.6 2.4 2.6 5.4v11" />
        <path d="M6.4 47c.8 4 1.9 7.1 3.5 9.7M41.6 46c-.5 3.6-1.4 6.7-2.8 9.5" strokeWidth="3" />
      </g>
      <circle cx="47" cy="45" r="16" fill="#FFFFFF" />
      <path d="M33 45s6-9 14-9 14 9 14 9-6 9-14 9-14-9-14-9z" fill="#EFEBF9" stroke="#43307D" strokeWidth="3" strokeLinejoin="round" />
      <circle cx="47" cy="45" r="6.4" fill="#9A86D6" />
      <circle cx="47" cy="45" r="2.8" fill="#211E33" />
      <circle cx="49" cy="43" r="1.2" fill="#FFFFFF" />
    </svg>
  )
}

function SealStep({ className }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <path d="M22 44h20l4 18-14-6-14 6z" fill="#9A86D6" />
      <circle cx="32" cy="28" r="23" fill="#5B3FA6" />
      <circle cx="32" cy="28" r="18" fill="#FFFFFF" />
      <circle cx="32" cy="28" r="14.4" fill="#5B3FA6" />
      {Array.from({ length: 24 }).map((_, i) => {
        const a = (i / 24) * Math.PI * 2
        return (
          <line key={i} x1={32 + Math.cos(a) * 18.6} y1={28 + Math.sin(a) * 18.6}
                x2={32 + Math.cos(a) * 21.4} y2={28 + Math.sin(a) * 21.4}
                stroke="#EFEBF9" strokeWidth="1.8" strokeLinecap="round" />
        )
      })}
      <path d="M24.6 28.4l5.6 5.8L40 21.6" fill="none" stroke="#FFFFFF" strokeWidth="5"
            strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function StepState({ state }) {
  const tone = state === 'fail' ? '#A8711F' : state === 'wait' ? '#C3B6E8' : '#5B3FA6'
  return (
    <svg viewBox="0 0 20 20" className="h-[18px] w-[18px] shrink-0" aria-hidden="true">
      <rect x="1" y="1" width="18" height="18" rx="6" fill={state === 'wait' ? '#FFFFFF' : tone} stroke={tone} strokeWidth="1.6" />
      {state === 'fail' ? (
        <path d="M7 7l6 6M13 7l-6 6" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" />
      ) : state === 'wait' ? (
        <circle cx="10" cy="10" r="2.6" fill={tone} />
      ) : (
        <path d="M6 10.4l2.6 2.6L14.4 7" fill="none" stroke="#FFFFFF" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  )
}

function BayWord({ status }) {
  const map = {
    pass: ['Matched', 'मिला', 'border-fv-accent-soft bg-fv-card-focus text-fv-accent-deep'],
    fail: ['Not matched', 'मेल नहीं', 'border-[#EDD9B8] bg-[#F6EDDD] text-[#A8711F]'],
    scanning: ['Reading…', 'पढ़ रहे हैं', 'border-fv-accent-soft bg-fv-card-focus text-fv-accent-deep'],
  }
  const [word, hi, tone] = map[status] || ['Not scanned', 'बाकी', 'border-fv-line bg-white text-fv-muted']
  return (
    <span className={`shrink-0 rounded-[9px] border px-2.5 py-1 text-[12.5px] font-bold ${tone}`}>
      {word}
      <span className="fv-hi ml-1.5 text-[11.5px] font-bold opacity-75">{hi}</span>
    </span>
  )
}

// The checks, drawn down a rail that fills as each one lands. Violet is
// done, amber is not, and anything still waiting sits quiet.
function CheckRail({ rows }) {
  const live = rows.filter((r) => r.show !== false)
  const doneTo = live.reduce((n, r, i) => (r.state === 'pass' || r.state === 'fail' ? i : n), -1)
  return (
    <ol className="fv-stagger relative mt-0.5 flex min-h-0 flex-1 flex-col justify-between">
      {/* the rail itself */}
      <span aria-hidden="true" className="absolute left-[23px] top-6 bottom-6 w-[3px] rounded-full bg-fv-line" />
      <span aria-hidden="true"
            className="absolute left-[23px] top-6 w-[3px] rounded-full bg-fv-accent transition-all duration-700"
            style={{ height: doneTo < 0 ? 0 : `calc(${(doneTo / Math.max(1, live.length - 1)) * 100}% - 12px)` }} />
      {live.map((r) => {
        const Art = r.art
        const done = r.state === 'pass'
        const bad = r.state === 'fail'
        const busy = r.state === 'busy'
        const ready = r.state === 'ready'
        return (
          <li key={r.key} className="relative flex items-center gap-3 py-[3px] lg:py-1.5">
            <span className={`relative grid h-[min(40px,3.8vh)] w-[min(40px,3.8vh)] shrink-0 place-items-center rounded-[13px] border-2 bg-white transition-colors duration-300 ${
              done ? 'border-fv-accent bg-fv-card-focus'
                : bad ? 'border-[#EDD9B8] bg-[#F6EDDD]'
                : busy || ready ? 'border-fv-accent' : 'border-fv-line'}`}>
              <Art className={`h-[70%] w-[70%] transition-opacity duration-300 ${done || bad || busy || ready ? 'opacity-100' : 'opacity-45'}`} />
              {(busy || ready) && (
                <span aria-hidden="true" className="fv-breathe absolute -inset-1 rounded-[18px] border-2 border-fv-accent/40" />
              )}
              {done && (
                <span aria-hidden="true" className="absolute -right-1 -top-1 grid h-5 w-5 place-items-center rounded-full bg-fv-accent ring-2 ring-white">
                  <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="#FFFFFF" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12.5l4.5 4.5L19 7" />
                  </svg>
                </span>
              )}
              {bad && (
                <span aria-hidden="true" className="absolute -right-1 -top-1 grid h-5 w-5 place-items-center rounded-full bg-[#A8711F] ring-2 ring-white">
                  <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="#FFFFFF" strokeWidth="4" strokeLinecap="round">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </span>
              )}
            </span>

            <span className="min-w-0 leading-tight">
              <span className={`block text-[15px] font-bold leading-[1.15] tracking-[-0.01em] ${done || bad || busy || ready ? 'text-fv-ink' : 'text-fv-muted'}`}>
                {r.title}
              </span>
              <span className="fv-hi block text-[12.5px] font-bold leading-[1.2] text-fv-faint">{r.hi}</span>
            </span>

            <span className={`ml-auto shrink-0 text-right leading-tight ${
              bad ? 'text-[#A8711F]' : done || busy || ready ? 'text-fv-accent-deep' : 'text-fv-faint'}`}>
              <span className="block text-[14px] font-bold">
                {done ? r.ok : bad ? r.bad : busy ? 'Reading…' : ready ? 'Ready' : 'Waiting'}
              </span>
              <span className="fv-hi block text-[12px] font-bold opacity-80">
                {done ? r.hiOk : bad ? r.hiBad : busy ? 'पढ़ रहे हैं' : ready ? 'तैयार' : 'प्रतीक्षा'}
              </span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}

// A live face: the eye, with the pulse that proves it is a person.
function LivenessArt({ className }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <path d="M4 32s10-15 22-15 22 15 22 15-10 15-22 15S4 32 4 32z" fill="#FFFFFF" stroke="#43307D" strokeWidth="3.4" strokeLinejoin="round" />
      <circle cx="26" cy="32" r="9" fill="#5B3FA6" />
      <circle cx="26" cy="32" r="4" fill="#211E33" />
      <circle cx="28.4" cy="29.4" r="1.8" fill="#FFFFFF" />
      <path d="M44 44h5l3-9 4 18 3.5-9H62" fill="none" stroke="#F28C28" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// A fingerprint, on its own.
function FingerArt({ className }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <g fill="none" stroke="#5B3FA6" strokeWidth="4" strokeLinecap="round">
        <path d="M8 36c0-13 9-23 24-23s24 10 24 23v3" stroke="#43307D" />
        <path d="M15 38c0-10 7-18 17-18s17 8 17 18v6" />
        <path d="M22 40c0-6.6 4.4-12 10-12s10 5.4 10 12v10" stroke="#43307D" />
        <path d="M29 42c0-3.2 1.4-5.8 3-5.8s3 2.6 3 5.8v12" />
        <path d="M10 46c.9 4.4 2.1 7.8 3.8 10.6M54 45c-.6 4-1.6 7.3-3 10.3" strokeWidth="3.2" />
      </g>
    </svg>
  )
}

// An iris, on its own.
function IrisArt({ className }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <path d="M4 32s11-16 28-16 28 16 28 16-11 16-28 16S4 32 4 32z" fill="#EFEBF9" stroke="#43307D" strokeWidth="3.4" strokeLinejoin="round" />
      <circle cx="32" cy="32" r="13" fill="#9A86D6" />
      <g stroke="#5B3FA6" strokeWidth="1.8">
        {Array.from({ length: 14 }).map((_, i) => {
          const a = (i / 14) * Math.PI * 2
          return <line key={i} x1={32 + Math.cos(a) * 5.5} y1={32 + Math.sin(a) * 5.5} x2={32 + Math.cos(a) * 12.4} y2={32 + Math.sin(a) * 12.4} />
        })}
      </g>
      <circle cx="32" cy="32" r="5.4" fill="#211E33" />
      <circle cx="34.4" cy="29.4" r="2" fill="#FFFFFF" />
    </svg>
  )
}

// The camera, warming up.
function CameraWaitArt({ className }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <rect x="6" y="20" width="40" height="28" rx="8" fill="#5B3FA6" />
      <path d="M46 30l12-7v20l-12-7z" fill="#43307D" />
      <circle cx="24" cy="34" r="9" fill="#EFEBF9" />
      <circle cx="24" cy="34" r="4.4" fill="#211E33" />
      <circle cx="26" cy="32" r="1.6" fill="#FFFFFF" />
      <circle cx="39" cy="27" r="2.6" fill="#F28C28" />
      <g fill="none" stroke="#9A86D6" strokeWidth="2.6" strokeLinecap="round">
        <path d="M10 14c2-3 5-5 8-6M54 50c-2 3-5 5-8 6" />
      </g>
    </svg>
  )
}

function BioTabs({ step, onStep, fp, iris }) {
  const tab = (key, title, hi, status) => {
    const here = step === key
    const done = status === 'pass'
    const bad = status === 'fail'
    return (
      <button key={key} type="button" onClick={() => onStep(key)}
              className={`flex flex-1 items-center gap-2.5 rounded-[12px] border-2 px-3.5 py-1.5 text-left transition ${
                here ? 'border-fv-accent bg-fv-card-focus'
                  : done ? 'border-fv-accent-soft bg-white'
                  : bad ? 'border-[#EDD9B8] bg-[#F6EDDD]' : 'border-fv-line bg-white'}`}>
        <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[13px] font-bold ${
          done ? 'bg-fv-accent text-white' : bad ? 'bg-[#A8711F] text-white' : here ? 'bg-fv-accent text-white' : 'bg-fv-line text-fv-muted'}`}>
          {done ? (
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12.5l4.5 4.5L19 7" />
            </svg>
          ) : key === 'fp' ? '1' : '2'}
        </span>
        <span className="leading-tight">
          <span className={`block text-[14.5px] font-bold ${here || done ? 'text-fv-ink' : 'text-fv-muted'}`}>{title}</span>
          <span className="fv-hi block text-[12px] font-bold text-fv-faint">{hi}</span>
        </span>
      </button>
    )
  }
  return (
    <div className="flex items-stretch gap-3">
      {tab('fp', 'Fingerprint', 'अंगुली', fp)}
      {tab('iris', 'Iris', 'पुतली', iris)}
    </div>
  )
}

// One check on the record: what it was, how it went, and the capture it
// was decided on.
function RecordCheck({ art: Art, title, hi, matched, skipped, error, plate, shot, seed = '' }) {
  const edge = matched ? 'bg-fv-accent' : error ? 'bg-[#A8711F]' : 'bg-fv-line'
  const pill = matched ? 'bg-fv-card-focus text-fv-accent-deep ring-fv-accent-soft'
    : error ? 'bg-[#F6EDDD] text-[#8A5A14] ring-[#EDD9B8]'
      : 'bg-fv-page text-fv-faint ring-fv-line'
  const word = matched ? ['Matched', 'मिला'] : error ? ['Not matched', 'मेल नहीं'] : skipped ? ['Not taken', 'नहीं लिया'] : ['Pending', 'बाकी']
  return (
    <div className="relative flex max-h-[92px] min-h-[58px] flex-1 items-center gap-3 overflow-hidden rounded-[14px] border border-fv-line bg-white px-3 py-2 shadow-[0_1px_2px_rgba(33,30,51,.045)]">
      <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-[4px] ${edge}`} />
      <span className="ml-1 grid h-[min(48px,5.4vh)] w-[min(48px,5.4vh)] shrink-0 place-items-center rounded-[13px] bg-fv-page">
        <Art className="h-[78%] w-[78%]" />
      </span>
      <span className="min-w-0 leading-tight">
        <span className="block text-[15px] font-bold text-fv-ink">{title}</span>
        <span className="fv-hi block text-[12.5px] font-bold text-fv-faint">{hi}</span>
      </span>

      <span className="ml-auto flex shrink-0 items-center gap-3">
        {/* what the scanner actually took */}
        {plate ? (
          <PrintPlate src={plate.src} status={matched ? 'pass' : error ? 'fail' : 'idle'}
                      kind={plate.kind} seed={seed}
                      className="h-[min(48px,5.4vh)] w-[min(39px,4.4vh)] shrink-0 ring-1 ring-fv-accent-soft" />
        ) : shot ? (
          <img src={shot} alt="" aria-hidden="true"
               className="h-[min(48px,5.4vh)] w-[min(39px,4.4vh)] shrink-0 rounded-[14px] object-cover ring-1 ring-fv-accent-soft" />
        ) : null}

        <span className={`inline-flex items-baseline gap-1.5 rounded-full px-2.5 py-1 ring-1 ${pill}`}>
          <span className="text-[13.5px] font-bold">{word[0]}</span>
          <span className="fv-hi text-[12px] font-bold opacity-75">{word[1]}</span>
        </span>
      </span>
    </div>
  )
}

// One passport frame: the photograph, and the word for what it is.
function Portrait({ src, label, hi, accent }) {
  return (
    <div className={`relative aspect-[7/9] h-full w-auto shrink overflow-hidden rounded-[13px] bg-fv-page shadow-[0_2px_10px_rgba(33,30,51,.08)] ${
      accent ? 'ring-2 ring-fv-accent' : 'ring-1 ring-fv-line'
    }`}>
      {src ? (
        <img src={src} alt="" aria-hidden="true" className="h-full w-full object-cover" />
      ) : (
        <span className="grid h-full w-full place-items-center bg-fv-card-focus">
          <svg viewBox="0 0 24 24" className="h-8 w-8 text-fv-accent opacity-50" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
          </svg>
        </span>
      )}
      <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-fv-ink/85 to-fv-ink/0 px-2 pb-1.5 pt-6 text-center leading-tight">
        <span className="block text-[11.5px] font-bold text-white">{label}</span>
        <span className="fv-hi block text-[11px] font-bold text-white/75">{hi}</span>
      </span>
    </div>
  )
}

// A fact on the record: what it is, then what it says.
function RecordField({ label, hi, children }) {
  return (
    <span className="block max-w-[190px] leading-tight">
      <span className="block text-[12px] font-bold text-fv-faint">
        {label} <span className="fv-hi font-bold">{hi}</span>
      </span>
      <span className="block truncate text-[14.5px] font-bold text-fv-ink">{children}</span>
    </span>
  )
}

// The weave a printed record carries, drawn rather than scanned.
function RecordWeave() {
  return (
    <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.03]"
         viewBox="0 0 800 500" preserveAspectRatio="xMidYMid slice">
      <defs>
        <pattern id="fvWeave" width="34" height="34" patternUnits="userSpaceOnUse">
          <path d="M0 17q8.5-12 17 0t17 0M17 0q-12 8.5 0 17t0 17" fill="none" stroke="#43307D" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width="800" height="500" fill="url(#fvWeave)" />
      <g fill="none" stroke="#43307D" strokeWidth="1.2">
        {Array.from({ length: 5 }).map((_, i) => (
          <circle key={i} cx="400" cy="250" r={70 + i * 34} />
        ))}
      </g>
    </svg>
  )
}

// A seal pressed into the page.
function SealedGlyph({ className }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M8 16h8l2 7-6-2.6L6 23z" fill="#9A86D6" />
      <circle cx="12" cy="10" r="8" fill="#5B3FA6" />
      <circle cx="12" cy="10" r="5.6" fill="#EFEBF9" />
      <path d="M9.4 10.2l1.8 1.8 3.6-4" fill="none" stroke="#5B3FA6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// Where the check happened.
function PinGlyph({ className }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M12 2c4 0 7 3 7 7 0 5.2-7 13-7 13S5 14.2 5 9c0-4 3-7 7-7z" fill="#5B3FA6" />
      <circle cx="12" cy="9" r="3" fill="#EFEBF9" />
    </svg>
  )
}

// The border a printed record carries: a guilloche rule with a rosette
// in each corner, drawn rather than scanned.
function RecordFrame() {
  const rose = (x, y) => (
    <g transform={`translate(${x} ${y})`}>
      {Array.from({ length: 12 }).map((_, i) => {
        const a = (i / 12) * Math.PI * 2
        return (
          <ellipse key={i} cx={Math.cos(a) * 4} cy={Math.sin(a) * 4} rx="7" ry="3"
                   transform={`rotate(${(a * 57.3).toFixed(1)} ${Math.cos(a) * 4} ${Math.sin(a) * 4})`}
                   fill="none" stroke="#43307D" strokeWidth=".6" />
        )
      })}
      <circle r="2.4" fill="none" stroke="#43307D" strokeWidth=".8" />
    </g>
  )
  return (
    <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.1]"
         viewBox="0 0 800 500" preserveAspectRatio="none">
      <rect x="10" y="10" width="780" height="480" rx="10" fill="none" stroke="#43307D" strokeWidth="1.4" />
      <rect x="16" y="16" width="768" height="468" rx="8" fill="none" stroke="#43307D" strokeWidth=".6" strokeDasharray="3 4" />
      <g opacity=".9">{rose(34, 34)}{rose(766, 34)}{rose(34, 466)}{rose(766, 466)}</g>
    </svg>
  )
}

// The block that stands for this record: a drawn matrix, the same every
// time for the same candidate and sitting, different for anyone else.
function SecurityMatrix({ seed = '', className }) {
  const N = 11
  const cells = []
  let h = 2166136261
  for (let i = 0; i < String(seed).length; i++) { h ^= String(seed).charCodeAt(i); h = Math.imul(h, 16777619) }
  let x = h >>> 0
  const next = () => { x = (Math.imul(x, 1103515245) + 12345) >>> 0; return x / 4294967296 }
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const finder = (r < 3 && c < 3) || (r < 3 && c > N - 4) || (r > N - 4 && c < 3)
      if (finder) continue
      if (next() > 0.52) cells.push([c, r])
    }
  }
  const eye = (cx, cy) => (
    <g>
      <rect x={cx} y={cy} width="3" height="3" fill="none" stroke="#43307D" strokeWidth=".55" />
      <rect x={cx + 1} y={cy + 1} width="1" height="1" fill="#43307D" />
    </g>
  )
  return (
    <svg viewBox="0 0 11 11" className={`${className} rounded-[8px] border border-fv-line bg-white p-[3px]`} aria-hidden="true">
      {eye(0, 0)}{eye(8, 0)}{eye(0, 8)}
      {cells.map(([c, r], i) => <rect key={i} x={c} y={r} width="1" height="1" fill="#5B3FA6" />)}
    </svg>
  )
}

// Where the centre signs it off.
function SignBlock({ name }) {
  return (
    <div className="flex flex-col items-end">
      <svg viewBox="0 0 120 34" className="h-[clamp(20px,2.8vh,32px)] w-[124px]" aria-hidden="true">
        <path d="M6 26c12-2 16-17 24-17s6 17 14 17 12-15 20-15 8 13 16 13 14-7 22-11"
              fill="none" stroke="#43307D" strokeWidth="1.6" strokeLinecap="round" opacity=".6" />
      </svg>
      <span className="w-[178px] border-t border-fv-line pt-1 text-right leading-tight">
        <span className="block truncate text-[13px] font-bold text-fv-ink">{name || 'Verification desk'}</span>
        <span className="fv-hi block text-[12px] font-bold text-fv-faint">केंद्र प्रभारी</span>
      </span>
    </div>
  )
}
