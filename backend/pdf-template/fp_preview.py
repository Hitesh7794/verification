#!/usr/bin/env python3
"""
fp_preview.py — decode a base64 ISO/IEC 19794-4 fingerprint image
record into a browser-renderable PNG.

Reads base64 from stdin (single line, no wrapping / no whitespace-
sensitivity — we strip whitespace before decoding). Writes PNG bytes
to stdout. Exits non-zero on any decode failure so the Go handler
returns an HTTP error instead of streaming garbage.

Handles the three compression algorithms Startek FM220U L1 hardware
actually emits per the UIDAI mandate:
  0  uncompressed (raw 8bpp grayscale)
  2  WSQ  (wsq package decodes to a PIL Image)
  3  JPEG (Pillow native)
  5  PNG  (Pillow native)

Kept intentionally tiny and dependency-light; imported by
verification_pdf_handlers.go's neighbour handler via subprocess.
"""

from __future__ import annotations

import base64
import io
import struct
import sys

from PIL import Image

# `wsq` registers a decoder plugin with Pillow on import — a bare
# `Image.open()` on WSQ bytes then works without further ceremony.
import wsq  # noqa: F401


# ISO/IEC 19794-4 general record header layout (32 bytes).
_GENERAL_HEADER_LEN = 32
# Finger view header (14 bytes) precedes each image record.
_FINGER_VIEW_HEADER_LEN = 14

# Compression algorithm bytes per ISO/IEC 19794-4 §7.2.
_COMPRESSION_UNCOMPRESSED         = 0
_COMPRESSION_UNCOMPRESSED_PACKED  = 1
_COMPRESSION_WSQ                  = 2
_COMPRESSION_JPEG                 = 3
_COMPRESSION_JPEG2000             = 4
_COMPRESSION_PNG                  = 5


def _parse_first_view(buf: bytes) -> tuple[int, int, int, int, bytes]:
    """Return (compression, pixel_depth, width, height, image_bytes)
    for the first finger view. Raises ValueError on any structural
    problem."""
    if len(buf) < _GENERAL_HEADER_LEN + _FINGER_VIEW_HEADER_LEN:
        raise ValueError("record too short for ISO 19794-4")
    if buf[0:4] != b"FIR\x00":
        raise ValueError(
            f"missing FIR magic; got {buf[0:4]!r} — payload isn't an "
            "ISO 19794-4 image record")
    num_views    = buf[16]
    pixel_depth  = buf[26]
    compression  = buf[27]
    if num_views < 1:
        raise ValueError("record declares zero finger views")

    off = _GENERAL_HEADER_LEN
    (view_len,) = struct.unpack(">I", buf[off:off + 4])
    if view_len < _FINGER_VIEW_HEADER_LEN or off + view_len > len(buf):
        raise ValueError("finger-view length out of range")
    (width,)  = struct.unpack(">H", buf[off + 9:  off + 11])
    (height,) = struct.unpack(">H", buf[off + 11: off + 13])
    if width < 1 or height < 1:
        raise ValueError(f"finger-view has zero dimension {width}x{height}")

    image_bytes = buf[off + _FINGER_VIEW_HEADER_LEN: off + view_len]
    return compression, pixel_depth, width, height, image_bytes


def _decode_inner(compression: int, pixel_depth: int, width: int, height: int,
                  image_bytes: bytes) -> Image.Image:
    if compression == _COMPRESSION_WSQ:
        # wsq plugin lets Pillow open WSQ from a BytesIO.
        return Image.open(io.BytesIO(image_bytes))
    if compression in (_COMPRESSION_JPEG, _COMPRESSION_JPEG2000, _COMPRESSION_PNG):
        return Image.open(io.BytesIO(image_bytes))
    if compression in (_COMPRESSION_UNCOMPRESSED, _COMPRESSION_UNCOMPRESSED_PACKED):
        if pixel_depth != 8:
            raise ValueError(
                f"uncompressed pixel_depth={pixel_depth} not supported "
                "(only 8bpp grayscale)")
        expected = width * height
        if len(image_bytes) < expected:
            raise ValueError(
                f"uncompressed image bytes too short: "
                f"got {len(image_bytes)}, need {expected}")
        return Image.frombytes("L", (width, height), image_bytes[:expected])
    raise ValueError(f"unsupported ISO 19794-4 compression algorithm: {compression}")


def _iso_to_png(iso_b64: str) -> bytes:
    """Public entry point — base64 in, PNG bytes out."""
    if not iso_b64:
        raise ValueError("empty base64 input")
    # Tolerate whitespace / newlines that JSON transport sometimes
    # sprinkles in.
    raw = base64.b64decode("".join(iso_b64.split()), validate=False)

    # Some ACPL firmware variants label the field "iso" but ship raw
    # BMP/PNG/JPEG. Match browser-side sniffing behaviour: if magic
    # bytes are a known standalone image format, re-encode as PNG
    # (cheaper than round-tripping through canvas on the client).
    if len(raw) >= 3 and raw[0:2] == b"BM":
        return _to_png_bytes(Image.open(io.BytesIO(raw)))
    if len(raw) >= 4 and raw[0:4] == b"\x89PNG":
        # Already PNG — but re-encode to strip any device metadata
        # and normalize colour depth. Round-trip is <5 ms.
        return _to_png_bytes(Image.open(io.BytesIO(raw)))
    if len(raw) >= 3 and raw[0:3] == b"\xff\xd8\xff":
        return _to_png_bytes(Image.open(io.BytesIO(raw)))

    compression, pixel_depth, width, height, image_bytes = _parse_first_view(raw)
    img = _decode_inner(compression, pixel_depth, width, height, image_bytes)
    return _to_png_bytes(img)


def _to_png_bytes(img: Image.Image) -> bytes:
    # Coerce paletted / palette+alpha to grayscale — fingerprints are
    # single-channel. Keeps the PNG small.
    if img.mode not in ("L", "LA", "RGB", "RGBA"):
        img = img.convert("L")
    out = io.BytesIO()
    img.save(out, format="PNG", optimize=False)
    return out.getvalue()


def main() -> int:
    try:
        b64 = sys.stdin.read()
        png = _iso_to_png(b64)
    except Exception as e:  # noqa: BLE001 — one-shot CLI, top-level catch is fine
        sys.stderr.write(f"fp_preview: {e}\n")
        return 2
    sys.stdout.buffer.write(png)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
