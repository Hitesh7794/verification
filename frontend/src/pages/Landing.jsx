import { Link } from 'react-router-dom'
import Verifier from '../components/login/Verifier.jsx'
import ExamHall from '../components/login/ExamHall.jsx'
import EmblemDraw from '../components/login/EmblemDraw.jsx'
import './landing.css'

// Landing — the portal's front door, in the Android app's own register
// (WelcomeScreen.kt): no company mark, the State Emblem where a mark
// would go, the companion greeting with folded hands, the candidates
// standing on a flat tint floor. FlatViolet, Bricolage only, flat
// throughout — no gradients, glows, shadows, red or green.
//
// One orchestrated moment: on load the emblem inks itself, "Namaste"
// arrives, the companion rises and greets, the queue fills one by one.
// Everything after that is still unless you act on it.

const DESKS = [
  {
    who: 'Verification agent',
    what: 'You check candidates at the exam centre: roll number, face, fingerprint, iris.',
    to: '/institute/operator/login',
    action: 'Sign in at the desk',
  },
  {
    who: 'Institution administrator',
    what: 'You add your verification agents, assign their exams and keep their wallet topped up.',
    to: '/admin/login',
    action: 'Sign in as administrator',
  },
  {
    who: 'Exam board reviewer',
    what: 'You approve the institutions that verify candidates for your exams.',
    to: '/reviewer/login',
    action: 'Sign in as reviewer',
  },
  {
    who: 'Platform team',
    what: 'You run the portal for every exam board and institution.',
    to: '/superadmin/login',
    action: 'Sign in to the platform',
  },
]

const CHECKS = [
  { name: 'Face', mood: { type: 'selfie', raised: true, face: 'smile' },
    text: 'A live photo from the desk camera, matched to the photo on the admit card.' },
  { name: 'Liveness', mood: { type: 'selfie', raised: true, face: 'blink' },
    text: 'The candidate blinks on request, so a printed photo or a screen can\'t stand in.' },
  { name: 'Fingerprint', mood: { type: 'fingerScan' },
    text: 'One finger on the scanner, compared with the print taken at registration.' },
  { name: 'Iris', mood: { type: 'eyeScan' },
    text: 'When a print won\'t read, the iris scanner confirms the same person.' },
]

const DOCS = [
  'Recognition letter',
  'PAN or TAN card',
  'Authorisation letter',
  'NAAC or NBA certificate, if you have one',
]

function greeting(h = new Date().getHours()) {
  if (h >= 5 && h <= 11) return 'Good morning'
  if (h >= 12 && h <= 16) return 'Good afternoon'
  if (h >= 17 && h <= 20) return 'Good evening'
  return 'Good night'
}

export default function Landing() {
  return (
    <div className="fv lp tricolour-top">
      {/* ── Top bar ─────────────────────────────────────────────── */}
      <header className="lp-bar">
        <a href="/" className="lp-brand" aria-label="Verification Portal home">
          <span aria-hidden="true" className="fv-emblem lp-brand-emblem" />
          <span>Verification Portal</span>
        </a>
        <nav className="lp-nav">
          <a href="#desks" className="lp-link">Sign in</a>
          <Link to="/register/institution" className="lp-btn lp-btn-primary lp-btn-sm">Register<span className="lp-hide-sm">&nbsp;your institution</span></Link>
        </nav>
      </header>

      {/* ── Hero: the greeting, then exam day itself, running ─────── */}
      <section className="lp-hero" aria-labelledby="lp-title">
        <ExamHall className="lp-hall" style={{ position: 'absolute', inset: 0 }} top={0.4} clearLeft={0.46} />
        <div className="lp-hero-top">
          <div className="lp-hero-copy">
            <EmblemDraw className="lp-hero-emblem" style={{ width: 52, height: 86 }} delay={80} />
            <p className="lp-greet lp-in" style={{ '--d': '1450ms' }}>{greeting()}.</p>
            <h1 id="lp-title" className="lp-namaste lp-in" style={{ '--d': '1550ms' }}>Namaste</h1>
            <p className="lp-lede lp-in" style={{ '--d': '1800ms' }}>
              The Verification Portal confirms that the candidate at the exam desk is the candidate who registered.
              One visit, four checks, the same for everyone.
            </p>
            <div className="lp-cta lp-in" style={{ '--d': '2100ms' }}>
              <a href="#desks" className="lp-btn lp-btn-primary">Sign in to your desk</a>
              <Link to="/register/institution" className="lp-btn lp-btn-quiet">Register your institution</Link>
            </div>
          </div>
        </div>
      </section>

      {/* ── The four checks ─────────────────────────────────────── */}
      <section className="lp-sec" aria-labelledby="lp-checks">
        <div className="lp-sec-head">
          <h2 id="lp-checks" className="lp-h2">Four checks, one visit</h2>
          <p className="lp-sec-lede">
            Face, liveness, fingerprint and iris, matched to the candidate's record on the spot.
            The agent follows the same four steps for every candidate.
          </p>
        </div>
        <ol className="lp-checks">
          {CHECKS.map((c, i) => (
            <li key={c.name} className="lp-check">
              <div className="lp-check-fig" aria-hidden="true">
                <Verifier mood={c.mood} className="lp-check-canvas" />
              </div>
              <p className="lp-check-step">Step {i + 1}</p>
              <h3 className="lp-h3">{c.name}</h3>
              <p className="lp-check-text">{c.text}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* ── Where to sign in ───────────────────────────────────── */}
      <section id="desks" className="lp-sec" aria-labelledby="lp-desks">
        <div className="lp-sec-head">
          <h2 id="lp-desks" className="lp-h2">Where do you sign in?</h2>
          <p className="lp-sec-lede">Each role has its own desk. Your administrator or exam board gives you the account.</p>
        </div>
        <ul className="lp-desks">
          {DESKS.map((d) => (
            <li key={d.who} className="lp-desk">
              <h3 className="lp-desk-who">{d.who}</h3>
              <p className="lp-desk-what">{d.what}</p>
              <Link to={d.to} className="lp-btn lp-btn-quiet lp-desk-go">{d.action}</Link>
            </li>
          ))}
        </ul>
      </section>

      {/* ── Register ───────────────────────────────────────────── */}
      <section className="lp-reg" aria-labelledby="lp-reg">
        <div className="lp-reg-copy">
          <h2 id="lp-reg" className="lp-h2">Bring your institution on board</h2>
          <p className="lp-sec-lede">
            Registration takes about ten minutes in one sitting. The exam board reviews every application,
            and your administrator account opens once it's approved.
          </p>
          <Link to="/register/institution" className="lp-btn lp-btn-primary">Start registration</Link>
        </div>
        <div className="lp-reg-docs">
          <p className="lp-reg-docs-title">Have these scans ready</p>
          <ul>
            {DOCS.map((d) => <li key={d}>{d}</li>)}
          </ul>
        </div>
      </section>

      {/* ── Close ──────────────────────────────────────────────── */}
      <section className="lp-close">
        <p className="lp-close-line">
          Every candidate is checked the same way, on the same screen, and every result is recorded.
        </p>
      </section>

      <footer className="lp-foot">
        <span aria-hidden="true" className="fv-emblem lp-foot-emblem" />
        <p>सत्यमेव जयते</p>
        <p className="lp-foot-fine">Authorised access only. All sign-in attempts are logged.</p>
      </footer>
    </div>
  )
}
