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

  // Fire-on-change: any time the caller's fn identity changes
  // (typically because a filter / page state changed), run it
  // immediately so the UI doesn't wait up to `ms` for the next
  // background tick. Without this, switching tabs / changing
  // status on a filtered list would show stale data for ~8s.
  // We deliberately don't restart the interval here — that stays
  // owned by the (ms, enabled) effect below.
  useEffect(() => {
    if (!enabled) return
    if (typeof document !== 'undefined' && document.hidden) return
    fn?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fn, enabled])

  // Interval + visibility lifecycle. Independent of fn identity so
  // a parent recreating its callback on every render doesn't churn
  // the timer; we always read the latest fn via the ref.
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

    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      stop()
    }
  }, [ms, enabled])
}
