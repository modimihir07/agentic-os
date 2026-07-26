# Central Brain — Graphify knowledge graph

One central, queryable brain that project graphs roll up into.

## Topology
- `agentic-os.json` — this project's own code graph (built from `graphify . --code-only`).
- `projects/<name>.json` — each linked project's graph (registered via `link-project.sh`).
- `central-graph.json` — the MERGED cross-repo brain (union of all the above). This is the artifact everything queries.
- `serve-brain.sh` — serves `central-graph.json` over HTTP MCP at `http://127.0.0.1:8090/mcp`.
- Dashboard: the brain directory is mounted at `http://127.0.0.1:8080/brain-graph/`.

## Commands
```
bash brain/graph/build-central.sh            # rebuild central brain (code graph + merge linked projects)
bash brain/graph/link-project.sh <name> <graph.json>   # register a project's graph into the brain
bash brain/graph/serve-brain.sh             # serve central brain over HTTP MCP (:8090)
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
