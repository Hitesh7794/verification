import useScene from './motion.js'

// ScanScene — the two biometric devices, drawn and properly animated.
//
// FingerScene: the reader on the desk. A finger comes down, flattens on
// the glass, and trembles a little while it is held. The platen reads it
// line by line: a bright bar travels up the glass, the ridges behind it
// stay lit, and sparks pop where the matcher finds a point. A bead runs
// the edge, an arc closes on the device, and the verdict rings out.
//
// IrisScene: the tower at eye height. The eye blinks on its own until the
// read starts, then the lid opens wide, the brackets close in, a line
// sweeps the iris while the pupil breathes under the infrared, and the
// iris code fills in as a ring of bits around the eye.
//
// status: 'idle' | 'scanning' | 'pass' | 'fail'
// Violet is a match, amber is not — the same language as the rest.

const V = '#5B3FA6', VD = '#43307D', VS = '#9A86D6', T = '#DDD5F2', L = '#EFEBF9'
const W = '#FFFFFF', INK = '#211E33', AMB = '#A8711F', AMB_L = '#E4A54B'
const SKIN = '#F3EAD9', SKIN_D = '#E2D4BE'

const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : 1 - Math.pow(1 - x, 3))

// The badge that lands when a bay settles.
function Verdict({ ok, show, x, y }) {
  if (show < 0.02) return null
  const s = 0.6 + show * 0.4
  const c = ok ? V : AMB
  return (
    <g transform={`translate(${x} ${y}) scale(${s.toFixed(3)})`} opacity={Math.min(1, show * 1.4)}>
      <circle r={26 + (1 - show) * 24} fill="none" stroke={c} strokeWidth="3" opacity={(1 - show) * 0.7} />
      <circle r="24" fill={c} />
      <circle r="24" fill={W} opacity=".12" />
      {ok
        ? <path d="M-10 1l7 7 15-16" fill="none" stroke={W} strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" />
        : <path d="M-8 -8l16 16M8 -8l-16 16" stroke={W} strokeWidth="5.5" strokeLinecap="round" />}
    </g>
  )
}

// ── The fingerprint bay ───────────────────────────────────────────────
export function FingerScene({ status = 'idle', className = '' }) {
  const { t, v } = useScene({
    down: status === 'scanning' ? 1 : status === 'idle' ? 0 : 0.42,
    done: status === 'pass' || status === 'fail' ? 1 : 0,
    warm: status === 'scanning' ? 1 : 0,
  }, 7)
  const scanning = status === 'scanning'
  const ok = status === 'pass'
  const bad = status === 'fail'
  const tone = bad ? AMB : V

  // the read: a bar travelling up the glass, ridges lit behind it
  const read = scanning ? ((t * 0.7) % 1) : v.done
  const barY = 184 - read * 34
  const tremble = scanning ? Math.sin(t * 22) * 0.5 : 0
  const tipY = 112 + v.down * 42 + tremble + (scanning ? 0 : Math.sin(t * 1.3) * 2.2)
  const lamp = scanning ? (t * 3 % 1 < 0.5) : Math.sin(t * 1.8) > 0
  const seg = (i) => (scanning ? (Math.floor(t * 6) % 5) >= i : v.done > 0.5)
  const shake = bad ? Math.sin(t * 30) * (1 - Math.min(1, v.done)) * 2 : 0
  const ring = scanning ? (t * 0.9) % 1 : v.done

  // sparks where the matcher finds something, only while reading
  const sparks = Array.from({ length: 5 }).map((_, i) => {
    const k = (t * 0.7 + i * 0.19) % 1
    return { x: 116 + ((i * 37) % 88), y: 182 - k * 32, a: Math.sin(k * Math.PI) }
  })

  return (
    <div aria-hidden="true" className={`relative ${className}`}>
      <svg viewBox="0 0 320 250" className="h-full w-full">
        <defs>
          <linearGradient id="fsDesk" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#F7F5FC" /><stop offset="1" stopColor="#EDE8F8" />
          </linearGradient>
          <linearGradient id="fsGlass" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#2A2740" /><stop offset=".55" stopColor="#15132A" /><stop offset="1" stopColor="#221F38" />
          </linearGradient>
          <clipPath id="fsPlaten"><rect x="104" y="150" width="112" height="34" rx="9" /></clipPath>
        </defs>

        <rect x="0" y="0" width="320" height="250" rx="14" fill="url(#fsDesk)" />
        <ellipse cx="160" cy="214" rx="104" ry="14" fill={T} opacity=".55" />

        <g transform={`translate(${shake.toFixed(2)} 0)`}>
          {/* the reader */}
          <path d="M78 206h164l-12-58H90z" fill={VD} />
          <path d="M86 198h148l-9-44H95z" fill={V} />
          <path d="M86 198h148l-2-10H88z" fill={W} opacity=".08" />
          <rect x="96" y="142" width="128" height="16" rx="8" fill={VD} />
          <rect x="104" y="150" width="112" height="34" rx="9" fill="url(#fsGlass)" />
          <rect x="104" y="150" width="112" height="34" rx="9" fill={tone}
                opacity={(0.12 + v.warm * 0.22 + v.done * 0.3).toFixed(3)} />

          {/* what the glass is reading */}
          <g clipPath="url(#fsPlaten)">
            {/* the ridge field, lit behind the bar */}
            {Array.from({ length: 10 }).map((_, i) => {
              const y = 151 + i * 3.4
              const lit = scanning ? (y > barY ? 1 : 0.18) : v.done > 0.5 ? 0.9 : 0.16
              return (
                <path key={i} d={`M104 ${y}q28 ${(-3 - i * 0.35).toFixed(1)} 56 0t56 0`}
                      fill="none" stroke={bad ? AMB_L : W} strokeWidth={lit > 0.5 ? 1.5 : 1}
                      opacity={(lit * 0.65).toFixed(2)} />
              )
            })}
            {/* the bar */}
            {scanning && (
              <>
                <rect x="104" y={barY.toFixed(1)} width="112" height="2.4" fill={W} opacity=".9" />
                <rect x="104" y={(barY - 6).toFixed(1)} width="112" height="6" fill={W} opacity=".16" />
              </>
            )}
            {/* points it finds on the way */}
            {scanning && sparks.map((sp, i) => (
              <circle key={i} cx={sp.x.toFixed(1)} cy={sp.y.toFixed(1)} r={(1 + sp.a * 1.4).toFixed(2)}
                      fill={W} opacity={(sp.a * 0.9).toFixed(2)} />
            ))}
            {/* the print it leaves once it has read */}
            {v.done > 0.02 && (
              <g opacity={(v.done * 0.8).toFixed(2)}>
                {Array.from({ length: 5 }).map((_, i) => (
                  <ellipse key={i} cx="160" cy="170" rx={(8 + i * 7).toFixed(1)} ry={(5 + i * 3.2).toFixed(1)}
                           fill="none" stroke={ok ? W : AMB_L} strokeWidth="1.2" opacity=".7" />
                ))}
              </g>
            )}
            {/* the sheen on the glass */}
            <path d="M104 150l34 34h-20l-24-24z" fill={W} opacity=".07" />
          </g>

          {/* the bead running the edge as it reads */}
          {scanning && (
            <g>
              <rect x="104" y="146" width="112" height="2.4" rx="1.2" fill={L} opacity=".45" />
              <rect x={(104 + ((t * 70) % 112)).toFixed(1)} y="145.4" width="26" height="3.6" rx="1.8" fill={W} opacity=".9" />
            </g>
          )}

          {/* the status strip on its face */}
          <g transform="translate(116 190)">
            {[0, 1, 2, 3, 4].map((i) => (
              <rect key={i} x={i * 9} y="0" width="6" height="3.4" rx="1.7"
                    fill={seg(i) ? (bad ? AMB_L : VS) : '#6D5FA8'} opacity={seg(i) ? 0.95 : 0.4} />
            ))}
          </g>
          <circle cx="232" cy="166" r="4.4" fill={bad ? AMB_L : lamp ? VS : T} />
          <circle cx="232" cy="166" r="8" fill={bad ? AMB_L : VS} opacity={lamp ? 0.22 : 0.06} />
          <path d="M242 168c14 0 18 12 34 12" fill="none" stroke={INK} strokeWidth="3" opacity=".35" />
        </g>

        {/* the ripple a decision sends out */}
        {v.done > 0.02 && v.done < 0.98 && (
          <ellipse cx="160" cy="167" rx={(60 + v.done * 90).toFixed(0)} ry={(16 + v.done * 26).toFixed(0)}
                   fill="none" stroke={tone} strokeWidth="2.4" opacity={(1 - v.done).toFixed(2)} />
        )}

        {/* the finger */}
        <g>
          <ellipse cx="160" cy="153" rx={(12 + v.down * 18).toFixed(1)} ry={(2.5 + v.down * 4).toFixed(1)}
                   fill={INK} opacity={(0.04 + v.down * 0.18).toFixed(3)} />
          <g transform={`translate(160 ${tipY.toFixed(2)}) rotate(${(-6 + v.down * 4).toFixed(2)})`}>
            <path d="M-40 -150h74a16 16 0 0 1 16 16v28a22 22 0 0 1-22 22h-52z" fill={SKIN_D} />
            <path d="M-34 -150h60a14 14 0 0 1 14 14v22a18 18 0 0 1-18 18h-42z" fill={SKIN} />
            <path d="M-23 -104 L-23 -22 A23 22 0 0 0 23 -22 L23 -104 Z" fill={SKIN} stroke={SKIN_D} strokeWidth="2.2" strokeLinejoin="round" />
            <path d="M-23 -104 L-23 -22 A23 22 0 0 0 -8 -.6 L-8 -104 Z" fill={W} opacity=".3" />
            <ellipse cx="2" cy="-70" rx="13" ry="17" fill="#F8F1E6" stroke={SKIN_D} strokeWidth="1.4" />
            <path d="M-23 -50q23 8 46 0M-23 -34q23 7 46 0" fill="none" stroke={SKIN_D} strokeWidth="1.8" opacity=".5" />
            <path d="M-17 -16q17 8 34 0" fill="none" stroke={SKIN_D} strokeWidth="1.8" opacity=".45" />
            {/* where it flattens on the glass */}
            <ellipse cx="0" cy="-2" rx={(16 + v.down * 8).toFixed(1)} ry={(3 + v.down * 2.6).toFixed(1)}
                     fill={W} opacity={(v.down * 0.3).toFixed(2)} />
          </g>
        </g>

        {/* the arc that closes as it reads */}
        <g transform="translate(268 54)" opacity={(v.warm * 0.9 + v.done).toFixed(3)}>
          <circle r="24" fill="none" stroke={L} strokeWidth="5" />
          <circle r="24" fill="none" stroke={tone} strokeWidth="5" strokeLinecap="round"
                  strokeDasharray={`${(2 * Math.PI * 24 * ring).toFixed(1)} 999`} transform="rotate(-90)" />
        </g>

        <Verdict ok={ok} show={v.done} x={268} y={54} />
      </svg>
    </div>
  )
}

// ── The iris bay ──────────────────────────────────────────────────────
const BITS = 36

export function IrisScene({ status = 'idle', className = '' }) {
  const { t, v } = useScene({
    lean: status === 'idle' ? 0 : 1,
    done: status === 'pass' || status === 'fail' ? 1 : 0,
    warm: status === 'scanning' ? 1 : 0,
  }, 7)
  const scanning = status === 'scanning'
  const ok = status === 'pass'
  const bad = status === 'fail'
  const tone = bad ? AMB : V

  // the lid: it blinks on its own until the read starts
  const bp = (t * 0.45) % 1
  const lid = scanning ? 1 : bp > 0.94 ? Math.abs(Math.cos(((bp - 0.94) / 0.06) * Math.PI)) : 1
  // the pupil breathes under the infrared
  const pupil = 10.5 + (scanning ? Math.sin(t * 2.6) * 2.6 : Math.sin(t * 0.9) * 1.1)
  const scanY = 96 + ((t * 54) % 52)
  const sweep = (t * 1.1) % 1
  const read = scanning ? Math.min(1, ((t * 0.55) % 1.4)) : v.done
  const litBits = Math.round(read * BITS)
  const ir = Math.sin(t * 5) > 0
  const ring = scanning ? (t * 0.9) % 1 : v.done
  const shake = bad ? Math.sin(t * 30) * (1 - Math.min(1, v.done)) * 1.6 : 0

  return (
    <div aria-hidden="true" className={`relative ${className}`}>
      <svg viewBox="0 0 320 250" className="h-full w-full">
        <defs>
          <linearGradient id="isBg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#F7F5FC" /><stop offset="1" stopColor="#EDE8F8" />
          </linearGradient>
          <radialGradient id="isIris" cx="50%" cy="50%" r="50%">
            <stop offset="0" stopColor="#7E6BC4" /><stop offset=".7" stopColor="#5B3FA6" /><stop offset="1" stopColor="#38276E" />
          </radialGradient>
          <clipPath id="isEye">
            <path d="M96 122s28-34 64-34 64 34 64 34-28 34-64 34-64-34-64-34z" />
          </clipPath>
        </defs>

        <rect x="0" y="0" width="320" height="250" rx="14" fill="url(#isBg)" />
        <ellipse cx="160" cy="216" rx="106" ry="14" fill={T} opacity=".55" />

        <g transform={`translate(${shake.toFixed(2)} 0)`}>
          {/* the tower */}
          <path d="M96 210h128l-14-24H110z" fill={VD} />
          <path d="M110 186h100l-4-6H114z" fill={V} opacity=".5" />
          <rect x="148" y="150" width="24" height="42" rx="7" fill={VD} />
          <rect x="154" y="150" width="6" height="42" fill={VS} opacity=".5" />

          {/* the eye it holds */}
          <g transform={`translate(0 ${(-v.lean * 4).toFixed(2)})`}>
            <path d="M96 122s28-34 64-34 64 34 64 34-28 34-64 34-64-34-64-34z" fill={W} stroke={VD} strokeWidth="4" strokeLinejoin="round" />
            <g clipPath="url(#isEye)">
              <circle cx="160" cy="122" r="30" fill="url(#isIris)" />
              <circle cx="160" cy="122" r="30" fill={tone} opacity={(v.warm * 0.22 + v.done * 0.26).toFixed(3)} />
              {/* the fibres, two layers, turning against each other */}
              {Array.from({ length: 30 }).map((_, i) => {
                const a = (i / 30) * Math.PI * 2 + t * 0.22
                return <line key={i} x1={160 + Math.cos(a) * 12} y1={122 + Math.sin(a) * 12}
                             x2={160 + Math.cos(a) * 29} y2={122 + Math.sin(a) * 29}
                             stroke={VD} strokeWidth={i % 2 ? 1.5 : 2.4} opacity={i % 3 ? 0.45 : 0.7} />
              })}
              {Array.from({ length: 20 }).map((_, i) => {
                const a = (i / 20) * Math.PI * 2 - t * 0.36
                return <line key={`b${i}`} x1={160 + Math.cos(a) * 16} y1={122 + Math.sin(a) * 16}
                             x2={160 + Math.cos(a) * 27} y2={122 + Math.sin(a) * 27}
                             stroke={W} strokeWidth="1.1" opacity=".2" />
              })}
              {/* the collarette, then the pupil with its soft edge */}
              <circle cx="160" cy="122" r="14" fill="none" stroke="#CFC2F2" strokeWidth="1.2" opacity=".45" />
              <circle cx="160" cy="122" r={pupil.toFixed(1)} fill="#0B0918" />
              <circle cx="160" cy="122" r={(pupil + 0.9).toFixed(1)} fill="none" stroke="#000" strokeWidth="1.6" opacity=".5" />
              <circle cx="168" cy="113" r="5.4" fill={W} opacity=".88" />
              <circle cx="151" cy="131" r="2.6" fill={W} opacity=".45" />
              {/* the limbal ring around it all */}
              <circle cx="160" cy="122" r="30" fill="none" stroke="#1A1236" strokeWidth="3" opacity=".75" />

              {/* the read: a bar down the eye and a line going round */}
              {scanning && (
                <>
                  <rect x="96" y={scanY.toFixed(1)} width="128" height="3" fill={W} opacity=".8" />
                  <rect x="96" y={(scanY - 10).toFixed(1)} width="128" height="10" fill={W} opacity=".16" />
                  <line x1="160" y1="122"
                        x2={(160 + Math.cos(sweep * Math.PI * 2) * 30).toFixed(1)}
                        y2={(122 + Math.sin(sweep * Math.PI * 2) * 30).toFixed(1)}
                        stroke={W} strokeWidth="1.6" opacity=".55" />
                </>
              )}

              {/* the lid, which only rests when it is not reading */}
              <rect x="96" y={(88 - 36 * lid).toFixed(1)} width="128" height="36" fill={W} />
              <path d={`M96 ${(124 - 36 * lid).toFixed(1)}h128`} stroke={SKIN_D} strokeWidth="1.6" opacity={(1 - lid).toFixed(2)} />
            </g>

            {/* lashes on the lid */}
            <g stroke={VD} strokeWidth="2.4" strokeLinecap="round" opacity=".8">
              <path d="M112 100l-7-7M132 90l-4-8M160 86v-9M188 90l4-8M208 100l7-7" />
            </g>

            {/* the code it lifts, filling in around the eye */}
            <g>
              {Array.from({ length: BITS }).map((_, i) => {
                const a = (i / BITS) * Math.PI * 2 - Math.PI / 2
                const on = i < litBits
                return (
                  <rect key={i} x={-2} y={-1.6} width="4" height="3.2" rx="1"
                        transform={`translate(${160 + Math.cos(a) * 40} ${122 + Math.sin(a) * 40}) rotate(${(a * 57.3 + 90).toFixed(1)})`}
                        fill={on ? tone : VS} opacity={on ? 0.95 : 0.25} />
                )
              })}
            </g>

            {/* the brackets, closing in as it reads */}
            <g fill="none" stroke={tone} strokeWidth="4" strokeLinecap="round" opacity={(0.3 + v.warm * 0.55).toFixed(2)}>
              <g transform={`translate(${(v.warm * 9).toFixed(1)} 0)`}><path d="M88 104V88h16M88 140v16h16" /></g>
              <g transform={`translate(${(-v.warm * 9).toFixed(1)} 0)`}><path d="M232 104V88h-16M232 140v16h-16" /></g>
            </g>
          </g>

          {/* the infrared pair */}
          <rect x="112" y="176" width="96" height="26" rx="12" fill={INK} />
          <circle cx="134" cy="189" r="7.5" fill="#2B2742" stroke={VS} strokeWidth="1.6" />
          <circle cx="186" cy="189" r="7.5" fill="#2B2742" stroke={VS} strokeWidth="1.6" />
          <circle cx="134" cy="189" r="3" fill={V} /><circle cx="186" cy="189" r="3" fill={V} />
          <circle cx="152" cy="189" r="2.6" fill={ir ? AMB_L : '#4A4660'} />
          <circle cx="168" cy="189" r="2.6" fill={ir ? '#4A4660' : AMB_L} />
        </g>

        {/* the arc that closes as it reads */}
        <g transform="translate(270 52)" opacity={(v.warm * 0.9 + v.done).toFixed(3)}>
          <circle r="24" fill="none" stroke={L} strokeWidth="5" />
          <circle r="24" fill="none" stroke={tone} strokeWidth="5" strokeLinecap="round"
                  strokeDasharray={`${(2 * Math.PI * 24 * ring).toFixed(1)} 999`} transform="rotate(-90)" />
        </g>

        <Verdict ok={ok} show={v.done} x={270} y={52} />
      </svg>
    </div>
  )
}

export default { FingerScene, IrisScene }
