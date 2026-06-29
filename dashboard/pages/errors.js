async function renderErrors() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <div class="page-title">Error Dashboard</div>
        <div class="page-subtitle">Track and manage system errors across all agents</div>
      </div>
      <div class="btn-group">
        <button class="btn btn-ghost" onclick="refreshErrors()">🔄 Refresh</button>
        <button class="btn btn-danger" onclick="clearAllErrors()">🗑 Clear All</button>
      </div>
    </div>
    <div class="flex gap-3 mb-3" style="flex-wrap:wrap">
      <div class="metric-tile" style="flex:1;min-width:120px">
        <div class="metric-tile-value" id="errorTotalCount">0</div>
        <div class="metric-tile-label">Total Errors</div>
      </div>
      <div class="metric-tile" style="flex:1;min-width:120px">
        <div class="metric-tile-value" id="errorAgentCount">0</div>
        <div class="metric-tile-label">Agent Errors</div>
      </div>
      <div class="metric-tile" style="flex:1;min-width:120px">
        <div class="metric-tile-value" id="errorSkillCount">0</div>
        <div class="metric-tile-label">Skill Errors</div>
      </div>
      <div class="metric-tile" style="flex:1;min-width:120px">
        <div class="metric-tile-value" id="errorCircuitCount">0</div>
        <div class="metric-tile-label">Circuit Breaks</div>
      </div>
    </div>
    <div class="flex gap-2 mb-3" style="flex-wrap:wrap">
      <select id="errorCategoryFilter" class="form-select" style="width:160px" onchange="refreshErrors()">
        <option value="">All Categories</option>
        <option value="agent">Agent</option>
        <option value="skill">Skill</option>
        <option value="api">API</option>
        <option value="system">System</option>
        <option value="general">General</option>
      </select>
      <span id="errorCountBadge" class="badge badge-danger" style="display:none"></span>
    </div>
    <div id="errorList"><div class="loading"><div class="loading-spinner"></div></div></div>
    <div class="section-title mt-4">Circuit Breaker Status</div>
    <div id="circuitBreakerCards" class="grid grid-3"></div>
  `;
  await Promise.all([refreshErrors(), loadCircuitBreaker()]);
}

async function refreshErrors() {
  const container = document.getElementById('errorList');
  if (!container) return;
  const category = document.getElementById('errorCategoryFilter')?.value || '';
  try {
    const data = await api.getErrors(100, category);
    const errors = data.errors || [];
    const totalEl = document.getElementById('errorTotalCount');
    if (totalEl) totalEl.textContent = errors.length;
    const agentErrors = errors.filter(e => e.category === 'agent').length;
    const skillErrors = errors.filter(e => e.category === 'skill').length;
    const circuitErrors = errors.filter(e => e.category === 'circuit').length;
    const aEl = document.getElementById('errorAgentCount');
    if (aEl) aEl.textContent = agentErrors;
    const sEl = document.getElementById('errorSkillCount');
    if (sEl) sEl.textContent = skillErrors;
    const cEl = document.getElementById('errorCircuitCount');
    if (cEl) cEl.textContent = circuitErrors;
    const badge = document.getElementById('errorCountBadge');
    if (badge) {
      if (errors.length > 0) { badge.style.display = 'inline'; badge.textContent = errors.length + ' issues'; }
      else { badge.style.display = 'none'; }
    }
    if (errors.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">✅</div><div class="empty-state-title">No errors</div><div class="empty-state-desc">System is running smoothly</div></div>';
      return;
    }
    container.innerHTML = `
      <div class="table-wrapper">
        <table>
          <thead><tr><th>Time</th><th>Category</th><th>Source</th><th>Message</th><th>ID</th></tr></thead>
          <tbody>
            ${errors.slice().reverse().map(e => `
              <tr>
                <td style="font-size:12px;white-space:nowrap">${formatDate(e.timestamp)}</td>
                <td><span class="badge ${e.category === 'agent' ? 'badge-danger' : e.category === 'skill' ? 'badge-warning' : e.category === 'api' ? 'badge-info' : 'badge'}">${escapeHtml(e.category)}</span></td>
                <td style="font-size:13px"><strong>${escapeHtml(e.source)}</strong></td>
                <td style="font-size:13px">${escapeHtml(e.message)}</td>
                <td style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono)">${e.id || ''}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <div style="font-size:12px;color:var(--text-muted);text-align:right;margin-top:8px">${errors.length} error${errors.length !== 1 ? 's' : ''}</div>
    `;
  } catch (err) {
    if (container) container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠</div><div class="empty-state-title">${escapeHtml(err.message)}</div></div>`;
  }
}

async function clearAllErrors() {
  if (!confirm('Clear all error logs?')) return;
  try {
    await api.clearErrors();
    showToast('Error log cleared', 'success');
    refreshErrors();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

async function loadCircuitBreaker() {
  const container = document.getElementById('circuitBreakerCards');
  if (!container) return;
  try {
    const data = await api.getCircuitBreaker();
    const agents = data.agents || {};
    const agentNames = Object.keys(agents);
    if (agentNames.length === 0) {
      container.innerHTML = '<div style="grid-column:1/-1"><div class="empty-state" style="padding:20px"><div class="empty-state-icon">🔌</div><div class="empty-state-title">No circuit breaker data</div></div></div>';
      return;
    }
    const agentIcons = { opencode: '🔧', hermes: '⚡', gemini: '🧠' };
    container.innerHTML = agentNames.map(a => {
      const cb = agents[a] || {};
      const isOpen = cb.state === 'open';
      return `
        <div class="card" style="border-color:${isOpen ? 'var(--red)' : 'var(--green-dim)'}">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
            <span style="font-size:20px">${agentIcons[a] || '🤖'}</span>
            <div>
              <div style="font-weight:600;text-transform:capitalize">${escapeHtml(a)}</div>
              <div style="font-size:12px;color:${isOpen ? 'var(--red)' : 'var(--green)'}">${cb.state || 'closed'}</div>
            </div>
          </div>
          <div style="display:flex;gap:8px;font-size:12px;color:var(--text-muted);margin-bottom:8px">
            <span>Failures: ${cb.failures || 0}</span>
            <span>Threshold: ${data.threshold || 3}</span>
          </div>
          ${isOpen ? `<button class="btn btn-sm btn-primary" onclick="resetCircuit('${a}')">🔓 Reset</button>` : ''}
        </div>
      `;
    }).join('');
  } catch {
    container.innerHTML = '<div style="grid-column:1/-1"><div class="empty-state" style="padding:20px"><div class="empty-state-icon">⚠</div><div class="empty-state-title">Failed to load circuit breaker</div></div></div>';
  }
}

async function resetCircuit(agent) {
  try {
    await api.resetCircuitBreaker(agent);
    showToast(`Circuit breaker reset for ${agent}`, 'success');
    loadCircuitBreaker();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}
