import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
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
  loadDraft,
  saveDraft,
  clearDraft,
} from '../../lib/onboarding/register.js'

// Multi-step institution registration wizard.
//
// UI conventions used here, kept consistent across all 3 steps:
//   - Each step is a single EnhancedCard with a coloured accent bar at
//     the top. Bar colour shifts step-by-step (indigo → violet →
//     fuchsia) so the page visibly "warms up" toward submit.
//   - Each section inside a step gets a small icon + tracker label
//     above its fields.
//   - Required-field markers are subtle (rose dot) instead of giant
//     asterisks.
//   - The footer with Back / Continue buttons is sticky inside the
//     card so very long sections don't bury the primary action.
//
// State persistence (localStorage), honeypot, and the per-doc upload
// retry pattern from earlier remain unchanged.

const STEPS = [
  { label: 'Institution', icon: Icon.Building },
  { label: 'Address & Head', icon: Icon.MapPin },
  { label: 'Documents', icon: Icon.FileText },
  { label: 'Done', icon: Icon.Check },
]

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
const TIERS = [
  { value: 'tier_1', label: 'Tier 1' },
  { value: 'tier_2', label: 'Tier 2' },
  { value: 'tier_3', label: 'Tier 3' },
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

const EMPTY_FORM = {
  institution_name: '',
  institution_type: 'college',
  tier: '',
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

  // Restore draft on mount.
  useEffect(() => {
    const d = loadDraft()
    if (d) {
      setForm({ ...EMPTY_FORM, ...(d.form || {}) })
      setStep(d.step ?? 0)
      setApplicationId(d.applicationId ?? null)
      setUploaded(d.uploaded ?? {})
    }
  }, [])

  useEffect(() => {
    saveDraft({ form, step, applicationId, uploaded })
  }, [form, step, applicationId, uploaded])

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }))
    setErrors((e) => {
      if (!e[field]) return e
      const { [field]: _, ...rest } = e
      return rest
    })
  }

  function validateStep0() {
    const e = {}
    if (form.institution_name.trim().length < 3) e.institution_name = 'Required (at least 3 characters)'
    if (!INSTITUTION_TYPES.find((t) => t.value === form.institution_type)) e.institution_type = 'Pick a type'
    // Tier is optional — omit if not chosen
    if (!form.aishe_code.trim()) e.aishe_code = 'Required'
    if (!form.pan.trim()) e.pan = 'Required'
    else if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/i.test(form.pan.trim())) e.pan = 'Format: ABCDE1234F'
    const year = Number(form.year_established)
    if (!form.year_established || !year) e.year_established = 'Required'
    else if (year < 1800 || year > new Date().getFullYear()) e.year_established = `Must be between 1800 and ${new Date().getFullYear()}`
    if (!form.affiliation_body) e.affiliation_body = 'Required'
    else if (form.affiliation_body === 'Other' && !form.affiliation_body_other.trim()) {
      e.affiliation_body_other = 'Please specify'
    }
    const students = Number(form.approx_student_count)
    if (!form.approx_student_count || !students) e.approx_student_count = 'Required'
    else if (students < 1 || students > 10_000_000) e.approx_student_count = 'Must be a positive number'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  function validateStep1() {
    const e = {}
    if (!form.address_line1.trim()) e.address_line1 = 'Required'
    if (!form.city.trim()) e.city = 'Required'
    if (!form.state.trim()) e.state = 'Required'
    if (!/^[0-9]{6}$/.test(form.pin_code.trim())) e.pin_code = 'PIN must be 6 digits'
    if (form.head_name.trim().length < 2) e.head_name = 'Required'
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.head_email.trim())) e.head_email = 'Invalid email'
    if (!/^[0-9]{10}$/.test(form.head_mobile.trim())) e.head_mobile = 'Mobile must be exactly 10 digits'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  async function goToStep2() {
    if (!validateStep1()) return
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
        }
        delete payload.affiliation_body_other // internal-only field
        const res = await registerInit(payload)
        setApplicationId(res.application_id)
      }
      setStep(2)
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

  async function finalize() {
    const missing = REQUIRED_DOCS.filter((d) => d.required && !uploaded[d.kind]?.doc_id)
    if (missing.length) {
      setTopError('Please upload: ' + missing.map((d) => d.label).join(', '))
      return
    }
    setSubmitting(true)
    setTopError('')
    try {
      await submitApplication(applicationId)
      clearDraft()
      setStep(3)
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
    setStep(0)
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
        {/* three drifting orbs — warm indigo + violet + emerald hint */}
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 1.2, ease: 'easeOut' }}
          className="absolute -top-40 -left-24 h-[28rem] w-[28rem] rounded-full bg-indigo-200/40 blur-[100px]"
        />
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 1.2, delay: 0.1, ease: 'easeOut' }}
          className="absolute -top-24 right-[-6rem] h-[26rem] w-[26rem] rounded-full bg-violet-200/45 blur-[100px]"
        />
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 1.4, delay: 0.2, ease: 'easeOut' }}
          className="absolute top-40 left-1/3 h-96 w-96 rounded-full bg-emerald-100/30 blur-[110px]"
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
          {step === 3
            ? 'Application received'
            : (
              <>
                Register your{' '}
                <span className="bg-gradient-to-r from-indigo-600 via-violet-600 to-fuchsia-600 bg-clip-text text-transparent">
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
        {step === 3 ? (
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
                  {step === 0 && (
                    <Step0
                      form={form}
                      errors={errors}
                      update={update}
                      onNext={() => {
                        if (validateStep0()) setStep(1)
                      }}
                    />
                  )}
                  {step === 1 && (
                    <Step1
                      form={form}
                      errors={errors}
                      update={update}
                      onBack={() => setStep(0)}
                      onNext={goToStep2}
                      submitting={submitting}
                    />
                  )}
                  {step === 2 && (
                    <Step2
                      applicationId={applicationId}
                      uploaded={uploaded}
                      errors={errors}
                      handleFile={handleFile}
                      removeDoc={removeDoc}
                      onBack={() => setStep(1)}
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
          {STEPS.slice(0, 3).map((s, i) => {
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

function Step0({ form, errors, update, onNext }) {
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
            1. Pickers (Type + Tier)
            2. Identifier / history fields
          Separated by a subtle labelled divider so the eye doesn't
          read everything as one undifferentiated grid. */}
      <div className="px-7 py-7 space-y-7">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-7">
          <div>
            <Label>
              Type <span className="text-rose-600 ml-0.5">*</span>
            </Label>
            <div className="grid grid-cols-2 gap-2.5">
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
          <div>
            <Label>
              Tier <span className="text-slate-400 ml-1 text-xs font-normal">(optional)</span>
            </Label>
            <div className="grid grid-cols-3 gap-2.5">
              {TIERS.map((t) => (
                <ChipChoice
                  key={t.value}
                  selected={form.tier === t.value}
                  onSelect={() => update('tier', form.tier === t.value ? '' : t.value)}
                  label={t.label}
                />
              ))}
            </div>
            {errors.tier && <p className="mt-1.5 text-xs text-rose-600">{errors.tier}</p>}
          </div>
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
              placeholder="e.g. Saragarhi Memorial College of Eminence"
            />
          </Field>
          <Field className="sm:col-span-2" label="AISHE code" required error={errors.aishe_code}>
            <InputWithIcon
              icon={Icon.ShieldCheck}
              value={form.aishe_code}
              onChange={(e) => update('aishe_code', e.target.value)}
              placeholder="C-12345"
            />
          </Field>
          <Field className="sm:col-span-2" label="PAN" required error={errors.pan}>
            <InputWithIcon
              icon={Icon.File}
              value={form.pan}
              onChange={(e) => update('pan', e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10))}
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

// CompactChoice — picker button for the Type slot. Bigger padding
// than ChipChoice (px-4 py-3 vs px-3 py-3) and a leading icon chip so
// the eye picks the category before the text. Used in a 2-up grid; the
// dropped blurb (vs the old ChoiceCard) keeps things tidy without
// feeling cramped.
function CompactChoice({ selected, onSelect, icon: IconComp, label }) {
  return (
    <motion.button
      type="button"
      onClick={onSelect}
      whileTap={{ scale: 0.98 }}
      className={`relative h-14 inline-flex items-center gap-2.5 rounded-xl border px-4 text-left transition-colors ${
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
      {selected && (
        <motion.span
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ duration: 0.15, ease: [0.22, 1.5, 0.36, 1] }}
          className="ml-auto h-4 w-4 rounded-full bg-emerald-50 text-emerald-600 ring-1 ring-emerald-200 flex items-center justify-center"
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

// ChipChoice — picker chip for tier selection. Same height as
// CompactChoice (the Type picker) so the two pickers sit on a visually
// matched baseline — without an icon chip of its own, ChipChoice would
// otherwise look ~12px shorter. h-14 (56px) matches the Type button's
// natural height (icon chip + vertical padding).
function ChipChoice({ selected, onSelect, label }) {
  return (
    <motion.button
      type="button"
      onClick={onSelect}
      whileHover={{ y: -1, transition: { duration: 0.15 } }}
      whileTap={{ scale: 0.98, y: 0 }}
      className={`relative h-14 rounded-xl border px-4 transition-colors duration-150 inline-flex items-center justify-center gap-2
                  ${selected
                    ? 'border-slate-900 bg-slate-50/80 ring-1 ring-slate-900/10'
                    : 'border-slate-200 bg-white hover:border-slate-300'}`}
    >
      <p className={`text-sm font-semibold ${selected ? 'text-slate-900' : 'text-slate-800'}`}>{label}</p>
      {selected && (
        <motion.span
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          className="h-5 w-5 rounded-md bg-emerald-50 text-emerald-600 ring-1 ring-emerald-200 flex items-center justify-center"
        >
          <Icon.Check className="h-3 w-3" />
        </motion.span>
      )}
    </motion.button>
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

function Step1({ form, errors, update, onBack, onNext, submitting }) {
  return (
    <div className="space-y-5">
      {/* Section 1 — Campus address.
          Own card so it visually reads as a distinct block from the
          head-of-institution section below. Soft teal accent on the
          icon chip to differentiate from the violet head chip. */}
      <SectionCard
        icon={Icon.MapPin}
        accent="from-teal-500 to-emerald-600"
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
            <Input
              value={form.state}
              onChange={(e) => update('state', e.target.value)}
              placeholder="e.g. Punjab"
              autoComplete="off"
            />
          </Field>
          <Field label="City" required error={errors.city}>
            <Input
              value={form.city}
              onChange={(e) => update('city', e.target.value)}
              placeholder="e.g. Amritsar"
              autoComplete="off"
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
            placeholder="143001"
            inputMode="numeric"
            maxLength={6}
            className="sm:max-w-[200px]"
          />
        </Field>
      </SectionCard>

      {/* Section 2 — Head of institution.
          Indigo accent on the icon chip — visually different from the
          address card so the operator knows they're switching context
          from "place" to "person". Compact callout under the heading
          highlights what this email will be used for. */}
      <SectionCard
        icon={Icon.ShieldCheck}
        accent="from-indigo-500 to-violet-500"
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
              placeholder="principal@college.ac.in"
            />
          </Field>
          <Field label="Mobile" required error={errors.head_mobile}>
            <InputWithIcon
              icon={Icon.Phone}
              value={form.head_mobile}
              onChange={(e) => update('head_mobile', e.target.value.replace(/\D/g, '').slice(0, 10))}
              inputMode="numeric"
              maxLength={10}
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
        <Button onClick={onSubmit} disabled={submitting} size="lg" variant="success">
          {submitting ? 'Submitting…' : 'Submit for review'}
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

function Select({ value, onChange, options }) {
  return (
    <select
      value={value}
      onChange={onChange}
      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
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
