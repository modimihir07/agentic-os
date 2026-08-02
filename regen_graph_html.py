"""Regenerate graphify-out/graph.html from the existing graph.json.

graphify's normal build writes both graph.json and the interactive
graph.html viewer, but only graph.json was committed here (the
Agent Time page links to /dashboard/graphify-out/graph.html, which 404s).
This reuses graphify's own exporters.html.to_html on the already
built graph.json so the viewer actually exists.

Run:  . venv/bin/activate && python3 regen_graph_html.py
"""
from pathlib import Path
import json
import networkx as nx
from graphify.exporters.html import to_html

ROOT = Path(__file__).resolve().parent
GRAPH_JSON = ROOT / "graphify-out" / "graph.json"
OUT = ROOT / "graphify-out" / "graph.html"

data = json.loads(GRAPH_JSON.read_text())
nodes = data.get("nodes", [])
links = data.get("links", [])

G = nx.Graph()
for n in nodes:
    nid = n.get("id") or n.get("name")
    if nid is None:
        continue
    attrs = {k: v for k, v in n.items() if k not in ("id", "name")}
    G.add_node(nid, **attrs)

for e in links:
    s = e.get("source") or e.get("from")
    t = e.get("target") or e.get("to")
    if s is None or t is None:
        continue
    eattrs = {k: v for k, v in e.items() if k not in ("source", "target", "from", "to")}
    G.add_edge(s, t, **eattrs)

print(f"graph: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges")

# Real communities so the aggregated fallback (used when node count is high)
# has something valid to render instead of skipping.
try:
    import networkx.algorithms.community as nxcomm
    comm_list = nxcomm.greedy_modularity_communities(G)
    communities = {i: list(c) for i, c in enumerate(comm_list)}
except Exception as ex:
    print(f"community detection failed ({ex}); using single community")
    communities = {0: list(G.nodes())}

to_html(G, communities, str(OUT), node_limit=4000)
print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
