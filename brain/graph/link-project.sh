#!/usr/bin/env bash
# Link a project's graphify graph into the CENTRAL brain.
#
# Usage:
#   ./brain/graph/link-project.sh <project-name> <path-to-graph.json>
#
# Copies the project's graph.json into brain/graph/projects/<name>.json and
# records it in brain/graph/projects/registry.json, then rebuilds the central
# brain. The central brain is a merged cross-repo graph, so projects stay
# independent on disk but roll up into one queryable brain.
set -eu
DIR="/home/austin/agentic-os"
OUT="$DIR/brain/graph"
REG="$OUT/projects/registry.json"

NAME="${1:-}"
SRC="${2:-}"
if [ -z "$NAME" ] || [ -z "$SRC" ]; then
  echo "Usage: $0 <project-name> <path-to-graph.json>" >&2
  exit 1
fi
if [ ! -f "$SRC" ]; then
  echo "ERROR: graph not found: $SRC" >&2
  exit 1
fi

mkdir -p "$OUT/projects"
cp "$SRC" "$OUT/projects/$NAME.json"
echo "linked $NAME -> $OUT/projects/$NAME.json"

# update registry
python3 - "$REG" "$NAME" "$OUT/projects/$NAME.json" <<'PY'
import json, sys
reg, name, path = sys.argv[1], sys.argv[2], sys.argv[3]
data = {}
if __import__('os').path.exists(reg):
    try: data = json.load(open(reg))
    except Exception: data = {}
data[name] = {"graph": path, "linked": __import__('datetime').datetime.now().isoformat()}
json.dump(data, open(reg, "w"), indent=2)
PY

echo "rebuild central brain..."
bash "$OUT/build-central.sh"
