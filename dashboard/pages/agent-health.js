async function renderAgentHealth() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h1 class="page-title">Agent Health</h1>
        <p class="page-subtitle">Monitor and manage all connected agents</p>
      </div>
      <div class="btn-group">
        <button class="btn btn-ghost" onclick="loadAgents()">↻ Refresh</button>
        <button class="btn btn-primary" onclick="showAddAgentModal()">+ Add Agent</button>
      </div>
    </div>
    <div id="agentCards" class="grid grid-3">
      <div class="card"><div class="skeleton" style="height:120px"></div></div>
      <div class="card"><div class="skeleton" style="height:120px"></div></div>
      <div class="card"><div class="skeleton" style="height:120px"></div></div>
    </div>
    <div class="card mt-4">
      <div class="card-header"><span class="card-title">Agent Registry</span></div>
      <div id="agentTable"></div>
    </div>
  `;
  await loadAgents();
}

async function loadAgents() {
  try {
    const { agents } = await api.getAgents();
    const container = document.getElementById('agentCards');
    const table = document.getElementById('agentTable');

    if (!agents || agents.length === 0) {
      if (container) container.innerHTML = '<div class="card" style="grid-column:1/-1"><div class="empty-state"><div class="empty-state-icon">📭</div><div class="empty-state-title">No agents registered</div><div class="empty-state-desc">Add an agent to see runtime metrics here.</div></div></div>';
      if (table) table.innerHTML = '';
      return;
    }

    // Card view
    container.innerHTML = agents.map(a => {
      const sc = statusColor(a.status);
      const safeName = escapeHtml(a.display_name || a.name);
      const safeDesc = escapeHtml(a.description || 'No description');
      return `
        <div class="card agent-card">
          <div class="agent-card-header">
            <div class="agent-dot ${a.status}" style="width:12px;height:12px"></div>
            <span style="font-weight:600;font-size:15px">${safeName}</span>
            ${a.builtin ? '<span class="nav-badge" style="background:var(--accent)">built-in</span>' : '<span class="nav-badge" style="background:var(--green)">custom</span>'}
          </div>
          <div style="font-size:12px;color:var(--text-secondary);margin:8px 0">${safeDesc}</div>
          <div style="display:flex;gap:8px;align-items:center">
            <span style="font-size:11px;color:${sc.text};text-transform:uppercase;font-weight:600">${a.status}</span>
            <span style="font-size:11px;color:var(--text-muted)">${a.type || 'cli'}</span>
          </div>
          <div style="margin-top:10px;font-size:11px;color:var(--text-muted);display:flex;gap:10px;flex-wrap:wrap">
            <span>Runs: ${a.total_runs ?? 0}</span>
            <span>Success: ${a.successful_runs ?? 0}</span>
            <span>Failed: ${a.failed_runs ?? 0}</span>
            <span>Avg: ${(a.avg_response_time ?? 0).toFixed(1)}s</span>
          </div>
          ${!a.builtin ? `<div style="margin-top:12px"><button class="btn btn-ghost btn-sm" onclick="removeAgent('${a.name}')">Remove</button></div>` : ''}
        </div>
      `;
    }).join('');

    // Table view
    table.innerHTML = `
      <table class="agent-table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Type</th>
            <th>Status</th>
            <th>Source</th>
            <th>Runs</th>
            <th>Success</th>
            <th>Failed</th>
            <th>Avg</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${agents.map(a => {
            const sc = statusColor(a.status);
            return `
              <tr>
                <td>
                  <div style="display:flex;align-items:center;gap:8px">
                    <div class="agent-dot ${a.status}" style="width:8px;height:8px"></div>
                    <span style="font-weight:500">${safeName}</span>
                  </div>
                  <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${safeDesc}</div>
                </td>
                <td style="text-transform:uppercase;font-size:11px">${a.type || 'cli'}</td>
                <td><span style="color:${sc.text};font-size:11px;text-transform:uppercase;font-weight:600">${a.status}</span></td>
                <td>${a.builtin ? '<span style="color:var(--text-muted)">built-in</span>' : '<span style="color:var(--green)">custom</span>'}</td>
                <td>${a.total_runs ?? 0}</td>
                <td>${a.successful_runs ?? 0}</td>
                <td>${a.failed_runs ?? 0}</td>
                <td>${(a.avg_response_time ?? 0).toFixed(1)}s</td>
                <td>
                  ${!a.builtin ? `<button class="btn btn-ghost btn-sm" onclick="removeAgent('${a.name}')">Remove</button>` : '<span style="color:var(--text-muted);font-size:11px">—</span>'}
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
  } catch (err) {
    const agentCards = document.getElementById('agentCards');
    if (agentCards) {
      agentCards.innerHTML = `<div class="card" style="grid-column:1/-1"><div class="empty-state"><div class="empty-state-icon">⚠</div><div class="empty-state-title">Error loading agents</div><div class="empty-state-desc">${escapeHtml(err.message)}</div><button class="btn btn-primary mt-3" onclick="loadAgents()">Retry</button></div></div>`;
    }
  }
}

function showAddAgentModal() {
  showModal('Register New Agent', `
    <div class="form-group">
      <label class="form-label">Agent Name *</label>
      <input id="agentName" class="form-input" placeholder="e.g. claude-code, codex, custom-llm">
      <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Unique identifier (lowercase, no spaces)</div>
    </div>
    <div class="form-group">
      <label class="form-label">Display Name</label>
      <input id="agentDisplay" class="form-input" placeholder="e.g. Claude Code">
    </div>
    <div class="form-group">
      <label class="form-label">Description</label>
      <input id="agentDesc" class="form-input" placeholder="What this agent does">
    </div>
    <div class="form-group">
      <label class="form-label">Agent Type</label>
      <select id="agentType" class="form-select" onchange="updateAgentForm()">
        <option value="cli">CLI Binary (local command)</option>
        <option value="http">HTTP API (remote endpoint)</option>
        <option value="mcp">MCP Server (Model Context Protocol)</option>
      </select>
    </div>
    <div id="cliFields">
      <div class="form-group">
        <label class="form-label">Binary Name *</label>
        <input id="agentBinary" class="form-input" placeholder="e.g. claude, codex">
      </div>
      <div class="form-group">
        <label class="form-label">Run Arguments (one per line, use {message} for user input)</label>
        <textarea id="agentRunArgs" class="form-textarea" rows="3" placeholder="claude&#10;-p&#10;{message}"></textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Health Check</label>
        <select id="agentCheckType" class="form-select">
          <option value="binary">Binary exists in PATH</option>
          <option value="custom">Custom command</option>
        </select>
      </div>
      <div class="form-group" id="customCheckGroup" style="display:none">
        <label class="form-label">Custom Check Command</label>
        <input id="agentCheckCmd" class="form-input" placeholder="e.g. claude --version">
      </div>
    </div>
    <div id="httpFields" style="display:none">
      <div class="form-group">
        <label class="form-label">API URL *</label>
        <input id="agentApiUrl" class="form-input" placeholder="https://api.example.com/chat">
      </div>
      <div class="form-group">
        <label class="form-label">HTTP Method</label>
        <select id="agentApiMethod" class="form-select">
          <option value="POST">POST</option>
          <option value="GET">GET</option>
        </select>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Timeout (seconds)</label>
      <input id="agentTimeout" class="form-input" type="number" value="60">
    </div>
    <div class="form-group">
      <label class="form-label">Router Keywords (comma-separated)</label>
      <input id="agentKeywords" class="form-input" placeholder="code, debug, test, build">
      <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Keywords for smart routing to this agent</div>
    </div>
  `, `
    <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="registerAgent()">Register Agent</button>
  `);

  // Show/hide custom check command field
  document.getElementById('agentCheckType').addEventListener('change', (e) => {
    document.getElementById('customCheckGroup').style.display = e.target.value === 'custom' ? 'block' : 'none';
  });
}

function updateAgentForm() {
  const type = document.getElementById('agentType').value;
  document.getElementById('cliFields').style.display = type === 'cli' ? 'block' : 'none';
  document.getElementById('httpFields').style.display = type === 'http' ? 'block' : 'none';
}

async function registerAgent() {
  const name = document.getElementById('agentName').value.trim();
  if (!name) { showToast('Agent name is required', 'error'); return; }

  const type = document.getElementById('agentType').value;
  const data = {
    name: name,
    display_name: document.getElementById('agentDisplay').value.trim() || name,
    description: document.getElementById('agentDesc').value.trim(),
    type: type,
    binary: document.getElementById('agentBinary').value.trim() || name,
    check_type: document.getElementById('agentCheckType').value === 'custom' ? 'custom' : 'binary',
    check_command: document.getElementById('agentCheckCmd').value.trim(),
    timeout: parseInt(document.getElementById('agentTimeout').value) || 60,
    router_keywords: document.getElementById('agentKeywords').value.split(',').map(k => k.trim()).filter(Boolean),
  };

  if (type === 'cli') {
    const runArgs = document.getElementById('agentRunArgs').value.trim();
    if (runArgs) {
      data.run_args = runArgs.split('\n').map(a => a.trim()).filter(Boolean);
    }
  } else if (type === 'http') {
    data.api_url = document.getElementById('agentApiUrl').value.trim();
    data.api_method = document.getElementById('agentApiMethod').value;
  }

  try {
    await api.registerAgent(data);
    closeModal();
    showToast(`Agent '${name}' registered successfully`, 'success');
    loadAgents();
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

async function removeAgent(name) {
  if (!confirm(`Remove agent '${name}'?`)) return;
  try {
    await api.unregisterAgent(name);
    showToast(`Agent '${name}' removed`, 'success');
    loadAgents();
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}
