// Animated biometric glyphs for the sign-in panel.
//
// The product's whole proposition is three capture modalities, so the
// sign-in screen shows them rather than listing them in prose.
//
// ── Design ──────────────────────────────────────────────────────────
// Three glyphs on a shared 48×48 grid, each inside the same corner
// detection frame, drawn bare on the navy — no tile behind them.
// Structure is the panel's own slate; only the moving part is gold,
// which keeps the palette rule intact (gold marks the authoritative
// act, and here that act is the capture).
//
// Two notes on the drawings themselves:
//
//   * The face is a head-and-shoulders bust, the mark every
//     face-recognition icon uses — not a face with features. A smiling
//     face reads as an emoji at 64px; a bust reads as a person being
//     identified.
//
//   * The fingerprint is a loop pattern: nested arches tapering to a
//     fingertip, with ridge endings and a closed core. Concentric
//     circles read as a target, and arcs cut off at the midline read as
//     the Aadhaar mark — neither is what this is.
//
// Motion is a relay, not three separate loops: one 5.4s cycle in which
// the face reads, then the fingerprint, then the iris, each result
// holding lit until the cycle restarts. See the note in index.css.
// Every animated element also has a resting state drawn underneath it,
// so the reduced-motion version is still a complete icon.
//
// No icon library and no runtime: these are inline paths, so the first
// paint of the first screen costs nothing extra.

const STRUCTURE = '#93A2B5' // slate-400 — reads on navy without glare
const ACCENT    = '#71D0A5' // emerald-300 — the product's verified
                            // colour. 9.23:1 on the navy panel.

// The detection frame, shared by all three. Brightens once per cycle as
// the read completes.
// PHASE offsets the glyph into its slot in the relay.
const PHASE = { face: '0s', print: '1.8s', iris: '3.6s' }

function Frame({ phase }) {
  return (
    <g
      data-bio="lock"
      style={{ animationDelay: phase }}
      stroke={STRUCTURE}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    >
      <path d="M4 15V8.6A4.6 4.6 0 0 1 8.6 4H15" />
      <path d="M33 4h6.4A4.6 4.6 0 0 1 44 8.6V15" />
      <path d="M44 33v6.4a4.6 4.6 0 0 1-4.6 4.6H33" />
      <path d="M15 44H8.6A4.6 4.6 0 0 1 4 39.4V33" />
    </g>
  )
}

// ── Face ────────────────────────────────────────────────────────────
// Detection frame + head-and-shoulders bust + verification tick.
// Two beats on a 2.8s loop: the capture line sweeps the bust, then the
// tick draws and the frame tightens to acknowledge the match.
export function FaceGlyph({ size = 64, className = '' }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 48 48"
      className={`bio-svg ${className}`} role="img" aria-label="Face verification" fill="none"
    >
      <Frame phase={PHASE.face} />

      {/* bust — head and shoulders, the face-recognition mark */}
      <g stroke={STRUCTURE} strokeWidth="1.9" strokeLinecap="round" fill="none">
        <circle cx="24" cy="16.2" r="5.4" />
        <path d="M14.6 29.6c0-4.7 4.2-7.4 9.4-7.4s9.4 2.7 9.4 7.4" />
      </g>

      {/* capture line — sweeps the bust in the first half of the loop */}
      <g data-bio="scan" style={{ animationDelay: PHASE.face }}>
        <line x1="8" y1="5" x2="40" y2="5" stroke={ACCENT} strokeWidth="1.7" strokeLinecap="round" />
        <rect x="8" y="5" width="32" height="7" fill="url(#faceFade)" />
      </g>

      {/* verification tick — resting, then the gold pass draws over it */}
      <path
        d="M18.8 35.4l3.4 3.4 7-7.2"
        stroke={STRUCTURE} strokeWidth="2.4" opacity="0.45"
        strokeLinecap="round" strokeLinejoin="round" fill="none"
      />
      <path
        data-bio="check"
        d="M18.8 35.4l3.4 3.4 7-7.2"
        stroke={ACCENT} strokeWidth="2.6"
        strokeLinecap="round" strokeLinejoin="round" fill="none"
        style={{ strokeDasharray: 15, strokeDashoffset: 15, animationDelay: PHASE.face }}
      />

      <defs>
        <linearGradient id="faceFade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={ACCENT} stopOpacity="0.22" />
          <stop offset="100%" stopColor={ACCENT} stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  )
}

// ── Fingerprint ─────────────────────────────────────────────────────
// A loop-pattern print: four nested arches tapering to a fingertip,
// plus a closed core and two ridge endings. The ridges run the full
// height of the frame, so it reads as a whole print rather than the
// half-print-plus-sun of the Aadhaar mark.
//
// Lengths below are the paths' measured arc lengths. A dash animation
// whose dasharray does not match its path's true length draws at the
// wrong speed, and the four ridges would visibly race each other.
export function FingerprintGlyph({ size = 64, className = '' }) {
  const ridges = [
    { d: 'M12.4 35.2C11.1 22.4 15.4 12.4 24 12.4s12.9 10 11.6 22.8', len: 57.6, delay: '1.8s'  },
    { d: 'M16.1 35.6C15.3 25.2 18.5 17.6 24 17.6s8.7 7.6 7.9 18',    len: 43.5, delay: '1.94s' },
    { d: 'M19.6 35.8C19.2 28.4 20.8 22.8 24 22.8s4.8 5.6 4.4 13',    len: 29.7, delay: '2.08s' },
    { d: 'M22.1 33.6c-.4-4.2.4-7.2 1.9-7.2s2.3 3 1.9 7.2',           len: 16,   delay: '2.22s' },
  ]
  return (
    <svg
      width={size} height={size} viewBox="0 0 48 48"
      className={`bio-svg ${className}`} role="img" aria-label="Fingerprint capture" fill="none"
    >
      <Frame phase={PHASE.print} />

      {/* resting print — always there; the gold pass is the read */}
      <g stroke={STRUCTURE} strokeWidth="1.6" strokeLinecap="round" fill="none" opacity="0.5">
        {ridges.map((r) => <path key={r.d} d={r.d} />)}
        {/* ridge endings — a real print is not perfectly nested */}
        <path d="M27.9 31.2c.5-2.8.4-5.2-.2-7" />
        <path d="M20.4 20.4c-1.3 1.5-2.2 3.5-2.6 5.9" />
      </g>

      {/* the read itself */}
      <g stroke={ACCENT} strokeWidth="1.8" strokeLinecap="round" fill="none">
        {ridges.map((r) => (
          <path
            key={r.d}
            d={r.d}
            data-bio="ridge"
            style={{
              '--bio-len': r.len,
              strokeDasharray: r.len,
              strokeDashoffset: r.len,
              animationDelay: r.delay,
            }}
          />
        ))}
      </g>
    </svg>
  )
}

// ── Iris ────────────────────────────────────────────────────────────
// A measuring ring turns around the pupil while acquisition pulses
// leave the centre.
export function IrisGlyph({ size = 64, className = '' }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 48 48"
      className={`bio-svg ${className}`} role="img" aria-label="Iris capture" fill="none"
    >
      <Frame phase={PHASE.iris} />

      {/* eye aperture */}
      <path
        d="M9 24c3.9-5.8 9-8.8 15-8.8S35.1 18.2 39 24c-3.9 5.8-9 8.8-15 8.8S12.9 29.8 9 24Z"
        stroke={STRUCTURE} strokeWidth="1.8" strokeLinejoin="round" fill="none"
      />
      {/* acquisition pulse */}
      <circle data-bio="pulse" cx="24" cy="24" r="7.6" stroke={ACCENT} strokeWidth="1.5" fill="none"
              style={{ animationDelay: PHASE.iris }} />
      {/* measuring ring */}
      <circle
        data-bio="ring" cx="24" cy="24" r="6"
        stroke={ACCENT} strokeWidth="1.7" fill="none"
        strokeDasharray="3.8 3.8" strokeLinecap="round"
        style={{ animationDelay: PHASE.iris }}
      />
      {/* pupil */}
      <circle cx="24" cy="24" r="2.4" fill={STRUCTURE} />
    </svg>
  )
}

// ── Row ─────────────────────────────────────────────────────────────
export function BiometricStrip({ className = '' }) {
  const items = [
    { Glyph: FaceGlyph,        label: 'Face' },
    { Glyph: FingerprintGlyph, label: 'Fingerprint' },
    { Glyph: IrisGlyph,        label: 'Iris' },
  ]
  return (
    <div className={`flex items-start gap-10 ${className}`}>
      {items.map(({ Glyph, label }) => (
        <div key={label} className="flex flex-col items-center gap-2.5">
          <Glyph />
          <span className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-slate-400">
            {label}
          </span>
        </div>
      ))}
    </div>
  )
}
