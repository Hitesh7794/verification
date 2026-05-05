import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './lib/auth.jsx'

import LandingPage from './pages/Landing.jsx'

import ClientLogin from './pages/client/Login.jsx'
import ClientDashboard from './pages/client/Dashboard.jsx'

import AdminLogin from './pages/admin/Login.jsx'
import AdminDashboard from './pages/admin/Dashboard.jsx'

import SuperLogin from './pages/superadmin/Login.jsx'
import SuperDashboard from './pages/superadmin/Dashboard.jsx'

function RequireRole({ role, children }) {
  const { user } = useAuth()
  if (!user) return <Navigate to={`/${role}/login`} replace />
  if (user.role !== role) return <Navigate to="/" replace />
  return children
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />

      <Route path="/client/login" element={<ClientLogin />} />
      <Route
        path="/client"
        element={
          <RequireRole role="client">
            <ClientDashboard />
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

      <Route path="/superadmin/login" element={<SuperLogin />} />
      <Route
        path="/superadmin"
        element={
          <RequireRole role="superadmin">
            <SuperDashboard />
          </RequireRole>
        }
      />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
