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
  checkRegistrationIdentifiers,
  registerInit,
  uploadDoc,
  submitApplication,
  // Draft persistence removed 2026-08-24 — the wizard now holds all
  // state (fields, OTP proofs, File objects) in React memory only,
  // and the DB is only written to on final Submit. `deleteDoc` also
  // dropped — no server-side doc to delete pre-submit any more.
} from '../../lib/onboarding/register.js'
import OtpVerificationField from '../../components/ui/OtpVerificationField.jsx'
import {
  sendEmailOTP,
  verifyEmailOTP,
  sendSmsOTP,
  verifySmsOTP,
} from '../../lib/otp/api.js'

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
    blurb: 'Degree college or institute',
  },
  {
    value: 'university',
    label: 'University',
    blurb: 'Central, state, deemed, or private university',
  },
  {
    value: 'other',
    label: 'Govt Commission / Recruitment Body',
    blurb: 'PSUs, commissions, & hiring agencies',
  },
]

const AFFILIATION_BODIES = [
  'UGC', 'AICTE', 'CBSE', 'ICSE', 'State Board',
  'Deemed University', 'Autonomous', 'Other',
]

const RECRUITMENT_SECTORS = [
  'Central Government Commission / Ministry',
  'State Public Service Commission (State PSC)',
  'Public Sector Undertaking (PSU)',
  'Banking / Financial Institution',
  'Autonomous Recruitment Board / Agency',
  'Corporate Employer',
  'Other',
]

const ACADEMIC_DESIGNATIONS = [
  'Principal', 'Director', 'Registrar',
  'Vice-Chancellor', 'Dean', 'Owner', 'Trustee',
]

const RECRUITER_DESIGNATIONS = [
  'Controller of Examinations',
  'Secretary / Under Secretary',
  'Director (Recruitment / Personnel)',
  'General Manager (HR)',
  'Head of Human Resources / CHRO',
  'Nodal Verification Officer',
  'Verification Lead',
]

const DESIGNATIONS = [...ACADEMIC_DESIGNATIONS, ...RECRUITER_DESIGNATIONS]

const REQUIRED_DOCS_ACADEMIC = [
  { kind: 'recognition_letter',   label: 'Recognition letter',  hint: 'From UGC / AICTE / state education board', required: true },
  { kind: 'pan_card',             label: 'PAN / TAN card scan', hint: 'Of the institution / parent trust (PAN or TAN)', required: true },
  { kind: 'authorization_letter', label: 'Authorization letter', hint: 'On letterhead, signed by the head',         required: true },
  { kind: 'naac_certificate',     label: 'NAAC / NBA certificate', hint: 'Optional — strengthens your application', required: false },
]

const REQUIRED_DOCS_RECRUITMENT = [
  { kind: 'recognition_letter',   label: 'Gazette / Establishment / Mandate Proof',  hint: 'Gazette notification, Act reference, or Certificate of Incorporation', required: true },
  { kind: 'pan_card',             label: 'Organization PAN / TAN scan',       hint: 'Copy of Organization PAN or TAN card',         required: true },
  { kind: 'authorization_letter', label: 'Nodal Officer Authorization Letter', hint: 'On official letterhead, signed by Director / Secretary / Head of HR', required: true },
]

function getRequiredDocs(form) {
  return form?.institution_type === 'other' ? REQUIRED_DOCS_RECRUITMENT : REQUIRED_DOCS_ACADEMIC
}

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
// acceptable. `form` is passed for rules that depend on sibling/dynamic fields.
const FIELD_RULES = {
  institution_name: (v, form) =>
    v.trim().length < 3
      ? (form?.institution_type === 'other' ? 'Required (at least 3 characters)' : 'Required (at least 3 characters)')
      : undefined,
  institution_type: (v) =>
    INSTITUTION_TYPES.find((t) => t.value === v) ? undefined : 'Pick a type',
  institution_type_other: () => undefined,
  aishe_code: (v, form) => {
    if (!v.trim()) {
      return form?.institution_type === 'other' ? 'Required (Govt Ref / Notification / CIN)' : 'Required (AISHE code)'
    }
    return undefined
  },
  pan: (v) => {
    if (!v.trim()) return 'Required'
    const clean = v.trim().toUpperCase()
    const isPan = /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(clean)
    const isTan = /^[A-Z]{4}[0-9]{5}[A-Z]$/.test(clean)
    return (isPan || isTan) ? undefined : 'Format: PAN (ABCDE1234F) or TAN (ABCD12345E)'
  },
  year_established: (v) => {
    const year = Number(v)
    if (!v || !year) return 'Required'
    const now = new Date().getFullYear()
    return year < 1800 || year > now ? `Must be between 1800 and ${now}` : undefined
  },
  affiliation_body: (v, form) => {
    if (!v) {
      return form?.institution_type === 'other' ? 'Please select organization sector' : 'Required'
    }
    return undefined
  },
  affiliation_body_other: (v, form) =>
    form?.affiliation_body === 'Other' && !v.trim() ? 'Please specify' : undefined,
  approx_student_count: (v, form) => {
    if (form?.institution_type === 'other') return undefined
    const n = Number(v)
    if (!v || !n) return 'Required'
    return n < 1 || n > 10_000_000 ? 'Must be a positive number' : undefined
  },
  address_line1: (v) => (!v.trim() ? 'Required' : undefined),
  district: (v) => (!v.trim() ? 'Required' : undefined),
  state: (v) => (!v.trim() ? 'Required' : undefined),
  pin_code: (v) => (/^[0-9]{6}$/.test(v.trim()) ? undefined : 'PIN must be 6 digits'),
  head_name: (v, form) =>
    v.trim().length < 2 ? (form?.institution_type === 'other' ? 'Nodal officer name required' : 'Required') : undefined,
  head_email: (v) =>
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? undefined : 'Invalid email',
  head_mobile: (v) => {
    // Indian mobile format:
    //   - 10 digits total
    //   - first digit must be 6, 7, 8 or 9 (TRAI mobile ranges)
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
    'institution_name', 'institution_type', 'institution_type_other', 'aishe_code', 'pan',
    'year_established', 'affiliation_body', 'affiliation_body_other',
    'approx_student_count',
  ],
  ['address_line1', 'district', 'state', 'pin_code', 'head_name', 'head_email', 'head_mobile'],
]

const EMPTY_FORM = {
  // Which exam board (client) will review this KYC. Optional — when
  // omitted the application lands in the legacy superadmin queue.
  // Prefilled from ?client_id= in the URL so a client can hand out
  // their own dedicated registration link.
  client_id: '',
  institution_name: '',
  institution_type: 'college',
  institution_type_other: '', // free text when institution_type === 'other'
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
  const [emailOtpToken, setEmailOtpToken] = useState('')
  const [mobileOtpToken, setMobileOtpToken] = useState('')
  const [checkingStep0, setCheckingStep0] = useState(false)

  // Draft persistence removed 2026-08-24 — nothing hits localStorage
  // any more. Refreshing the tab now clears the wizard entirely,
  // which is by design: it keeps OTP proof tokens off disk, avoids
  // stale-app_id pitfalls when the server DB is wiped between
  // sessions, and matches the "only write to DB on final Submit"
  // policy that Submit now enforces end-to-end.

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }))
    if (field === 'head_email' && value !== form.head_email) {
      setEmailOtpToken('')
    }
    if (field === 'head_mobile' && value !== form.head_mobile) {
      setMobileOtpToken('')
    }
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
  async function validateOnBlur(field) {
    const raw = form[field]
    if (raw === undefined || String(raw).trim() === '') return
    const msg = FIELD_RULES[field]?.(String(raw), form)
    if (msg) {
      setErrors((e) => ({ ...e, [field]: msg }))
      return
    }
    setErrors((e) => {
      if (!e[field]) return e
      const { [field]: _drop, ...rest } = e
      return rest
    })

    // Instant async pre-check for AISHE code or PAN/TAN uniqueness
    if (field === 'aishe_code' || field === 'pan') {
      try {
        const payload = field === 'aishe_code'
          ? { aishe_code: String(raw).trim() }
          : { pan: String(raw).trim().toUpperCase() }
        const res = await checkRegistrationIdentifiers(payload)
        if (field === 'aishe_code' && res?.aishe_code && !res.aishe_code.available) {
          setErrors((e) => ({ ...e, aishe_code: res.aishe_code.reason }))
        }
        if (field === 'pan' && res?.pan && !res.pan.available) {
          setErrors((e) => ({ ...e, pan: res.pan.reason }))
        }
      } catch {}
    }
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

  // goToStep1: identifier pre-check (rahul-FE) — hits the read-only
  // /register/check endpoint to catch duplicate AISHE / PAN early so
  // the operator sees the collision at Step 0 instead of after
  // typing every field and hitting Submit. Read-only; compatible
  // with the "no DB writes until final Submit" policy.
  async function goToStep1() {
    if (!validateStep(S_INSTITUTION)) return
    setCheckingStep0(true)
    setTopError('')
    try {
      const res = await checkRegistrationIdentifiers({
        aishe_code: form.aishe_code.trim(),
        pan: form.pan.trim().toUpperCase(),
      })
      const errs = {}
      if (res?.aishe_code && !res.aishe_code.available) {
        errs.aishe_code = res.aishe_code.reason
      }
      if (res?.pan && !res.pan.available) {
        errs.pan = res.pan.reason
      }
      if (Object.keys(errs).length > 0) {
        setErrors((prev) => ({ ...prev, ...errs }))
        setTopError('This institution or identifier is already registered or under review.')
        return
      }
      setStep(S_ADDRESS)
    } catch {
      // If the pre-check endpoint itself errors, don't block the
      // operator — server-side uniqueness at final Submit still catches.
      setStep(S_ADDRESS)
    } finally {
      setCheckingStep0(false)
    }
  }

  // buildRegisterPayload composes the create-application body. Extracted
  // so the (now-single) call site in submit() reads cleanly. Contains
  // no side effects — the actual /register/init HTTP call happens in
  // submit() per the "defer all DB writes to Submit" refactor
  // (2026-08-23). Rahul's earlier initApplicationDraft() called
  // registerInit here; dropped on merge because that's the exact
  // behavior we intentionally moved.
  function buildRegisterPayload() {
    const affiliation = form.affiliation_body === 'Other'
      ? form.affiliation_body_other.trim()
      : form.affiliation_body
    const institutionType = form.institution_type === 'other'
      ? (form.institution_type_other.trim() || 'other')
      : form.institution_type
    const district = (form.district || '').trim()
    const city = (form.city || '').trim() || district
    const payload = {
      ...form,
      district,
      city,
      institution_type: institutionType,
      affiliation_body: affiliation,
      year_established: Number(form.year_established) || 0,
      approx_student_count: Number(form.approx_student_count) || 0,
      expected_centres: Number(form.expected_centres) || 1,
      email_otp_token: emailOtpToken,
      mobile_otp_token: mobileOtpToken,
      client_id: form.client_id ? Number(form.client_id) : undefined,
    }
    delete payload.affiliation_body_other
    delete payload.institution_type_other
    delete payload.website
    if (!payload.client_id) delete payload.client_id
    return payload
  }

  async function goToStep2() {
    if (!validateStep(S_ADDRESS)) return

    if (!emailOtpToken) {
      setTopError('Please verify the Head of Institution Email address via OTP before continuing.')
      return
    }
    if (!mobileOtpToken) {
      setTopError('Please verify the Head of Institution Mobile number via OTP before continuing.')
      return
    }

    // No DB write here any more — registerInit is deferred until
    // Submit. Advance straight to the Documents step; docs are held
    // as File objects in state until the final Submit orchestrates
    // create-app + upload-all + finalize as one atomic sequence.
    setTopError('')
    setStep(S_DOCUMENTS)
  }

  // Stash the File in React state — no server call. The actual
  // upload runs during Submit as part of the create-app + upload-all
  // + finalize sequence.
  function handleFile(docKind, file) {
    if (!file) return
    if (file.size > 10 * 1024 * 1024) {
      setErrors((e) => ({ ...e, [docKind]: 'File exceeds 10 MB limit' }))
      return
    }
    setErrors((e) => ({ ...e, [docKind]: undefined }))
    setUploaded((u) => ({
      ...u,
      [docKind]: {
        file,                       // held in memory; sent on Submit
        original_name: file.name,
        size_bytes: file.size,
      },
    }))
  }

  // Client-only remove — no server call any more; the doc never
  // existed server-side yet.
  function removeDoc(docKind) {
    setUploaded((prev) => {
      const { [docKind]: _, ...rest } = prev
      return rest
    })
  }

  // Documents → Review. The required-doc gate now checks the in-memory
  // File presence instead of a server-issued doc_id.
  function goToReview() {
    const activeDocs = getRequiredDocs(form)
    const missing = activeDocs.filter((d) => d.required && !uploaded[d.kind]?.file)
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
    const activeDocs = getRequiredDocs(form)
    const missing = activeDocs.filter((d) => d.required && !uploaded[d.kind]?.file)
    if (missing.length) {
      setTopError('Please upload: ' + missing.map((d) => d.label).join(', '))
      setStep(S_DOCUMENTS)
      return
    }
    setSubmitting(true)
    setTopError('')
    try {
      const initRes = await registerInit(buildRegisterPayload())
      const newAppId = Number(initRes?.application_id)
      if (!newAppId || isNaN(newAppId) || newAppId <= 0) {
        throw new Error(initRes?.error || 'Could not initialize registration. Please re-verify your OTPs and try again.')
      }
      setApplicationId(newAppId)

      const entries = Object.entries(uploaded).filter(([_, u]) => u?.file)
      for (const [kind, u] of entries) {
        await uploadDoc(newAppId, kind, u.file)
      }

      await submitApplication(newAppId)
      setStep(S_DONE)
    } catch (err) {
      setTopError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  function startOver() {
    setForm(EMPTY_FORM)
    setApplicationId(null)
    setUploaded({})
    setEmailOtpToken('')
    setMobileOtpToken('')
    setStep(S_INSTITUTION)
    setTopError('')
  }

  // Picker handler for the Step 0 institution-type tiles.
  //
  // Cross-branch changes (academic ↔ non-academic) invalidate the
  // whole form because the fields required + their semantics shift
  // wholesale: aishe_code ↔ establishment reference, affiliation
  // ↔ parent ministry, student_count meaning, designation
  // vocabulary, required doc set. Keeping half-filled academic
  // values around after the applicant re-declares as a recruitment
  // body would produce garbage. Prompt-and-reset instead.
  //
  // Within-branch swaps (college ↔ university) share the same
  // field set; carry values over as before, only touching
  // institution_type_other + designation to keep them consistent.
  function onTypeSelect(newType) {
    const oldType = form.institution_type
    if (oldType === newType) return

    const wasAcademic = oldType === 'college' || oldType === 'university'
    const nowAcademic = newType === 'college' || newType === 'university'
    const crossBranch = wasAcademic !== nowAcademic

    if (crossBranch) {
      const hasData = (
        form.institution_name || form.aishe_code || form.pan ||
        form.head_name || form.head_email || form.head_mobile ||
        Object.keys(uploaded).length > 0
      )
      if (hasData && !window.confirm(
        'Changing the organisation type will reset the form — the fields required are different. Continue?'
      )) {
        return
      }
      setForm({ ...EMPTY_FORM, institution_type: newType })
      setUploaded({})
      setEmailOtpToken('')
      setMobileOtpToken('')
      setErrors({})
      setTopError('')
      return
    }

    // Within-branch: preserve fields, just swap type + touch-ups.
    update('institution_type', newType)
    if (newType !== 'other') {
      update('institution_type_other', '')
      if (RECRUITER_DESIGNATIONS.includes(form.head_designation)) {
        update('head_designation', 'Principal')
      }
    } else {
      if (ACADEMIC_DESIGNATIONS.includes(form.head_designation)) {
        update('head_designation', 'Nodal Verification Officer')
      }
    }
  }

  return (
    <div className="min-h-screen relative bg-warm-page overflow-hidden">
      {/* Ambient background — warm golden/amber washes + fine warm grid overlay. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden"
      >
        {/* soft warm grid */}
        <div
          className="absolute inset-0 opacity-[0.35]"
          style={{
            backgroundImage:
              'linear-gradient(to right, rgb(216 203 176 / 0.45) 1px, transparent 1px), linear-gradient(to bottom, rgb(216 203 176 / 0.45) 1px, transparent 1px)',
            backgroundSize: '48px 48px',
            maskImage: 'radial-gradient(ellipse at top, black 40%, transparent 75%)',
            WebkitMaskImage: 'radial-gradient(ellipse at top, black 40%, transparent 75%)',
          }}
        />
        {/* Warm amber / parchment ambient glows */}
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 1.2, ease: 'easeOut' }}
          className="absolute -top-40 -left-24 h-[28rem] w-[28rem] rounded-full bg-brand-100/45 blur-[100px]"
        />
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 1.2, delay: 0.1, ease: 'easeOut' }}
          className="absolute -top-24 right-[-6rem] h-[26rem] w-[26rem] rounded-full bg-[#ECF0F5]/70 blur-[100px]"
        />
      </div>

      <PortalHeader
        right={
          <Link
            to="/admin/login"
            className="inline-flex items-center gap-2 rounded-lg px-3.5 py-2
                       text-sm font-semibold text-slate-200 hover:text-white
                       bg-white/8 hover:bg-white/16 ring-1 ring-inset ring-white/15
                       transition-colors focus-visible:outline-2
                       focus-visible:outline-offset-2 focus-visible:outline-amber-300"
          >
            <Icon.ChevronLeft className="h-4 w-4" />
            Back to sign in
          </Link>
        }
      />

      <main className="relative mx-auto max-w-6xl px-4 sm:px-6 pt-8 pb-16">
        <div className="mb-6">
          <motion.h1
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: 'easeOut' }}
            className="text-3xl sm:text-4xl lg:text-[2.65rem] font-bold tracking-tight text-ink-900 leading-tight"
          >
            {step === S_DONE
              ? 'Application received'
              : (
                <>
                  Register your{' '}
                  <span className="text-gold-display">
                    institution
                  </span>
                </>
              )}
          </motion.h1>
          {step !== S_DONE && (
            <p className="mt-2 text-sm sm:text-base text-stone-600 max-w-2xl leading-relaxed">
              Complete the secure 4-step accreditation profile to establish your institution's biometric verification registry.
            </p>
          )}
        </div>

        {topError && (
          <div className="mt-4 rounded-xl bg-rose-50 border border-rose-200/80 px-4 py-3 text-sm text-rose-800 flex items-start gap-2.5 shadow-2xs">
            <Icon.X className="h-5 w-5 text-rose-600 shrink-0 mt-0.5" />
            <span className="font-medium">{topError}</span>
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
            <StepSidebar step={step} form={form} />
            <div className="min-w-0">
              <AnimatePresence mode="wait" initial={false}>
                <SlideStep key={step}>
                  {step === S_INSTITUTION && (
                    <Step0
                      form={form}
                      errors={errors}
                      update={update}
                      onBlurField={validateOnBlur}
                      onNext={goToStep1}
                      onTypeSelect={onTypeSelect}
                      checking={checkingStep0}
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
                      emailOtpToken={emailOtpToken}
                      setEmailOtpToken={setEmailOtpToken}
                      mobileOtpToken={mobileOtpToken}
                      setMobileOtpToken={setMobileOtpToken}
                    />
                  )}
                  {step === S_DOCUMENTS && (
                    <Step2
                      form={form}
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

function StepSidebar({ step, form }) {
  return (
    <aside className="lg:sticky lg:top-6 lg:self-start">
      <div className="rounded-2xl border border-warm bg-warm-surface shadow-xs p-3.5 overflow-hidden">
        <div className="px-3 pt-2 pb-3 mb-1 border-b border-warm flex items-center justify-between">
          <span className="text-[11px] font-bold uppercase tracking-wider text-stone-400">Onboarding Steps</span>
          <span className="text-xs font-semibold text-brand-800 bg-brand-50 border border-brand-100 px-2 py-0.5 rounded-md font-mono">
            {step + 1} / 4
          </span>
        </div>
        <ol className="space-y-1.5 mt-2">
          {STEPS.slice(0, 4).map((s, i) => {
            const active = i === step
            const done = i < step
            const IconComp = s.icon
            const stepNum = `0${i + 1}`
            return (
              <li key={s.label}>
                <motion.div
                  layout
                  className={`flex items-center gap-3.5 rounded-xl px-3.5 py-3 transition-all ${
                    active
                      ? 'bg-ink-600 text-white shadow-sm'
                      : done
                      ? 'bg-emerald-50/70 hover:bg-emerald-50 text-emerald-950 border border-emerald-200/60'
                      : 'bg-transparent text-stone-600 hover:bg-[#ECF0F5]/40'
                  }`}
                >
                  <motion.span
                    initial={false}
                    animate={{ scale: active ? 1.05 : 1 }}
                    transition={{ duration: 0.2 }}
                    className={`h-9 w-9 rounded-xl flex items-center justify-center shrink-0 ${
                      active
                        ? 'bg-white/15 text-white'
                        : done
                        ? 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200/80'
                        : 'bg-[#ECF0F5] text-stone-600 font-mono text-xs font-semibold border border-warm'
                    }`}
                  >
                    {done ? <Icon.Check className="h-4 w-4" /> : active ? <IconComp className="h-4 w-4" /> : stepNum}
                  </motion.span>
                  <div className="min-w-0 flex-1">
                    <p
                      className={`text-sm font-semibold leading-tight ${
                        active ? 'text-white' : done ? 'text-emerald-900' : 'text-slate-800'
                      }`}
                    >
                      {s.label}
                    </p>
                    <p className={`text-[11px] mt-0.5 ${
                      active ? 'text-slate-300' : done ? 'text-emerald-700 font-medium' : 'text-slate-400'
                    }`}>
                      {done ? 'Completed' : active ? 'In progress' : 'Pending'}
                    </p>
                  </div>
                  {active && (
                    <motion.span
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      className="h-2 w-2 rounded-full bg-emerald-400 shrink-0 shadow-[0_0_8px_rgba(52,211,153,0.8)]"
                      aria-label="current step"
                    />
                  )}
                </motion.div>
              </li>
            )
          })}
        </ol>
      </div>

      <PrepPanel form={form} />
    </aside>
  )
}

// PrepPanel — "have these ready before you start". Mirrors exactly what
// step 3 will ask for, and re-renders when the applicant changes
// category, because a recruitment body is asked for a gazette where a
// college is asked for a recognition letter.
function PrepPanel({ form }) {
  const docs = getRequiredDocs(form)
  const required = docs.filter((d) => d.required !== false)
  const optional = docs.filter((d) => d.required === false)

  return (
    <div className="mt-4 rounded-2xl border border-slate-200 bg-white shadow-xs overflow-hidden">
      <div className="px-4 pt-3.5 pb-3 border-b border-slate-200">
        <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500">
          Before you start
        </p>
      </div>

      <div className="px-4 py-3.5">
        <p className="text-[11px] font-semibold text-slate-700 mb-2.5">
          Scans you&rsquo;ll upload at step 3
        </p>
        <ul className="space-y-2">
          {required.map((d) => (
            <li key={d.kind} className="flex gap-2.5">
              <Icon.File className="h-3.5 w-3.5 text-slate-400 shrink-0 mt-[3px]" />
              <span className="text-[12px] leading-snug text-slate-700">{d.label}</span>
            </li>
          ))}
          {optional.map((d) => (
            <li key={d.kind} className="flex gap-2.5">
              <Icon.File className="h-3.5 w-3.5 text-slate-300 shrink-0 mt-[3px]" />
              <span className="text-[12px] leading-snug text-slate-500">
                {d.label}
                <span className="text-slate-400"> &middot; optional</span>
              </span>
            </li>
          ))}
        </ul>

        <div className="mt-4 pt-3.5 border-t border-slate-100 space-y-2">
          <p className="flex items-center gap-2 text-[11.5px] text-slate-600">
            <Icon.Clock className="h-3.5 w-3.5 text-slate-400 shrink-0" />
            About 10 minutes to complete
          </p>
          <p className="flex items-start gap-2 text-[11.5px] text-amber-800">
            <Icon.AlertCircle className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-[1px]" />
            <span>Complete in one sitting &mdash; refreshing the page clears the form.</span>
          </p>
        </div>
      </div>
    </div>
  )
}

// ─── Step 0 ────────────────────────────────────────────────────────────

function Step0({ form, errors, update, onBlurField, onNext, onTypeSelect, checking = false }) {
  const isRecruiter = form.institution_type === 'other'

  return (
    <AestheticCard>
      {/* Header with warm icon and border */}
      <div className="px-7 py-5 border-b border-warm flex items-center gap-3.5">
        <span className="h-11 w-11 rounded-xl bg-brand-50 text-brand-700 border border-brand-100 flex items-center justify-center shrink-0">
          <Icon.Building className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-ink-900">
            {isRecruiter ? 'Organization details' : 'Institution details'}
          </h2>
          <p className="text-sm text-stone-500 mt-0.5">
            {isRecruiter
              ? 'Category, government identifiers, and recruitment sector.'
              : 'Type, identifiers, and history of your institution.'}
          </p>
        </div>
      </div>

      <div className="px-7 py-7 space-y-7">
        <div>
          <Label className="font-semibold text-slate-900">
            Organization Category <span className="text-rose-600 ml-0.5">*</span>
          </Label>
          {/* items-stretch + h-full on the card: the three options are one
              radio group, so an option with a longer blurb must not make
              its card taller than the two beside it. */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-4xl items-stretch">
            {INSTITUTION_TYPES.map((t) => {
              const iconMap = {
                college: Icon.Building,
                university: Icon.ShieldCheck,
                other: Icon.FileText,
              }
              const IconComp = iconMap[t.value] || Icon.Building
              return (
                <CompactChoice
                  key={t.value}
                  selected={form.institution_type === t.value}
                  onSelect={() => onTypeSelect(t.value)}
                  icon={IconComp}
                  label={t.label}
                  blurb={t.blurb}
                />
              )
            })}
          </div>
          {errors.institution_type && (
            <p className="mt-1.5 text-xs text-rose-600 font-medium">{errors.institution_type}</p>
          )}
        </div>

        <Divider label="Identifiers & history" />

        <div className="grid grid-cols-1 sm:grid-cols-6 gap-x-6 gap-y-5">
          <Field
            className="sm:col-span-6"
            label={isRecruiter ? 'Organization / Commission name' : 'Institution name'}
            required
            error={errors.institution_name}
          >
            <Input
              value={form.institution_name}
              onChange={(e) => update('institution_name', e.target.value)}
              onBlur={() => onBlurField('institution_name')}
              placeholder={isRecruiter ? 'e.g. Staff Selection Commission (SSC) / ONGC / State PSC' : 'e.g. Saragarhi Memorial College of Eminence'}
            />
          </Field>
          <Field
            className="sm:col-span-2"
            label={isRecruiter ? 'Govt Gazette / Ref / CIN' : 'AISHE code'}
            required
            error={errors.aishe_code}
          >
            <InputWithIcon
              icon={isRecruiter ? Icon.FileText : Icon.ShieldCheck}
              value={form.aishe_code}
              onChange={(e) => update('aishe_code', e.target.value)}
              onBlur={() => onBlurField('aishe_code')}
              placeholder={isRecruiter ? 'e.g. Gazette No. / Act Ref / CIN' : 'C-12345'}
            />
          </Field>
          <Field
            className="sm:col-span-2"
            label={isRecruiter ? 'Organization PAN / TAN' : 'PAN / TAN'}
            required
            error={errors.pan}
          >
            <InputWithIcon
              icon={Icon.File}
              value={form.pan}
              onChange={(e) => update('pan', e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10))}
              onBlur={() => onBlurField('pan')}
              placeholder={isRecruiter ? 'PAN/TAN (e.g. ABCD12345E)' : 'e.g. ABCDE1234F / ABCD12345E'}
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
          <Field
            className={isRecruiter ? 'sm:col-span-6' : 'sm:col-span-4'}
            label={isRecruiter ? 'Sector / Category' : 'Affiliation body'}
            required
            error={errors.affiliation_body}
          >
            <Select
              value={form.affiliation_body}
              onChange={(e) => update('affiliation_body', e.target.value)}
              options={[
                { value: '', label: '— Pick one —' },
                ...(isRecruiter ? RECRUITMENT_SECTORS : AFFILIATION_BODIES).map((b) => ({ value: b, label: b })),
              ]}
            />
            {form.affiliation_body === 'Other' && (
              <div className="mt-2">
                <Input
                  value={form.affiliation_body_other}
                  onChange={(e) => update('affiliation_body_other', e.target.value)}
                  onBlur={() => onBlurField('affiliation_body_other')}
                  placeholder={isRecruiter ? 'Specify sector / category' : 'Specify affiliation body'}
                  maxLength={80}
                />
                {errors.affiliation_body_other && (
                  <p className="mt-1.5 text-xs text-rose-600 font-medium">{errors.affiliation_body_other}</p>
                )}
              </div>
            )}
          </Field>
          {!isRecruiter && (
            <Field
              className="sm:col-span-2"
              label="Student count"
              required
              error={errors.approx_student_count}
            >
              <Input
                type="number"
                value={form.approx_student_count}
                onChange={(e) => update('approx_student_count', e.target.value)}
                onBlur={() => onBlurField('approx_student_count')}
                placeholder="500"
              />
            </Field>
          )}
        </div>
      </div>

      <FooterBar>
        <span className="text-xs text-stone-500">
          Required fields marked with <span className="text-rose-600 font-semibold">*</span>
        </span>
        <Button onClick={onNext} disabled={checking} size="lg">
          {checking ? 'Checking availability…' : 'Continue'}
          {!checking && <Icon.ChevronRight className="ml-1.5 h-4 w-4" />}
        </Button>
      </FooterBar>
    </AestheticCard>
  )
}

function CompactChoice({ selected, onSelect, icon: IconComp, label, blurb }) {
  return (
    <motion.button
      type="button"
      onClick={onSelect}
      whileHover={{ y: -1.5, transition: { duration: 0.15 } }}
      whileTap={{ scale: 0.98 }}
      className={`relative h-full text-left px-5 py-4 rounded-xl border transition-all ${
        selected
          ? 'border-brand-600 bg-brand-50 ring-2 ring-brand-500/25 shadow-xs'
          : 'border-slate-200 bg-white hover:border-slate-300 hover:shadow-xs'
      }`}
    >
      <div className="flex items-start gap-3 h-full">
        <span
          className={`h-10 w-10 rounded-lg flex items-center justify-center shrink-0 transition-all ${
            selected ? 'bg-brand-600 text-white shadow-xs' : 'bg-slate-100 text-slate-600 border border-slate-200'
          }`}
        >
          {IconComp && <IconComp className="h-4 w-4" />}
        </span>
        <div className="min-w-0 flex-1 pr-6">
          <p className={`text-sm font-bold tracking-tight leading-snug text-balance ${selected ? 'text-brand-900' : 'text-slate-900'}`}>
            {label}
          </p>
          {blurb ? (
            <p className={`text-xs leading-snug mt-1 ${selected ? 'text-brand-700' : 'text-slate-500'}`}>
              {blurb}
            </p>
          ) : null}
        </div>
      </div>
      {selected && (
        <motion.span
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ duration: 0.15, ease: [0.22, 1.5, 0.36, 1] }}
          className="absolute right-3 top-3 h-4 w-4 rounded-full bg-brand-600 text-white flex items-center justify-center shadow-xs"
        >
          <Icon.Check className="h-2.5 w-2.5 stroke-[2.5]" />
        </motion.span>
      )}
    </motion.button>
  )
}

// ─── New visual primitives used by Step 0 ──────────────────────────────

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
  const isRecruiter = form.institution_type === 'other'
  const affiliation =
    form.affiliation_body === 'Other'
      ? form.affiliation_body_other
      : form.affiliation_body

  const typeLabel =
    INSTITUTION_TYPES.find((t) => t.value === form.institution_type)?.label || form.institution_type

  const address = [
    form.address_line1,
    form.address_line2,
    [form.city, form.district].filter(Boolean).join(', '),
    [form.state, form.pin_code].filter(Boolean).join(' — '),
  ].filter((l) => l && l.trim())

  const activeDocs = getRequiredDocs(form)
  // Files live in memory until Submit (the "defer all DB writes to
  // Submit" flow), so key off `.file` (or `.doc_id` if present).
  const docs = activeDocs.filter((d) => uploaded[d.kind]?.file || uploaded[d.kind]?.doc_id)

  return (
    <AestheticCard>
      <div className="px-7 py-6 border-b border-warm">
        <div className="flex items-start gap-3">
          <span className="h-10 w-10 rounded-xl bg-brand-50 text-brand-700 border border-brand-100 flex items-center justify-center shrink-0">
            <Icon.Eye className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-base font-semibold text-ink-900">Review your application</h2>
            <p className="text-sm text-stone-500 mt-0.5">
              Check every detail before submitting. Our team reviews this manually,
              so a correction now saves days later.
            </p>
          </div>
        </div>
      </div>

      <div className="px-7 py-6 space-y-6">
        <ReviewGroup
          title={isRecruiter ? 'Organization' : 'Institution'}
          onEdit={() => onEdit(S_INSTITUTION)}
          rows={[
            [isRecruiter ? 'Organization name' : 'Name', form.institution_name],
            ['Type', typeLabel],
            [isRecruiter ? 'Govt / CIN Ref' : 'AISHE code', form.aishe_code],
            [isRecruiter ? 'Organization PAN / TAN' : 'PAN / TAN', form.pan?.toUpperCase()],
            ['Year established', form.year_established],
            [isRecruiter ? 'Sector / Category' : 'Affiliation', affiliation],
            !isRecruiter ? ['Approx. students', form.approx_student_count] : null,
          ].filter(Boolean)}
        />

        <ReviewGroup
          title={isRecruiter ? 'Registered office' : 'Campus address'}
          onEdit={() => onEdit(S_ADDRESS)}
          rows={[
            ['Address', address.join('\n')],
            ['Expected centres', form.expected_centres],
          ]}
        />

        <ReviewGroup
          title={isRecruiter ? 'Nodal verification officer' : 'Head of institution'}
          onEdit={() => onEdit(S_ADDRESS)}
          rows={[
            ['Name', form.head_name],
            ['Designation', form.head_designation],
            ['Email', form.head_email],
            ['Mobile', form.head_mobile],
          ]}
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
              className="text-xs font-semibold text-brand-700 hover:underline"
            >
              Edit
            </button>
          </div>
          <ul className="rounded-xl border border-warm divide-y divide-warm overflow-hidden bg-warm-surface">
            {docs.map((d) => (
              <li key={d.kind} className="flex items-center gap-3 px-4 py-2.5">
                <span className="h-6 w-6 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center justify-center shrink-0">
                  <Icon.Check className="h-3.5 w-3.5" />
                </span>
                <span className="text-sm font-medium text-stone-800">{d.label}</span>
                <span className="ml-auto text-xs text-stone-500 font-mono truncate max-w-[45%]">
                  {uploaded[d.kind]?.original_name}
                </span>
              </li>
            ))}
            {docs.length === 0 && (
              <li className="px-4 py-3 text-sm text-stone-500 italic">No documents uploaded.</li>
            )}
          </ul>
        </div>

        <div className="rounded-xl bg-[#ECF0F5]/60 border border-warm px-4 py-3 text-xs text-stone-700 leading-relaxed">
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

function ReviewGroup({ title, rows, onEdit, note }) {
  const filled = rows.filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-600">{title}</h3>
        <button
          type="button"
          onClick={onEdit}
          className="text-xs font-semibold text-brand-700 hover:underline"
        >
          Edit
        </button>
      </div>
      <dl className="rounded-xl border border-warm divide-y divide-warm overflow-hidden bg-warm-surface">
        {filled.map(([k, v]) => (
          <div key={k} className="flex gap-4 px-4 py-2.5">
            <dt className="text-xs text-stone-500 w-40 shrink-0 pt-0.5">{k}</dt>
            <dd className="text-sm text-ink-900 min-w-0 break-words whitespace-pre-line">{v}</dd>
          </div>
        ))}
        {filled.length === 0 && (
          <div className="px-4 py-3 text-sm text-stone-500">Nothing entered.</div>
        )}
      </dl>
      {note && <p className="mt-1.5 text-xs text-stone-500">{note}</p>}
    </div>
  )
}

function Divider({ label }) {
  return (
    <div className="flex items-center gap-3 pt-1">
      <span className="h-px flex-1 bg-[#DDE4EC]" />
      <span className="text-[11px] font-semibold uppercase tracking-wider text-stone-400">{label}</span>
      <span className="h-px flex-1 bg-[#DDE4EC]" />
    </div>
  )
}

function InputWithIcon({ icon: IconComp, className = '', ...rest }) {
  return (
    <div className="relative group">
      {IconComp && (
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-400 group-focus-within:text-stone-700 transition-colors pointer-events-none">
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

function YearPicker({ value, onChange, placeholder = 'Pick year' }) {
  const currentYear = new Date().getFullYear()
  const [open, setOpen] = useState(false)
  const [viewYear, setViewYear] = useState(() => Number(value) || currentYear)
  const containerRef = useRef(null)

  useEffect(() => {
    if (value) setViewYear(Number(value))
  }, [value])

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
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`w-full inline-flex items-center justify-between gap-2 rounded-xl border border-warm bg-white px-3 py-2 text-sm text-left transition-colors focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-500/12 ${
          open ? 'border-amber-600 ring-2 ring-amber-200' : 'hover:border-warm-strong'
        }`}
      >
        <span className={value ? 'text-ink-900 tabular-nums font-medium' : 'text-stone-400'}>
          {value || placeholder}
        </span>
        <Icon.Calendar className={`h-4 w-4 ${open ? 'text-stone-700' : 'text-stone-400'} transition-colors`} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="absolute z-30 mt-2 w-full min-w-[260px] rounded-xl border border-warm bg-warm-surface p-3 shadow-lg shadow-stone-900/10"
          >
            <div className="flex items-center justify-between mb-3">
              <button
                type="button"
                onClick={() => setViewYear(viewYear - 10)}
                className="rounded-md p-1 text-stone-500 hover:bg-[#ECF0F5] hover:text-ink-900 transition-colors"
                aria-label="Previous decade"
              >
                <Icon.ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-sm font-semibold text-stone-800 tabular-nums">
                {decadeStart} – {decadeStart + 9}
              </span>
              <button
                type="button"
                onClick={() => setViewYear(viewYear + 10)}
                disabled={!canGoForward}
                className="rounded-md p-1 text-stone-500 hover:bg-[#ECF0F5] hover:text-ink-900 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                aria-label="Next decade"
              >
                <Icon.ChevronRight className="h-4 w-4" />
              </button>
            </div>

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
                        ? 'bg-ink-900 text-white shadow-xs'
                        : future
                        ? 'text-stone-300 cursor-not-allowed'
                        : isCurrent
                        ? 'text-ink-900 ring-1 ring-warm-strong bg-warm-surface hover:bg-[#ECF0F5]'
                        : 'text-stone-700 hover:bg-[#ECF0F5]'
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

function Step1({
  form,
  errors,
  update,
  onBlurField,
  onBack,
  onNext,
  submitting,
  emailOtpToken,
  setEmailOtpToken,
  mobileOtpToken,
  setMobileOtpToken,
}) {
  const isRecruiter = form.institution_type === 'other'
  const designationList = isRecruiter ? RECRUITER_DESIGNATIONS : ACADEMIC_DESIGNATIONS

  return (
    <div className="space-y-5">
      <SectionCard
        icon={Icon.MapPin}
        title={isRecruiter ? 'Registered office address' : 'Campus address'}
        subtitle={isRecruiter ? 'Physical headquarters or official recruitment office.' : 'Where the institution is physically located.'}
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
                update('district', '')
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
            label="District"
            required
            error={errors.district}
            help={!form.state ? 'Select a state first' : undefined}
          >
            <Select
              value={form.district}
              onChange={(e) => update('district', e.target.value)}
              onBlur={() => onBlurField('district')}
              disabled={!form.state}
              options={[
                { value: '', label: form.state ? 'Select district' : '—' },
                ...((CITIES_BY_STATE[form.state] || []).map((c) => ({ value: c, label: c }))),
              ]}
            />
          </Field>
          <Field label="City">
            <Input
              value={form.city}
              onChange={(e) => update('city', e.target.value)}
              placeholder="e.g. City / Town (Optional)"
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

      <SectionCard
        icon={Icon.ShieldCheck}
        title={isRecruiter ? 'Nodal Verification Officer / Authorized Signatory' : 'Head of institution'}
        subtitle={isRecruiter ? 'We send the activation credentials to this official after approval.' : 'We send the activation link to this person after approval.'}
      >
        <CalloutNote>
          The email and mobile below will receive OTP verification codes to confirm
          authenticity, and the email will receive the one-time activation link upon approval.
        </CalloutNote>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <Field label={isRecruiter ? 'Nodal Officer / Signatory name' : 'Full name'} required error={errors.head_name}>
            <Input
              value={form.head_name}
              onChange={(e) => update('head_name', e.target.value)}
              onBlur={() => onBlurField('head_name')}
              placeholder={isRecruiter ? 'e.g. Shri Rajesh Verma' : 'Dr. Rajesh Kumar'}
            />
          </Field>
          <Field label="Designation" required>
            <Select
              value={form.head_designation}
              onChange={(e) => update('head_designation', e.target.value)}
              options={designationList.map((d) => ({ value: d, label: d }))}
            />
          </Field>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <OtpVerificationField
            label="Email"
            type="email"
            required
            icon={Icon.Mail}
            value={form.head_email}
            onChange={(e) => update('head_email', e.target.value)}
            onBlur={() => onBlurField('head_email')}
            placeholder={isRecruiter ? 'nodal.exam@gov.in / hr@ongc.in' : 'principal@college.ac.in'}
            error={errors.head_email}
            isVerified={Boolean(emailOtpToken)}
            onVerified={(token) => setEmailOtpToken(token)}
            onResetVerification={() => setEmailOtpToken('')}
            canSendOtp={/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.head_email?.trim() || '')}
            sendOtpFn={() => sendEmailOTP(form.head_email.trim(), 'registration')}
            verifyOtpFn={(code) => verifyEmailOTP(form.head_email.trim(), code, 'registration')}
          />
          <OtpVerificationField
            label="Mobile"
            type="tel"
            required
            icon={Icon.Phone}
            value={form.head_mobile}
            onChange={(e) => update('head_mobile', normaliseIndianMobile(e.target.value))}
            onBlur={() => onBlurField('head_mobile')}
            placeholder="9876543210"
            error={errors.head_mobile}
            inputMode="numeric"
            maxLength={14}
            isVerified={Boolean(mobileOtpToken)}
            onVerified={(token) => setMobileOtpToken(token)}
            onResetVerification={() => setMobileOtpToken('')}
            canSendOtp={/^[6-9][0-9]{9}$/.test(form.head_mobile?.trim() || '')}
            sendOtpFn={() => sendSmsOTP(form.head_mobile.trim(), 'registration')}
            verifyOtpFn={(code) => verifySmsOTP(form.head_mobile.trim(), code, 'registration')}
          />
        </div>
      </SectionCard>

      <AestheticCard>
        <FooterBar>
          <Button variant="secondary" onClick={onBack} size="lg">
            <Icon.ChevronLeft className="mr-1.5 h-4 w-4" />
            Back
          </Button>
          <span className="text-xs text-stone-500 inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-600 animate-pulse" />
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

function SectionCard({ icon: IconComp, title, subtitle, children }) {
  return (
    <AestheticCard>
      <div className="px-6 py-5 border-b border-warm flex items-start gap-3">
        <motion.span
          initial={{ scale: 0.85, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.28, ease: [0.22, 1.2, 0.36, 1] }}
          className="h-10 w-10 rounded-xl bg-brand-50 text-brand-700 border border-brand-100 flex items-center justify-center shrink-0 shadow-2xs"
        >
          <IconComp className="h-5 w-5" />
        </motion.span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-ink-900">{title}</h2>
          {subtitle && <p className="text-sm text-stone-500 mt-0.5">{subtitle}</p>}
        </div>
      </div>
      <div className="px-6 py-6 space-y-5">{children}</div>
    </AestheticCard>
  )
}

function CalloutNote({ children }) {
  return (
    <div className="rounded-xl bg-amber-50/70 border border-warm px-3.5 py-2.5 text-xs text-stone-700 leading-relaxed">
      {children}
    </div>
  )
}

function Step2({ form, applicationId, uploaded, errors, handleFile, removeDoc, onBack, onSubmit, submitting }) {
  const activeDocs = getRequiredDocs(form)
  const requiredCount = activeDocs.filter((d) => d.required).length
  // Count picked-in-memory files, not server-issued doc_ids — the
  // Submit-time upload is what mints doc_id.
  const uploadedRequiredCount = activeDocs.filter((d) => d.required && (uploaded[d.kind]?.file || uploaded[d.kind]?.doc_id)).length
  return (
    <AestheticCard>
      <div className="px-6 py-5 border-b border-warm flex items-start gap-3">
        <span className="h-10 w-10 rounded-xl bg-brand-50 text-brand-700 border border-brand-100 flex items-center justify-center shrink-0">
          <Icon.Upload className="h-5 w-5" />
        </span>
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-semibold text-ink-900">Upload documents</h2>
          <p className="text-sm text-stone-500 mt-0.5">
            PDF, JPG or PNG — up to 10 MB per file.
          </p>
        </div>
        <Pill tone={uploadedRequiredCount === requiredCount ? 'emerald' : 'amber'}>
          {uploadedRequiredCount} / {requiredCount} required
        </Pill>
      </div>
      <div className="px-6 py-6 space-y-3">
        {activeDocs.map((d) => (
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
  // `done` = a file is picked (kept in memory until Submit).
  const done = Boolean(state?.file || state?.doc_id) && !uploading

  return (
    <motion.div
      layout
      className={`rounded-xl border p-4 transition-colors ${
        done
          ? 'border-emerald-200 bg-emerald-50/40'
          : error
          ? 'border-rose-300 bg-rose-50/40'
          : 'border-warm hover:border-warm-strong bg-warm-surface'
      }`}
    >
      <div className="flex items-start gap-4">
        <motion.span
          initial={false}
          animate={done ? { scale: [1, 1.12, 1] } : { scale: 1 }}
          transition={{ duration: 0.32, ease: 'easeOut' }}
          className={`h-10 w-10 rounded-xl flex items-center justify-center shrink-0 border ${
            done
              ? 'bg-emerald-50 text-emerald-600 border-emerald-200'
              : 'bg-[#ECF0F5] text-stone-700 border-warm'
          }`}
        >
          {done ? <Icon.Check className="h-5 w-5" /> : <Icon.FileText className="h-5 w-5" />}
        </motion.span>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <p className="text-sm font-medium text-ink-900">{label}</p>
            {required && (
              <span className="text-xs text-rose-600 font-semibold">required</span>
            )}
          </div>
          {hint && <p className="text-xs text-stone-500 mt-0.5">{hint}</p>}
          {state?.original_name && (
            <p className="mt-2 text-xs text-stone-700 truncate">
              <span className="font-mono font-medium">{state.original_name}</span>
              {state.size_bytes ? ` · ${(state.size_bytes / 1024).toFixed(0)} KB` : ''}
            </p>
          )}
          {uploading && (
            <div className="mt-2 h-1.5 w-full bg-[#DDE4EC] rounded-full overflow-hidden">
              <motion.div
                className="h-full bg-ink-900 rounded-full"
                initial={false}
                animate={{ width: `${state.progress || 0}%` }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
              />
            </div>
          )}
          {error && <p className="mt-2 text-xs text-rose-600 font-medium">{error}</p>}
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
                      : 'bg-white text-stone-700 border border-warm hover:border-warm-strong hover:bg-warm-surface'
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

function DonePanel({ applicationId, email, institutionName, onStartOver, onHome }) {
  const [copied, setCopied] = useState(false)

  function copyRef() {
    if (!applicationId) return
    navigator.clipboard?.writeText(String(applicationId))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="rounded-2xl border border-warm bg-warm-surface shadow-sm overflow-hidden">
      <div className="px-6 py-12 text-center max-w-xl mx-auto">
        <motion.div
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.45, ease: [0.22, 1.5, 0.36, 1] }}
          className="mx-auto h-16 w-16 rounded-2xl bg-emerald-600 text-white flex items-center justify-center shadow-lg shadow-emerald-600/20 ring-4 ring-emerald-100"
        >
          <Icon.Check className="h-8 w-8 stroke-[2.5]" />
        </motion.div>
        <h2 className="mt-5 text-2xl sm:text-3xl font-bold tracking-tight text-ink-900">
          Application Submitted!
        </h2>
        <p className="mt-2.5 text-sm sm:text-base text-stone-600 leading-relaxed">
          Your onboarding application for <strong className="text-ink-900 font-semibold">{institutionName}</strong> has been successfully received and placed in the accreditation queue.
        </p>

        <div className="mt-6 p-4 rounded-xl bg-[#ECF0F5]/70 border border-warm flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="text-left">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-stone-500">Application Reference ID</p>
            <p className="text-base font-bold font-mono text-ink-900 tracking-tight">#{applicationId ?? '—'}</p>
          </div>
          <button
            type="button"
            onClick={copyRef}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-warm text-xs font-semibold text-stone-700 hover:text-ink-900 hover:border-warm-strong shadow-2xs transition-all"
          >
            {copied ? <Icon.Check className="h-3.5 w-3.5 text-emerald-600" /> : <Icon.File className="h-3.5 w-3.5 text-stone-400" />}
            {copied ? 'Copied!' : 'Copy Reference'}
          </button>
        </div>

        <div className="mt-6 text-left p-4 rounded-xl bg-amber-50/80 border border-amber-200/80">
          <h4 className="text-xs font-bold uppercase tracking-wider text-amber-950 mb-2">What happens next?</h4>
          <ul className="text-xs text-amber-950 space-y-1.5">
            <li className="flex items-start gap-2">
              <span className="h-4 w-4 rounded-full bg-amber-200/80 text-amber-900 flex items-center justify-center shrink-0 mt-0.5 text-[10px] font-bold">1</span>
              <span>An activation link has been emailed to <strong className="font-semibold text-amber-950">{email}</strong> — set your password from there.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="h-4 w-4 rounded-full bg-amber-200/80 text-amber-900 flex items-center justify-center shrink-0 mt-0.5 text-[10px] font-bold">2</span>
              <span>Your application enters review. Full portal access unlocks after approval.</span>
            </li>
          </ul>
        </div>

        <div className="mt-8 flex items-center justify-center gap-3 flex-wrap">
          <Button variant="secondary" onClick={onStartOver}>Register Another Institution</Button>
          <Button onClick={onHome}>Return to Portal</Button>
        </div>
      </div>
    </div>
  )
}

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
