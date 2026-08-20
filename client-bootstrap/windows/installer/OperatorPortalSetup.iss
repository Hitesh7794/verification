; OperatorPortalSetup.iss — Inno Setup script for the Verification Portal
; operator-laptop install bundle.
;
; This wraps the existing install.ps1 (which has been verified end-to-end
; on real hardware) inside a single double-click .exe that a college's
; operator can run without touching PowerShell. The wizard asks for the
; portal URL, lets the operator opt out of optional components (Startek,
; Iris), and invokes install.ps1 with the appropriate flags in the
; background. install.ps1 still does ALL the heavy lifting — this is
; purely a friendlier front end.
;
; Why install.ps1 stays the source of truth (instead of translating
; everything into Inno Setup's Pascal scripting):
;   1. install.ps1 has been field-tested and debugged across multiple
;      Windows versions; rewriting it in Pascal would re-introduce
;      every bug we already squashed.
;   2. install.ps1 handles partial-failure cases (e.g. mid-WSL reboot
;      prompt) that would be painful to express in Pascal.
;   3. Single source of truth for the install logic — Inno Setup users
;      and direct-zip-extract users both run the same install.ps1.
;
; Code signing: deliberately UNSIGNED per the user's PR-1 decision (see
; admin Downloads page + DownloadsPanel.jsx — the SmartScreen warning
; is documented for operators with a 3-click dismissal procedure).
;
; Build (Windows + Inno Setup 6+):
;   "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" OperatorPortalSetup.iss
;   (Or use the build.cmd in this directory.)
;
; Build prerequisite: run client-bootstrap/windows/build-bundle.sh first
; so the bundle staging dir exists at:
;   client-bootstrap\windows\dist\VerificationPortalClient-1.0.0-windows\
;
; Output: client-bootstrap\windows\installer\output\OperatorPortalSetup-1.0.0.exe

#define AppName        "Verification Portal Operator Client"
#define AppShortName   "VerificationPortal"
#define AppVersion     "1.1.0"
#define AppPublisher   "Verification Portal"

; Portal URL is baked in at build time -- this .exe knows exactly which
; portal the operator laptop should connect to. Override at compile time
; with:  iscc /DPortalUrl=https://staging.example.com OperatorPortalSetup.iss
#ifndef PortalUrl
  #define PortalUrl "https://verifyportal.13-127-17-248.nip.io"
#endif
#define AppContact     PortalUrl

; Bundle staging dir, relative to this .iss file location.
; build-bundle.sh populates this; the [Files] section reads from it.
#define BundleDir      "..\dist\VerificationPortalClient-" + AppVersion + "-windows"

[Setup]
; A stable AppId is what lets Add/Remove Programs find existing installs
; on upgrade. Once generated, NEVER change — changing it would orphan
; every previous install on every operator's machine. Generated once
; via {{{B2DD3802-64CA-FDFE-FC61-5523F291B59E}}} (random GUID).
AppId={{B2DD3802-64CA-FDFE-FC61-5523F291B59E}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppContact}
AppSupportURL={#AppContact}
AppUpdatesURL={#AppContact}

; Install root: C:\Program Files\VerificationPortal\ on 64-bit Windows.
; install.ps1 also defaults to this path; the wizard lets the operator
; change it via the Select Destination Location page.
DefaultDirName={autopf}\{#AppShortName}
DefaultGroupName={#AppName}

OutputBaseFilename=OperatorPortalSetup-{#AppVersion}
OutputDir=output
; LZMA2/max is Inno Setup's most aggressive compression — slower compile
; (~30 sec on a modern laptop) but ~40 MB smaller .exe than the equivalent
; .zip. Worth it for an artefact downloaded over college Wi-Fi.
Compression=lzma2/max
SolidCompression=yes

; Admin elevation: the install registers a Windows service (nssm) and
; writes to HKLM. UAC prompt is automatic; without admin we fail fast
; rather than producing a half-installed system.
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=dialog

; 64-bit only -- the MorFin daemon's native DLLs are x64. The .NET-
; framework era 32-bit Windows world is irrelevant for Windows 10+
; operator laptops, but we explicitly refuse to install on x86.
; x64compatible covers native x64 + ARM64 machines running x64 binaries
; via emulation (Windows 11 ARM), which is the Inno Setup 6.3+ preferred
; identifier (replaces the deprecated bare "x64").
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

; Modern wizard chrome; the legacy style looks like a Windows XP install
; and would undermine trust.
WizardStyle=modern

; License page: backs the [Files] copy of license.txt — operators have
; to scroll through and click Accept before they can proceed. Standard
; consent flow.
LicenseFile=license.txt

; Behaviour: don't show the program-group selection page (operators
; don't need to customise where the Start Menu icons go).
DisableProgramGroupPage=yes

; SetupLogging captures Inno Setup's own actions to a log file the
; operator can attach to a support ticket if anything goes wrong.
; install.ps1 separately logs to {app}\logs\.
SetupLogging=yes

; Don't include the "Select Start Menu Folder" wizard page — we don't
; create any Start Menu icons of our own (install.ps1 handles browser
; shortcuts independently).
DisableDirPage=auto

; Uninstall: confirm with the user once before tearing down. We don't
; auto-uninstall the vendor MSIs (MorFin driver, Startek) because they
; might be in use by other things on the operator's machine.
UninstallDisplayName={#AppName}

; The wizard's window title. Operators see this in the taskbar.
SetupMutex=Global\{#AppShortName}_Setup

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

; -----------------------------------------------------------------------
; Components — what the operator can opt in/out of.
;
; Fingerprint (Mantra MorFin) is forced because that's the headline
; feature. Startek and Iris are optional — the audit dropped iris from
; the default install earlier (see CONTEXT §16) because most colleges
; don't need it and the WSL2 reboot adds ~10 min to install time.
; Compact = bare minimum (fingerprint only).
; Full    = everything including Iris.
; -----------------------------------------------------------------------
[Components]
Name: "fingerprint"; Description: "Mantra MorFin fingerprint daemon (required)"; \
  Types: full compact custom; Flags: fixed
Name: "startek"; Description: "Startek FM220U / AST300 capture API (extra fingerprint hardware)"; \
  Types: full
Name: "iris"; Description: "Marvis iris service + IriShield / MIS100V2 USB driver (native Windows, no WSL)"; \
  Types: full

; -----------------------------------------------------------------------
; Files — copied from the bundle staging dir to {app} on install.
;
; ignoreversion: copy regardless of the existing file's version (we're
; not shipping COM components; the daemons we install have no embedded
; version resource to compare against).
; recursesubdirs: walk subfolders too (morfin/jre/ is deeply nested).
; -----------------------------------------------------------------------
[Files]
; Common to all installs.
Source: "{#BundleDir}\install.ps1";    DestDir: "{app}"; Flags: ignoreversion
Source: "{#BundleDir}\uninstall.ps1";  DestDir: "{app}"; Flags: ignoreversion
Source: "{#BundleDir}\README.txt";     DestDir: "{app}"; Flags: ignoreversion

; Fingerprint daemon (forced):
;   morfin/morfinauth-client-service-1.0.0.0.jar
;   morfin/MorFinDriver_1.4.1.1.exe
;   morfin/certs/*.crt
;   morfin/jre/      -- bundled Adoptium JRE 17
;   tools/nssm.exe
Source: "{#BundleDir}\morfin\*";       DestDir: "{app}\morfin"; \
  Components: fingerprint; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#BundleDir}\tools\*";        DestDir: "{app}\tools"; \
  Components: fingerprint; Flags: ignoreversion recursesubdirs

; Startek payload -- only if the operator picked the component.
Source: "{#BundleDir}\startek\*";      DestDir: "{app}\startek"; \
  Components: startek; Flags: ignoreversion recursesubdirs

; Iris payload -- Marvis Auth Client Service (native Windows daemon on
; localhost:8031) AND the IriShield / MIS100V2 USB driver (VID 1F63).
; Both live under vendor/ and install.ps1 runs the driver first, then
; the service. The old WSL2 .deb + wsl-iris-setup.sh path is retired.
Source: "{#BundleDir}\vendor\*";       DestDir: "{app}\vendor"; \
  Components: iris; Flags: ignoreversion recursesubdirs

; -----------------------------------------------------------------------
; Run section — fires AFTER files are copied. We invoke install.ps1
; here, passing the portal URL and the -Skip flags derived from the
; operator's component choices.
;
; runhidden + waituntilterminated: the PowerShell window doesn't pop
; up (less scary for non-technical operators); Inno Setup blocks on
; install.ps1 finishing so the progress bar reflects real progress.
; -----------------------------------------------------------------------
[Run]
; install.ps1 does the real work -- driver install, service registration,
; certificate imports, homepage policy, shortcuts. Runs visibly in a new
; console window (not hidden) so operators watch progress rather than
; staring at a stuck-looking wizard for 5-10 min. waituntilterminated
; blocks the wizard's Finish page until the script exits, so no one
; clicks the shortcut before services are up.
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\install.ps1"" -PortalUrl ""{#PortalUrl}"" -InstallRoot ""{app}""{code:GetSkipFlags}"; \
  WorkingDir: "{app}"; \
  StatusMsg: "Installing biometric drivers + services (5-10 min, watch the PowerShell window)..."; \
  Flags: waituntilterminated

; Post-install: offer to open the portal in the operator's default browser.
; Baked URL -- no code-hook needed. Operator can untick this on the Finish
; page if they want to install other software first.
Filename: "{#PortalUrl}"; \
  Description: "Open the Verification Portal in your browser"; \
  Flags: postinstall shellexec nowait skipifsilent

; -----------------------------------------------------------------------
; UninstallRun — fires BEFORE files are removed. Tears down the MorFin
; service so Windows doesn't refuse to delete the jar (locked by the
; running JVM). The Startek MSI is uninstalled separately by the
; operator via Add/Remove Programs — we don't auto-remove vendor
; installers we didn't write.
;
; We deliberately do NOT remove the Mantra MorFin USB driver — the
; operator might have multiple Mantra-using apps on this laptop and
; pulling the driver would break the others.
; -----------------------------------------------------------------------
[UninstallRun]
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""Stop-Service MorfinAuthClientService -Force -ErrorAction SilentlyContinue; & '{app}\tools\nssm.exe' remove MorfinAuthClientService confirm"""; \
  Flags: runhidden waituntilterminated; \
  RunOnceId: "stop_morfin_service"

; -----------------------------------------------------------------------
; UninstallDelete — files install.ps1 created at runtime that aren't
; tracked by Inno Setup's own bookkeeping. logs/ holds nssm log files
; that grow at runtime; we own this directory, safe to wipe.
; -----------------------------------------------------------------------
[UninstallDelete]
Type: filesandordirs; Name: "{app}\logs"

; -----------------------------------------------------------------------
; Custom Pascal code: skip-flag derivation from component checkboxes.
; Portal URL is baked in at compile time (#define PortalUrl above) so
; no input page -- operators can install without knowing the URL.
; -----------------------------------------------------------------------
[Code]
function GetSkipFlags(Param: String): String;
begin
  // Returns a string with leading space, e.g. " -SkipIris -SkipStartek".
  // install.ps1 expects whatever-isn't-selected to be skipped. If a
  // component is selected, we DON'T pass the corresponding -Skip flag.
  Result := '';
  if not WizardIsComponentSelected('iris') then
    Result := Result + ' -SkipIris';
  if not WizardIsComponentSelected('startek') then
    Result := Result + ' -SkipStartek';
end;
