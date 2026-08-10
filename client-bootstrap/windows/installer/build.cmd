@echo off
REM build.cmd — compile OperatorPortalSetup.iss into a single .exe.
REM
REM Prerequisites:
REM   1. Run client-bootstrap\windows\build-bundle.sh first so the
REM      bundle staging dir exists at:
REM        client-bootstrap\windows\dist\VerificationPortalClient-1.0.0-windows\
REM      (Run it from WSL or git-bash on Windows.)
REM   2. Install Inno Setup 6 from https://jrsoftware.org/isinfo.php
REM      (free, takes ~30 seconds).
REM
REM Output:
REM   client-bootstrap\windows\installer\output\OperatorPortalSetup-1.0.0.exe

setlocal
cd /d "%~dp0"

set "ISCC=C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" set "ISCC=C:\Program Files\Inno Setup 6\ISCC.exe"

if not exist "%ISCC%" (
    echo.
    echo Inno Setup 6 not found.
    echo Download and install from: https://jrsoftware.org/isinfo.php
    echo.
    echo If you have Inno Setup installed elsewhere, set the ISCC env var:
    echo   set ISCC=C:\path\to\ISCC.exe
    echo.
    exit /b 1
)

if not exist "..\dist\VerificationPortalClient-1.0.0-windows\install.ps1" (
    echo.
    echo Bundle staging dir not found.
    echo Run client-bootstrap\windows\build-bundle.sh first to populate
    echo the staging dir at:
    echo   client-bootstrap\windows\dist\VerificationPortalClient-1.0.0-windows\
    echo.
    exit /b 1
)

echo Compiling OperatorPortalSetup.iss with Inno Setup...
"%ISCC%" OperatorPortalSetup.iss
if errorlevel 1 (
    echo.
    echo Inno Setup compilation failed. See output above for errors.
    exit /b 1
)

echo.
echo Build complete. Installer is at:
echo   %~dp0output\OperatorPortalSetup-1.0.0.exe
echo.
endlocal
