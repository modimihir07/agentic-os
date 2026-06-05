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
            <option value="opencode">🔧 opencode (Code/DevOps)</option>
            <option value="hermes">⚡ Hermes (Memory/Scheduling)</option>
            <option value="gemini">🧠 Gemini CLI (Research/Analysis)</option>
          </select>
        </div>
        <button class="btn btn-primary" onclick="suggestRouter()" style="margin-bottom:16px">🤖 Suggest Agent</button>
        <button class="btn btn-gradient" onclick="routeTask()" style="margin-bottom:16px">🚀 Route Task</button>
      </div>
    </div>
    <div id="routerResult"></div>
    <div class="section-title" style="margin-top:20px">Routing Rules</div>
    <div class="card">
      <table>
        <tr><th>Agent</th><th>Best For</th><th>Keywords</th></tr>
        <tr><td><strong>🔧 opencode</strong></td><td>Code, DevOps, infra, git, file operations</td><td class="text-muted text-sm">code, deploy, git, terraform, docker, test, build, script</td></tr>
        <tr><td><strong>⚡ Hermes</strong></td><td>Memory, scheduling, messaging, skills</td><td class="text-muted text-sm">memory, schedule, cron, reminder, brain, plugin, backup</td></tr>
        <tr><td><strong>🧠 Gemini CLI</strong></td><td>Research, analysis, study, document, review</td><td class="text-muted text-sm">research, analyze, search, explain, study, learn, report</td></tr>
      </table>
    </div>
  `;
}

async function suggestRouter() {
  const task = document.getElementById('routerTaskInput').value.trim();
  if (!task) { showToast('Describe your task first', 'warning'); return; }
  const btn = document.querySelector('button[onclick="suggestRouter()"]');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Thinking...'; }
  try {
    const data = await api.suggestRouter(task);
    const result = document.getElementById('routerResult');
    const agentIcons = { opencode: '🔧', hermes: '⚡', gemini: '🧠' };
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
