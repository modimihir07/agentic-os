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
PORT=$($PYTHON -c "import json; f=open('data/settings.json'); d=json.load(f); print(d.get('dashboard',{}).get('port',8080)); f.close()" 2>/dev/null || echo "8080")

echo "Dashboard: http://127.0.0.1:${PORT}"
echo "Press Ctrl+C to stop"
echo ""

# Start server
$PYTHON server.py --port "${PORT}"
