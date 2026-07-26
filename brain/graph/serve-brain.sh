#!/usr/bin/env bash
# Serve the CENTRAL brain graph over HTTP MCP so agents/tools can query it.
#
# Endpoints:  http://127.0.0.1:8090/mcp   (Streamable HTTP MCP)
# Requires the graphify [mcp] extra (pip install "graphifyy[mcp]").
#
# The central brain is the single memory/code query surface for all projects.
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

echo "Serving central brain on http://127.0.0.1:$PORT/mcp"
exec "$GF" -m graphify.serve "$GRAPH" --transport http --host 127.0.0.1 --port "$PORT"
