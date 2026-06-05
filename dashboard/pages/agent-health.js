let agentHealthInterval = null;

async function renderAgentHealth() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <div class="page-title">Agent Health</div>
        <div class="page-subtitle">Real-time monitoring of all 3 agents</div>
      </div>
      <div class="btn-group">
        <label class="switch" title="Auto-refresh every 5s">
          <input type="checkbox" id="healthAutoRefresh" checked onchange="toggleHealthAutoRefresh()">
          <span class="switch-slider"></span>
        </label>
        <span class="text-sm text-muted">Auto</span>
        <button class="btn btn-primary" onclick="refreshAgentHealth()">🔄 Refresh Now</button>
      </div>
    </div>
    <div id="agentHealthCards" class="grid grid-3" style="margin-bottom:20px">
      <div class="skeleton" style="height:180px"></div>
      <div class="skeleton" style="height:180px"></div>
      <div class="skeleton" style="height:180px"></div>
    </div>
    <div class="section-title">Health Overview</div>
    <div class="card" id="healthOverviewCard">
      <div class="loading"><div class="loading-spinner"></div><span>Loading health data...</span></div>
    </div>
  `;
  await refreshAgentHealth();
  if (document.getElementById('healthAutoRefresh')?.checked) {
    startHealthAutoRefresh();
  }
}

function startHealthAutoRefresh() {
  stopHealthAutoRefresh();
  agentHealthInterval = setInterval(refreshAgentHealth, 5000);
}

function stopHealthAutoRefresh() {
  if (agentHealthInterval) {
    clearInterval(agentHealthInterval);
    agentHealthInterval = null;
  }
}

function toggleHealthAutoRefresh() {
  if (document.getElementById('healthAutoRefresh')?.checked) {
    startHealthAutoRefresh();
  } else {
    stopHealthAutoRefresh();
  }
}

async function refreshAgentHealth() {
  try {
    const data = await api.getAgentHealth();
    const agents = data.agents || [];
    const cards = document.getElementById('agentHealthCards');
    if (!cards) return;
    const agentIcons = { opencode: '🔧', hermes: '⚡', gemini: '🧠' };
    const agentColors = { opencode: 'purple', hermes: 'green', gemini: 'blue' };
    cards.innerHTML = agents.map(a => `
      <div class="agent-health-card">
        <div class="agent-health-avatar" style="background:var(--${agentColors[a.name] || 'accent'}-dim);color:var(--${agentColors[a.name] || 'accent'})">
          ${agentIcons[a.name] || '🤖'}
        </div>
        <div class="agent-health-info">
          <div class="agent-health-name" style="text-transform:capitalize">${a.name}</div>
          <div class="agent-health-status">
            <span class="agent-dot ${a.status === 'online' ? 'online' : a.status === 'warning' ? 'warning' : 'offline'}"></span>
            <span style="text-transform:capitalize;color:var(--text-secondary)">${a.status}</span>
          </div>
          <div class="agent-health-stats">
            <div class="agent-health-stat">
              <div class="agent-health-stat-value" style="color:var(--green)">${a.status === 'online' ? '100' : '0'}%</div>
              <div class="agent-health-stat-label">Uptime</div>
            </div>
            <div class="agent-health-stat">
              <div class="agent-health-stat-value" style="color:var(--accent-light)">${a.status === 'online' ? '✓' : '✗'}</div>
              <div class="agent-health-stat-label">Reachable</div>
            </div>
            <div class="agent-health-stat">
              <div class="agent-health-stat-value text-sm" style="font-size:11px;color:var(--text-muted)">${new Date(data.updated).toLocaleTimeString()}</div>
              <div class="agent-health-stat-label">Last Check</div>
            </div>
          </div>
        </div>
      </div>
    `).join('');
    const overview = document.getElementById('healthOverviewCard');
    if (overview) {
      const online = agents.filter(a => a.status === 'online').length;
      const total = agents.length;
      overview.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div>
            <div style="font-size:14px;font-weight:600">System Status</div>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:4px">
              ${online}/${total} agents online · Last updated: ${new Date(data.updated).toLocaleTimeString()}
            </div>
          </div>
          <div class="status-indicator ${online === total ? 'online' : online > 0 ? 'warning' : 'offline'}">
            <span class="agent-dot ${online === total ? 'online' : online > 0 ? 'warning' : 'offline'}"></span>
            ${online === total ? 'All Online' : online > 0 ? 'Partial' : 'Offline'}
          </div>
        </div>
      `;
    }
  } catch (err) {
    const cards = document.getElementById('agentHealthCards');
    if (cards) cards.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-state-icon">⚠</div><div class="empty-state-title">Failed to load health data</div><div class="empty-state-desc">${escapeHtml(err.message)}</div></div>`;
  }
}
