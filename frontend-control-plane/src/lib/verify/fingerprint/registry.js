// Multi-vendor fingerprint registry.
//
// The portal supports two fingerprint daemons running concurrently on an
// operator laptop. Rather than make the operator pick which vendor's
// device they're using, we poll both in parallel and bind to whichever
// has a device connected. Same plug-and-play UX as the single-vendor
// case; nothing changes for the operator.
//
//   ┌─ operator laptop ────────────────────────────────────────────────┐
//   │  Browser ── /api/* ───────────────▶ EC2 backend                  │
//   │  Browser ── :8030 ── morfin ───── USB ──▶ MELO041 / MFS500 / ... │
//   │  Browser ── :8090 ── startek ──── USB ──▶ FM220U L1 / AST300     │
//   └──────────────────────────────────────────────────────────────────┘
//
// First daemon to report a connected device wins the session. If the
// operator unplugs the active device, the next poll re-arbitrates and
// the banner re-renders.
//
// This module re-exports a vendor-neutral client. Callers (the polling
// hook and the React component) don't know which SDK is running under
// the hood — they just call .getConnectedDevices, .init, .match against
// what the registry hands them.

import { morfin, MorfinError } from '../morfin.js'
import { startek, StartekError } from './startek.js'
import { Vendor, DefaultThresholds, VendorLabel } from './types.js'

export { Vendor, DefaultThresholds, VendorLabel }

// Concrete clients keyed by vendor enum. New vendor support = one entry
// here + one client module + one entry in DefaultThresholds.
const CLIENTS = {
  [Vendor.Mantra]: morfin,
  [Vendor.Startek]: startek,
}

// Vendor probe order. Mantra is listed first because it's been in
// production longer; if both are connected at the same time (unlikely
// in practice, since most operator laptops will have one device), the
// first to report wins. Easy to flip later via env var if a deployment
// prefers Startek by default.
const PROBE_ORDER = [Vendor.Mantra, Vendor.Startek]

// Result shape returned by pollConnected. `active` is null when neither
// vendor has a device connected; the caller treats that as the "no
// device" state. `serviceErrors` carries per-vendor service-level
// failures (daemon not running) so the polling hook can surface a
// useful banner even when both daemons are down.
//
//   {
//     active: { vendor: 'mantra' | 'startek', name: 'MFS500', client },
//     serviceErrors: { mantra: <Error|null>, startek: <Error|null> },
//   }
export async function pollConnected() {
  const probes = PROBE_ORDER.map(async (vendor) => {
    const client = CLIENTS[vendor]
    try {
      const devices = await client.getConnectedDevices()
      return { vendor, devices, error: null }
    } catch (e) {
      return { vendor, devices: [], error: e }
    }
  })
  const results = await Promise.all(probes)

  const serviceErrors = {}
  let active = null
  for (const r of results) {
    if (r.error) {
      // Service-level errors (daemon not reachable) are noted but don't
      // disqualify the other vendor. Device-level / SDK errors are
      // similarly recorded — useDeviceStatus decides how to render.
      serviceErrors[r.vendor] = r.error
      continue
    }
    serviceErrors[r.vendor] = null
    if (r.devices.length > 0 && active === null) {
      active = {
        vendor: r.vendor,
        name: r.devices[0],
        client: CLIENTS[r.vendor],
        threshold: DefaultThresholds[r.vendor],
        label: VendorLabel[r.vendor],
      }
    }
  }

  return { active, serviceErrors }
}

// Look up a client by vendor — used by FingerprintCapture once the
// polling hook has identified which vendor is active.
export function getClient(vendor) {
  return CLIENTS[vendor] || null
}

// Heuristic: is `err` a "service unreachable" error from any vendor's
// client? useDeviceStatus uses this to decide between ServiceDown and
// other failure modes when only one vendor's probe fails.
export function isServiceError(err) {
  if (err instanceof MorfinError) return err.kind === 'service'
  if (err instanceof StartekError) return err.kind === 'service'
  return false
}

// Same for device-level errors (device not connected, no fingerprint
// found, etc.) — the UI routes these to "plug in the device" state.
export function isDeviceError(err) {
  if (err instanceof MorfinError) return err.kind === 'device'
  if (err instanceof StartekError) return err.kind === 'device'
  return false
}
