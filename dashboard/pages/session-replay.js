async function renderSessionReplay() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <div class="page-title">Session Replay</div>
        <div class="page-subtitle">Browse and replay past opencode sessions</div>
      </div>
      <div class="btn-group">
        <button class="btn btn-ghost" onclick="renderSessionReplay()">🔄 Refresh</button>
      </div>
    </div>
    <div id="sessionList">
      <div class="loading"><div class="loading-spinner"></div><span>Loading sessions...</span></div>
    </div>
    <div id="sessionDetail" style="margin-top:16px"></div>
  `;
  try {
    const data = await api.listSessions();
    const sessions = data.sessions || [];
    const list = document.getElementById('sessionList');
    if (sessions.length === 0) {
      list.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🎬</div><div class="empty-state-title">No sessions found</div><div class="empty-state-desc">Sessions from opencode will appear here</div></div>`;
      return;
    }
    list.innerHTML = `
      <div class="card" style="padding:0">
        <table>
          <tr><th>Session ID</th><th>Date</th><th>Size</th><th></th></tr>
          ${sessions.slice(0, 50).map(s => `
            <tr>
              <td style="font-family:monospace;font-size:12px">${escapeHtml(s.id)}</td>
              <td class="text-sm">${new Date(s.date).toLocaleString()}</td>
              <td class="text-sm text-muted">${formatSize(s.size || 0)}</td>
              <td><button class="btn btn-sm btn-ghost" onclick="replaySession('${s.id}')">▶ Replay</button></td>
            </tr>
          `).join('')}
        </table>
        ${sessions.length > 50 ? `<div style="padding:12px;text-align:center;color:var(--text-muted);font-size:12px">Showing 50 of ${sessions.length} sessions</div>` : ''}
      </div>
    `;
  } catch (err) {
    document.getElementById('sessionList').innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠</div><div class="empty-state-title">Failed to load sessions</div><div class="empty-state-desc">${escapeHtml(err.message)}</div></div>`;
  }
}

async function replaySession(id) {
  const detail = document.getElementById('sessionDetail');
  detail.innerHTML = `<div class="loading"><div class="loading-spinner"></div><span>Loading session ${escapeHtml(id)}...</span></div>`;
  try {
    const data = await api.getSessionReplay(id);
    const messages = data.messages || [];
    const session = data.session || {};
    detail.innerHTML = `
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div>
            <div style="font-weight:600">Session: <code style="font-size:12px">${escapeHtml(id)}</code></div>
            <div class="text-muted text-sm">${messages.length} messages · ${new Date(session.created_at || Date.now()).toLocaleString()}</div>
          </div>
          <button class="btn btn-sm btn-ghost" onclick="document.getElementById('sessionDetail').innerHTML=''">✕ Close</button>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;max-height:600px;overflow-y:auto;padding-right:8px">
        ${messages.map(m => {
          const isUser = m.role === 'user' || m.role === 'human';
          return `
            <div class="session-message ${isUser ? 'session-message-user' : 'session-message-assistant'}">
              <div class="session-message-role">${isUser ? '👤 You' : '🤖 Assistant'}</div>
              <div class="session-message-content">${escapeHtml((m.content || '').substring(0, 500))}${(m.content || '').length > 500 ? '...' : ''}</div>
              <div class="session-message-meta">${new Date(m.timestamp || Date.now()).toLocaleTimeString()}</div>
            </div>
          `;
        }).join('')}
        ${messages.length === 0 ? '<div class="text-muted text-sm" style="text-align:center;padding:20px">Empty session</div>' : ''}
      </div>
    `;
  } catch (err) {
    detail.innerHTML = `<div class="card" style="border-color:var(--red)"><div class="text-sm" style="color:var(--red)">⚠ Failed to replay session: ${escapeHtml(err.message)}</div></div>`;
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
