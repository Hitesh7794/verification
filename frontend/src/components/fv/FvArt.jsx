import useInstitutionPhoto from './useInstitutionPhoto.js'
// FvArt — flat illustrations for the admin pages. Each one shows what its
// figure means in the product's own terms (a face locked in a capture frame,
// a report with a photo and a fingerprint, an admit card, an answer sheet,
// a centre on the map, a candidate through the gate) rather than a generic
// icon. Solid FlatViolet fills, the tint for paper, saffron and India green
// as accents, no gradients. 64×64 drawings; size them with className.

const V = '#5B3FA6', VD = '#43307D', VS = '#9A86D6', T = '#DDD5F2', L = '#EFEBF9'
const W = '#FFFFFF', INK = '#211E33', SAF = '#F28C28', GRN = '#138808', MARK = '#A8711F'

function Art({ className = 'h-12 w-12', children }) {
  return <svg viewBox="0 0 64 64" className={className} aria-hidden="true">{children}</svg>
}

// A small bust: head, hair (or hijab), shoulders.
function Bust({ x, y, r, skin, hair, shirt, hijab }) {
  return (
    <g>
      <path d={`M${x - r * 1.9} ${y + r * 2.9}c0-${r * 1.4} ${r * 0.8}-${r * 2.1} ${r * 1.9}-${r * 2.1}s${r * 1.9} ${r * 0.7} ${r * 1.9} ${r * 2.1}z`} fill={shirt} />
      {hijab && <circle cx={x} cy={y} r={r * 1.35} fill={hijab} />}
      <circle cx={x} cy={y} r={r} fill={skin} />
      {!hijab && <path d={`M${x - r * 1.05} ${y - r * 0.1}a${r * 1.05} ${r * 1.05} 0 0 1 ${r * 2.1} 0c-${r * 0.5}-${r * 0.5}-${r * 1.1}-${r * 0.6}-${r * 1.05}-${r * 0.6}s-${r * 0.6} ${r * 0.1}-${r * 1.05} ${r * 0.6}z`} fill={hair} />}
      <circle cx={x - r * 0.36} cy={y + r * 0.15} r={r * 0.13} fill={INK} />
      <circle cx={x + r * 0.36} cy={y + r * 0.15} r={r * 0.13} fill={INK} />
    </g>
  )
}
function Tick({ cx, cy, r, fill = GRN }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} fill={fill} />
      <path d={`M${cx - r * 0.45} ${cy + r * 0.02}l${r * 0.32} ${r * 0.34} ${r * 0.6}-${r * 0.66}`} stroke={W} strokeWidth={r * 0.26} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </g>
  )
}
function Whorl({ cx, cy, s, color = V }) {
  return (
    <g stroke={color} strokeWidth={s * 0.09} fill="none" strokeLinecap="round">
      <path d={`M${cx - s * 0.2} ${cy + s * 0.1}a${s * 0.2} ${s * 0.26} 0 1 1 ${s * 0.4} 0`} />
      <path d={`M${cx - s * 0.42} ${cy + s * 0.3}a${s * 0.42} ${s * 0.52} 0 1 1 ${s * 0.84} 0`} />
      <path d={`M${cx - s * 0.64} ${cy + s * 0.46}a${s * 0.64} ${s * 0.78} 0 1 1 ${s * 1.28} -${s * 0.1}`} />
    </g>
  )
}

// Checked today — a face locked in the capture frame, ticked; today's page behind.
export function ArtClipboard(p) {
  return (
    <Art {...p}>
      <rect x="6" y="8" width="44" height="46" rx="7" fill={L} />
      <rect x="6" y="8" width="44" height="10" rx="5" fill={V} />
      <rect x="6" y="13" width="44" height="5" fill={V} />
      <rect x="13" y="4" width="4" height="9" rx="2" fill={VD} />
      <rect x="39" y="4" width="4" height="9" rx="2" fill={VD} />
      <g stroke={VD} strokeWidth="2.6" fill="none" strokeLinecap="round">
        <path d="M14 29v-5h5M42 29v-5h-5M14 43v5h5M42 43v5h-5" />
      </g>
      <Bust x={28} y={33} r={5.6} skin="#D9A47C" hair={INK} shirt={SAF} />
      <Tick cx={50} cy={48} r={9} />
    </Art>
  )
}

// Verifications so far — a pile of reports, each with the candidate's photo
// and fingerprint; the top one sealed.
export function ArtRecords(p) {
  return (
    <Art {...p}>
      <rect x="16" y="5" width="34" height="44" rx="4" fill={T} transform="rotate(8 33 27)" />
      <rect x="12" y="8" width="34" height="44" rx="4" fill={VS} transform="rotate(-5 29 30)" />
      <rect x="10" y="10" width="34" height="46" rx="4" fill={W} stroke={T} strokeWidth="1.5" />
      <rect x="15" y="15" width="12" height="14" rx="2" fill={L} />
      <Bust x={21} y={20.5} r={2.9} skin="#F1D2B6" hair="#3B2A20" shirt={GRN} />
      <rect x="30" y="16" width="10" height="2.6" rx="1.3" fill={T} />
      <rect x="30" y="21" width="8" height="2.6" rx="1.3" fill={L} />
      <rect x="30" y="26" width="9" height="2.6" rx="1.3" fill={L} />
      <Whorl cx={21} cy={40} s={7} />
      <rect x="30" y="36" width="9" height="2.6" rx="1.3" fill={L} />
      <rect x="30" y="41" width="7" height="2.6" rx="1.3" fill={L} />
      <Tick cx={45} cy={47} r={10} fill={V} />
    </Art>
  )
}

// Candidates enrolled — admit cards: photo, name lines, fingerprint, the
// tiranga stripe, one per candidate.
export function ArtStudents(p) {
  const card = (x, y, rot, skin, hair, shirt, hijab) => (
    <g transform={`rotate(${rot} ${x + 17} ${y + 12})`}>
      <rect x={x} y={y} width="34" height="24" rx="3.5" fill={W} stroke={T} strokeWidth="1.2" />
      <rect x={x} y={y} width="34" height="2" rx="1" fill={SAF} />
      <rect x={x} y={y + 2} width="34" height="1.4" fill={W} />
      <rect x={x} y={y + 3.4} width="34" height="1.6" fill={GRN} />
      <rect x={x + 3} y={y + 7.5} width="11" height="13" rx="2" fill={L} />
      <Bust x={x + 8.5} y={y + 12.5} r={2.7} skin={skin} hair={hair} shirt={shirt} hijab={hijab} />
      <rect x={x + 17} y={y + 9} width="13" height="2.2" rx="1.1" fill={T} />
      <rect x={x + 17} y={y + 13.5} width="9" height="2.2" rx="1.1" fill={L} />
      <Whorl cx={x + 27} cy={y + 18.5} s={2.6} color={VS} />
    </g>
  )
  return (
    <Art {...p}>
      {card(14, 6, 9, '#C68B59', INK, V)}
      {card(10, 18, -4, '#F5DCC4', '#4A2E22', SAF, '#94B7F2')}
      {card(6, 33, 2, '#A66E48', '#1E1F23', GRN)}
    </Art>
  )
}

// Exams assigned — an answer sheet with filled bubbles and a pencil.
export function ArtExam(p) {
  return (
    <Art {...p}>
      <rect x="8" y="6" width="36" height="52" rx="4" fill={W} stroke={T} strokeWidth="1.5" />
      <rect x="8" y="6" width="36" height="10" rx="4" fill={V} />
      <rect x="8" y="12" width="36" height="4" fill={V} />
      <rect x="13" y="9.5" width="14" height="3" rx="1.5" fill={VS} />
      {[22, 29, 36, 43, 50].map((y, r) => (
        <g key={y}>
          <rect x="12" y={y - 1.2} width="4" height="2.4" rx="1.2" fill={T} />
          {[21, 27, 33, 39].map((x, c) => (
            <circle key={x} cx={x} cy={y} r="2.4" fill={c === (r * 3 + 1) % 4 ? V : W} stroke={c === (r * 3 + 1) % 4 ? V : VS} strokeWidth="1.1" />
          ))}
        </g>
      ))}
      <g transform="rotate(35 48 34)">
        <rect x="44" y="12" width="8" height="34" rx="2" fill={SAF} />
        <rect x="44" y="12" width="8" height="5" rx="2" fill="#F7B37A" />
        <rect x="44" y="17" width="8" height="2" fill={VD} />
        <path d="M44 46h8l-4 7z" fill="#F3E3C8" />
        <path d="M46.9 50.9h2.2l-1.1 2.1z" fill={INK} />
      </g>
    </Art>
  )
}

// Daily volume — a week on a desk calendar, each day's checks as a column of ticks.
export function ArtCalendar(p) {
  const h = [3, 4, 3, 5, 5, 6, 7]
  return (
    <Art {...p}>
      <rect x="4" y="10" width="56" height="46" rx="6" fill={W} stroke={T} strokeWidth="1.5" />
      <rect x="4" y="10" width="56" height="10" rx="6" fill={V} />
      <rect x="4" y="15" width="56" height="5" fill={V} />
      <rect x="15" y="5" width="4" height="10" rx="2" fill={VD} />
      <rect x="45" y="5" width="4" height="10" rx="2" fill={VD} />
      {h.map((n, i) => {
        const x = 10.5 + i * 7.2
        return (
          <g key={i}>
            {Array.from({ length: n }).map((_, k) => (
              <rect key={k} x={x - 2.4} y={50 - k * 4.2} width="4.8" height="3.2" rx="1" fill={k === n - 1 && i % 3 === 1 ? MARK : i === 6 ? V : VS} />
            ))}
          </g>
        )
      })}
      <rect x="53.5" y="21.5" width="5" height="2.4" rx="1.2" fill={SAF} />
    </Art>
  )
}

// Busiest centres — a college on the map, a pin over it, candidates at the door.
export function ArtCollege(p) {
  return (
    <Art {...p}>
      <ellipse cx="32" cy="55" rx="28" ry="5" fill={L} />
      <path d="M10 30l22-11 22 11z" fill={VD} />
      <rect x="12" y="30" width="40" height="4" fill={V} />
      <rect x="12" y="34" width="40" height="18" fill={L} />
      {[16, 24, 36, 44].map((x) => <rect key={x} x={x} y="34" width="4" height="18" rx="1" fill={W} />)}
      <rect x="28.5" y="41" width="7" height="11" rx="3.5" fill={VD} />
      <rect x="9" y="52" width="46" height="4" rx="1.5" fill={VS} />
      <circle cx="21" cy="50.5" r="1.8" fill="#C68B59" /><rect x="19.4" y="52" width="3.2" height="3" rx="1" fill={SAF} />
      <circle cx="42" cy="50.5" r="1.8" fill="#F1D2B6" /><rect x="40.4" y="52" width="3.2" height="3" rx="1" fill={GRN} />
      {/* the pin */}
      <path d="M32 4c-5.5 0-9.5 4-9.5 9.2 0 6.4 9.5 13.3 9.5 13.3s9.5-6.9 9.5-13.3C41.5 8 37.5 4 32 4z" fill={SAF} />
      <circle cx="32" cy="13" r="3.8" fill={W} />
    </Art>
  )
}

// Recent verifications — a candidate stepping through the gate; the next waits.
export function ArtQueue(p) {
  return (
    <Art {...p}>
      <rect x="4" y="56" width="56" height="3" rx="1.5" fill={T} />
      <rect x="18" y="10" width="4" height="46" rx="1.5" fill={VS} />
      <rect x="44" y="10" width="4" height="46" rx="1.5" fill={VS} />
      <rect x="15" y="6" width="36" height="7" rx="2.5" fill={VD} />
      <rect x="29" y="12" width="8" height="5" rx="1.5" fill={VD} />
      <circle cx="33" cy="14.5" r="1.3" fill={SAF} />
      <Bust x={33} y={32} r={6} skin="#E8C39E" hair={INK} shirt={V} />
      <g stroke={V} strokeWidth="1.8" fill="none" strokeLinecap="round">
        <path d="M25 28v-4h4M41 28v-4h-4M25 38v4h4M41 38v4h-4" />
      </g>
      <Bust x={9} y={40} r={4} skin="#A66E48" hair="#2F3034" shirt={SAF} />
      <Tick cx={52} cy={24} r={7} />
      <rect x="23" y="47" width="20" height="3" rx="1.5" fill={GRN} />
    </Art>
  )
}

// Devices — a fingerprint scanner with a finger on the glass.
export function ArtScanner(p) {
  return (
    <Art {...p}>
      <ellipse cx="32" cy="56" rx="24" ry="4" fill={L} />
      <path d="M12 52c0-14 8-28 20-28s20 14 20 28z" fill={VD} />
      <path d="M17 50c0-10 6-20 15-20s15 10 15 20z" fill={V} />
      <rect x="22" y="38" width="20" height="10" rx="3" fill={T} />
      <rect x="24" y="40" width="16" height="6" rx="2" fill={VS} />
      <circle cx="46" cy="33" r="2" fill={SAF} />
      {/* the finger coming down */}
      <path d="M27 4h10v26a5 5 0 0 1-10 0z" fill="#D9A47C" />
      <path d="M28.5 26a3.5 3.5 0 0 0 7 0" stroke="#C48D66" strokeWidth="1.4" fill="none" />
      <rect x="25" y="2" width="14" height="8" rx="3" fill={SAF} />
      <Whorl cx={32} cy={43} s={4} color={W} />
    </Art>
  )
}

// Downloads — a laptop with the agent app arriving on it.
export function ArtLaptop(p) {
  return (
    <Art {...p}>
      <rect x="10" y="14" width="44" height="30" rx="4" fill={VD} />
      <rect x="13" y="17" width="38" height="24" rx="2" fill={L} />
      <path d="M4 46h56l-4 6H8z" fill={VS} />
      <rect x="26" y="46" width="12" height="2" rx="1" fill={VD} />
      {/* the app window */}
      <rect x="18" y="21" width="28" height="16" rx="2" fill={W} />
      <rect x="18" y="21" width="28" height="4" rx="2" fill={V} />
      <Bust x={25} y={30} r={2.6} skin="#E8C39E" hair={INK} shirt={V} />
      <rect x="31" y="28" width="11" height="2" rx="1" fill={T} />
      <rect x="31" y="32" width="8" height="2" rx="1" fill={L} />
      {/* the download arrow */}
      <circle cx="50" cy="12" r="8" fill={SAF} />
      <path d="M50 8v7M46.8 12.2 50 15.4l3.2-3.2" stroke={W} strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </Art>
  )
}

// Agents — a verification agent at the desk, lanyard and headset on.
export function ArtAgent(p) {
  return (
    <Art {...p}>
      <rect x="4" y="46" width="56" height="6" rx="2" fill={VS} />
      <path d="M14 46c0-10 8-15 18-15s18 5 18 15z" fill={V} />
      <path d="M27.5 31.5 32 38l4.5-6.5" fill={W} />
      <path d="M28 32l4 10 4-10" stroke={SAF} strokeWidth="1.6" fill="none" />
      <rect x="29.5" y="40" width="5" height="6" rx="1" fill={W} />
      <rect x="30.3" y="41.2" width="3.4" height="1.2" rx=".6" fill={GRN} />
      <circle cx="32" cy="20" r="9" fill="#C68B59" />
      <path d="M22.8 19c0-6 4.2-9.6 9.2-9.6s9.2 3.6 9.2 9.6c-1.4-3-3.6-4.8-6.4-5.2-2 1.8-6.4 3-12 5.2z" fill={INK} />
      <circle cx="28.8" cy="21" r="1.1" fill={INK} /><circle cx="35.2" cy="21" r="1.1" fill={INK} />
      <path d="M29.5 24.8c1.5 1.1 3.5 1.1 5 0" stroke={INK} strokeWidth="1.1" fill="none" strokeLinecap="round" />
      {/* headset */}
      <path d="M21.5 20a10.5 10.5 0 0 1 21 0" stroke={VD} strokeWidth="2" fill="none" />
      <rect x="19.5" y="18" width="4" height="7" rx="2" fill={VD} />
      <path d="M21.5 25c0 3 2 4.5 5 4.5" stroke={VD} strokeWidth="1.4" fill="none" />
      <Tick cx={50} cy={14} r={7} fill={V} />
    </Art>
  )
}

// Applications — an institution's KYC file, stamped.
export function ArtStamp(p) {
  return (
    <Art {...p}>
      <rect x="8" y="6" width="36" height="50" rx="4" fill={W} stroke={T} strokeWidth="1.5" />
      <rect x="8" y="6" width="36" height="3" fill={SAF} />
      <rect x="8" y="9" width="36" height="2" fill={W} />
      <rect x="8" y="11" width="36" height="3" fill={GRN} />
      <rect x="13" y="19" width="16" height="3" rx="1.5" fill={T} />
      <rect x="13" y="25" width="24" height="2.4" rx="1.2" fill={L} />
      <rect x="13" y="30" width="20" height="2.4" rx="1.2" fill={L} />
      <rect x="13" y="35" width="22" height="2.4" rx="1.2" fill={L} />
      {/* the stamp, mid-press */}
      <g transform="rotate(-14 44 42)">
        <circle cx="44" cy="44" r="11" fill="none" stroke={V} strokeWidth="2.4" />
        <circle cx="44" cy="44" r="7.5" fill="none" stroke={V} strokeWidth="1" strokeDasharray="2 2" />
        <path d="M40 44.2l2.8 2.8 5.4-5.8" stroke={V} strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      <rect x="47" y="4" width="10" height="14" rx="3" fill={MARK} transform="rotate(20 52 11)" />
      <rect x="44" y="16" width="14" height="4" rx="1.5" fill={VD} transform="rotate(20 51 18)" />
    </Art>
  )
}

// Clients — an exam board: a hall with the emblem-like crest and its exams.
export function ArtBoard(p) {
  return (
    <Art {...p}>
      <rect x="6" y="50" width="52" height="5" rx="1.5" fill={VS} />
      <rect x="10" y="24" width="44" height="26" fill={L} />
      <path d="M6 24h52L32 10z" fill={VD} />
      <circle cx="32" cy="19" r="3" fill={SAF} />
      {[14, 22, 38, 46].map((x) => <rect key={x} x={x} y="26" width="4" height="24" rx="1" fill={W} />)}
      <rect x="27" y="32" width="10" height="18" rx="2" fill={V} />
      <rect x="29" y="35" width="6" height="2" rx="1" fill={W} />
      <rect x="29" y="39" width="4" height="2" rx="1" fill={T} />
      <rect x="29" y="43" width="5" height="2" rx="1" fill={T} />
    </Art>
  )
}

// Request access — a letter with an exam sheet inside, flying off.
export function ArtEnvelope(p) {
  return (
    <Art {...p}>
      <path d="M4 20c6-2 9 1 12 0M2 28c5-1.6 8 .8 11 0M5 36c4-1.2 6 .6 8 0" stroke={T} strokeWidth="2.2" fill="none" strokeLinecap="round" />
      <g transform="rotate(-10 38 34)">
        <rect x="20" y="14" width="30" height="32" rx="2.5" fill={W} stroke={T} strokeWidth="1.2" />
        <rect x="20" y="14" width="30" height="6" rx="2.5" fill={V} />
        {[25, 31, 37].map((y) => (
          <g key={y}>{[27, 33, 39].map((x, i) => <circle key={x} cx={x} cy={y} r="2" fill={i === (y % 3) ? V : W} stroke={VS} strokeWidth=".9" />)}</g>
        ))}
        <path d="M16 30h38v24a3 3 0 0 1-3 3H19a3 3 0 0 1-3-3z" fill={VS} />
        <path d="M16 30l19 14 19-14" fill="none" stroke={VD} strokeWidth="2" strokeLinejoin="round" />
        <path d="M16 57l14-12M54 57L40 45" stroke={VD} strokeWidth="1.4" />
        <circle cx="35" cy="44" r="4" fill={SAF} />
      </g>
    </Art>
  )
}

// Assign — an agent holding up the answer sheet, ready for exam day.
export function ArtAssign(p) {
  return (
    <Art {...p}>
      <path d="M12 60c0-11 9-17 20-17s20 6 20 17z" fill={V} />
      <path d="M27 43.5 32 50l5-6.5" fill={W} />
      <circle cx="32" cy="27" r="10" fill="#E8C39E" />
      <path d="M21.8 26c0-6.6 4.6-10.6 10.2-10.6S42.2 19.4 42.2 26c-1.6-3.3-4-5.3-7.1-5.8-2.2 2-7.1 3.3-13.3 5.8z" fill={INK} />
      <circle cx="28.4" cy="28" r="1.2" fill={INK} /><circle cx="35.6" cy="28" r="1.2" fill={INK} />
      <path d="M29 32.2c1.7 1.2 4.3 1.2 6 0" stroke={INK} strokeWidth="1.2" fill="none" strokeLinecap="round" />
      <g transform="rotate(-6 32 50)">
        <rect x="20" y="38" width="24" height="24" rx="2" fill={W} stroke={T} strokeWidth="1.2" />
        <rect x="20" y="38" width="24" height="5" rx="2" fill={VD} />
        {[47, 52, 57].map((y, r) => (
          <g key={y}>{[26, 32, 38].map((x, c) => <circle key={x} cx={x} cy={y} r="1.9" fill={c === (r + 1) % 3 ? V : W} stroke={VS} strokeWidth=".8" />)}</g>
        ))}
        <ellipse cx="20" cy="51" rx="2.6" ry="3.6" fill="#E8C39E" />
        <ellipse cx="44" cy="51" rx="2.6" ry="3.6" fill="#E8C39E" />
      </g>
      <Tick cx={52} cy={16} r={7} />
    </Art>
  )
}

// Small inline glyphs for table cells.
export function GlyphSheet({ className = 'h-7 w-7' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <rect x="4" y="2" width="16" height="20" rx="2.5" fill={L} stroke={VS} strokeWidth="1.2" />
      <rect x="4" y="2" width="16" height="4.5" rx="2" fill={V} />
      {[10, 14, 18].map((y, r) => <g key={y}>{[9, 13, 17].map((x, c) => <circle key={x} cx={x} cy={y} r="1.4" fill={c === r ? V : W} stroke={VS} strokeWidth=".7" />)}</g>)}
    </svg>
  )
}
export function GlyphWindow({ className = 'h-5 w-5' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="3" fill={W} stroke={VS} strokeWidth="1.4" />
      <rect x="3" y="5" width="18" height="5" rx="2.5" fill={VS} />
      <rect x="7" y="2.5" width="2.4" height="5" rx="1.2" fill={VD} /><rect x="14.6" y="2.5" width="2.4" height="5" rx="1.2" fill={VD} />
      <rect x="7" y="13" width="10" height="4" rx="2" fill={SAF} />
    </svg>
  )
}
export function GlyphPeople({ className = 'h-5 w-5' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <circle cx="8" cy="9" r="3" fill={VS} /><path d="M2.5 20c0-3.6 2.5-6 5.5-6s5.5 2.4 5.5 6z" fill={VS} />
      <circle cx="16" cy="8" r="3.3" fill={V} /><path d="M10 20c0-4 2.7-6.6 6-6.6s6 2.6 6 6.6z" fill={V} />
    </svg>
  )
}

// A portrait for a person, different for every seed (their username):
// skin, hair (short, long, bun, hijab, turban), shirt colour, glasses.
const P_SKIN = ['#F5DCC4', '#F1D2B6', '#E8C39E', '#D9A47C', '#C68B59', '#A66E48', '#8A5A3B']
const P_HAIR = ['#1E1F23', '#2F3034', '#3B2A20', '#4A2E22']
const P_SHIRT = [['#5B3FA6', '#43307D'], ['#F28C28', '#D97A1E'], ['#138808', '#0F6E07'], ['#9A86D6', '#7C6BC4'], ['#3671B5', '#2A5B93'], ['#43307D', '#2B1F52']]
function seedOf(s = '') { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h }
// Gender for a portrait: the record's own field when it has one, else a
// guess from the first name (common Indian names, then a soft ending rule).
const FEMALE_NAMES = new Set(['sneha', 'priya', 'diya', 'ananya', 'isha', 'saanvi', 'meera', 'zoya', 'tanvi', 'pooja', 'neha',
  'kavya', 'riya', 'anjali', 'divya', 'shreya', 'aisha', 'fatima', 'sunita', 'geeta', 'sita', 'lakshmi', 'deepa', 'nisha',
  'swati', 'pallavi', 'aarti', 'ritu', 'komal', 'simran', 'harpreet', 'jaspreet', 'manpreet', 'gurpreet', 'sana', 'ayesha',
  'kiran', 'rekha', 'rani', 'shalini', 'megha', 'bhavna', 'nandini', 'aditi', 'ishita', 'kritika', 'sakshi', 'muskan'])
const MALE_NAMES = new Set(['ravi', 'amit', 'arjun', 'aarav', 'kabir', 'vihaan', 'rohan', 'aditya', 'nikhil', 'farhan', 'rahul',
  'vikram', 'suresh', 'ramesh', 'rajesh', 'mahesh', 'anil', 'sunil', 'vijay', 'ajay', 'sanjay', 'manoj', 'deepak', 'rakesh',
  'mohan', 'krishna', 'shiva', 'arun', 'varun', 'karan', 'sahil', 'yash', 'harsh', 'dev', 'om', 'imran', 'salman', 'faisal',
  'gurdeep', 'harjeet', 'jaswinder', 'mohit', 'rohit', 'sumit', 'ankit', 'aman', 'ashok', 'dinesh', 'gaurav', 'kunal', 'pranav'])
export function genderOf(name = '', given) {
  const g = String(given || '').toLowerCase()
  if (g === 'f' || g === 'female' || g === 'woman') return 'f'
  if (g === 'm' || g === 'male' || g === 'man') return 'm'
  const first = String(name).trim().split(/[\s.@_]+/)[0].toLowerCase()
  if (FEMALE_NAMES.has(first)) return 'f'
  if (MALE_NAMES.has(first)) return 'm'
  return /(a|i|ee|ya)$/.test(first) ? 'f' : 'm'
}
const MALE_STYLES = [0, 0, 4, 0]      // short (mostly), turban
const FEMALE_STYLES = [1, 2, 3, 1]    // long, bun, hijab
// The picks that make one person's avatar: the same seed always gives the
// same face, so the navbar, the agent lists and the drawings agree.
export function avatarPalette(seed = '', name, gender) {
  const h = seedOf(seed)
  const skin = P_SKIN[h % P_SKIN.length]
  const hair = P_HAIR[(h >>> 3) % P_HAIR.length]
  const [shirt, shirtDk] = P_SHIRT[(h >>> 5) % P_SHIRT.length]
  const g = genderOf(name || seed, gender)
  const style = (g === 'f' ? FEMALE_STYLES : MALE_STYLES)[(h >>> 8) % 4]
  const glasses = (h >>> 11) % 3 === 0
  return { h, skin, hair, shirt, shirtDk, style, glasses, gender: g }
}

// Just the head from that avatar, on nothing, for drawings that carry
// their own body. Same construction as the portrait below.
export function AvatarHead({ seed = '', name, gender, className = 'h-16 w-16' }) {
  const { skin, hair, style, glasses, shirtDk } = avatarPalette(seed, name, gender)
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      {style === 1 && <rect x="17" y="18" width="30" height="34" rx="12" fill={hair} />}
      {style === 3 && <path d="M15 56c0-20 6-32 17-32s17 12 17 32z" fill={shirtDk} />}
      {style === 3 && <circle cx="32" cy="28" r="15" fill={shirtDk} />}
      <circle cx="32" cy="29" r="12" fill={skin} />
      {style === 0 && <path d="M19.6 27.5c0-8 5.6-12.6 12.4-12.6s12.4 4.6 12.4 12.6c-2-4-4.8-6.4-8.6-7-2.6 2.4-8.6 4-16.2 7z" fill={hair} />}
      {style === 1 && <path d="M19.6 29c0-8.6 5.6-13.6 12.4-13.6S44.4 20.4 44.4 29c-3-5-7-6.6-12.4-6.6S22.6 24 19.6 29z" fill={hair} />}
      {style === 2 && <><circle cx="32" cy="14" r="5.5" fill={hair} /><path d="M19.8 28c0-7.6 5.4-12.2 12.2-12.2S44.2 20.4 44.2 28c-3.4-4.4-7.4-5.8-12.2-5.8S23.2 23.6 19.8 28z" fill={hair} /></>}
      {style === 4 && <path d="M18.5 27c0-9 6-14 13.5-14S45.5 18 45.5 27c-4-3-8.6-4-13.5-4s-9.5 1-13.5 4z" fill={SAF} />}
      <circle cx="22.4" cy="30.6" r="2.4" fill="#B9CDEA" opacity=".5" />
      <circle cx="41.6" cy="30.6" r="2.4" fill="#B9CDEA" opacity=".5" />
      <circle cx="27.6" cy="30.4" r="1.6" fill={INK} /><circle cx="36.4" cy="30.4" r="1.6" fill={INK} />
      {glasses && <g fill="none" stroke={INK} strokeWidth="1.2"><circle cx="27.6" cy="30.4" r="3.6" /><circle cx="36.4" cy="30.4" r="3.6" /><path d="M31.2 30.2h1.6" /></g>}
      <path d="M28.4 35.2c2.2 1.6 5 1.6 7.2 0" stroke={INK} strokeWidth="1.4" fill="none" strokeLinecap="round" />
    </svg>
  )
}

export function AgentPortrait({ seed = '', name, gender, className = 'h-16 w-16' }) {
  const { h, skin, hair, shirt, shirtDk, style, glasses } = avatarPalette(seed, name, gender)
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <circle cx="32" cy="32" r="32" fill={L} />
      <clipPath id={`pc-${h}`}><circle cx="32" cy="32" r="32" /></clipPath>
      <g clipPath={`url(#pc-${h})`}>
        {style === 1 && <rect x="17" y="18" width="30" height="34" rx="12" fill={hair} />}
        {style === 3 && <path d="M14 64c0-22 7-40 18-40s18 18 18 40z" fill={shirtDk} />}
        <path d="M10 66c0-12 9.8-19 22-19s22 7 22 19z" fill={shirt} />
        <path d="M27 47.5 32 54l5-6.5" fill={style === 3 ? shirtDk : W} />
        <rect x="28" y="38" width="8" height="10" rx="3" fill={skin} opacity=".92" />
        {style === 3 && <circle cx="32" cy="28" r="15" fill={shirtDk} />}
        <circle cx="32" cy="29" r="12" fill={skin} />
        {style === 0 && <path d="M19.6 27.5c0-8 5.6-12.6 12.4-12.6s12.4 4.6 12.4 12.6c-2-4-4.8-6.4-8.6-7-2.6 2.4-8.6 4-16.2 7z" fill={hair} />}
        {style === 1 && <path d="M19.6 29c0-8.6 5.6-13.6 12.4-13.6S44.4 20.4 44.4 29c-3-5-7-6.6-12.4-6.6S22.6 24 19.6 29z" fill={hair} />}
        {style === 2 && <><circle cx="32" cy="14" r="5.5" fill={hair} /><path d="M19.8 28c0-7.6 5.4-12.2 12.2-12.2S44.2 20.4 44.2 28c-3.4-4.4-7.4-5.8-12.2-5.8S23.2 23.6 19.8 28z" fill={hair} /></>}
        {style === 4 && <path d="M18.5 27c0-9 6-14 13.5-14S45.5 18 45.5 27c-4-3-8.6-4-13.5-4s-9.5 1-13.5 4z" fill={SAF} />}
        <circle cx="27.6" cy="30.4" r="1.4" fill={INK} /><circle cx="36.4" cy="30.4" r="1.4" fill={INK} />
        {glasses && <g fill="none" stroke={INK} strokeWidth="1.2"><circle cx="27.6" cy="30.4" r="3.6" /><circle cx="36.4" cy="30.4" r="3.6" /><path d="M31.2 30.2h1.6" /></g>}
        <path d="M28.6 35.2c2 1.4 4.8 1.4 6.8 0" stroke={INK} strokeWidth="1.3" fill="none" strokeLinecap="round" />
      </g>
    </svg>
  )
}


// A half-dial showing how much of a purse is spent.
export function PurseGauge({ spent = 0, cap = 0, className = 'h-16 w-28' }) {
  const k = cap > 0 ? Math.min(1, spent / cap) : 0
  const a = Math.PI * (1 - k)
  const x = 40 + Math.cos(a) * 30, y = 40 - Math.sin(a) * 30
  const col = k > 0.85 ? '#A8711F' : V
  return (
    <svg viewBox="0 0 80 46" className={className} aria-hidden="true">
      <path d="M10 40a30 30 0 0 1 60 0" fill="none" stroke={L} strokeWidth="9" strokeLinecap="round" />
      {k > 0.001 && <path d={`M10 40A30 30 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)}`} fill="none" stroke={col} strokeWidth="9" strokeLinecap="round" />}
      <circle cx={x} cy={y} r="5.5" fill={W} stroke={col} strokeWidth="2.4" />
      <text x="40" y="38" textAnchor="middle" fontSize="11" fontWeight="700" fill={INK} fontFamily="Bricolage Grotesque, sans-serif">₹</text>
    </svg>
  )
}

// ── Institution buildings ────────────────────────────────────────────
// A campus for an institution: four generic buildings (a domed hall, a
// modern block, a gate house, a clock tower), picked from the name so the
// same institution always gets the same one. If the record ever carries a
// real photo, use that instead — see InstitutionArt below.
function B1({ W: w }) {   // domed hall
  return (
    <g>
      <rect x="10" y="78" width="140" height="42" fill={VS} />
      <rect x="4" y="74" width="152" height="6" rx="3" fill={VD} />
      <path d="M30 74h100l-50-26z" fill={VD} />
      <circle cx="80" cy="34" r="16" fill={V} />
      <rect x="76" y="10" width="8" height="10" rx="4" fill={SAF} />
      <rect x="62" y="48" width="36" height="26" fill={L} />
      {[18, 36, 108, 126].map((x) => <rect key={x} x={x} y="84" width="12" height="28" rx="2" fill={W} />)}
      {[66, 86].map((x) => <rect key={x} x={x} y="54" width="10" height="20" rx="2" fill={W} />)}
      <rect x="70" y="96" width="20" height="24" rx="4" fill={VD} />
    </g>
  )
}
function B2({ W: w }) {   // modern block
  return (
    <g>
      <rect x="16" y="40" width="60" height="80" fill={VS} />
      <rect x="80" y="62" width="64" height="58" fill={V} />
      <rect x="16" y="36" width="60" height="6" rx="3" fill={VD} />
      <rect x="80" y="58" width="64" height="6" rx="3" fill={VD} />
      {[0, 1, 2, 3].map((r) => [0, 1, 2].map((c) => (
        <rect key={`${r}-${c}`} x={24 + c * 18} y={50 + r * 16} width="12" height="10" rx="1.5" fill={W} />
      )))}
      {[0, 1, 2].map((r) => [0, 1, 2].map((c) => (
        <rect key={`m${r}-${c}`} x={88 + c * 18} y={72 + r * 16} width="12" height="10" rx="1.5" fill={L} />
      )))}
      <rect x="40" y="100" width="18" height="20" rx="3" fill={VD} />
    </g>
  )
}
function B3({ W: w }) {   // gate house
  return (
    <g>
      <rect x="6" y="96" width="148" height="24" fill={VS} />
      <rect x="20" y="44" width="26" height="76" fill={V} />
      <rect x="114" y="44" width="26" height="76" fill={V} />
      <rect x="14" y="38" width="38" height="8" rx="4" fill={VD} />
      <rect x="108" y="38" width="38" height="8" rx="4" fill={VD} />
      <path d="M46 96V70a34 34 0 0 1 68 0v26z" fill={L} />
      <path d="M46 70a34 34 0 0 1 68 0" fill="none" stroke={VD} strokeWidth="5" />
      <rect x="70" y="80" width="20" height="40" rx="10" fill={VD} />
      {[26, 120].map((x) => [0, 1, 2].map((r) => <rect key={`${x}-${r}`} x={x} y={54 + r * 18} width="14" height="12" rx="2" fill={W} />))}
      <rect x="76" y="14" width="8" height="26" fill={INK} />
      <rect x="84" y="14" width="20" height="6" fill={SAF} /><rect x="84" y="20" width="20" height="5" fill={W} /><rect x="84" y="25" width="20" height="6" fill={GRN} />
    </g>
  )
}
function B4({ W: w }) {   // clock tower
  return (
    <g>
      <rect x="10" y="84" width="140" height="36" fill={VS} />
      <rect x="4" y="80" width="152" height="6" rx="3" fill={VD} />
      <rect x="62" y="20" width="36" height="60" fill={V} />
      <path d="M58 20h44l-22-16z" fill={VD} />
      <circle cx="80" cy="40" r="11" fill={W} />
      <path d="M80 33v7l5 3" fill="none" stroke={VD} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      {[20, 40, 110, 130].map((x) => <rect key={x} x={x} y="90" width="12" height="24" rx="2" fill={W} />)}
      <rect x="70" y="60" width="20" height="20" rx="2" fill={L} />
      <rect x="68" y="98" width="24" height="22" rx="4" fill={VD} />
    </g>
  )
}
const BUILDINGS = [B1, B2, B3, B4]

// InstitutionArt — the campus for one institution. Give it the record: if
// it carries a photo (photo_url / logo_url / image_url) that is drawn
// instead, so a real picture takes over the moment the API sends one.
export function InstitutionArt({ name = '', photo, lookup = true, className = 'h-full w-full' }) {
  // A real picture when the record has one, else one found by name (only
  // when it clearly matches), else the drawn campus.
  const found = useInstitutionPhoto(name, lookup && !photo)
  const src = photo || found
  if (src) return <img src={src} alt="" aria-hidden="true" className={`${className} object-cover`} loading="lazy" />
  const B = BUILDINGS[seedOf(name) % BUILDINGS.length]
  return (
    <svg viewBox="0 0 160 120" preserveAspectRatio="xMidYMax meet" className={className} aria-hidden="true">
      <B W={160} />
    </svg>
  )
}

// A decision stamp, pressed across a row: APPROVED in violet, SENT BACK
// in the amber mark.
export function DecisionStamp({ status, label: labelProp, className = 'h-16 w-40' }) {
  const ok = status === 'approved'
  const c = ok ? V : '#C62828'   // red is allowed on a rejection stamp
  const label = labelProp || (ok ? 'APPROVED' : 'REJECTED')
  return (
    <svg viewBox="0 0 200 76" className={className} aria-hidden="true">
      <g transform="rotate(-8 100 38)" fill="none" stroke={c}>
        <rect x="8" y="10" width="184" height="56" rx="8" strokeWidth="4" />
        <rect x="16" y="18" width="168" height="40" rx="5" strokeWidth="1.4" strokeDasharray="5 5" />
        <text x="100" y="47" textAnchor="middle" fontSize="26" fontWeight="800" fill={c} stroke="none"
              fontFamily="Bricolage Grotesque, sans-serif" letterSpacing="2">{label}</text>
      </g>
    </svg>
  )
}

// RoundStamp — the old boxed stamp, inside a circular seal: the word in
// its ruled box, the Hindi under it, the whole thing ringed twice the way
// an office seal is. Solid ink, no curved type.
export function RoundStamp({ status = 'approved', className = 'h-28 w-28' }) {
  // The one place red is allowed: a rejection seal is red ink everywhere
  // it is pressed, and nothing else in the portal is.
  const ok = status === 'approved'
  const c = ok ? '#5B3FA6' : '#C62828'
  return (
    <svg viewBox="0 0 130 130" className={className} aria-hidden="true">
      {/* the circular layer */}
      <circle cx="65" cy="65" r="60" fill="none" stroke={c} strokeWidth="5" />
      <circle cx="65" cy="65" r="52" fill="none" stroke={c} strokeWidth="1.6" />
      <circle cx="65" cy="65" r="47" fill="none" stroke={c} strokeWidth="1.4" strokeDasharray="4 5" />
      {/* the mark, above the box */}
      {ok
        ? <path d="M56 37l6 6 13-15" fill="none" stroke={c} strokeWidth="5.4" strokeLinecap="round" strokeLinejoin="round" />
        : <path d="M57 30l16 16M73 30L57 46" stroke={c} strokeWidth="5.4" strokeLinecap="round" />}
      {/* the old stamp, in its ruled box */}
      <rect x="21" y="54" width="88" height="27" rx="5" fill="none" stroke={c} strokeWidth="3" />
      <text x="65" y="73.5" textAnchor="middle" fontSize="14.5" fontWeight="800" letterSpacing="0.6" fill={c}
            fontFamily="Bricolage Grotesque, sans-serif">{ok ? 'APPROVED' : 'REJECTED'}</text>
      {/* its Hindi, under the box */}
      <text x="65" y="97" textAnchor="middle" fontSize="12" fontWeight="600" fill={c}
            fontFamily="Noto Sans Devanagari, sans-serif">{ok ? 'स्वीकृत' : 'अस्वीकृत'}</text>
      <circle cx="11" cy="65" r="2.6" fill={c} />
      <circle cx="119" cy="65" r="2.6" fill={c} />
    </svg>
  )
}
