import { useEffect, useState } from 'react'

// useInstitutionPhoto — a real picture of an institution, when one can be
// found and trusted.
//
// The record's own photo always wins; this is the fallback. It asks
// Wikipedia's open API for the best-matching page image, then CHECKS the
// match before using it: a search for a name that has no page comes back
// with whatever is closest, which is how "Kota Academy" returns a film
// actor and "Deccan University" returns a geology map. A result is only
// accepted when the page reads like an institution — its title carries an
// education word (university, college, institute, IIT…), or it shares two
// distinctive words with the name. Anything else is refused and the caller
// draws its building instead.
//
// One request per name per session (answers, including "nothing", are
// cached in sessionStorage). The institution's name is sent to Wikipedia;
// nothing else leaves the page. Pass enabled=false to switch it off.

const EDU = /(universit|college|institute|institution|school|academy|vidyalaya|vishwavidyalaya|polytechnic|\biit\b|\biim\b|\bnit\b|\biiit\b)/i
const STOP = new Set(['of', 'the', 'and', 'for', 'in', 'at', 'a', 'an', 'memorial', 'national', 'new', 'sri', 'shri'])
const KEY = 'fv_inst_photo_v1'

function readCache() {
  try { return JSON.parse(sessionStorage.getItem(KEY) || '{}') } catch { return {} }
}
function writeCache(name, value) {
  try {
    const c = readCache()
    c[name] = value
    sessionStorage.setItem(KEY, JSON.stringify(c))
  } catch { /* private mode, full quota — the lookup just repeats */ }
}

const words = (s) => String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w))

// Does this page actually look like the institution we asked about?
export function matches(name, title) {
  if (!title) return false
  const n = words(name), t = new Set(words(title))
  const shared = n.filter((w) => t.has(w)).length
  if (EDU.test(title)) return shared >= 1 || EDU.test(name)
  return shared >= 2
}

export default function useInstitutionPhoto(name, enabled = true) {
  const [url, setUrl] = useState(() => (name ? readCache()[name] || null : null))
  useEffect(() => {
    if (!enabled || !name) return undefined
    const cache = readCache()
    if (Object.prototype.hasOwnProperty.call(cache, name)) { setUrl(cache[name]); return undefined }
    let alive = true
    const api = 'https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*'
      + '&prop=pageimages&piprop=thumbnail&pithumbsize=640&generator=search&gsrlimit=3&gsrsearch='
      + encodeURIComponent(name)
    fetch(api)
      .then((r) => r.json())
      .then((j) => {
        // the first of the top few results that has a picture AND reads
        // like this institution
        const pages = j?.query?.pages ? Object.values(j.query.pages) : []
        pages.sort((a, b) => (a.index || 0) - (b.index || 0))
        const hit = pages.find((pg) => pg?.thumbnail?.source && matches(name, pg.title))
        const good = hit ? hit.thumbnail.source : null
        writeCache(name, good)
        if (alive) setUrl(good)
      })
      .catch(() => { writeCache(name, null); if (alive) setUrl(null) })
    return () => { alive = false }
  }, [name, enabled])
  return url
}
