#!/usr/bin/env bash
# Agentic OS Quick Start
# Usage: ./start.sh          — start server
#        ./start.sh --open   — start server + open browser
#        ./start.sh --stop   — stop running server
#        ./start.sh --status — check if running

set -euo pipefail

PORT="${PORT:-8081}"
PID_FILE=".agentic-os.pid"
DASHBOARD_URL="http://127.0.0.1:${PORT}"

# ── Handle flags ───────────────────────────────────────────────────────────

case "${1:-}" in
  --stop)
    if [ -f "$PID_FILE" ]; then
      PID=$(cat "$PID_FILE")
      if kill -0 "$PID" 2>/dev/null; then
        kill "$PID" && echo "Agentic OS stopped (PID $PID)."
        rm -f "$PID_FILE"
      else
        echo "Agentic OS is not running (stale PID file removed)."
        rm -f "$PID_FILE"
      fi
    else
      echo "Agentic OS is not running."
    fi
    exit 0
    ;;
  --status)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "Agentic OS is running (PID $(cat "$PID_FILE")) — $DASHBOARD_URL"
    else
      echo "Agentic OS is not running."
    fi
    exit 0
    ;;
esac

# ── Already running? ───────────────────────────────────────────────────────

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Agentic OS is already running at $DASHBOARD_URL"
  echo "Use ./start.sh --stop to stop it first."
  exit 0
fi

# ── Setup ──────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Activate venv if it exists
if [ -d "venv" ]; then
  source venv/bin/activate
fi

# Install deps if needed
if ! python3 -c "import fastapi" 2>/dev/null; then
  echo "Installing dependencies..."
  pip3 install -r requirements.txt --quiet
fi

# ── Start server ───────────────────────────────────────────────────────────

echo ""
echo "  Agentic OS Dashboard"
echo "  ─────────────────────"
echo "  Starting on port ${PORT}..."
echo "  URL: ${DASHBOARD_URL}"
echo "  Press Ctrl+C to stop"
echo ""

nohup python3 server.py --port "$PORT" --host 0.0.0.0 > /tmp/agentic-os.log 2>&1 &
echo $! > "$PID_FILE"

# Wait for server to be ready
for i in $(seq 1 10); do
  if curl -s http://127.0.0.1:${PORT}/api/status > /dev/null 2>&1; then
    echo "  Ready! ($DASHBOARD_URL)"
    break
  fi
  sleep 0.5
done

# ── Open browser ───────────────────────────────────────────────────────────

case "${1:-}" in
  --open)
    echo "  Opening browser..."
    if command -v xdg-open &>/dev/null; then
      xdg-open "$DASHBOARD_URL" 2>/dev/null || true
    elif command -v open &>/dev/null; then
      open "$DASHBOARD_URL" 2>/dev/null || true
    fi
    ;;
esac

echo ""
echo "  Logs: tail -f /tmp/agentic-os.log"
echo "  Stop: ./start.sh --stop"
echo ""
