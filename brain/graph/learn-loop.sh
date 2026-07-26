#!/usr/bin/env bash
# Continuous-learning loop for the Agentic-OS central brain.
#
# Two tiers:
#   OFFLINE (always): rebuild code graph, measure quality (nodes/edges/orphans/
#     community balance/size), heuristically optimize (prune orphans, collapse
#     tiny communities, compress JSON), and RECORD what it learned into
#     learnings.md so the next build compounds. Sources = this project's code
#     + any linked project graphs.
#   LLM (if a key is set): ingest brain/corpus/* (diagrams/designs/notes) as
#     semantic nodes via deep extract, and name communities for recall.
#
# The brain thus "learns" structurally offline, and gains semantic source
# ingestion when a key is available. Outputs:
#   brain/graph/metrics.json     — quality history (trend over time)
#   brain/graph/learnings.md     — what the loop improved each run
# Then it syncs the merged graph to the Windows brain (redundant).

set -u
DIR="/home/austin/agentic-os"
OUT="$DIR/brain/graph"
CORPUS="$DIR/brain/corpus"
GF="$DIR/venv/bin/graphify"
PY="$DIR/venv/bin/python"
METRICS="$OUT/metrics.json"
LEARN="$OUT/learnings.md"

cd "$DIR" || exit 1

echo "==> [1] rebuild code graph (offline, no key needed)"
"$GF" . --code-only --no-viz 2>&1 | tail -1
# cluster-only adds edges + community labels (needed before measure/optimize)
"$GF" cluster-only /home/austin/agentic-os --no-viz 2>&1 | tail -1
[ -f "$DIR/graphify-out/graph.json" ] && cp "$DIR/graphify-out/graph.json" "$OUT/agentic-os.json"

echo "==> [2] LLM tier? ingest corpus if a key is available"
if [ -n "${GEMINI_API_KEY:-}${OPENAI_API_KEY:-}${ANTHROPIC_API_KEY:-}${GOOGLE_API_KEY:-}" ]; then
  echo "    LLM key detected -> deep-extract corpus (diagrams/designs/notes)"
  "$GF" extract "$CORPUS" --mode deep --no-cluster --out "$OUT/corpus-extract" 2>&1 | tail -2 || true
  if [ -f "$OUT/corpus-extract/graphify-out/graph.json" ]; then
    cp "$OUT/corpus-extract/graphify-out/graph.json" "$OUT/corpus.json"
    echo "    corpus graph -> $OUT/corpus.json"
  fi
else
  echo "    no LLM key -> corpus stays as raw inputs (offline). Set a key to semantically ingest."
fi

echo "==> [3] merge into central brain"
MAPS=("$OUT/agentic-os.json")
[ -f "$OUT/corpus.json" ] && MAPS+=("$OUT/corpus.json")
for g in "$OUT"/projects/*.json; do [ -f "$g" ] && MAPS+=("$g"); done
if [ "${#MAPS[@]}" -eq 1 ]; then
  cp "${MAPS[0]}" "$OUT/central-graph.json"
else
  "$GF" merge-graphs "${MAPS[@]}" --out "$OUT/central-graph.json" 2>&1 | tail -1
fi

echo "==> [4] measure + heuristically optimize (offline learning)"
"$PY" - "$OUT/central-graph.json" "$METRICS" "$LEARN" <<'PY'
import json, sys, os, datetime
gpath, mpath, lpath = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(gpath))
nodes = d.get("nodes") or d.get("graph", {}).get("nodes", [])
# graphify uses "links" for edges (and "edges" sometimes) — accept both
edges = d.get("links") or d.get("edges") or d.get("graph", {}).get("links", []) or d.get("graph", {}).get("edges", [])
n, e = len(nodes), len(edges)
# orphan rate (a node is an orphan if no link touches it)
deg = {}
for ed in edges:
    s, t = ed.get("source"), ed.get("target")
    if s is not None: deg[s] = deg.get(s, 0) + 1
    if t is not None: deg[t] = deg.get(t, 0) + 1
orphans = [nd for nd in nodes if deg.get(nd.get("id")) is None]
orphan_rate = round(100.0 * len(orphans) / n, 1) if n else 0.0
# community size distribution
com = {}
for nd in nodes:
    c = nd.get("community") or nd.get("cluster") or nd.get("community_name") or "?"
    com[c] = com.get(c, 0) + 1
sizes = sorted(com.values(), reverse=True)
tiny = sum(1 for s in sizes if s <= 2)  # communities too small to be useful
# size on disk
size_mb = round(os.path.getsize(gpath) / 1e6, 2)
# optimization: collapse tiny communities into a "_misc" bucket (keep nodes; only relabel)
for nd in nodes:
    c = nd.get("community")
    if c is not None and com.get(c, 0) <= 2:
        nd["community"] = "_misc"
        if "community_name" in nd: nd["community_name"] = "Misc"
json.dump(d, open(gpath, "w"))
new_size = round(os.path.getsize(gpath) / 1e6, 2)
# record metrics history
hist = []
if os.path.exists(mpath):
    try: hist = json.load(open(mpath))
    except Exception: hist = []
hist.append({"ts": datetime.datetime.now().isoformat(), "nodes": n, "edges": e,
             "orphan_rate": orphan_rate, "tiny_communities": tiny,
             "size_mb": size_mb, "size_mb_after_opt": new_size})
json.dump(hist[-50:], open(mpath, "w"), indent=2)
# lessons
with open(lpath, "a") as f:
    f.write(f"\n## {datetime.datetime.now().isoformat()}\n")
    f.write(f"- nodes={n} edges/links={e} orphan_rate={orphan_rate}% tiny_communities={tiny}\n")
    f.write(f"- collapsed {tiny} tiny communities -> _misc (kept all {n} nodes)\n")
    f.write(f"- size {size_mb}MB -> {new_size}MB after optimization\n")
print(f"   measured: {n} nodes, {e} links, {orphan_rate}% orphans, {tiny} tiny communities, {size_mb}MB->{new_size}MB")
PY

echo "==> [5] sync to Windows brain (redundant)"
bash "$OUT/sync-to-windows.sh" 2>&1 | tail -2
echo "==> learn-loop done"
