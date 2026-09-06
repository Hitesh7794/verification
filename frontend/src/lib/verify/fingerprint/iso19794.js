// ISO/IEC 19794-4 Finger Image Record decoder → browser-renderable
// data URL. Startek FM220U's ACPL Capture API returns the captured
// fingerprint as an ISO 19794-4 record in `isoImgBase64`. That format
// is raw binary (fixed-offset header + finger view header + image
// payload) — browsers don't decode it natively. This helper parses
// enough of the header to pull out the first finger view's width,
// height, compression algorithm, and image bytes, then produces a
// data: URL the operator UI can drop into a plain <img>.
//
// Supported compression algorithms per ISO 19794-4:
//   0  uncompressed, no bit-packing      → canvas render
//   1  uncompressed, bit-packed          → canvas render (bpp=8 only)
//   2  WSQ                               → not supported (browser can't)
//   3  JPEG                              → passthrough as image/jpeg
//   4  JPEG 2000                         → not supported
//   5  PNG                               → passthrough as image/png
//
// Anything the browser can't natively render returns null; the caller
// falls back to a plain "captured" placeholder so the flow doesn't
// break on unknown compression.

// General Record Header offsets (bytes 0..31).
const GENERAL_HEADER_LEN = 32
// Finger View Header offsets (14 bytes prefix inside each finger view).
const FINGER_VIEW_HEADER_LEN = 14

function b64ToBytes(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function bytesToB64(bytes) {
  // btoa can't take a Uint8Array directly; walk in chunks so large
  // buffers don't blow the call stack of String.fromCharCode.
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return btoa(s)
}

// Parse the general header + FIRST finger view. Returns null on any
// structural issue — safer than throwing into an operator flow.
function parseFirstView(bytes) {
  if (!bytes || bytes.length < GENERAL_HEADER_LEN + FINGER_VIEW_HEADER_LEN) return null
  // Magic "FIR\0" — some vendors use "FMR"/"FAC" for OTHER record
  // types; ISO 19794-4 image records use "FIR\0".
  if (bytes[0] !== 0x46 || bytes[1] !== 0x49 || bytes[2] !== 0x52 || bytes[3] !== 0x00) {
    return null
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const numViews = dv.getUint8(16)
  if (numViews < 1) return null
  const pixelDepth = dv.getUint8(26)
  const compression = dv.getUint8(27)

  // First finger view starts immediately after the general header.
  const viewOffset = GENERAL_HEADER_LEN
  const viewLen = dv.getUint32(viewOffset + 0, false) // big-endian
  if (viewLen < FINGER_VIEW_HEADER_LEN || viewOffset + viewLen > bytes.length) return null
  const width = dv.getUint16(viewOffset + 9, false)
  const height = dv.getUint16(viewOffset + 11, false)
  if (width < 1 || height < 1) return null

  const imageStart = viewOffset + FINGER_VIEW_HEADER_LEN
  const imageEnd = viewOffset + viewLen
  const image = bytes.subarray(imageStart, imageEnd)
  return { compression, pixelDepth, width, height, image }
}

function renderGrayscaleToPng(width, height, pixels) {
  // pixels.length should equal width*height for 8-bpp uncompressed.
  // If short (bit-packed), skip — real captures at 8bpp are the norm.
  if (pixels.length < width * height) return null
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const img = ctx.createImageData(width, height)
  for (let i = 0, j = 0; i < width * height; i++, j += 4) {
    const v = pixels[i]
    img.data[j]     = v
    img.data[j + 1] = v
    img.data[j + 2] = v
    img.data[j + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return canvas.toDataURL('image/png')
}

// Public API: given the base64 payload from Startek's `isoImgBase64`,
// return { dataUrl, width, height } the caller can drop into <img>,
// or null if we can't render it.
//
// Some ACPL firmware variants mislabel the field: they say "iso image"
// but actually ship raw BMP / JPEG / PNG bytes. We sniff the magic on
// the decoded bytes first — cheapest possible path — and only fall
// through to the ISO 19794-4 parser when we don't recognize a
// standalone image format.
export function isoImgToDataURL(isoImgB64) {
  if (!isoImgB64 || typeof isoImgB64 !== 'string') return null
  let bytes
  try {
    bytes = b64ToBytes(isoImgB64)
  } catch (_) {
    return null
  }
  if (bytes.length < 4) return null

  // Magic-byte sniffing — if the payload is already a standalone
  // browser-renderable image, return it verbatim. No canvas round-
  // trip needed: browsers render all three of these natively from a
  // data: URL.
  //   BMP:  42 4D                 ("BM")
  //   PNG:  89 50 4E 47           ("‰PNG")
  //   JPEG: FF D8 FF
  if (bytes[0] === 0x42 && bytes[1] === 0x4D) {
    return { dataUrl: 'data:image/bmp;base64,' + isoImgB64, width: 0, height: 0 }
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    return { dataUrl: 'data:image/png;base64,' + isoImgB64, width: 0, height: 0 }
  }
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return { dataUrl: 'data:image/jpeg;base64,' + isoImgB64, width: 0, height: 0 }
  }

  // Not a standalone image — try to parse as an ISO 19794-4 record.
  const view = parseFirstView(bytes)
  if (!view) return null

  const { compression, pixelDepth, width, height, image } = view
  switch (compression) {
    case 0: // uncompressed, no bit-packing
    case 1: // uncompressed, bit-packed (only handle 8bpp here — bit-
            // packed sub-8bpp variants are exotic and not what
            // FM220U ships)
      if (pixelDepth === 8) {
        const dataUrl = renderGrayscaleToPng(width, height, image)
        return dataUrl ? { dataUrl, width, height } : null
      }
      return null
    case 3: // JPEG
      return { dataUrl: 'data:image/jpeg;base64,' + bytesToB64(image), width, height }
    case 5: // PNG
      return { dataUrl: 'data:image/png;base64,' + bytesToB64(image), width, height }
    case 2: // WSQ — browsers don't decode
    case 4: // JPEG 2000 — Safari does but Chrome doesn't; skip
    default:
      return null
  }
}
