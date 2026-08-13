# install.ps1 -- operator-laptop bootstrap (Windows 10 / Windows 11).
#
# Architecture:
#
#   Windows host:
#     Browser -> portal URL                  (portal frontend, served remote)
#             -> localhost:8030              (Mantra MorFin FP, native Win)
#             -> localhost:4443 / :8090      (Startek/ACPL FP, native Win)
#             -> localhost:8031              (Marvis Auth iris, native Win)
#
#     USB devices: MorFin readers (MELO041 / MFS500 / MARC10), Startek
#     FM220U L1 (0BCA:8230) / AST300 (34F9:8230), Marvis MIS100V2
#     (2C0F:2100).
#
# Historical note: v1.0 of the Marvis SDK crashed on Windows because
# its JAR's native DLL had a JNI signature mismatch. Iris used to run
# via a WSL2 + usbipd + Java-daemon workaround. Retired -- v1.4 of the
# Marvis Auth Web SDK ships a native Windows service (MarvisAuthClient-
# Service.exe) that self-registers on :8031. See IRIS_NOTES.md.
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

    # Skip iris provisioning. Use only when iris hardware isn't part of
    # the deployment (fingerprint-only centers) OR when the Marvis
    # Auth installer isn't staged in vendor/ (in which case Install-
    # MarvisIris will warn and skip regardless).
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
    # 64-bit Windows 10 build 17763 (October 2018, 1809 LTSC) or newer.
    # Marvis Auth v1.4 needs .NET Framework 4.7.2+ which ships with
    # 1803+; ACPL Capture API MSI needs a modern Installer engine which
    # is Windows 10 1607+. 17763 is the lowest common denominator that
    # covers both plus any vendor security-catalog freshness assumptions.
    if (-not [System.Environment]::Is64BitOperatingSystem) {
        throw "32-bit Windows detected. Vendor daemons require 64-bit."
    }
    $build = [System.Environment]::OSVersion.Version.Build
    if ($build -lt 17763) {
        throw @"
Windows build $build is too old (requires 17763+; that's Windows 10
1809 / October 2018 update or newer). Run Windows Update until
Settings -> System -> About shows a supported build, then re-run.
"@
    }
    Write-Host "[OK] Windows build $build"
}

function Resolve-BundledJava {
    # The bundle ships its own private Adoptium Temurin JRE 17 under
    # ./morfin/jre/, which install.ps1 copies to $InstallRoot\morfin\jre\
    # before this function runs. We point nssm directly at that java.exe
    # so the MorFin daemon doesn't depend on whether the operator has a
    # system Java installed -- and crucially, doesn't depend on PATH being
    # configured correctly (the #1 install-time failure mode pre-bundling).
    #
    # If the JRE is missing (someone manually trimmed the bundle, or an
    # older build without the JRE step), we fall back to whatever 'java'
    # resolves to on PATH so the script doesn't hard-crash. A warning
    # nudges them to use a fresh bundle.
    $bundled = Join-Path $InstallRoot 'morfin\jre\bin\java.exe'
    if (Test-Path $bundled) {
        Write-Host "[OK] Using bundled JRE at $bundled"
        return $bundled
    }
    Write-Warning "Bundled JRE not found at $bundled; falling back to system 'java' on PATH."
    $cmd = Get-Command java -ErrorAction SilentlyContinue
    if (-not $cmd) {
        throw @"
No Java runtime available.

Expected the bundled JRE at: $bundled
That path is created by install.ps1 from ./morfin/jre/ in the install bundle.
If you trimmed the bundle, rebuild it (client-bootstrap/windows/build-bundle.sh)
or download a fresh OperatorPortalSetup bundle from the admin portal.
"@
    }
    return $cmd.Source
}


# ---------------------------------------------------------------------------
# Phase 1 -- Marvis Iris (native Windows service)
# ---------------------------------------------------------------------------
# Retired: v1.0 of the SDK crashed on Windows (JNI signature mismatch)
# so iris ran via WSL2 + usbipd + a Java daemon. v1.4's Web SDK ships
# a native Windows service (MarvisAuthClientService.exe) that self-
# registers on localhost:8031. See IRIS_NOTES.md.
#
# Vendor payload is not committed to git (197 MB, not redistributable).
# The bundle builder stages it at ./vendor/MarvisAuthClientService.exe;
# if missing, we warn and skip so fingerprint-only builds still work.

function Install-IrisDriver {
    # IriTech IriShield / Mantra MIS100V2 uses VID 1F63 on USB. Mantra's
    # own MYUSB driver (installed via their fingerprint SDK) does NOT
    # cover this VID -- new operator laptops therefore show the device
    # with Status: Error in Device Manager until this vendor .exe runs.
    #
    # We call this BEFORE Install-MarvisIris so the USB stack is in
    # place when the service starts and enumerates hardware. Idempotent:
    # if a healthy VID_1F63 device is already present, we skip.
    $installer = Join-Path $PSScriptRoot 'vendor\MIS100V2_Driver.exe'
    if (-not (Test-Path $installer)) {
        Write-Warning @"
IriShield / MIS100V2 driver installer not found at:
  $installer

If this is a fresh operator laptop and iris hardware is plugged in,
the Marvis service will start but the scanner will report -1307
(no hardware). Options:
  1. Drop MIS100V2_Driver.exe into vendor/ and re-run this script, or
  2. Install the driver manually from IriTech
     (https://www.iritech.com/support/downloads), or
  3. Re-run with -SkipIris if this laptop has no iris hardware.
"@
        return
    }

    # Skip if the driver already claimed the device successfully.
    $dev = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
           Where-Object { $_.InstanceId -like '*VID_1F63*' } |
           Select-Object -First 1
    if ($dev -and $dev.Status -eq 'OK') {
        Write-Host "[OK] IriShield driver already installed (device $($dev.Status))"
        return
    }

    Write-Host "-> installing IriShield / MIS100V2 driver (silent /S attempt)"
    # NSIS-style silent first. Vendor NSIS installers respect /S and
    # bootstrap the driver via pnputil under the hood.
    $p = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
    if ($p.ExitCode -ne 0) {
        Write-Warning "  Silent install returned exit $($p.ExitCode). Opening interactively -- click through Next > Install > Finish."
        Start-Process -FilePath $installer -Verb RunAs -Wait | Out-Null
    }

    # Verify: at least one VID_1F63 device present + OK. Device does not
    # need to be plugged in RIGHT NOW for the driver install to succeed --
    # Windows caches the .inf so first plug-in later Just Works. So we
    # only warn (not throw) if there's no device visible.
    Start-Sleep -Seconds 2
    $dev = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
           Where-Object { $_.InstanceId -like '*VID_1F63*' } |
           Select-Object -First 1
    if ($dev) {
        Write-Host "[OK] IriShield driver installed ($($dev.FriendlyName): $($dev.Status))"
    } else {
        Write-Host "[OK] IriShield driver installed (no device plugged in right now -- .inf cached; first plug-in will bind)"
    }
}

function Install-MarvisIris {
    $installer = Join-Path $PSScriptRoot 'vendor\MarvisAuthClientService.exe'
    if (-not (Test-Path $installer)) {
        Write-Warning @"
Marvis Auth Client Service installer not found at:
  $installer

Iris capture will NOT work on this laptop. Either:
  1. Drop MarvisAuthClientService.exe (from the Marvis Auth Web SDK
     1.4.0.0 bundle) into that path and re-run this script, or
  2. Re-run with -SkipIris to acknowledge and continue without iris.

Fingerprint installation continues either way.
"@
        return
    }

    # Vendor doesn't publish a canonical service name in the SDK docs;
    # match anything that looks like theirs. First-match-wins is fine
    # because they're not supposed to register multiple services.
    function Get-MarvisService {
        Get-Service -Name 'MarvisAuthClientService','*Marvis*','*MarvisAuth*' `
            -ErrorAction SilentlyContinue |
            Select-Object -First 1
    }

    $svc = Get-MarvisService
    if ($svc) {
        Write-Host "[OK] $($svc.Name) already registered ($($svc.Status))"
        if ($svc.Status -ne 'Running') {
            Write-Host "  -> starting service"
            Start-Service $svc.Name
            Start-Sleep -Seconds 2
        }
    } else {
        Write-Host "-> running Marvis installer (silent /S attempt)"
        # Try NSIS-style silent first. If the vendor uses InstallShield
        # or WiX, silent may not register the service -- fall back to
        # interactive so the operator clicks through once.
        Start-Process -FilePath $installer -ArgumentList '/S' -Wait | Out-Null
        Start-Sleep -Seconds 3
        $svc = Get-MarvisService
        if (-not $svc) {
            Write-Warning "  Silent install didn't register the service. Opening the installer interactively -- click through Next > Install > Finish."
            Start-Process -FilePath $installer -Verb RunAs -Wait | Out-Null
            Start-Sleep -Seconds 3
            $svc = Get-MarvisService
            if (-not $svc) {
                throw @"
Marvis Auth Client Service didn't register after the interactive installer.
Try running it manually as Administrator:
  $installer
Then re-run install.ps1 -SkipIris to continue past the iris phase.
"@
            }
        }
        Write-Host "[OK] $($svc.Name) installed and running"
    }

    # Verify the daemon actually responds on :8031. Vendor sample uses
    # POST /marvisauth/info with an empty body for the health check.
    try {
        $resp = Invoke-WebRequest -Uri 'http://localhost:8031/marvisauth/info' `
                    -Method POST -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        Write-Host "[OK] Marvis daemon responding on http://localhost:8031/ (HTTP $($resp.StatusCode))"
    } catch {
        Write-Warning @"
$($svc.Name) is registered but not responding on http://localhost:8031/
Check the service:
  Get-Service $($svc.Name)
  Get-NetTCPConnection -LocalPort 8031
"@
    }
}


# ---------------------------------------------------------------------------
# Phase 4 -- MorFin daemon (Windows-native -- works without WSL)
# ---------------------------------------------------------------------------

# Mantra USB vendor ID -- covers MFS500 (PID 1100), MELO041, MARC10, etc.
# Used by Test-MorfinDriverInstalled and Bind-MorfinDevices to filter the
# devices we care about without affecting other USB peripherals.
$script:MantraUsbVendorIdPattern = 'USB\VID_2C0F*'

function Test-MorfinDriverInstalled {
    # Returns $true if the MorFin driver is already in the Windows driver
    # store. pnputil /enum-drivers is much faster than Get-WindowsDriver
    # (which scans the whole driver INF database -- can take 60+ seconds
    # on machines with lots of drivers).
    $oldPref = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $drivers = & pnputil /enum-drivers 2>$null | Out-String
        return ($drivers -match 'Mantra' -or
                $drivers -match 'MorFin' -or
                $drivers -match 'mantra\.inf')
    } finally {
        $ErrorActionPreference = $oldPref
    }
}

function Invoke-PnpRebind {
    # Force a Windows PnP re-evaluation on any currently-plugged Mantra
    # device. Equivalent to physically unplugging and replugging the
    # MFS500 -- which is what Windows otherwise requires before it will
    # bind a freshly-installed driver to an already-present device.
    #
    # Without this, install.ps1 finishes "successfully" but the MFS500
    # still shows Status=Error in Device Manager because no driver got
    # bound to it. The operator then sees ErrorCode 2027 from the
    # daemon and assumes the install is broken.
    #
    # Targets only USB\VID_2C0F* devices in Error state so we don't
    # disturb other peripherals on the laptop.
    $oldPref = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $devices = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
            Where-Object { $_.InstanceId -like $script:MantraUsbVendorIdPattern }
        if (-not $devices) {
            Write-Host "  (no Mantra USB device currently plugged in -- driver ready when one is)"
            return
        }
        Write-Host "  rebinding $($devices.Count) Mantra device(s) so the new driver takes effect"
        foreach ($d in $devices) {
            Disable-PnpDevice -InstanceId $d.InstanceId -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
            Start-Sleep -Milliseconds 500
            Enable-PnpDevice  -InstanceId $d.InstanceId -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
        }
        Start-Sleep -Seconds 2
        # Confirm the rebind worked. Show the operator what landed.
        $devices2 = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
            Where-Object { $_.InstanceId -like $script:MantraUsbVendorIdPattern }
        foreach ($d in $devices2) {
            $tag = if ($d.Status -eq 'OK') { '[OK]' } else { '[!] ' }
            Write-Host "    $tag $($d.FriendlyName) status=$($d.Status) class=$($d.Class)"
        }
    } finally {
        $ErrorActionPreference = $oldPref
    }
}

function Install-MorfinDriver {
    # Mantra ships the MorFin USB driver as a self-extracting .exe.
    # Windows needs it installed before plugging the MFS500 / MARC10
    # / MELO041 in, otherwise the device shows up as "Unknown" in
    # Device Manager and the daemon can't open the handle.
    #
    # Real-world install path (verified on 2026-06-11 with a fresh
    # Windows 11 laptop and an MFS500):
    #
    #   1. Vendor's NSIS installer often IGNORES the /S silent flag
    #      on modern Windows and returns exit 0 without doing anything.
    #      We don't trust the exit code -- we verify post-install via
    #      pnputil. If silent failed, we fall back to interactive so
    #      the operator clicks through the EULA + Install + Finish.
    #
    #   2. After the driver lands in the store, Windows does NOT
    #      auto-bind it to a device that was already plugged in.
    #      Operators don't know they need to replug -- they see
    #      Status=Error in Device Manager and ErrorCode 2027 from the
    #      daemon, and conclude the install is broken. Invoke-PnpRebind
    #      disables + re-enables the device, which is what Windows
    #      treats as a plug event and triggers driver evaluation.
    #
    # Idempotent -- re-running this function on a system that already
    # has the driver just runs the rebind step, which is harmless.

    $driverExe = Get-ChildItem (Join-Path $InstallRoot 'morfin') -Filter 'MorFinDriver_*.exe' -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $driverExe) {
        Write-Host "  (no MorFinDriver_*.exe in bundle -- assuming driver already installed)"
        Invoke-PnpRebind
        return
    }

    if (Test-MorfinDriverInstalled) {
        Write-Host "[OK] MorFin USB driver already in driver store"
        Invoke-PnpRebind
        return
    }

    Write-Host "-> installing MorFin USB driver $($driverExe.Name) (silent attempt)"
    # NSIS /S silent flag. Many vendor NSIS builds ignore it on Windows
    # 10/11; we verify post-install and don't trust the exit code.
    Start-Process -FilePath $driverExe.FullName -ArgumentList '/S' -Wait | Out-Null
    Start-Sleep -Seconds 2

    if (-not (Test-MorfinDriverInstalled)) {
        Write-Warning "  Silent driver install didn't take effect (Mantra's NSIS installer ignored /S)."
        Write-Warning "  Opening the installer interactively -- click through Next > Install > Finish in the wizard window."
        Start-Process -FilePath $driverExe.FullName -Verb RunAs -Wait | Out-Null
        Start-Sleep -Seconds 2
        if (-not (Test-MorfinDriverInstalled)) {
            throw @"
MorFin USB driver install failed even after the interactive installer ran.
Try running this manually as Administrator and walking through the wizard:
  $($driverExe.FullName)
Then re-run install.ps1.
"@
        }
    }
    Write-Host "[OK] MorFin USB driver installed"
    Invoke-PnpRebind
}

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
        & $nssm stop $svc *>$null
        & $nssm remove $svc confirm *>$null

        $java = Resolve-BundledJava
        $logPath = Join-Path $InstallRoot 'logs\MorfinAuthClientService.log'

        # ---------------------------------------------------------------
        # The space-in-Program-Files quoting bug -- and the only fix that
        # actually works:
        #
        # Under PowerShell 5.1, any attempt to pass quoted arguments to
        # nssm.exe loses the inner quotes. We've tested all three:
        #
        #   `& $nssm set $svc AppParameters "-jar `"$jar`""`
        #     -> stored: -jar C:\Program Files\... (NO quotes)
        #
        #   `& $nssm set $svc AppParameters --% -jar "C:\Program Files\..."`
        #     -> stored: -jar C:\Program Files\... (NO quotes)
        #     (Windows command-line parser strips quotes before nssm's argv)
        #
        #   `& $nssm set $svc AppParameters --% -jar \"C:\Program Files\...\"`
        #     -> also stored without quotes
        #
        # When the service starts, nssm hands the unquoted value to
        # CreateProcess, which tokenizes at the first space -> java gets
        # `-jar C:\Program` as the JAR path -> "Unable to access jarfile"
        # -> service crashes -> nssm restart-throttles -> Status=Paused.
        #
        # The only reliable fix is to bypass the nssm CLI for any value
        # that contains spaces. Set-ItemProperty writes the value
        # verbatim to the registry where nssm reads it on service start.
        # The quotes survive.
        #
        # We still use `nssm install` to CREATE the service entry
        # (creates the registry key with all the SCM bookkeeping); we
        # just overwrite the Application + AppParameters values
        # afterwards.
        # ---------------------------------------------------------------

        & $nssm install $svc $java *>$null
        # Wait briefly so nssm's registry writes complete before we
        # start overwriting them.
        Start-Sleep -Milliseconds 500

        $paramKey = "HKLM:\SYSTEM\CurrentControlSet\Services\$svc\Parameters"
        if (-not (Test-Path $paramKey)) {
            # Defensive: if nssm install didn't create Parameters (it
            # always should), create it ourselves so the writes below
            # land.
            New-Item -Path $paramKey -Force | Out-Null
        }

        # Application: nssm install above already wrote it, but PS5.1
        # might have mangled the spaces. Overwrite with the correct
        # value to be safe.
        Set-ItemProperty -Path $paramKey -Name 'Application'   -Value $java -Type String
        # AppParameters: this is THE value that breaks under nssm CLI.
        # Single-quoted PowerShell string preserves the inner " chars
        # literally. The stored value contains the quotes around the
        # JAR path -> CreateProcess tokenizes correctly -> java gets one
        # arg containing the full path.
        Set-ItemProperty -Path $paramKey -Name 'AppParameters' -Value "-jar `"$($morfinJar.FullName)`"" -Type String
        Set-ItemProperty -Path $paramKey -Name 'AppDirectory'  -Value $InstallRoot -Type String
        Set-ItemProperty -Path $paramKey -Name 'AppStdout'     -Value $logPath -Type String
        Set-ItemProperty -Path $paramKey -Name 'AppStderr'     -Value $logPath -Type String

        # The remaining values don't contain spaces, so the nssm CLI is
        # safe for them. (DisplayName/Description go to the service-
        # level key, not Parameters -- using nssm set is the simplest
        # path that doesn't require us to look up which key each one
        # lives in.)
        & $nssm set $svc DisplayName 'MorFin Fingerprint Daemon (Verification Portal)' *>$null
        & $nssm set $svc Description 'Vendor MorFin daemon listening on :8030 for fingerprint capture.' *>$null
        & $nssm set $svc Start SERVICE_AUTO_START *>$null
        & $nssm set $svc AppRestartDelay 3000 *>$null
        & $nssm set $svc AppExit Default Restart *>$null

        # Sanity-verify the AppParameters we just wrote retained the
        # critical quotes. If something stripped them, we're back to
        # the "Unable to access jarfile" failure mode -- abort here so
        # the operator sees the error during install instead of after.
        $stored = (Get-ItemProperty -Path $paramKey -Name AppParameters -ErrorAction SilentlyContinue).AppParameters
        if (-not $stored -or $stored -notmatch '^-jar\s+"') {
            throw "AppParameters didn't store with the required quotes around the JAR path. Stored value: $stored"
        }
        Write-Host "  [OK] AppParameters stored as: $stored"

        & $nssm start $svc *>$null
        Start-Sleep -Seconds 2

        # Final verification: the service should be Running, not Paused.
        $status = (Get-Service $svc -ErrorAction SilentlyContinue).Status
        if ($status -ne 'Running') {
            throw @"
$svc didn't reach Running state -- current status: $status.
Check the daemon log:
  Get-Content '$logPath' -Tail 30
Common causes:
  - Bundled JRE missing or corrupt (re-extract the install bundle)
  - JAR path quoting still broken (registry under
    HKLM:\SYSTEM\CurrentControlSet\Services\$svc\Parameters
    should have AppParameters with quotes around the JAR path)
"@
        }
    } finally {
        $ErrorActionPreference = $oldPref
    }
    Write-Host "  -> MorFin daemon registered and started (Status: Running)"
}

# ---------------------------------------------------------------------------
# Phase 4b -- Startek / ACPL Capture API
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
#   1. VC++ 2017 redist (x86) -- ACPLAPI.DLL / FM220API.DLL link against it.
#   2. The L1 RD Service (Windows Certified RD Service for L1 Devices) is a
#      SEPARATE vendor download from acpl.in.net. install.ps1 doesn't ship
#      it because it's not in our bundle scope -- but the Capture API needs
#      L1 RD running to hand off the USB device (RELEASEFM220 call from
#      our startek.js client). Warn the operator if L1 RD is missing.
#   3. The Capture API MSI (this bundle ships L1_API_Setup_30072025.msi).

function Install-StartekCaptureApi {
    $startekDir = Join-Path $InstallRoot 'startek'
    if (-not (Test-Path $startekDir)) {
        Write-Host "  (no startek payload staged; skipping -- re-run build-bundle.sh to include it)"
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
    # rather than fail -- let the operator decide whether to install it
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
# Phase 5 -- Vendor certs + browser homepage + shortcuts
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
    # (Internet Shortcuts), which only exposes TargetPath + Save -- no
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
# (No Require-Java -- the bundle ships its own Temurin JRE 17 under
# ./morfin/jre/, picked up by Resolve-BundledJava during service install.
# Operators don't need Java pre-installed and don't need to touch PATH.)

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

# --- iris (native Windows service, Marvis Auth Web SDK 1.4) ---------------
if (-not $SkipIris) {
    Write-Host ""
    Write-Host "=== Iris driver -- IriShield / MIS100V2 (IriTech VID 1F63) ==="
    Install-IrisDriver         # USB driver -- must run before the service registers
    Write-Host ""
    Write-Host "=== Iris daemon -- Marvis Auth (Windows native) ==="
    Install-MarvisIris
} else {
    Write-Host "-> -SkipIris set; iris driver + service NOT installed"
}

# --- fingerprint (Windows native, Mantra MorFin) ---------------------------
Write-Host ""
Write-Host "=== Fingerprint daemon -- Mantra MorFin (Windows native) ==="
Import-VendorCerts (Join-Path $InstallRoot 'morfin\certs')
Install-MorfinDriver       # USB driver -- must run before the daemon registers
Install-MorfinService

# --- fingerprint (Windows native, Startek/ACPL Capture API) ----------------
# Runs alongside Mantra on separate ports (MorFin :8030, ACPL :4443/:8090).
# The frontend probes both and picks whichever vendor has a device plugged
# in -- having both installed is intentional, not a conflict.
if (-not $SkipStartek) {
    Write-Host ""
    Write-Host "=== Fingerprint daemon -- Startek / ACPL Capture API (Windows native) ==="
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
New-Shortcut (Join-Path $desktop   'Verification Portal.url') $PortalUrl 'Verification Portal -- operator workstation'
New-Shortcut (Join-Path $startMenu 'Programs\Verification Portal.url') $PortalUrl 'Verification Portal -- operator workstation'

Write-Host ""
Write-Host "[OK] Operator laptop ready."
Write-Host "  Portal:        $PortalUrl"
Write-Host "  FP -- Mantra:   http://localhost:8030/  (Get-Service MorfinAuthClientService)"
if (-not $SkipStartek) {
    Write-Host "  FP -- Startek:  https://localhost:4443/  (ACPL Capture API; HTTPS) or :8090 (HTTP)"
}
if (-not $SkipIris) {
    Write-Host "  Iris:          http://localhost:8031/  (Get-Service *Marvis*)"
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
    Write-Host "  curl.exe -X POST http://localhost:8031/marvisauth/info       # Marvis iris"
}
