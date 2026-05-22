import { useEffect, useRef, useState } from 'react'
import { pollConnected, getClient, isServiceError, isDeviceError } from './fingerprint/registry.js'

// The state machine that drives the operator's view of the fingerprint
// device. Designed so the operator never sees a dropdown or an "init"
// button — they plug in, the dot in the corner turns green, they place a
// finger, the system captures.
//
//   service_down   — neither daemon at :8030/:8090 is reachable; install needed
//   no_device      — at least one daemon is up, no device plugged in
//   initializing   — device just appeared; we're calling init silently
//   ready          — initialized, idle, awaiting capture
//   capturing      — a capture/match call is in flight
//   error          — terminal SDK error; auto-resets on next poll
//
// Any state can transition back to no_device or service_down on the next
// poll — that's how mid-shift unplug recovers without a reload.
//
// Multi-vendor (added 2026-05-15): the polling tick fans out to the
// registry, which probes both Mantra MorFin and Startek/ACPL daemons in
// parallel. Whichever has a connected device wins; the active vendor
// is exposed alongside `device` so the React component can both:
//   (a) call the right client's match() in the capture handler
//   (b) surface "Device ready · Mantra MFS500" vs "... · Startek FM220U"

export const Status = {
  ServiceDown: 'service_down',
  NoDevice: 'no_device',
  Initializing: 'initializing',
  Ready: 'ready',
  Capturing: 'capturing',
  Error: 'error',
}

const POLL_MS = 2000

export function useDeviceStatus({ enabled = true } = {}) {
  const [status, setStatus] = useState(Status.ServiceDown)
  // device.vendor (Vendor enum), device.name (model string), device.info ({SerialNo, Model, ...})
  const [device, setDevice] = useState(null)
  const [error, setError] = useState(null)
  // Track in a ref because the polling closure shouldn't re-render every tick.
  const stateRef = useRef({
    initialized: false, // have we successfully called init on the current vendor/device?
    initInFlight: false, // suppress duplicate init calls when polling overlaps
    capturing: false, // pause polling while a capture is happening
  })

  useEffect(() => {
    if (!enabled) return
    let alive = true
    let timer

    async function tick() {
      if (!alive) return
      // Don't poll on top of an in-flight capture. The capture call will
      // re-poll itself on completion.
      if (stateRef.current.capturing) {
        timer = setTimeout(tick, POLL_MS)
        return
      }
      let pollRes
      try {
        pollRes = await pollConnected()
      } catch (e) {
        // pollConnected catches per-vendor errors internally, so a throw
        // here is genuinely unexpected. Surface as terminal error.
        if (!alive) return
        stateRef.current.initialized = false
        setDevice(null)
        setStatus(Status.Error)
        setError(e)
        timer = setTimeout(tick, POLL_MS)
        return
      }
      if (!alive) return

      const { active, serviceErrors } = pollRes

      if (!active) {
        // Nothing connected on either vendor. Distinguish between
        // "both daemons down" (service-down) and "daemon up but no
        // device" (no-device). If every vendor is service-down, show
        // service-down; otherwise show no-device.
        stateRef.current.initialized = false
        setDevice(null)
        const vendors = Object.keys(serviceErrors)
        const allDown = vendors.every((v) => isServiceError(serviceErrors[v]))
        if (allDown && vendors.length > 0) {
          setStatus(Status.ServiceDown)
          // Surface the first vendor's error message for the banner.
          setError(serviceErrors[vendors[0]])
        } else {
          setStatus(Status.NoDevice)
          setError(null)
        }
        timer = setTimeout(tick, POLL_MS)
        return
      }

      // A vendor reports a connected device. Init the device if we
      // haven't yet, or re-init if the active vendor/name changed.
      const changed =
        !stateRef.current.initialized ||
        device?.vendor !== active.vendor ||
        device?.name !== active.name

      if (changed) {
        if (!stateRef.current.initInFlight) {
          stateRef.current.initInFlight = true
          setStatus(Status.Initializing)
          try {
            await active.client.init(active.name)
            const info = await active.client.getInfo(active.name)
            if (!alive) return
            stateRef.current.initialized = true
            setDevice({
              vendor: active.vendor,
              name: active.name,
              label: active.label,
              threshold: active.threshold,
              info,
            })
            setStatus(Status.Ready)
            setError(null)
          } catch (e) {
            if (!alive) return
            stateRef.current.initialized = false
            if (isDeviceError(e)) {
              setStatus(Status.NoDevice)
            } else {
              setStatus(Status.Error)
              setError(e)
            }
          } finally {
            stateRef.current.initInFlight = false
          }
        }
      } else {
        setStatus(Status.Ready)
        setError(null)
      }
      timer = setTimeout(tick, POLL_MS)
    }

    tick()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
    // device.vendor + device.name in deps is intentional — when a new
    // device is detected (or vendor switches) we want the polling cycle
    // to re-evaluate immediately on the next tick instead of waiting a
    // full poll interval.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, device?.vendor, device?.name])

  // Wrap a fingerprint operation so the state machine pauses polling and
  // reflects "capturing" while it's in flight. The caller's promise is
  // returned as-is.
  function withCapturing(fn) {
    return async (...args) => {
      stateRef.current.capturing = true
      setStatus(Status.Capturing)
      try {
        const out = await fn(...args)
        return out
      } finally {
        stateRef.current.capturing = false
        // The next poll tick will pick the right post-capture status
        // (Ready if device still present, NoDevice if unplugged, etc).
        setStatus((s) => (s === Status.Capturing ? Status.Ready : s))
      }
    }
  }

  return { status, device, error, withCapturing, getClient }
}
