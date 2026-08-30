// Downloads client. Used by both the admin portal and the operator
// (client) portal so a freshly-logged-in operator on a fresh laptop
// can self-serve the install bundle when the admin can't physically
// deliver it. Thin wrappers over /api/downloads.
//
// downloadOperatorClient() is hand-rolled (not via the shared api()
// helper) because the response is a 200+ MB binary, not JSON. We need
// to attach the Bearer token explicitly and turn the response into a
// blob + temporary anchor to trigger the browser save dialog. The
// shared api() helper assumes a JSON body and would parse the entire
// .exe as text — wrong shape end to end.

import { ApiError, api } from './api.js'
import { getStoredToken, getRoleScope } from './authStorage.js'

const BASE = '/api'

// Returns { items: [...], last_download?: { at, username } }.
// items[0] is the operator-client bundle (when present); empty array
// means the backend can't find a bundle in DOWNLOADS_DIR — UI shows a
// "not published yet" empty state.
export const getDownloads = () => api('/downloads')

// Triggers the browser to download the operator-client bundle. Returns
// { filename, sha256, bytes } describing what landed. Throws ApiError
// on transport failure, or a DOMException on abort.
//
// Why not <a href> + click? Because the backend requires Authorization:
// Bearer <jwt> and browsers don't send headers on plain navigation.
// We fetch with the header, stream-read the body so the UI can show
// progress, then synthesise a click on a temporary <a download="...">
// to invoke the native save dialog.
//
// Memory: the 222 MB body sits in memory briefly while we concat the
// chunks into a Blob. That's fine on any modern laptop. When the
// artefact grows past ~1 GB we'd switch to streamSaver.js, but we're
// nowhere near that.
//
// Options:
//   - signal:      AbortSignal — cancels mid-download cleanly.
//   - onProgress:  (loaded, total) => void — called as bytes arrive.
//                  total may be 0 if the server didn't send
//                  Content-Length (it does, but defensive).
export async function downloadOperatorClient({ signal, onProgress } = {}) {
  const token = getStoredToken(getRoleScope())
  const res = await fetch(`${BASE}/downloads/operator-client`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal,
  })
  if (!res.ok) {
    let msg = `Download failed (HTTP ${res.status})`
    try {
      const body = await res.json()
      if (body?.error) msg = body.error
    } catch {
      // body wasn't JSON — keep generic message
    }
    throw new ApiError(msg, { status: res.status })
  }
  const filename =
    parseFilenameFromContentDisposition(res.headers.get('Content-Disposition')) ||
    'OperatorPortalSetup.zip'
  const sha256 = res.headers.get('X-SHA256') || res.headers.get('X-Sha256') || ''
  const total = Number(res.headers.get('Content-Length')) || 0

  // Stream the body so we can emit progress. If the browser is ancient
  // enough not to expose res.body as a ReadableStream we fall back to
  // res.blob() — no progress but the download still completes.
  let blob
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader()
    const chunks = []
    let loaded = 0
    onProgress?.(0, total)
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      loaded += value.byteLength
      onProgress?.(loaded, total)
    }
    blob = new Blob(chunks, { type: res.headers.get('Content-Type') || 'application/octet-stream' })
  } else {
    blob = await res.blob()
    onProgress?.(blob.size, blob.size)
  }

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoke after a tick so Chrome on slow disks doesn't drop the save.
  setTimeout(() => URL.revokeObjectURL(url), 1500)
  return { filename, sha256, bytes: blob.size }
}

function parseFilenameFromContentDisposition(header) {
  if (!header) return null
  // Match filename* (RFC 5987) first, then plain filename. Both shapes
  // appear in the wild; the backend sends the plain form.
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header)
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''))
    } catch {
      // fall through to plain form
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header)
  return plain ? plain[1].trim() : null
}
