"""Biometric Verification Report — NTA issue, government document template.

    python build_report.py            # writes the HTML
    python build_report.py --pdf      # ...and prints it to A4 PDF
    python build_report.py --icons    # re-exports icons/*.svg

Written to one rule: this should read as a departmental form that has existed
for years and was professionally digitised, not as a designed artefact. Which
in practice means the page is built from four things and nothing else —
rectangles, 1px rules, a fixed type scale, and disciplined alignment. There are
no cards, no radii above 1px, no shadows, no gradients, no pills, no accent
colours beyond the four declared below.

Every colour, size, weight and space is a CSS variable declared once in :root
and reused. If a value appears twice as a literal, that is a bug.

DATA. Every value lives in the block of constants below — candidate, centre,
timings, all three modality readings and thresholds, devices, verdict. Nothing
about the record is buried in the markup, so wiring this to a real source means
replacing that block and nothing else.

The readings and thresholds are no longer printed: the sheet states each
modality by name in green or red, with a tick or cross on the mark. They are
kept here because they are the record, and because a later revision may want
them back.

THE EMBLEM. The State Emblem of India is restricted by the State Emblem of
India (Prohibition of Improper Use) Act, 2005. It belongs here only because the
report is issued by NTA, which is entitled to use it.
"""
import argparse, base64, json, re, shutil, subprocess, sys
from pathlib import Path

HERE      = Path(__file__).resolve().parent
ASSETS    = HERE / "assets"
ICONS_DIR = HERE / "icons"
OUT       = HERE

MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}


def b64(p: Path) -> str:
    return base64.b64encode(p.read_bytes()).decode()


def stylesheet() -> str:
    """report.css, with every url("assets/...") folded in as a data URI.

    The stylesheet on disk carries ordinary relative paths so it can be dropped
    into a codebase and served as it is. They are inlined only for the one-file
    HTML, which has to survive being emailed with no folder beside it.
    """
    css = (HERE / "report.css").read_text(encoding="utf-8")

    def sub(m):
        p = ASSETS / m.group(1)
        return 'url("data:%s;base64,%s")' % (MIME[p.suffix.lower()], b64(p))

    return re.sub(r'url\("assets/([^"]+)"\)', sub, css)

# ── the record ──────────────────────────────────────────────────────────────
AUTHORITY = "National Testing Agency"
SYSTEM    = "Central Candidate Biometric Verification System"
DOCTITLE  = "Biometric Verification Report"
EXAM_NAME = "National Eligibility cum Entrance Test (UG) 2026 (NEET2)"

META = [
    ("Centre Code",     "DL-0402"),
    ("Reference",       "VER-68"),
    ("Date",            "13 August 2026"),
    ("Time",            "21:36 IST"),
]

CAND_NAME = "Ankur Sir"
ID_FIELDS = [
    ("Roll Number",         "20002"),
    ("Registration ID",     "NEET2-2026-0002"),
    ("Father&rsquo;s Name", "Rajesh Sharma"),
    ("Gender &amp; Date of Birth", "Male&ensp;|&ensp;15 May 2004"),
]
PLACE_FIELDS = [
    ("Shift / Session",   "Morning Shift (09:00 AM &ndash; 12:00 PM)"),
    ("Centre Name",       "Govt Sarvodaya Vidyalaya, Sector 4"),
    ("Venue Address",     "Plot No. 12, Institutional Area, New Delhi, Delhi, 110..."),
    ("Verification Time", "13 Aug 2026 at 21:36 IST"),
]

# modality, measured, minimum, system, pass
MODALITIES = [
    ("Face",        "98.4%", "80%", "TrustView Vision v4",     True),
    ("Fingerprint", "12",    "40",  "Mantra MFS500 (ISO/IEC)", False),
    ("Iris",        "84.0%", "50%", "Mantra MIS100V2 Dual",    True),
]

RESULT_LEAD = "Final status: Biometric verification"
RESULT_WORD = "Mismatch"

SIGNATURES = [
    ("Candidate Signature",              "Ankur", "Signature of Candidate"),
    ("Biometric Operator",               "",      "Operator Sign &amp; Stamp"),
    ("Centre Superintendent / Observer", "",      "Official Seal &amp; Signature"),
]

# The foot carried the centre, the reference, the timestamp, a page count and a
# machine-generated notice — every one of which is already on the sheet above.
# It is gone, and the room it was taking has gone to the signing boxes.
FOOTER = "Centre DL-0402&ensp;&middot;&ensp;Ref. VER-68"

# No tick, no cross. On a form the colour is the verdict: the modality name in
# green reads as met, in red as not met. A glyph on top of that is decoration.
WARN = ('<svg class="wm" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
        'stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter">'
        '<path d="M12 3L22 20.5H2z"/><path d="M12 9.5v5"/>'
        '<path d="M12 17.4h.01"/></svg>')


# The reading is gone from the sheet; the modality itself is now the whole
# statement, so it needs a mark to carry it. Three line glyphs at the same
# weight as the warning mark above, drawn in currentColor so the green/red
# on the modality colours the icon with it.
ICONS = {
  "Face": '<path d="M3 8.5V3h5.5"/><path d="M21 8.5V3h-5.5"/>'
          '<path d="M3 15.5V21h5.5"/><path d="M21 15.5V21h-5.5"/>'
          '<circle cx="12" cy="10" r="2.4"/>'
          '<path d="M7.6 17.6c0-2.4 2-3.9 4.4-3.9s4.4 1.5 4.4 3.9"/>',
  # Nested ridges with tails: without the ends turning down it reads as a
  # signal-strength glyph rather than a print.
  "Fingerprint": '<g transform="translate(-1.4,-.6)">'
          '<path d="M12 15v5.6"/>'
          '<path d="M9.6 18.4v-4.9a2.4 2.4 0 0 1 4.8 0v4.9"/>'
          '<path d="M7.4 19.8v-6.3a4.6 4.6 0 0 1 9.2 0v3.7"/>'
          '<path d="M5.2 18.8v-5.3a6.8 6.8 0 0 1 13.6 0v2.7"/>'
          '<path d="M3 16.8v-3.3a9 9 0 0 1 18 0v1.7"/></g>',
  "Iris": '<path d="M1.6 12S5.6 5.6 12 5.6 22.4 12 22.4 12 18.4 18.4 12 18.4 1.6 12 1.6 12z"/>'
          '<circle cx="12" cy="12" r="3.4"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>',
}


# The verdict badge, as in the reference: a filled disc in the modality's own
# colour carrying a white tick or cross, sat on the lower right of the mark. The
# halo behind it is the paper colour, so the disc reads as sitting *on* the
# glyph rather than tangled in its lines.
TICK  = ('<path d="M19.1 22.6l2.5 2.6 4.6-5" stroke="#fff" stroke-width="2.3" '
         'fill="none" stroke-linecap="round" stroke-linejoin="round"/>')
CROSS = ('<path d="M20 19.9l5.3 5.3M25.3 19.9l-5.3 5.3" stroke="#fff" '
         'stroke-width="2.3" fill="none" stroke-linecap="round"/>')


def icon(name, ok):
    # The box is 30 wide for a 24-wide glyph: the badge hangs off the corner
    # rather than sitting inside the drawing, so the ridges of the print and the
    # brackets of the face survive underneath it.
    #
    # The gap around the badge is cut out of the glyph with a mask rather than
    # covered with a paper-coloured disc. A disc would be opaque, and this block
    # sits directly over the watermark — it would punch three holes in it.
    m = f"mi-{name.lower()}"
    return ('<svg class="mi" viewBox="0 0 30 30" fill="none" stroke="currentColor" '
            'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'
            f'<defs><mask id="{m}">'
            '<rect width="30" height="30" fill="#fff"/>'
            '<circle cx="22.5" cy="22.5" r="8.6" fill="#000"/></mask></defs>'
            f'<g mask="url(#{m})">{ICONS[name]}</g>'
            '<circle cx="22.5" cy="22.5" r="7" fill="currentColor" stroke="none"/>'
            f'{TICK if ok else CROSS}</svg>')


def main(out_dir=None, enrolled_photo=None, probe_photo=None):
    out_dir = Path(out_dir) if out_dir else OUT
    out_dir.mkdir(parents=True, exist_ok=True)

    emblem = (ASSETS / "emblem.svg").read_text(encoding="utf-8")
    emblem = re.sub(r"<\?xml[^>]*\?>", "", emblem).strip()
    emblem = emblem.replace('width="550"', "").replace('height="876.55"', "")
    nta = b64(ASSETS / "nta-logo.png")
    ntawm = b64(ASSETS / "nta-watermark.png")

    def photo_img(path_str, fallback=None):
        p = Path(path_str) if path_str else None
        if p and p.exists():
            mime = "image/png" if p.suffix.lower() == ".png" else "image/jpeg"
            return f'<img src="data:{mime};base64,{b64(p)}" alt="">'
        if fallback and fallback.exists():
            mime = "image/png" if fallback.suffix.lower() == ".png" else "image/jpeg"
            return f'<img src="data:{mime};base64,{b64(fallback)}" alt="">'
        return ""

    fallback = ASSETS / "live-capture.jpg"
    shot_enrolled = photo_img(enrolled_photo, fallback if not enrolled_photo else None)
    shot_probe    = photo_img(probe_photo,    fallback if not probe_photo    else None)

    meta = "".join(f"<tr><th>{k}</th><td>{v}</td></tr>" for k, v in META)

    def fieldrows(rows):
        return "".join(f"<tr><th>{k}</th><td>{v}</td></tr>" for k, v in rows)

    mods = "".join(
        f'<div class="mod {"p" if ok else "f"}">{icon(name, ok)}'
        f'<div class="mod-n">{name}</div></div>'
        for name, _val, _min, _sysname, ok in MODALITIES)

    sigs = "".join(
        f"<td><div class=\"sg-t\">{t}</div>"
        f'<div class="sg-box">{"<span>" + hand + "</span>" if hand else ""}</div>'
        f'<div class="sg-c">{c}</div></td>' for t, hand, c in SIGNATURES)

    body = f"""<main class="sheet">
      <div class="wmark"><img src="data:image/png;base64,{ntawm}" alt=""></div>
      <header class="masthead">
        <div class="mh-mark">
          <div class="emblem">{emblem}</div>
          <div class="mh-id">
            <img class="ntamark" src="data:image/png;base64,{nta}"
                 alt="{AUTHORITY}">
            <p class="mh-sys">{SYSTEM}</p>
          </div>
        </div>
        <table class="mh-meta"><tbody>{meta}</tbody></table>
      </header>

      <div class="doctitle">
        <h1>{DOCTITLE}</h1>
        <p class="dt-exam">{EXAM_NAME}</p>
      </div>

      <section class="block">
        <h2>Candidate Particulars</h2>
        <div class="cand">
          <div class="cand-l">
            <p class="cand-name">{CAND_NAME}</p>
            <table class="fields"><tbody>{fieldrows(ID_FIELDS)}</tbody></table>
          </div>
          <table class="photos"><tbody>
            <tr><td>{shot_enrolled}</td><td>{shot_probe}</td></tr>
            <tr><th>Enrolled Photograph</th><th>Live Capture</th></tr>
          </tbody></table>
        </div>
        <div class="pcols">
          <table class="fields"><tbody>{fieldrows(PLACE_FIELDS[:2])}</tbody></table>
          <table class="fields"><tbody>{fieldrows(PLACE_FIELDS[2:])}</tbody></table>
        </div>
      </section>

      <section class="block">
        <h2>Biometric Verification Summary</h2>
        <div class="mods">{mods}</div>
      </section>

      <section class="block">
        <div class="result">
          <div class="res-head">{WARN}
            <h3>{RESULT_LEAD} &mdash; <span>{RESULT_WORD}</span></h3></div>
        </div>
      </section>

      <section class="block">
        <table class="sigs"><tbody><tr>{sigs}</tr></tbody></table>
      </section>

      <footer class="docfoot">{FOOTER}</footer>
    </main>"""

    html = ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
            '<title>Biometric Verification Report</title>'
            '<link rel="preconnect" href="https://fonts.googleapis.com">'
            '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
            '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?'
            'family=Noto+Sans:wght@400;600;700&family=Noto+Serif:wght@700'
            '&display=swap">'
            f"<style>{stylesheet()}</style>"
            f"</head><body>{body}</body></html>")
    # File name uses the first ID field (roll number) so multiple
    # renders in the same folder don't collide.
    roll = ID_FIELDS[0][1] if ID_FIELDS else "report"
    roll = re.sub(r"[^A-Za-z0-9_-]", "_", str(roll)) or "report"
    out = out_dir / f"NTA-Verification-Report-{roll}.html"
    out.write_text(html, encoding="utf-8")
    print(f"  {out.name} — {len(html)//1024} KB, A4")
    return out


def token(name: str) -> str:
    """Read a colour straight out of report.css.

    The stylesheet is the single declaration of every value in this report; an
    exported icon carrying its own copy of the green would be a second one.
    """
    css = (HERE / "report.css").read_text(encoding="utf-8")
    return re.search(rf"--{name}:\s*(#[0-9A-Fa-f]{{6}})", css).group(1)


def write_icons():
    """The six marks as standalone files — one per modality, per verdict.

    On the sheet the glyph inherits its ink from the column through
    currentColor, and needs no xmlns because it is inline HTML. A file opened
    on its own has neither, so both are written in here.
    """
    ICONS_DIR.mkdir(exist_ok=True)
    ink = {True: token("pass"), False: token("fail")}
    for name in ICONS:
        for state, ok in (("pass", True), ("fail", False)):
            key, uid = name.lower(), f"{name.lower()}-{state}"
            svg = (icon(name, ok)
                   .replace('<svg class="mi" ',
                            '<svg xmlns="http://www.w3.org/2000/svg" '
                            'width="96" height="96" ')
                   .replace('"currentColor"', f'"{ink[ok]}"')
                   .replace(f'id="mi-{key}"', f'id="mi-{uid}"')
                   .replace(f'url(#mi-{key})', f'url(#mi-{uid})'))
            p = ICONS_DIR / f"{uid}.svg"
            p.write_text(svg + "\n", encoding="utf-8")
            print(f"  icons/{p.name}")


CHROME = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "google-chrome", "chromium", "chromium-browser",
]


def write_pdf(html: Path):
    """A4 through headless Chrome. The margins live in report.css, in @page.

    --no-sandbox is needed when Chrome runs from a shell where the user
    lacks the sandbox setuid helper (e.g. Docker, some CI, our Linux
    prod box); harmless on Mac.
    """
    exe = next((c for c in CHROME if Path(c).exists() or shutil.which(c)), None)
    if exe is None:
        sys.exit("  Chrome or Chromium is required to print the PDF.")
    pdf = html.with_suffix(".pdf")
    subprocess.run([exe, "--headless=new", "--disable-gpu",
                    "--no-sandbox", "--no-pdf-header-footer",
                    f"--print-to-pdf={pdf}", html.as_uri()], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(f"  {pdf.name} — {pdf.stat().st_size // 1024} KB")


def _apply_data(data: dict):
    """Overwrite the module-level constants from a JSON record.

    Accepts the same names as the constants declared above (AUTHORITY,
    META, ID_FIELDS, MODALITIES, etc.). Missing keys keep the default.
    List-of-tuples fields (META, ID_FIELDS, MODALITIES, SIGNATURES) come
    in from JSON as list-of-lists — convert to tuples so the HTML
    formatter's unpacking still works.
    """
    tuple_fields = {"META", "ID_FIELDS", "PLACE_FIELDS", "MODALITIES", "SIGNATURES"}
    g = globals()
    for k, v in data.items():
        if k in tuple_fields and isinstance(v, list):
            v = [tuple(row) if isinstance(row, list) else row for row in v]
        g[k] = v


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Biometric Verification Report builder")
    ap.add_argument("--icons", action="store_true", help="Re-export icons/*.svg from the builder")
    ap.add_argument("--pdf",   action="store_true", help="Also print to A4 PDF via headless Chrome/Chromium")
    ap.add_argument("--data",  help="Path to a JSON file whose keys override the module constants (or '-' for stdin)")
    ap.add_argument("--out",   help="Output directory (default: this folder)")
    ap.add_argument("--enrolled-photo", help="Path to the enrolled photograph JPEG/PNG")
    ap.add_argument("--probe-photo",    help="Path to the live-capture photograph JPEG/PNG")
    args = ap.parse_args()

    if args.icons:
        write_icons()
        sys.exit(0)

    if args.data:
        raw = sys.stdin.read() if args.data == "-" else Path(args.data).read_text(encoding="utf-8")
        _apply_data(json.loads(raw))

    page = main(out_dir=args.out, enrolled_photo=args.enrolled_photo, probe_photo=args.probe_photo)
    if args.pdf:
        write_pdf(page)
