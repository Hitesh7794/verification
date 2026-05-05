const BASE = '/api'

function getToken() {
  return localStorage.getItem('nv_token') || ''
}

export async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (auth) {
    const t = getToken()
    if (t) headers.Authorization = `Bearer ${t}`
  }
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let msg = res.statusText
    try {
      const j = await res.json()
      if (j.error) msg = j.error
    } catch {}
    throw new Error(msg)
  }
  if (res.status === 204) return null
  return res.json()
}

export function photoUrl(roll) {
  // Token isn't included in <img>, so use a separate fetch + blob URL helper.
  return `${BASE}/candidates/${encodeURIComponent(roll)}/photo`
}

export async function fetchPhotoBlob(roll) {
  const res = await fetch(photoUrl(roll), {
    headers: { Authorization: `Bearer ${getToken()}` },
  })
  if (!res.ok) throw new Error('photo not found')
  const blob = await res.blob()
  return URL.createObjectURL(blob)
}

// Fetches the candidate's enrolled fingerprint template ready to be passed
// straight to morfin.match() as GalleryTemplate. Returns {template_b64,
// format, size_bytes}. The format string ("FMR_V2005" etc.) maps to the
// daemon's TmpFormat enum via tmpFormatFromString().
export async function fetchFPTemplate(roll) {
  return api(`/candidates/${encodeURIComponent(roll)}/fp-template`)
}
