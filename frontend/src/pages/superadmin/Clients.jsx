import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import AppShell from '../../components/shell/AppShell.jsx'
import SuperTabs from '../../components/shell/SuperTabs.jsx'
import {
  Button,
  Card,
  CardBody,
  Input,
  Label,
  PageHeader,
} from '../../components/ui/ui.jsx'
import { Icon, Pill } from '../../components/ui/extras.jsx'
import { FadeIn } from '../../components/ui/motion.jsx'
import {
  listClients,
  createClient,
  toggleClientVisibility,
  closeClient,
  reopenClient,
} from '../../lib/superadmin/examCatalog.js'

// Superadmin > Clients — the top-level exam-body catalog.
// A client is the conducting authority (UP Govt, NTA); it owns exams.
// Every row has inline Visible/Hidden + Close/Reopen buttons (no modals).
export default function Clients() {
  const [clients, setClients] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newNotes, setNewNotes] = useState('')
  const [saving, setSaving] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      setClients(await listClients())
    } catch (e) {
      setErr(e.message || 'Could not load clients')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  async function onCreate(e) {
    e.preventDefault()
    if (!newName.trim()) return
    setSaving(true)
    setErr('')
    try {
      await createClient({ name: newName.trim(), notes: newNotes.trim() })
      setNewName('')
      setNewNotes('')
      setCreating(false)
      await refresh()
    } catch (e) {
      const status = e.status ? ` (HTTP ${e.status})` : ''
      const backendMsg = e.body?.error ? `: ${e.body.error}` : ''
      setErr(`${e.message || 'Create failed'}${status}${backendMsg}`)
      // eslint-disable-next-line no-console
      console.error('createClient failed', { status: e.status, body: e.body, message: e.message })
    } finally {
      setSaving(false)
    }
  }

  async function onToggleVisibility(id) {
    await toggleClientVisibility(id)
    await refresh()
  }

  async function onClose(id) {
    if (!confirm('Close this client? It stays visible in history; existing exams under it will still show.')) return
    await closeClient(id)
    await refresh()
  }

  async function onReopen(id) {
    await reopenClient(id)
    await refresh()
  }

  return (
    <AppShell>
      <SuperTabs />
      <FadeIn>
        <PageHeader
          title="Clients"
          subtitle="Exam-conducting bodies. Each client owns its exams."
          right={
            <Button onClick={() => setCreating(v => !v)}>
              <Icon.Plus className="h-4 w-4 mr-1" />
              {creating ? 'Cancel' : 'New client'}
            </Button>
          }
        />

        {err && (
          <div role="alert" className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
            {err}
          </div>
        )}

        {creating && (
          <Card className="mb-6">
            <CardBody>
              <form onSubmit={onCreate} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-3 items-end">
                <div>
                  <Label>Name</Label>
                  <Input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="e.g. National Testing Agency"
                    maxLength={200}
                    autoFocus
                    required
                  />
                </div>
                <div>
                  <Label>Notes (optional)</Label>
                  <Input
                    value={newNotes}
                    onChange={(e) => setNewNotes(e.target.value)}
                    placeholder="Internal reference"
                  />
                </div>
                <Button type="submit" disabled={saving || !newName.trim()}>
                  {saving ? 'Creating…' : 'Create'}
                </Button>
              </form>
            </CardBody>
          </Card>
        )}

        <Card>
          <CardBody className="p-0">
            {loading ? (
              <div className="p-10 text-center text-sm text-slate-500">Loading…</div>
            ) : clients.length === 0 ? (
              <div className="p-10 text-center">
                <p className="text-sm text-slate-500">No clients yet.</p>
                <p className="text-xs text-slate-400 mt-1">Click <b>New client</b> to add the first one.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wider text-slate-500 bg-slate-50">
                      <th className="px-4 py-2.5">Name</th>
                      <th className="px-4 py-2.5">Exams</th>
                      <th className="px-4 py-2.5">Status</th>
                      <th className="px-4 py-2.5">Created</th>
                      <th className="px-4 py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {clients.map((c) => (
                      <tr key={c.id} className="border-b border-slate-100 last:border-none hover:bg-slate-50/60">
                        <td className="px-4 py-3 font-medium text-slate-900">
                          <Link to={`/superadmin/clients/${c.id}`} className="hover:underline">
                            {c.name}
                          </Link>
                          {c.notes && <div className="text-xs text-slate-500 mt-0.5">{c.notes}</div>}
                        </td>
                        <td className="px-4 py-3 text-slate-700 tabular-nums">{c.exam_count}</td>
                        <td className="px-4 py-3">
                          <div className="flex gap-1.5">
                            {c.visible
                              ? <Pill tone="emerald" dot>Visible</Pill>
                              : <Pill tone="slate" dot>Hidden</Pill>}
                            {c.closed && <Pill tone="amber" dot>Closed</Pill>}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-500">
                          {new Date(c.created_at).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex justify-end gap-2">
                            <Button variant="ghost" size="sm" onClick={() => onToggleVisibility(c.id)}>
                              {c.visible ? 'Hide' : 'Show'}
                            </Button>
                            {c.closed
                              ? <Button variant="ghost" size="sm" onClick={() => onReopen(c.id)}>Reopen</Button>
                              : <Button variant="ghost" size="sm" onClick={() => onClose(c.id)}>Close</Button>}
                            <Link
                              to={`/superadmin/clients/${c.id}`}
                              className="inline-flex items-center px-2.5 py-1.5 text-xs font-medium rounded-md text-slate-700 hover:bg-slate-100"
                            >
                              Open →
                            </Link>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
      </FadeIn>
    </AppShell>
  )
}
