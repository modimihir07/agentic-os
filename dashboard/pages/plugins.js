async function renderPlugins() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h1 class="page-title">Plugin Registry</h1>
        <p class="page-subtitle">Manage installed plugins and extensions</p>
      </div>
      <button class="btn btn-primary" onclick="showInstallPlugin()">+ Install</button>
    </div>
    <div id="pluginList"><div class="loading"><div class="loading-spinner"></div></div></div>
  `;

  try {
    const data = await api.getPlugins();
    const plugins = data.plugins || [];
    const container = document.getElementById('pluginList');

    if (plugins.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🔌</div><div class="empty-state-title">No plugins installed</div><div class="empty-state-desc">Install plugins from the registry or create your own</div></div>';
      return;
    }

    container.innerHTML = `
      <div class="table-wrapper">
        <table>
          <thead><tr><th>Plugin</th><th>Version</th><th>Type</th><th>Installed</th></tr></thead>
          <tbody>
            ${plugins.map(p => `
              <tr>
                <td><strong>${escapeHtml(p.name)}</strong></td>
                <td><code>${escapeHtml(p.version || '1.0.0')}</code></td>
                <td><span class="badge badge-info">${escapeHtml(p.type || 'skill')}</span></td>
                <td style="font-size:12px;color:var(--text-muted)">${formatDate(p.installed)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <div style="font-size:12px;color:var(--text-muted);text-align:right;margin-top:8px">${plugins.length} plugin${plugins.length !== 1 ? 's' : ''}</div>
    `;
  } catch (err) {
    document.getElementById('pluginList').innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠</div><div class="empty-state-title">${escapeHtml(err.message)}</div></div>`;
  }
}

function showInstallPlugin() {
  showModal('Install Plugin', `
    <div class="form-group">
      <label class="form-label">Plugin Name</label>
      <input id="pluginNameInput" class="form-input" placeholder="e.g., my-custom-skill">
      <div class="form-hint">Enter the name of the plugin to install from the registry</div>
    </div>
  `, `
    <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="installPlugin()">Install</button>
  `);
}

async function installPlugin() {
  const name = document.getElementById('pluginNameInput').value.trim();
  if (!name) { showToast('Plugin name required', 'warning'); return; }
  try {
    const r = await api.installPlugin(name);
    closeModal();
    showToast(r.status === 'already_installed' ? 'Already installed' : `"${name}" installed`, r.status === 'already_installed' ? 'info' : 'success');
    renderPlugins();
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}
