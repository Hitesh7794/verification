# install.ps1 — operator-laptop bootstrap (Windows 10/11).
#
# Run from inside the unpacked bundle, in an elevated PowerShell:
#
#   .\install.ps1 -PortalUrl https://portal.example.com
#
# Installs:
#   - MorFin fingerprint daemon as a Windows service on :8030 (java -jar)
#   - Mantra iris service as a Windows service on :8031 (java -jar)
#   - Browser homepage policy pinning the portal URL (Edge + Chrome)
#   - Vendor TLS certs into Cert:\LocalMachine\Root
#   - Start Menu + Desktop shortcuts to the portal
#
# Both services are registered via `nssm.exe` (bundled in tools/) which
# wraps a JAR as a proper Windows service with auto-restart.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PortalUrl,

    [string]$InstallRoot = "C:\Program Files\VerificationPortal"
)

$ErrorActionPreference = 'Stop'

function Require-Admin {
    $current = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]$current
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "install.ps1 must be run from an elevated PowerShell prompt (Run as Administrator)."
    }
}

function Require-Java {
    # We rely on `java` being on PATH. Bundling a JRE is possible via
    # jlink but adds maintenance surface; defer until field need.
    try {
        $null = & java -version 2>&1
    } catch {
        throw "Java is required but `"java`" was not found on PATH. Install Adoptium Temurin 17 from https://adoptium.net/ and re-run."
    }
}

function Install-Service([string]$Name, [string]$Jar, [string]$DisplayName, [hashtable]$EnvVars) {
    $nssm = Join-Path $PSScriptRoot 'tools\nssm.exe'
    if (-not (Test-Path $nssm)) {
        throw "tools/nssm.exe missing from bundle (cannot register Windows services)."
    }

    # Pre-flight: stop + remove if already installed (idempotent re-run).
    & $nssm stop $Name 2>$null | Out-Null
    & $nssm remove $Name confirm 2>$null | Out-Null

    $java = (Get-Command java).Source
    & $nssm install $Name $java "-jar `"$Jar`"" | Out-Null
    & $nssm set $Name DisplayName $DisplayName | Out-Null
    & $nssm set $Name Description "Verification Portal — $DisplayName" | Out-Null
    & $nssm set $Name Start SERVICE_AUTO_START | Out-Null
    & $nssm set $Name AppRestartDelay 3000 | Out-Null
    & $nssm set $Name AppExit Default Restart | Out-Null
    & $nssm set $Name AppStdout (Join-Path $InstallRoot "logs\$Name.log") | Out-Null
    & $nssm set $Name AppStderr (Join-Path $InstallRoot "logs\$Name.log") | Out-Null

    if ($EnvVars) {
        $envBlock = ($EnvVars.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join "`r`n"
        & $nssm set $Name AppEnvironmentExtra $envBlock | Out-Null
    }

    & $nssm start $Name | Out-Null
    Write-Host "  → service '$Name' registered and started"
}

function Import-VendorCerts([string]$CertDir) {
    if (-not (Test-Path $CertDir)) { return }
    Get-ChildItem -Path $CertDir -Filter '*.crt' | ForEach-Object {
        # Cert:\LocalMachine\Root is the system-wide trust store browsers
        # honour by default on Windows. Same end result as the .deb's
        # `update-ca-certificates` + `certutil` Firefox/Chrome import on
        # Linux, with one big difference: Windows browsers all read this
        # store, no per-browser dance needed.
        $thumb = (Import-Certificate -FilePath $_.FullName `
                  -CertStoreLocation 'Cert:\LocalMachine\Root').Thumbprint
        Write-Host "  → imported $($_.Name) (thumbprint $thumb)"
    }
}

function Set-BrowserHomepage([string]$Url) {
    # Edge + Chrome both honour HKLM\SOFTWARE\Policies\<Vendor>\<Browser>
    # for homepage / startup-URL policy. Writing here pins the policy
    # for every user on the machine — operator profiles can't override.
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

        # RestoreOnStartupURLs is a sub-key with numbered string values.
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

# --- main -------------------------------------------------------------------

Require-Admin
Require-Java

Write-Host "→ creating install root: $InstallRoot"
New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $InstallRoot 'logs') | Out-Null

Write-Host "→ staging JARs and tools"
Copy-Item -Recurse -Force (Join-Path $PSScriptRoot 'morfin') $InstallRoot
Copy-Item -Recurse -Force (Join-Path $PSScriptRoot 'iris')   $InstallRoot
Copy-Item -Recurse -Force (Join-Path $PSScriptRoot 'tools')  $InstallRoot

$morfinJar = Get-ChildItem (Join-Path $InstallRoot 'morfin') -Filter 'morfinauth-client-service-*.jar' | Select-Object -First 1
$irisJar   = Get-ChildItem (Join-Path $InstallRoot 'iris')   -Filter 'mantra-iris-service-*.jar'        | Select-Object -First 1
if (-not $morfinJar) { throw "MorFin JAR not found in bundle morfin/ folder." }
if (-not $irisJar)   { throw "Iris service JAR not found in bundle iris/ folder."   }

Write-Host "→ importing vendor TLS certificates"
Import-VendorCerts (Join-Path $InstallRoot 'morfin\certs')

Write-Host "→ registering MorFin fingerprint daemon (port 8030)"
Install-Service -Name 'MorfinAuthClientService' `
                -Jar  $morfinJar.FullName `
                -DisplayName 'MorFin Fingerprint Daemon'

Write-Host "→ registering Mantra iris service (port 8031)"
Install-Service -Name 'MantraIrisService' `
                -Jar  $irisJar.FullName `
                -DisplayName 'Mantra Iris Service' `
                -EnvVars @{
                    # Strict mode = fail-closed on SDK load failure, so
                    # ops sees a stopped service instead of fake scores.
                    IRIS_PROVIDER = 'marvis-strict';
                    IRIS_PORT     = '8031';
                }

Write-Host "→ pinning portal homepage in Chrome / Edge policy"
Set-BrowserHomepage $PortalUrl

Write-Host "→ creating Start Menu + Desktop shortcuts"
$desktop = [Environment]::GetFolderPath('CommonDesktopDirectory')
$startMenu = [Environment]::GetFolderPath('CommonStartMenu')
New-Shortcut -LinkPath (Join-Path $desktop   'Verification Portal.url') `
             -Target $PortalUrl `
             -Description 'Verification Portal — operator workstation'
New-Shortcut -LinkPath (Join-Path $startMenu 'Programs\Verification Portal.url') `
             -Target $PortalUrl `
             -Description 'Verification Portal — operator workstation'

Write-Host ""
Write-Host "✓ Operator laptop ready."
Write-Host "  Portal:      $PortalUrl"
Write-Host "  Fingerprint: http://localhost:8030/  (Get-Service MorfinAuthClientService)"
Write-Host "  Iris:        http://localhost:8031/  (Get-Service MantraIrisService)"
Write-Host "  Shortcut:    Desktop + Start Menu"
