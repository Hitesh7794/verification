import { useEffect, useRef, useState } from 'react'
import AppShell from '../../components/AppShell.jsx'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Label,
  PageHeader,
} from '../../components/ui.jsx'
import FingerprintCapture from '../../components/FingerprintCapture.jsx'
import IrisCapture from '../../components/IrisCapture.jsx'
import FaceMatchPanel from '../../components/FaceMatchPanel.jsx'
import { api, fetchFPTemplate, fetchPhotoBlob } from '../../lib/api.js'

// Generate an idempotency key per verification attempt so a network retry
// of the submit doesn't create two rows. crypto.randomUUID is available in
// every browser this app supports (Vite targets evergreen).
function newIdempotencyKey() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return 'k-' + Date.now() + '-' + Math.random().toString(36).slice(2)
}

const APP_VERSION = '0.2.0'

const STEPS = ['Roll Number', 'Face Capture', 'Fingerprint', 'Decision']

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
  const [step, setStep] = useState(0)
  const [roll, setRoll] = useState('')
  const [candidate, setCandidate] = useState(null)
  const [photoBlob, setPhotoBlob] = useState(null)
  const [gallery, setGallery] = useState(null) // {template_b64, format}
  const [lookupErr, setLookupErr] = useState('')
  const [snap, setSnap] = useState(null)
  const [faceResult, setFaceResult] = useState(null) // result from FaceMatchPanel
  const [fpResult, setFpResult] = useState(null) // result from FingerprintCapture
  const [irisResult, setIrisResult] = useState(null) // result from IrisCapture (fallback)
  const [showIris, setShowIris] = useState(false) // operator opted in to iris fallback
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState(null)
  const [verificationStartedAt, setVerificationStartedAt] = useState(null)

  async function lookupRoll(e) {
    e?.preventDefault()
    setLookupErr('')
    if (!roll.trim()) return
    try {
      const c = await api(`/candidates/${encodeURIComponent(roll.trim())}`)
      setCandidate(c)
      setVerificationStartedAt(Date.now())
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
      setStep(1)
    } catch (e) {
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
        idempotency_key: newIdempotencyKey(),
      }
      if (fpResult) {
        Object.assign(body, {
          device_serial: fpResult.deviceSerial || null,
          device_model: fpResult.deviceModel || null,
          fp_template_format: fpResult.templateFormat || null,
          fp_quality: fpResult.quality,
          fp_nfiq: fpResult.nfiq,
          fp_match_score: fpResult.score,
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
      <PageHeader
        title="New verification"
        subtitle="Enter the candidate roll number, capture face and fingerprint, then record the decision."
        right={
          step > 0 && (
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

      {step >= 1 && candidate && (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-1">
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
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-slate-500">Roll No.</dt>
                  <dd className="font-medium text-slate-900">{candidate.roll_no}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Organization</dt>
                  <dd className="font-medium text-slate-900">{candidate.org_code}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Center</dt>
                  <dd className="font-medium text-slate-900 text-right max-w-[60%]">
                    {candidate.center_name}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Exam date</dt>
                  <dd className="font-medium text-slate-900">{candidate.exam_date}</dd>
                </div>
                <div className="flex justify-between items-center">
                  <dt className="text-slate-500">Templates</dt>
                  <dd className="flex gap-1">
                    {candidate.has_photo && <Badge tone="indigo">Photo</Badge>}
                    {candidate.has_fp_image && <Badge tone="indigo">FP img</Badge>}
                    {candidate.has_iso_template && <Badge tone="indigo">ISO</Badge>}
                  </dd>
                </div>
              </dl>
            </CardBody>
          </Card>

          <div className="lg:col-span-2 space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Step 2 — Live face capture &amp; match</CardTitle>
              </CardHeader>
              <CardBody>
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

            {step >= 2 && (
              <Card>
                <CardHeader>
                  <CardTitle>Step 3 — Fingerprint scan</CardTitle>
                </CardHeader>
                <CardBody>
                  {gallery ? (
                    <FingerprintCapture
                      galleryTemplate={gallery.template_b64}
                      galleryFormat={gallery.format}
                      matchThreshold={140}
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
                  <CardTitle>Step 4 — Operator decision</CardTitle>
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
                      <div className="mt-3">
                        <Button onClick={reset}>Start next verification</Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="text-sm text-slate-600 mb-4">
                        Compare the live capture against the candidate on file. SDK auto-matching
                        will integrate later — for now, record your decision manually.
                      </p>
                      <div className="flex gap-3">
                        <Button
                          variant="success"
                          size="lg"
                          disabled={submitting}
                          onClick={() => submitVerification('verified')}
                        >
                          {submitting ? 'Saving...' : 'Verified'}
                        </Button>
                        <Button
                          variant="danger"
                          size="lg"
                          disabled={submitting}
                          onClick={() => submitVerification('denied')}
                        >
                          Not verified
                        </Button>
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
