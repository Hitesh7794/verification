# install.ps1 — operator-laptop bootstrap (Windows 10 19041+ / Windows 11).
#
# Architecture:
#
#   ┌─ Windows host ─────────────────────────────────────────────────────┐
#   │  Browser ─-> portal URL              (portal frontend, served remote) │
#   │           ─-> localhost:8030          (Mantra MorFin FP, native Win)  │
#   │           ─-> localhost:4443 / :8090  (Startek/ACPL FP, native Win)   │
#   │           ─-> localhost:8031          (mantra-iris-service in WSL2)   │
#   │                                                                       │
#   │  WSL2 Ubuntu ─ runs mantra-iris-service.deb on :8031                  │
#   │       ↑                                                               │
#   │       │ usbipd-win passes through MIS100V2 (vendor 2c0f:2100)         │
#   │       │ — needed because Mantra's Marvis_Auth.jar Windows DLL has a   │
#   │       │   JNI signature mismatch (vendor bug); the Linux .so in the   │
#   │       │   same JAR works fine.                                        │
#   │       ▼                                                               │
#   │  USB devices: MorFin readers (MELO041/MFS500/MARC10), Startek FM220U  │
#   │  L1 (0BCA:8230) / AST300 (34F9:8230), Marvis MIS100V2 (2c0f:2100).    │
#   └───────────────────────────────────────────────────────────────────────┘
#
# Two-phase: if WSL2 isn't enabled, phase 1 enables Windows features and
# prompts for a reboot. After reboot, re-run; the script detects WSL2 is
# now ready and continues with provisioning.
#
# Re-runnable: every step is idempotent, so re-running after a partial
# failure or to update config is safe.
#
# Run in an elevated PowerShell:
#
#   Set-ExecutionPolicy -Scope Process Bypass
#   .\install.ps1 -PortalUrl https://portal.example.com

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PortalUrl,

    [string]$InstallRoot = "C:\Program Files\VerificationPortal",

    # WSL distro to provision the iris service in. Default Ubuntu 22.04
    # (current LTS, well-supported by usbipd + systemd in WSL).
    [string]$WslDistro = "Ubuntu-22.04",

    # Mantra iris device USB hardware ID (vendor:product). Found via
    # `usbipd list` on a host with the device plugged in. Documented in
    # IRIS_VENDOR_ISSUE.md as VID 2C0F / PID 2100 for MIS100V2.
    [string]$IrisHwId = "2c0f:2100",

    # Skip iris provisioning. Use only when iris hardware isn't part of
    # the deployment (fingerprint-only centers).
    [switch]$SkipIris,

    # Skip Startek/ACPL Capture API install. Use only when Startek
    # (FM220U L1 / AST300) devices aren't part of the deployment and only
    # Mantra MorFin fingerprint readers are in use. Defaults to off: the
    # frontend transparently picks whichever vendor has a device plugged
    # in, so having both daemons installed is harmless.
    [switch]$SkipStartek
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------

function Require-Admin {
    $current = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]$current
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Run from an elevated PowerShell prompt (Right-click -> 'Run as Administrator')."
    }
}

function Require-OsCompatible {
    # WSL2 needs Windows 10 build 19041+ (May 2020 update / version 2004)
    # or Windows 11 (build 22000+). 32-bit Windows isn't supported either.
    if (-not [System.Environment]::Is64BitOperatingSystem) {
        throw "32-bit Windows detected. WSL2 requires 64-bit. Use a Linux operator laptop instead."
    }
    $build = [System.Environment]::OSVersion.Version.Build
    if ($build -lt 19041) {
        throw @"
Windows build $build is too old for WSL2 (requires 19041+).
Run Windows Update until Settings -> System -> About shows
'Version 22H2' (or newer) and 'OS build 19045+' / Windows 11.
Then re-run this installer.
"@
    }
    Write-Host "[OK] Windows build $build (WSL2-capable)"
}

function Require-Java {
    # Check whether 'java' resolves on PATH. We deliberately do NOT invoke
    # `java -version` for the test, because Java writes its version banner
    # to stderr — and on Windows PowerShell 5.1 with ErrorActionPreference=
    # Stop, any native-command stderr output is treated as a fatal error.
    # That made the previous test report "Java not found" even when Java
    # was installed correctly. Get-Command checks PATH resolution without
    # running the command.
    if (-not (Get-Command java -ErrorAction SilentlyContinue)) {
        throw @"
Java not found on PATH. Install Adoptium Temurin JRE 17 (free, OpenJDK):
  https://adoptium.net/temurin/releases/?version=17
Tick 'Add to PATH' during install, open a new PowerShell, then re-run this script.
"@
    }
    Write-Host "[OK] Java available on PATH"
}

# ---------------------------------------------------------------------------
# Phase 1 — WSL2 enablement (may require reboot)
# ---------------------------------------------------------------------------

function Test-Wsl2Ready {
    # Check the underlying Windows optional features directly — more robust
    # than invoking `wsl --status`, which writes its banner to stderr (which
    # PS5.1 turns into a terminating error under ErrorActionPreference=Stop).
    $f1 = (Get-WindowsOptionalFeature -Online -FeatureName 'Microsoft-Windows-Subsystem-Linux' -ErrorAction SilentlyContinue).State
    $f2 = (Get-WindowsOptionalFeature -Online -FeatureName 'VirtualMachinePlatform' -ErrorAction SilentlyContinue).State
    return ($f1 -eq 'Enabled' -and $f2 -eq 'Enabled')
}

function Test-WslDistroPresent([string]$Name) {
    # `wsl -l -q` lists installed distros (one per line, UTF-16-LE on
    # older WSL — strip nulls before matching). EAP=Continue locally so
    # any banner-on-stderr from older WSL builds doesn't terminate the
    # script before we get to inspect the output.
    $oldPref = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $list = (& wsl.exe -l -q 2>$null) -replace "`0", "" -split "`r?`n" | Where-Object { $_ }
        return ($list -contains $Name)
    } catch {
        return $false
    } finally {
        $ErrorActionPreference = $oldPref
    }
}

function Enable-Wsl2 {
    Write-Host "-> enabling WSL2 + Virtual Machine Platform (Windows features)"
    # Enabling these features requires a reboot before they take effect.
    # `dism /online /norestart` keeps the script responsive; we tell the
    # user to reboot at the end and re-run.
    $needsReboot = $false
    foreach ($feature in @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')) {
        $state = (Get-WindowsOptionalFeature -Online -FeatureName $feature -ErrorAction SilentlyContinue).State
        if ($state -ne 'Enabled') {
            Write-Host "  enabling $feature..."
            Enable-WindowsOptionalFeature -Online -FeatureName $feature -NoRestart -All | Out-Null
            $needsReboot = $true
        } else {
            Write-Host "  [OK] $feature already enabled"
        }
    }

    Write-Host "-> setting WSL default version to 2"
    & wsl.exe --set-default-version 2 2>$null | Out-Null

    Write-Host "-> updating WSL kernel"
    & wsl.exe --update 2>$null | Out-Null

    if ($needsReboot) {
        Write-Warning @"

WSL2 features have been enabled but require a REBOOT to take effect.

  1. Reboot the machine.
  2. Re-run this same install.ps1 (with the same -PortalUrl).
  3. The script will detect WSL2 is ready and continue with provisioning.

Exiting now. No services have been registered yet.
"@
        exit 0
    }
}

function Install-WslDistro([string]$Name) {
    if (Test-WslDistroPresent $Name) {
        Write-Host "[OK] WSL distro '$Name' already installed"
        return
    }
    Write-Host "-> installing WSL distro '$Name' (downloads ~500MB)"
    # WSL CLI flags evolved across Windows builds. Older inbox WSL doesn't
    # support `--no-launch`; newer Store WSL does. Try the modern form
    # first, fall back to the legacy form, and use `wsl --shutdown` after
    # the legacy install to close any setup window the distro may auto-open.
    $oldPref = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & wsl.exe --install -d $Name --no-launch 2>&1
        $rc = $LASTEXITCODE
        if ($rc -ne 0) {
            Write-Host "  --no-launch not supported on this WSL build; retrying without it"
            Write-Host "  (an Ubuntu setup window may open briefly — close it; the script will continue)"
            $output = & wsl.exe --install -d $Name 2>&1
            $rc = $LASTEXITCODE
        }
        $output | ForEach-Object { if ($_) { Write-Host "  $_" } }
        if ($rc -ne 0) {
            throw "WSL distro install failed (exit $rc). Run 'wsl --list --online' to see available distros and retry with -WslDistro <Name>."
        }
        # Force a clean shutdown of any auto-launched session before we re-enter.
        Start-Sleep -Seconds 3
        & wsl.exe --shutdown 2>&1 | Out-Null
    } finally {
        $ErrorActionPreference = $oldPref
    }

    # First boot to finalize. Pass `--user root` to skip the new-user prompt;
    # we'll create an unprivileged user via the setup script instead.
    Write-Host "-> first-boot of '$Name' as root (~15s)"
    & wsl.exe -d $Name --user root -- echo "ready" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "First-boot of '$Name' failed (exit $LASTEXITCODE). Try running 'wsl -d $Name --user root -- echo ready' manually to see what went wrong."
    }
}

# ---------------------------------------------------------------------------
# Phase 2 — usbipd-win (USB passthrough into WSL)
# ---------------------------------------------------------------------------

function Install-Usbipd {
    if (Get-Command usbipd.exe -ErrorAction SilentlyContinue) {
        Write-Host "[OK] usbipd-win already installed"
        return
    }
    Write-Host "-> installing usbipd-win (USB passthrough for WSL)"
    if (Get-Command winget.exe -ErrorAction SilentlyContinue) {
        & winget install --exact --id dorssel.usbipd-win --silent --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -ne 0) {
            throw "winget failed to install usbipd-win. Manual install: https://github.com/dorssel/usbipd-win/releases"
        }
    } else {
        throw @"
winget not available; install usbipd-win manually:
  Download the latest .msi from https://github.com/dorssel/usbipd-win/releases
  Run the installer, then re-run this install.ps1.
"@
    }
    # winget puts usbipd in %ProgramFiles%\usbipd-win\ — refresh PATH so
    # subsequent calls in this same script find it.
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path", "User")
}

function Bind-IrisDevice([string]$HwId) {
    # usbipd 4.x: `bind` makes the device shareable (admin, persistent),
    # `attach --auto-attach` keeps it attached to WSL across replug events.
    Write-Host "-> binding USB device $HwId for WSL passthrough"
    # EAP=Continue locally so the `2>&1 |` patterns (which feed native-command
    # stderr into the pipeline) don't terminate under PS5.1+EAP=Stop.
    $oldPref = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $null = & usbipd.exe list --usbids 2>$null
        # usbipd `bind` is idempotent; no harm in calling on an already-bound device.
        & usbipd.exe bind --hardware-id $HwId 2>&1 | ForEach-Object { Write-Host "  $_" }

        # Attach immediately (does nothing if device not currently plugged in).
        & usbipd.exe attach --hardware-id $HwId --wsl --auto-attach 2>&1 |
            Select-Object -First 5 | ForEach-Object { Write-Host "  $_" }
    } finally {
        $ErrorActionPreference = $oldPref
    }
}

function Register-IrisAttachTask([string]$HwId) {
    # usbipd's `--auto-attach` is per-process and dies if PowerShell exits.
    # Use Task Scheduler to start it at every user logon as a background
    # task that survives logout/login cycles.
    $taskName = "VerificationPortal-IrisUsbAttach"
    $usbipdPath = (Get-Command usbipd.exe).Source
    $action = New-ScheduledTaskAction -Execute $usbipdPath `
        -Argument "attach --hardware-id $HwId --wsl --auto-attach"
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries `
        -AllowStartIfOnBatteries -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
    # Run as the SYSTEM account so the task survives user-switch and works
    # even before a user logs in. usbipd has the right capabilities here.
    $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest

    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal | Out-Null
    Write-Host "  -> scheduled task '$taskName' will reattach the iris device on every boot"
}

# ---------------------------------------------------------------------------
# Phase 3 — Provision iris service inside WSL
# ---------------------------------------------------------------------------

function Provision-Wsl([string]$Distro) {
    $setupScript = Join-Path $PSScriptRoot 'wsl-iris-setup.sh'
    if (-not (Test-Path $setupScript)) {
        throw "wsl-iris-setup.sh missing from bundle (expected at $setupScript)."
    }
    $debDir = Join-Path $PSScriptRoot 'iris-wsl'
    if (-not (Test-Path $debDir)) {
        throw "iris-wsl/ directory missing from bundle (must contain mantra-iris-service_*_all.deb)."
    }

    # Translate Windows paths to WSL paths so the distro can see them.
    # WSL auto-mounts `C:\` as `/mnt/c/`, so we rewrite the prefix.
    $setupScriptWsl = (Resolve-Path $setupScript).Path -replace '\\', '/' `
        -replace '^([A-Za-z]):', '/mnt/$($matches[1].ToLower())' 2>$null
    # PowerShell's regex can't easily lowercase the captured group inline;
    # fall back to a manual two-step.
    $setupScriptWsl = (Resolve-Path $setupScript).Path
    $drive = $setupScriptWsl.Substring(0, 1).ToLower()
    $setupScriptWsl = "/mnt/$drive" + ($setupScriptWsl.Substring(2) -replace '\\', '/')

    $debDirWsl = (Resolve-Path $debDir).Path
    $drive = $debDirWsl.Substring(0, 1).ToLower()
    $debDirWsl = "/mnt/$drive" + ($debDirWsl.Substring(2) -replace '\\', '/')

    Write-Host "-> running iris provisioning script inside WSL distro '$Distro'"
    Write-Host "  (this installs JRE, the iris .deb, and enables systemd; ~2 min)"

    # `bash -c` runs the script with the .deb path passed as an argument.
    # `--user root` because we need apt + systemctl.
    & wsl.exe -d $Distro --user root -- bash $setupScriptWsl $debDirWsl
    if ($LASTEXITCODE -ne 0) {
        throw "WSL provisioning script exited with code $LASTEXITCODE. Check 'wsl -d $Distro' to debug."
    }
}

# ---------------------------------------------------------------------------
# Phase 4 — MorFin daemon (Windows-native — works without WSL)
# ---------------------------------------------------------------------------

function Install-MorfinService {
    $morfinJar = Get-ChildItem (Join-Path $InstallRoot 'morfin') -Filter 'morfinauth-client-service-*.jar' -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $morfinJar) {
        throw "MorFin JAR not found under $InstallRoot\morfin. Bundle staging may have failed."
    }

    $nssm = Join-Path $InstallRoot 'tools\nssm.exe'
    if (-not (Test-Path $nssm)) {
        throw "tools\nssm.exe missing. Cannot register Windows services without it."
    }

    $svc = 'MorfinAuthClientService'
    # nssm prints status info to stderr in some versions; EAP=Continue locally
    # prevents PS5.1+EAP=Stop from turning that into a fatal error.
    $oldPref = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $nssm stop $svc 2>$null | Out-Null
        & $nssm remove $svc confirm 2>$null | Out-Null

        $java = (Get-Command java).Source
        & $nssm install $svc $java "-jar `"$($morfinJar.FullName)`"" 2>&1 | Out-Null
        & $nssm set $svc DisplayName 'MorFin Fingerprint Daemon (Verification Portal)' 2>&1 | Out-Null
        & $nssm set $svc Description 'Vendor MorFin daemon listening on :8030 for fingerprint capture.' 2>&1 | Out-Null
        & $nssm set $svc Start SERVICE_AUTO_START 2>&1 | Out-Null
        & $nssm set $svc AppRestartDelay 3000 2>&1 | Out-Null
        & $nssm set $svc AppExit Default Restart 2>&1 | Out-Null
        & $nssm set $svc AppStdout (Join-Path $InstallRoot 'logs\MorfinAuthClientService.log') 2>&1 | Out-Null
        & $nssm set $svc AppStderr (Join-Path $InstallRoot 'logs\MorfinAuthClientService.log') 2>&1 | Out-Null
        & $nssm start $svc 2>&1 | Out-Null
    } finally {
        $ErrorActionPreference = $oldPref
    }
    Write-Host "  -> MorFin daemon registered and started"
}

# ---------------------------------------------------------------------------
# Phase 4b — Startek / ACPL Capture API
# ---------------------------------------------------------------------------
# ACPL's MSI is a proper Windows Installer (publisher: Access Computech Pvt
# Ltd, ProductName: ACPL CAPTURE API). It registers its own Windows service
# at install time, so we don't need nssm. Defaults:
#
#   service listens on localhost:4443 (HTTPS) and localhost:8090 (HTTP)
#   FM220U L1 device VID:PID = 0BCA:8230
#   AST300 device VID:PID    = 34F9:8230
#
# Prereqs we install in order:
#   1. VC++ 2017 redist (x86) — ACPLAPI.DLL / FM220API.DLL link against it.
#   2. The L1 RD Service (Windows Certified RD Service for L1 Devices) is a
#      SEPARATE vendor download from acpl.in.net. install.ps1 doesn't ship
#      it because it's not in our bundle scope — but the Capture API needs
#      L1 RD running to hand off the USB device (RELEASEFM220 call from
#      our startek.js client). Warn the operator if L1 RD is missing.
#   3. The Capture API MSI (this bundle ships L1_API_Setup_30072025.msi).

function Install-StartekCaptureApi {
    $startekDir = Join-Path $InstallRoot 'startek'
    if (-not (Test-Path $startekDir)) {
        Write-Host "  (no startek payload staged; skipping — re-run build-bundle.sh to include it)"
        return
    }

    # --- VC++ 2017 redist (silent, idempotent) ---
    $vcRedist = Join-Path $startekDir 'VC17_redist.x86.exe'
    if (Test-Path $vcRedist) {
        Write-Host "  -> installing VC++ 2017 x86 redist (silent)"
        # /install /quiet /norestart is the standard VS redist switch.
        # ExitCode 0 = ok, 1638 = already installed (newer), 3010 = reboot
        # required. We treat 1638 + 3010 as success.
        $p = Start-Process -FilePath $vcRedist `
                           -ArgumentList '/install','/quiet','/norestart' `
                           -Wait -PassThru
        if ($p.ExitCode -notin 0,1638,3010) {
            Write-Warning "VC++ 2017 redist returned exit code $($p.ExitCode); the Capture API may fail to load its DLLs"
        }
    } else {
        Write-Host "  (VC17_redist.x86.exe missing; assuming VC++ runtime already present)"
    }

    # --- Capture API MSI ---
    $msi = Get-ChildItem $startekDir -Filter 'L1_API_Setup_*.msi' -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $msi) {
        throw "Startek Capture API MSI not found under $startekDir. Bundle staging may have failed."
    }
    Write-Host "  -> running msiexec /i $($msi.Name) /qn /norestart"
    $logFile = Join-Path $InstallRoot 'logs\startek-capture-api.log'
    $p = Start-Process -FilePath 'msiexec.exe' `
                       -ArgumentList @(
                           '/i',"`"$($msi.FullName)`"",
                           '/qn','/norestart',
                           '/l*v',"`"$logFile`""
                       ) `
                       -Wait -PassThru
    if ($p.ExitCode -notin 0,1638,3010) {
        throw "Startek Capture API MSI failed with exit code $($p.ExitCode). See $logFile"
    }
    Write-Host "  -> Capture API installed (log: $logFile)"

    # --- L1 RD Service presence check ---
    # The Capture API can technically run without L1 RD if no other process
    # has the device open, but ACPL's documented workflow needs L1 RD
    # holding the device and our client calling RELEASEFM220 to hand it off.
    # If the operator's laptop doesn't have L1 RD installed, the first
    # capture will likely fail with "device not connected". Warn loudly
    # rather than fail — let the operator decide whether to install it
    # before/after our bundle.
    $l1rd = Get-Service -Name '*L1RD*','*l1-rd*','*ACPLL1*' -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($l1rd) {
        Write-Host "  -> L1 RD service detected: $($l1rd.Name) ($($l1rd.Status))"
    } else {
        Write-Warning ("Windows Certified RD Service for L1 Devices not detected. " +
                       "If you plan to use Startek/ACPL fingerprint devices, install " +
                       "it from https://acpl.in.net/RdService.html before running a " +
                       "verification. (Mantra MorFin devices work without it.)")
    }
}

# ---------------------------------------------------------------------------
# Phase 5 — Vendor certs + browser homepage + shortcuts
# ---------------------------------------------------------------------------

function Import-VendorCerts([string]$CertDir) {
    if (-not (Test-Path $CertDir)) {
        Write-Host "  (no vendor certs found; skipping cert import)"
        return
    }
    Get-ChildItem -Path $CertDir -Filter '*.crt' | ForEach-Object {
        $thumb = (Import-Certificate -FilePath $_.FullName `
                  -CertStoreLocation 'Cert:\LocalMachine\Root').Thumbprint
        Write-Host "  -> imported $($_.Name) (thumbprint $thumb)"
    }
}

function Set-BrowserHomepage([string]$Url) {
    $policies = @(
        'HKLM:\SOFTWARE\Policies\Google\Chrome',
        'HKLM:\SOFTWARE\Policies\Microsoft\Edge'
    )
    foreach ($key in $policies) {
        New-Item -Path $key -Force | Out-Null
        New-ItemProperty -Path $key -Name 'HomepageLocation' -Value $Url -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $key -Name 'HomepageIsNewTabPage' -Value 0 -PropertyType DWord -Force | Out-Null
        New-ItemProperty -Path $key -Name 'RestoreOnStartup' -Value 4 -PropertyType DWord -Force | Out-Null
        New-ItemProperty -Path $key -Name 'ShowHomeButton' -Value 1 -PropertyType DWord -Force | Out-Null
        $urlsKey = Join-Path $key 'RestoreOnStartupURLs'
        New-Item -Path $urlsKey -Force | Out-Null
        New-ItemProperty -Path $urlsKey -Name '1' -Value $Url -PropertyType String -Force | Out-Null
        Write-Host "  -> pinned homepage in $key"
    }
}

function New-Shortcut([string]$LinkPath, [string]$Target, [string]$Description) {
    $sh = New-Object -ComObject WScript.Shell
    $shortcut = $sh.CreateShortcut($LinkPath)
    $shortcut.TargetPath = $Target
    # WScript.Shell.CreateShortcut returns a WshURLShortcut for .url files
    # (Internet Shortcuts), which only exposes TargetPath + Save — no
    # Description, no IconLocation. Setting .Description on it throws
    # "The property 'Description' cannot be found on this object". Only
    # .lnk shortcuts (WshShortcut) carry a Description.
    if ($LinkPath -like '*.lnk') {
        $shortcut.Description = $Description
    }
    $shortcut.Save()
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

Require-Admin
Require-OsCompatible
Require-Java

Write-Host "-> creating install root: $InstallRoot"
New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $InstallRoot 'logs') | Out-Null

Write-Host "-> staging bundle into $InstallRoot"
Copy-Item -Recurse -Force (Join-Path $PSScriptRoot 'morfin') $InstallRoot
Copy-Item -Recurse -Force (Join-Path $PSScriptRoot 'tools')  $InstallRoot
# Startek payload is optional in the bundle (it's only staged when the
# build host had Setup_ACPL_L1_API/ available). Copy if present; the
# Install-StartekCaptureApi function below tolerates missing payloads.
if (Test-Path (Join-Path $PSScriptRoot 'startek')) {
    Copy-Item -Recurse -Force (Join-Path $PSScriptRoot 'startek') $InstallRoot
}

# --- iris (WSL2 path) -------------------------------------------------------
if (-not $SkipIris) {
    Write-Host ""
    Write-Host "=== Iris service (WSL2 + usbipd) ==="
    if (-not (Test-Wsl2Ready)) {
        Enable-Wsl2     # may exit here with a reboot prompt
    } else {
        Write-Host "[OK] WSL2 already enabled"
    }
    Install-WslDistro $WslDistro
    Install-Usbipd
    Bind-IrisDevice  $IrisHwId
    Register-IrisAttachTask $IrisHwId
    Provision-Wsl    $WslDistro
} else {
    Write-Host "-> -SkipIris set; iris service NOT installed"
}

# --- fingerprint (Windows native, Mantra MorFin) ---------------------------
Write-Host ""
Write-Host "=== Fingerprint daemon — Mantra MorFin (Windows native) ==="
Import-VendorCerts (Join-Path $InstallRoot 'morfin\certs')
Install-MorfinService

# --- fingerprint (Windows native, Startek/ACPL Capture API) ----------------
# Runs alongside Mantra on separate ports (MorFin :8030, ACPL :4443/:8090).
# The frontend probes both and picks whichever vendor has a device plugged
# in — having both installed is intentional, not a conflict.
if (-not $SkipStartek) {
    Write-Host ""
    Write-Host "=== Fingerprint daemon — Startek / ACPL Capture API (Windows native) ==="
    Install-StartekCaptureApi
} else {
    Write-Host "-> -SkipStartek set; Startek Capture API NOT installed"
}

# --- browser + shortcuts ---------------------------------------------------
Write-Host ""
Write-Host "=== Browser policy + launcher ==="
Set-BrowserHomepage $PortalUrl
$desktop = [Environment]::GetFolderPath('CommonDesktopDirectory')
$startMenu = [Environment]::GetFolderPath('CommonStartMenu')
New-Shortcut (Join-Path $desktop   'Verification Portal.url') $PortalUrl 'Verification Portal — operator workstation'
New-Shortcut (Join-Path $startMenu 'Programs\Verification Portal.url') $PortalUrl 'Verification Portal — operator workstation'

Write-Host ""
Write-Host "[OK] Operator laptop ready."
Write-Host "  Portal:        $PortalUrl"
Write-Host "  FP — Mantra:   http://localhost:8030/  (Get-Service MorfinAuthClientService)"
if (-not $SkipStartek) {
    Write-Host "  FP — Startek:  https://localhost:4443/  (ACPL Capture API; HTTPS) or :8090 (HTTP)"
}
if (-not $SkipIris) {
    Write-Host "  Iris (WSL):    http://localhost:8031/  (wsl -d $WslDistro -- systemctl status mantra-iris-service)"
    Write-Host "  USB attach:    Get-ScheduledTask VerificationPortal-IrisUsbAttach"
}
Write-Host "  Shortcut:      Desktop + Start Menu"
Write-Host ""
Write-Host "Smoke test:"
Write-Host "  curl http://localhost:8030/                                   # Mantra MorFin"
if (-not $SkipStartek) {
    Write-Host "  curl http://localhost:8090/FM220/getserial                    # Startek (HTTP)"
    Write-Host "  curl -k https://localhost:4443/FM220/getserial                # Startek (HTTPS)"
}
if (-not $SkipIris) {
    Write-Host "  curl -X POST http://localhost:8031/iris/supporteddevicelist  # Iris"
}
