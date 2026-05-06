# install.ps1 — operator-laptop bootstrap (Windows 10 19041+ / Windows 11).
#
# Architecture:
#
#   ┌─ Windows host ───────────────────────────────────────────────────┐
#   │  Browser ─→ localhost:5173    (portal frontend, served remote)   │
#   │           ─→ localhost:8030   (MorFin fingerprint, native Win)   │
#   │           ─→ localhost:8031   (mantra-iris-service in WSL2)      │
#   │                                                                   │
#   │  WSL2 Ubuntu ─ runs mantra-iris-service.deb on :8031             │
#   │       ↑                                                           │
#   │       │ usbipd-win passes through MIS100V2 (vendor 2c0f:2100)    │
#   │       │ — needed because Mantra's Marvis_Auth.jar Windows DLL    │
#   │       │   has a JNI signature mismatch (vendor bug); the Linux  │
#   │       │   .so in the same JAR works fine.                        │
#   │       ▼                                                           │
#   │  USB device                                                       │
#   └───────────────────────────────────────────────────────────────────┘
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
    [switch]$SkipIris
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------

function Require-Admin {
    $current = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]$current
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Run from an elevated PowerShell prompt (Right-click → 'Run as Administrator')."
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
Run Windows Update until Settings → System → About shows
'Version 22H2' (or newer) and 'OS build 19045+' / Windows 11.
Then re-run this installer.
"@
    }
    Write-Host "✓ Windows build $build (WSL2-capable)"
}

function Require-Java {
    try {
        $null = & java -version 2>&1
    } catch {
        throw @"
Java not found on PATH. Install Adoptium Temurin JRE 17 (free, OpenJDK):
  https://adoptium.net/temurin/releases/?version=17
Tick 'Add to PATH' during install, open a new PowerShell, then re-run this script.
"@
    }
    Write-Host "✓ Java available on PATH"
}

# ---------------------------------------------------------------------------
# Phase 1 — WSL2 enablement (may require reboot)
# ---------------------------------------------------------------------------

function Test-Wsl2Ready {
    # `wsl --status` returns non-zero if the optional features aren't
    # enabled or kernel isn't installed. We treat any failure as "not ready".
    try {
        $null = & wsl.exe --status 2>&1
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

function Test-WslDistroPresent([string]$Name) {
    try {
        # `wsl -l -q` lists installed distros (one per line, UTF-16-LE on
        # older WSL — strip nulls before matching).
        $list = (& wsl.exe -l -q 2>$null) -replace "`0", "" -split "`r?`n" | Where-Object { $_ }
        return ($list -contains $Name)
    } catch {
        return $false
    }
}

function Enable-Wsl2 {
    Write-Host "→ enabling WSL2 + Virtual Machine Platform (Windows features)"
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
            Write-Host "  ✓ $feature already enabled"
        }
    }

    Write-Host "→ setting WSL default version to 2"
    & wsl.exe --set-default-version 2 2>$null | Out-Null

    Write-Host "→ updating WSL kernel"
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
        Write-Host "✓ WSL distro '$Name' already installed"
        return
    }
    Write-Host "→ installing WSL distro '$Name' (downloads ~500MB; first-run will prompt for a UNIX username)"
    # `wsl --install -d <distro> --no-launch` installs without opening a
    # terminal window. The first ACTUAL launch (we run it below) does
    # the user-creation prompts. We bypass those by piping a UNIX user
    # creation through the distro's setup.
    & wsl.exe --install -d $Name --no-launch
    if ($LASTEXITCODE -ne 0) {
        throw "WSL distro install failed (exit $LASTEXITCODE). Run 'wsl --list --online' to see available distros and retry with -WslDistro <Name>."
    }

    # First boot to finalize. Pass `--user root` to skip the new-user prompt;
    # we'll create an unprivileged user via the setup script instead.
    Write-Host "→ first-boot of '$Name' (creating root account, ~10s)"
    & wsl.exe -d $Name --user root -- echo "ready" | Out-Null
}

# ---------------------------------------------------------------------------
# Phase 2 — usbipd-win (USB passthrough into WSL)
# ---------------------------------------------------------------------------

function Install-Usbipd {
    if (Get-Command usbipd.exe -ErrorAction SilentlyContinue) {
        Write-Host "✓ usbipd-win already installed"
        return
    }
    Write-Host "→ installing usbipd-win (USB passthrough for WSL)"
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
    Write-Host "→ binding USB device $HwId for WSL passthrough"
    $boundList = & usbipd.exe list --usbids 2>$null
    # usbipd `bind` is idempotent; no harm in calling on an already-bound device.
    & usbipd.exe bind --hardware-id $HwId 2>&1 | ForEach-Object { Write-Host "  $_" }

    # Attach immediately (does nothing if device not currently plugged in).
    & usbipd.exe attach --hardware-id $HwId --wsl --auto-attach 2>&1 |
        Select-Object -First 5 | ForEach-Object { Write-Host "  $_" }
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
    Write-Host "  → scheduled task '$taskName' will reattach the iris device on every boot"
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

    Write-Host "→ running iris provisioning script inside WSL distro '$Distro'"
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
    & $nssm stop $svc 2>$null | Out-Null
    & $nssm remove $svc confirm 2>$null | Out-Null

    $java = (Get-Command java).Source
    & $nssm install $svc $java "-jar `"$($morfinJar.FullName)`"" | Out-Null
    & $nssm set $svc DisplayName 'MorFin Fingerprint Daemon (Verification Portal)' | Out-Null
    & $nssm set $svc Description 'Vendor MorFin daemon listening on :8030 for fingerprint capture.' | Out-Null
    & $nssm set $svc Start SERVICE_AUTO_START | Out-Null
    & $nssm set $svc AppRestartDelay 3000 | Out-Null
    & $nssm set $svc AppExit Default Restart | Out-Null
    & $nssm set $svc AppStdout (Join-Path $InstallRoot 'logs\MorfinAuthClientService.log') | Out-Null
    & $nssm set $svc AppStderr (Join-Path $InstallRoot 'logs\MorfinAuthClientService.log') | Out-Null
    & $nssm start $svc | Out-Null
    Write-Host "  → MorFin daemon registered and started"
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
        Write-Host "  → imported $($_.Name) (thumbprint $thumb)"
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
        Write-Host "  → pinned homepage in $key"
    }
}

function New-Shortcut([string]$LinkPath, [string]$Target, [string]$Description) {
    $sh = New-Object -ComObject WScript.Shell
    $shortcut = $sh.CreateShortcut($LinkPath)
    $shortcut.TargetPath = $Target
    $shortcut.Description = $Description
    $shortcut.Save()
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

Require-Admin
Require-OsCompatible
Require-Java

Write-Host "→ creating install root: $InstallRoot"
New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $InstallRoot 'logs') | Out-Null

Write-Host "→ staging bundle into $InstallRoot"
Copy-Item -Recurse -Force (Join-Path $PSScriptRoot 'morfin') $InstallRoot
Copy-Item -Recurse -Force (Join-Path $PSScriptRoot 'tools')  $InstallRoot

# --- iris (WSL2 path) -------------------------------------------------------
if (-not $SkipIris) {
    Write-Host ""
    Write-Host "=== Iris service (WSL2 + usbipd) ==="
    if (-not (Test-Wsl2Ready)) {
        Enable-Wsl2     # may exit here with a reboot prompt
    } else {
        Write-Host "✓ WSL2 already enabled"
    }
    Install-WslDistro $WslDistro
    Install-Usbipd
    Bind-IrisDevice  $IrisHwId
    Register-IrisAttachTask $IrisHwId
    Provision-Wsl    $WslDistro
} else {
    Write-Host "→ -SkipIris set; iris service NOT installed"
}

# --- fingerprint (Windows native) ------------------------------------------
Write-Host ""
Write-Host "=== Fingerprint daemon (Windows native) ==="
Import-VendorCerts (Join-Path $InstallRoot 'morfin\certs')
Install-MorfinService

# --- browser + shortcuts ---------------------------------------------------
Write-Host ""
Write-Host "=== Browser policy + launcher ==="
Set-BrowserHomepage $PortalUrl
$desktop = [Environment]::GetFolderPath('CommonDesktopDirectory')
$startMenu = [Environment]::GetFolderPath('CommonStartMenu')
New-Shortcut (Join-Path $desktop   'Verification Portal.url') $PortalUrl 'Verification Portal — operator workstation'
New-Shortcut (Join-Path $startMenu 'Programs\Verification Portal.url') $PortalUrl 'Verification Portal — operator workstation'

Write-Host ""
Write-Host "✓ Operator laptop ready."
Write-Host "  Portal:      $PortalUrl"
Write-Host "  Fingerprint: http://localhost:8030/  (Get-Service MorfinAuthClientService)"
if (-not $SkipIris) {
    Write-Host "  Iris (WSL):  http://localhost:8031/  (wsl -d $WslDistro -- systemctl status mantra-iris-service)"
    Write-Host "  USB attach:  Get-ScheduledTask VerificationPortal-IrisUsbAttach"
}
Write-Host "  Shortcut:    Desktop + Start Menu"
Write-Host ""
Write-Host "Smoke test:"
Write-Host "  curl http://localhost:8030/                            # MorFin"
if (-not $SkipIris) {
    Write-Host "  curl -X POST http://localhost:8031/iris/supporteddevicelist  # Iris"
}
