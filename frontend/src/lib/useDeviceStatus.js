import { useEffect, useRef, useState } from 'react'
import { morfin, MorfinError } from './morfin.js'

// The state machine that drives the operator's view of the fingerprint
// device. Designed so the operator never sees a dropdown or an "init"
// button — they plug in, the dot in the corner turns green, they place a
// finger, the system captures.
//
//   service_down   — daemon at localhost:8030 not reachable; install needed
//   no_device      — daemon up, no USB device plugged in
//   initializing   — device just appeared; we're calling init silently
//   ready          — initialized, idle, awaiting capture
//   capturing      — a capture/match call is in flight
//   error          — terminal SDK error; auto-resets on next poll
//
// Any state can transition back to no_device or service_down on the next
// poll — that's how mid-shift unplug recovers without a reload.

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
  const [device, setDevice] = useState(null) // {name, info: {SerialNo, Model, ...}}
  const [error, setError] = useState(null)
  // Track in a ref because the polling closure shouldn't re-render every tick.
  const stateRef = useRef({
    initialized: false, // have we successfully called initdevice on `device.name`?
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
      try {
        const devices = await morfin.getConnectedDevices()
        if (!alive) return
        if (devices.length === 0) {
          stateRef.current.initialized = false
          setDevice(null)
          setStatus(Status.NoDevice)
          setError(null)
          timer = setTimeout(tick, POLL_MS)
          return
        }
        const name = devices[0]
        // New device appeared (or different one) — re-init.
        if (!stateRef.current.initialized || device?.name !== name) {
          if (!stateRef.current.initInFlight) {
            stateRef.current.initInFlight = true
            setStatus(Status.Initializing)
            try {
              await morfin.init(name)
              const info = await morfin.getInfo(name)
              if (!alive) return
              stateRef.current.initialized = true
              setDevice({ name, info })
              setStatus(Status.Ready)
              setError(null)
            } catch (e) {
              if (!alive) return
              stateRef.current.initialized = false
              if (e instanceof MorfinError && e.kind === 'device') {
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
      } catch (e) {
        if (!alive) return
        stateRef.current.initialized = false
        setDevice(null)
        if (e instanceof MorfinError && e.kind === 'service') {
          setStatus(Status.ServiceDown)
        } else if (e instanceof MorfinError && e.kind === 'device') {
          setStatus(Status.NoDevice)
        } else {
          setStatus(Status.Error)
          setError(e)
        }
      }
      timer = setTimeout(tick, POLL_MS)
    }

    tick()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
    // device.name in deps is intentional — when a new device is detected
    // we want the polling cycle to re-evaluate immediately on the next
    // tick instead of waiting a full poll interval.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, device?.name])

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

  return { status, device, error, withCapturing }
}
