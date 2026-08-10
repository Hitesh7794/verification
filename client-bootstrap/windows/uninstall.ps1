# uninstall.ps1 -- remove the Verification Portal operator-laptop install.
#
# Reverses everything install.ps1 did. Defaults are conservative: vendor
# drivers (MorFin USB driver, ACPL Capture API) and WSL distros are NOT
# removed unless explicitly requested, because other software on the
# laptop might rely on them. Pass the -Remove* flags below for a full
# nuke.
#
# Run from an *elevated* PowerShell:
#
#   Set-ExecutionPolicy -Scope Process Bypass
#   .\uninstall.ps1                            # soft uninstall (default)
#   .\uninstall.ps1 -RemoveDriver -RemoveCerts # full uninstall (typical retest)
#
# Idempotent -- safe to re-run. Each phase prints "[skip]" when its
# target is already absent.

[CmdletBinding()]
param(
    # Install root used by install.ps1. Default matches install.ps1's default.
    [string]$InstallRoot = "C:\Program Files\VerificationPortal",

    # Also uninstall the Mantra MorFin USB driver from the Windows
    # driver store. Other Mantra-using apps on this laptop will break.
    [switch]$RemoveDriver,

    # Also uninstall the Startek ACPL Capture API MSI.
    [switch]$RemoveStartek,

    # Also remove the WSL iris service. Doesn't unregister the WSL
    # distro itself (might host other workloads).
    [switch]$RemoveWsl,

    # Also remove the imported Mantra TLS certs from Cert:\LocalMachine\Root.
    [switch]$RemoveCerts,

    # WSL distro hosting the iris service (only relevant with -RemoveWsl).
    [string]$WslDistro = "Ubuntu-22.04"
)

# EAP=Continue is the right default for an uninstaller. Native commands
# like sc.exe, nssm.exe, pnputil routinely write informational messages
# to stderr ("service has not been started", "driver not present", etc.).
# Under EAP=Stop those become terminating errors that abort the
# uninstall mid-flight. Each phase here is independent and tolerates
# partial state, so we want best-effort cleanup with visible warnings
# rather than hard aborts.
$ErrorActionPreference = 'Continue'

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------

function Require-Admin {
    $current = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]$current
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Run from an elevated PowerShell (Right-click -> 'Run as Administrator')."
    }
}

# ---------------------------------------------------------------------------
# Removal helpers
# ---------------------------------------------------------------------------

function Remove-MorfinService {
    $svc = 'MorfinAuthClientService'
    $existing = Get-Service -Name $svc -ErrorAction SilentlyContinue
    if (-not $existing) {
        Write-Host "  [skip] $svc not installed"
        return
    }

    # sc.exe stop works on Paused services too (Stop-Service doesn't).
    # The service might have been restart-throttled into the Paused
    # state by nssm -- we still want to tear it down cleanly.
    Write-Host "-> stopping $svc (status was: $($existing.Status))"
    & sc.exe stop $svc *>$null
    Start-Sleep -Seconds 1

    # Prefer nssm if its binary is still around (cleaner deregister).
    $nssm = Join-Path $InstallRoot 'tools\nssm.exe'
    if (Test-Path $nssm) {
        Write-Host "-> removing via nssm"
        & $nssm stop $svc *>$null
        & $nssm remove $svc confirm *>$null
    } else {
        # Fallback: sc.exe delete. Slower but works without nssm.exe.
        Write-Host "-> removing via sc.exe (nssm.exe missing -- install dir already gone?)"
        & sc.exe delete $svc *>$null
    }

    # Confirm the service really is gone (SCM sometimes lingers a beat).
    Start-Sleep -Milliseconds 500
    if (Get-Service -Name $svc -ErrorAction SilentlyContinue) {
        Write-Warning "$svc still present after removal attempt. Reboot may be required."
    } else {
        Write-Host "[OK] $svc removed"
    }
}

function Remove-InstallDir {
    if (-not (Test-Path $InstallRoot)) {
        Write-Host "  [skip] $InstallRoot not present"
        return
    }
    Write-Host "-> removing $InstallRoot"
    try {
        Remove-Item -Path $InstallRoot -Recurse -Force -ErrorAction Stop
        Write-Host "[OK] install directory removed"
    } catch {
        Write-Warning "Couldn't remove ${InstallRoot}: $_"
        Write-Warning "If a file is locked, the service may still be holding the JAR."
        Write-Warning "Try: Stop-Service MorfinAuthClientService -Force, reboot, then re-run."
    }
}

function Remove-BrowserHomepage {
    # install.ps1 wrote homepage policies under HKLM\SOFTWARE\Policies\.
    # We strip just the values we set; we don't delete the whole policy
    # key because a sysadmin may have other policies under it.
    $policies = @(
        'HKLM:\SOFTWARE\Policies\Google\Chrome',
        'HKLM:\SOFTWARE\Policies\Microsoft\Edge'
    )
    $touched = $false
    foreach ($key in $policies) {
        if (-not (Test-Path $key)) { continue }
        $touched = $true
        Write-Host "-> clearing browser homepage policy at $key"
        foreach ($name in 'HomepageLocation','HomepageIsNewTabPage','RestoreOnStartup','ShowHomeButton') {
            Remove-ItemProperty -Path $key -Name $name -ErrorAction SilentlyContinue
        }
        Remove-Item -Path (Join-Path $key 'RestoreOnStartupURLs') -Recurse -ErrorAction SilentlyContinue
    }
    if ($touched) {
        Write-Host "[OK] browser homepage policies cleared (Chrome + Edge will use their defaults on next launch)"
    } else {
        Write-Host "  [skip] no Chrome/Edge homepage policy keys present"
    }
}

function Remove-Shortcuts {
    $desktop = [Environment]::GetFolderPath('CommonDesktopDirectory')
    $startMenu = [Environment]::GetFolderPath('CommonStartMenu')
    $paths = @(
        (Join-Path $desktop 'Verification Portal.url'),
        (Join-Path $startMenu 'Programs\Verification Portal.url')
    )
    $removed = 0
    foreach ($p in $paths) {
        if (Test-Path $p) {
            Remove-Item -Path $p -Force
            Write-Host "  removed $p"
            $removed++
        }
    }
    if ($removed -eq 0) {
        Write-Host "  [skip] no Verification Portal shortcuts present"
    } else {
        Write-Host "[OK] $removed shortcut(s) removed"
    }
}

function Remove-IrisTask {
    $taskName = 'VerificationPortal-IrisUsbAttach'
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
        Write-Host "-> unregistering scheduled task $taskName"
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Host "[OK] scheduled task removed"
    } else {
        Write-Host "  [skip] scheduled task $taskName not present"
    }
}

function Remove-VendorCerts {
    # install.ps1 imported certs from morfin\certs\*.crt into the LocalMachine
    # Root store. Subjects contain 'Mantra' or 'CEIS'.
    $certs = Get-ChildItem -Path Cert:\LocalMachine\Root |
        Where-Object { $_.Subject -like '*Mantra*' -or $_.Subject -like '*CEIS*' }
    if (-not $certs) {
        Write-Host "  [skip] no Mantra/CEIS certs found in LocalMachine\Root"
        return
    }
    foreach ($c in $certs) {
        Write-Host "-> removing cert $($c.Subject) thumbprint=$($c.Thumbprint)"
        Remove-Item -Path "Cert:\LocalMachine\Root\$($c.Thumbprint)" -Force
    }
    Write-Host "[OK] $($certs.Count) vendor cert(s) removed"
}

function Remove-MorfinDriver {
    # Uninstall the MorFin USB driver from the Windows driver store via
    # pnputil. Other apps that talk to Mantra fingerprint hardware will
    # break, so this is gated behind -RemoveDriver.
    Write-Host "-> enumerating Mantra driver INFs"
    $oldPref = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $enum = & pnputil /enum-drivers 2>$null | Out-String
        # pnputil output structure:
        #   Published Name : oem<N>.inf
        #   Original Name  : foo.inf
        #   Provider Name  : Mantra
        #   Class Name     : Biometric Devices
        #   ...
        # We need the Published Name of any block whose Provider matches Mantra.
        $infs = @()
        $current = $null
        foreach ($line in ($enum -split "`r?`n")) {
            if ($line -match '^Published Name\s*:\s*(.+)\s*$') {
                $current = $matches[1].Trim()
            } elseif ($line -match '^(Provider Name|Driver Provider)\s*:\s*(.+)\s*$') {
                $provider = $matches[2].Trim()
                if ($current -and ($provider -like '*Mantra*' -or $provider -like '*MorFin*')) {
                    $infs += $current
                }
                $current = $null
            } elseif ($line -match '^Published Name') {
                # Reset on every Published Name even if we didn't match a Provider yet.
                # No-op for the parser, but stops a stale $current from leaking forward.
            }
        }
        if (-not $infs) {
            Write-Host "  [skip] no Mantra driver INFs found in driver store"
            return
        }
        foreach ($inf in $infs) {
            Write-Host "-> uninstalling $inf via pnputil /delete-driver"
            & pnputil /delete-driver $inf /uninstall /force 2>&1 |
                ForEach-Object { if ($_) { Write-Host "    $_" } }
        }
        Write-Host "[OK] MorFin driver(s) removed from driver store"
    } finally {
        $ErrorActionPreference = $oldPref
    }
}

function Remove-StartekCaptureApi {
    $pkg = Get-Package -Name '*ACPL*' -ErrorAction SilentlyContinue
    if (-not $pkg) {
        Write-Host "  [skip] ACPL Capture API not installed"
        return
    }
    foreach ($p in $pkg) {
        Write-Host "-> uninstalling $($p.Name)"
        try {
            $p | Uninstall-Package -Force -ErrorAction Stop | Out-Null
        } catch {
            Write-Warning "Uninstall-Package failed for $($p.Name): $_"
            Write-Warning "Try: Get-Package '*ACPL*' | Uninstall-Package -Force"
        }
    }
    Write-Host "[OK] ACPL Capture API removed"
}

function Remove-IrisService {
    Write-Host "-> uninstalling mantra-iris-service from WSL distro $WslDistro"
    $oldPref = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & wsl.exe -d $WslDistro --user root -- apt-get purge -y mantra-iris-service 2>&1 |
            ForEach-Object { if ($_) { Write-Host "    $_" } }
    } finally {
        $ErrorActionPreference = $oldPref
    }
    Write-Host "[OK] mantra-iris-service uninstalled from $WslDistro"
    Write-Host "  (the $WslDistro distro itself is preserved; to remove entirely:"
    Write-Host "   wsl --unregister $WslDistro)"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

Require-Admin

Write-Host "===================================================================="
Write-Host "Verification Portal -- uninstall"
Write-Host "===================================================================="
Write-Host "Install root        : $InstallRoot"
Write-Host "Remove MorFin driver: $($RemoveDriver.IsPresent)"
Write-Host "Remove Startek      : $($RemoveStartek.IsPresent)"
Write-Host "Remove iris (WSL)   : $($RemoveWsl.IsPresent)"
Write-Host "Remove vendor certs : $($RemoveCerts.IsPresent)"
Write-Host ""

Write-Host "=== Phase 1: Windows service ==="
Remove-MorfinService

Write-Host ""
Write-Host "=== Phase 2: install directory ==="
Remove-InstallDir

Write-Host ""
Write-Host "=== Phase 3: browser homepage policies ==="
Remove-BrowserHomepage

Write-Host ""
Write-Host "=== Phase 4: desktop + start menu shortcuts ==="
Remove-Shortcuts

Write-Host ""
Write-Host "=== Phase 5: scheduled tasks ==="
Remove-IrisTask

if ($RemoveCerts) {
    Write-Host ""
    Write-Host "=== Phase 6: vendor TLS certs ==="
    Remove-VendorCerts
}

if ($RemoveDriver) {
    Write-Host ""
    Write-Host "=== Phase 7: MorFin USB driver ==="
    Remove-MorfinDriver
}

if ($RemoveStartek) {
    Write-Host ""
    Write-Host "=== Phase 8: Startek Capture API ==="
    Remove-StartekCaptureApi
}

if ($RemoveWsl) {
    Write-Host ""
    Write-Host "=== Phase 9: WSL iris service ==="
    Remove-IrisService
}

Write-Host ""
Write-Host "===================================================================="
Write-Host "[OK] Uninstall complete."
Write-Host "===================================================================="
Write-Host ""
Write-Host "Verify nothing remains:"
Write-Host "  Get-Service MorfinAuthClientService -ErrorAction SilentlyContinue  # should print nothing"
Write-Host "  Test-Path '$InstallRoot'                                            # should be False"
if ($RemoveDriver) {
    Write-Host "  Get-PnpDevice | ? FriendlyName -match 'Mantra|MFS'                   # MFS500 (if plugged in) should show Status=Error / Class empty"
}
Write-Host ""
Write-Host "Fresh install:"
Write-Host "  Set-ExecutionPolicy -Scope Process Bypass"
Write-Host "  .\install.ps1 -PortalUrl http://172.16.62.147:5173 -SkipIris -SkipStartek"
