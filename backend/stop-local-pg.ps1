# Stop local PostgreSQL 16 server
$baseDir = $PSScriptRoot
$binDir = Join-Path $baseDir ".pgsql\pgsql\bin"
$dataDir = Join-Path $baseDir ".pgsql_data"

if (Test-Path (Join-Path $binDir "pg_ctl.exe")) {
    Write-Host "==> Stopping PostgreSQL on port 5434..." -ForegroundColor Yellow
    & (Join-Path $binDir "pg_ctl.exe") stop -D $dataDir -m fast
    Write-Host "==> PostgreSQL stopped." -ForegroundColor Green
}
