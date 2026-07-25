// Agent Time Monitor page — total time AI agents spent on the project.
// Data comes from the backend (/api/agent-time), which derives totals
// from event logs via a session-gap estimator. No Mnemoverse widget.

function fmtDuration(seconds) {
  seconds = Math.floor(seconds || 0);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtHMS(seconds) {
  seconds = Math.floor(seconds || 0);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

// Agent accent colors, matching agent-health / known identities.
function agentColor(agent) {
  const map = {
    system: 'var(--purple, #9b8cff)',
    hermes: 'var(--green, #37e0a6)',
    opencode: 'var(--accent, #6c5ce7)',
    gemini: 'var(--yellow, #ffcf5c)',
    codex: '#5b8cff',
    jarvis: '#ff79c6',
    kilocode: '#74b9ff',
    test_claude: '#a29bfe',
    test: '#7f8fa6',
  };
  return map[agent] || 'linear-gradient(90deg, var(--accent), var(--green))';
}

async function renderAgentTime() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h1 class="page-title">Agent Time</h1>
        <p class="page-subtitle">Total time AI agents have spent on this project</p>
      </div>
      <div class="btn-group">
        <button class="btn btn-ghost" onclick="loadAgentTime(false)">↻ Refresh</button>
        <button class="btn btn-primary" onclick="recomputeAgentTime()">⚡ Recompute</button>
      </div>
    </div>
    <div id="agentTimeBody">
      <div class="grid grid-4">
        <div class="card"><div class="skeleton" style="height:90px"></div></div>
        <div class="card"><div class="skeleton" style="height:90px"></div></div>
        <div class="card"><div class="skeleton" style="height:90px"></div></div>
        <div class="card"><div class="skeleton" style="height:90px"></div></div>
      </div>
    </div>
  `;
  await loadAgentTime(false);
}

async function loadAgentTime(recompute) {
  const body = document.getElementById('agentTimeBody');
  try {
    const data = await api.getAgentTime(recompute);
    const agents = data.agents || {};
    const keys = Object.keys(agents);
    const max = Math.max(1, ...keys.map(k => agents[k].total_seconds));
    const sorted = keys.slice().sort((a, b) => agents[b].total_seconds - agents[a].total_seconds);

    const g = data.graph || {};
    const graphCard = g.nodes != null ? `
      <div class="card">
        <div class="card-header"><span class="card-title">Codebase Graph (graphify)</span></div>
        <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:8px">
          <div><div style="font-size:22px;font-weight:700">${g.nodes}</div><div style="font-size:11px;color:var(--text-muted);text-transform:uppercase">nodes</div></div>
          <div><div style="font-size:22px;font-weight:700">${g.edges}</div><div style="font-size:11px;color:var(--text-muted);text-transform:uppercase">edges</div></div>
          <div><div style="font-size:22px;font-weight:700">${g.communities != null ? g.communities : '—'}</div><div style="font-size:11px;color:var(--text-muted);text-transform:uppercase">communities</div></div>
        </div>
        <a class="btn btn-ghost btn-sm mt-3" href="/dashboard/graphify-out/graph.html" target="_blank">↗ Open interactive graph</a>
      </div>` : '';

    body.innerHTML = `
      <div class="grid grid-4">
        <div class="card">
          <div class="card-header"><span class="card-title">Total Agent Time</span></div>
          <div style="font-size:30px;font-weight:800;margin-top:6px">${escapeHtml(data.total_human || '0h 0m 0s')}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:6px">estimated · ${escapeHtml((data.method || '').replace('session-gap estimate ', ''))}</div>
        </div>
        <div class="card">
          <div class="card-header"><span class="card-title">Active Agents</span></div>
          <div style="font-size:30px;font-weight:800;margin-top:6px">${keys.length}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:6px">distinct agents</div>
        </div>
        <div class="card">
          <div class="card-header"><span class="card-title">Logged Events</span></div>
          <div style="font-size:30px;font-weight:800;margin-top:6px">${data.event_count || 0}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:6px">audit + chat + cost</div>
        </div>
        <div class="card">
          <div class="card-header"><span class="card-title">Coverage</span></div>
          <div style="font-size:18px;font-weight:700;margin-top:8px">${(data.first_seen || '—').slice(0, 10)}</div>
          <div style="font-size:13px;color:var(--text-muted)">→ ${(data.last_seen || '—').slice(0, 10)}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px">first → last activity</div>
        </div>
      </div>

      <div class="card mt-4">
        <div class="card-header"><span class="card-title">Time per Agent</span>
          <span style="font-size:11px;color:var(--text-muted)">sessions of activity (30-min gap) + 2-min tail</span></div>
        <div class="table-wrap">
          <table class="agent-table">
            <thead><tr><th>Agent</th><th>Total Time</th><th>Share</th><th class="num">Sessions</th><th class="num">Touches</th></tr></thead>
            <tbody>
              ${sorted.map(k => {
                const a = agents[k];
                const pct = ((a.total_seconds / max) * 100).toFixed(1);
                return `
                  <tr>
                    <td><span style="font-weight:600">${escapeHtml(k)}</span></td>
                    <td><b>${fmtDuration(a.total_seconds)}</b></td>
                    <td style="min-width:140px">
                      <div style="height:8px;border-radius:6px;background:var(--bg-elevated,#0c1320);overflow:hidden">
                        <div style="height:100%;width:0;background:${agentColor(k)};border-radius:6px;transition:width .8s ease-out" data-w="${pct}%"></div>
                      </div>
                    </td>
                    <td class="num">${a.sessions}</td>
                    <td class="num">${a.touches}</td>
                  </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>

      ${graphCard ? `<div class="card mt-4">${graphCard}</div>` : ''}

      <div style="font-size:11px;color:var(--text-muted);margin-top:14px">
        Computed ${escapeHtml((data.generated_at || '').replace('T', ' ').slice(0, 19))} UTC.
        Totals are <b>estimates</b> — the project logs events, not durations; see the method in the report.
      </div>
    `;
    // animate bars
    setTimeout(() => {
      document.querySelectorAll('#agentTimeBody [data-w]').forEach(el => { el.style.width = el.dataset.w; });
    }, 60);
  } catch (err) {
    body.innerHTML = `
      <div class="card">
        <div class="empty-state">
          <div class="empty-state-icon">⚠</div>
          <div class="empty-state-title">Could not load agent-time report</div>
          <div class="empty-state-desc">${escapeHtml(err.message)}</div>
          <button class="btn btn-primary mt-3" onclick="recomputeAgentTime()">Recompute now</button>
        </div>
      </div>`;
  }
}

async function recomputeAgentTime() {
  const body = document.getElementById('agentTimeBody');
  showToast('Recomputing from logs…', 'info');
  try {
    const res = await api.recomputeAgentTime();
    if (res.ok) {
      showToast(`Recomputed: ${res.total_human} across ${res.agents} agents`, 'success');
      await loadAgentTime(false);
    } else {
      showToast('Recompute failed', 'error');
    }
  } catch (err) {
    showToast(`Recompute error: ${err.message}`, 'error');
  }
}
