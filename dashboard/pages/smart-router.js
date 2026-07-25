// Per-agent display metadata (icons + role blurb). Built-ins + known custom agents.
const ROUTER_AGENT_META = {
  opencode: { icon: '🔧', blurb: 'Code & DevOps' },
  hermes:   { icon: '⚡', blurb: 'Memory & Scheduling' },
  gemini:   { icon: '🧠', blurb: 'Research & Analysis' },
  jarvis:   { icon: '🤖', blurb: 'Local-first AI / Deep Research' },
  kilocode: { icon: '💻', blurb: 'AI Coding Assistant' },
  codex:    { icon: '🧩', blurb: 'Code Generation' },
};
function routerAgentMeta(name) {
  return ROUTER_AGENT_META[name] || { icon: '🤖', blurb: 'Custom agent' };
}

async function renderSmartRouter() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <div class="page-title">Smart Router</div>
        <div class="page-subtitle">Intelligent task routing — auto-suggest or manually pick an agent</div>
      </div>
    </div>
    <div class="card" style="margin-bottom:20px">
      <div class="card-header">
        <div class="card-title">Route a Task</div>
      </div>
      <div class="form-group">
        <label class="form-label">Describe your task</label>
        <textarea class="form-textarea" id="routerTaskInput" placeholder="e.g., Deploy the CloudMart infrastructure to GCP..." rows="3"></textarea>
      </div>
      <div class="flex gap-3" style="align-items:flex-end">
        <div class="form-group" style="flex:1">
          <label class="form-label">Route to Agent</label>
          <select class="form-select" id="routerAgentSelect">
            <option value="auto">🤖 Auto (AI suggests)</option>
            <!-- agent options injected by loadRouterAgents() -->
          </select>
        </div>
        <button class="btn btn-primary" onclick="suggestRouter()" style="margin-bottom:16px">🤖 Suggest Agent</button>
        <button class="btn btn-gradient" onclick="routeTask()" style="margin-bottom:16px">🚀 Route Task</button>
      </div>
    </div>
    <div id="routerResult"></div>
    <div class="section-title" style="margin-top:20px">Routing Rules</div>
    <div class="card">
      <table id="routerRulesTable">
        <tr><th>Agent</th><th>Best For</th><th>Keywords</th></tr>
        <!-- rows injected by loadRouterAgents() -->
      </table>
    </div>
  `;
  await loadRouterAgents();
}

// Pull the live agent list from the server so the dropdown + rules table
// always reflect every registered agent (built-in AND custom).
async function loadRouterAgents() {
  let agents = [];
  try {
    const data = await api.getAgents();
    agents = (data.agents || []).map(a => a.name);
  } catch (e) {
    // Fallback to known built-ins if the API is unreachable.
    agents = ['opencode', 'hermes', 'gemini'];
  }

  const select = document.getElementById('routerAgentSelect');
  const table = document.getElementById('routerRulesTable');
  if (!select || !table) return;

  // Populate dropdown (preserve the Auto option already in the DOM).
  agents.forEach(name => {
    const meta = routerAgentMeta(name);
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = `${meta.icon} ${name} (${meta.blurb})`;
    select.appendChild(opt);
  });

  // Populate routing-rules table.
  const rows = agents.map(name => {
    const meta = routerAgentMeta(name);
    const kw = (window._routerKeywords && window._routerKeywords[name]) || [];
    return `<tr>
      <td><strong>${meta.icon} ${name}</strong></td>
      <td>${meta.blurb}</td>
      <td class="text-muted text-sm">${kw.join(', ') || '—'}</td>
    </tr>`;
  }).join('');
  table.innerHTML = `<tr><th>Agent</th><th>Best For</th><th>Keywords</th></tr>${rows}`;
}

async function suggestRouter() {
  const task = document.getElementById('routerTaskInput').value.trim();
  if (!task) { showToast('Describe your task first', 'warning'); return; }
  const btn = document.querySelector('button[onclick="suggestRouter()"]');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Thinking...'; }
  try {
    const data = await api.suggestRouter(task);
    // Cache keyword map from scores for the rules table refresh.
    window._routerKeywords = data.scores ? Object.keys(data.scores).reduce((m, a) => m, {}) : {};
    const result = document.getElementById('routerResult');
    const agentIcons = {
      opencode: '🔧', hermes: '⚡', gemini: '🧠',
      jarvis: '🤖', kilocode: '💻', codex: '🧩'
    };
    const confidenceColors = { high: 'var(--green)', medium: 'var(--yellow)', low: 'var(--text-muted)' };
    result.innerHTML = `
      <div class="card" style="border-color:${confidenceColors[data.confidence] || 'var(--border)'};margin-bottom:12px">
        <div class="router-suggestion" style="border:none;padding:0;background:none">
          <div>
            <div class="router-suggestion-agent" style="font-size:18px">
              ${agentIcons[data.suggested_agent] || '🤖'} ${data.suggested_agent}
            </div>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:4px">
              Confidence: <span style="color:${confidenceColors[data.confidence] || 'var(--text-muted)'}">${data.confidence}</span>
              ${data.confidence === 'high' ? '✅' : data.confidence === 'medium' ? '⚠️' : '❓'}
            </div>
          </div>
          <div style="flex:1;text-align:right">
            <span class="badge badge-accent">Best Match</span>
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
          ${Object.entries(data.scores || {}).map(([agent, score]) => `
            <span class="badge ${score > 0 ? 'badge-success' : 'badge-info'}">
              ${agentIcons[agent] || '🤖'} ${agent}: ${score}
            </span>
          `).join('')}
        </div>
      </div>
    `;
    document.getElementById('routerAgentSelect').value = data.suggested_agent || 'auto';
  } catch (err) {
    showToast('Suggestion failed: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🤖 Suggest Agent'; }
  }
}

async function routeTask() {
  const task = document.getElementById('routerTaskInput').value.trim();
  if (!task) { showToast('Describe your task first', 'warning'); return; }
  let agent = document.getElementById('routerAgentSelect').value;
  if (agent === 'auto') {
    showToast('Click "Suggest Agent" first or pick an agent manually', 'warning');
    return;
  }
  const btn = document.querySelector('button[onclick="routeTask()"]');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Routing...'; }
  try {
    const data = await api.routeTask(task, agent);
    showToast(`✅ Task routed to ${agent}`, 'success');
    const result = document.getElementById('routerResult');
    result.innerHTML += `
      <div class="card" style="margin-top:8px;border-color:var(--green)">
        <div style="display:flex;align-items:center;gap:12px">
          <span style="font-size:24px">✅</span>
          <div>
            <div style="font-weight:600">Task Routed</div>
            <div class="text-muted text-sm">${data.message}</div>
          </div>
        </div>
      </div>
    `;
  } catch (err) {
    showToast('Routing failed: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🚀 Route Task'; }
  }
}
