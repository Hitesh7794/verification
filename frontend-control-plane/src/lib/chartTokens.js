// Shared chart tokens for the admin + superadmin dashboards.
//
// Categorical slots are assigned in FIXED ORDER and keyed to an entity,
// never to rank — a filter or a change in volume ordering must not
// repaint the survivors. Validated as a 5-slot categorical set against
// this app's white card surface (#ffffff): lightness band, chroma floor,
// adjacent CVD separation (worst ΔE 9.1) and normal-vision floor (worst
// ΔE 19.6) all pass.
//
// Three of the five land under 3:1 contrast on white, so the relief rule
// applies wherever they're used: ship visible labels or a table view, so
// colour never carries meaning on its own.
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4']

// Status tokens are reserved for state — good/bad — and are never reused
// as a series colour. Verified/denied is genuinely status, so it belongs
// here rather than in the categorical ramp.
export const STATUS_GOOD = '#0ca30c'
export const STATUS_BAD = '#d03b3b'

// Chart chrome. Recessive by design: the grid should sit one shade off
// the surface, never compete with the data.
export const INK_MUTED = '#898781'
export const GRID = '#e1e0d9'
export const SURFACE = '#ffffff'

// Indian digit grouping (1,23,456) — the audience is Indian institutions.
export const nf = new Intl.NumberFormat('en-IN')
