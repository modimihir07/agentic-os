#!/usr/bin/env bash
set -euo pipefail

echo "Starting Agentic OS Dashboard..."
echo ""

# Check if server.py exists
if [ ! -f server.py ]; then
    echo "ERROR: server.py not found. Are you in the right directory?"
    exit 1
fi

# Resolve Python
if command -v python &>/dev/null; then
    PYTHON="python"
elif command -v python3 &>/dev/null; then
    PYTHON="python3"
else
    echo "ERROR: Python 3.10+ required. Install from https://www.python.org/downloads/ or your OS package manager."
    exit 1
fi

# Check dependencies
$PYTHON -m pip install -r requirements.txt --quiet 2>/dev/null

# Get port from settings or default
CONFIGURED_PORT=$($PYTHON -c "import json; f=open('data/settings.json'); d=json.load(f); print(d.get('dashboard',{}).get('port',8080)); f.close()" 2>/dev/null || echo "8080")

# Find a free port starting at CONFIGURED_PORT (in case it's already taken by another app)
PORT="$CONFIGURED_PORT"
for _ in $(seq 1 20); do
    if ! (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; then
        break
    fi
    exec 3>&- 2>/dev/null || true
    PORT=$((PORT + 1))
done

if [ "$PORT" != "$CONFIGURED_PORT" ]; then
    echo "WARNING: Port ${CONFIGURED_PORT} is already in use - using ${PORT} instead."
fi

echo "Dashboard: http://127.0.0.1:${PORT}"
echo "Press Ctrl+C to stop"
echo ""

# Best-effort auto-open browser once the server is up
( sleep 2
  if command -v xdg-open &>/dev/null; then xdg-open "http://127.0.0.1:${PORT}" &>/dev/null
  elif command -v open &>/dev/null; then open "http://127.0.0.1:${PORT}" &>/dev/null
  fi
) &

# Start server
$PYTHON server.py --port "${PORT}"
