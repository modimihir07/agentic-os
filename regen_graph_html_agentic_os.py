"""Regenerate graphify-out/graph.html with a real 3D viewer,
falling back to 2D vis-network if Three.js renders nothing.

Run:  . venv/bin/activate && python3 regen_graph_html_3d.py
"""
from pathlib import Path
import json

ROOT = Path(__file__).resolve().parent
GRAPH_JSON = ROOT / "brain" / "graph" / "agentic-os.json"
OUT = ROOT / "graphify-out" / "graph-agentic-os.html"

data = json.loads(GRAPH_JSON.read_text(encoding="utf-8"))
nodes = data.get("nodes", [])
links = data.get("links", [])


def esc(s: str) -> str:
    return (
        str(s)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )

degree = {}
for link in links:
    for key in ("source", "from", "target", "to"):
        if key in link and link[key] is not None:
            degree[link[key]] = degree.get(link[key], 0) + 1
            break

for n in nodes:
    nid = n.get("id") or n.get("name")
    n["__degree__"] = degree.get(nid, 0)

RAW_NODES = json.dumps(nodes, ensure_ascii=False)
RAW_LINKS = json.dumps(links, ensure_ascii=False)

PALETTE = [
    "#E15759", "#4E79A7", "#F28E2B", "#76B7B2",
    "#59A14F", "#EDC948", "#B07AA1", "#FF9DA7",
    "#9C755F", "#BAB0AC", "#86BCB6", "#8CD17D",
    "#B6992D", "#499894", "#D37295", "#F1CE63",
    "#D4A6C8",
]

seen_communities = []
for n in nodes:
    cn = (n.get("community_name") or n.get("community") or "").strip()
    if cn and cn not in seen_communities:
        seen_communities.append(cn)


def community_color(name: str, index: int) -> str:
    if not name:
        return PALETTE[index % len(PALETTE)]
    import hashlib
    h = hashlib.md5(name.encode("utf-8")).hexdigest()
    return PALETTE[int(h, 16) % len(PALETTE)]


legend_items = []
for idx, cn in enumerate(seen_communities):
    color = community_color(cn, idx)
    legend_items.append(
        '<span class="legend-dot" style="background:%s"></span>'
        '<span class="legend-label">%s</span>' % (color, esc(cn))
    )

legend_html = "\n".join(
    '<div class="legend-item" data-community="%s">%s</div>' % (esc(cn), item)
    for cn, item in zip(seen_communities, legend_items)
)

html = """\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>graphify - Agentic-OS brain</title>
<script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js" crossorigin="anonymous"></script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; background: #0b0c10; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  #graph { position: fixed; inset: 0; background: #0b0c10; }
  #sidebar {
    position: fixed; top: 0; right: 0; width: 300px; height: 100%; background: rgba(15,15,26,0.92);
    border-left: 1px solid #2a2a4e; display: flex; flex-direction: column;
    backdrop-filter: blur(8px); z-index: 10;
  }
  #search-wrap { padding: 14px; border-bottom: 1px solid #2a2a4e; }
  #search {
    width: 100%; background: #0f0f1a; border: 1px solid #3a3a5e; color: #e0e0e0;
    padding: 8px 10px; border-radius: 6px; font-size: 13px; outline: none;
  }
  #search:focus { border-color: #4E79A7; }
  #search-results { max-height: 160px; overflow-y: auto; padding: 6px 0; display: none; }
  .search-item { padding: 6px 14px; cursor: pointer; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .search-item:hover { background: #2a2a4e; }
  #info-panel { padding: 16px; border-bottom: 1px solid #2a2a4e; min-height: 150px; }
  #info-panel h3 { font-size: 12px; color: #888; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.08em; }
  #info-content { font-size: 13px; color: #ccc; line-height: 1.55; }
  .field { margin-bottom: 5px; } .field b { color: #eee; }
  .empty { color: #555; font-style: italic; }
  #legend-wrap { flex: 1; overflow-y: auto; padding: 14px; }
  #legend-wrap h3 { font-size: 12px; color: #888; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.08em; }
  .legend-item { display: flex; align-items: center; gap: 8px; padding: 5px 4px; cursor: pointer; border-radius: 4px; font-size: 12px; }
  .legend-item:hover { background: #2a2a4e; }
  .legend-item.dimmed { opacity: 0.3; }
  .legend-dot { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; }
  .legend-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #stats { padding: 12px 14px; border-top: 1px solid #2a2a4e; font-size: 11px; color: #666; }
  .controls { padding: 10px 14px; border-bottom: 1px solid #2a2a4e; font-size: 11px; color: #aaa; }
  .controls label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
  .badge { position: fixed; top: 12px; left: 12px; background: #F28E2B; color: #000; padding: 6px 10px; border-radius: 6px; font-size: 12px; font-weight: 700; z-index: 20; display: none; }
</style>
</head>
<body>
<div id="graph"></div>
<div id="sidebar">
  <div id="search-wrap">
    <input id="search" type="text" placeholder="Search nodes..." autocomplete="off">
    <div id="search-results"></div>
  </div>
  <div class="controls">
    <label><input type="checkbox" id="landing-toggle" checked> Stabilize layout</label>
  </div>
  <div id="info-panel">
    <h3>Node Info</h3>
    <div id="info-content"><span class="empty">Click a node to inspect it</span></div>
  </div>
  <div id="legend-wrap">
    <h3>Communities</h3>
    <div id="legend">
""" + legend_html + """\
    </div>
  </div>
  <div id="stats">""" + str(len(nodes)) + """ nodes &middot; """ + str(len(links)) + """ edges</div>
</div>
<script>
const RAW_NODES = """ + RAW_NODES + """;
const RAW_LINKS = """ + RAW_LINKS + """;
const PALETTE = """ + json.dumps(PALETTE) + """;
const seen = [];
function communityIndex(name) {
  if (!name) return 0;
  let i = seen.indexOf(name);
  if (i === -1) { seen.push(name); i = seen.length - 1; }
  return i;
}
function communityColor(name) {
  const i = communityIndex(name);
  return PALETTE[i % PALETTE.length];
}
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

RAW_NODES.forEach(n => {
  const c = n.community_name || n.community || "";
  n.color = communityColor(c);
  n.size = Math.max(1.2, (n.__degree__ || 0) * 0.6 + 2);
});

function updateInfo(node) {
  const fields = [
    ['id', node.id],
    ['label', node.label],
    ['type', node.type],
    ['community', node.community_name || node.community],
    ['source', node.source_file],
    ['location', node.source_location],
    ['degree', node.__degree__],
  ].filter(function(x) { return x[1] != null && x[1] !== ''; });
  document.getElementById('info-content').innerHTML = fields.map(function(f) { return '<div class="field"><b>' + esc(f[0]) + ':</b> ' + esc(String(f[1])) + '</div>'; }).join('');
}

function wireSearch(GraphInst) {
  const searchInput = document.getElementById('search');
  const searchResults = document.getElementById('search-results');
  searchInput.addEventListener('input', function() {
    const q = searchInput.value.trim().toLowerCase();
    searchResults.style.display = 'none';
    if (!q) return;
    const matches = RAW_NODES.filter(function(n) {
      return (n.label || '').toLowerCase().includes(q) || (n.id || '').toLowerCase().includes(q);
    }).slice(0, 40);
    searchResults.innerHTML = matches.map(function(n, i) { return '<div class="search-item" data-idx="' + i + '">' + esc(n.label || n.id) + '</div>'; }).join('');
    searchResults.style.display = matches.length ? 'block' : 'none';
  });
  searchResults.addEventListener('click', function(e) {
    const item = e.target.closest('.search-item');
    if (!item) return;
    const idx = parseInt(item.getAttribute('data-idx'), 10);
    const q = searchInput.value.trim().toLowerCase();
    const match = RAW_NODES.find(function(n) {
      return (n.label || '').toLowerCase().includes(q) || (n.id || '').toLowerCase().includes(q);
    });
    if (match) {
      if (GraphInst && typeof GraphInst.centerAt === 'function') {
        GraphInst.centerAt(match.x || 0, match.y || 0, match.z || 0, 1000);
        GraphInst.zoom(4, 1000);
      }
    }
  });
}

function wireLegend(GraphInst) {
  document.querySelectorAll('.legend-item').forEach(function(el) {
    el.addEventListener('click', function() {
      const cn = el.getAttribute('data-community');
      el.classList.toggle('dimmed');
      const active = !el.classList.contains('dimmed');
      if (GraphInst && typeof GraphInst.nodeOpacity === 'function') {
        GraphInst.nodeOpacity(function(n) {
          const cc = n.community_name || n.community || '';
          return cc === cn ? (active ? 1 : 0.05) : (active ? 0.05 : 1);
        });
      }
    });
  });
}

function showFallback() {
  document.getElementById('graph').style.display = 'none';
  document.getElementById('graph2d').style.display = 'block';
  document.getElementById('fallback-badge').style.display = 'block';
}

function checkRender() {
  try {
    const canvas = container.querySelector('canvas');
    if (!canvas) {
      if (performance.now() - start < 2000) setTimeout(checkRender, 250);
      else showFallback();
      return;
    }
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) {
      showFallback();
      return;
    }
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    if (/SwiftShader|llvmpipe|Software/.test(renderer)) {
      showFallback();
      return;
    }
  } catch (e) {
    showFallback();
    return;
  }
}

var Graph = null;
try {
  Graph = ForceGraph3D()(container)
    .graphData({ nodes: RAW_NODES, links: RAW_LINKS })
    .backgroundColor('#0b0c10')
    .nodeColor(function(n) { return n.color || '#4E79A7'; })
    .nodeLabel('')
    .linkWidth(0.6)
    .linkColor(function() { return 'rgba(255,255,255,0.08)'; })
    .linkOpacity(0.35)
    .onNodeClick(function(node) { updateInfo(node); })
    .cameraPosition({ x: 0, y: 0, z: 420 })
    .d3AlphaDecay(0.02)
    .d3VelocityDecay(0.25);
} catch (e) {
  showFallback();
}

setTimeout(function() {
  var landing = document.getElementById('landing-toggle');
  if (landing) {
    landing.addEventListener('change', function(e) {
      if (!Graph) return;
      Graph.d3AlphaDecay(e.target.checked ? 0.02 : 0);
    });
  }
  init2D();
}, 50);

function init2D() {
  var el = document.getElementById('graph2d');
  var visNodes = new vis.DataSet(RAW_NODES.map(function(n) {
    var deg = n.__degree__ || 0;
    var size = 6 + Math.min(deg, 20) * 1.4;
    size = Math.max(6, Math.min(size, 32));
    return {
      id: n.id, label: n.label || n.id,
      title: [n.id, n.label, n.type, n.source_file, n.community_name || n.community].filter(Boolean).join('\n'),
      color: {
        background: n.color || '#4E79A7',
        border: n.color || '#4E79A7',
        highlight: { background: '#ffffff', border: '#ffffff' }
      },
      size: size,
      font: { color: '#e0e0e0', size: 10, face: 'Inter, -apple-system, sans-serif' },
      borderWidth: 1,
      shadow: { enabled: true, color: n.color || '#4E79A7', size: 6 }
    };
  })));
  var visLinks = new vis.DataSet(RAW_LINKS.map(function(l) {
    return { from: l.source || l.from, to: l.target || l.to };
  }));
  var options = {
    background: { color: '#0b0c10' },
    nodes: {
      shape: 'dot',
      scaling: { min: 6, max: 32 },
      font: { color: '#e0e0e0', size: 10, face: 'Inter, -apple-system, sans-serif' }
    },
    edges: {
      color: { color: 'rgba(255,255,255,0.07)', highlight: 'rgba(255,255,255,0.35)' },
      smooth: { type: 'continuous', forceDirection: 'none' },
      width: 0.6,
      selectionWidth: 1.2
    },
    physics: {
      stabilization: true,
      stabilization.fit: true,
      stabilization.iterations: 180,
      stabilization.updateInterval: 25,
      barnesHut: {
        gravitationalConstant: -4200,
        centralGravity: 0.15,
        springLength: 170,
        springConstant: 0.04,
        damping: 0.35,
        avoidOverlap: 0.12
      },
      solver: 'barnesHut'
    },
    interaction: {
      hover: true,
      tooltipDelay: 120,
      navigationButtons: false,
      keyboard: { enabled: true }
    }
  };
  var net = new vis.Network(el, { nodes: visNodes, edges: visLinks }, options);
  window.twoDGraphInstance = net;
  net.on('click', function(params) {
    if (params.nodes.length) {
      var nid = params.nodes[0];
      var raw = RAW_NODES.find(function(x) { return x.id === nid; });
      updateInfo(raw || { id: nid });
    }
  });
  wireSearch(net);
  wireLegend(net);
}
</script>
</body>
</html>
"""

OUT.write_text(html, encoding="utf-8")
print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
