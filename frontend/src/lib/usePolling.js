import { useEffect, useRef } from 'react'

// usePolling — setInterval that respects document.visibilityState.
//
// Replaces the raw setInterval pattern used across the dashboards. The
// callback runs immediately on mount, then every `ms` milliseconds
// while the tab is visible. When the tab is hidden, the timer is
// cancelled (no network requests, no React renders). When the tab
// becomes visible again, we fire the callback once immediately to
// catch up on any state that changed while we were away, then resume
// the regular cadence.
//
// Why it matters: a laptop with the admin tab in the background was
// hitting 5 backend endpoints every 4 seconds × hours = wasted
// battery + non-trivial backend load × N admins. With this hook,
// background tabs cost zero.
//
// Caveats:
//   - The callback should be stable (use useCallback in the parent or
//     declare it inside useEffect). We don't depend on `fn` identity
//     so a parent recreating the function on every render won't
//     restart the timer prematurely; we always read the latest fn
//     through a ref.
//   - Setting `enabled=false` pauses without unmounting.

export function usePolling(fn, ms, { enabled = true } = {}) {
  const fnRef = useRef(fn)
  fnRef.current = fn

  // Single lifecycle effect — owns the immediate first-run, the
  // interval, AND the visibility lifecycle. Depends only on (ms,
  // enabled) so an inline arrow at the call site (fresh identity
  // every render) can't churn it.
  //
  // Historical note: an earlier version had a second effect keyed on
  // `[fn, enabled]` to "catch up when a filter changes." Passing an
  // inline arrow to that hook turned into an infinite render loop
  // (every render → new fn identity → effect fires → setState in
  // callback → new render → new identity → ...). Removed. Callers
  // that need "re-fire when a filter changes" should key on the
  // filter value themselves, or wrap fn in useCallback.
  useEffect(() => {
    if (!enabled || !ms || ms <= 0) return

    let timer = null
    function start() {
      if (timer !== null) return
      timer = setInterval(() => fnRef.current?.(), ms)
    }
    function stop() {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    }
    function onVisibility() {
      if (document.hidden) {
        stop()
      } else {
        // Catch up immediately on re-show, then resume the cadence.
        fnRef.current?.()
        start()
      }
    }

    if (!document.hidden) {
      // Fire once on mount so the UI doesn't wait up to `ms` for the
      // first tick.
      fnRef.current?.()
      start()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      stop()
    }
  }, [ms, enabled])
}
