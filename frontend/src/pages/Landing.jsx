import { Link } from 'react-router-dom'
import { Card, CardBody } from '../components/ui.jsx'

const portals = [
  {
    to: '/client/login',
    title: 'Client Portal',
    desc: 'For center operators conducting on-site biometric verification of candidates.',
    accent: 'bg-indigo-600',
  },
  {
    to: '/admin/login',
    title: 'Admin Portal',
    desc: 'For exam organizations to monitor verification activity across centers.',
    accent: 'bg-emerald-600',
  },
  {
    to: '/superadmin/login',
    title: 'Superadmin Portal',
    desc: 'Platform-wide oversight across organizations, centers and operators.',
    accent: 'bg-slate-800',
  },
]

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-7xl px-6 py-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-indigo-600 flex items-center justify-center">
              <span className="text-white font-bold">NV</span>
            </div>
            <span className="font-semibold text-slate-900">NEET Verification Portal</span>
          </div>
          <span className="text-xs text-slate-500">Mock build</span>
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
      </main>
    </div>
  )
}
