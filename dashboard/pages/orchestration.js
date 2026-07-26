// Multi-Agent Orchestration — fan-out N agents on one goal, then converge.

async function renderOrchestration() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h1 class="page-title">Multi-Agent Run</h1>
        <p class="page-subtitle">Spin up opencode, Gemini & Hermes on the same goal from different angles, then converge</p>
      </div>
    </div>
    <div class="card mb-4">
      <div class="page-subtitle" style="margin-bottom:8px">New orchestration run</div>
      <label class="form-label">Project goal</label>
      <textarea id="orchGoal" class="form-input" rows="3" placeholder="e.g. Build a real-time sync layer between the dashboard and the brain index"></textarea>
      <details class="mt-2">
        <summary style="cursor:pointer;font-size:12px;color:var(--text-muted)">Customize angles (optional)</summary>
        <div class="mt-2">
          <label class="form-label">opencode angle</label>
          <input id="orchOpencode" class="form-input mb-2" placeholder="implementation focus" />
          <label class="form-label">gemini angle</label>
          <input id="orchGemini" class="form-input mb-2" placeholder="research focus" />
          <label class="form-label">hermes angle</label>
          <input id="orchHermes" class="form-input" placeholder="coordination focus" />
        </div>
      </details>
      <button class="btn btn-primary mt-3" id="orchRunBtn" onclick="orchRun()">🚀 Launch agents</button>
    </div>
    <div id="orchResult"></div>
    <div class="page-subtitle mt-4">Past runs</div>
    <div id="orchRuns"></div>
  `;
  await orchLoadRuns();
}

async function orchLoadRuns() {
  const box = document.getElementById('orchRuns');
  try {
    const d = await api.getOrchestrationRuns(30);
    if (!d.runs.length) { box.innerHTML = '<div class="empty-state"><div class="empty-state-title">No runs yet</div></div>'; return; }
    box.innerHTML = d.runs.map(r => `
      <div class="card mb-2" style="border-left:4px solid var(--accent)">
        <div class="flex items-center gap-2">
          <strong style="font-size:13px">${escapeHtml(r.goal || '(no goal)')}</strong>
          <span class="badge" style="font-size:10px">${escapeHtml((r.agents||[]).join(' + '))}</span>
          <span class="badge badge-accent" style="font-size:10px">→ ${escapeHtml(r.converge_agent||'')}</span>
        </div>
        <div style="font-size:11px;color:var(--text-muted)">${escapeHtml(r.run_id||'')} · ${escapeHtml(r.timestamp||'')}</div>
      </div>`).join('');
  } catch (e) {
    box.innerHTML = `<div class="empty-state"><div class="empty-state-title">Could not load runs</div></div>`;
  }
}

async function orchRun() {
  const goal = document.getElementById('orchGoal').value.trim();
  const btn = document.getElementById('orchRunBtn');
  if (!goal) { alert('Enter a project goal first.'); return; }
  const angles = {};
  const oc = document.getElementById('orchOpencode').value.trim();
  const gm = document.getElementById('orchGemini').value.trim();
  const hm = document.getElementById('orchHermes').value.trim();
  if (oc) angles.opencode = oc;
  if (gm) angles.gemini = gm;
  if (hm) angles.hermes = hm;
  btn.disabled = true; btn.textContent = 'Running agents…';
  const res = document.getElementById('orchResult');
  res.innerHTML = '<div class="loading"><div class="loading-spinner"></div><span>Fanning out agents & converging…</span></div>';
  try {
    const data = await api.orchestrate({ goal, angles: Object.keys(angles).length ? angles : undefined });
    const cards = (data.outputs && Object.entries(data.outputs) || [])
      .map(([a, o]) => `
        <div class="card mb-2">
          <div class="flex items-center gap-2 mb-1"><span class="badge badge-accent" style="font-size:10px">${escapeHtml(a)}</span><span style="font-size:11px;color:var(--text-muted)">angle output</span></div>
          <div style="font-size:12px;white-space:pre-wrap;max-height:240px;overflow:auto">${escapeHtml((o||'').slice(0,2000))}</div>
        </div>`).join('');
    res.innerHTML = `
      <div class="card mb-3" style="border-left:4px solid var(--accent)">
        <div class="page-subtitle">✅ Synthesis (via ${escapeHtml(data.converge_agent||'')})</div>
        <div style="font-size:13px;white-space:pre-wrap">${escapeHtml(data.synthesis || '(no synthesis)')}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:6px">run_id: ${escapeHtml(data.run_id||'')} · saved to ${escapeHtml(data.run_file||'')}</div>
      </div>
      <details><summary style="cursor:pointer;font-size:12px;color:var(--text-muted)">Show per-agent angle outputs</summary>
        <div class="mt-2">${cards}</div>
      </details>`;
    await orchLoadRuns();
  } catch (e) {
    res.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠</div><div class="empty-state-title">Orchestration failed</div><div class="empty-state-desc">${escapeHtml(e.message)}</div></div>`;
  } finally {
    btn.disabled = false; btn.textContent = '🚀 Launch agents';
  }
}
