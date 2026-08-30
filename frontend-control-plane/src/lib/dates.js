// Date and time formatting helpers shared across catalog, exam, and operator screens.

export function dateOnly(value) {
  if (!value) return ''
  const s = String(value).trim()
  const t = s.indexOf('T')
  const space = s.indexOf(' ')
  const splitIdx = t !== -1 ? t : space
  return splitIdx === -1 ? s : s.slice(0, splitIdx)
}

// toDatetimeLocal formats any ISO/RFC 3339 or date string to
// YYYY-MM-DDTHH:MM for HTML5 <input type="datetime-local">.
//
// Timezone handling: if the incoming value carries an offset (Z or
// +/-HH:MM), we CONVERT to IST (Asia/Kolkata) before formatting so
// the user sees the wall-clock time they typed originally. The
// backend (parseDateTimeWindow) parses naive datetime-local values
// as IST too, so a round-trip
//   DB (UTC) → toDatetimeLocal → input → PATCH → backend → DB
// preserves the original wall-clock moment.
//
// Before this fix, we stripped the tz suffix and returned raw UTC
// hours in the input — a timestamp stored as 11:00 UTC rendered as
// "11:00" in the picker, which the user read as 11:00 IST and, on
// save, the backend parsed as 11:00 IST = 05:30 UTC. Every edit
// drifted the value by 5.5 hours.
export function toDatetimeLocal(value, defaultTime = '00:00') {
  if (!value) return ''
  let s = String(value).trim()
  if (!s) return ''
  if (s.length >= 10 && s[10] === ' ') {
    s = s.slice(0, 10) + 'T' + s.slice(11)
  }
  // Bare date (no time) — pad with the default time. No tz math to do.
  if (!s.includes('T')) {
    return `${s}T${defaultTime}`
  }
  // If a tz suffix is present, convert to IST for display.
  if (/[zZ]$|[+\-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s)
    if (!isNaN(d.getTime())) {
      // en-CA gives YYYY-MM-DD; en-GB 24h gives HH:mm — both stable
      // across locales, and the timeZone option pins the output to
      // IST regardless of the viewer's browser locale/tz.
      const opts = { timeZone: 'Asia/Kolkata', hour12: false }
      const date = d.toLocaleDateString('en-CA', opts)
      const time = d.toLocaleTimeString('en-GB', { ...opts, hour: '2-digit', minute: '2-digit' })
      return `${date}T${time}`
    }
  }
  // Naive datetime — the string is already in the wall-clock format
  // the picker wants. Trim to minute precision.
  const parts = s.split('T')
  const datePart = parts[0]
  const timePart = (parts[1] || '').slice(0, 5)
  return `${datePart}T${timePart || defaultTime}`
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
