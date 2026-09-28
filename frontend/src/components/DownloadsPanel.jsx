import { useEffect, useState } from 'react'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  EmptyState,
} from './ui/ui.jsx'
import { getDownloads, downloadOperatorClient } from '../lib/downloads.js'

// DownloadsPanel — the full Downloads experience (manifest fetch, button,
// progress bar, SmartScreen callout, install guide). Used by BOTH the
// admin Downloads tab and the client Downloads page so the install
// flow looks identical for both roles. Each role's outer page wraps
// this with its own AppShell + role-specific nav chrome.
//
// Behavioural notes that affect both portals:
//   - The download endpoint (/api/downloads/*) is open to admin and
//     client roles — the backend audits per-org, so an operator's
//     self-serve download lands in the same org bucket as an admin's.
//   - The "last downloaded" timestamp shows whoever last downloaded
//     in the same org. Operators see "last downloaded by admin 2 hours
//     ago" which is useful signal, not a leak.
//   - The 222+ MB bundle streams via fetch + ReadableStream so the
//     progress bar reflects real bytes-on-wire, not a fake spinner.

export default function DownloadsPanel({ heading = 'Verification agent client (Windows)' }) {
  const [data, setData] = useState(null)          // { items, last_download? }
  const [loadErr, setLoadErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [downloadErr, setDownloadErr] = useState('')
  const [copiedField, setCopiedField] = useState(null) // 'sha256' | 'filename' | null
  const [guideOpen, setGuideOpen] = useState(false)
  const [progress, setProgress] = useState(null)  // { loaded, total, startedAt }
  const [abortCtrl, setAbortCtrl] = useState(null)

  async function reload() {
    setLoadErr('')
    try {
      setData(await getDownloads())
    } catch (e) {
      setLoadErr(e.message || 'failed to load downloads')
    }
  }
  useEffect(() => { reload() }, [])

  async function onDownload() {
    setBusy(true)
    setDownloadErr('')
    const ctrl = new AbortController()
    setAbortCtrl(ctrl)
    const startedAt = Date.now()
    setProgress({ loaded: 0, total: 0, startedAt })
    try {
      await downloadOperatorClient({
        signal: ctrl.signal,
        onProgress: (loaded, total) => setProgress({ loaded, total, startedAt }),
      })
      // Small delay so the audit_log insert lands before we read it back.
      setTimeout(reload, 500)
    } catch (e) {
      setDownloadErr(e?.name === 'AbortError' ? 'Download cancelled.' : (e.message || 'download failed'))
    } finally {
      setBusy(false)
      setProgress(null)
      setAbortCtrl(null)
    }
  }

  function onCancel() { abortCtrl?.abort() }

  async function copy(field, value) {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedField(field)
      setTimeout(() => setCopiedField((cur) => (cur === field ? null : cur)), 1500)
    } catch {
      // clipboard blocked (insecure context) — the value is on screen anyway
    }
  }

  const item = data?.items?.[0] || null

  return (
    <div className="fv-bold">
      {loadErr && (
        <div className="mb-5 rounded-[12px] bg-[#F6EDDD] px-4 py-3 text-[14px] text-[#7A4F12]">{loadErr}</div>
      )}

      {data && !item && (
        <div className="rounded-[12px] border border-fv-line bg-fv-card">
          <EmptyState title="No installer published yet" body="It lands here as soon as it's built." />
        </div>
      )}

      {item && (
        <>
          {/* the bundle */}
          <section className="mb-4 overflow-hidden rounded-[12px] border border-fv-line bg-fv-card">
            <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-6 p-6">
              <InstallerArt className="h-36 w-36 shrink-0" />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="fv-display text-[24px] leading-tight tracking-[-0.02em] text-fv-ink">{heading}</h2>
                  {item.version && (
                    <span className="rounded-full bg-fv-card-focus px-3 py-1 text-[13px] text-fv-accent-deep">v{item.version}</span>
                  )}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Chip icon="file">
                    <span className="truncate">{item.filename}</span>
                    <button type="button" onClick={() => copy('filename', item.filename)}
                            className="ml-1 rounded-md px-1.5 py-0.5 text-[12px] text-fv-accent hover:bg-fv-card-focus">
                      {copiedField === 'filename' ? 'Copied' : 'Copy'}
                    </button>
                  </Chip>
                  <Chip icon="size">{formatBytes(item.size_bytes)}</Chip>
                  <Chip icon="windows">Windows 10 or 11</Chip>
                  <Chip icon="java">Java included</Chip>
                </div>

                <div className="mt-5 flex flex-wrap items-center gap-3">
                  {busy ? (
                    <button type="button" onClick={onCancel}
                            className="inline-flex items-center gap-2 rounded-[10px] border border-fv-line bg-fv-card px-5 py-3 text-[15px] text-fv-accent-deep hover:bg-fv-card-focus transition-colors">
                      <DIcon name="stop" />Cancel
                    </button>
                  ) : (
                    <button type="button" onClick={onDownload}
                            className="inline-flex items-center gap-2 rounded-[10px] bg-fv-accent px-5 py-3 text-[15px] text-white hover:bg-fv-accent-deep transition-colors">
                      <DIcon name="down" />Download the installer
                    </button>
                  )}
                </div>

                {busy && <DownloadProgress progress={progress} totalFallback={item.size_bytes} />}
                {downloadErr && (
                  <div className="mt-3 rounded-[10px] bg-[#F6EDDD] px-3 py-2 text-[13.5px] text-[#7A4F12]">{downloadErr}</div>
                )}
              </div>
            </div>
          </section>

          {/* what happens the first time you run it */}
          <section className="mb-4" aria-label="First run">
            <h3 className="mb-3 fv-display text-[18px] tracking-[-0.015em] text-fv-ink">First run on a new laptop</h3>
            <ol className="grid gap-3 sm:grid-cols-3">
              {[
                { art: ShieldArt, title: 'Windows warns', text: 'Click More info.' },
                { art: RunArt, title: 'Run anyway', text: 'The file is safe.' },
                { art: AdminArt, title: 'Allow admin', text: 'Say yes to the prompt.' },
              ].map(({ art: A, title, text }) => (
                <li key={title} className="flex items-center gap-4 rounded-[12px] border border-fv-line bg-fv-card p-4"
                    data-guide-title={title} data-guide={text}>
                  <A className="h-20 w-20 shrink-0" />
                  <div>
                    <p className="fv-display text-[16px] text-fv-ink">{title}</p>
                    <p className="text-[13.5px] text-fv-muted">{text}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          {/* the long version, folded away */}
          <details className="rounded-[12px] border border-fv-line bg-fv-card px-5 py-4">
            <summary className="cursor-pointer fv-display text-[16px] text-fv-accent-deep">Step-by-step install guide</summary>
            <ol className="mt-4 space-y-3 text-[14px] text-fv-muted">
              <li><span className="text-fv-ink">Before you start.</span> Windows 10 (May 2020 update or newer) or Windows 11, and administrator access. Java is inside the installer.</li>
              <li><span className="text-fv-ink">Download.</span> About {formatBytes(item.size_bytes)}. On a slow line it can take 5 to 15 minutes.</li>
              <li><span className="text-fv-ink">Move it across.</span> Installing on another laptop? Copy the file there by USB stick, email or shared drive.</li>
              <li><span className="text-fv-ink">Run as administrator.</span> Right-click the file, then Run as administrator, and walk through the three steps above. It takes about 90 seconds and adds a Desktop shortcut.</li>
              <li><span className="text-fv-ink">Sign in.</span> Open the Desktop shortcut, sign in as the agent, and plug in the fingerprint scanner. The device light turns violet when it's ready.</li>
              <li><span className="text-fv-ink">Removing it.</span> Settings, then Apps, find Verification Portal, then Uninstall.</li>
            </ol>
          </details>
        </>
      )}
    </div>
  )
}

// The installer bundle: a box with the app's disc, ready to go.
function InstallerArt({ className }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <ellipse cx="32" cy="57" rx="24" ry="4" fill="#EFEBF9" />
      <path d="M8 24h48v27a4 4 0 0 1-4 4H12a4 4 0 0 1-4-4z" fill="#F28C28" />
      <path d="M8 24h48v8H8z" fill="#D97A1E" />
      <path d="M28 24h8v31h-8z" fill="#D97A1E" />
      <path d="M12 12h40l4 12H8z" fill="#F7B37A" />
      <circle cx="32" cy="41" r="10" fill="#FFFFFF" />
      <circle cx="32" cy="41" r="9" fill="none" stroke="#5B3FA6" strokeWidth="1.6" />
      <path d="M32 35v9M28 40.5l4 4 4-4" fill="none" stroke="#5B3FA6" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="24" y="8" width="16" height="7" rx="3" fill="#43307D" />
    </svg>
  )
}
function ShieldArt({ className }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <rect x="6" y="12" width="52" height="40" rx="5" fill="#FFFFFF" stroke="#DDD5F2" strokeWidth="2" />
      <rect x="6" y="12" width="52" height="9" rx="4.5" fill="#5B3FA6" />
      <path d="M32 26l9 3.4v6.6c0 5.2-3.8 8.6-9 10-5.2-1.4-9-4.8-9-10v-6.6z" fill="#EFEBF9" stroke="#9A86D6" strokeWidth="2" />
      <path d="M32 31v6M32 41v1.5" stroke="#5B3FA6" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  )
}
function RunArt({ className }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <rect x="6" y="12" width="52" height="40" rx="5" fill="#FFFFFF" stroke="#DDD5F2" strokeWidth="2" />
      <rect x="6" y="12" width="52" height="9" rx="4.5" fill="#5B3FA6" />
      <rect x="14" y="27" width="24" height="4" rx="2" fill="#DDD5F2" />
      <rect x="14" y="35" width="16" height="4" rx="2" fill="#EFEBF9" />
      <rect x="30" y="38" width="24" height="12" rx="4" fill="#5B3FA6" />
      <path d="M36 44h12M44 40l4 4-4 4" stroke="#FFFFFF" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="26" cy="47" r="5" fill="#F3EAD9" stroke="#E2D4BE" strokeWidth="1.4" />
    </svg>
  )
}
function AdminArt({ className }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <rect x="10" y="10" width="44" height="44" rx="8" fill="#EFEBF9" />
      <path d="M32 18l12 4.6v9c0 7.4-5 12.4-12 14.4-7-2-12-7-12-14.4v-9z" fill="#5B3FA6" />
      <path d="M26 32.6l4.4 4.4 8.6-9.4" fill="none" stroke="#FFFFFF" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="47" cy="45" r="9" fill="#138808" />
      <path d="M43 45.2l2.6 2.6 5-5.6" fill="none" stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
function Chip({ icon, children }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-[10px] bg-fv-page px-3 py-1.5 text-[13.5px] text-fv-ink">
      <DIcon name={icon} />{children}
    </span>
  )
}
function DIcon({ name }) {
  const d = {
    down: <><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M4.5 19.5h15" /></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
    file: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>,
    size: <><rect x="3" y="7" width="18" height="10" rx="2" /><path d="M7 7v10M17 7v10" /></>,
    windows: <><path d="M4 6.5l7-1v7H4zM13 5.2l7-1v8.3h-7zM4 13.5h7v6l-7-1zM13 13.5h7v8.3l-7-1z" /></>,
    java: <><path d="M9 4c3 2.5-1.5 4 1 6.5M13 3c3 2.5-1.5 4 1 6.5" /><path d="M6 14c3 1.6 9 1.6 12 0M7 18c2.4 1.2 7.6 1.2 10 0" /></>,
  }[name]
  return <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-fv-accent" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
}

function DownloadProgress({ progress, totalFallback }) {
  const total = progress?.total || totalFallback || 0
  const loaded = progress?.loaded || 0
  const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0

  let speed = ''
  let eta = ''
  if (progress?.startedAt && loaded > 0) {
    const elapsedSec = (Date.now() - progress.startedAt) / 1000
    if (elapsedSec > 0.5) {
      const bps = loaded / elapsedSec
      speed = formatSpeed(bps)
      if (total > 0 && bps > 0) {
        const remainingSec = (total - loaded) / bps
        eta = formatEta(remainingSec)
      }
    }
  }

  return (
    <div className="mt-4">
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-fv-card-focus">
        <div
          className="h-full bg-fv-accent transition-[width] duration-150"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
        <span>
          {formatBytes(loaded)}{total > 0 ? ` of ${formatBytes(total)}` : ''}
          {total > 0 ? ` · ${pct}%` : ''}
        </span>
        <span>{speed}{speed && eta ? ' · ' : ''}{eta}</span>
      </div>
    </div>
  )
}

function FactRow({ label, value, mono, onCopy, copied }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">{label}</div>
      <div className="flex items-center gap-2">
        <div className={`flex-1 text-sm text-slate-800 ${mono ? 'font-mono break-all' : ''}`}>
          {value}
        </div>
        {onCopy && (
          <button
            type="button"
            onClick={onCopy}
            className="px-2 py-1 rounded border border-slate-200 bg-white text-xs text-slate-600 hover:bg-slate-50"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </div>
    </div>
  )
}

function formatBytes(n) {
  if (typeof n !== 'number' || n <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0, v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}

function formatDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

function formatRelativeOrAbsolute(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const diffMs = Date.now() - d.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? '' : 's'} ago`
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

function formatSpeed(bps) {
  if (!isFinite(bps) || bps <= 0) return ''
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  let i = 0, v = bps
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}

function formatEta(sec) {
  if (!isFinite(sec) || sec <= 0) return ''
  if (sec < 60) return `~${Math.ceil(sec)}s left`
  if (sec < 3600) return `~${Math.ceil(sec / 60)} min left`
  return `~${(sec / 3600).toFixed(1)} hr left`
}
