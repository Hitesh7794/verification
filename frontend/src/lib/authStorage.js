// Path-scoped auth storage. The three portals (admin, client, superadmin)
// share an origin in dev (and on portal.example.com in prod where verify-
// mode hosts all three), so a single `nv_token` key would have them
// stomping on each other — logging in as the operator would log out the
// admin in another tab, and vice versa. We avoid that by namespacing the
// stored token + user by the portal the page belongs to. Two tabs at the
// same origin, one on /admin and one on /client, end up reading/writing
// completely disjoint storage keys.
//
// Scope resolution rule: take the first path segment of window.location
// (admin / client / superadmin). Everything else — landing page,
// registration flow, magic-link landing — has no scope and therefore no
// stored credentials, which is correct for those public surfaces.

export function getRoleScope(pathname) {
  const p = pathname || (typeof window !== 'undefined' ? window.location.pathname : '')
  if (p.startsWith('/admin')) return 'admin'
  if (p.startsWith('/client')) return 'client'
  if (p.startsWith('/superadmin')) return 'superadmin'
  return null
}

export function tokenKey(scope) {
  return scope ? `nv_token_${scope}` : null
}

export function userKey(scope) {
  return scope ? `nv_user_${scope}` : null
}

export function getStoredToken(scope) {
  const k = tokenKey(scope)
  if (!k) return ''
  try {
    return localStorage.getItem(k) || ''
  } catch {
    return ''
  }
}

export function getStoredUser(scope) {
  const k = userKey(scope)
  if (!k) return null
  try {
    const raw = localStorage.getItem(k)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function setStoredSession(scope, token, user) {
  const tk = tokenKey(scope)
  const uk = userKey(scope)
  if (!tk || !uk) return
  localStorage.setItem(tk, token)
  localStorage.setItem(uk, JSON.stringify(user))
}

export function clearStoredSession(scope) {
  const tk = tokenKey(scope)
  const uk = userKey(scope)
  if (!tk || !uk) return
  localStorage.removeItem(tk)
  localStorage.removeItem(uk)
}
