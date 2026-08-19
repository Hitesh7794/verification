import AppShell from '../../components/shell/AppShell.jsx'
import { Button, PageHeader } from '../../components/ui/ui.jsx'
import DownloadsPanel from '../../components/DownloadsPanel.jsx'
import { Link } from 'react-router-dom'

// /institute/operator/downloads — operator's self-serve install page. Same download
// flow as /admin/downloads (shared DownloadsPanel); the only difference
// is the surrounding chrome (no AdminTabs since the client portal has
// no tab strip today, and a "Back to verification" link instead).
//
// Why operators need this: an admin can't always physically deliver
// the install bundle to every laptop in their centre. With this page
// the operator opens the portal in a browser on a fresh laptop, signs
// in with the shared credentials, downloads + installs the bundle,
// then starts running verifications. Zero admin involvement.

export default function ClientDownloads() {
  return (
    <AppShell title="Downloads" subtitle="Verification agent laptop install bundle">
      <PageHeader
        title="Verification agent installer"
        subtitle="Use this to install the verification client on a new verification agent laptop. After install, sign in with the same credentials you used here."
        right={
          <Link to="/institute/operator">
            <Button variant="secondary">Back to verification</Button>
          </Link>
        }
      />
      <DownloadsPanel />
    </AppShell>
  )
}
