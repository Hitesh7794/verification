// Org-management API client — wraps /api/admin/operator-access.
// Kept thin on purpose; the backend already validates everything, so
// we just hand the bytes over and surface the response.
//
// One shared client-role credential per org. Admin views + resets +
// disables; there is no individual-operator management surface.

import { api } from '../api.js'

export const getOperatorAccess = () => api('/admin/operator-access')

export const resetOperatorPassword = () =>
  api('/admin/operator-access/reset-password', { method: 'POST' })

export const setOperatorPassword = (password) =>
  api('/admin/operator-access/set-password', {
    method: 'POST',
    body: { password },
  })

export const disableOperatorAccess = () =>
  api('/admin/operator-access/disable', { method: 'POST' })

export const enableOperatorAccess = () =>
  api('/admin/operator-access/enable', { method: 'POST' })
