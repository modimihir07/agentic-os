#!/usr/bin/env bash
# Start the Agentic-OS Agent-Time Monitor on localhost.
# Usage:  ./dashboard/start-monitor.sh [port]
# Then open: http://localhost:<port>/dashboard/pages/agent-time-monitor.html
set -e
cd "$(dirname "$0")/.."
PORT="${1:-8765}"
if [ -d venv ]; then . venv/bin/activate; fi
echo "Starting monitor on http://127.0.0.1:${PORT} ..."
exec python3 dashboard/serve_monitor.py --port "${PORT}"
