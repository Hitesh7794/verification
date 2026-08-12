import { Link } from 'react-router-dom'
import { Card, CardBody } from '../components/ui/ui.jsx'
import { Brand } from '../components/ui/brand.jsx'

const portals = [
  {
    to: '/institute/operator/login',
    title: 'Operator Portal',
    desc: 'For centre operators conducting on-site biometric verification of candidates.',
    accent: 'bg-indigo-600',
  },
  {
    to: '/admin/login',
    title: 'Admin Portal',
    desc: 'For exam organisations to monitor verification activity across their exams.',
    accent: 'bg-emerald-600',
  },
  {
    to: '/superadmin/login',
    title: 'Superadmin Portal',
    desc: 'Platform-wide oversight across organisations, exams and operators.',
    accent: 'bg-slate-800',
  },
]

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/85 backdrop-blur supports-[backdrop-filter]:bg-white/70">
        <div className="mx-auto max-w-7xl px-6 h-14 flex items-center justify-between">
          <Brand />
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-16">
        <div className="max-w-2xl">
          <h1 className="text-4xl font-semibold tracking-tight text-slate-900">
            Biometric verification for high-stakes examinations.
          </h1>
          <p className="mt-4 text-slate-600 leading-relaxed">
            Sleek, fast and reliable identity verification using face recognition and fingerprint
            matching. Choose a portal to sign in.
          </p>
        </div>

        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {portals.map((p) => (
            <Link key={p.to} to={p.to} className="group">
              <Card className="h-full transition-shadow group-hover:shadow-md">
                <div className={`h-1.5 ${p.accent}`} />
                <CardBody>
                  <h3 className="text-lg font-semibold text-slate-900">{p.title}</h3>
                  <p className="mt-2 text-sm text-slate-600 leading-relaxed">{p.desc}</p>
                  <p className="mt-4 text-sm font-medium text-indigo-600 group-hover:text-indigo-700">
                    Sign in →
                  </p>
                </CardBody>
              </Card>
            </Link>
          ))}
        </div>

        {/* Public CTA for new institutions. Routes to the wizard at
            /register/institution. Distinct visual treatment so it
            doesn't compete with the operator portals above. */}
        <div className="mt-12">
          <Card>
            <CardBody className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h3 className="text-base font-semibold text-slate-900">
                  New institution? Register here.
                </h3>
                <p className="mt-1 text-sm text-slate-600">
                  Tell us a few details, upload your recognition documents, and our team will activate your account within 48 hours.
                </p>
              </div>
              <Link
                to="/register/institution"
                className="inline-flex items-center justify-center font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 text-sm px-4 py-2"
              >
                Register your institution
              </Link>
            </CardBody>
          </Card>
        </div>
      </main>
    </div>
  )
}
