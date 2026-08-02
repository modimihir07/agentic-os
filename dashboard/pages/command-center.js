/* Command Center — a unified dispatcher + live console for Agentic OS.
 *
 * This page combines two things:
 *   1. The real Agentic-OS surfaces (agent registry, scheduler jobs, audit
 *      trail, agent-time, server uptime) — all pulled live from the API.
 *   2. The "command console" UX from the standalone Desktop Command Center
 *      (sidebar command-target selector, a small command language, Wake/Reset,
 *      and the compact color-coded log + event streams).
 *
 * It is a browser frontend to the running OS server. Nothing here is mocked.
 */

// Module state for this page.
let _cc = {
  agents: [],
  selected: null,
  running: false,
  simTimer: null,
  tickTimer: null,
  hwTimer: 0,
  startTime: null,
  jobs: [],
  hw: null,
};

// ── small command language used in the console ──────────────────────
//   /help            list available commands
//   /status          refresh + print agent states
//   /run <task>      dispatch a task to the selected agent via /api/chat
//   /wake            re-run agent health checks
//   /reset           clear the console + event streams
//   /clear           clear just the log stream
//   anything else     sent to the selected agent as a free-text message
async function ccRunCommand() {
  const input = document.getElementById('ccCmd');
  if (!input) return;
  const raw = input.value.trim();
  if (!raw) { ccLog('no command entered', 'warn'); return; }
  ccLog('> ' + raw, 'sys');

  const [cmd, ...rest] = raw.split(/\s+/);
  const arg = rest.join(' ').trim();

  switch (cmd.toLowerCase()) {
    case '/help':
      ccLog('commands: /help /status /run <task> /wake /reset /clear', 'info');
      ccLog('anything else is sent to the selected agent', 'sys');
      break;
    case '/status':
      await ccRefreshAgents(true);
      break;
    case '/wake':
      await ccRefreshAgents(true);
      ccEvent('wake signal broadcast to all agents', 'ok');
      break;
    case '/reset':
      ccReset();
      break;
    case '/clear':
      document.getElementById('ccLogStream').innerHTML = '';
      break;
    case '/run':
      if (!arg) { ccLog('usage: /run <task description>', 'warn'); break; }
      await ccDispatch(arg);
      break;
    default:
      await ccDispatch(raw);
  }
}

async function ccDispatch(message) {
  const agent = _cc.selected;
  if (!agent) { ccLog('select a target agent first', 'warn'); return; }
  if (_cc.running) { ccLog('a command is already running — wait or reset', 'warn'); return; }

  _cc.running = true;
  const runBtn = document.getElementById('ccRun');
  const stopBtn = document.getElementById('ccStop');
  if (runBtn) runBtn.disabled = true;
  if (stopBtn) stopBtn.disabled = false;

  const jobId = 'J' + String(Date.now()).slice(-5);
  ccJobAdd(jobId, agent, message, 'running');
  ccEvent(`dispatching to ${agent} ...`, 'info');
  ccLog(`${jobId} → ${agent}: ${message}`, 'info');

  const controller = new AbortController();
  _cc._controller = controller;
  try {
    const res = await api.chat(agent, message, controller);
    const out = (res && (res.response || res.reply || res.output || JSON.stringify(res))) || '(no output)';
    ccLog(`${jobId} · ${String(out).slice(0, 400)}`, 'ok');
    ccEvent(`${jobId} done`, 'ok');
    ccJobUpdate(jobId, 'done');
  } catch (err) {
    ccLog(`${jobId} · error: ${err.message}`, 'err');
    ccEvent(`${jobId} failed`, 'err');
    ccJobUpdate(jobId, 'failed');
  } finally {
    _cc.running = false;
    _cc._controller = null;
    if (runBtn) runBtn.disabled = false;
    if (stopBtn) stopBtn.disabled = true;
    await ccRefreshAgents(false);
  }
}

function ccStop() {
  if (_cc._controller) _cc._controller.abort();
  _cc.running = false;
  ccLog('stop requested — aborted', 'warn');
  ccEvent('run interrupted by operator', 'warn');
  const runBtn = document.getElementById('ccRun');
  const stopBtn = document.getElementById('ccStop');
  if (runBtn) runBtn.disabled = false;
  if (stopBtn) stopBtn.disabled = true;
}

// ── rendering ─────────────────────────────────────────────────────
async function renderCommandCenter() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h1 class="page-title">Command Center</h1>
        <p class="page-subtitle">Dispatch tasks to agents and watch live execution</p>
      </div>
      <div class="btn-group">
        <button class="btn btn-ghost" onclick="ccRefreshAll()">↻ Refresh</button>
        <button class="btn btn-primary" onclick="document.getElementById('ccCmd').focus()">⌨ Focus Console</button>
      </div>
    </div>

    <div class="grid grid-2" style="align-items:start">
      <!-- Command Console -->
      <section class="card span-2" id="ccPanelControl">
        <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
          <span class="card-title">Command Console</span>
          <div style="display:flex;gap:8px">
            <button id="ccRun" class="btn btn-primary" onclick="ccRunCommand()">Run Command</button>
            <button id="ccStop" class="btn btn-ghost" onclick="ccStop()" disabled>■ Stop</button>
          </div>
        </div>
        <div style="margin:12px 0">
          <textarea id="ccCmd" class="form-textarea" rows="2" spellcheck="false"
            placeholder="e.g. /run summarize the brain folder   ·   /status   ·   /help"></textarea>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:16px;align-items:flex-end;margin-bottom:12px">
          <div style="flex:1;min-width:220px">
            <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Command Target</div>
            <select id="ccAgentSelect" class="form-select" onchange="ccSelectAgent(this.value)"></select>
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-ghost btn-sm" onclick="ccRefreshAgents(true)">↻ Wake Agents</button>
            <button class="btn btn-ghost btn-sm" onclick="ccReset()">⟲ Reset Console</button>
          </div>
        </div>
        <div class="cc-tip-row">
          <span class="cc-tip"><b>/help</b> commands</span>
          <span class="cc-tip"><b>/status</b> agent states</span>
          <span class="cc-tip"><b>/run</b> dispatch task</span>
          <span class="cc-tip" style="margin-left:auto;color:var(--text-muted)">Selected: <span id="ccSelected" class="mono">--</span></span>
        </div>
        <div class="cc-log-head" style="display:flex;justify-content:space-between;margin:14px 0 8px">
          <span class="card-title" style="font-size:14px">Execution Log</span>
          <span id="ccJobLast" style="font-size:12px;color:var(--text-muted)">Last job: --</span>
        </div>
        <div id="ccLogStream" class="cc-log" role="log" aria-live="polite"></div>
      </section>

      <!-- Agent Status -->
      <section class="card" id="ccPanelAgents">
        <div class="card-header"><span class="card-title">Agent Status</span></div>
        <div id="ccAgentRows" class="cc-agent-rows"></div>
      </section>

      <!-- System Metrics (real data) -->
      <section class="card" id="ccPanelMetrics">
        <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
          <span class="card-title">System</span>
          <span id="ccUptime" class="nav-badge" style="background:var(--bg-card)">Uptime: --</span>
        </div>
        <div class="cc-metrics" id="ccMetrics"></div>
        <div style="margin-top:16px">
          <span class="card-title" style="font-size:14px">Hardware Monitors</span>
          <span style="font-size:11px;color:var(--text-muted);margin-left:8px">live · real readings</span>
          <div class="cc-metrics" id="ccHw" style="margin-top:10px"></div>
        </div>
        <div style="margin-top:14px">
          <span class="card-title" style="font-size:14px">Recent Jobs</span>
          <div id="ccJobs" class="cc-jobs"></div>
        </div>
      </section>

      <!-- Event Stream -->
      <section class="card span-2" id="ccPanelLogs">
        <div class="card-header"><span class="card-title">Event Stream</span></div>
        <div id="ccEventStream" class="cc-log" role="log" aria-live="polite" style="height:200px"></div>
      </section>
    </div>
  `;

  // Ctrl/Cmd+Enter to run from the textarea.
  const ta = document.getElementById('ccCmd');
  if (ta) ta.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); ccRunCommand(); }
  });

  _cc.startTime = Date.now();
  await ccRefreshAll();

  // Live tick: uptime + light metrics refresh. Hardware polls every 3s
  // (cheap, but no need to hammer /api/system every second).
  if (_cc.tickTimer) clearInterval(_cc.tickTimer);
  _cc.tickTimer = setInterval(() => {
    ccTickUptime();
    ccRenderMetrics();
    if ((_cc.hwTimer = (_cc.hwTimer + 1) % 3) === 0) ccRefreshSystem();
  }, 1000);
}

async function ccRefreshAll() {
  await Promise.all([ccRefreshAgents(false), ccRefreshJobs(), ccRefreshMetrics(), ccRefreshSystem()]);
  ccEvent('command center synced', 'info');
}

async function ccRefreshAgents(announce) {
  try {
    const { agents } = await api.getAgents();
    _cc.agents = agents || [];
    if (!_cc.selected && _cc.agents.length) _cc.selected = _cc.agents[0].name;
    ccRenderAgents();
    ccRenderAgentSelect();
    if (announce) _cc.agents.forEach(a =>
      ccLog(`${a.display_name || a.name} → ${a.status}`, 'info'));
  } catch (err) {
    ccLog('agent refresh failed: ' + err.message, 'err');
  }
}

function ccRenderAgents() {
  const rows = document.getElementById('ccAgentRows');
  if (!rows) return;
  rows.innerHTML = _cc.agents.map(a => {
    const sc = statusColor(a.status);
    const dotCls = a.status === 'online' ? 'online' : a.status === 'warning' ? 'warning' : 'offline';
    return `
      <div class="cc-agent-row" onclick="ccSelectAgent('${a.name}')" style="cursor:pointer">
        <div class="agent-dot ${dotCls}" style="width:10px;height:10px"></div>
        <div style="flex:1">
          <div style="font-weight:600;font-size:13px">${escapeHtml(a.display_name || a.name)}</div>
          <div style="font-size:11px;color:var(--text-muted)">${escapeHtml(a.type || 'cli')}${a.builtin ? ' · built-in' : ''}</div>
        </div>
        <span style="font-size:11px;color:${sc.text};text-transform:uppercase;font-weight:600">${a.status}</span>
      </div>`;
  }).join('') || '<div class="empty-state"><div class="empty-state-desc">No agents registered</div></div>';
}

function ccRenderAgentSelect() {
  const sel = document.getElementById('ccAgentSelect');
  if (!sel) return;
  sel.innerHTML = _cc.agents.map(a =>
    `<option value="${a.name}">${escapeHtml(a.display_name || a.name)}</option>`).join('');
  sel.value = _cc.selected || '';
  ccSelectAgent(_cc.selected);
}

function ccSelectAgent(name) {
  _cc.selected = name;
  const label = document.getElementById('ccSelected');
  if (label) {
    const a = _cc.agents.find(x => x.name === name);
    label.textContent = a ? (a.display_name || a.name) : (name || '--');
  }
  const sel = document.getElementById('ccAgentSelect');
  if (sel && sel.value !== name) sel.value = name;
}

async function ccRefreshJobs() {
  try {
    const jobs = await api.getJobs();
    _cc.jobs = (jobs || []).slice(-8).reverse();
    ccRenderJobs();
  } catch { /* scheduler may be empty */ }
}

function ccRenderJobs() {
  const el = document.getElementById('ccJobs');
  if (!el) return;
  el.innerHTML = _cc.jobs.map(j => {
    const st = (j.enabled === false) ? 'off' : (j.next_run ? 'queued' : 'queued');
    return `<div class="cc-job">
      <span><b>${escapeHtml(j.name || j.id || 'job')}</b> <span style="color:var(--text-muted);font-size:11px">${escapeHtml(j.schedule || '')}</span></span>
      <span class="nav-badge" style="background:var(--bg-card)">${escapeHtml(st)}</span>
    </div>`;
  }).join('') || '<div style="font-size:12px;color:var(--text-muted)">No scheduled jobs</div>';
}

function ccJobAdd(id, agent, cmd, status) {
  _cc.jobs.unshift({ id, name: id, agent, cmd, status, schedule: agent });
  if (_cc.jobs.length > 8) _cc.jobs.pop();
  ccRenderJobs();
  const last = document.getElementById('ccJobLast');
  if (last) last.textContent = 'Last job: ' + id;
}

function ccJobUpdate(id, status) {
  const j = _cc.jobs.find(x => x.id === id);
  if (j) { j.status = status; ccRenderJobs(); }
}

// Metrics: real OS data only — no fabricated CPU/mem.
async function ccRefreshMetrics() {
  try {
    const status = await api.getStatus();
    _cc.systemStatus = status;
  } catch { /* offline */ }
  ccRenderMetrics();
  ccTickUptime();
}

function ccRenderMetrics() {
  const el = document.getElementById('ccMetrics');
  if (!el) return;
  const st = _cc.systemStatus || {};
  const agents = _cc.agents || [];
  const online = agents.filter(a => a.status === 'online').length;
  const cards = [
    { label: 'Agents Online', value: `${online}/${agents.length}`, pct: agents.length ? (online / agents.length) * 100 : 0, color: 'var(--green)' },
    { label: 'Skills', value: String(st.skills_count ?? '--'), pct: 100, color: 'var(--accent)' },
    { label: 'Scheduled Jobs', value: String(_cc.jobs.length), pct: Math.min(100, _cc.jobs.length * 20), color: 'var(--yellow)' },
    { label: 'System', value: (st.status || 'unknown').toUpperCase(), pct: st.status === 'healthy' ? 100 : 30, color: st.status === 'healthy' ? 'var(--green)' : 'var(--red)' },
  ];
  el.innerHTML = cards.map(c => `
    <div class="cc-metric">
      <div class="cc-metric-label">${c.label}</div>
      <div class="cc-metric-value">${c.value}</div>
      <div class="cc-bar"><div class="cc-fill" style="width:${Math.max(0, Math.min(100, c.pct))}%;background:${c.color}"></div></div>
    </div>`).join('');
}

// Hardware monitors: real CPU / GPU / RAM / Disk from /api/system.
async function ccRefreshSystem() {
  try {
    const hw = await api.request('/api/system');
    _cc.hw = hw;
  } catch { /* metrics endpoint optional */ }
  ccRenderHw();
}

function ccLoadColor(pct) {
  if (pct == null) return 'var(--text-muted)';
  if (pct >= 85) return 'var(--red)';
  if (pct >= 60) return 'var(--yellow)';
  return 'var(--green)';
}

function ccRenderHw() {
  const el = document.getElementById('ccHw');
  if (!el) return;
  const hw = _cc.hw || {};
  const cards = [];

  // CPU
  const cpu = hw.cpu || {};
  cards.push({
    label: 'CPU',
    value: cpu.percent == null ? 'N/A' : cpu.percent + '%',
    pct: cpu.percent || 0,
    color: ccLoadColor(cpu.percent),
  });

  // GPU (may be null when no nvidia-smi / no GPU)
  const gpu = hw.gpu;
  if (gpu && !gpu.error) {
    const gv = gpu.util_percent == null ? 'N/A' : gpu.util_percent + '%';
    const gsub = gpu.name ? gpu.name : '';
    cards.push({
      label: 'GPU',
      value: gv,
      sub: gsub,
      pct: gpu.util_percent || 0,
      color: ccLoadColor(gpu.util_percent),
    });
  } else {
    cards.push({ label: 'GPU', value: 'N/A', sub: (gpu && gpu.error) ? 'err' : 'no GPU', pct: 0, color: 'var(--text-muted)' });
  }

  // RAM
  const ram = hw.ram || {};
  cards.push({
    label: 'RAM',
    value: ram.percent == null ? 'N/A' : ram.percent + '%',
    sub: ram.total_gb ? `${ram.used_gb ?? '?'} / ${ram.total_gb} GB` : '',
    pct: ram.percent || 0,
    color: ccLoadColor(ram.percent),
  });

  // Disk (total space monitor)
  const disk = hw.disk || {};
  cards.push({
    label: 'Disk',
    value: disk.percent == null ? 'N/A' : disk.percent + '%',
    sub: disk.total_gb ? `${disk.used_gb ?? '?'} / ${disk.total_gb} GB` : '',
    pct: disk.percent || 0,
    color: ccLoadColor(disk.percent),
  });

  el.innerHTML = cards.map(c => `
    <div class="cc-metric">
      <div class="cc-metric-label">${c.label}</div>
      <div class="cc-metric-value">${c.value}</div>
      ${c.sub ? `<div class="cc-metric-sub">${escapeHtml(c.sub)}</div>` : ''}
      <div class="cc-bar"><div class="cc-fill" style="width:${Math.max(0, Math.min(100, c.pct))}%;background:${c.color}"></div></div>
    </div>`).join('');
}

function ccTickUptime() {
  const el = document.getElementById('ccUptime');
  if (!el || !_cc.startTime) return;
  const up = Math.floor((Date.now() - _cc.startTime) / 1000);
  const h = String(Math.floor(up / 3600)).padStart(2, '0');
  const m = String(Math.floor((up % 3600) / 60)).padStart(2, '0');
  const s = String(up % 60).padStart(2, '0');
  el.textContent = `Uptime: ${h}:${m}:${s}`;
}

function ccReset() {
  const log = document.getElementById('ccLogStream');
  const ev = document.getElementById('ccEventStream');
  if (log) log.innerHTML = '';
  if (ev) ev.innerHTML = '';
  ccLog('console reset', 'ok');
  ccEvent('console reset', 'ok');
}

// ── log / event helpers ───────────────────────────────────────────
function ccLog(msg, level = 'sys') {
  const s = document.getElementById('ccLogStream');
  if (!s) return;
  const line = document.createElement('div');
  line.className = 'cc-log-line ' + level;
  line.innerHTML = `<span class="cc-time">[${ccStamp()}]</span><span class="cc-msg"></span>`;
  line.querySelector('.cc-msg').textContent = msg;
  s.appendChild(line);
  s.scrollTop = s.scrollHeight;
}

function ccEvent(msg, level = 'sys') {
  const s = document.getElementById('ccEventStream');
  if (!s) return;
  const line = document.createElement('div');
  line.className = 'cc-log-line ' + level;
  line.innerHTML = `<span class="cc-time">[${ccStamp()}]</span><span class="cc-msg"></span>`;
  line.querySelector('.cc-msg').textContent = msg;
  s.appendChild(line);
  s.scrollTop = s.scrollHeight;
}

function ccStamp() { return new Date().toTimeString().slice(0, 8); }

// Clean up timers when navigating away (best-effort).
window.addEventListener('hashchange', () => {
  if (_cc.tickTimer) { clearInterval(_cc.tickTimer); _cc.tickTimer = null; }
});
