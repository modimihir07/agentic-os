async function renderBackups() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h1 class="page-title">Backups</h1>
        <p class="page-subtitle">System snapshots and disaster recovery</p>
      </div>
      <button class="btn btn-primary" onclick="createBackup()">+ New Backup</button>
    </div>
    <div id="backupList"><div class="loading"><div class="loading-spinner"></div></div></div>
  `;

  try {
    const backups = await api.getBackups();
    const container = document.getElementById('backupList');

    if (backups.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">💾</div><div class="empty-state-title">No backups yet</div><div class="empty-state-desc">Create your first backup to protect your system configuration</div><button class="btn btn-primary mt-3" onclick="createBackup()">Create Backup</button></div>';
      return;
    }

    container.innerHTML = `
      <div class="table-wrapper">
        <table>
          <thead><tr><th>Name</th><th>Size</th><th>Created</th><th></th></tr></thead>
          <tbody>
            ${backups.map(b => `
              <tr>
                <td><strong>${escapeHtml(b.name)}</strong></td>
                <td>${formatBytes(b.size)}</td>
                <td style="font-size:12px">${formatDate(b.created)}</td>
                <td><button class="btn btn-sm btn-danger" onclick="restoreBackup('${encodeURIComponent(b.name)}')">Restore</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <div style="font-size:12px;color:var(--text-muted);text-align:right;margin-top:8px">${backups.length} backup${backups.length !== 1 ? 's' : ''}</div>
    `;
  } catch (err) {
    document.getElementById('backupList').innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠</div><div class="empty-state-title">${escapeHtml(err.message)}</div></div>`;
  }
}

async function createBackup() {
  try {
    const r = await api.createBackup();
    showToast(`Backup created: ${r.file} (${formatBytes(r.size)})`, 'success');
    renderBackups();
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

async function restoreBackup(encodedName) {
  const name = decodeURIComponent(encodedName);
  showModal('Restore Backup', `
    <p style="font-size:13px;color:var(--text-secondary);margin-bottom:8px">Restore <strong>${escapeHtml(name)}</strong>? This will overwrite current brain, skills, agents, registry, standards, and prompts data.</p>
    <div class="card" style="background:var(--red-dim);border-color:transparent">
      <div class="flex items-center gap-2"><span>⚠</span><span style="font-size:13px;font-weight:500">This action cannot be undone</span></div>
    </div>
  `, `
    <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    <button class="btn btn-danger" onclick="confirmRestore('${encodeURIComponent(name)}')">Restore</button>
  `);
}

async function confirmRestore(encodedName) {
  const name = decodeURIComponent(encodedName);
  try {
    const r = await api.restoreBackup(name);
    closeModal();
    showToast('Backup restored successfully', 'success');
    renderBackups();
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}
