async function renderAudit() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h1 class="page-title">Audit Log</h1>
        <p class="page-subtitle">Complete system activity trail</p>
      </div>
      <div class="btn-group">
        <button class="btn" onclick="refreshAudit()">🔄 Refresh</button>
        <button class="btn" onclick="clearAuditFilters()">✕ Clear Filters</button>
      </div>
    </div>
    <div class="flex gap-2 mb-3" style="flex-wrap:wrap">
      <input id="auditFilter" class="form-input" style="width:200px" placeholder="Filter by keyword..." oninput="applyAuditFilter()">
      <select id="auditActionFilter" class="form-select" style="width:150px" onchange="applyAuditFilter()">
        <option value="">All Actions</option>
        <option value="skill_run">Skill Run</option>
        <option value="brain_update">Brain Update</option>
        <option value="job_created">Job Created</option>
        <option value="job_deleted">Job Deleted</option>
        <option value="backup_created">Backup Created</option>
        <option value="backup_restored">Backup Restored</option>
        <option value="plugin_installed">Plugin Installed</option>
        <option value="settings_updated">Settings Updated</option>
      </select>
    </div>
    <div id="auditTable"><div class="loading"><div class="loading-spinner"></div></div></div>
  `;

  await refreshAudit();
}

let _allAuditEntries = [];

async function refreshAudit() {
  const container = document.getElementById('auditTable');
  container.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  try {
    const r = await api.getAudit(200);
    _allAuditEntries = r.entries || [];
    applyAuditFilter();
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠</div><div class="empty-state-title">${escapeHtml(err.message)}</div></div>`;
  }
}

function applyAuditFilter() {
  const q = (document.getElementById('auditFilter').value || '').toLowerCase();
  const action = document.getElementById('auditActionFilter').value;
  let filtered = _allAuditEntries;
  if (q) filtered = filtered.filter(e => JSON.stringify(e).toLowerCase().includes(q));
  if (action) filtered = filtered.filter(e => e.action === action);

  const container = document.getElementById('auditTable');
  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📭</div><div class="empty-state-title">No audit entries found</div></div>';
    return;
  }

  container.innerHTML = `
    <div class="table-wrapper">
      <table>
        <thead><tr><th>Time</th><th>Action</th><th>Details</th><th>ID</th></tr></thead>
        <tbody>
          ${filtered.slice(0, 100).map(e => `
            <tr>
              <td style="font-size:12px;white-space:nowrap">${formatDate(e.timestamp)}</td>
              <td><span class="badge ${e.action === 'skill_run' ? 'badge-success' : e.action === 'brain_update' ? 'badge-info' : e.action === 'backup_created' ? 'badge-accent' : 'badge-warning'}">${e.action}</span></td>
              <td style="font-size:13px">${e.skill ? `<strong>${escapeHtml(e.skill)}</strong>` : ''}${e.file ? `File: ${escapeHtml(e.file)}` : ''}${e.job ? `Job: ${escapeHtml(e.job)}` : ''}${e.plugin ? `Plugin: ${escapeHtml(e.plugin)}` : ''}</td>
              <td style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono)">${e.id || ''}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    <div style="font-size:12px;color:var(--text-muted);text-align:right;margin-top:8px">${filtered.length > 100 ? 'Showing 100 of ' : ''}${filtered.length} entries</div>
  `;
}

function clearAuditFilters() {
  document.getElementById('auditFilter').value = '';
  document.getElementById('auditActionFilter').value = '';
  applyAuditFilter();
}
