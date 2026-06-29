async function renderDashboard() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h1 class="page-title">Dashboard</h1>
        <p class="page-subtitle">Agentic OS system overview</p>
      </div>
      <div class="btn-group">
        <button class="btn btn-primary" onclick="runQuickSkill()">▶ Quick Run</button>
        <button class="btn" onclick="navigate('backups')">💾 Backup Now</button>
      </div>
    </div>
    <div id="dashStats" class="grid grid-4 mb-4"></div>
    <div class="grid grid-2">
      <div class="card">
        <div class="card-header"><span class="card-title">Agent Status</span></div>
        <div id="agentList"><div class="skeleton" style="height:100px"></div></div>
      </div>
      <div class="card">
        <div class="card-header"><span class="card-title">Recent Activity</span></div>
        <div id="recentActivity"><div class="skeleton" style="height:100px"></div></div>
      </div>
    </div>
  `;

  try {
    const [status, skills, audit] = await Promise.all([
      api.getStatus(),
      api.getSkills(),
      api.getAudit(10)
    ]);

    const agents = status.agents || [];
    const skillsCount = status.skills_count || 0;
    const entries = audit.entries || [];
    const online = agents.filter(a => a.status === 'online').length;

    document.getElementById('dashStats').innerHTML = `
      <div class="card stat-card">
        <div class="stat-icon purple">⬡</div>
        <div class="stat-value">${skillsCount}</div>
        <div class="stat-label">Skills Installed</div>
        <div class="stat-change up">↑ ready to execute</div>
      </div>
      <div class="card stat-card">
        <div class="stat-icon ${online === agents.length ? 'green' : online > 0 ? 'yellow' : 'red'}">
          ${online === agents.length ? '✓' : online > 0 ? '⚠' : '✕'}
        </div>
        <div class="stat-value">${online}/${agents.length}</div>
        <div class="stat-label">Agents Online</div>
        <div class="stat-change ${online === agents.length ? 'up' : 'down'}">${online === agents.length ? 'all operational' : `${agents.length - online} offline`}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-icon blue">📋</div>
        <div class="stat-value">${entries.length}</div>
        <div class="stat-label">Recent Events</div>
        <div class="stat-change up">last ${entries.length} activities</div>
      </div>
      <div class="card stat-card">
        <div class="stat-icon yellow">⚡</div>
        <div class="stat-value">${(skills || []).filter(s => s.scores && s.scores.length > 0).length}</div>
        <div class="stat-label">Skills w/ Eval Scores</div>
        <div class="stat-change up">performance tracked</div>
      </div>
    `;

    document.getElementById('agentList').innerHTML = `
      <div class="agent-card-list">
        ${agents.map(a => {
          const sc = statusColor(a.status);
          return `<div class="agent-card">
            <div class="agent-dot ${a.status}" style="width:10px;height:10px"></div>
            <div>
              <div style="font-weight:600;font-size:13px">${a.name}</div>
              <div style="font-size:11px;color:${sc.text}">${a.status}</div>
            </div>
          </div>`;
        }).join('')}
      </div>
    `;

    document.getElementById('recentActivity').innerHTML = entries.length === 0
      ? '<div class="empty-state" style="padding:20px"><div class="empty-state-icon" style="font-size:24px">📭</div><div class="empty-state-title" style="font-size:14px">No activity yet</div></div>'
      : `<div class="event-list">${entries.slice(0, 8).map(e => `
        <div class="event-item">
          <div class="event-dot" style="background:${e.action === 'skill_run' ? 'var(--accent)' : 'var(--blue)'}"></div>
          <div class="event-content">
            <div class="event-title">${escapeHtml(e.action)}${e.skill ? `: ${escapeHtml(e.skill)}` : ''}</div>
            <div class="event-meta">${e.agent ? `via ${e.agent}` : ''} ${e.run_id ? `#${e.run_id}` : ''}</div>
          </div>
          <div class="event-time">${timeAgo(e.timestamp)}</div>
        </div>
      `).join('')}</div>`;

  } catch (err) {
    document.getElementById('dashStats').innerHTML = `<div class="card" style="grid-column:1/-1"><div class="empty-state"><div class="empty-state-icon">⚠</div><div class="empty-state-title">Connection Error</div><div class="empty-state-desc">${escapeHtml(err.message)}</div><button class="btn btn-primary mt-3" onclick="navigate('dashboard')">Retry</button></div></div>`;
  }
}

async function runQuickSkill() {
  showModal('Quick Run Skill', `
    <div class="form-group">
      <label class="form-label">Skill Name</label>
      <select id="qrSkill" class="form-select">
        <option value="">Select a skill...</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Input (optional)</label>
      <textarea id="qrInput" class="form-textarea" rows="3" placeholder="Enter input for the skill..."></textarea>
    </div>
  `, `
    <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="executeQuickRun()">▶ Run Skill</button>
  `);

  try {
    const skills = await api.getSkills();
    const select = document.getElementById('qrSkill');
    skills.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.name;
      opt.textContent = s.name.replace(/-/g, ' ');
      select.appendChild(opt);
    });
  } catch {}
}

async function executeQuickRun() {
  const name = document.getElementById('qrSkill').value;
  const input = document.getElementById('qrInput').value;
  if (!name) { showToast('Please select a skill', 'warning'); return; }
  try {
    const r = await api.runSkill(name, input);
    closeModal();
    showToast(`"${name}" dispatched to ${r.agent} #${r.run_id}`, 'success');
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}
