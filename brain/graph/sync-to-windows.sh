#!/usr/bin/env bash
# Sync the WSL-built central brain into the WINDOWS-native central brain.
#
# The Agentic-OS brain lives in WSL (brain/graph/). The device-wide central
# brain lives on Windows at C:\Users\Austin\Brains\central\, running its own
# Graphify (own venv) — fully offline, no WSL dependency at query time.
#
# This script: rebuild the WSL central brain, then copy central-graph.json
# into the Windows folder so the Windows serve (serve-brain.bat) picks it up.
set -u
DIR="/home/austin/agentic-os"
WIN_BRAIN="/mnt/c/Users/Austin/Brains/central"

cd "$DIR" || { echo "FATAL: cannot cd $DIR"; exit 1; }

echo "==> rebuild WSL central brain"
bash "$DIR/brain/graph/build-central.sh" 2>&1 | tail -3

if [ ! -d "$WIN_BRAIN" ]; then
  echo "WARN: Windows brain dir missing ($WIN_BRAIN) — skipping push. Create it + venv first."
  exit 0
fi

echo "==> push central-graph.json -> Windows brain"
cp "$DIR/brain/graph/central-graph.json" "$WIN_BRAIN/central-graph.json"
echo "   copied -> $WIN_BRAIN/central-graph.json"
echo "==> done. Windows serve (serve-brain.bat) will serve the updated graph on next (re)start."
