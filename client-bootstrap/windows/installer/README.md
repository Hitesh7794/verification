# Inno Setup installer — `OperatorPortalSetup-X.Y.Z.exe`

Wraps the existing `install.ps1` + all the vendor binaries in a single
double-click `.exe`. The operator runs the .exe, sees a wizard
(Welcome → License → Portal URL → Components → Install → Finish),
and ~90 seconds later their laptop is ready. No PowerShell knowledge,
no `Set-ExecutionPolicy`, no copy-paste.

This is **Phase 2** of the operator-laptop install story. Phase 1 (the
existing `.zip` bundle with `install.ps1`) still works — the `.exe`
installer is purely a friendlier front end.

## Output

```
output/OperatorPortalSetup-1.0.0.exe   ~240-250 MB
```

The admin portal's Downloads page will automatically pick this up over
the existing `.zip` once you drop it into the same `DOWNLOADS_DIR`
(the backend's file-selection rule is `.exe > .msi > .zip`, so the
Inno Setup output supersedes the zip with no UI change).

## Building (Windows)

You need a Windows machine with **Inno Setup 6** installed
(<https://jrsoftware.org/isinfo.php>, free, ~30 sec install).

```bat
REM From cmd.exe / PowerShell:
cd client-bootstrap\windows\installer
build.cmd
```

The build script:

1. Checks Inno Setup is installed at the standard location.
2. Checks the bundle staging dir exists (run
   `client-bootstrap/windows/build-bundle.sh` first if not).
3. Runs `ISCC.exe OperatorPortalSetup.iss`.
4. Outputs `output/OperatorPortalSetup-1.0.0.exe`.

Typical compile time on a modern laptop: ~30 seconds (LZMA2/max
compression on ~300 MB of input).

## Building from macOS / Linux (untested)

Inno Setup is Windows-only, but it runs cleanly under Wine. Untested
in this repo; for a quick reference:

```bash
# Install once:
brew install --cask wine-stable      # macOS
# OR: apt-get install wine            # Linux

# Download Inno Setup 6 .exe from jrsoftware.org/isinfo.php
# Install it inside wine:
wine innosetup-6.x.x.exe

# Compile:
cd client-bootstrap/windows/installer
wine "$HOME/.wine/drive_c/Program Files (x86)/Inno Setup 6/ISCC.exe" OperatorPortalSetup.iss
```

If you'd like proper CI for this, GitHub Actions has a Windows runner;
add a workflow that runs `build.cmd` on every tag push.

## What the wizard asks

| Page | What it does |
|---|---|
| Welcome | Standard greeting. |
| License | Shows `license.txt` (placeholder — replace with your institution's actual EULA before publishing). User must click "I accept". |
| **Portal URL** | Custom input page. Operator types the URL of their portal (e.g. `https://portal.example.com`). Validated as starting with `http://` or `https://`. |
| Components | Three options: Fingerprint (forced, the Mantra MorFin daemon), Startek (optional), Iris (optional, slower). Picked combination determines which `-Skip*` flags get passed to `install.ps1`. |
| Select Destination Location | Default `C:\Program Files\VerificationPortal\`. Operator can change. |
| Ready to Install | Standard confirmation. |
| Installing | Progress bar; `install.ps1` runs hidden in the background. |
| Finish | Optional "Open Verification Portal in browser" checkbox — ticked by default. |

## What happens inside the install step

The wizard invokes:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File "<install dir>\install.ps1" `
  -PortalUrl "<from wizard>" `
  -InstallRoot "<install dir>" `
  [-SkipIris] [-SkipStartek]
```

`install.ps1` does the actual work — same battle-tested script as
the zip flow. Log files land in `<install dir>\logs\` for troubleshooting.

## What gets uninstalled

The Inno Setup uninstaller (`<install dir>\unins000.exe`, also accessible
via Add/Remove Programs):

- Stops + removes the `MorfinAuthClientService` Windows service.
- Removes everything Inno Setup originally copied.
- Removes the `logs/` directory.

What it does NOT remove (intentional):

- The MorFin USB driver — other vendor apps might depend on it.
- The Startek Capture API MSI — vendor-installed, vendor-uninstalled
  via its own Add/Remove Programs entry.
- WSL2 itself — too disruptive; might be in use by other tooling.
- Browser homepage policy — operator may have moved on to a new
  portal URL via another tool.

For a full clean uninstall, follow the manual steps in the bundle's
README.txt.

## Code signing

**Deliberately unsigned** for now. Operators will see a SmartScreen
"Windows protected your PC — Unknown publisher" warning the first time.
The admin Downloads page already shows the 3-click dismissal procedure
(`More info → Run anyway → Yes`). When you're ready to invest in a
~₹15k/year Authenticode certificate, sign at compile time with:

```bat
signtool sign /f cert.pfx /p <password> /t http://timestamp.digicert.com OperatorPortalSetup-1.0.0.exe
```

(The .iss file doesn't need changes for signing — sign the output .exe.)

## File layout

```
client-bootstrap/windows/installer/
├── OperatorPortalSetup.iss   ← the Inno Setup script
├── license.txt               ← EULA shown on the License page (placeholder)
├── build.cmd                 ← Windows compile helper
├── README.md                 ← this file
└── output/                   ← created on first build; not tracked in git
    └── OperatorPortalSetup-1.0.0.exe
```

## Versioning when you ship 1.0.1, 1.1, etc.

Two-line change in `OperatorPortalSetup.iss`:

```iss
#define AppVersion "1.0.1"
```

Inno Setup handles in-place upgrades natively via the `AppId` (which is
a stable GUID — never change it). Operators run the new `.exe`; it
detects the existing install, uninstalls the old version, installs the
new one, preserves their portal URL settings via the registry. Total
operator effort: same as a fresh install.

## CI / release flow (suggested)

The intended pipeline is:

1. Tag the repo with `v1.0.1`.
2. GitHub Actions Windows runner: `build-bundle.sh` → `build.cmd`.
3. Upload `OperatorPortalSetup-1.0.1.exe` as a release artifact.
4. Replace the file in `backend/downloads/` on production; restart not
   needed (the admin Downloads page's manifest endpoint hashes on each
   request and pick the newest file automatically).

Not implemented yet — manual flow is fine until you have ~3+ colleges
deployed.
