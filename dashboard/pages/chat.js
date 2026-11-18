async function renderChat() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h1 class="page-title">AI Chat</h1>
        <p class="page-subtitle">Talk to opencode and agy CLI</p>
      </div>
      <div class="btn-group">
        <button class="btn" onclick="clearChat()">🗑 Clear</button>
        <button class="btn" onclick="refreshChat()">🔄 Refresh</button>
      </div>
    </div>
    <div class="chat-layout">
      <div class="chat-sidebar">
        <div class="chat-agents-label">Agents</div>
        <div class="chat-agent active" data-agent="opencode" onclick="selectAgent('opencode')">
          <div class="agent-dot online"></div>
          <div>
            <div class="chat-agent-name">opencode</div>
            <div class="chat-agent-desc">Code & DevOps</div>
          </div>
        </div>
        <div class="chat-agent" data-agent="agy" onclick="selectAgent('agy')">
          <div class="agent-dot offline"></div>
          <div>
            <div class="chat-agent-name">agy (Antigravity)</div>
            <div class="chat-agent-desc">Research & Analysis</div>
          </div>
        </div>
        <div style="margin-top:auto;padding:12px;font-size:11px;color:var(--text-muted);border-top:1px solid var(--border)">
          <div id="chatAgentStatus">opencode • ready</div>
        </div>
      </div>
      <div class="chat-main">
        <div id="chatMessages" class="chat-messages">
          <div class="chat-welcome">
            <div class="chat-welcome-icon">💬</div>
            <div class="chat-welcome-title">Agentic OS Chat</div>
            <div class="chat-welcome-desc">Select an agent on the left and start a conversation.<br>Each agent has different capabilities — choose the right one for your task.</div>
            <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap;justify-content:center">
              <button class="btn btn-sm" onclick="sendQuickPrompt('opencode','Check the system status and running processes')">🔍 System Check</button>
              <button class="btn btn-sm" onclick="sendQuickPrompt('agy','Research the latest trends in AI agents')">📊 Research</button>
            </div>
          </div>
        </div>
        <div class="chat-input-area">
          <div class="chat-agent-indicator" id="chatAgentIndicator">opencode</div>
          <textarea id="chatInput" class="chat-input" rows="1" placeholder="Type a message..." onkeydown="handleChatKey(event)"></textarea>
          <button class="btn btn-icon" onclick="document.getElementById('chatFileInput').click()" title="Attach file" style="font-size:16px">📎</button>
          <input type="file" id="chatFileInput" style="display:none" onchange="handleChatFile(this)">
          <button class="btn btn-primary btn-icon" onclick="sendChatMessage()" id="chatSendBtn" title="Send">➤</button>
        </div>
        <div id="chatAttachment" style="display:none;padding:6px 12px;font-size:12px;color:var(--text-secondary);background:var(--yellow-dim);border-top:1px solid var(--border)">
          📎 <span id="chatAttachmentName"></span> <span style="cursor:pointer;margin-left:8px;color:var(--red)" onclick="clearChatAttachment()">✕ remove</span>
        </div>
      </div>
    </div>
  `;

  window._currentAgent = 'opencode';
  window._chatHistory = [];
  document.getElementById('chatInput').focus();

  // Update agent status indicators
  try {
    const status = await api.getStatus();
    (status.agents || []).forEach(a => {
      const el = document.querySelector(`.chat-agent[data-agent="${a.name}"]`);
      if (el) {
        const dot = el.querySelector('.agent-dot');
        dot.className = `agent-dot ${a.status}`;
      }
    });
    updateAgentStatusText();
  } catch {}

  // Load chat history
  await refreshChat();
}

function selectAgent(agent) {
  window._currentAgent = agent;
  document.querySelectorAll('.chat-agent').forEach(el => el.classList.remove('active'));
  document.querySelector(`.chat-agent[data-agent="${agent}"]`).classList.add('active');
  document.getElementById('chatAgentIndicator').textContent = agent;
  document.getElementById('chatInput').focus();
  updateAgentStatusText();
}

function updateAgentStatusText() {
  const el = document.getElementById('chatAgentStatus');
  if (el && window._currentAgent) {
    const agentEl = document.querySelector(`.chat-agent[data-agent="${window._currentAgent}"]`);
    const dot = agentEl ? agentEl.querySelector('.agent-dot').className : 'offline';
    el.textContent = `${window._currentAgent} • ${dot === 'agent-dot online' ? 'online' : 'offline'}`;
  }
}

function handleChatKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
  autoResizeTextarea(e.target);
}

function autoResizeTextarea(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 150) + 'px';
}

async function sendChatMessage() {
  const input = document.getElementById('chatInput');
  const message = input.value.trim();
  const fileInput = document.getElementById('chatFileInput');
  const file = fileInput && fileInput.files && fileInput.files[0];
  if (!message && !file) return;

  const agent = window._currentAgent || 'opencode';
  input.value = '';
  input.style.height = 'auto';

  // Add user message to chat
  addChatMessage('user', message || `📎 ${file.name}`, agent);

  // Show typing indicator
  const typingId = showTypingIndicator(agent);

  // Client-side timeout: 200s (slightly more than the 180s backend CLI timeout)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 200000);

  try {
    let r;
    if (file) {
      r = await api.chatWithFile(agent, message, file, controller);
      clearChatAttachment();
    } else {
      r = await api.chat(agent, message, controller);
    }
    clearTimeout(timeoutId);
    removeTypingIndicator(typingId);
    addChatMessage('assistant', r.response.content, agent);

    // Store in local history
    window._chatHistory.push({ role: 'user', content: message || `📎 ${file.name}`, agent });
    window._chatHistory.push({ role: 'assistant', content: r.response.content, agent });
  } catch (err) {
    removeTypingIndicator(typingId);
    const msg = err.name === 'AbortError' ? 'Request timed out after 200s' : err.message;
    addChatMessage('assistant', `⚠ Error: ${msg}`, agent);
  }
}

function handleChatFile(fileInput) {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    showToast('File too large (max 2 MB)', 'error');
    fileInput.value = '';
    return;
  }
  document.getElementById('chatAttachment').style.display = '';
  document.getElementById('chatAttachmentName').textContent = `${file.name} (${formatBytes(file.size)})`;
}

function clearChatAttachment() {
  const fi = document.getElementById('chatFileInput');
  if (fi) fi.value = '';
  const bar = document.getElementById('chatAttachment');
  if (bar) bar.style.display = 'none';
}

function addChatMessage(role, content, agent) {
  const container = document.getElementById('chatMessages');
  const welcome = container.querySelector('.chat-welcome');
  if (welcome) welcome.style.display = 'none';

  const msg = document.createElement('div');
  msg.className = `chat-message ${role}`;
  msg.innerHTML = `
    <div class="chat-message-avatar">${role === 'user' ? '👤' : '🤖'}</div>
    <div class="chat-message-body">
      <div class="chat-message-header">
        <span class="chat-message-agent">${role === 'user' ? 'You' : agent}</span>
        <span class="chat-message-time">just now</span>
      </div>
      <div class="chat-message-content">${escapeHtml(content)}</div>
    </div>
  `;
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

function showTypingIndicator(agent) {
  const container = document.getElementById('chatMessages');
  const id = 'typing-' + Date.now();
  const div = document.createElement('div');
  div.className = 'chat-message assistant';
  div.id = id;
  div.innerHTML = `
    <div class="chat-message-avatar">🤖</div>
    <div class="chat-message-body">
      <div class="chat-message-header">
        <span class="chat-message-agent">${agent}</span>
      </div>
      <div class="typing-indicator"><span></span><span></span><span></span></div>
    </div>
  `;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return id;
}

function removeTypingIndicator(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

async function refreshChat() {
  try {
    const data = await api.getChatHistory();
    const messages = data.messages || [];
    window._chatHistory = messages;
    renderChatHistory(messages);
  } catch {}
}

function renderChatHistory(messages) {
  const container = document.getElementById('chatMessages');
  if (!container) return;
  const welcome = container.querySelector('.chat-welcome');
  if (welcome) welcome.style.display = 'none';

  // Remove all existing messages (keep welcome)
  container.querySelectorAll('.chat-message').forEach(el => el.remove());

  if (messages.length === 0) {
    if (welcome) welcome.style.display = '';
    return;
  }

  messages.forEach(msg => {
    const div = document.createElement('div');
    div.className = `chat-message ${msg.role}`;
    div.innerHTML = `
      <div class="chat-message-avatar">${msg.role === 'user' ? '👤' : '🤖'}</div>
      <div class="chat-message-body">
        <div class="chat-message-header">
          <span class="chat-message-agent">${msg.role === 'user' ? 'You' : msg.agent}</span>
          <span class="chat-message-time">${timeAgo(msg.timestamp)}</span>
        </div>
        <div class="chat-message-content">${escapeHtml(msg.content)}</div>
      </div>
    `;
    container.appendChild(div);
  });
  container.scrollTop = container.scrollHeight;
}

function clearChat() {
  document.querySelectorAll('#chatMessages .chat-message').forEach(el => el.remove());
  const welcome = document.querySelector('.chat-welcome');
  if (welcome) welcome.style.display = '';
  window._chatHistory = [];
}

function sendQuickPrompt(agent, message) {
  selectAgent(agent);
  document.getElementById('chatInput').value = message;
  sendChatMessage();
}
