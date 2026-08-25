// Date and time formatting helpers shared across catalog, exam, and operator screens.

export function dateOnly(value) {
  if (!value) return ''
  const s = String(value).trim()
  const t = s.indexOf('T')
  const space = s.indexOf(' ')
  const splitIdx = t !== -1 ? t : space
  return splitIdx === -1 ? s : s.slice(0, splitIdx)
}

// toDatetimeLocal formats any ISO/RFC 3339 or date string to YYYY-MM-DDTHH:MM
// for HTML5 <input type="datetime-local">.
export function toDatetimeLocal(value, defaultTime = '00:00') {
  if (!value) return ''
  let s = String(value).trim()
  if (!s) return ''
  if (s.length >= 10 && s[10] === ' ') {
    s = s.slice(0, 10) + 'T' + s.slice(11)
  }
  if (!s.includes('T')) {
    return `${s}T${defaultTime}`
  }
  const parts = s.split('T')
  const datePart = parts[0]
  const timePart = (parts[1] || '').replace(/Z|[+-].*$/, '')
  const hm = timePart ? timePart.slice(0, 5) : defaultTime
  return `${datePart}T${hm}`
}

// formatDateTime renders a human-friendly string e.g. "15 May 2026, 09:30 AM"
export function formatDateTime(value, opts = {}) {
  if (!value) return ''
  const s = String(value).trim()
  if (!s) return ''
  const dt = toDatetimeLocal(s)
  if (!dt) return s
  const [datePart, timePart] = dt.split('T')
  const [y, m, d] = datePart.split('-').map(Number)
  if (!y || !m || !d) return s

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const monthName = months[m - 1] || ''

  if (!timePart || opts.dateOnly) {
    return `${d} ${monthName} ${y}`
  }

  const [hh, mm] = (timePart || '00:00').split(':').map(Number)
  const ampm = hh >= 12 ? 'PM' : 'AM'
  const hour12 = hh % 12 === 0 ? 12 : hh % 12
  const minStr = String(mm || 0).padStart(2, '0')
  const timeFormatted = `${hour12}:${minStr} ${ampm}`

  if (opts.timeOnly) {
    return timeFormatted
  }

  return `${d} ${monthName} ${y}, ${timeFormatted}`
}

// dateRange renders a verification window as "from – to" with date and time.
export function dateRange(from, to, separator = ' – ') {
  if (!from && !to) return ''
  if (from && !to) return formatDateTime(from)
  if (!from && to) return formatDateTime(to)

  const fStr = formatDateTime(from)
  const tStr = formatDateTime(to)
  return `${fStr}${separator}${tStr}`
}
