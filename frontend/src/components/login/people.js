// people.js — the candidates, shared by the cover's canvases.
// A faithful JS port of drawPerson / PEOPLE / easeOutBack from the Android
// ui/welcome/Crowd.kt, plus the small canvas helpers they draw with.
// Everything draws in the 100-unit figure space (0…100 wide, 0…100 tall,
// shoulders on y = 100); the caller translates and scales.

// Scheme (ACTIVE = FlatViolet).
export const CHAR_INK = '#211E33' // FlatViolet.charInk is null → Ink
export const BLUSH = 'rgba(185,205,234,0.349)' // 0x59B9CDEA, the companion's cool blush

// ── Looks ─────────────────────────────────────────────────────────────
export const HIJAB = 0, CROP = 1, TURBAN = 2, BOB = 3, ELDER = 4
// Web additions (students only): more hair so no two faces repeat.
export const PONY = 5, CURLY = 6, SPIKY = 7, BUN = 8, BRAIDS = 9, SIDE = 10
const SHORT_HAIR = [CROP, TURBAN, ELDER, CURLY, SPIKY, SIDE]

// Colour comes from the app's own ramps plus one lilac; skin is skin.
export const PEOPLE = [
  { look: HIJAB, skin: '#E8C39E', shade: '#D6AA80', hair: '#94B7F2', hairDk: '#6E9BE0',
    shirt: '#DCE6FA', shirtDk: '#BFD2F7', glasses: true, smile: 0.9, phase: 0.4, blinkEvery: 4.3, breathEvery: 3.1 },
  { look: CROP, skin: '#C68B59', shade: '#B07648', hair: '#2F3034', hairDk: '#1E1F23',
    shirt: '#C58226', shirtDk: '#A66E1E', glasses: false, smile: 1.2, phase: 1.9, blinkEvery: 5.1, breathEvery: 3.6 },
  { look: TURBAN, skin: '#A66E48', shade: '#915D3B', hair: '#3671B5', hairDk: '#2A5B93',
    shirt: '#575A5F', shirtDk: '#434449', glasses: false, smile: 0.8, phase: 3.3, blinkEvery: 6.2, breathEvery: 4.0 },
  { look: BOB, skin: '#F1D2B6', shade: '#E0B896', hair: '#4A2E22', hairDk: '#36201A',
    shirt: '#7C6BC4', shirtDk: '#6556A8', glasses: true, smile: 1.1, phase: 4.8, blinkEvery: 3.9, breathEvery: 2.9 },
  { look: ELDER, skin: '#D9A47C', shade: '#C48D66', hair: '#D0D2D5', hairDk: '#B4B6BB',
    shirt: '#1F4672', shirtDk: '#143153', glasses: true, smile: 0.7, phase: 6.1, blinkEvery: 5.7, breathEvery: 4.4 },
]

// ── Helpers ───────────────────────────────────────────────────────────
export const clamp01 = (x) => Math.min(1, Math.max(0, x))

/** Ease-out with a small overshoot: quick to arrive, a soft settle, never a snap. */
export function easeOutBack(x) {
  const c1 = 1.15
  const c3 = c1 + 1
  const f = clamp01(x) - 1
  return 1 + c3 * f * f * f + c1 * f * f
}

export function withAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

export function line(ctx, color, x0, y0, x1, y1, width) {
  ctx.beginPath()
  ctx.moveTo(x0, y0)
  ctx.lineTo(x1, y1)
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.lineCap = 'round'
  ctx.stroke()
}

export function rrectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.lineTo(x + w - rr, y)
  ctx.arcTo(x + w, y, x + w, y + rr, rr)
  ctx.lineTo(x + w, y + h - rr)
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr)
  ctx.lineTo(x + rr, y + h)
  ctx.arcTo(x, y + h, x, y + h - rr, rr)
  ctx.lineTo(x, y + rr)
  ctx.arcTo(x, y, x + rr, y, rr)
  ctx.closePath()
}

export function fillRRect(ctx, color, x, y, w, h, r) {
  rrectPath(ctx, x, y, w, h, r)
  ctx.fillStyle = color
  ctx.fill()
}

export function strokeRRect(ctx, color, x, y, w, h, r, width) {
  rrectPath(ctx, x, y, w, h, r)
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.lineJoin = 'miter'
  ctx.stroke()
}

export function fillCircle(ctx, color, cx, cy, r) {
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()
}

export function strokeCircle(ctx, color, cx, cy, r, width) {
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.stroke()
}

// Stroke the current path with a round cap (Stroke(width, cap = Round)).
export function strokeRound(ctx, color, width) {
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'miter'
  ctx.stroke()
}

// ── drawPerson (Crowd.kt), in the 100-unit figure space ──────────────
export function drawPerson(ctx, p, eyeOpen) {
  const ink = CHAR_INK
  // Shoulders and neck
  ctx.beginPath()
  ctx.moveTo(6, 100); ctx.lineTo(6, 76); ctx.quadraticCurveTo(6, 63, 22, 61)
  ctx.lineTo(78, 61); ctx.quadraticCurveTo(94, 63, 94, 76); ctx.lineTo(94, 100); ctx.closePath()
  ctx.fillStyle = p.shirt
  ctx.fill()
  ctx.fillStyle = p.shirtDk
  ctx.fillRect(6, 95, 88, 5)
  if (p.look !== HIJAB) {
    // A collar line on the shirt.
    ctx.beginPath()
    ctx.moveTo(40, 61); ctx.lineTo(50, 71); ctx.lineTo(60, 61)
    strokeRound(ctx, p.shirtDk, 1.6)
    fillRRect(ctx, p.shade, 42, 52, 16, 14, 3)
  }
  // What sits behind the head
  if (p.look === HIJAB) {
    fillRRect(ctx, p.hair, 17, 4, 66, 84, 30)
    fillRRect(ctx, p.hairDk, 24, 11, 52, 56, 25)
    fillRRect(ctx, p.hair, 27, 14, 46, 50, 22)
  } else if (p.look === BOB) {
    fillRRect(ctx, p.hair, 20, 9, 60, 52, 23)
  } else if (p.look === PONY) {
    fillRRect(ctx, p.hair, 66, 26, 15, 44, 7.5)            // the tail, behind the right shoulder
    fillRRect(ctx, p.hairDk, 69, 26, 6, 4, 2)
  } else if (p.look === BRAIDS) {
    for (const bx of [19, 72]) {
      fillRRect(ctx, p.hair, bx, 30, 9, 44, 4.5)
      for (let y = 38; y < 72; y += 7) fillRRect(ctx, p.hairDk, bx, y, 9, 1.6, 0.8)
    }
  } else if (p.look === BUN) {
    fillCircle(ctx, p.hair, 50, 8.5, 9.5)
    fillRRect(ctx, p.hairDk, 42, 14, 16, 2.4, 1.2)
  }
  // Ears, head
  if (SHORT_HAIR.includes(p.look)) {
    fillCircle(ctx, p.skin, 23, 44, 5.5)
    fillCircle(ctx, p.skin, 77, 44, 5.5)
  }
  if (p.look === HIJAB) fillRRect(ctx, p.skin, 29, 18, 42, 44, 19)
  else fillRRect(ctx, p.skin, 25 - (p.faceW || 0), 16, 50 + 2 * (p.faceW || 0), 46, 20)
  // A little shade under the jaw so the head sits on the neck.
  if (p.look !== HIJAB) fillRRect(ctx, p.shade, 33, 56, 34, 6, 3)
  fillCircle(ctx, BLUSH, 33.5, 55, 4.2)
  fillCircle(ctx, BLUSH, 66.5, 55, 4.2)

  // Hair, on top
  if (p.look === CROP) {
    ctx.beginPath()
    ctx.moveTo(25, 30); ctx.quadraticCurveTo(25, 9, 50, 9); ctx.quadraticCurveTo(75, 9, 75, 30)
    ctx.lineTo(69, 30); ctx.quadraticCurveTo(50, 21, 31, 30); ctx.closePath()
    ctx.fillStyle = p.hair
    ctx.fill()
    fillRRect(ctx, p.hair, 25, 27, 5, 15, 2)
    fillRRect(ctx, p.hair, 70, 27, 5, 15, 2)
  } else if (p.look === TURBAN) {
    ctx.beginPath()
    ctx.moveTo(21, 35); ctx.quadraticCurveTo(23, 3, 52, 3); ctx.quadraticCurveTo(80, 3, 79, 35)
    ctx.quadraticCurveTo(50, 27, 21, 35); ctx.closePath()
    ctx.fillStyle = p.hair
    ctx.fill()
    // The folds, wound round.
    for (const [x0, y0, x1, y1] of [[28, 30, 60, 7], [35, 32, 70, 10], [44, 32, 76, 16]]) {
      line(ctx, p.hairDk, x0, y0, x1, y1, 2.2)
    }
  } else if (p.look === BOB) {
    ctx.beginPath()
    ctx.moveTo(25, 34); ctx.quadraticCurveTo(25, 10, 50, 10); ctx.quadraticCurveTo(75, 10, 75, 34)
    ctx.lineTo(75, 30); ctx.quadraticCurveTo(58, 34, 44, 26); ctx.quadraticCurveTo(34, 22, 25, 30); ctx.closePath()
    ctx.fillStyle = p.hair
    ctx.fill()
  } else if (p.look === PONY || p.look === BUN) {
    // Pulled back: a smooth cap, a soft side sweep, no fringe.
    ctx.beginPath()
    ctx.moveTo(24, 36); ctx.quadraticCurveTo(24, 10, 50, 10); ctx.quadraticCurveTo(76, 10, 76, 36)
    ctx.lineTo(74, 36); ctx.quadraticCurveTo(66, 22, 46, 22); ctx.quadraticCurveTo(32, 23, 26, 36); ctx.closePath()
    ctx.fillStyle = p.hair
    ctx.fill()
  } else if (p.look === BRAIDS) {
    // A centre parting.
    ctx.beginPath()
    ctx.moveTo(23, 38); ctx.quadraticCurveTo(23, 10, 50, 10); ctx.quadraticCurveTo(77, 10, 77, 38)
    ctx.lineTo(74, 38); ctx.quadraticCurveTo(70, 22, 50, 20); ctx.quadraticCurveTo(30, 22, 26, 38); ctx.closePath()
    ctx.fillStyle = p.hair
    ctx.fill()
    line(ctx, p.hairDk, 50, 11, 50, 20, 1.4)
  } else if (p.look === CURLY) {
    fillRRect(ctx, p.hair, 26, 12, 48, 14, 7)
    for (let j = 0; j < 8; j++) fillCircle(ctx, p.hair, 26 + j * 6.8, 20 + (j % 2) * 3, 6.4)
    for (let j = 0; j < 7; j++) fillCircle(ctx, p.hair, 29.5 + j * 6.8, 11 + (j % 2) * 2, 5.6)
  } else if (p.look === SPIKY) {
    ctx.beginPath()
    ctx.moveTo(25, 30); ctx.quadraticCurveTo(25, 13, 50, 13); ctx.quadraticCurveTo(75, 13, 75, 30)
    ctx.lineTo(70, 28); ctx.lineTo(64, 22); ctx.lineTo(58, 27); ctx.lineTo(50, 21); ctx.lineTo(42, 27)
    ctx.lineTo(36, 22); ctx.lineTo(30, 28); ctx.closePath()
    ctx.fillStyle = p.hair
    ctx.fill()
    for (const [x, y] of [[30, 13], [40, 8], [50, 6], [60, 8], [70, 13]]) {
      ctx.beginPath(); ctx.moveTo(x - 6, 17); ctx.lineTo(x, y); ctx.lineTo(x + 6, 17); ctx.closePath(); ctx.fill()
    }
    fillRRect(ctx, p.hair, 25, 26, 4.5, 13, 2)
    fillRRect(ctx, p.hair, 70.5, 26, 4.5, 13, 2)
  } else if (p.look === SIDE) {
    // Side-parted, the fringe swept across.
    ctx.beginPath()
    ctx.moveTo(25, 32); ctx.quadraticCurveTo(24, 9, 50, 9); ctx.quadraticCurveTo(76, 9, 75, 32)
    ctx.lineTo(71, 30); ctx.quadraticCurveTo(58, 20, 36, 26); ctx.lineTo(33, 22); ctx.lineTo(29, 33); ctx.closePath()
    ctx.fillStyle = p.hair
    ctx.fill()
    line(ctx, p.hairDk, 36, 12, 33, 22, 1.4)
    fillRRect(ctx, p.hair, 25, 27, 5, 14, 2)
    fillRRect(ctx, p.hair, 70, 27, 5, 14, 2)
  } else if (p.look === ELDER) {
    // Bald crown, hair only at the sides, in grey; a shine on the crown.
    fillRRect(ctx, p.hair, 25, 30, 6, 16, 3)
    fillRRect(ctx, p.hair, 69, 30, 6, 16, 3)
    fillRRect(ctx, 'rgba(255,255,255,0.22)', 38, 19, 14, 5, 2.5)
  }

  // Eyes
  const eyeY = 48.5
  const ew = 9.6
  const eh = 11.4 * Math.max(eyeOpen, 0.06)
  for (const ex of [40.5, 59.5]) {
    ctx.beginPath()
    ctx.ellipse(ex, eyeY, ew / 2, eh / 2, 0, 0, Math.PI * 2)
    ctx.fillStyle = '#FFFFFF'
    ctx.fill()
    if (eyeOpen > 0.3) {
      const lx = p.lookX || 0, ly = p.lookY || 0
      fillCircle(ctx, ink, ex + 0.4 + lx, eyeY + 0.8 + ly, 2.7)
      fillCircle(ctx, '#FFFFFF', ex - 0.5 + lx, eyeY - 0.4 + ly, 0.9)
    }
  }
  // Brows
  const browInk = p.look === ELDER ? p.hair : ink
  const browW = p.look === TURBAN ? 2.9 : (p.look === HIJAB || p.look === BOB) ? 2.0 : 2.4
  line(ctx, browInk, 34, 39.6, 46, 38.6, browW)
  line(ctx, browInk, 54, 38.6, 66, 39.6, browW)
  // Beard, moustache
  if (p.look === TURBAN) {
    fillRRect(ctx, ink, 27, 53, 46, 16, 11)
    fillRRect(ctx, ink, 38, 52, 24, 5, 2.5)
  }
  if (p.look === ELDER) {
    fillRRect(ctx, '#E4E5E7', 36.5, 54.5, 12.5, 4.4, 2.2)
    fillRRect(ctx, '#E4E5E7', 51, 54.5, 12.5, 4.4, 2.2)
    // Crow's feet, one shade darker.
    line(ctx, p.shade, 31.5, 47, 29.5, 50, 1.1)
    line(ctx, p.shade, 68.5, 47, 70.5, 50, 1.1)
  }
  // Web additions: a nose for everyone, and the small things that make a face someone's own.
  fillRRect(ctx, p.shade, 48.2, 51, 3.6, 3, 1.5)
  if (p.moustache && p.look !== TURBAN) fillRRect(ctx, p.hairDk || ink, 43, 54.8, 14, 2.4, 1.2)
  if (p.bindi) fillCircle(ctx, '#43307D', 50, 41, 1.5)
  if (p.earrings) {
    fillCircle(ctx, '#99641B', 24.5, 52, 1.7)
    fillCircle(ctx, '#99641B', 75.5, 52, 1.7)
  }
  // Mouth
  const mouthY = p.look === TURBAN ? 61 : 58
  const mouthInk = p.look === TURBAN ? '#8D9199' : ink
  ctx.beginPath()
  ctx.moveTo(44, mouthY)
  ctx.quadraticCurveTo(50, mouthY + 5 * p.smile, 56, mouthY)
  strokeRound(ctx, mouthInk, 1.8)
  // Glasses
  if (p.look === TURBAN) {
    fillRRect(ctx, ink, 30.5, 43, 17, 11, 5)
    fillRRect(ctx, ink, 52.5, 43, 17, 11, 5)
    line(ctx, ink, 47.5, 46.5, 52.5, 46.5, 2)
    line(ctx, ink, 30.5, 46, 24, 44.5, 1.6)
    line(ctx, ink, 69.5, 46, 76, 44.5, 1.6)
  } else if (p.glasses) {
    strokeCircle(ctx, ink, 40.5, eyeY, 7.2, 1.5)
    strokeCircle(ctx, ink, 59.5, eyeY, 7.2, 1.5)
    line(ctx, ink, 47.7, 47.6, 52.3, 47.6, 1.5)
    if (p.look !== HIJAB && p.look !== BOB) {
      line(ctx, ink, 33.3, 47.5, 25.5, 45.5, 1.4)
      line(ctx, ink, 66.7, 47.5, 74.5, 45.5, 1.4)
    }
  }
}


// ── makeCast — a crowd with no repeats ────────────────────────────────
// Every index is a different person: ten hair looks (no elderly — these
// are candidates), seven skin tones, hair and cloth colours, clothes
// (saffron and India green among them), glasses, and the small things —
// a moustache, a bindi, earrings, face width, smile. Give each on-screen
// figure its own index and no two faces on screen are ever the same.
const LOOKS = [HIJAB, CROP, TURBAN, BOB, PONY, CURLY, SPIKY, BUN, BRAIDS, SIDE]
const FEMALE = [HIJAB, BOB, PONY, BUN, BRAIDS]
const SKINS = [
  ['#F5DCC4', '#E6C3A5'], ['#F1D2B6', '#E0B896'], ['#E8C39E', '#D6AA80'], ['#D9A47C', '#C48D66'],
  ['#C68B59', '#B07648'], ['#A66E48', '#915D3B'], ['#8A5A3B', '#744A30'],
]
const HAIRS = [['#1E1F23', '#141518'], ['#2F3034', '#1E1F23'], ['#3B2A20', '#2A1D16'], ['#4A2E22', '#36201A'], ['#5A3A26', '#452C1C']]
const CLOTH = [['#94B7F2', '#6E9BE0'], ['#3671B5', '#2A5B93'], ['#F28C28', '#D97A1E'], ['#9A86D6', '#7C6BC4'],
  ['#138808', '#0F6E07'], ['#43307D', '#352566'], ['#E8E1F7', '#C9BEEA']]
const SHIRTS_ALL = [
  ['#DCE6FA', '#BFD2F7'], ['#C58226', '#A66E1E'], ['#575A5F', '#434449'], ['#7C6BC4', '#6556A8'],
  ['#1F4672', '#143153'], ['#9A86D6', '#8570C4'], ['#E8E1F7', '#D3C9EE'], ['#43307D', '#352566'],
  ['#F28C28', '#D97A1E'], ['#138808', '#0F6E07'], ['#FFFFFF', '#E3E1EA'], ['#2E6DA4', '#245887'],
]
export function makeCast(n = 64) {
  const out = []
  for (let i = 0; i < n; i++) {
    const look = LOOKS[i % LOOKS.length]
    const round = Math.floor(i / LOOKS.length)
    const [skin, shade] = SKINS[(i * 3 + round) % SKINS.length]
    const cloth = look === HIJAB || look === TURBAN
    const [hair, hairDk] = cloth ? CLOTH[(i * 5 + round) % CLOTH.length] : HAIRS[(i * 2 + round) % HAIRS.length]
    const [shirt, shirtDk] = SHIRTS_ALL[(i * 7 + 3 + round) % SHIRTS_ALL.length]
    const female = FEMALE.includes(look)
    out.push({
      look, skin, shade, hair, hairDk, shirt, shirtDk,
      glasses: look !== TURBAN && (i * 5 + round) % 3 === 0,
      smile: 0.55 + ((i * 37) % 10) / 12,
      faceW: ((i * 11) % 5) - 2,
      moustache: !female && look !== TURBAN && (i + round) % 3 === 1,
      bindi: female && look !== HIJAB && (i + round) % 2 === 0,
      earrings: female && look !== HIJAB && (i + round) % 3 !== 0,
      phase: (i * 1.37) % 7,
      blinkEvery: 3.4 + ((i * 13) % 9) * 0.35,
      breathEvery: 2.8 + ((i * 7) % 6) * 0.3,
    })
  }
  return out
}
