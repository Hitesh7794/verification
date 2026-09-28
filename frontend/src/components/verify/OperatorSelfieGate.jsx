import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Verifier from '../login/Verifier.jsx'
import { getStoredToken, getRoleScope } from '../../lib/authStorage.js'
import { postOperatorSelfie } from '../../lib/api.js'
import { useAuth } from '../../lib/auth.jsx'

// OperatorSelfieGate — post-login "take your photo" screen, mirroring
// the Android app's flow before the roll-number search.
//
// Behaviour (matches the mobile client):
//   · Every fresh login is prompted to declare name + phone and take
//     one selfie of themselves at the operator's console.
//   · A logout / new tab / hard-reload triggers a fresh capture; a
//     silent page reload within the same session does NOT (the
//     sessionStorage flag survives navigation but not tab close).
//   · Name and phone are BOTH required — the app enforces both, and
//     the CP admin needs identity attached to every shift.
//   · The JPEG is uploaded raw to POST /api/operator/selfie with
//     X-Operator-Name / X-Operator-Phone headers, exactly as the
//     Android client does. See backend/internal/api/operator_selfie_handlers.go.
//
// The gate wraps its children; when the flag is set for the current
// token, `children` renders directly (no perceptible cost). While
// capture is required, `children` is not mounted at all — so the
// operator can't reach the roll-number search without a photo, and
// side-effects (wallet polls, exam picker) don't fire until they do.
//
// UI matches the FlatViolet redesign: tiranga ribbon, State Emblem
// behind the panel, `fv-*` design tokens, bilingual English + Hindi.

const V         = '#5B3FA6'
const V_DEEP    = '#43307D'
const V_SOFT    = '#EFEBF9'

// Where the "we've captured on this login" flag lives. Scoped to the
// current session (per-tab). Cleared automatically on tab close; a
// same-tab logout+login triggers a fresh capture because the key is
// suffixed with the last 16 chars of the token.
const FLAG_PREFIX = 'operator_selfie_captured:'
function flagKey() {
  const t = getStoredToken(getRoleScope()) || 'anon'
  return FLAG_PREFIX + t.slice(-16)
}
function isCapturedThisSession() {
  try { return sessionStorage.getItem(flagKey()) === '1' } catch { return false }
}
function markCapturedThisSession() {
  try { sessionStorage.setItem(flagKey(), '1') } catch {}
}

// Indian mobile numbers only. The operators sit inside exam centres
// in India, and the CP team's callback list has been running against
// this format for years — a foreign number here reads as a typo, not
// a legitimate operator. We accept the various ways a human might
// type the same number (with country code, leading zero, spaces,
// dashes, brackets) and normalise before validating.
function normalizeIndianMobile(raw) {
  let d = String(raw || '').replace(/\D/g, '')
  if (d.length === 12 && d.startsWith('91'))  d = d.slice(2)
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1)
  return d
}
function isValidIndianMobile(raw) {
  // 10 digits, starts with 6/7/8/9 (TRAI's mobile prefix band).
  return /^[6-9]\d{9}$/.test(normalizeIndianMobile(raw))
}

export default function OperatorSelfieGate({ children }) {
  const { user } = useAuth()
  const [done, setDone] = useState(() => isCapturedThisSession())
  if (done) return children
  return <SelfieCapture user={user} onDone={() => { markCapturedThisSession(); setDone(true) }} />
}

function SelfieCapture({ user, onDone }) {
  // Name is intentionally left blank on every session — the operator
  // must retype it each login, matching how the Android app treats
  // this as a declaration of who is physically at the desk (not just
  // whose account was used). Prefilling read as "the portal knows
  // it's you" and made the field feel like decoration.
  void user
  const [name, setName]   = useState('')
  const [phone, setPhone] = useState('')
  const [stage, setStage] = useState('form')  // 'form' → 'review' → 'sending'
  const [err, setErr]     = useState('')
  const [cameraReady, setCameraReady] = useState(false)
  const [cameraErr, setCameraErr]     = useState('')
  const [snap, setSnap]   = useState(null)   // { blob, url } after freeze
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const canvasRef = useRef(document.createElement('canvas'))

  // Camera lifecycle: open once when the gate mounts, close it when
  // the gate unmounts (either on success or if the shell above tears
  // us down). The stream is closed the moment we freeze the snap so a
  // running webcam LED doesn't stay lit while the operator is deciding.
  useEffect(() => {
    let cancelled = false
    async function open() {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 720 } },
          audio: false,
        })
        if (cancelled) { s.getTracks().forEach((t) => t.stop()); return }
        streamRef.current = s
        if (videoRef.current) {
          videoRef.current.srcObject = s
          videoRef.current.onloadedmetadata = () => setCameraReady(true)
        }
      } catch (e) {
        setCameraErr(e?.message || 'Could not open the camera')
      }
    }
    open()
    return () => {
      cancelled = true
      const s = streamRef.current
      if (s) s.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
  }, [])

  function stopCamera() {
    const s = streamRef.current
    if (s) s.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
  }

  async function capture() {
    const v = videoRef.current
    if (!v || !v.videoWidth) return
    // Draw the video into a square canvas, mirrored so the JPEG we
    // upload matches what the operator sees on screen (mirrored
    // preview → mirrored capture; a non-mirrored save reads as "why
    // is my parting on the wrong side").
    const side = Math.min(v.videoWidth, v.videoHeight)
    const sx = (v.videoWidth  - side) / 2
    const sy = (v.videoHeight - side) / 2
    const cv = canvasRef.current
    const TARGET = 480
    cv.width = TARGET; cv.height = TARGET
    const ctx = cv.getContext('2d')
    ctx.save()
    ctx.translate(TARGET, 0)
    ctx.scale(-1, 1)
    ctx.drawImage(v, sx, sy, side, side, 0, 0, TARGET, TARGET)
    ctx.restore()
    cv.toBlob((blob) => {
      if (!blob) { setErr('Could not encode the photo — try again'); return }
      setSnap({ blob, url: URL.createObjectURL(blob) })
      stopCamera()
      setStage('review')
    }, 'image/jpeg', 0.85)
  }

  async function retake() {
    if (snap?.url) URL.revokeObjectURL(snap.url)
    setSnap(null)
    setErr('')
    setCameraReady(false)
    // Re-open the camera — same code path as first mount.
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 720 } },
        audio: false,
      })
      streamRef.current = s
      if (videoRef.current) {
        videoRef.current.srcObject = s
        videoRef.current.onloadedmetadata = () => setCameraReady(true)
      }
      setStage('form')
    } catch (e) {
      setCameraErr(e?.message || 'Could not re-open the camera')
    }
  }

  async function submit() {
    if (!snap?.blob) return
    setStage('sending')
    setErr('')
    try {
      // Store the normalised 10-digit number so the CP admin's list
      // reads consistently regardless of how the operator typed it.
      await postOperatorSelfie(snap.blob, { name: name.trim(), phone: normalizeIndianMobile(phone) })
      if (snap.url) URL.revokeObjectURL(snap.url)
      onDone()
    } catch (e) {
      setErr(e?.message || 'Could not upload the photo — try again')
      setStage('review')
    }
  }

  const nameOk  = name.trim().length >= 2 && name.trim().length <= 120
  const phoneOk = isValidIndianMobile(phone)
  const canCapture = stage === 'form' && nameOk && phoneOk && cameraReady

  return createPortal(
    <div className="fixed inset-0 z-[70] flex flex-col overflow-y-auto bg-fv-page">
      {/* Tricolour ribbon along the top — the same signature strip the
          rest of the FlatViolet portal uses. */}
      <div aria-hidden="true" className="h-[6px] w-full shrink-0" style={{
        background: 'linear-gradient(to right, #FF9933 0 33.33%, #FFFFFF 33.33% 66.66%, #128807 66.66% 100%)',
      }} />
      <div className="relative flex-1 px-5 py-6 sm:px-10 sm:py-8">
        {/* State Emblem, faint behind the panel. */}
        <span aria-hidden="true" className="fv-emblem pointer-events-none absolute left-1/2 top-1/2 -z-[1] h-[70%] -translate-x-1/2 -translate-y-1/2 opacity-[0.05]" />

        <div className="mx-auto max-w-5xl">
          <header className="mb-5">
            <p className="fv-display text-[26px] font-bold leading-[1.05] tracking-[-0.02em] text-fv-ink sm:text-[30px]">Take your photo</p>
            <p className="fv-hi mt-1 text-[15px] font-medium text-fv-muted sm:text-[16px]">अपनी फ़ोटो लें</p>
            <p className="mt-3 max-w-2xl text-[14px] leading-snug text-fv-muted">
              Confirm you are the agent on this desk before you start checking candidates.
              <span className="fv-hi mt-1 block text-[13.5px] text-fv-faint">आज इस डेस्क पर आप ही एजेंट हैं, यह पुष्टि करें।</span>
            </p>
          </header>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
            {/* ── Left: identity form ─────────────────────────────── */}
            <section className="rounded-[14px] border border-fv-line bg-fv-card p-5">
              <p className="fv-display text-[16px] font-bold text-fv-ink">Who is signing in?
                <span className="fv-hi ml-2 text-[12.5px] font-bold text-fv-faint">कौन लॉगिन कर रहा है?</span>
              </p>
              <div className="mt-4 space-y-4">
                <Field
                  label={['Name', 'नाम']}
                  value={name}
                  onChange={setName}
                  autoFocus
                  // Chrome/Safari ignore autoComplete="off" on plain
                  // name fields (they still offer saved-address /
                  // saved-name suggestions), but they DO honour
                  // "new-password" for suppressing history-based
                  // autofill. Pairing it with a randomised `name`
                  // attribute stops the browser from matching this
                  // field to any previously saved value.
                  autoComplete="new-password"
                  name="op_name_field"
                  hint={nameOk ? '' : 'Enter your full name (min 2 characters).'}
                  hintHi="अपना पूरा नाम भरें (कम-से-कम 2 अक्षर)।"
                  showHint={name.length > 0 && !nameOk}
                />
                <Field
                  label={['Mobile number', 'मोबाइल नंबर']}
                  value={phone}
                  // Digits only, capped at 10. Anything the operator
                  // pastes (spaces, dashes, +91 prefix, brackets)
                  // gets filtered here so the field always shows
                  // exactly the ten digits that will be sent, and
                  // further keystrokes past ten are silently ignored.
                  onChange={(v) => setPhone(v.replace(/\D/g, '').slice(0, 10))}
                  inputMode="numeric"
                  autoComplete="off"
                  name="op_phone_field"
                  maxLength={10}
                  placeholder="10-digit Indian mobile"
                  hint="Enter a 10-digit Indian mobile number (starts with 6, 7, 8, or 9)."
                  hintHi="10-अंकों का भारतीय मोबाइल नंबर भरें (6, 7, 8 या 9 से शुरू)।"
                  showHint={phone.length > 0 && !phoneOk}
                />
              </div>

              {/* Verifier mascot + coaching line. */}
              <div className="mt-5 flex items-end gap-3 rounded-[12px] bg-fv-card-focus px-3 py-3">
                <span className="h-16 w-16 shrink-0"><Verifier mood={{ type: 'namaste' }} className="h-full w-full" /></span>
                <span className="pb-1 text-[13.5px] leading-snug text-fv-ink">
                  Fill in your name and mobile, then look at the camera and press capture.
                  <span className="fv-hi mt-1 block text-[12.5px] text-fv-muted">अपना नाम व मोबाइल भरें, फिर कैमरा देखें और फ़ोटो लें।</span>
                </span>
              </div>
            </section>

            {/* ── Right: camera / captured photo ──────────────────── */}
            <section className="rounded-[14px] border border-fv-line bg-fv-card p-5">
              <p className="fv-display text-[16px] font-bold text-fv-ink">Your photo
                <span className="fv-hi ml-2 text-[12.5px] font-bold text-fv-faint">आपकी फ़ोटो</span>
              </p>

              <div className="mt-3 relative mx-auto aspect-square w-full max-w-[420px] overflow-hidden rounded-[14px] bg-[#0E0B1C]">
                {stage === 'review' && snap ? (
                  <img src={snap.url} alt="Captured selfie" className="absolute inset-0 h-full w-full object-cover" />
                ) : (
                  <>
                    <video
                      ref={videoRef}
                      autoPlay
                      playsInline
                      muted
                      className="absolute inset-0 h-full w-full object-cover"
                      style={{ transform: 'scaleX(-1)' }}
                    />
                    {/* Simple oval guide so the operator centres their face. */}
                    <svg viewBox="0 0 100 100" className="pointer-events-none absolute inset-0 h-full w-full" preserveAspectRatio="none">
                      <ellipse cx="50" cy="50" rx="30" ry="38" fill="none" stroke={V} strokeOpacity="0.6" strokeWidth="0.6" strokeDasharray="2 2" />
                    </svg>
                    {!cameraReady && !cameraErr && (
                      <div className="absolute inset-0 grid place-items-center text-center text-white">
                        <div>
                          <div className="mx-auto h-14 w-14 animate-pulse rounded-full bg-white/15" />
                          <p className="mt-3 text-[14px] font-semibold">Starting the camera…</p>
                          <p className="fv-hi mt-1 text-[12.5px] text-white/70">कैमरा शुरू हो रहा है</p>
                        </div>
                      </div>
                    )}
                    {cameraErr && (
                      <div className="absolute inset-0 grid place-items-center p-4 text-center text-white">
                        <div>
                          <p className="text-[14px] font-semibold">Camera unavailable</p>
                          <p className="fv-hi mt-1 text-[12.5px] text-white/75">कैमरा उपलब्ध नहीं</p>
                          <p className="mt-2 text-[12.5px] text-white/70">{cameraErr}</p>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>

              {err && (
                <div role="alert" className="mt-3 rounded-[10px] border border-[#EDD9B8] bg-[#F6EDDD] px-3 py-2 text-[13px] font-semibold text-[#A8711F]">
                  {err}
                </div>
              )}

              {/* Action buttons — swap on stage. */}
              <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
                {stage === 'form' && (
                  <button
                    type="button"
                    onClick={capture}
                    disabled={!canCapture}
                    className="rounded-[12px] bg-fv-accent px-6 py-3 text-[15.5px] font-bold text-white shadow-[0_10px_30px_rgba(91,63,166,.28)] transition hover:bg-fv-accent-deep disabled:cursor-not-allowed disabled:opacity-50"
                    style={{ background: V }}
                  >
                    Capture photo
                    <span className="fv-hi ml-2 text-[13px] font-bold text-white/85">फ़ोटो लें</span>
                    <span aria-hidden="true" className="ml-2">→</span>
                  </button>
                )}
                {stage === 'review' && (
                  <>
                    <button
                      type="button"
                      onClick={retake}
                      className="rounded-[12px] border-2 border-fv-line bg-white px-5 py-2.5 text-[15px] font-bold text-fv-ink transition hover:bg-fv-page"
                    >
                      Retake
                      <span className="fv-hi ml-1.5 text-[13px] font-bold text-fv-faint">फिर से</span>
                    </button>
                    <button
                      type="button"
                      onClick={submit}
                      className="rounded-[12px] px-6 py-3 text-[15.5px] font-bold text-white shadow-[0_10px_30px_rgba(91,63,166,.28)] transition hover:brightness-110"
                      style={{ background: V }}
                    >
                      Continue
                      <span className="fv-hi ml-2 text-[13px] font-bold text-white/85">जारी रखें</span>
                      <span aria-hidden="true" className="ml-2">→</span>
                    </button>
                  </>
                )}
                {stage === 'sending' && (
                  <button
                    type="button"
                    disabled
                    className="inline-flex items-center gap-2 rounded-[12px] px-6 py-3 text-[15.5px] font-bold text-white opacity-90"
                    style={{ background: V_DEEP }}
                  >
                    <span aria-hidden="true" className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/60 border-t-transparent" />
                    Uploading…
                    <span className="fv-hi ml-1 text-[13px] font-bold text-white/85">भेजा जा रहा है</span>
                  </button>
                )}
              </div>
            </section>
          </div>

          <p className="mt-5 text-center text-[12.5px] text-fv-faint">
            Your photo is stored with your account and stamped onto every verification you run today.
            <span className="fv-hi mt-0.5 block">आज की हर जाँच पर आपकी यह फ़ोटो जुड़ जाएगी।</span>
          </p>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function Field({ label, value, onChange, hint, hintHi, showHint, ...rest }) {
  return (
    <label className="block">
      <span className="text-[13px] font-bold text-fv-ink">
        {label[0]}
        <span className="text-[#A8711F]"> *</span>
        <span className="fv-hi ml-1.5 text-[12px] font-bold text-fv-faint">{label[1]}</span>
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1.5 block w-full rounded-[10px] border border-fv-line bg-white px-3 py-2.5 text-[14.5px] text-fv-ink outline-none transition focus:border-fv-accent focus:ring-2 focus:ring-fv-accent-soft"
        {...rest}
      />
      {showHint && (
        <span className="mt-1 block text-[12px] text-[#A8711F]">
          {hint}
          {hintHi && <span className="fv-hi ml-1.5 text-[11.5px]">{hintHi}</span>}
        </span>
      )}
    </label>
  )
}
