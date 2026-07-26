# Central Brain — Graphify knowledge graph

One central, queryable brain that project graphs roll up into.

## Topology (two brains)
1. **Agentic-OS brain (WSL)** — this folder. `agentic-os.json` + merged `central-graph.json`.
2. **Windows central brain (device-wide, offline, standalone)** — `C:\Users\Austin\Brains\central\`.
   Its own Python venv + Graphify, serves `central-graph.json` over HTTP MCP at
   `http://127.0.0.1:8090/mcp` from Windows. No WSL dependency at query time.
   WSL's `sync-to-windows.sh` pushes the merged graph into it hourly.

Per-project graphs: `projects/<name>.json` (linked via `link-project.sh`) roll
up into `central-graph.json` here, which is then synced to Windows.

## Commands (WSL side)
```
bash brain/graph/build-central.sh            # rebuild WSL central brain (code graph + merge linked projects)
bash brain/graph/link-project.sh <name> <graph.json>   # register a project's graph into the brain
bash brain/graph/sync-to-windows.sh          # rebuild + push merged graph to Windows central brain
bash brain/graph/serve-brain.sh             # serve WSL central brain over HTTP MCP (:8090)
bash brain/graph/serve-brain-wsl.sh         # redundant WSL serve (:8090, independent of Windows brain)
bash brain/graph/keepalive-brain-wsl.sh     # restart WSL serve if :8090 drops (fail-safe)
```
Set `CENTRAL_BRAIN_PORT` to override the serve port (default 8090).

## Continuous learning
`learn-loop.sh` runs the self-improving pass (replaces the plain rebuild):
1. Rebuild code graph + cluster (edges + community labels).
2. If an LLM key is set (GEMINI/OPENAI/ANTHROPIC/GOOGLE), deep-extract `brain/corpus/` (diagrams/designs/notes) into the graph.
3. Merge agentic-os + corpus + linked projects → central-graph.json.
4. **Measure + heuristically optimize** (offline learning): computes node/link
   counts, orphan rate, community-size balance, and file size; collapses tiny
   communities into `_misc` for tighter recall; records metrics to `metrics.json`
   and writes what it improved to `learnings.md` (the brain's own memory of
   improvements — compounds each run).
5. Sync to Windows brain (redundant).

Drop sources to learn from in `brain/corpus/{diagrams,designs,notes}/`.
Without an LLM key, corpus files are stored but only become graph nodes via
the semantic (keyed) path — code is always graphed offline.

Hourly cron `agentic-os-brain-rebuild` runs the learn-loop.

## Notes
- `graphify`'s MCP HTTP serve requires the extra: `pip install "graphifyy[mcp]"` (done in the venv).
- The write path for memory is still `brain/*.md` + `audit` + `data/`; graphify reads those, never writes them.
- Rebuild is scheduled hourly by the `agentic-os-brain-rebuild` cron.
- WSL serve is kept alive every 5 min by the `agentic-os-brain-keepalive-wsl` cron (fail-safe; mirrors Windows `keepalive-brain.bat`).
- Two independent brain endpoints exist on :8090 — WSL (this tree) and Windows (`C:\Users\Austin\Brains\central\`). Either can answer if the other is down.
