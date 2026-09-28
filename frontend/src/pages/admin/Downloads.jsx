import { ArtLaptop } from '../../components/fv/FvArt.jsx'
import AdminShell from '../../components/fv/FvAdminShell.jsx'
import { PageHead } from '../../components/shell/AdminShell.jsx'
import DownloadsPanel from '../../components/DownloadsPanel.jsx'
import DownloadScene from '../../components/fv/DownloadScene.jsx'

// /admin/downloads — admin's view of the install bundle. Same content
// as the client-side /client/downloads page; the DownloadsPanel
// component renders everything. This file is the admin wrapper that
// adds the tabs strip; the underlying download flow is shared.

export default function AdminDownloads() {
  return (
    <AdminShell>
      {/* The page's living background: the installer landing on a laptop. */}
      <DownloadScene className="fixed bottom-[20px] right-[1%] z-0 h-[min(64vh,580px)] aspect-[480/300] opacity-[0.15]" />
      <div className="relative z-[1]">
        <PageHead eyebrow="Installer" title="Downloads" art={ArtLaptop} subtitle="The app for an agent's laptop." />
        <DownloadsPanel />
      </div>
    </AdminShell>
  )
}
