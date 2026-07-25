# Agentic-OS memory layer + Graphify — honest status

## Can Graphify BE the memory layer?
**Partially, and not as a replacement for the write path.**

What Graphify is: a tool that turns a *codebase* into a knowledge graph
(nodes = code symbols/modules, edges = relationships) and lets you
visualize / query it. It is a **read/visualize/query layer over your
files** — it does NOT store or write memory. The OS's actual
memory write path stays `brain/memory.md`, `append_audit()`,
`data/*.json`, etc.

## What we verified (2026-07-25)
- `graphify . --code-only` over the whole project → **321 nodes, 517
  edges, 41 communities** (graphify-out/graph.json + graph.html).
  This graphs the *code* (server.py, skills' .py, etc.).
- `graphify brain skills --code-only` → **0 nodes**. The memory
  folders are almost entirely **Markdown**, which `--code-only`
  skips. So the memory *content* is invisible to a code-only build.
- To graph the *memory docs* (markdown notes), Graphify needs an
  LLM key for semantic extraction (GEMINI_API_KEY / GOOGLE_API_KEY
  / ANTHROPIC_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY /
  MOONSHOT_API_KEY). With a key:
  `graphify brain skills` (no --code-only) will build a graph that
  includes your notes as nodes. Without a key it errors out.

## Recommended setup (works today, upgrades with a key)
1. Build the code graph (no key needed):
     cd ~/agentic-os && graphify . --code-only
   → live in the dashboard at http://localhost:8080/graphify-out/graph.html
     and the "Agent Time" page's "Open interactive graph" link.
2. (Optional, with a key) Build the memory-inclusive graph:
     export GEMINI_API_KEY=...
     graphify brain skills data            # docs + code, semantic
   This adds your memory notes as queryable nodes.
3. Expose it to the OS agents as a query tool (MCP or HTTP):
     # HTTP (team/shared):
     python -m graphify.serve graphify-out/graph.json --transport http --port 8081
     # or stdio MCP for a single agent:
     python -m graphify.serve graphify-out/graph.json
   Then point the agent/MCP client at it. Agents can ASK the graph
   ("what connects memory-consolidation to audit?", "show the
   agentic-os data flow") — a retrieval aid, not a memory writer.

## Bottom line
- ✅ Use Graphify as a **visualization + semantic-query layer** for the
  OS's memory/code. Great for "what's in my brain and how does it
  connect."
- ❌ Do NOT treat it as the memory store. Writing memory still goes
  through the existing `brain/` + `audit` + `data/` files. Graphify
  reads those; it never writes them.
- ⚠️ Memory-note graphing requires an LLM key; code graphing does not.

## Files
- graphify-out/        — built code graph (graph.json, graph.html, GRAPH_REPORT.md)
- scripts/analyze_agent_time.py — agent-time estimator (the dashboard's data source)
- dashboard/.../agent-time.js    — integrated "Agent Time" page (port 8080)
- dashboard/serve_monitor.py      — standalone monitor (kept, unused by integration)
