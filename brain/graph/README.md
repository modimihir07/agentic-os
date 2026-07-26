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
```
Set `CENTRAL_BRAIN_PORT` to override the serve port (default 8090).

## What it contains today
- Code symbols of agentic-os as nodes (functions/classes/modules), with call/import edges.
- Linked projects (added via `link-project.sh`).
- Memory NOTES (markdown under `brain/`) are NOT yet graph nodes. To make them
  queryable, set an LLM key (GEMINI_API_KEY / OPENAI_API_KEY / etc.) and run
  `graphify .` (no `--code-only`) so notes are semantically extracted. Until
  then, notes remain the write path; the graph indexes code structure.

## Notes
- `graphify`'s MCP HTTP serve requires the extra: `pip install "graphifyy[mcp]"` (done in the venv).
- The write path for memory is still `brain/*.md` + `audit` + `data/`; graphify reads those, never writes them.
- Rebuild is scheduled hourly by the `agentic-os-brain-rebuild` cron.
