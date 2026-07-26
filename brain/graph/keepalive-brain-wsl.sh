#!/usr/bin/env bash
# Redundant keepalive for the WSL-side central brain MCP serve (:8090).
# Mirrors keepalive-brain.bat on Windows. If the serve is down, start it.
# Designed as a fail-safe: the Windows brain is primary for Windows-side
# queries; this keeps the WSL-side brain answerable even if Windows is down.
set -u
PORT="${CENTRAL_BRAIN_PORT:-8090}"
LAUNCH="/home/austin/agentic-os/brain/graph/serve-brain-wsl.sh"
LOG="/home/austin/agentic-os/brain/graph/wsl-keepalive.log"

# is something listening on the port?
if ss -ltn 2>/dev/null | grep -q ":$PORT "; then
  exit 0
fi

echo "$(date '+%F %T') brain serve down on :$PORT -- starting" >> "$LOG"
# launch detached so this script can exit (cron-friendly)
setsid bash "$LAUNCH" >> "$LOG" 2>&1 < /dev/null &
