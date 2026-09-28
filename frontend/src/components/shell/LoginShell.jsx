import { useState } from 'react'
import Verifier from '../login/Verifier.jsx'
import ClassroomScene from '../login/ClassroomScene.jsx'
import LoginCard from '../login/LoginCard.jsx'
import { useLoginForm } from '../login/useLoginForm.js'

// LoginShell — VERSION A · Companion. Shared by all four portals.
//
// The desk scene fills the left ~70%: one verification counter, close up,
// candidates stepping up and being checked (DeskScene). The Verifier is the
// agent behind that counter — he acts out whatever the desk is doing, and
// the moment you touch the form he turns to you instead, exactly as in the
// Android app: types with the username, covers his eyes for the password,
// peeks when it's shown, waits while signing in, is confused by a miss,
// celebrates success. The form sits on a white panel at the right ~30%.
//
// Below 1024px the scene folds away and the form takes the page.
// Version B (no companion, brand panel): components/login/LoginShellPanel.jsx.

// What the agent does for each desk phase while the form is untouched.
const DESK_MOOD = {
  arrive: { type: 'idle' },
  face:   { type: 'point' },
  finger: { type: 'point' },
  fail:   { type: 'confused' },
  iris:   { type: 'eyeScan' },
  done:   { type: 'thumbsUp' },
}

export default function LoginShell({ showRegisterLink = false, ...config }) {
  const f = useLoginForm({ ...config, celebrateMs: 1100 })
  const [deskPhase, setDeskPhase] = useState('arrive')
  const engaged = f.focus || f.err || f.busy || f.success
  const mood = engaged || f.mood.type !== 'idle' ? f.mood : DESK_MOOD[deskPhase] || f.mood

  return (
    <div className="fv tricolour-top relative min-h-screen overflow-hidden lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(400px,30%)]">
      {/* ── The desk, running ──────────────────────────────────────── */}
      <ClassroomScene className="hidden lg:block min-h-screen" onPhase={setDeskPhase}>
        {/* The agent, behind the counter at its right end. */}
        <div aria-hidden="true" className="fv-rise absolute" style={{
          right: '6%', bottom: '16.5%', width: 'min(37vh, 24vw)', aspectRatio: '1 / 1',
        }}>
          <Verifier mood={mood} className="h-full w-full" />
        </div>
      </ClassroomScene>

      {/* ── Form panel ─────────────────────────────────────────────── */}
      <div className="relative z-10 flex min-h-screen flex-col items-center justify-center bg-fv-card px-8 py-10 lg:border-l lg:border-fv-line xl:px-12">
        <LoginCard f={f} showRegisterLink={showRegisterLink} bare />
        <p className="absolute bottom-5 left-8 right-8 text-center text-[12px] text-fv-faint">
          Authorised access only. All sign-in attempts are logged.
        </p>
      </div>
    </div>
  )
}
