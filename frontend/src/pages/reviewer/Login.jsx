import LoginShell from '../../components/shell/LoginShell.jsx'

// Client-reviewer sign-in. Uses the same warm-palette LoginShell as
// every other portal so a reviewer who's used the admin or superadmin
// screen sees the same visual grammar. The role-eyebrow reads "Review
// portal" — the shell picks that up from expectedRole via ROLE_LABEL.
//
// One quirk vs the other login pages: reviewers were provisioned by
// superadmin with a fixed password (no magic-link activation), so no
// "just activated" banner and no register link.
export default function ReviewerLogin() {
  return (
    <LoginShell
      expectedRole="client_reviewer"
      redirectTo="/reviewer"
      rememberKey="nv_last_reviewer_username"
    />
  )
}
