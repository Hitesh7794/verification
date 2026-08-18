import AdminShell, { PageHead } from '../../components/shell/AdminShell.jsx'
import DownloadsPanel from '../../components/DownloadsPanel.jsx'

// /admin/downloads — admin's view of the install bundle. Same content
// as the client-side /client/downloads page; the DownloadsPanel
// component renders everything. This file is the admin wrapper that
// adds the tabs strip; the underlying download flow is shared.

export default function AdminDownloads() {
  return (
    <AdminShell>
      <PageHead
        eyebrow="Installer"
        title="Downloads"
      />
      <DownloadsPanel />
    </AdminShell>
  )
}
