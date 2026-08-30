import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './lib/auth.jsx'

import SuperLogin from './pages/superadmin/Login.jsx'
import SuperDashboard from './pages/superadmin/Dashboard.jsx'
import SuperClients from './pages/superadmin/Clients.jsx'
import SuperClientDetail from './pages/superadmin/ClientDetail.jsx'
import PendingApplications from './pages/superadmin/PendingApplications.jsx'
import ApplicationDetail from './pages/superadmin/ApplicationDetail.jsx'
import SuperExamDetail from './pages/superadmin/ExamDetail.jsx'
import BulkBiometricUpload from './pages/superadmin/BulkBiometricUpload.jsx'
import ForcePasswordChange from './pages/ForcePasswordChange.jsx'

function RequireRole({ role, children }) {
  const { user } = useAuth()
  const allowed = Array.isArray(role) ? role : [role]
  if (!user) {
    return <Navigate to="/superadmin/login" replace />
  }
  if (!allowed.includes(user.role)) {
    return <Navigate to="/superadmin" replace />
  }
  if (user.password_change_required) {
    return <Navigate to="/superadmin/force-password-change" replace />
  }
  return children
}

export default function App() {
  return (
    <Routes>
      {/* Login & Auth */}
      <Route path="/login" element={<Navigate to="/superadmin/login" replace />} />
      <Route path="/superadmin/login" element={<SuperLogin />} />
      <Route path="/superadmin/force-password-change" element={<ForcePasswordChange />} />

      {/* Root redirects to superadmin dashboard */}
      <Route path="/" element={<Navigate to="/superadmin" replace />} />

      {/* Dashboard / Overview */}
      <Route
        path="/superadmin"
        element={
          <RequireRole role="superadmin">
            <SuperDashboard />
          </RequireRole>
        }
      />

      {/* Clients Registry */}
      <Route
        path="/superadmin/clients"
        element={
          <RequireRole role="superadmin">
            <SuperClients />
          </RequireRole>
        }
      />
      <Route
        path="/superadmin/clients/:id"
        element={
          <RequireRole role="superadmin">
            <SuperClientDetail />
          </RequireRole>
        }
      />

      {/* Exam Details & Bulk Biometric Upload */}
      <Route
        path="/superadmin/exams/:id"
        element={
          <RequireRole role="superadmin">
            <SuperExamDetail />
          </RequireRole>
        }
      />
      <Route
        path="/superadmin/exams/:id/bulk-upload"
        element={
          <RequireRole role="superadmin">
            <BulkBiometricUpload />
          </RequireRole>
        }
      />

      {/* Central KYC Queue & Application Details */}
      <Route
        path="/superadmin/applications"
        element={
          <RequireRole role="superadmin">
            <PendingApplications />
          </RequireRole>
        }
      />
      <Route
        path="/superadmin/applications/:id"
        element={
          <RequireRole role="superadmin">
            <ApplicationDetail />
          </RequireRole>
        }
      />

      {/* Clean aliases for direct URLs */}
      <Route path="/clients" element={<Navigate to="/superadmin/clients" replace />} />
      <Route path="/clients/:id" element={<Navigate to="/superadmin/clients" replace />} />
      <Route path="/applications" element={<Navigate to="/superadmin/applications" replace />} />
      <Route path="/applications/:id" element={<Navigate to="/superadmin/applications" replace />} />

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/superadmin" replace />} />
    </Routes>
  )
}
