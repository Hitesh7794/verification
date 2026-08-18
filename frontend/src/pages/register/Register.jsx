import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { INDIAN_STATES, CITIES_BY_STATE } from '../../lib/india-locations.js'
import {
  Button,
  Input,
  Label,
} from '../../components/ui/ui.jsx'
import {
  AestheticCard,
  Icon,
  Pill,
} from '../../components/ui/extras.jsx'
import {
  AnimatePresence,
  FadeIn,
  SlideStep,
  StaggerList,
  StaggerItem,
} from '../../components/ui/motion.jsx'
import { PortalHeader } from '../../components/ui/brand.jsx'
import {
  registerInit,
  uploadDoc,
  deleteDoc,
  submitApplication,
  listPublicClients,
  loadDraft,
  saveDraft,
  clearDraft,
} from '../../lib/onboarding/register.js'

// Multi-step institution registration wizard.
//
// UI conventions used here, kept consistent across all 3 steps:
//   - One hue family (brand indigo) carries every accent; slate marks
//     subordinate blocks and emerald means "done". See ACCENTS below.
//   - Each section inside a step gets a small icon + tracker label
//     above its fields.
//   - Required-field markers are subtle (rose dot) instead of giant
//     asterisks.
//   - The footer with Back / Continue buttons is sticky inside the
//     card so very long sections don't bury the primary action.
//
// State persistence (localStorage), honeypot, and the per-doc upload
// retry pattern from earlier remain unchanged.

// Step indices are used throughout, so name them rather than scattering
// magic numbers. REVIEW sits between Documents and Done: this form is
// read by a human and a mistake costs the applicant days, so they get to
// see every answer in one place before committing.
const S_INSTITUTION = 0
const S_ADDRESS = 1
const S_DOCUMENTS = 2
const S_REVIEW = 3
const S_DONE = 4

const STEPS = [
  { label: 'Institution', icon: Icon.Building },
  { label: 'Address & Head', icon: Icon.MapPin },
  { label: 'Documents', icon: Icon.FileText },
  { label: 'Review', icon: Icon.Eye },
  { label: 'Done', icon: Icon.Check },
]

// ─── Palette ───────────────────────────────────────────────────────────
//
// This form is filled in by a registrar, dean or vice-chancellor. They
// arrive with an AISHE code, a PAN and a signed authorization letter,
// and a human reviews the result before anything is activated. It sits
// closer to a regulatory filing than to a product sign-up, so the colour
// has to read institutional: credible, calm, and obviously not a
// marketing page.
//
// What changed and why:
//   - The heading ran indigo → violet → FUCHSIA. Pink is the single
//     strongest "consumer startup" signal available, and it was the very
//     first thing a vice-chancellor saw. Now two analogous stops in the
//     brand hue — still crafted, no longer selling something.
//   - The section icons were a grab-bag: teal→emerald here, indigo→violet
//     there. Five hue families on one form reads unplanned.
//   - Progress is already signalled three ways — the sidebar tracker,
//     the emerald done-ticks, and the Continue/Submit label. Spending
//     hue on it as well was the fourth, and the least legible.
//
// Emerald stays, but only where it means "done" — status, not decoration.
const ACCENTS = {
  // The word "institution" in the page heading. Two analogous stops in
  // the brand hue, not three across half the colour wheel.
  heading: 'from-indigo-700 via-indigo-600 to-blue-600',
  // Primary section chip — brand indigo, matching the flat indigo-50
  // chips that steps 1 and 3 already use.
  section: 'from-indigo-500 to-indigo-600',
  // Subordinate section on the same step. Slate rather than a second
  // hue: it reads as "less important", which is the actual relationship.
  sub: 'from-slate-600 to-slate-800',
}

// College + university only — schools and coaching centres are out
// of scope for this portal. Each entry has a short blurb shown on
// the visual type-picker card so the operator can pick faster.
const INSTITUTION_TYPES = [
  {
    value: 'college',
    label: 'College',
    blurb: 'Undergraduate / professional, affiliated to a university',
  },
  {
    value: 'university',
    label: 'University',
    blurb: 'Multi-faculty, degree-granting in its own right',
  },
]
const AFFILIATION_BODIES = [
  'UGC', 'AICTE', 'CBSE', 'ICSE', 'State Board',
  'Deemed University', 'Autonomous', 'Other',
]
const DESIGNATIONS = [
  'Principal', 'Director', 'Registrar',
  'Vice-Chancellor', 'Dean', 'Owner', 'Trustee',
]
const REQUIRED_DOCS = [
  { kind: 'recognition_letter',   label: 'Recognition letter',  hint: 'From UGC / AICTE / state education board', required: true },
  { kind: 'pan_card',             label: 'PAN card scan',       hint: 'Of the institution / parent trust',         required: true },
  { kind: 'authorization_letter', label: 'Authorization letter', hint: 'On letterhead, signed by the head',         required: true },
  { kind: 'naac_certificate',     label: 'NAAC / NBA certificate', hint: 'Optional — strengthens your application', required: false },
]

// ─── Field rules ───────────────────────────────────────────────────────
//
// One rule per field, so the same logic can run three ways:
//   - on blur, for the single field the user just left
//   - on change, but only for a field that is ALREADY showing an error,
//     so a correction clears the message the moment it becomes valid
//     rather than on the next Continue
//   - for the whole step, when Continue is pressed
//
// Each rule returns an error string, or undefined when the value is
// acceptable. `form` is passed for the couple of rules that depend on a
// sibling field (affiliation "Other").
const FIELD_RULES = {
  institution_name: (v) =>
    v.trim().length < 3 ? 'Required (at least 3 characters)' : undefined,
  institution_type: (v) =>
    INSTITUTION_TYPES.find((t) => t.value === v) ? undefined : 'Pick a type',
  aishe_code: (v) => (!v.trim() ? 'Required' : undefined),
  pan: (v) => {
    if (!v.trim()) return 'Required'
    return /^[A-Z]{5}[0-9]{4}[A-Z]$/i.test(v.trim()) ? undefined : 'Format: ABCDE1234F'
  },
  year_established: (v) => {
    const year = Number(v)
    if (!v || !year) return 'Required'
    const now = new Date().getFullYear()
    return year < 1800 || year > now ? `Must be between 1800 and ${now}` : undefined
  },
  affiliation_body: (v) => (!v ? 'Required' : undefined),
  affiliation_body_other: (v, form) =>
    form.affiliation_body === 'Other' && !v.trim() ? 'Please specify' : undefined,
  approx_student_count: (v) => {
    const n = Number(v)
    if (!v || !n) return 'Required'
    return n < 1 || n > 10_000_000 ? 'Must be a positive number' : undefined
  },
  address_line1: (v) => (!v.trim() ? 'Required' : undefined),
  city: (v) => (!v.trim() ? 'Required' : undefined),
  state: (v) => (!v.trim() ? 'Required' : undefined),
  pin_code: (v) => (/^[0-9]{6}$/.test(v.trim()) ? undefined : 'PIN must be 6 digits'),
  head_name: (v) => (v.trim().length < 2 ? 'Required' : undefined),
  head_email: (v) =>
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? undefined : 'Invalid email',
  head_mobile: (v) => {
    // Indian mobile format:
    //   - 10 digits total
    //   - first digit must be 6, 7, 8 or 9 (TRAI mobile ranges;
    //     landline numbers start with 2-5 and don't belong here)
    // The input onChange normaliser has already stripped country codes,
    // leading 0, spaces, dashes and parens so what lands here is a bare
    // digit string of length 0..10.
    return /^[6-9][0-9]{9}$/.test(v.trim())
      ? undefined
      : 'Enter a 10-digit Indian mobile starting with 6, 7, 8 or 9'
  },
}

// normaliseIndianMobile accepts anything the user might paste — with
// spaces, dashes, parens, +91 prefix, trunk-0 prefix — and returns a
// bare 10-digit string (or fewer digits if they haven't finished typing).
// Called from the onChange handler so the field always shows the canonical
// form, matching what the validator expects.
function normaliseIndianMobile(raw) {
  let digits = String(raw || '').replace(/\D/g, '')
  // "+919876543210" or "919876543210" → drop the "91" country code.
  if (digits.length > 10 && digits.startsWith('91')) {
    digits = digits.slice(2)
  }
  // "09876543210" → drop the trunk-0 prefix.
  if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.slice(1)
  }
  return digits.slice(0, 10)
}

// Which fields belong to which step, for the Continue-time sweep.
const STEP_FIELDS = [
  [
    'institution_name', 'institution_type', 'aishe_code', 'pan',
    'year_established', 'affiliation_body', 'affiliation_body_other',
    'approx_student_count',
  ],
  ['address_line1', 'city', 'state', 'pin_code', 'head_name', 'head_email', 'head_mobile'],
]

const EMPTY_FORM = {
  // Which exam board (client) will review this KYC. Optional — when
  // omitted the application lands in the legacy superadmin queue.
  // Prefilled from ?client_id= in the URL so a client can hand out
  // their own dedicated registration link.
  client_id: '',
  institution_name: '',
  institution_type: 'college',
  aishe_code: '',
  pan: '',
  year_established: '',
  affiliation_body: '',
  affiliation_body_other: '', // free text when affiliation_body === 'Other'
  approx_student_count: '',
  address_line1: '',
  address_line2: '',
  city: '',
  district: '',
  state: '',
  pin_code: '',
  expected_centres: 1,
  head_name: '',
  head_designation: 'Principal',
  head_email: '',
  head_mobile: '',
  website: '', // honeypot
}

export default function Register() {
  const nav = useNavigate()
  const [step, setStep] = useState(0)
  const [form, setForm] = useState(EMPTY_FORM)
  const [applicationId, setApplicationId] = useState(null)
  const [uploaded, setUploaded] = useState({})
  const [errors, setErrors] = useState({})
  const [submitting, setSubmitting] = useState(false)
  const [topError, setTopError] = useState('')
  // Exam boards currently accepting KYC via their own review portal.
  // Loaded once on mount; the register form shows this as a dropdown
  // in step 0. Empty list → dropdown hides entirely (system falls back
  // to the legacy superadmin queue).
  const [publicClients, setPublicClients] = useState([])
  const [clientsLoaded, setClientsLoaded] = useState(false)

  // Restore draft on mount.
  useEffect(() => {
    const d = loadDraft()
    if (d) {
      setForm({ ...EMPTY_FORM, ...(d.form || {}) })
      setStep(d.step ?? 0)
      setApplicationId(d.applicationId ?? null)
      setUploaded(d.uploaded ?? {})
    }
    // Prefill client_id from URL (?client_id=42). Wins over any draft
    // value — if the visitor arrived through a client-specific link,
    // that intent is fresher than whatever was stashed in localStorage.
    try {
      const q = new URLSearchParams(window.location.search)
      const cid = q.get('client_id')
      if (cid && /^\d+$/.test(cid)) {
        setForm((f) => ({ ...f, client_id: cid }))
      }
    } catch {}
  }, [])

  // Load the public client list once. Failures are non-fatal — we just
  // hide the dropdown and route the application to the superadmin queue.
  useEffect(() => {
    let cancelled = false
    listPublicClients()
      .then((res) => {
        if (cancelled) return
        setPublicClients(Array.isArray(res?.clients) ? res.clients : [])
        setClientsLoaded(true)
      })
      .catch(() => {
        if (cancelled) return
        setPublicClients([])
        setClientsLoaded(true)
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    saveDraft({ form, step, applicationId, uploaded })
  }, [form, step, applicationId, uploaded])

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }))
    // Live-correct: only re-run the rule for a field that is ALREADY
    // showing an error, so the message disappears the instant the value
    // becomes valid. Fields with no error stay quiet while typing —
    // nobody wants "Invalid email" at "r@".
    //
    // Kept as its own setState rather than nested inside the setForm
    // updater: updaters must be pure, and React may run them twice in
    // StrictMode, which swallowed this update entirely on the first pass.
    setErrors((e) => {
      if (!e[field]) return e
      const msg = FIELD_RULES[field]?.(String(value ?? ''), { ...form, [field]: value })
      if (msg === e[field]) return e
      const { [field]: _drop, ...rest } = e
      return msg ? { ...rest, [field]: msg } : rest
    })
  }

  // Blur handler. Stays silent on a field the user tabbed straight
  // through without typing — flagging "Required" on something they
  // haven't reached yet reads as nagging. Continue still catches those.
  function validateOnBlur(field) {
    const raw = form[field]
    if (raw === undefined || String(raw).trim() === '') return
    const msg = FIELD_RULES[field]?.(String(raw), form)
    setErrors((e) => {
      if (msg === e[field]) return e
      const { [field]: _drop, ...rest } = e
      return msg ? { ...rest, [field]: msg } : rest
    })
  }

  // Whole-step sweep on Continue — this one DOES flag empty required
  // fields, and merges into any errors already on screen.
  function validateStep(index) {
    const e = {}
    for (const field of STEP_FIELDS[index]) {
      const msg = FIELD_RULES[field]?.(String(form[field] ?? ''), form)
      if (msg) e[field] = msg
    }
    setErrors(e)
    return Object.keys(e).length === 0
  }

  async function goToStep2() {
    if (!validateStep(S_ADDRESS)) return
    setSubmitting(true)
    setTopError('')
    try {
      if (!applicationId) {
        // If "Other" was picked for affiliation, send the free-text value
        // as affiliation_body (backend takes any non-empty string).
        const affiliation = form.affiliation_body === 'Other'
          ? form.affiliation_body_other.trim()
          : form.affiliation_body
        const payload = {
          ...form,
          affiliation_body: affiliation,
          year_established: Number(form.year_established) || 0,
          approx_student_count: Number(form.approx_student_count) || 0,
          expected_centres: Number(form.expected_centres) || 1,
          // Backend expects an int (or omit). Empty-string picker value
          // → drop the key entirely so the app lands in the legacy
          // superadmin queue rather than 400'ing on a NaN.
          client_id: form.client_id ? Number(form.client_id) : undefined,
        }
        delete payload.affiliation_body_other // internal-only field
        if (!payload.client_id) delete payload.client_id
        const res = await registerInit(payload)
        setApplicationId(res.application_id)
      }
      setStep(S_DOCUMENTS)
    } catch (err) {
      setTopError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleFile(docKind, file) {
    if (!file) return
    if (file.size > 10 * 1024 * 1024) {
      setErrors((e) => ({ ...e, [docKind]: 'File exceeds 10 MB limit' }))
      return
    }
    setErrors((e) => ({ ...e, [docKind]: undefined }))
    setUploaded((u) => ({ ...u, [docKind]: { uploading: true, progress: 0, original_name: file.name } }))
    try {
      const res = await uploadDoc(applicationId, docKind, file, (pct) => {
        setUploaded((u) => ({ ...u, [docKind]: { ...u[docKind], progress: pct } }))
      })
      setUploaded((u) => ({
        ...u,
        [docKind]: {
          doc_id: res.doc_id,
          original_name: res.original_name,
          size_bytes: res.size_bytes,
          uploading: false,
          progress: 100,
        },
      }))
    } catch (err) {
      setErrors((e) => ({ ...e, [docKind]: err.message }))
      setUploaded((u) => {
        const { [docKind]: _, ...rest } = u
        return rest
      })
    }
  }

  async function removeDoc(docKind) {
    const u = uploaded[docKind]
    if (!u?.doc_id) {
      setUploaded((prev) => {
        const { [docKind]: _, ...rest } = prev
        return rest
      })
      return
    }
    try {
      await deleteDoc(applicationId, u.doc_id)
    } catch {}
    setUploaded((prev) => {
      const { [docKind]: _, ...rest } = prev
      return rest
    })
  }

  // Documents → Review. The required-doc gate lives here now, so the
  // applicant can't reach a review page that claims they're ready when
  // they aren't.
  function goToReview() {
    const missing = REQUIRED_DOCS.filter((d) => d.required && !uploaded[d.kind]?.doc_id)
    if (missing.length) {
      setTopError('Please upload: ' + missing.map((d) => d.label).join(', '))
      return
    }
    setTopError('')
    setStep(S_REVIEW)
  }

  async function finalize() {
    // Re-check both field steps and the docs before the irreversible
    // call. The applicant can jump back and edit from the review page,
    // so the data may have changed since it was last validated.
    const badStep = [S_INSTITUTION, S_ADDRESS].find((i) => !validateStep(i))
    if (badStep !== undefined) {
      setTopError('Some details need fixing — take another look at the highlighted fields.')
      setStep(badStep)
      return
    }
    const missing = REQUIRED_DOCS.filter((d) => d.required && !uploaded[d.kind]?.doc_id)
    if (missing.length) {
      setTopError('Please upload: ' + missing.map((d) => d.label).join(', '))
      setStep(S_DOCUMENTS)
      return
    }
    setSubmitting(true)
    setTopError('')
    try {
      await submitApplication(applicationId)
      clearDraft()
      setStep(S_DONE)
    } catch (err) {
      setTopError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  function startOver() {
    clearDraft()
    setForm(EMPTY_FORM)
    setApplicationId(null)
    setUploaded({})
    setStep(S_INSTITUTION)
    setTopError('')
  }

  return (
    <div className="min-h-screen relative bg-slate-50 overflow-hidden">
      {/* Ambient background — layered gradient orbs + fine grid overlay.
          Anchored to the body so it scrolls; pointer-events off. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden"
      >
        {/* soft grid — barely visible; adds structure without noise */}
        <div
          className="absolute inset-0 opacity-[0.35]"
          style={{
            backgroundImage:
              'linear-gradient(to right, rgb(226 232 240 / 0.5) 1px, transparent 1px), linear-gradient(to bottom, rgb(226 232 240 / 0.5) 1px, transparent 1px)',
            backgroundSize: '48px 48px',
            maskImage: 'radial-gradient(ellipse at top, black 40%, transparent 75%)',
            WebkitMaskImage: 'radial-gradient(ellipse at top, black 40%, transparent 75%)',
          }}
        />
        {/* Two cool orbs in adjacent hues (indigo + blue). Was indigo +
            violet + emerald — three unrelated families competing behind
            a form about PAN numbers and authorization letters. Dropped
            to two, and softened, so the background stays background. */}
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 1.2, ease: 'easeOut' }}
          className="absolute -top-40 -left-24 h-[28rem] w-[28rem] rounded-full bg-indigo-200/35 blur-[100px]"
        />
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 1.2, delay: 0.1, ease: 'easeOut' }}
          className="absolute -top-24 right-[-6rem] h-[26rem] w-[26rem] rounded-full bg-blue-200/30 blur-[100px]"
        />
      </div>

      <PortalHeader
        right={
          <Link
            to="/admin/login"
            className="inline-flex items-center gap-1.5 rounded-lg
                       bg-white/70 hover:bg-white px-3 py-1.5 text-sm font-medium
                       text-slate-700 hover:text-slate-900
                       ring-1 ring-slate-200 hover:ring-slate-300
                       backdrop-blur transition"
          >
            <Icon.ChevronLeft className="h-4 w-4" />
            Back to sign in
          </Link>
        }
      />

      <main className="relative mx-auto max-w-6xl px-4 sm:px-6 pt-10 pb-16">
        <motion.h1
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
          className="text-3xl sm:text-4xl lg:text-[2.5rem] font-semibold tracking-tight text-slate-900 leading-tight"
        >
          {step === S_DONE
            ? 'Application received'
            : (
              <>
                Register your{' '}
                <span className={`bg-gradient-to-r ${ACCENTS.heading} bg-clip-text text-transparent`}>
                  institution
                </span>
              </>
            )}
        </motion.h1>

        {topError && (
          <div className="mt-4 rounded-lg bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-800 flex items-start gap-2">
            <Icon.X className="h-5 w-5 text-rose-600 shrink-0 mt-0.5" />
            <span>{topError}</span>
          </div>
        )}

        {/* Honeypot — off-screen, bots fill it, real users never see it. */}
        <input
          type="text"
          name="website"
          value={form.website}
          onChange={(e) => update('website', e.target.value)}
          autoComplete="off"
          tabIndex={-1}
          aria-hidden="true"
          style={{ position: 'absolute', left: '-10000px', width: '1px', height: '1px', overflow: 'hidden' }}
        />

        {/* Done step doesn't need the sidebar — full-width centred card. */}
        {step === S_DONE ? (
          <div className="mt-6">
            <AnimatePresence mode="wait" initial={false}>
              <SlideStep key={step}>
                <DonePanel
                  applicationId={applicationId}
                  email={form.head_email}
                  institutionName={form.institution_name}
                  onStartOver={startOver}
                  onHome={() => nav('/')}
                />
              </SlideStep>
            </AnimatePresence>
          </div>
        ) : (
          // Two-column layout: sticky step sidebar on the LEFT, form
          // on the right. Generous outer gap (gap-8 = 32px) so the
          // sidebar doesn't crowd the form visually. lg breakpoint
          // stacks the sidebar above the form on small screens.
          <div className="mt-6 grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-8 items-start">
            <StepSidebar step={step} />
            <div className="min-w-0">
              <AnimatePresence mode="wait" initial={false}>
                <SlideStep key={step}>
                  {step === S_INSTITUTION && (
                    <Step0
                      form={form}
                      errors={errors}
                      update={update}
                      onBlurField={validateOnBlur}
                      publicClients={publicClients}
                      clientsLoaded={clientsLoaded}
                      onNext={() => {
                        if (validateStep(S_INSTITUTION)) setStep(S_ADDRESS)
                      }}
                    />
                  )}
                  {step === S_ADDRESS && (
                    <Step1
                      form={form}
                      errors={errors}
                      update={update}
                      onBlurField={validateOnBlur}
                      onBack={() => setStep(S_INSTITUTION)}
                      onNext={goToStep2}
                      submitting={submitting}
                    />
                  )}
                  {step === S_DOCUMENTS && (
                    <Step2
                      applicationId={applicationId}
                      uploaded={uploaded}
                      errors={errors}
                      handleFile={handleFile}
                      removeDoc={removeDoc}
                      onBack={() => setStep(S_ADDRESS)}
                      onSubmit={goToReview}
                      submitting={submitting}
                    />
                  )}
                  {step === S_REVIEW && (
                    <ReviewStep
                      form={form}
                      uploaded={uploaded}
                      onEdit={(s) => { setTopError(''); setStep(s) }}
                      onBack={() => setStep(S_DOCUMENTS)}
                      onSubmit={finalize}
                      submitting={submitting}
                    />
                  )}
                </SlideStep>
              </AnimatePresence>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

// ─── StepSidebar ────────────────────────────────────────────────────────
//
// Left-rail step navigation. Just the vertical step list — no header,
// no subtitle, no "draft saved" footer, no per-step help card. Clean.

function StepSidebar({ step }) {
  return (
    <aside className="lg:sticky lg:top-6 lg:self-start">
      <AestheticCard>
        <ol className="p-3 space-y-1.5">
          {STEPS.slice(0, 4).map((s, i) => {
            const active = i === step
            const done = i < step
            const IconComp = s.icon
            return (
              <li key={s.label}>
                <motion.div
                  layout
                  className={`flex items-center gap-3 rounded-xl px-3 py-3 transition-colors ${
                    active
                      ? 'bg-slate-900'
                      : done
                      ? 'bg-emerald-50/70'
                      : 'bg-transparent'
                  }`}
                >
                  <motion.span
                    initial={false}
                    animate={{ scale: active ? 1.05 : 1 }}
                    transition={{ duration: 0.2 }}
                    className={`h-9 w-9 rounded-lg flex items-center justify-center shrink-0 ${
                      active
                        ? 'bg-white/15 text-white'
                        : done
                        ? 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200'
                        : 'bg-slate-100 text-slate-400'
                    }`}
                  >
                    {done ? <Icon.Check className="h-4 w-4" /> : <IconComp className="h-4 w-4" />}
                  </motion.span>
                  <p
                    className={`text-sm font-medium ${
                      active ? 'text-white' : done ? 'text-emerald-800' : 'text-slate-700'
                    }`}
                  >
                    {s.label}
                  </p>
                  {active && (
                    <motion.span
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      className="ml-auto h-2 w-2 rounded-full bg-emerald-400 shrink-0 animate-pulse"
                      aria-label="current step"
                    />
                  )}
                </motion.div>
              </li>
            )
          })}
        </ol>
      </AestheticCard>
    </aside>
  )
}

// ─── Step 0 ────────────────────────────────────────────────────────────

function Step0({ form, errors, update, onBlurField, onNext, publicClients = [], clientsLoaded = false }) {
  // The dropdown only shows up once we've heard back from the server AND
  // there's at least one enabled client. If the list is empty we hide the
  // control entirely rather than showing "— None available —"; the
  // application will fall back to the superadmin queue silently.
  const showClientPicker = clientsLoaded && publicClients.length > 0
  const selectedClient = publicClients.find(
    (c) => String(c.id) === String(form.client_id),
  )

  return (
    <AestheticCard>
      {/* Header — generous padding so the chip + title don't feel
          glued to the card edges. */}
      <div className="px-7 py-5 border-b border-slate-100 flex items-center gap-3.5">
        <span className="h-11 w-11 rounded-xl bg-indigo-50 text-indigo-700 flex items-center justify-center shrink-0">
          <Icon.Building className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-slate-900">Institution details</h2>
          <p className="text-sm text-slate-500 mt-0.5">Type, identifiers, and history of your institution.</p>
        </div>
      </div>

      {/* Body — split into two clearly-spaced visual sections:
            1. Type picker
            2. Identifier / history fields
          Separated by a subtle labelled divider so the eye doesn't
          read everything as one undifferentiated grid. */}
      <div className="px-7 py-7 space-y-7">
        {showClientPicker && (
          // Reviewer picker. First thing on the form because it frames
          // the whole flow — the chosen board's team is who'll read the
          // uploaded docs and approve/reject. Kept in an amber-tinted
          // panel so it's visually distinct from the indigo card body
          // without competing for hierarchy with the primary CTA.
          <div className="rounded-xl border border-amber-100 bg-amber-50/60 px-5 py-4">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 h-8 w-8 rounded-lg bg-white text-amber-700 flex items-center justify-center shrink-0 ring-1 ring-amber-200">
                <Icon.ShieldCheck className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <Label className="!mb-0">Exam board reviewer</Label>
                  <span className="text-[11px] uppercase tracking-wide text-amber-700/80">
                    Optional
                  </span>
                </div>
                <p className="text-xs text-slate-600 mt-1">
                  Route this KYC to a specific board. If left blank, the
                  platform's onboarding team reviews it.
                </p>
                <div className="mt-2.5">
                  <Select
                    value={form.client_id}
                    onChange={(e) => update('client_id', e.target.value)}
                    options={[
                      { value: '', label: '— Platform onboarding team —' },
                      ...publicClients.map((c) => ({ value: String(c.id), label: c.name })),
                    ]}
                  />
                </div>
                {selectedClient && (
                  <p className="mt-2 text-xs text-amber-900">
                    <span className="font-medium">{selectedClient.name}</span> will
                    review your documents and issue admin credentials on approval.
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        <div>
          <Label>
            Type <span className="text-rose-600 ml-0.5">*</span>
          </Label>
          {/* Capped width: with Tier gone this picker would otherwise
              stretch the full card, turning two short options into two
              very wide slabs. */}
          <div className="grid grid-cols-2 gap-2.5 max-w-md">
            {INSTITUTION_TYPES.map((t) => (
              <CompactChoice
                key={t.value}
                selected={form.institution_type === t.value}
                onSelect={() => update('institution_type', t.value)}
                icon={Icon.Building}
                label={t.label}
              />
            ))}
          </div>
          {errors.institution_type && (
            <p className="mt-1.5 text-xs text-rose-600">{errors.institution_type}</p>
          )}
        </div>

        <Divider label="Identifiers & history" />

        {/* Identifier + history fields in a 6-column grid. The col-spans
            below balance label widths so nothing wraps awkwardly:
              row 1: name (full)
              row 2: AISHE | PAN | Year      (2 + 2 + 2)
              row 3: Affiliation | Students  (4 + 2)
            gap-6 gives each row ~24px breathing room horizontally and
            vertically — enough that adjacent fields don't crowd. */}
        <div className="grid grid-cols-1 sm:grid-cols-6 gap-x-6 gap-y-5">
          <Field className="sm:col-span-6" label="Institution name" required error={errors.institution_name}>
            <Input
              value={form.institution_name}
              onChange={(e) => update('institution_name', e.target.value)}
              onBlur={() => onBlurField('institution_name')}
              placeholder="e.g. Saragarhi Memorial College of Eminence"
            />
          </Field>
          <Field className="sm:col-span-2" label="AISHE code" required error={errors.aishe_code}>
            <InputWithIcon
              icon={Icon.ShieldCheck}
              value={form.aishe_code}
              onChange={(e) => update('aishe_code', e.target.value)}
              onBlur={() => onBlurField('aishe_code')}
              placeholder="C-12345"
            />
          </Field>
          <Field className="sm:col-span-2" label="PAN" required error={errors.pan}>
            <InputWithIcon
              icon={Icon.File}
              value={form.pan}
              onChange={(e) => update('pan', e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10))}
              onBlur={() => onBlurField('pan')}
              placeholder="ABCDE1234F"
              maxLength={10}
            />
          </Field>
          <Field className="sm:col-span-2" label="Year established" required error={errors.year_established}>
            <YearPicker
              value={form.year_established}
              onChange={(y) => update('year_established', y)}
              placeholder="Pick year"
            />
          </Field>
          <Field className="sm:col-span-4" label="Affiliation body" required error={errors.affiliation_body}>
            <Select
              value={form.affiliation_body}
              onChange={(e) => update('affiliation_body', e.target.value)}
              options={[
                { value: '', label: '— Pick one —' },
                ...AFFILIATION_BODIES.map((b) => ({ value: b, label: b })),
              ]}
            />
            {form.affiliation_body === 'Other' && (
              <div className="mt-2">
                <Input
                  value={form.affiliation_body_other}
                  onChange={(e) => update('affiliation_body_other', e.target.value)}
                  onBlur={() => onBlurField('affiliation_body_other')}
                  placeholder="Specify affiliation body"
                  maxLength={80}
                />
                {errors.affiliation_body_other && (
                  <p className="mt-1.5 text-xs text-rose-600">{errors.affiliation_body_other}</p>
                )}
              </div>
            )}
          </Field>
          <Field className="sm:col-span-2" label="Student count" required error={errors.approx_student_count}>
            <InputWithIcon
              icon={Icon.Sparkles}
              type="number"
              value={form.approx_student_count}
              onChange={(e) => update('approx_student_count', e.target.value)}
              onBlur={() => onBlurField('approx_student_count')}
              placeholder="500"
            />
          </Field>
        </div>
      </div>

      <FooterBar>
        <span className="text-xs text-slate-500">
          Required fields marked with <span className="text-rose-600">*</span>
        </span>
        <Button onClick={onNext} size="lg">
          Continue
          <Icon.ChevronRight className="ml-1.5 h-4 w-4" />
        </Button>
      </FooterBar>
    </AestheticCard>
  )
}

// CompactChoice — picker button for the Type slot. A leading icon chip
// so the eye picks the category before the text. Used in a 2-up grid;
// the dropped blurb (vs the old ChoiceCard) keeps things tidy without
// feeling cramped.
function CompactChoice({ selected, onSelect, icon: IconComp, label }) {
  // `flex w-full` so both buttons fill their grid cell to exactly the
  // same width, and `justify-center` so the icon + label sit centred
  // rather than ragged against the left edge.
  return (
    <motion.button
      type="button"
      onClick={onSelect}
      whileTap={{ scale: 0.98 }}
      className={`relative h-14 flex w-full items-center justify-center gap-2.5 rounded-xl border px-9 transition-colors ${
        selected
          ? 'border-slate-900 bg-slate-50/80 ring-1 ring-slate-900/10'
          : 'border-slate-200 bg-white hover:border-slate-300'
      }`}
    >
      {IconComp && (
        <span
          className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 transition-colors ${
            selected ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600'
          }`}
        >
          <IconComp className="h-4 w-4" />
        </span>
      )}
      <span className={`text-sm font-medium ${selected ? 'text-slate-900' : 'text-slate-800'}`}>
        {label}
      </span>
      {/* Absolutely positioned, so selecting an option doesn't shove its
          label off-centre and leave the two buttons visibly mismatched.
          The symmetric px-9 reserves room for it on both sides. */}
      {selected && (
        <motion.span
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ duration: 0.15, ease: [0.22, 1.5, 0.36, 1] }}
          className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 rounded-full bg-emerald-50 text-emerald-600 ring-1 ring-emerald-200 flex items-center justify-center"
        >
          <Icon.Check className="h-2.5 w-2.5" />
        </motion.span>
      )}
    </motion.button>
  )
}

// ─── New visual primitives used by Step 0 ──────────────────────────────

// ChoiceCard — a large clickable card used for type-picking. Animates
// a subtle scale + border tightening on hover, and locks in with a
// dark border + check icon when selected.
function ChoiceCard({ selected, onSelect, icon: IconComp, label, blurb }) {
  return (
    <motion.button
      type="button"
      onClick={onSelect}
      whileHover={{ y: -2, transition: { duration: 0.18 } }}
      whileTap={{ scale: 0.985, y: 0 }}
      className={`relative text-left rounded-xl border p-4 transition-colors duration-150
                  ${selected
                    ? 'border-slate-900 bg-slate-50/80 ring-1 ring-slate-900/10'
                    : 'border-slate-200 bg-white hover:border-slate-300'}`}
    >
      <div className="flex items-start gap-3">
        <span
          className={`h-10 w-10 rounded-lg flex items-center justify-center shrink-0 transition-colors
                      ${selected ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600'}`}
        >
          <IconComp className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className={`text-sm font-semibold ${selected ? 'text-slate-900' : 'text-slate-800'}`}>{label}</p>
          </div>
          <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{blurb}</p>
        </div>
      </div>
      {/* Animated emerald check badge when selected. Soft green pill
          (bg-emerald-50 + emerald-600 stroke) matches the rest of the
          completion indicators in the wizard. */}
      <AnimatePresence>
        {selected && (
          <motion.span
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.22, 1.5, 0.36, 1] }}
            className="absolute top-3 right-3 h-6 w-6 rounded-lg bg-emerald-50 text-emerald-600 ring-1 ring-emerald-200 flex items-center justify-center"
          >
            <Icon.Check className="h-3.5 w-3.5" />
          </motion.span>
        )}
      </AnimatePresence>
    </motion.button>
  )
}

// ─── Review step ───────────────────────────────────────────────────────
//
// Everything the applicant is about to submit, in one read-only page.
// This form is reviewed by a human and a rejection costs days, so the
// cheapest possible fix for a typo'd PAN or a wrong email is letting
// them see it before they commit.
//
// Every group has its own Edit link back to the step that owns it —
// returning to the review page is just Continue, and the draft keeps
// the answers, so a correction is a few seconds' round trip.
function ReviewStep({ form, uploaded, onEdit, onBack, onSubmit, submitting }) {
  const affiliation =
    form.affiliation_body === 'Other'
      ? form.affiliation_body_other
      : form.affiliation_body

  const typeLabel =
    INSTITUTION_TYPES.find((t) => t.value === form.institution_type)?.label ||
    form.institution_type

  const address = [
    form.address_line1,
    form.address_line2,
    [form.city, form.district].filter(Boolean).join(', '),
    [form.state, form.pin_code].filter(Boolean).join(' — '),
  ].filter((l) => l && l.trim())

  const docs = REQUIRED_DOCS.filter((d) => uploaded[d.kind]?.doc_id)

  return (
    <AestheticCard>
      <div className="px-7 py-6 border-b border-slate-100">
        <div className="flex items-start gap-3">
          <span className="h-10 w-10 rounded-xl bg-indigo-50 text-indigo-700 flex items-center justify-center shrink-0">
            <Icon.Eye className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-base font-semibold text-slate-900">Review your application</h2>
            <p className="text-sm text-slate-500 mt-0.5">
              Check every detail before submitting. Our team reviews this manually,
              so a correction now saves days later.
            </p>
          </div>
        </div>
      </div>

      <div className="px-7 py-6 space-y-6">
        <ReviewGroup
          title="Institution"
          onEdit={() => onEdit(S_INSTITUTION)}
          rows={[
            ['Name', form.institution_name],
            ['Type', typeLabel],
            ['AISHE code', form.aishe_code],
            ['PAN', form.pan?.toUpperCase()],
            ['Year established', form.year_established],
            ['Affiliation', affiliation],
            ['Approx. students', form.approx_student_count],
          ]}
        />

        <ReviewGroup
          title="Campus address"
          onEdit={() => onEdit(S_ADDRESS)}
          rows={[
            ['Address', address.join('\n')],
            ['Expected centres', form.expected_centres],
          ]}
        />

        <ReviewGroup
          title="Head of institution"
          onEdit={() => onEdit(S_ADDRESS)}
          rows={[
            ['Name', form.head_name],
            ['Designation', form.head_designation],
            ['Email', form.head_email],
            ['Mobile', form.head_mobile],
          ]}
          // The activation link goes to this address — if it's wrong the
          // applicant never hears back, so it's worth calling out.
          note="The activation link is sent to this email address after approval."
        />

        <div>
          <div className="flex items-center justify-between gap-3 mb-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-600">
              Documents
            </h3>
            <button
              type="button"
              onClick={() => onEdit(S_DOCUMENTS)}
              className="text-xs font-medium text-indigo-600 hover:text-indigo-800 hover:underline"
            >
              Edit
            </button>
          </div>
          <ul className="rounded-xl border border-slate-200 divide-y divide-slate-100 overflow-hidden">
            {docs.map((d) => (
              <li key={d.kind} className="flex items-center gap-3 px-4 py-2.5">
                <span className="h-6 w-6 rounded-md bg-emerald-50 text-emerald-600 ring-1 ring-emerald-200 flex items-center justify-center shrink-0">
                  <Icon.Check className="h-3.5 w-3.5" />
                </span>
                <span className="text-sm text-slate-800">{d.label}</span>
                <span className="ml-auto text-xs text-slate-500 truncate max-w-[45%]">
                  {uploaded[d.kind]?.original_name}
                </span>
              </li>
            ))}
            {docs.length === 0 && (
              <li className="px-4 py-3 text-sm text-slate-500">No documents uploaded.</li>
            )}
          </ul>
        </div>

        <div className="rounded-lg bg-slate-50 border border-slate-200 px-4 py-3 text-xs text-slate-600 leading-relaxed">
          Submitting locks the application for review. You won't be able to edit it
          afterwards — our team will contact the head of institution at the email above.
        </div>
      </div>

      <FooterBar>
        <Button type="button" variant="ghost" onClick={onBack} disabled={submitting}>
          Back
        </Button>
        <Button type="button" onClick={onSubmit} disabled={submitting}>
          {submitting ? 'Submitting…' : 'Submit application'}
        </Button>
      </FooterBar>
    </AestheticCard>
  )
}

// One labelled block of read-only answers, with an Edit link back to
// whichever step owns them.
function ReviewGroup({ title, rows, onEdit, note }) {
  const filled = rows.filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-600">{title}</h3>
        <button
          type="button"
          onClick={onEdit}
          className="text-xs font-medium text-indigo-600 hover:text-indigo-800 hover:underline"
        >
          Edit
        </button>
      </div>
      <dl className="rounded-xl border border-slate-200 divide-y divide-slate-100 overflow-hidden">
        {filled.map(([k, v]) => (
          <div key={k} className="flex gap-4 px-4 py-2.5">
            <dt className="text-xs text-slate-500 w-40 shrink-0 pt-0.5">{k}</dt>
            {/* whitespace-pre-line so the multi-line address keeps its
                line breaks instead of collapsing into one run-on line. */}
            <dd className="text-sm text-slate-900 min-w-0 break-words whitespace-pre-line">{v}</dd>
          </div>
        ))}
        {filled.length === 0 && (
          <div className="px-4 py-3 text-sm text-slate-500">Nothing entered.</div>
        )}
      </dl>
      {note && <p className="mt-1.5 text-xs text-slate-500">{note}</p>}
    </div>
  )
}

// Divider — a thin horizontal rule with a label centred over it. Adds
// visual hierarchy without taking real estate.
function Divider({ label }) {
  return (
    <div className="flex items-center gap-3 pt-1">
      <span className="h-px flex-1 bg-slate-200" />
      <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</span>
      <span className="h-px flex-1 bg-slate-200" />
    </div>
  )
}

// InputWithIcon — wraps the existing Input with a slate icon on the
// left. Animates a soft indigo glow on focus so the active field is
// visually distinct.
function InputWithIcon({ icon: IconComp, className = '', ...rest }) {
  return (
    <div className="relative group">
      {IconComp && (
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-slate-700 transition-colors pointer-events-none">
          <IconComp className="h-4 w-4" />
        </span>
      )}
      <Input
        {...rest}
        className={`${IconComp ? 'pl-9' : ''} ${className}`}
      />
    </div>
  )
}

// YearPicker — calendar-style year selector. Clicking the trigger
// reveals a decade grid below; prev/next decade nav at the top;
// future years (after the current year) are disabled because an
// institution can't be "established" in the future. Click outside
// or hit Escape to dismiss.
function YearPicker({ value, onChange, placeholder = 'Pick year' }) {
  const currentYear = new Date().getFullYear()
  const [open, setOpen] = useState(false)
  // The decade currently shown in the popover. Initialised from the
  // selected year (so reopening lands you on the right decade) or
  // current year otherwise.
  const [viewYear, setViewYear] = useState(() => Number(value) || currentYear)
  const containerRef = useRef(null)

  // Whenever the user picks a value, re-anchor the view to that decade
  // on next open. Cheap enough to do unconditionally.
  useEffect(() => {
    if (value) setViewYear(Number(value))
  }, [value])

  // Close on click outside.
  useEffect(() => {
    if (!open) return
    function handleClick(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  // Close on Escape.
  useEffect(() => {
    if (!open) return
    function handleKey(e) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open])

  const decadeStart = Math.floor(viewYear / 10) * 10
  const years = Array.from({ length: 10 }, (_, i) => decadeStart + i)
  const canGoForward = decadeStart + 10 <= currentYear

  return (
    <div className="relative" ref={containerRef}>
      {/* Trigger — looks like the regular Input, with a calendar icon
          on the right and the selected year (or placeholder) inside. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`w-full inline-flex items-center justify-between gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-left transition-colors focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 ${
          open ? 'border-indigo-500 ring-2 ring-indigo-200' : 'hover:border-slate-400'
        }`}
      >
        <span className={value ? 'text-slate-900 tabular-nums' : 'text-slate-400'}>
          {value || placeholder}
        </span>
        <Icon.Calendar className={`h-4 w-4 ${open ? 'text-slate-700' : 'text-slate-400'} transition-colors`} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="absolute z-30 mt-2 w-full min-w-[260px] rounded-xl border border-slate-200 bg-white p-3 shadow-[0_8px_24px_-8px_rgba(15,23,42,0.18)]"
            // The popover anchors to the trigger via min-width; if the
            // input is narrow (sm:grid columns), 260px keeps the grid
            // readable rather than crushing the cells.
          >
            {/* Decade nav: ◀  2020 – 2029  ▶ */}
            <div className="flex items-center justify-between mb-3">
              <button
                type="button"
                onClick={() => setViewYear(viewYear - 10)}
                className="rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900 transition-colors"
                aria-label="Previous decade"
              >
                <Icon.ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-sm font-medium text-slate-700 tabular-nums">
                {decadeStart} – {decadeStart + 9}
              </span>
              <button
                type="button"
                onClick={() => setViewYear(viewYear + 10)}
                disabled={!canGoForward}
                className="rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                aria-label="Next decade"
              >
                <Icon.ChevronRight className="h-4 w-4" />
              </button>
            </div>

            {/* Year grid — 4 columns, 10 cells (the last 2 sit in the
                third row, intentionally). */}
            <div className="grid grid-cols-4 gap-1.5">
              {years.map((y) => {
                const future = y > currentYear
                const selected = String(y) === String(value)
                const isCurrent = y === currentYear
                return (
                  <motion.button
                    key={y}
                    type="button"
                    disabled={future}
                    whileTap={!future ? { scale: 0.95 } : undefined}
                    onClick={() => {
                      onChange(y)
                      setOpen(false)
                    }}
                    className={`rounded-lg px-2 py-2 text-sm font-medium tabular-nums transition-colors ${
                      selected
                        ? 'bg-slate-900 text-white shadow-sm'
                        : future
                        ? 'text-slate-300 cursor-not-allowed'
                        : isCurrent
                        ? 'text-slate-900 ring-1 ring-slate-300 hover:bg-slate-100'
                        : 'text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    {y}
                  </motion.button>
                )
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ─── Step 1 ────────────────────────────────────────────────────────────

function Step1({ form, errors, update, onBlurField, onBack, onNext, submitting }) {
  return (
    <div className="space-y-5">
      {/* Section 1 — Campus address.
          Own card so it visually reads as a distinct block from the
          head-of-institution section below. Both sections now share
          this step's accent — the ICONS already say "place" vs
          "person", so spending a second hue on that distinction was
          buying nothing and cost the form its coherence. */}
      <SectionCard
        icon={Icon.MapPin}
        accent={ACCENTS.section}
        title="Campus address"
        subtitle="Where the institution is physically located."
      >
        <Field label="Address line 1" required error={errors.address_line1}>
          <InputWithIcon
            icon={Icon.MapPin}
            value={form.address_line1}
            onChange={(e) => update('address_line1', e.target.value)}
            placeholder="Building, street, area"
          />
        </Field>
        <Field label="Address line 2">
          <Input
            value={form.address_line2}
            onChange={(e) => update('address_line2', e.target.value)}
            placeholder="Landmark or extra info (optional)"
          />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
          <Field label="State" required error={errors.state}>
            <Select
              value={form.state}
              onChange={(e) => {
                update('state', e.target.value)
                update('city', '')
              }}
              onBlur={() => onBlurField('state')}
              options={[
                { value: '', label: 'Select state' },
                ...INDIAN_STATES.map((s) => ({ value: s, label: s })),
              ]}
            />
          </Field>
          <Field
            label="City"
            required
            error={errors.city}
            help={!form.state ? 'Select a state first' : undefined}
          >
            <Select
              value={form.city}
              onChange={(e) => update('city', e.target.value)}
              onBlur={() => onBlurField('city')}
              disabled={!form.state}
              options={[
                { value: '', label: form.state ? 'Select city' : '—' },
                ...((CITIES_BY_STATE[form.state] || []).map((c) => ({ value: c, label: c }))),
              ]}
            />
          </Field>
          <Field label="District">
            <Input
              value={form.district}
              onChange={(e) => update('district', e.target.value)}
              placeholder="Optional"
            />
          </Field>
        </div>
        <Field label="PIN code" required error={errors.pin_code}>
          <Input
            value={form.pin_code}
            onChange={(e) => update('pin_code', e.target.value.replace(/\D/g, '').slice(0, 6))}
            onBlur={() => onBlurField('pin_code')}
            placeholder="143001"
            inputMode="numeric"
            maxLength={6}
            className="sm:max-w-[200px]"
          />
        </Field>
      </SectionCard>

      {/* Section 2 — Head of institution. Slate chip marks it as the
          subordinate block on this step; the shield icon and the
          callout carry the "this is a person, and it matters" weight. */}
      <SectionCard
        icon={Icon.ShieldCheck}
        accent={ACCENTS.sub}
        title="Head of institution"
        subtitle="We send the activation link to this person after approval."
      >
        <CalloutNote>
          The email below receives a one-time activation link valid for 7 days.
          Make sure it's a mailbox the head actually monitors.
        </CalloutNote>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <Field label="Full name" required error={errors.head_name}>
            <Input
              value={form.head_name}
              onChange={(e) => update('head_name', e.target.value)}
              onBlur={() => onBlurField('head_name')}
              placeholder="Dr. Rajesh Kumar"
            />
          </Field>
          <Field label="Designation" required>
            <Select
              value={form.head_designation}
              onChange={(e) => update('head_designation', e.target.value)}
              options={DESIGNATIONS.map((d) => ({ value: d, label: d }))}
            />
          </Field>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <Field label="Email" required error={errors.head_email}>
            <InputWithIcon
              icon={Icon.Mail}
              type="email"
              value={form.head_email}
              onChange={(e) => update('head_email', e.target.value)}
              onBlur={() => onBlurField('head_email')}
              placeholder="principal@college.ac.in"
            />
          </Field>
          <Field label="Mobile" required error={errors.head_mobile}>
            <InputWithIcon
              icon={Icon.Phone}
              value={form.head_mobile}
              onChange={(e) => update('head_mobile', normaliseIndianMobile(e.target.value))}
              onBlur={() => onBlurField('head_mobile')}
              inputMode="numeric"
              maxLength={14}
              placeholder="9876543210"
            />
          </Field>
        </div>
      </SectionCard>

      {/* Action bar — wrapped in its own card so the visual rhythm
          (3 stacked cards) is consistent with the rest of the step. */}
      <AestheticCard>
        <FooterBar>
          <Button variant="secondary" onClick={onBack} size="lg">
            <Icon.ChevronLeft className="mr-1.5 h-4 w-4" />
            Back
          </Button>
          <span className="text-xs text-slate-500 inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
            Draft saved automatically
          </span>
          <Button onClick={onNext} disabled={submitting} size="lg">
            {submitting ? 'Saving…' : (
              <>Continue<Icon.ChevronRight className="ml-1.5 h-4 w-4" /></>
            )}
          </Button>
        </FooterBar>
      </AestheticCard>
    </div>
  )
}

// ─── SectionCard ───────────────────────────────────────────────────────
// Used by step 1 to break the form into two visually distinct cards
// (address + head). The icon chip is the only place a subtle gradient
// appears in the registration flow — keeps the chrome interesting
// without colouring whole panels.
function SectionCard({ icon: IconComp, accent, title, subtitle, children }) {
  return (
    <AestheticCard>
      <div className="px-6 py-5 border-b border-slate-100 flex items-start gap-3">
        <motion.span
          initial={{ scale: 0.85, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.28, ease: [0.22, 1.2, 0.36, 1] }}
          className={`h-10 w-10 rounded-xl text-white flex items-center justify-center shrink-0 shadow-sm
                      bg-gradient-to-br ${accent || 'from-slate-700 to-slate-900'}`}
        >
          <IconComp className="h-5 w-5" />
        </motion.span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          {subtitle && <p className="text-sm text-slate-500 mt-0.5">{subtitle}</p>}
        </div>
      </div>
      <div className="px-6 py-6 space-y-5">{children}</div>
    </AestheticCard>
  )
}

// CalloutNote — small inline tip box used inside SectionCard bodies
// when the operator needs a heads-up about a specific field group.
function CalloutNote({ children }) {
  return (
    <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-xs text-slate-600 leading-relaxed">
      {children}
    </div>
  )
}

// ─── Step 2: Documents ─────────────────────────────────────────────────

function Step2({ applicationId, uploaded, errors, handleFile, removeDoc, onBack, onSubmit, submitting }) {
  const requiredCount = REQUIRED_DOCS.filter((d) => d.required).length
  const uploadedRequiredCount = REQUIRED_DOCS.filter((d) => d.required && uploaded[d.kind]?.doc_id).length
  return (
    <AestheticCard>
      <div className="px-6 py-5 border-b border-slate-100 flex items-start gap-3">
        <span className="h-10 w-10 rounded-lg bg-indigo-50 text-indigo-700 flex items-center justify-center shrink-0">
          <Icon.Upload className="h-5 w-5" />
        </span>
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-semibold text-slate-900">Upload documents</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            PDF, JPG or PNG — up to 10 MB per file. Application{' '}
            <code className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 text-xs font-mono">
              #{applicationId ?? '—'}
            </code>
          </p>
        </div>
        <Pill tone={uploadedRequiredCount === requiredCount ? 'emerald' : 'amber'}>
          {uploadedRequiredCount} / {requiredCount} required
        </Pill>
      </div>
      <div className="px-6 py-6 space-y-3">
        {REQUIRED_DOCS.map((d) => (
          <DocUploadRow
            key={d.kind}
            kind={d.kind}
            label={d.label}
            hint={d.hint}
            required={d.required}
            state={uploaded[d.kind]}
            error={errors[d.kind]}
            onFile={(f) => handleFile(d.kind, f)}
            onRemove={() => removeDoc(d.kind)}
          />
        ))}
      </div>
      <FooterBar>
        <Button variant="secondary" onClick={onBack} size="lg">
          <Icon.ChevronLeft className="mr-1.5 h-4 w-4" />
          Back
        </Button>
        {/* Goes to the Review step, not to submit — the label has to say
            so, or the applicant braces for a commit that isn't happening
            yet. `success` variant dropped for the same reason: green
            reads as "this is the final action". */}
        <Button onClick={onSubmit} size="lg">
          Review application
          <Icon.ChevronRight className="ml-1.5 h-4 w-4" />
        </Button>
      </FooterBar>
    </AestheticCard>
  )
}

function DocUploadRow({ kind, label, hint, required, state, error, onFile, onRemove }) {
  const inputId = `file_${kind}`
  const uploading = state?.uploading
  const done = state?.doc_id && !uploading

  return (
    <motion.div
      layout
      className={`rounded-xl border p-4 transition-colors ${
        done
          ? 'border-emerald-200 bg-emerald-50/40'
          : error
          ? 'border-rose-300 bg-rose-50/40'
          : 'border-slate-200 hover:border-slate-300 bg-white'
      }`}
    >
      <div className="flex items-start gap-4">
        <motion.span
          initial={false}
          animate={done ? { scale: [1, 1.12, 1] } : { scale: 1 }}
          transition={{ duration: 0.32, ease: 'easeOut' }}
          className={`h-10 w-10 rounded-xl flex items-center justify-center shrink-0 ring-1 ${
            done
              ? 'bg-emerald-50 text-emerald-600 ring-emerald-200'
              : 'bg-slate-100 text-slate-500 ring-slate-200'
          }`}
        >
          {done ? <Icon.Check className="h-5 w-5" /> : <Icon.FileText className="h-5 w-5" />}
        </motion.span>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <p className="text-sm font-medium text-slate-900">{label}</p>
            {required && (
              <span className="text-xs text-rose-600 font-medium">required</span>
            )}
          </div>
          {hint && <p className="text-xs text-slate-500 mt-0.5">{hint}</p>}
          {state?.original_name && (
            <p className="mt-2 text-xs text-slate-700 truncate">
              <span className="font-mono">{state.original_name}</span>
              {state.size_bytes ? ` · ${(state.size_bytes / 1024).toFixed(0)} KB` : ''}
            </p>
          )}
          {uploading && (
            <div className="mt-2 h-1.5 w-full bg-slate-200 rounded-full overflow-hidden">
              <motion.div
                className="h-full bg-slate-900 rounded-full"
                initial={false}
                animate={{ width: `${state.progress || 0}%` }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
              />
            </div>
          )}
          {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}
        </div>
        <div className="shrink-0">
          {done ? (
            <Button variant="secondary" size="sm" onClick={onRemove}>
              <Icon.Trash className="h-4 w-4 mr-1" />
              Remove
            </Button>
          ) : (
            <>
              <input
                id={inputId}
                type="file"
                accept="application/pdf,image/jpeg,image/png"
                className="hidden"
                onChange={(e) => onFile(e.target.files?.[0])}
                disabled={uploading}
              />
              <label htmlFor={inputId}>
                <span
                  className={`inline-flex items-center gap-1.5 rounded-lg font-medium text-sm px-3 py-1.5 transition cursor-pointer ${
                    uploading
                      ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                      : 'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  <Icon.Upload className="h-4 w-4" />
                  {uploading ? 'Uploading…' : 'Choose file'}
                </span>
              </label>
            </>
          )}
        </div>
      </div>
    </motion.div>
  )
}

// ─── Step 3: Done ──────────────────────────────────────────────────────

function DonePanel({ applicationId, email, institutionName, onStartOver, onHome }) {
  return (
    <AestheticCard>
      <div className="px-6 py-12 text-center">
        <motion.div
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.45, ease: [0.22, 1.5, 0.36, 1] }}
          className="mx-auto h-16 w-16 rounded-full bg-slate-900 text-white flex items-center justify-center shadow-sm"
        >
          <Icon.Check className="h-8 w-8" />
        </motion.div>
        <h2 className="mt-5 text-2xl font-semibold text-slate-900">
          Submitted!
        </h2>
        <p className="mt-2 text-sm text-slate-600 max-w-md mx-auto leading-relaxed">
          Your application for <strong className="text-slate-900">{institutionName}</strong> is now under review.
          Our team typically responds within 48 hours to{' '}
          <strong className="text-slate-900">{email}</strong>.
        </p>
        <div className="mt-5 inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">
          <Icon.Clock className="h-3.5 w-3.5" />
          Reference: <code className="font-mono">#{applicationId}</code>
        </div>
        <div className="mt-8 flex items-center justify-center gap-3 flex-wrap">
          <Button variant="secondary" onClick={onStartOver}>Register another</Button>
          <Button onClick={onHome}>Back to home</Button>
        </div>
      </div>
    </AestheticCard>
  )
}

// ─── Helpers ───────────────────────────────────────────────────────────

function Field({ label, required, error, help, className = '', children }) {
  return (
    <div className={className}>
      <Label>
        {label}
        {required && <span className="text-rose-600 ml-0.5" aria-label="required">*</span>}
      </Label>
      {children}
      {error && <p className="mt-1 text-xs text-rose-600">{error}</p>}
      {!error && help && <p className="mt-1 text-xs text-slate-500">{help}</p>}
    </div>
  )
}

function Select({ value, onChange, options, disabled = false, onBlur }) {
  return (
    <select
      value={value}
      onChange={onChange}
      onBlur={onBlur}
      disabled={disabled}
      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:bg-slate-100 disabled:text-slate-400 disabled:cursor-not-allowed"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  )
}

function FooterBar({ children }) {
  return (
    <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex items-center justify-between gap-3">
      {children}
    </div>
  )
}
