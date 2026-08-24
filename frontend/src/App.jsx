import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './lib/auth.jsx'

import ClientLogin from './pages/client/Login.jsx'
import ClientDashboard from './pages/client/Dashboard.jsx'
import ClientDownloads from './pages/client/Downloads.jsx'

import AdminLogin from './pages/admin/Login.jsx'
import AdminDashboard from './pages/admin/Dashboard.jsx'
import AdminHistory from './pages/admin/History.jsx'
import AdminDownloads from './pages/admin/Downloads.jsx'
import AdminProducts from './pages/admin/Products.jsx'
import AdminCatalog from './pages/admin/Catalog.jsx'
import AdminMyExams from './pages/admin/MyExams.jsx'
import AdminOperators from './pages/admin/Operators.jsx'

import SuperLogin from './pages/superadmin/Login.jsx'
import SuperDashboard from './pages/superadmin/Dashboard.jsx'
import PendingApplications from './pages/superadmin/PendingApplications.jsx'
import ApplicationDetail from './pages/superadmin/ApplicationDetail.jsx'
import SuperClients from './pages/superadmin/Clients.jsx'
import SuperClientDetail from './pages/superadmin/ClientDetail.jsx'
import SuperExamDetail from './pages/superadmin/ExamDetail.jsx'

import ReviewerLogin from './pages/reviewer/Login.jsx'
import ReviewerDashboard from './pages/reviewer/Dashboard.jsx'
import ReviewerApplicationDetail from './pages/reviewer/ApplicationDetail.jsx'

import Register from './pages/register/Register.jsx'
import SetPassword from './pages/register/SetPassword.jsx'
import ForcePasswordChange from './pages/ForcePasswordChange.jsx'

// Build-mode driven route gating. Three production subdomains share
// one codebase; each Vite build runs with VITE_APP_MODE set so it
// includes only the routes relevant to that subdomain.
//
//   VITE_APP_MODE=signup   →  signup.portal.example.com  (public registration only)
//   VITE_APP_MODE=verify   →  portal.example.com         (operator + admin + verification superadmin)
//   VITE_APP_MODE=ops      →  ops.portal.example.com     (institution-application review)
//   (unset / "all")        →  dev — mounts everything
//
// Dev (`npm run dev`) leaves the var unset so a developer keeps a
// single Vite serving every route. Production deploys produce three
// dist-* folders that nginx serves from three server blocks.

const MODE = (typeof import.meta.env !== 'undefined' && import.meta.env.VITE_APP_MODE) || 'all'

// requireRole helper that accepts a single role string OR an array.
// The login redirect uses the first role's login screen when more than
// one role is allowed (the alternates can sign in there too — the
// backend re-checks role per endpoint).
function RequireRole({ role, children }) {
  const { user } = useAuth()
  const allowed = Array.isArray(role) ? role : [role]
  if (!user) {
    // Pick a sensible login URL for the role we're protecting. For
    // multi-role routes, use the first role's login page.
    // client_reviewer lives at /reviewer/* — not /client_reviewer/*
    // which would be an ugly URL and collide with the operator's
    // legacy /client redirect.
    const first = allowed[0]
    const scopeSeg = first === 'ops_admin' ? 'admin'
      : first === 'client_reviewer' ? 'reviewer'
      : first
    const loginPath = `/${scopeSeg}/login`
    return <Navigate to={loginPath} replace />
  }
  if (!allowed.includes(user.role)) {
    return <Navigate to="/" replace />
  }
  // Seeded accounts (super/super123, ops/ops123) and any other user
  // flagged by the backend get bounced to a forced-rotation screen
  // before they can touch any protected page. The flag clears as
  // soon as they pick a new password.
  //
  // The scope-prefix on the URL matters: getRoleScope() reads the
  // first path segment to find the right `nv_user_*` storage entry.
  // Without the prefix, ForcePasswordChange would see user=null and
  // redirect to landing — making it look like login itself failed.
  if (user.password_change_required) {
    const scope = user.role === 'ops_admin' ? 'admin' : user.role
    return <Navigate to={`/${scope}/force-password-change`} replace />
  }
  return children
}

const includes = (...modes) => modes.includes(MODE) || MODE === 'all'

export default function App() {
  return (
    <Routes>
      {/* Root: no landing page — send visitors straight to the admin
          login (which now hosts the "Register your institution" CTA
          for new tenants). Operator and superadmin URLs are direct.
          Ops mode still deep-links to its own queue. */}
      {(includes('signup', 'verify')) && (
        <Route path="/" element={<Navigate to="/admin/login" replace />} />
      )}
      {MODE === 'ops' && (
        <Route path="/" element={<Navigate to="/superadmin/applications" replace />} />
      )}

      {/* SIGNUP & RECOVERY — public institution registration & password reset flows */}
      <Route path="/reset-password" element={<SetPassword />} />
      {includes('signup') && (
        <>
          <Route path="/register/institution" element={<Register />} />
          <Route path="/register/set-password" element={<SetPassword />} />
        </>
      )}

      {/* Forced password rotation — anywhere a logged-in user lands
          with password_change_required=true. Mounted under each
          role's path so getRoleScope() can find the right session in
          localStorage. The page itself enforces "must be logged in +
          must have the flag". */}
      <Route path="/admin/force-password-change"                 element={<ForcePasswordChange />} />
      <Route path="/institute/operator/force-password-change"    element={<ForcePasswordChange />} />
      <Route path="/superadmin/force-password-change"            element={<ForcePasswordChange />} />
      <Route path="/reviewer/force-password-change"              element={<ForcePasswordChange />} />

      {/* Legacy /client/* → /institute/operator/* redirects. The old
          URLs were unclear ("client" meant "operator at an institute",
          not "customer"). Keep them redirecting so bookmarks + saved
          desktop shortcuts on operator laptops don't 404. */}
      <Route path="/client/login"                  element={<Navigate to="/institute/operator/login" replace />} />
      <Route path="/client"                        element={<Navigate to="/institute/operator" replace />} />
      <Route path="/client/downloads"              element={<Navigate to="/institute/operator/downloads" replace />} />
      <Route path="/client/force-password-change"  element={<Navigate to="/institute/operator/force-password-change" replace />} />

      {/* VERIFY MODE — the original operator/admin/superadmin app */}
      {includes('verify') && (
        <>
          <Route path="/institute/operator/login" element={<ClientLogin />} />
          <Route
            path="/institute/operator"
            element={
              <RequireRole role="client">
                <ClientDashboard />
              </RequireRole>
            }
          />
          <Route
            path="/institute/operator/downloads"
            element={
              <RequireRole role="client">
                <ClientDownloads />
              </RequireRole>
            }
          />

          <Route path="/admin/login" element={<AdminLogin />} />
          <Route
            path="/admin"
            element={
              <RequireRole role="admin">
                <AdminDashboard />
              </RequireRole>
            }
          />
          <Route
            path="/admin/history"
            element={
              <RequireRole role="admin">
                <AdminHistory />
              </RequireRole>
            }
          />
          <Route
            path="/admin/products"
            element={
              <RequireRole role="admin">
                <AdminProducts />
              </RequireRole>
            }
          />
          <Route
            path="/admin/downloads"
            element={
              <RequireRole role="admin">
                <AdminDownloads />
              </RequireRole>
            }
          />

          {/* Phase-2 admin surface: self-service catalog + subscriptions
              + per-operator management (cap, date window, exam list). */}
          <Route
            path="/admin/catalog"
            element={<RequireRole role="admin"><AdminCatalog /></RequireRole>}
          />
          <Route
            path="/admin/my-exams"
            element={<RequireRole role="admin"><AdminMyExams /></RequireRole>}
          />
          <Route
            path="/admin/operators"
            element={<RequireRole role="admin"><AdminOperators /></RequireRole>}
          />

          <Route path="/superadmin/login" element={<SuperLogin />} />
          <Route
            path="/superadmin"
            element={
              <RequireRole role="superadmin">
                <SuperDashboard />
              </RequireRole>
            }
          />

          {/* Exam catalog (Phase 1) — superadmin creates clients + exams
              + uploads candidate CSVs. All superadmin-only. */}
          <Route
            path="/superadmin/clients"
            element={<RequireRole role="superadmin"><SuperClients /></RequireRole>}
          />
          <Route
            path="/superadmin/clients/:id"
            element={<RequireRole role="superadmin"><SuperClientDetail /></RequireRole>}
          />
          <Route
            path="/superadmin/exams/:id"
            element={<RequireRole role="superadmin"><SuperExamDetail /></RequireRole>}
          />

          {/* Client-reviewer portal — a per-tenant KYC inbox. Reviewers
              are provisioned by superadmin (see ClientDetail) and log
              in here to approve/reject applications routed to their
              client. Distinct URL space from /client/* (which is a
              legacy redirect for the operator role). */}
          <Route path="/reviewer/login" element={<ReviewerLogin />} />
          <Route
            path="/reviewer"
            element={
              <RequireRole role="client_reviewer">
                <ReviewerDashboard />
              </RequireRole>
            }
          />
          <Route
            path="/reviewer/applications/:id"
            element={
              <RequireRole role="client_reviewer">
                <ReviewerApplicationDetail />
              </RequireRole>
            }
          />
        </>
      )}

      {/* OPS MODE — institution review (separate role: ops_admin). The
          admin login screen is reused here so ops_admin users can sign
          in. Backend enforces role at every endpoint regardless. */}
      {includes('ops') && (
        <>
          {/* Ops mode also needs a login page. Reuse the admin login —
              it's a thin form that just calls /api/auth/login. After
              sign-in, role-based gating kicks in. */}
          {MODE === 'ops' && <Route path="/admin/login" element={<AdminLogin />} />}

          <Route
            path="/superadmin/applications"
            element={
              <RequireRole role={['superadmin', 'ops_admin']}>
                <PendingApplications />
              </RequireRole>
            }
          />
          <Route
            path="/superadmin/applications/:id"
            element={
              <RequireRole role={['superadmin', 'ops_admin']}>
                <ApplicationDetail />
              </RequireRole>
            }
          />
        </>
      )}

      {/* Fallback — unknown routes go to the mode's home. For ops
          mode this lands at the queue; for others, the landing page. */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
