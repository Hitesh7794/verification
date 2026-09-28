import { useEffect, useState } from 'react'
// Hindi alongside the few words that carry a decision.
//
// Only the prominent things are doubled — a status, an institution's type,
// a headline count. Everything else stays in one language, because a page
// that repeats every label twice is harder to read, not easier.
// Devanagari has its own face (Bricolage carries no Devanagari glyphs).

export const HI = {
  // decisions
  'Waiting on you': 'आपके पास लंबित',
  Waiting: 'लंबित',
  Pending: 'लंबित',
  'Pending Review': 'समीक्षा लंबित',
  Approved: 'स्वीकृत',
  'Sent back': 'वापस भेजा',
  Rejected: 'अस्वीकृत',
  Verified: 'सत्यापित',
  Denied: 'अस्वीकृत',
  Abandoned: 'अधूरा',
  Active: 'सक्रिय',
  Disabled: 'बंद',
  Locked: 'लॉक',
  'All time': 'कुल',
  // institutions
  College: 'महाविद्यालय',
  University: 'विश्वविद्यालय',
  Institute: 'संस्थान',
  School: 'विद्यालय',
  'Govt commission': 'सरकारी आयोग',
  'Recruitment body': 'भर्ती निकाय',
  // table headings
  When: 'कब',
  Candidate: 'अभ्यर्थी',
  Institute: 'संस्थान',
  Agent: 'एजेंट',
  Check: 'जाँच',
  Results: 'परिणाम',
  // pages and sections
  'KYC applications': 'केवाईसी आवेदन',
  'Exam approval': 'परीक्षा स्वीकृति',
  Agents: 'एजेंट',
  Exams: 'परीक्षाएँ',
  'Verification history': 'सत्यापन इतिहास',
  Institutes: 'संस्थान',
  Requests: 'अनुरोध',
  Candidates: 'अभ्यर्थी',
  Window: 'अवधि',
  Centres: 'केंद्र',
  // counts worth naming
  'Candidates checked': 'जाँचे गए अभ्यर्थी',
  'Checks, all time': 'कुल जाँच',
  Institutions: 'संस्थान',
  'Agents and staff': 'एजेंट और कर्मचारी',
}

export function hi(text) {
  if (!text) return null
  const k = String(text).trim()
  return HI[k] || HI[k.replace(/_/g, ' ')] || HI[k.charAt(0).toUpperCase() + k.slice(1).toLowerCase()] || null
}

// Bi — the word, with its Hindi under it (or beside it when inline).
// Renders nothing extra when there is no translation for that word.
export default function Bi({ en, inline = false, className = '', hiClassName = '' }) {
  const h = hi(en)
  if (!h) return <>{en}</>
  if (inline) {
    return (
      <span className={className}>
        {en}<span className={`fv-hi ml-1.5 text-[0.85em] text-fv-faint ${hiClassName}`}>{h}</span>
      </span>
    )
  }
  return (
    <span className={`inline-flex flex-col leading-tight ${className}`}>
      <span>{en}</span>
      <span className={`fv-hi text-[0.78em] font-medium text-fv-faint ${hiClassName}`}>{h}</span>
    </span>
  )
}

// ── Names in Devanagari ──────────────────────────────────────────────
// A record's own Hindi name always wins (name_hi / institution_name_hi).
// Failing that the name is transliterated — spelled in Devanagari, not
// translated, which is how these names are actually said: "University of
// Delhi" → यूनिवर्सिटी ऑफ दिल्ली. One request per name per session, cached
// (including failures). The name is sent to Google's input-tools endpoint;
// nothing else leaves the page. Pass enabled=false to switch it off.
const NAME_KEY = 'fv_hi_name_v1'
function readNames() {
  try { return JSON.parse(sessionStorage.getItem(NAME_KEY) || '{}') } catch { return {} }
}
function writeName(k, v) {
  try {
    const c = readNames(); c[k] = v
    sessionStorage.setItem(NAME_KEY, JSON.stringify(c))
  } catch { /* private mode — the lookup just repeats */ }
}

export function useHindiName(name, given, enabled = true) {
  const [out, setOut] = useState(() => given || (name ? readNames()[name] || null : null))
  useEffect(() => {
    if (given) { setOut(given); return undefined }
    if (!enabled || !name || !/[A-Za-z]/.test(name)) return undefined
    const cache = readNames()
    if (Object.prototype.hasOwnProperty.call(cache, name)) { setOut(cache[name]); return undefined }
    let alive = true
    const url = 'https://inputtools.google.com/request?itc=hi-t-i0-und&num=1&cp=0&cs=1&ie=utf-8&oe=utf-8&text='
      + encodeURIComponent(name)
    fetch(url)
      .then((r) => r.json())
      .then((j) => {
        const val = j?.[0] === 'SUCCESS' ? j?.[1]?.[0]?.[1]?.[0] || null : null
        writeName(name, val)
        if (alive) setOut(val)
      })
      .catch(() => { writeName(name, null); if (alive) setOut(null) })
    return () => { alive = false }
  }, [name, given, enabled])
  return out
}

// HindiName — the name again, in Devanagari, under the English one.
export function HindiName({ name, given, className = '' }) {
  const h = useHindiName(name, given)
  if (!h) return null
  return <span className={`fv-hi block text-fv-faint ${className}`}>{h}</span>
}
