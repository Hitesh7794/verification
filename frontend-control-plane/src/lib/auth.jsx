import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { api } from './api.js'
import {
  clearStoredSession,
  getRoleScope,
  getStoredToken,
  getStoredUser,
  setStoredSession,
  tokenKey,
  userKey,
} from './authStorage.js'

const AuthContext = createContext(null)

// AuthProvider is scope-aware: the "current user" depends on which
// portal the page belongs to. Two tabs at the same origin — one on
// /admin and one on /client — each see only their own user. This is
// what lets the admin stay logged in while an operator signs in next
// to them in another tab.
//
// Scope is derived from window.location.pathname. We use react-router's
// useLocation so that intra-tab navigation (e.g. /admin/login → /admin)
// re-evaluates the scope on every nav.
export function AuthProvider({ children }) {
  const location = useLocation()
  const scope = getRoleScope(location.pathname)

  // tick increments on any storage mutation so the user-derived state
  // refreshes; simpler than keeping a parallel React copy of user in
  // sync with localStorage by hand.
  const [tick, setTick] = useState(0)
  const [loading, setLoading] = useState(false)

  const user = scope ? getStoredUser(scope) : null

  // If we have a token but no cached user (e.g. fresh page load,
  // localStorage holds the token but the user object was lost), hydrate
  // from /api/me. Re-runs when scope changes — visiting /client after
  // /admin in the same tab loads the client-scoped user freshly.
  useEffect(() => {
    if (!scope) return
    const token = getStoredToken(scope)
    if (token && !getStoredUser(scope)) {
      api('/me')
        .then((u) => {
          setStoredSession(scope, token, u)
          setTick((t) => t + 1)
        })
        .catch(() => {
          clearStoredSession(scope)
          setTick((t) => t + 1)
        })
    }
    // We deliberately don't depend on `user` here — it would re-fire
    // every time setTick incremented and create a fetch loop.
    // eslint-disable-next-line
  }, [scope])

  // Cross-tab session sync, scoped to the current portal only. If the
  // admin signs in in another tab at /admin/login, our own admin tab
  // wants to know. But if an operator signs in at /institute/operator/login, that
  // touches `nv_token_client` — irrelevant to an admin-scoped tab.
  useEffect(() => {
    function onStorage(e) {
      if (!scope) return
      // localStorage.clear() sets key=null — treat as a global wipe.
      if (e.key === null) {
        setTick((t) => t + 1)
        return
      }
      if (e.key === tokenKey(scope) || e.key === userKey(scope)) {
        setTick((t) => t + 1)
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [scope])

  // Login stores the session under the response user's role-scope so a
  // user typing the wrong creds at /admin/login (e.g. operator creds)
  // doesn't pollute the admin scope's storage. The login form's
  // post-success navigation handles routing to the right dashboard.
  const login = useCallback(async (username, password) => {
    setLoading(true)
    try {
      const res = await api('/auth/login', {
        method: 'POST',
        body: { username, password },
        auth: false,
      })
      // Map backend role → URL scope. `client_reviewer` gets its own
      // scope (`reviewer`) so its session doesn't collide with the
      // operator (`client`) surface on the same origin.
      const responseScope =
        res.user?.role === 'client_reviewer' ? 'reviewer' :
        res.user?.role
      if (
        responseScope === 'admin' ||
        responseScope === 'client' ||
        responseScope === 'reviewer' ||
        responseScope === 'superadmin'
      ) {
        setStoredSession(responseScope, res.token, res.user)
      }
      setTick((t) => t + 1)
      return res.user
    } finally {
      setLoading(false)
    }
  }, [])

  // Logout clears ONLY the current scope. Operator tabs stay logged in
  // when the admin logs out from their tab, and vice versa.
  const logout = useCallback(() => {
    if (scope) clearStoredSession(scope)
    setTick((t) => t + 1)
  }, [scope])

  // tick is referenced so the linter doesn't flag it as unused; in
  // practice React re-reads `user` from localStorage on every render,
  // and tick is what causes those re-renders.
  void tick

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
