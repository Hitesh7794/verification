# Biometric Verification Report — NTA issue

Everything needed to produce the report as HTML and as an A4 PDF: the builder,
the stylesheet, the artwork, and the modality marks as standalone SVG. Nothing
here reaches outside this folder, so it can be dropped into a codebase as-is.

```
package/
  build_report.py     the builder — data at the top, markup below
  report.css          every colour, size, weight and space, declared once
  assets/
    emblem.svg        State Emblem of India
    nta-logo.png      NTA lockup, masthead
    nta-watermark.png the same mark, sat in the stock behind the sheet
    paper-fibre.png   mill texture, tiled at 34mm
    paper-mottle.png  uneven cast across the sheet
    live-capture.jpg  specimen photograph — replace per record
  icons/
    face-pass.svg          fingerprint-pass.svg     iris-pass.svg
    face-fail.svg          fingerprint-fail.svg     iris-fail.svg
```

## Running it

```
python build_report.py            # writes NTA-Verification-Report-20002.html
python build_report.py --pdf      # ...and prints it to A4 PDF
python build_report.py --icons    # re-exports icons/*.svg from the builder
```

No third-party packages — the standard library only. `--pdf` shells out to
headless Chrome or Chromium; the paths it looks in are the `CHROME` list near
the bottom of the builder. The HTML step needs nothing but Python.

The HTML it writes is a single file. Artwork is embedded as base64 data URIs at
build time, so the page renders from any folder, as an email attachment, or on
a machine with no network.

The sheet is one A4 page and has about 5mm to spare against the printable
height of 279mm (297 less the 10mm and 8mm in `@page`). Adding a field or a
signing box will spill the attestation table onto a second page — it carries
`break-inside:avoid`, so it moves whole rather than splitting. The give is in
`.block` margins and `.sg-box` height.

## Wiring it to real data

Every value on the sheet comes from the block of constants at the top of
`build_report.py` — `AUTHORITY`, `META`, `CAND_NAME`, `ID_FIELDS`,
`PLACE_FIELDS`, `MODALITIES`, `RESULT_WORD`, `SIGNATURES`, `FOOTER`. Nothing
about the record is buried in the markup. Replace that block with your source
and the rest of the file is unchanged.

`MODALITIES` is a list of `(name, measured, minimum, device, passed)`. Only
`name` and `passed` reach the page — `passed` picks the colour and the badge.
The other three are the record and are deliberately kept, not printed.

The photograph is `assets/live-capture.jpg`; the builder uses the same image
for both the enrolled and the live frame. Point `photo` at two files if you
have both. If the file is missing the frames render empty rather than breaking.

## The stylesheet

`report.css` is an ordinary stylesheet with relative `url("assets/...")` paths,
so it can be served directly by an application. The builder's `stylesheet()`
inlines those two textures as data URIs only when producing the one-file HTML.

Colour, type, spacing and rules are all `:root` custom properties. The ones
worth knowing:

| token                        | value               | used for                          |
| ---------------------------- | ------------------- | --------------------------------- |
| `--navy`                     | `#173A70`           | headings, rules, the masthead      |
| `--ink` / `--muted`          | `#222222` / `#5F6368` | body text / labels               |
| `--pass` / `--fail`          | `#187A45` / `#B52A2A` | modality labels and marks, the verdict |
| `--paper` / `--line`         | `#FCFAF9` / `#D5D8DC` | the sheet / hairlines            |

One green and one red do the whole job: the mark, the label under it and the
verdict all draw from the same pair. Changing them in `report.css` changes the
exported icons too — `--icons` reads its colours out of the stylesheet rather
than carrying its own copy.

If a value appears twice as a literal in `report.css`, that is a bug.

## The marks

Each mark is a 24-unit glyph in a 30-unit box, with the verdict badge hanging
off the lower-right corner rather than sitting inside the drawing — so the
ridges of the print and the brackets of the face survive underneath it. The gap
around the badge is cut with an SVG mask, not covered with an opaque disc: this
block sits directly over the watermark, and a disc would punch three holes
in it.

The marks are set at 64px on the sheet — read across a desk, but still a mark
on a form rather than an illustration; the size is `.mi` in `report.css`.
Inline in the report they take their ink from the column through
`currentColor`. The exported files in `icons/` have no such context, so the
colour and an `xmlns` are written in; they are drop-in `<img>` sources at any
size. Regenerate them with `--icons` after changing a path or a token.

## Fonts

The page links Noto Sans and Noto Serif from Google Fonts. That is the one
thing in the build that reaches the network, and it degrades to Arial or
Helvetica if it cannot. For a genuinely offline artefact, embed the two
families as base64 `@font-face` rules in `report.css` and drop the `<link>`
tags from `build_report.py`.

## The emblem

The State Emblem of India is restricted by the State Emblem of India
(Prohibition of Improper Use) Act, 2005. It belongs on this sheet only because
the report is issued by the National Testing Agency, which is entitled to use
it. Do not carry `assets/emblem.svg` into work issued by anyone else.
