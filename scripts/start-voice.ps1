<#
  Start the Jarvis voice stack (and the gateway) if they aren't already running.

    powershell -ExecutionPolicy Bypass -File "D:\Art Apps\agentic os\scripts\start-voice.ps1"

  - Whisper STT  : C:\whisper\bin\whisper-server.exe  -> http://127.0.0.1:8178/v1/audio/transcriptions
  - Kokoro TTS   : Docker container "kokoro"           -> http://127.0.0.1:8880/v1/audio/speech
  - Gateway      : server.py                           -> http://127.0.0.1:8080  (the desktop app also starts this)

  Safe to run repeatedly: anything already listening is left alone.
#>
param(
  [string]$WhisperModel = "C:\whisper\models\ggml-base.en.bin",
  [int]$Threads = 6,
  [switch]$NoGateway
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot

function Test-Port([int]$port) {
  [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

function Wait-Port([int]$port, [int]$seconds) {
  for ($i = 0; $i -lt $seconds; $i++) { if (Test-Port $port) { return $true }; Start-Sleep 1 }
  return $false
}

# -- Whisper ------------------------------------------------------------------
if (Test-Port 8178) {
  Write-Host "Whisper   already running on :8178" -ForegroundColor DarkGray
} elseif (-not (Test-Path "C:\whisper\bin\whisper-server.exe")) {
  Write-Host "Whisper   not installed (C:\whisper\bin\whisper-server.exe missing)" -ForegroundColor Red
} else {
  Start-Process -FilePath "C:\whisper\bin\whisper-server.exe" `
    -ArgumentList "-m", $WhisperModel, "--host", "127.0.0.1", "--port", "8178", "--inference-path", "/v1/audio/transcriptions", "-t", "$Threads" `
    -WorkingDirectory "C:\whisper" -WindowStyle Hidden `
    -RedirectStandardError "C:\whisper\server.log" -RedirectStandardOutput "C:\whisper\server.out.log"
  if (Wait-Port 8178 20) { Write-Host "Whisper   started on :8178 ($(Split-Path -Leaf $WhisperModel))" -ForegroundColor Green }
  else { Write-Host "Whisper   failed to start - see C:\whisper\server.log" -ForegroundColor Red }
}

# -- Kokoro (Docker) ----------------------------------------------------------
if (Test-Port 8880) {
  Write-Host "Kokoro    already running on :8880" -ForegroundColor DarkGray
} else {
  $exists = docker ps -a --filter "name=^kokoro$" --format "{{.Names}}" 2>$null
  if (-not $exists) {
    Write-Host "Kokoro    container not created yet - ask Claude/Cline to set it up (see HANDOFF.md)" -ForegroundColor Red
  } else {
    docker start kokoro | Out-Null
    if (Wait-Port 8880 60) { Write-Host "Kokoro    started on :8880" -ForegroundColor Green }
    else { Write-Host "Kokoro    container started but :8880 isn't answering yet - check 'docker logs kokoro'" -ForegroundColor Yellow }
  }
}

# -- Gateway ------------------------------------------------------------------
if (-not $NoGateway) {
  if (Test-Port 8080) {
    Write-Host "Gateway   already running on :8080" -ForegroundColor DarkGray
  } else {
    Start-Process -FilePath "python" -ArgumentList "server.py", "--port", "8080" -WorkingDirectory $repo -WindowStyle Hidden
    if (Wait-Port 8080 20) { Write-Host "Gateway   started on :8080" -ForegroundColor Green }
    else { Write-Host "Gateway   failed to start - run 'python server.py' in $repo to see why" -ForegroundColor Red }
  }
}
