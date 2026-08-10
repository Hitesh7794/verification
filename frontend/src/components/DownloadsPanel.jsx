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

export default function DownloadsPanel({ heading = 'Operator client (Windows)' }) {
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
    <>
      {loadErr && (
        <div className="mb-6 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
          {loadErr}
        </div>
      )}

      {data && !item && (
        <Card>
          <CardBody>
            <EmptyState
              title="No installer published yet"
              body="The portal admin will publish an operator install bundle here once it's ready. Check back shortly."
            />
          </CardBody>
        </Card>
      )}

      {item && (
        <>
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>
                {heading}{' '}
                {item.version && <Badge tone="indigo">v{item.version}</Badge>}
              </CardTitle>
            </CardHeader>
            <CardBody>
              <div className="grid gap-5 sm:grid-cols-3">
                <FactRow label="Filename" value={item.filename} mono onCopy={() => copy('filename', item.filename)} copied={copiedField === 'filename'} />
                <FactRow label="Size" value={formatBytes(item.size_bytes)} />
                <FactRow label="Last updated" value={formatDate(item.updated_at)} />
              </div>

              <div className="mt-5">
                <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">SHA256</div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-mono text-slate-700 break-all">
                    {item.sha256}
                  </code>
                  <button
                    type="button"
                    onClick={() => copy('sha256', item.sha256)}
                    className="px-3 py-2 rounded-md border border-slate-300 bg-white text-sm text-slate-700 hover:bg-slate-50"
                  >
                    {copiedField === 'sha256' ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  Compare this hash after download to verify the file wasn't corrupted in transit.
                </p>
              </div>

              <div className="mt-6 flex flex-wrap items-center gap-3">
                {busy ? (
                  <Button variant="secondary" onClick={onCancel} size="lg">
                    Cancel
                  </Button>
                ) : (
                  <Button onClick={onDownload} size="lg">
                    Download {item.filename}
                  </Button>
                )}
                {!busy && data?.last_download && (
                  <span className="text-xs text-slate-500">
                    Last downloaded {formatRelativeOrAbsolute(data.last_download.at)}
                    {data.last_download.username ? ` by ${data.last_download.username}` : ''}.
                  </span>
                )}
              </div>

              {busy && (
                <DownloadProgress progress={progress} totalFallback={item.size_bytes} />
              )}

              {downloadErr && (
                <div className="mt-3 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
                  {downloadErr}
                </div>
              )}
            </CardBody>
          </Card>

          <Card className="mb-6 border-amber-200">
            <CardHeader className="border-amber-100 bg-amber-50/40">
              <CardTitle className="text-amber-900">First-time install — what to expect</CardTitle>
            </CardHeader>
            <CardBody>
              <p className="text-sm text-slate-700">
                Windows will show a blue <strong>“Windows protected your PC”</strong> warning the first time
                you run this installer. The file is safe — Windows shows the warning for any installer that
                hasn't yet built up SmartScreen reputation. To proceed:
              </p>
              <ol className="mt-3 list-decimal pl-5 text-sm text-slate-700 space-y-1">
                <li>Click <strong>More info</strong> on the warning dialog.</li>
                <li>Click <strong>Run anyway</strong> at the bottom.</li>
                <li>Accept the User Account Control (UAC) prompt to allow administrator install.</li>
              </ol>
              <p className="mt-3 text-xs text-amber-800">
                Java is bundled inside the installer — you do NOT need to install Java separately or
                configure PATH. Just run the installer.
              </p>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>
                <button
                  type="button"
                  className="text-left w-full flex items-center justify-between"
                  onClick={() => setGuideOpen((v) => !v)}
                  aria-expanded={guideOpen}
                >
                  <span>Install guide</span>
                  <span className="text-xs text-slate-500 font-normal">
                    {guideOpen ? 'Hide' : 'Show'}
                  </span>
                </button>
              </CardTitle>
            </CardHeader>
            {guideOpen && (
              <CardBody>
                <ol className="list-decimal pl-5 space-y-3 text-sm text-slate-700">
                  <li>
                    <strong>Prerequisites</strong> — Windows 10 (May 2020 Update or newer) or Windows 11
                    and administrator access on the laptop. <em>No Java install required</em> — Java is
                    bundled inside this installer.
                  </li>
                  <li>
                    <strong>Download</strong> — click the button above to download the installer. The file
                    is around {formatBytes(item.size_bytes)}; over a slow connection it can take 5–15 minutes.
                  </li>
                  <li>
                    <strong>Transfer</strong> — if installing on a different laptop, copy the file there
                    (USB stick, email, shared drive).
                  </li>
                  <li>
                    <strong>Run as administrator</strong> — right-click the installer → <em>Run as administrator</em>.
                    Walk through the SmartScreen warning as described above. The installer registers the
                    fingerprint daemon, imports the security certificates, sets the portal URL as the browser
                    homepage, and adds a Desktop shortcut. Takes about 90 seconds.
                  </li>
                  <li>
                    <strong>Sign in</strong> — open Chrome / Edge from the new Desktop shortcut, sign in
                    with the operator credentials you already have. Plug in the fingerprint device. The
                    device indicator turns green when ready.
                  </li>
                  <li>
                    <strong>Verify the SHA256</strong> (optional) — if anti-virus flags unsigned installers,
                    share the SHA256 above so your IT can confirm the file matches.
                  </li>
                </ol>
                <p className="mt-4 text-xs text-slate-500">
                  Need to uninstall? Go to <em>Settings → Apps</em> on the laptop, find
                  <strong> Verification Portal</strong>, click Uninstall.
                </p>
              </CardBody>
            )}
          </Card>
        </>
      )}
    </>
  )
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
      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
        <div
          className="h-full bg-indigo-500 transition-[width] duration-150"
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
