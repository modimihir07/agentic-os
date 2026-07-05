@echo off
cd /d "%~dp0"
powershell -NoLogo -ExecutionPolicy Bypass -File "%~dp0start.ps1"
pause
