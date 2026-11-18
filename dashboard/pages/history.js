async function renderHistory() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h1 class="page-title">Chat History</h1>
        <p class="page-subtitle">Browse, search, and replay past conversations</p>
      </div>
      <div class="btn-group">
        <button class="btn" onclick="refreshHistory()">🔄 Refresh</button>
      </div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="form-group" style="margin-bottom:8px">
        <input id="historySearch" class="form-input" placeholder="Search conversations..." onkeydown="if(event.key==='Enter')loadHistory()">
      </div>
      <div class="flex items-center gap-2" style="flex-wrap:wrap">
        <span style="font-size:12px;color:var(--text-muted)">Filter:</span>
        ${['', 'opencode', 'agy'].map(a => `
          <button class="btn btn-sm ${!a ? 'btn-primary' : 'btn-ghost'}" data-agent="${a}" onclick="filterHistoryByAgent('${a}')">${a || 'All'}</button>
        `).join('')}
        <span style="flex:1"></span>
        <button class="btn btn-sm btn-primary" onclick="loadHistory()">🔍 Search</button>
      </div>
    </div>
    <div id="historyResults"><div class="loading"><div class="loading-spinner"></div><span>Loading history...</span></div></div>
  `;

  window._historyAgent = '';
  window._historyFilter = '';
  await loadHistory();
}

function filterHistoryByAgent(agent) {
  window._historyAgent = agent;
  document.querySelectorAll('#pageContent button[data-agent]').forEach(b => {
    b.classList.toggle('btn-primary', b.dataset.agent === agent);
    b.classList.toggle('btn-ghost', b.dataset.agent !== agent);
  });
  loadHistory();
}

async function loadHistory() {
  const container = document.getElementById('historyResults');
  if (!container) return;
  const q = (document.getElementById('historySearch')?.value || '').trim();
  try {
    const data = await api.searchChatHistory(q, window._historyAgent, 500);
    const messages = data.messages || [];
    renderHistoryList(container, messages, q);
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠</div><div class="empty-state-title">${escapeHtml(err.message)}</div></div>`;
  }
}

function renderHistoryList(container, messages, q) {
  if (messages.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">💬</div><div class="empty-state-title">No conversations found</div><div class="empty-state-desc">Messages appear here after you chat with an agent.</div></div>';
    return;
  }

  // Group by date (YYYY-MM-DD)
  const groups = {};
  messages.forEach(m => {
    const day = (m.timestamp || '').slice(0, 10) || 'Unknown date';
    (groups[day] = groups[day] || []).push(m);
  });

  const agentIcons = { opencode: '🔧', hermes: '⚡', agy: '🧠' };
  const highlight = (text) => {
    if (!q) return escapeHtml(text);
    const escaped = escapeHtml(text);
    const ql = escapeHtml(q);
    return escaped.split(new RegExp(`(${ql.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'i')).map((part, i) =>
      part.toLowerCase() === ql.toLowerCase() ? `<mark style="background:var(--yellow-dim);color:inherit;border-radius:2px">${part}</mark>` : part
    ).join('');
  };

  container.innerHTML = Object.entries(groups).map(([day, msgs]) => `
    <div class="card" style="margin-bottom:16px">
      <div class="card-header"><span class="card-title">📅 ${escapeHtml(day)}</span><span class="badge badge-info">${msgs.length} msg</span></div>
      <div style="display:flex;flex-direction:column">
        ${msgs.map(m => {
          const icon = agentIcons[m.agent] || '🤖';
          return `<div class="history-msg" style="display:flex;gap:10px;padding:10px 0;border-bottom:1px solid var(--border);cursor:pointer" onclick="loadHistoryIntoChat('${m.agent}','${escapeHtml(m.content || '').replace(/'/g, "\\'").slice(0, 1000)}')">
            <div style="flex:0 0 auto;width:28px;text-align:center;font-size:16px">${m.role === 'user' ? '👤' : icon}</div>
            <div style="flex:1;min-width:0">
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                <span style="font-size:12px;font-weight:600">${escapeHtml(m.role === 'user' ? 'You' : (m.agent || 'agent'))}</span>
                <span class="badge ${m.role === 'user' ? 'badge-info' : 'badge-accent'}">${escapeHtml(m.agent || '')}</span>
                <span style="font-size:11px;color:var(--text-muted)">${timeAgo(m.timestamp)}</span>
              </div>
              <div class="text-sm text-secondary" style="margin-top:3px;white-space:pre-wrap;word-break:break-word;max-height:80px;overflow:hidden">${highlight(m.content || '')}</div>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>
  `).join('');
}

async function refreshHistory() {
  await loadHistory();
}

function loadHistoryIntoChat(agent, content) {
  navigate('chat');
  setTimeout(() => {
    selectAgent(agent);
    const input = document.getElementById('chatInput');
    if (input) {
      input.value = content;
      input.focus();
      autoResizeTextarea(input);
    }
  }, 300);
}
