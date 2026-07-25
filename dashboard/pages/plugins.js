async function renderPlugins() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h1 class="page-title">Plugin Registry</h1>
        <p class="page-subtitle">Install skills from GitHub or create your own</p>
      </div>
      <button class="btn btn-primary" onclick="showInstallPlugin()">+ Install from GitHub</button>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px">
      <div class="card">
        <div class="card-title" style="margin-bottom:12px">Install a Plugin</div>
        <div class="form-group">
          <label class="form-label">GitHub Repo URL</label>
          <input id="pluginRepoInput" class="form-input" placeholder="https://github.com/you/your-skill-repo">
          <div class="form-hint">Paste a GitHub URL to clone a skill from a repo</div>
        </div>
        <div class="form-group">
          <label class="form-label">Plugin Name (optional)</label>
          <input id="pluginNameInput" class="form-input" placeholder="auto-detect from repo URL">
        </div>
        <button class="btn btn-primary" onclick="installPluginFromRepo()">Install</button>
        <div id="installStatus" style="margin-top:8px;font-size:12px"></div>
      </div>

      <div class="card">
        <div class="card-title" style="margin-bottom:12px">Connect External App</div>
        <div class="form-group">
          <label class="form-label">App Name</label>
          <input id="integrationNameInput" class="form-input" placeholder="e.g., Slack, Zapier, n8n">
        </div>
        <div class="form-group">
          <label class="form-label">Webhook / URL</label>
          <input id="integrationUrlInput" class="form-input" placeholder="https://hooks.slack.com/...">
        </div>
        <div class="form-group">
          <label class="form-label">Type</label>
          <select id="integrationType" class="form-input">
            <option value="webhook">Webhook</option>
            <option value="api">REST API</option>
            <option value="zapier">Zapier</option>
            <option value="n8n">n8n</option>
          </select>
        </div>
        <button class="btn btn-primary" onclick="addIntegration()">Connect</button>
        <div id="integrationStatus" style="margin-top:8px;font-size:12px"></div>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-title" style="margin-bottom:12px">Connected Apps</div>
      <div id="integrationsList"></div>
    </div>

    <div id="pluginList"><div class="loading"><div class="loading-spinner"></div></div></div>
  `;

  try {
    const [pluginsData, integrationsData] = await Promise.all([
      api.getPlugins(),
      api.getIntegrations(),
    ]);

    renderPluginTable(pluginsData.plugins || []);
    renderIntegrations(integrationsData.integrations || []);
  } catch (err) {
    document.getElementById('pluginList').innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠</div><div class="empty-state-title">${escapeHtml(err.message)}</div></div>`;
  }
}

function renderPluginTable(plugins) {
  const container = document.getElementById('pluginList');
  if (plugins.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🔌</div><div class="empty-state-title">No plugins installed</div><div class="empty-state-desc">Install plugins from GitHub or create your own</div></div>';
    return;
  }
  container.innerHTML = `
    <div class="card">
      <div class="card-title">Installed Plugins (${plugins.length})</div>
      <div class="table-wrapper">
        <table>
          <thead><tr><th>Plugin</th><th>Version</th><th>Type</th><th>Source</th><th>Installed</th><th></th></tr></thead>
          <tbody>
            ${plugins.map(p => `
              <tr>
                <td><strong>${escapeHtml(p.name)}</strong></td>
                <td><code>${p.version || '1.0.0'}</code></td>
                <td><span class="badge badge-info">${p.type || 'skill'}</span></td>
                <td style="font-size:11px;max-width:200px;overflow:hidden;text-overflow:ellipsis" title="${escapeHtml(p.source || '')}">${escapeHtml(p.source || 'built-in')}</td>
                <td style="font-size:12px;color:var(--text-muted)">${formatDate(p.installed)}</td>
                <td>${p.source ? `<button class="btn btn-ghost" style="padding:4px 8px;font-size:11px" onclick="uninstallPlugin('${escapeHtml(p.name)}')">Remove</button>` : '—'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderIntegrations(integrations) {
  const container = document.getElementById('integrationsList');
  if (integrations.length === 0) {
    container.innerHTML = '<div style="font-size:12px;color:var(--text-muted)">No external apps connected yet</div>';
    return;
  }
  container.innerHTML = `<div style="display:flex;flex-direction:column;gap:8px">
    ${integrations.map(i => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--bg-secondary);border-radius:6px">
        <div>
          <strong style="font-size:13px">${escapeHtml(i.name)}</strong>
          <span class="badge badge-info" style="margin-left:8px">${escapeHtml(i.type)}</span>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${escapeHtml(i.url)}</div>
        </div>
        <span style="font-size:11px;color:var(--accent)">● connected</span>
      </div>
    `).join('')}
  </div>`;
}

function showInstallPlugin() {
  document.getElementById('pluginRepoInput').focus();
}

async function installPluginFromRepo() {
  const repoUrl = document.getElementById('pluginRepoInput').value.trim();
  const name = document.getElementById('pluginNameInput').value.trim();
  const statusEl = document.getElementById('installStatus');

  if (!repoUrl) {
    statusEl.innerHTML = '<span style="color:#ef4444">Please enter a GitHub repo URL</span>';
    return;
  }

  statusEl.innerHTML = '<span style="color:var(--accent)">Installing...</span>';
  try {
    const r = await api.installPlugin(name || repoUrl, repoUrl);
    statusEl.innerHTML = `<span style="color:#22c55e">✓ ${escapeHtml(r.plugin)} installed</span>`;
    document.getElementById('pluginRepoInput').value = '';
    document.getElementById('pluginNameInput').value = '';
    setTimeout(() => renderPlugins(), 2000);
  } catch (err) {
    statusEl.innerHTML = `<span style="color:#ef4444">Error: ${escapeHtml(err.message)}</span>`;
  }
}

async function uninstallPlugin(name) {
  if (!confirm(`Remove "${name}"?`)) return;
  try {
    await api.uninstallPlugin(name);
    showToast(`${name} removed`, 'success');
    renderPlugins();
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

async function addIntegration() {
  const name = document.getElementById('integrationNameInput').value.trim();
  const url = document.getElementById('integrationUrlInput').value.trim();
  const type = document.getElementById('integrationType').value;
  const statusEl = document.getElementById('integrationStatus');

  if (!name || !url) {
    statusEl.innerHTML = '<span style="color:#ef4444">Name and URL required</span>';
    return;
  }

  statusEl.innerHTML = '<span style="color:var(--accent)">Connecting...</span>';
  try {
    const r = await api.addIntegration(name, url, type);
    statusEl.innerHTML = `<span style="color:#22c55e">✓ ${escapeHtml(r.name)} connected</span>`;
    document.getElementById('integrationNameInput').value = '';
    document.getElementById('integrationUrlInput').value = '';
    setTimeout(() => renderPlugins(), 2000);
  } catch (err) {
    statusEl.innerHTML = `<span style="color:#ef4444">Error: ${escapeHtml(err.message)}</span>`;
  }
}
