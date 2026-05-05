import { createContext, useContext, useEffect, useState } from 'react'
import { api } from './api.js'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try {
      const raw = localStorage.getItem('nv_user')
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  })
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const token = localStorage.getItem('nv_token')
    if (token && !user) {
      api('/me')
        .then((u) => {
          setUser(u)
          localStorage.setItem('nv_user', JSON.stringify(u))
        })
        .catch(() => logout())
    }
    // eslint-disable-next-line
  }, [])

  async function login(username, password) {
    setLoading(true)
    try {
      const res = await api('/auth/login', {
        method: 'POST',
        body: { username, password },
        auth: false,
      })
      localStorage.setItem('nv_token', res.token)
      localStorage.setItem('nv_user', JSON.stringify(res.user))
      setUser(res.user)
      return res.user
    } finally {
      setLoading(false)
    }
  }

  function logout() {
    localStorage.removeItem('nv_token')
    localStorage.removeItem('nv_user')
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
