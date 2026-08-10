import AppShell from '../../components/shell/AppShell.jsx'
import AdminTabs from '../../components/shell/AdminTabs.jsx'
import { PageHeader } from '../../components/ui/ui.jsx'
import DownloadsPanel from '../../components/DownloadsPanel.jsx'

// /admin/downloads — admin's view of the install bundle. Same content
// as the client-side /client/downloads page; the DownloadsPanel
// component renders everything. This file is the admin wrapper that
// adds the AdminTabs strip; the underlying download flow is shared.

export default function AdminDownloads() {
  return (
    <AppShell title="Downloads" subtitle="Operator-laptop install bundle for your centre">
      <PageHeader
        title="Downloads"
        subtitle="Install the operator-laptop client on every machine that will run verifications at your centre."
      />
      <AdminTabs />
      <DownloadsPanel />
    </AppShell>
  )
}
