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
import FaceMatchPanel from '../../components/verify/FaceMatchPanel.jsx'
import { api, fetchFPTemplate, fetchPhotoBlob, isWalletEmptyError, getCandidateAttempts } from '../../lib/api.js'

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
    const raw = sessionStorage.getItem(STATE_KEY)
    return raw ? JSON.parse(raw) : null
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
const STEPS = ['Roll Number', 'Face Capture', 'Fingerprint', 'Result']

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
  const [snap, setSnap] = useState(null)
  const [faceResult, setFaceResult] = useState(persisted?.faceResult ?? null)
  const [fpResult, setFpResult] = useState(persisted?.fpResult ?? null)
  const [irisResult, setIrisResult] = useState(persisted?.irisResult ?? null)
  const [showIris, setShowIris] = useState(persisted?.showIris ?? false)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState(null)
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

  // ── Auto-decide + auto-submit ────────────────────────────────────
  // Face-first flow: as soon as we have enough signal to decide, we
  // submit the verification automatically — no manual button.
  //
  //   • Candidate has a fingerprint template → wait for BOTH face and
  //     fingerprint. Both must PASS for "verified" (strict AND).
  //   • Candidate has only face → face alone decides.
  //
  // Guarded by `result` and `submitting` so it fires exactly once per
  // verification flow. `reset()` clears result and puts us back to
  // step 0, ready for the next candidate.
  useEffect(() => {
    if (result || submitting) return
    if (!candidate || !faceResult) return
    const needsFP = !!candidate.has_iso_template
    if (needsFP && !fpResult) return
    const facePass = !!(faceResult && faceResult.ok === true)
    const fpPass   = !!(fpResult   && fpResult.ok   === true)
    const finalStatus = needsFP
      ? (facePass && fpPass ? 'verified' : 'denied')
      : (facePass ? 'verified' : 'denied')
    if (step < 3) setStep(3)
    submitVerification(finalStatus)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidate, faceResult, fpResult, result, submitting])

  // Persist whenever the meaningful state changes, so an unexpected
  // refresh doesn't lose the operator's in-flight verification.
  // photoBlob/gallery/snap are deliberately excluded — they're large
  // and re-fetchable from `roll`.
  useEffect(() => {
    if (step === 0 && !roll && !candidate && !faceResult && !fpResult) {
      // Idle / cleared state — drop the persisted record entirely.
      clearPersistedState()
      return
    }
    persistState({
      step, roll, faceResult, fpResult, irisResult, showIris,
      verificationStartedAt, idempotencyKey,
    })
  }, [step, roll, faceResult, fpResult, irisResult, showIris,
      verificationStartedAt, idempotencyKey, candidate])

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

  async function lookupRoll(e) {
    e?.preventDefault()
    setLookupErr('')
    setWalletEmpty(false)
    if (!roll.trim()) return
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
      setStep(1)
    } catch (e) {
      // HTTP 402 from the wallet middleware → org wallet is empty.
      // Operator cannot self-serve; show a banner with the resolution
      // path (notify admin to top up).
      if (isWalletEmptyError(e)) {
        setWalletEmpty(true)
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

      await api('/verifications', { method: 'POST', body })
      setResult(status)
      // Flow is complete — discard the persisted state so a refresh
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
    setFpResult(null)
    setIrisResult(null)
    setShowIris(false)
    setResult(null)
    setLookupErr('')
    setVerificationStartedAt(null)
  }

  return (
    <AppShell
      title="Center Operator Portal"
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
          // Two right-slot buttons, mutually exclusive by verification step:
          //
          //   step === 0 (roll-search page)  → "Download installer"
          //   step >  0 (mid-verification)   → "Start over"
          //
          // The Downloads link only shows on the search page so it doesn't
          // distract operators mid-capture; that's also the moment when a
          // fresh-laptop operator first lands here, so discoverability is
          // unchanged. Styled to match the Start-over button visually so
          // the slot doesn't shift in appearance between steps.
          step === 0 ? (
            <Link
              to="/client/downloads"
              title="Download the install bundle for a new operator laptop"
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
          )
        }
      />

      <Card className="mb-6">
        <CardBody>
          <Stepper step={step} />
        </CardBody>
      </Card>

      {step === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Step 1 — Roll number</CardTitle>
          </CardHeader>
          <CardBody>
            <form onSubmit={lookupRoll} className="max-w-md space-y-4">
              <div>
                <Label>Candidate roll number</Label>
                <Input
                  value={roll}
                  onChange={(e) => setRoll(e.target.value)}
                  placeholder="e.g. 10001"
                  autoFocus
                />
                <p className="mt-1 text-xs text-slate-500">
                  Try one of the seeded rolls (10001 – 10500).
                </p>
              </div>
              {lookupErr && (
                <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
                  {lookupErr}
                </div>
              )}
              <Button type="submit">Look up candidate</Button>
            </form>
          </CardBody>
        </Card>
      )}

      {/* Step 1 — face capture only. Candidate summary is deliberately
          hidden here: the operator must capture a face before the
          enrolled record is revealed (and before the wallet is
          charged). This nudges "person in front of me first, then
          look at their record" rather than the other way round. */}
      {step === 1 && candidate && (
        <Card>
          <CardHeader>
            <CardTitle>Step 2 — Live face capture</CardTitle>
          </CardHeader>
          <CardBody>
            <p className="text-sm text-slate-600 mb-4">
              Capture the candidate's face to unlock their enrolled record.
              This is the payable step — the wallet is charged when the
              face capture is submitted (₹ per lookup, same-roll retries
              are free within 5 minutes).
            </p>
            <FaceMatchPanel
              rollNo={candidate.roll_no}
              onResult={(r) => {
                setFaceResult(r)
                setSnap(r?.snapshot ?? null)
                if (step < 2) setStep(2)
              }}
            />
          </CardBody>
        </Card>
      )}

      {step >= 2 && candidate && (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-1 self-start">
            <CardHeader>
              <CardTitle>Candidate on file</CardTitle>
            </CardHeader>
            <CardBody>
              <div className="aspect-square w-full rounded-lg bg-slate-100 overflow-hidden mb-4">
                {photoBlob ? (
                  <img src={photoBlob} alt="enrolled" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-slate-400 text-sm">
                    No photo on file
                  </div>
                )}
              </div>
              <div className="flex items-baseline justify-between">
                <span className="text-xs uppercase tracking-wide text-slate-500">Roll number</span>
                <span className="text-lg font-semibold text-slate-900 tabular-nums">
                  {candidate.roll_no}
                </span>
              </div>
              {/* Phase 3c — attempt-counter chip. Only shown when the
                  operator's org has previously looked up this roll
                  (count > 0 means at least one prior verification row). */}
              {attempts && attempts.count > 0 && (
                <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-amber-50 border border-amber-200 px-2.5 py-0.5 text-[11px] font-medium text-amber-800">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                  {(() => {
                    const n = attempts.count + 1
                    const suffix = n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'
                    return `${n}${suffix} attempt on this roll`
                  })()}
                  {attempts.last_at && (
                    <span className="text-amber-700/70 font-normal">
                      · last {relativeAgo(attempts.last_at)}
                    </span>
                  )}
                </div>
              )}
              {faceResult && (
                <div className="mt-3 text-xs text-slate-600 flex items-baseline justify-between">
                  <span className="uppercase tracking-wide text-slate-500">Face match</span>
                  <span className={`font-semibold tabular-nums ${faceResult.ok ? 'text-emerald-700' : 'text-rose-700'}`}>
                    {faceResult.ok ? 'PASS' : 'FAIL'}
                    {typeof faceResult.score === 'number' && ` · ${faceResult.score.toFixed(2)}`}
                  </span>
                </div>
              )}
            </CardBody>
          </Card>

          <div className="lg:col-span-2 space-y-6">

            {step >= 2 && (
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
                      // matchThreshold left unset on purpose: registry
                      // provides the per-vendor default (Mantra 140,
                      // Startek 40 — SourceAFIS 1-in-1000 FMR). Pass an
                      // explicit number here only for one-off overrides
                      // during calibration.
                      onResult={(r) => {
                        setFpResult(r)
                        if (step < 3) setStep(3)
                      }}
                    />
                  ) : (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                      No fingerprint template on file for this candidate. Proceed with manual verification.
                      <div className="mt-3">
                        <Button onClick={() => step < 3 && setStep(3)}>Skip fingerprint step</Button>
                      </div>
                    </div>
                  )}
                </CardBody>
              </Card>
            )}

            {/* Iris fallback: appears when fingerprint failed (or no template
                on file) and the operator opts in. The sample data has no iris
                templates, so this is capture-for-audit; if/when iris gallery
                is enrolled, the matcher kicks in automatically. */}
            {step >= 2 && fpResult && fpResult.ok === false && !showIris && (
              <Card>
                <CardBody>
                  <p className="text-sm text-slate-700">
                    Fingerprint did not match. You can try iris as a fallback.
                  </p>
                  <div className="mt-3">
                    <Button onClick={() => setShowIris(true)}>Try iris instead</Button>
                  </div>
                </CardBody>
              </Card>
            )}
            {showIris && (
              <Card>
                <CardHeader>
                  <CardTitle>Iris fallback</CardTitle>
                </CardHeader>
                <CardBody>
                  <IrisCapture
                    matchThreshold={0.6}
                    onResult={(r) => {
                      setIrisResult(r)
                      if (step < 3) setStep(3)
                    }}
                  />
                </CardBody>
              </Card>
            )}

            {step >= 3 && (
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
                      </div>
                      <div className="mt-3">
                        <Button onClick={reset}>Start next verification</Button>
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
                        {submitting ? 'Recording verification…' : 'Deciding based on match thresholds…'}
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
    </AppShell>
  )
}
