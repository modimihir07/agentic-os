#!/usr/bin/env bash
# Serve the WSL-side central brain over HTTP MCP.
# Independent of the Windows brain (separate process, same port 8090 on the
# WSL loopback). Provides a redundant/fail-safe brain endpoint: if the Windows
# brain is unavailable, agents on the WSL side can still query here.
set -u
DIR="/home/austin/agentic-os"
VENV="$DIR/venv"
GF="$VENV/bin/python"
GRAPH="$DIR/brain/graph/central-graph.json"
PORT="${CENTRAL_BRAIN_PORT:-8090}"

cd "$DIR" || exit 1
if [ ! -f "$GRAPH" ]; then
  echo "central brain missing ($GRAPH). Run: bash brain/graph/build-central.sh" >&2
  exit 1
fi
echo "Serving WSL central brain on http://127.0.0.1:$PORT/mcp"
exec "$GF" -m graphify.serve "$GRAPH" --transport http --host 127.0.0.1 --port "$PORT"
