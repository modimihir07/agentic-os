#!/usr/bin/env bash
# Build the CENTRAL Agentic-OS brain graph.
#
# Strategy (works WITHOUT an LLM key):
#   1. Build this project's CODE graph (graphify . --code-only) into
#      brain/graph/agentic-os.json  (nodes = code symbols, edges = relations).
#   2. Merge in every linked project graph under brain/graph/projects/ -> central-graph.json
#      (cross-repo union = the unified brain).
#
# The central brain is the single queryable artifact. Per-project graphs stay
# independent; they are rolled up here via `graphify merge-graphs`.
#
# To make MEMORY NOTES queryable too, set an LLM key (GEMINI_API_KEY etc.)
# and run `graphify . ` (no --code-only) — that adds markdown notes as nodes.
# Until then, notes live as linked files and the code graph indexes structure.

set -u
DIR="/home/austin/agentic-os"
VENV="$DIR/venv"
GF="$VENV/bin/graphify"
OUT="$DIR/brain/graph"
PORT="${CENTRAL_BRAIN_PORT:-8090}"

cd "$DIR" || { echo "FATAL: cannot cd $DIR"; exit 1; }

echo "==> [1/2] building Agentic-OS code graph"
"$GF" . --code-only --no-viz 2>&1 | tail -2 || {
  echo "WARN: code graph build failed; using existing graphify-out/graph.json if present"
}
# graphify always writes to graphify-out/graph.json relative to the scanned root
[ -f "$DIR/graphify-out/graph.json" ] && cp "$DIR/graphify-out/graph.json" "$OUT/agentic-os.json" && echo "   copied -> $OUT/agentic-os.json"

echo "==> [2/2] merging linked project graphs into central brain"
MAPS=()
[ -f "$OUT/agentic-os.json" ] && MAPS+=("$OUT/agentic-os.json")
for g in "$OUT"/projects/*.json; do
  [ -f "$g" ] && MAPS+=("$g")
done

if [ "${#MAPS[@]}" -eq 0 ]; then
  echo "ERROR: no graph.json found to merge"; exit 1
elif [ "${#MAPS[@]}" -eq 1 ]; then
  # only the agentic-os graph so far — central brain = that graph (no merge needed)
  cp "${MAPS[0]}" "$OUT/central-graph.json" && echo "   (single source -> central brain)"
else
  "$GF" merge-graphs "${MAPS[@]}" --out "$OUT/central-graph.json" 2>&1 | tail -3
fi
echo "==> central brain written: $OUT/central-graph.json"
"$VENV/bin/python" -c "import json;d=json.load(open('$OUT/central-graph.json'));n=d.get('nodes',d.get('graph',{}).get('nodes',[]));print('   nodes:',len(n) if isinstance(n,list) else '?')" 2>/dev/null || true
