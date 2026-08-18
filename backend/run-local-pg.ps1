# Run local PostgreSQL 16 server natively on Windows without Docker
$ErrorActionPreference = "Stop"

$baseDir = $PSScriptRoot
$pgsqlDir = Join-Path $baseDir ".pgsql"
$binDir = Join-Path $pgsqlDir "pgsql\bin"
$dataDir = Join-Path $baseDir ".pgsql_data"
$logFile = Join-Path $baseDir "pgsql_server.log"

Write-Host "==> Checking local PostgreSQL installation..." -ForegroundColor Cyan

if (-not (Test-Path (Join-Path $binDir "postgres.exe"))) {
    Write-Host "ERROR: PostgreSQL binaries not found in $binDir." -ForegroundColor Red
    exit 1
}

# If data directory is not a valid cluster, clean and re-init
if (-not (Test-Path (Join-Path $dataDir "PG_VERSION"))) {
    Write-Host "==> Initializing PostgreSQL data directory with user 'portal'..." -ForegroundColor Yellow
    if (Test-Path $dataDir) {
        Remove-Item -Path $dataDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    
    $tmpPw = Join-Path $env:TEMP "pg_pw_temp.txt"
    Set-Content -Path $tmpPw -Value "portal-dev" -NoNewline

    & (Join-Path $binDir "initdb.exe") -D $dataDir -U portal --pwfile=$tmpPw -E UTF8 -A trust
    Remove-Item -Path $tmpPw -Force -ErrorAction SilentlyContinue
    Write-Host "==> Data directory initialized successfully." -ForegroundColor Green
}

# Check if server is already running on port 5434
$conn = Test-NetConnection -ComputerName 127.0.0.1 -Port 5434 -WarningAction SilentlyContinue
if (-not $conn.TcpTestSucceeded) {
    Write-Host "==> Starting PostgreSQL on port 5434..." -ForegroundColor Yellow
    & (Join-Path $binDir "pg_ctl.exe") start -D $dataDir -o "-p 5434" -l $logFile

    Start-Sleep -Seconds 3
} else {
    Write-Host "==> PostgreSQL is already running on port 5434." -ForegroundColor Green
}

# Create 'verification' database if it doesn't exist
Write-Host "==> Ensuring 'verification' database exists..." -ForegroundColor Yellow
& (Join-Path $binDir "createdb.exe") -p 5434 -U portal -h 127.0.0.1 verification 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "==> Created 'verification' database." -ForegroundColor Green
} else {
    Write-Host "==> 'verification' database ready." -ForegroundColor Green
}

Write-Host "`nSUCCESS: Local PostgreSQL is running on 127.0.0.1:5434!" -ForegroundColor Green
Write-Host "DATABASE_URL: postgres://portal:portal-dev@127.0.0.1:5434/verification?sslmode=disable`n" -ForegroundColor Cyan
