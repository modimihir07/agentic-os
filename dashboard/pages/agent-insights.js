// Agent Insights — live AI-agent usage analytics.
// Answers: who I chat with most, who spends the most time, who's best
// suited for what, and which models I use per agent. All derived from
// real data via /api/agent-insights.

function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function agentColor(agent) {
  const palette = {
    opencode: '#6c5ce7', hermes: '#00b894', gemini: '#0984e3',
    jarvis: '#fd79a8', kilocode: '#e17055', codex: '#fdcb6e',
    system: '#636e72', test: '#b2bec3',
  };
  return palette[agent] || '#74b9ff';
}

let _charts = {};
function destroyCharts() {
  Object.values(_charts).forEach(c => { try { c.destroy(); } catch (e) {} });
  _charts = {};
}

async function renderAgentInsights() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h1 class="page-title">Agent Insights</h1>
        <p class="page-subtitle">Live analytics on how you actually use your AI agents</p>
      </div>
      <div class="flex gap-2">
        <button class="btn btn-secondary" onclick="renderAgentInsights()">↻ Refresh</button>
        <button class="btn btn-primary" onclick="recomputeAndRenderInsights()">⟳ Recompute time</button>
      </div>
    </div>
    <div id="insightsBody"><div class="loading"><div class="loading-spinner"></div><span>Analyzing agent usage…</span></div></div>
  `;

  let data;
  try {
    data = await api.getAgentInsights();
  } catch (err) {
    document.getElementById('insightsBody').innerHTML = `
      <div class="empty-state"><div class="empty-state-icon">⚠</div>
      <div class="empty-state-title">Could not load insights</div>
      <div class="empty-state-desc">${escapeHtml(err.message)}</div></div>`;
    return;
  }

  const t = data.totals || {};
  const pa = data.per_agent || {};
  const body = document.getElementById('insightsBody');

  body.innerHTML = `
    <div class="grid grid-4 mb-4">
      <div class="card stat-card"><div class="stat-icon purple">💬</div><div class="stat-value">${(t.total_user_turns||0).toLocaleString()}</div><div class="stat-label">Your chat turns</div></div>
      <div class="card stat-card"><div class="stat-icon blue">⏱</div><div class="stat-value">${fmtDuration(t.total_time_seconds)}</div><div class="stat-label">Total agent time</div></div>
      <div class="card stat-card"><div class="stat-icon green">🤖</div><div class="stat-value">${t.agents_observed||0}</div><div class="stat-label">Agents observed</div></div>
      <div class="card stat-card"><div class="stat-icon ${t.total_cost>0?'yellow':'green'}">💰</div><div class="stat-value">$${(t.total_cost||0).toFixed(4)}</div><div class="stat-label">Tracked cost</div></div>
    </div>

    <div class="grid grid-2 mb-4">
      <div class="card">
        <div class="card-header"><span class="card-title">💬 Most chatted-with agents</span></div>
        <div class="chart-container"><canvas id="chatsChart"></canvas></div>
      </div>
      <div class="card">
        <div class="card-header"><span class="card-title">⏱ Agents spending the most time</span></div>
        <div class="chart-container"><canvas id="timeChart"></canvas></div>
      </div>
    </div>

    <div class="card mb-4">
      <div class="card-header"><span class="card-title">🎯 Best suited for (derived from registry + router keywords + roles)</span></div>
      <div id="suiteGrid" class="grid grid-3"></div>
    </div>

    <div class="card mb-4">
      <div class="card-header"><span class="card-title">🧠 Models used per agent</span></div>
      <div id="modelsTable"></div>
    </div>

    <div class="card">
      <div class="card-header"><span class="card-title">📊 Per-agent breakdown</span></div>
      <div id="breakdownTable"></div>
    </div>

    <p class="page-subtitle mt-3" style="font-size:11px;opacity:.6">Generated ${formatDate(data.generated_at)} · data: chat-history, cost-history, agent-time, agent-registry, router-keywords</p>
  `;

  // Charts
  const chats = (data.most_chatted || []).slice(0, 8);
  const times = (data.most_time || []).slice(0, 8);

  _charts.chats = new Chart(document.getElementById('chatsChart'), {
    type: 'bar',
    data: {
      labels: chats.map(c => c.display_name || c.agent),
      datasets: [{
        label: 'Your chat turns',
        data: chats.map(c => c.user_turns),
        backgroundColor: chats.map(c => agentColor(c.agent)),
        borderRadius: 6,
      }],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } },
  });

  _charts.time = new Chart(document.getElementById('timeChart'), {
    type: 'bar',
    data: {
      labels: times.map(c => c.display_name || c.agent),
      datasets: [{
        label: 'Time spent',
        data: times.map(c => Math.round(c.time_seconds / 60)),
        backgroundColor: times.map(c => agentColor(c.agent)),
        borderRadius: 6,
      }],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${ctx.parsed.y} min` } } }, scales: { y: { beginAtZero: true, title: { display: true, text: 'minutes' } } } },
  });

  // Suite cards
  const suiteGrid = document.getElementById('suiteGrid');
  const suiteAgents = Object.values(pa)
    .filter(a => (a.suite && (a.suite.description || a.suite.keywords?.length)))
    .sort((a, b) => (b.user_turns + b.time_seconds / 60) - (a.user_turns + a.time_seconds / 60));
  if (suiteAgents.length === 0) {
    suiteGrid.innerHTML = '<div class="empty-state" style="padding:16px">No role data available yet.</div>';
  } else {
    suiteGrid.innerHTML = suiteAgents.map(a => {
      const s = a.suite || {};
      const kws = (s.keywords || []).slice(0, 8).map(k => `<span class="badge badge-accent" style="font-size:10px;margin:2px">${escapeHtml(k)}</span>`).join('');
      return `
        <div class="card" style="border-left:4px solid ${agentColor(a.agent)}">
          <div class="flex items-center gap-2 mb-2">
            <span class="badge" style="background:${agentColor(a.agent)};color:#fff">${escapeHtml(a.display_name || a.agent)}</span>
            <span style="font-size:11px;color:var(--text-muted)">${a.user_turns} chats · ${fmtDuration(a.time_seconds)}</span>
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">${escapeHtml(s.description || s.role_hint || '—')}</div>
          <div>${kws || '<span style="font-size:11px;opacity:.5">no keywords</span>'}</div>
        </div>`;
    }).join('');
  }

  // Models per agent
  const modelsRows = Object.values(pa)
    .filter(a => a.top_models && a.top_models.length)
    .sort((a, b) => b.tokens - a.tokens);
  document.getElementById('modelsTable').innerHTML = modelsRows.length
    ? `<div class="table-wrapper"><table>
        <thead><tr><th>Agent</th><th>Top models (by uses)</th><th>Tokens</th><th>Cost</th></tr></thead>
        <tbody>${modelsRows.map(a => `
          <tr>
            <td><span class="badge" style="background:${agentColor(a.agent)};color:#fff">${escapeHtml(a.display_name || a.agent)}</span></td>
            <td>${a.top_models.slice(0, 4).map(([m, c]) => `<span class="badge badge-accent" style="font-size:11px;margin:2px">${escapeHtml(m)} <b>×${c}</b></span>`).join(' ')}</td>
            <td>${(a.tokens || 0).toLocaleString()}</td>
            <td>$${(a.cost || 0).toFixed(4)}</td>
          </tr>`).join('')}</tbody>
      </table></div>`
    : '<div class="empty-state" style="padding:16px">No cost/model data recorded yet.</div>';

  // Full breakdown
  const rows = Object.values(pa).sort((a, b) => b.user_turns - a.user_turns);
  document.getElementById('breakdownTable').innerHTML = `
    <div class="table-wrapper"><table>
      <thead><tr><th>Agent</th><th>Chat turns</th><th>Msgs</th><th>Time</th><th>Sessions</th><th>Top model</th><th>First seen</th><th>Last seen</th></tr></thead>
      <tbody>${rows.map(a => `
        <tr>
          <td><span class="badge" style="background:${agentColor(a.agent)};color:#fff">${escapeHtml(a.display_name || a.agent)}</span></td>
          <td><b>${a.user_turns}</b></td>
          <td>${a.chat_messages}</td>
          <td>${fmtDuration(a.time_seconds)}</td>
          <td>${a.sessions}</td>
          <td>${a.top_models && a.top_models.length ? escapeHtml(a.top_models[0][0]) : '—'}</td>
          <td style="font-size:11px">${a.first_seen ? formatDate(a.first_seen) : '—'}</td>
          <td style="font-size:11px">${a.last_seen ? formatDate(a.last_seen) : '—'}</td>
        </tr>`).join('')}</tbody>
    </table></div>`;
}

async function recomputeAndRenderInsights() {
  try { await api.recomputeAgentTime(); } catch (e) {}
  await renderAgentInsights();
}
