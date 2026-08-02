"""Standalone 2D Agentic-OS brain viewer.

Run: . venv/bin/activate && python3 regen_graph_html_standalone.py
Then open: http://127.0.0.1:8080/graphify-out/graph-standalone.html
"""
from pathlib import Path
import json
from collections import Counter

ROOT = Path(__file__).resolve().parent
GRAPH_JSON = ROOT / "brain" / "graph" / "agentic-os.json"
OUT = ROOT / "graphify-out" / "graph-standalone.html"

data = json.loads(GRAPH_JSON.read_text(encoding="utf-8"))
nodes = data.get("nodes", [])
links = data.get("links", [])

# Count top communities for legend
community_counter = Counter()
for n in nodes:
    cn = (n.get("community_name") or n.get("community") or "").strip()
    if cn:
        community_counter[cn] += 1
top_communities = [cn for cn, _ in community_counter.most_common(25)]

PALETTE = [
    "#E15759", "#4E79A7", "#F28E2B", "#76B7B2",
    "#59A14F", "#EDC948", "#B07AA1", "#FF9DA7",
    "#9C755F", "#BAB0AC", "#86BCB6", "#8CD17D",
    "#B6992D", "#499894", "#D37295", "#F1CE63",
    "#D4A6C8",
]

def community_color(name: str, index: int) -> str:
    import hashlib
    h = hashlib.md5(name.encode("utf-8")).hexdigest()
    return PALETTE[int(h, 16) % len(PALETTE)]

community_color_map = {cn: community_color(cn, i) for i, cn in enumerate(top_communities)}

# Degree map
degree = {}
for link in links:
    for key in ("source", "from", "target", "to"):
        if key in link and link[key] is not None:
            degree[link[key]] = degree.get(link[key], 0) + 1
            break

for n in nodes:
    nid = n.get("id") or n.get("name")
    n["__degree__"] = degree.get(nid, 0)

# Escape for HTML attribute
import html as html_mod
esc = html_mod.escape

legend_items = []
for cn in top_communities:
    color = community_color_map[cn]
    legend_items.append(
        f'<span class="legend-dot" style="background:{esc(color)}"></span>'
        f'<span class="legend-label">{esc(cn)}</span>'
    )

legend_html = "\n".join(
    f'<div class="legend-item" data-community="{esc(cn)}">{item}</div>'
    for cn, item in zip(top_communities, legend_items)
)

html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Agentic-OS Brain</title>
<script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"
        crossorigin="anonymous"></script>
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  html, body {{ height: 100%; background: #07080d; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
  #mynetwork {{ position: fixed; inset: 0; }}
  #sidebar {{
    position: fixed; top: 0; right: 0; width: 300px; height: 100%; background: rgba(12,13,20,0.94);
    border-left: 1px solid #252540; display: flex; flex-direction: column; z-index: 10;
    backdrop-filter: blur(10px);
  }}
  #search-wrap {{ padding: 14px; border-bottom: 1px solid #252540; }}
  #search {{
    width: 100%; background: #0d0e16; border: 1px solid #353555; color: #e0e0e0;
    padding: 8px 10px; border-radius: 6px; font-size: 13px; outline: none;
  }}
  #search:focus {{ border-color: #4E79A7; }}
  #search-results {{ max-height: 180px; overflow-y: auto; padding: 6px 0; display: none; }}
  .search-item {{ padding: 6px 14px; cursor: pointer; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }}
  .search-item:hover {{ background: #252540; }}
  #info-panel {{ padding: 16px; border-bottom: 1px solid #252540; min-height: 150px; }}
  #info-panel h3 {{ font-size: 11px; color: #777; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.1em; }}
  #info-content {{ font-size: 12px; color: #bbb; line-height: 1.6; }}
  .field {{ margin-bottom: 5px; }} .field b {{ color: #eee; }}
  .empty {{ color: #555; font-style: italic; }}
  #legend-wrap {{ flex: 1; overflow-y: auto; padding: 14px; }}
  #legend-wrap h3 {{ font-size: 11px; color: #777; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.1em; }}
  .legend-item {{ display: flex; align-items: center; gap: 8px; padding: 5px 4px; cursor: pointer; border-radius: 4px; font-size: 11px; }}
  .legend-item:hover {{ background: #252540; }}
  .legend-item.dimmed {{ opacity: 0.25; }}
  .legend-dot {{ width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; }}
  .legend-label {{ flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }}
  #stats {{ padding: 12px 14px; border-top: 1px solid #252540; font-size: 11px; color: #666; }}
  .controls {{ padding: 12px 14px; border-bottom: 1px solid #252540; }}
  .controls label {{ display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 12px; color: #aaa; }}
</style>
</head>
<body>
<div id="mynetwork"></div>
<div id="sidebar">
  <div id="search-wrap">
    <input id="search" type="text" placeholder="Search nodes..." autocomplete="off">
    <div id="search-results"></div>
  </div>
  <div class="controls">
    <label><input type="checkbox" id="stabilize" checked> Stabilize layout</label>
  </div>
  <div id="info-panel">
    <h3>Node Info</h3>
    <div id="info-content"><span class="empty">Click a node to inspect it</span></div>
  </div>
  <div id="legend-wrap">
    <h3>Top Communities</h3>
    <div id="legend">{legend_html}</div>
  </div>
  <div id="stats">{len(nodes)} nodes · {len(links)} edges · {len(top_communities)} communities shown</div>
</div>
<script>
const RAW_NODES = {json.dumps(nodes, ensure_ascii=False)};
const RAW_LINKS = {json.dumps(links, ensure_ascii=False)};
const PALETTE = {json.dumps(PALETTE)};

function esc(s) {{
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}}

RAW_NODES.forEach(n => {{
  n.color = community_color_map[n.community_name || n.community || ""] || "#4E79A7";
  var d = n.__degree__ || 0;
  n.size = Math.max(6, Math.min(6 + Math.min(d, 20) * 1.4, 28));
}});

function community_color(name) {{
  if (!name) return "#4E79A7";
  if (community_color_map[name]) return community_color_map[name];
  import_hashes = [];
  for (let i = 0; i < name.length; i++) import_hashes.push(name.charCodeAt(i));
  var h = 0;
  for (let i = 0; i < import_hashes.length; i++) h = (h << 5) - h + import_hashes[i];
  return PALETTE[Math.abs(h) % PALETTE.length];
}}

function updateInfo(node) {{
  const fields = [
    ['id', node.id],
    ['label', node.label],
    ['type', node.type],
    ['community', node.community_name || node.community],
    ['source', node.source_file],
    ['location', node.source_location],
    ['degree', node.__degree__],
  ].filter(function(x) {{ return x[1] != null && x[1] !== ''; }});
  document.getElementById('info-content').innerHTML = fields.map(function(f) {{
    return '<div class="field"><b>' + esc(f[0]) + ':</b> ' + esc(String(f[1])) + '</div>';
  }}).join('');
}}

function wireSearch(net) {{
  const searchInput = document.getElementById('search');
  const searchResults = document.getElementById('search-results');
  searchInput.addEventListener('input', function() {{
    const q = searchInput.value.trim().toLowerCase();
    searchResults.style.display = 'none';
    if (!q) return;
    const matches = RAW_NODES.filter(function(n) {{
      return (n.label || '').toLowerCase().includes(q) || (n.id || '').toLowerCase().includes(q);
    }}).slice(0, 40);
    searchResults.innerHTML = matches.map(function(n, i) {{
      return '<div class="search-item" data-idx="' + i + '">' + esc(n.label || n.id) + '</div>';
    }}).join('');
    searchResults.style.display = matches.length ? 'block' : 'none';
  }});
  searchResults.addEventListener('click', function(e) {{
    const item = e.target.closest('.search-item');
    if (!item) return;
    const idx = parseInt(item.getAttribute('data-idx'), 10);
    const q = searchInput.value.trim().toLowerCase();
    const match = RAW_NODES.find(function(n) {{
      return (n.label || '').toLowerCase().includes(q) || (n.id || '').toLowerCase().includes(q);
    }});
    if (match) {{
      net.focus(match.id, {{ scale: 2.5, animation: true }});
    }}
  }});
}}

function wireLegend(net) {{
  document.querySelectorAll('.legend-item').forEach(function(el) {{
    el.addEventListener('click', function() {{
      const cn = el.getAttribute('data-community');
      el.classList.toggle('dimmed');
      const active = !el.classList.contains('dimmed');
      const val = active ? 1 : 0.05;
      net.setOptions({{ nodes: {{ opacity: function(opts, id) {{
        var n = RAW_NODES.find(function(x) {{ return x.id === id; }});
        if (!n) return val;
        var cc = n.community_name || n.community || "";
        return cc === cn ? 1 : 0.05;
      }} }} }});
    }});
  }});
}}

function initGraph() {{
  var visNodes = new vis.DataSet(RAW_NODES.map(function(n) {{
    return {{
      id: n.id,
      label: n.label || n.id,
      title: [n.id, n.label, n.type, n.source_file].filter(Boolean).join('\\n'),
      color: {{ background: n.color || '#4E79A7', border: n.color || '#4E79A7', highlight: {{ background: '#ffffff', border: '#ffffff' }} }},
      size: n.size || 8,
      font: {{ color: '#e0e0e0', size: 10, face: 'Inter, -apple-system, sans-serif' }},
      borderWidth: 1,
      shadow: {{ enabled: true, color: n.color || '#4E79A7', size: 8 }}
    }};
  }}));

  var visEdges = new vis.DataSet(RAW_LINKS.map(function(l) {{
    return {{ from: l.source || l.from, to: l.target || l.to }};
  }}));

  var container = document.getElementById('mynetwork');
  var options = {{
    background: {{ color: '#07080d' }},
    nodes: {{
      shape: 'dot',
      scaling: {{ min: 6, max: 28 }},
      font: {{ color: '#e0e0e0', size: 10, face: 'Inter, sans-serif' }}
    }},
    edges: {{
      color: {{ color: 'rgba(255,255,255,0.055)', highlight: 'rgba(255,255,255,0.3)', hover: 'rgba(255,255,255,0.2)' }},
      smooth: {{ type: 'continuous', forceDirection: 'none', roundness: 0.4 }},
      width: 0.5,
      selectionWidth: 1.2
    }},
    physics: {{
      stabilization: true,
      stabilization.fit: true,
      stabilization.iterations: 220,
      barnesHut: {{
        gravitationalConstant: -4800,
        centralGravity: 0.12,
        springLength: 180,
        springConstant: 0.035,
        damping: 0.35,
        avoidOverlap: 0.15
      }},
      solver: 'barnesHut'
    }},
    interaction: {{
      hover: true,
      tooltipDelay: 100,
      hideEdgesOnDrag: true,
      navigationButtons: false,
      keyboard: {{ enabled: true }}
    }}
  }};

  var net = new vis.Network(container, {{ nodes: visNodes, edges: visEdges }}, options);

  wireSearch(net);
  wireLegend(net);

  net.on('click', function(params) {{
    if (params.nodes.length) {{
      var nid = params.nodes[0];
      var raw = RAW_NODES.find(function(x) {{ return x.id === nid; }});
      if (raw) updateInfo(raw);
    }}
  }});

  window.__brainNet = net;
}}

setTimeout(initGraph, 60);
</script>
</body>
</html>
"""

OUT.write_text(html, encoding="utf-8")
print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
