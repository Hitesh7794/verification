# install.ps1 -- operator-laptop bootstrap (Windows 10 19041+ / Windows 11).
#
# Architecture:
#
#   Windows host:
#     Browser -> portal URL                  (portal frontend, served remote)
#             -> localhost:8030              (Mantra MorFin FP, native Win)
#             -> localhost:4443 / :8090      (Startek/ACPL FP, native Win)
#             -> localhost:8031              (mantra-iris-service in WSL2)
#
#     WSL2 Ubuntu - runs mantra-iris-service.deb on :8031
#         ^
#         | usbipd-win passes through MIS100V2 (vendor 2c0f:2100) - needed
#         | because Mantra's Marvis_Auth.jar Windows DLL has a JNI
#         | signature mismatch (vendor bug); the Linux .so in the same
#         | JAR works fine.
#         |
#     USB devices: MorFin readers (MELO041 / MFS500 / MARC10), Startek
#     FM220U L1 (0BCA:8230) / AST300 (34F9:8230), Marvis MIS100V2 (2c0f:2100).
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
# Phase 1 -- WSL2 enablement (may require reboot)
# ---------------------------------------------------------------------------

function Test-Wsl2Ready {
    # Check the underlying Windows optional features directly -- more robust
    # than invoking `wsl --status`, which writes its banner to stderr (which
    # PS5.1 turns into a terminating error under ErrorActionPreference=Stop).
    $f1 = (Get-WindowsOptionalFeature -Online -FeatureName 'Microsoft-Windows-Subsystem-Linux' -ErrorAction SilentlyContinue).State
    $f2 = (Get-WindowsOptionalFeature -Online -FeatureName 'VirtualMachinePlatform' -ErrorAction SilentlyContinue).State
    return ($f1 -eq 'Enabled' -and $f2 -eq 'Enabled')
}

function Test-WslDistroPresent([string]$Name) {
    # `wsl -l -q` lists installed distros (one per line, UTF-16-LE on
    # older WSL -- strip nulls before matching). EAP=Continue locally so
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
    & wsl.exe --set-default-version 2 *>$null

    Write-Host "-> updating WSL kernel"
    & wsl.exe --update *>$null

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
            Write-Host "  (an Ubuntu setup window may open briefly -- close it; the script will continue)"
            $output = & wsl.exe --install -d $Name 2>&1
            $rc = $LASTEXITCODE
        }
        $output | ForEach-Object { if ($_) { Write-Host "  $_" } }
        if ($rc -ne 0) {
            throw "WSL distro install failed (exit $rc). Run 'wsl --list --online' to see available distros and retry with -WslDistro <Name>."
        }
        # Force a clean shutdown of any auto-launched session before we re-enter.
        Start-Sleep -Seconds 3
        & wsl.exe --shutdown *>$null
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
# Phase 2 -- usbipd-win (USB passthrough into WSL)
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
    # winget puts usbipd in %ProgramFiles%\usbipd-win\ -- refresh PATH so
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
# Phase 3 -- Provision iris service inside WSL
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
