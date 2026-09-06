import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { createPortal } from 'react-dom'

// Animated confirmation dialog. Replaces browser confirm() for
// destructive actions (deletes, force-close, etc). Backdrop fades in;
// the modal scales up from 96% with a gentle spring. Escape or a
// backdrop click closes it (unless it is mid-confirm).
//
// Usage:
//
//   const [open, setOpen] = useState(false)
//   ...
//   <Button onClick={() => setOpen(true)}>Delete</Button>
//   <ConfirmDialog
//     open={open}
//     onCancel={() => setOpen(false)}
//     onConfirm={async () => { await api.delete(...) }}
//     title="Delete client?"
//     body="This is only allowed if the client has no exams."
//     confirmLabel="Delete"
//     tone="danger"
//   />
//
// onConfirm may be async. While it's running the buttons disable and
// the confirm button shows a spinner. Errors thrown from onConfirm are
// caught and shown inline; the dialog stays open so the user can retry.
export default function ConfirmDialog({
  open,
  onCancel,
  onConfirm,
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger', // 'danger' | 'warn' | 'primary'
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // Reset transient state whenever the dialog opens.
  useEffect(() => {
    if (open) {
      setBusy(false)
      setErr('')
    }
  }, [open])

  // ESC closes when idle.
  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onCancel])

  async function handleConfirm() {
    setBusy(true)
    setErr('')
    try {
      await onConfirm()
    } catch (e) {
      setErr(e?.message || 'Something went wrong')
      setBusy(false)
    }
    // On success we don't clear busy — the parent will unmount us via
    // `open=false`. Leaving busy=true prevents a double-click race.
  }

  const toneStyles = {
    danger:  { icon: 'bg-rose-100 text-rose-700',       btn: 'bg-rose-600 hover:bg-rose-700 focus:ring-rose-500' },
    warn:    { icon: 'bg-amber-100 text-amber-800',     btn: 'bg-amber-600 hover:bg-amber-700 focus:ring-amber-500' },
    primary: { icon: 'bg-stone-100 text-stone-800',     btn: 'bg-brand-600 hover:bg-brand-700 focus:ring-stone-700' },
  }[tone] || {}

  if (typeof document === 'undefined') return null

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 bg-stone-900/40 backdrop-blur-sm"
            onClick={() => !busy && onCancel()}
          />

          {/* Dialog */}
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
            initial={{ opacity: 0, y: 12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 380, damping: 28 }}
            className="relative w-full max-w-md rounded-2xl bg-warm-surface border border-warm shadow-2xl overflow-hidden"
          >
            <div className="p-6">
              <div className="flex items-start gap-4">
                <span className={`grid place-items-center h-11 w-11 rounded-full shrink-0 ${toneStyles.icon}`}>
                  {tone === 'danger' ? <IconWarning /> : tone === 'warn' ? <IconAlert /> : <IconCheck />}
                </span>
                <div className="flex-1 min-w-0">
                  <h2 id="confirm-dialog-title" className="text-base font-semibold text-ink-900 tracking-tight">
                    {title}
                  </h2>
                  {body && (
                    <div className="mt-1.5 text-sm text-stone-600 whitespace-pre-line leading-relaxed">
                      {body}
                    </div>
                  )}
                </div>
              </div>

              {err && (
                <div className="mt-4 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-700">
                  {err}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 px-6 py-3 bg-[#F6F8FA] border-t border-warm">
              <button
                type="button"
                onClick={onCancel}
                disabled={busy}
                className="inline-flex items-center px-4 py-2 text-sm font-medium rounded-lg text-stone-700 hover:bg-stone-100 focus:outline-none focus:ring-2 focus:ring-stone-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {cancelLabel}
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={busy}
                autoFocus
                className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-offset-1 disabled:opacity-70 disabled:cursor-not-allowed transition-colors ${toneStyles.btn}`}
              >
                {busy && <Spinner />}
                {busy ? 'Working…' : confirmLabel}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

function IconWarning() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
      <line x1="12" y1="9" x2="12" y2="13"/>
      <line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  )
}
function IconAlert() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="8" x2="12" y2="12"/>
      <line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
  )
}
function IconCheck() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  )
}
function Spinner() {
  return (
    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.3" strokeWidth="4" />
      <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    </svg>
  )
}
