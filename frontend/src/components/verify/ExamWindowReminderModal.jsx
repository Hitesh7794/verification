import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { toDatetimeLocal } from '../../lib/dates.js'

function formatDate(isoStr) {
  if (!isoStr) return '—'
  try {
    const s = String(isoStr).trim()
    const dt = toDatetimeLocal(s)
    if (dt) {
      const [datePart, timePart] = dt.split('T')
      const [y, m, d] = datePart.split('-').map(Number)
      if (y && m && d) {
        const dateObj = new Date(y, m - 1, d)
        const dateFormatted = dateObj.toLocaleDateString('en-IN', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        })
        if (timePart && timePart !== '00:00') {
          const [hh, mm] = timePart.split(':').map(Number)
          const ampm = hh >= 12 ? 'PM' : 'AM'
          const hour12 = hh % 12 === 0 ? 12 : hh % 12
          const minStr = String(mm || 0).padStart(2, '0')
          return `${dateFormatted} at ${hour12}:${minStr} ${ampm}`
        }
        return dateFormatted
      }
    }
  } catch {}
  return isoStr
}

function getDaysRemaining(isoDateStr) {
  if (!isoDateStr) return null
  try {
    const s = String(isoDateStr).trim()
    const dt = toDatetimeLocal(s)
    if (dt) {
      const [datePart, timePart] = dt.split('T')
      const [y, m, d] = datePart.split('-').map(Number)
      const [hh, mm] = (timePart || '00:00').split(':').map(Number)
      const target = new Date(y, m - 1, d, hh || 0, mm || 0, 0)
      const now = new Date()
      const diffMs = target.getTime() - now.getTime()
      if (diffMs <= 0) return 0
      const diffHours = diffMs / (1000 * 60 * 60)
      if (diffHours < 24 && target.getDate() === now.getDate()) return 0
      const diffDays = Math.ceil(diffHours / 24)
      return diffDays
    }
  } catch {}
  return null
}

export default function ExamWindowReminderModal({
  open,
  onClose,
  type = 'future', // 'future' | 'expired'
  examName = '',
  examCode = '',
  verificationFrom = '',
  verificationTo = '',
  message = '',
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open || typeof document === 'undefined') return null

  const daysRemaining = getDaysRemaining(verificationFrom)
  const isFuture = type === 'future'

  let countdownText = ''
  if (isFuture && daysRemaining !== null) {
    if (daysRemaining === 0) {
      countdownText = 'Opens today'
    } else if (daysRemaining === 1) {
      countdownText = 'Opens tomorrow'
    } else if (daysRemaining > 1) {
      countdownText = `Opens in ${daysRemaining} days`
    } else {
      countdownText = 'Upcoming'
    }
  }

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6">
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-0 bg-stone-900/60 backdrop-blur-sm"
            onClick={onClose}
          />

          {/* Dialog Container */}
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="exam-window-title"
            initial={{ opacity: 0, y: 16, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.95 }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            className="relative w-full max-w-lg rounded-2xl bg-white border border-stone-200 shadow-2xl shadow-stone-900/25 overflow-hidden z-10"
          >
            {/* Top Ambient Accent Glow */}
            <div
              className={`h-2 w-full ${
                isFuture
                  ? 'bg-gradient-to-r from-amber-500 via-amber-400 to-amber-600'
                  : 'bg-gradient-to-r from-stone-500 via-rose-500 to-stone-600'
              }`}
            />

            <div className="p-6 sm:p-7">
              {/* Header Icon + Title */}
              <div className="flex items-start gap-4">
                <div
                  className={`h-12 w-12 rounded-2xl flex items-center justify-center shrink-0 border ${
                    isFuture
                      ? 'bg-amber-50 text-amber-600 border-amber-200/80 shadow-sm'
                      : 'bg-rose-50 text-rose-600 border-rose-200/80 shadow-sm'
                  }`}
                >
                  <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
                  </svg>
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wider ${
                        isFuture
                          ? 'bg-amber-100/80 text-amber-900 border border-amber-300/60'
                          : 'bg-rose-100/80 text-rose-900 border border-rose-300/60'
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          isFuture ? 'bg-amber-500 animate-pulse' : 'bg-rose-500'
                        }`}
                      />
                      {isFuture ? 'Upcoming Examination' : 'Verification Expired'}
                    </span>
                    {countdownText && (
                      <span className="px-2 py-0.5 rounded-md bg-stone-100 text-stone-700 text-xs font-medium font-mono">
                        {countdownText}
                      </span>
                    )}
                  </div>

                  <h3
                    id="exam-window-title"
                    className="mt-2 text-xl font-bold text-stone-900 tracking-tight"
                  >
                    {isFuture
                      ? 'Verification Starts on Scheduled Date'
                      : 'Verification Window is Closed'}
                  </h3>
                </div>

                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg p-1.5 text-stone-400 hover:text-stone-700 hover:bg-stone-100 transition-colors"
                  aria-label="Close"
                >
                  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* Exam & Date Card */}
              <div className="mt-5 rounded-xl border border-stone-200 bg-stone-50/70 p-4 space-y-3.5">
                {(examName || examCode) && (
                  <div className="flex items-start justify-between gap-3 border-b border-stone-200/80 pb-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wider text-stone-500">
                        Assigned Examination
                      </p>
                      <p className="text-sm font-bold text-stone-900 mt-0.5">
                        {examName || examCode}
                      </p>
                    </div>
                    {examCode && (
                      <span className="px-2 py-1 rounded bg-white border border-stone-200 font-mono text-xs font-semibold text-stone-800 shrink-0">
                        {examCode}
                      </span>
                    )}
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-0.5">
                  <div className="rounded-lg bg-white border border-stone-200/80 p-3 shadow-2xs">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-700">
                      🗓️ Verification Starts
                    </p>
                    <p className="text-sm font-bold text-stone-900 mt-1">
                      {formatDate(verificationFrom)}
                    </p>
                    {verificationFrom && (
                      <p className="text-[11px] font-mono text-stone-500 mt-0.5">
                        {verificationFrom}
                      </p>
                    )}
                  </div>

                  <div className="rounded-lg bg-white border border-stone-200/80 p-3 shadow-2xs">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-stone-500">
                      🏁 Verification Closes
                    </p>
                    <p className="text-sm font-bold text-stone-900 mt-1">
                      {formatDate(verificationTo)}
                    </p>
                    {verificationTo && (
                      <p className="text-[11px] font-mono text-stone-500 mt-0.5">
                        {verificationTo}
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {/* Explanatory Message */}
              <div className="mt-4 rounded-xl bg-amber-50/60 border border-amber-200/60 p-3.5 text-xs text-amber-900 leading-relaxed flex items-start gap-2.5">
                <svg className="h-4 w-4 text-amber-700 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                <div>
                  <span className="font-semibold">Operator Notice: </span>
                  {message || (
                    isFuture
                      ? `Candidate verification for this exam will unlock on ${formatDate(verificationFrom) || verificationFrom}. Biometric lookups cannot be started before the official window opens.`
                      : `The verification window for this examination concluded on ${formatDate(verificationTo) || verificationTo}. Lookups for new candidates are locked.`
                  )}
                </div>
              </div>

              {/* Action Buttons */}
              <div className="mt-6 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={onClose}
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 transition-all"
                >
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  Understood, Return to Dashboard
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body
  )
}
