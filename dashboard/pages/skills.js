async function renderSkills() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h1 class="page-title">Skills Hub</h1>
        <p class="page-subtitle">Browse, run, and monitor skill performance</p>
      </div>
      <div class="btn-group">
        <input id="skillFilter" class="form-input" style="width:200px" placeholder="Filter skills..." oninput="filterSkills()">
        <button class="btn btn-primary" onclick="showAddSkill()">+ New Skill</button>
      </div>
    </div>
    <div class="tabs" id="skillTabs">
      <button class="tab active" data-view="grid" onclick="switchSkillView('grid')">📊 Grid</button>
      <button class="tab" data-view="list" onclick="switchSkillView('list')">📋 List</button>
    </div>
    <div id="skillsContainer"><div class="loading"><div class="loading-spinner"></div></div></div>
    <div id="skillDetail" style="display:none"></div>
  `;

  try {
    const skills = await api.getSkills();
    window._allSkills = skills;
    renderSkillGrid(skills);
  } catch (err) {
    document.getElementById('skillsContainer').innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠</div><div class="empty-state-title">${escapeHtml(err.message)}</div></div>`;
  }
}

function renderSkillGrid(skills) {
  const container = document.getElementById('skillsContainer');
  if (!skills || skills.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">⚡</div><div class="empty-state-title">No skills installed</div></div>';
    return;
  }
  container.innerHTML = `<div class="grid grid-3" id="skillGrid">${skills.map(s => {
    const lastScore = s.scores && s.scores.length > 0 ? s.scores[s.scores.length - 1] : null;
    const avg = lastScore && lastScore.criteria_scores ? (lastScore.criteria_scores.reduce((a, b) => a + b, 0) / lastScore.criteria_scores.length) : null;
    const icons = ['⚡', '🔧', '📝', '🔍', '🔄', '🎯', '📊', '🛠', '💡', '🧪', '📋', '💾', '💰', '🔄', '🎨'];
    const iconIdx = s.name.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % icons.length;
    const icon = icons[iconIdx];
    return `<div class="skill-card" onclick="showSkillDetail('${s.name}')">
      <div class="skill-card-header">
        <div class="skill-card-icon">${icon}</div>
        <div class="skill-card-name">${s.name.replace(/-/g, ' ')}</div>
      </div>
      <div class="skill-card-desc">${s.description ? s.description.slice(0, 120) + (s.description.length > 120 ? '...' : '') : 'No description'}</div>
      <div class="skill-card-footer">
        ${avg !== null ? `<span class="badge badge-success">${(avg * 100).toFixed(0)}%</span>` : '<span class="badge badge-info">New</span>'}
        ${s.has_learnings ? '<span class="badge badge-accent">📖</span>' : ''}
        <button class="btn btn-sm btn-primary" style="margin-left:auto" onclick="event.stopPropagation();quickRunSkill('${s.name}')">▶ Run</button>
      </div>
    </div>`;
  }).join('')}</div>`;
}

function switchSkillView(view) {
  document.querySelectorAll('#skillTabs .tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  if (view === 'list') {
    const skills = window._allSkills || [];
    document.getElementById('skillsContainer').innerHTML = `<div class="table-wrapper"><table><thead><tr><th>Skill</th><th>Score</th><th>Learnings</th><th></th></tr></thead><tbody>${skills.map(s => {
      const lastScore = s.scores && s.scores.length > 0 ? s.scores[s.scores.length - 1] : null;
      const avg = lastScore && lastScore.criteria_scores ? (lastScore.criteria_scores.reduce((a, b) => a + b, 0) / lastScore.criteria_scores.length) : null;
      return `<tr onclick="showSkillDetail('${s.name}')" style="cursor:pointer">
        <td><strong>${s.name.replace(/-/g, ' ')}</strong></td>
        <td>${avg !== null ? `<span class="badge badge-success">${(avg * 100).toFixed(0)}%</span>` : '<span class="badge badge-info">—</span>'}</td>
        <td>${s.has_learnings ? '<span class="badge badge-accent">✓</span>' : '<span class="badge">—</span>'}</td>
        <td><button class="btn btn-sm btn-primary" onclick="event.stopPropagation();quickRunSkill('${s.name}')">▶</button></td>
      </tr>`;
    }).join('')}</tbody></table></div>`;
  } else {
    renderSkillGrid(window._allSkills || []);
  }
}

function filterSkills() {
  const q = document.getElementById('skillFilter').value.toLowerCase();
  const skills = (window._allSkills || []).filter(s => s.name.toLowerCase().includes(q));
  renderSkillGrid(skills);
}

async function showSkillDetail(name) {
  document.getElementById('skillsContainer').style.display = 'none';
  document.getElementById('skillTabs').style.display = 'none';
  document.getElementById('skillFilter').style.display = 'none';
  const detail = document.getElementById('skillDetail');
  detail.style.display = 'block';
  detail.innerHTML = `<div class="loading"><div class="loading-spinner"></div></div>`;

  try {
    const skill = await api.getSkill(name);
    const scores = skill.score_history || [];
    const lastScore = scores.length > 0 ? scores[scores.length - 1] : null;
    const avg = lastScore && lastScore.criteria_scores ? (lastScore.criteria_scores.reduce((a, b) => a + b, 0) / lastScore.criteria_scores.length) : null;

    window._currentSkillName = name;

    detail.innerHTML = `
      <div style="margin-bottom:16px">
        <button class="btn btn-ghost" onclick="backToSkills()">← Back to Skills</button>
        <button class="btn btn-primary" style="margin-left:8px" onclick="quickRunSkill('${name}')">▶ Run ${name.replace(/-/g, ' ')}</button>
      </div>
      <div class="grid grid-2">
        <div class="card">
          <div class="card-header">
            <span class="card-title">📄 SKILL.md</span>
            <button class="btn btn-sm btn-ghost" style="margin-left:auto" onclick="editSkillMd('${name}')">✎ Edit</button>
          </div>
          <pre id="skillMdView" style="max-height:400px;overflow:auto;font-size:12px">${escapeHtml(skill.skill || 'No SKILL.md')}</pre>
        </div>
        <div class="card">
          <div class="card-header"><span class="card-title">📖 Learnings</span></div>
          <pre style="max-height:400px;overflow:auto;font-size:12px">${escapeHtml(skill.learnings || 'No learnings yet')}</pre>
        </div>
      </div>
      <div class="grid grid-2 mt-3">
        <div class="card">
          <div class="card-header"><span class="card-title">📊 Performance</span></div>
          ${scores.length > 0 ? `
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
              ${scores.slice(-10).map(s => `<span class="badge ${(s.total_score || 0) > 0.7 ? 'badge-success' : 'badge-warning'}">${((s.total_score || 0) * 100).toFixed(0)}%</span>`).join('')}
            </div>
            <div class="progress-bar"><div class="progress-fill" style="width:${(avg || 0) * 100}%"></div></div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:6px">Average: ${avg !== null ? (avg * 100).toFixed(0) : 'N/A'}% (${scores.length} runs)</div>
          ` : '<div style="color:var(--text-muted);font-size:13px">No evaluation scores yet</div>'}
        </div>
        <div class="card">
          <div class="card-header">
            <span class="card-title">📁 Context Files</span>
            <button class="btn btn-sm btn-ghost" style="margin-left:auto" onclick="addSkillContextFile('${name}')">+ Add File</button>
          </div>
          <div id="skillContextList">
            ${skill.context && skill.context.length > 0
              ? skill.context.map(f => `
                <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px">
                  <span style="flex:1">${escapeHtml(f)}</span>
                  <button class="btn btn-sm btn-ghost" onclick="editSkillContextFile('${name}','${escapeHtml(f)}')">✎</button>
                  <button class="btn btn-sm btn-ghost" style="color:var(--red)" onclick="deleteSkillContextFile('${name}','${escapeHtml(f)}')">🗑</button>
                </div>`).join('')
              : '<div style="color:var(--text-muted);font-size:13px">No context files</div>'}
          </div>
          ${skill.eval && skill.eval.criteria ? `<div style="margin-top:12px"><strong style="font-size:12px">Eval Criteria:</strong><div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">${skill.eval.criteria.map(c => `<span class="badge badge-accent">${c}</span>`).join('')}</div></div>` : ''}
        </div>
      </div>
    `;
  } catch (err) {
    detail.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠</div><div class="empty-state-title">Error</div><div class="empty-state-desc">${escapeHtml(err.message)}</div><button class="btn btn-primary mt-3" onclick="backToSkills()">Back</button></div>`;
  }
}

function backToSkills() {
  document.getElementById('skillsContainer').style.display = '';
  document.getElementById('skillTabs').style.display = '';
  document.getElementById('skillFilter').style.display = '';
  document.getElementById('skillDetail').style.display = 'none';
}

async function quickRunSkill(name) {
  const displayName = name.replace(/-/g, ' ');
  showModal(`Run: ${displayName}`, `
    <div class="form-group">
      <label class="form-label">Input (optional)</label>
      <textarea id="qrsInput" class="form-textarea" rows="3" placeholder="Enter input for ${displayName}..."></textarea>
    </div>
    <div class="form-group">
      <label class="form-label">Agent</label>
      <select id="qrsAgent" class="form-select">
        <option value="auto">Auto-detect</option>
        <option value="opencode">opencode</option>
        <option value="hermes">Hermes</option>
        <option value="gemini">Gemini CLI</option>
      </select>
    </div>
    <div id="skillResult" style="display:none"></div>
  `, `
    <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="executeSkillRun('${name}')">▶ Run</button>
  `);
}

async function executeSkillRun(name) {
  const input = document.getElementById('qrsInput').value;
  const agent = document.getElementById('qrsAgent').value;
  const runBtn = document.querySelector('#modalContainer .btn-primary');
  const resultArea = document.getElementById('skillResult');

  if (runBtn) { runBtn.disabled = true; runBtn.textContent = '⏳ Running...'; }
  if (resultArea) {
    resultArea.style.display = 'block';
    resultArea.innerHTML = '<div class="loading" style="padding:20px"><div class="loading-spinner"></div><span style="margin-left:8px">Executing skill...</span></div>';
  }

  try {
    const r = await api.runSkill(name, input, agent);
    if (resultArea) {
      const outputText = r.output || '(no output)';
      resultArea.innerHTML = `
        <div class="card" style="margin-top:8px">
          <div class="card-header" style="border-color:var(--green-dim)">
            <span class="card-title" style="color:var(--green)">✓ Completed — ${r.agent} #${r.run_id}</span>
          </div>
          <pre style="max-height:400px;overflow:auto;font-size:12px;white-space:pre-wrap;margin:0;padding:12px;background:var(--bg-code, #1a1a2e);border-radius:0 0 8px 8px">${escapeHtml(outputText)}</pre>
        </div>`;
    }
    if (runBtn) { runBtn.textContent = '✓ Done'; runBtn.disabled = false; }
  } catch (err) {
    if (resultArea) {
      resultArea.innerHTML = `<div class="empty-state" style="padding:20px"><div class="empty-state-icon">⚠</div><div class="empty-state-title">Error</div><div class="empty-state-desc">${escapeHtml(err.message)}</div></div>`;
    }
    if (runBtn) { runBtn.textContent = '▶ Run'; runBtn.disabled = false; }
  }
}

function showAddSkill() {
  showModal('New Skill', `
    <div class="form-group">
      <label class="form-label">Name</label>
      <input id="newSkillName" class="form-input" placeholder="e.g., my-custom-skill">
      <div class="form-hint">Letters, numbers, dashes and underscores only.</div>
    </div>
    <div class="form-group">
      <label class="form-label">SKILL.md</label>
      <textarea id="newSkillMd" class="form-textarea" rows="12" placeholder="# My Custom Skill&#10;&#10;Describe what this skill does and how an agent should perform it..."></textarea>
    </div>
  `, `
    <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="submitNewSkill()">Create Skill</button>
  `);
}

async function submitNewSkill() {
  const name = document.getElementById('newSkillName').value.trim();
  const skillMd = document.getElementById('newSkillMd').value;
  if (!name) { showToast('Skill name is required', 'error'); return; }
  try {
    await api.createSkill(name, skillMd);
    showToast('Skill created!', 'success');
    closeModal();
    await renderSkills();
    showSkillDetail(name);
  } catch (err) {
    showToast('Failed to create skill: ' + err.message, 'error');
  }
}

function editSkillMd(name) {
  const view = document.getElementById('skillMdView');
  const current = view ? view.textContent : '';
  view.outerHTML = `
    <textarea id="skillMdEdit" class="form-textarea" rows="16" style="font-family:var(--font-mono);font-size:12px">${escapeHtml(current)}</textarea>
    <div style="display:flex;gap:8px;margin-top:8px">
      <button class="btn btn-sm btn-primary" onclick="saveSkillMd('${name}')">Save</button>
      <button class="btn btn-sm btn-ghost" onclick="showSkillDetail('${name}')">Cancel</button>
    </div>
  `;
}

async function saveSkillMd(name) {
  const content = document.getElementById('skillMdEdit').value;
  try {
    await api.updateSkill(name, content);
    showToast('SKILL.md saved', 'success');
    showSkillDetail(name);
  } catch (err) {
    showToast('Failed to save: ' + err.message, 'error');
  }
}

function addSkillContextFile(name) {
  showModal('Add Context File', `
    <div class="form-group">
      <label class="form-label">File Name</label>
      <input id="newContextFilename" class="form-input" placeholder="e.g., reference.md">
    </div>
    <div class="form-group">
      <label class="form-label">Content</label>
      <textarea id="newContextContent" class="form-textarea" rows="10"></textarea>
    </div>
  `, `
    <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="submitNewContextFile('${name}')">Add File</button>
  `);
}

async function submitNewContextFile(name) {
  const filename = document.getElementById('newContextFilename').value.trim();
  const content = document.getElementById('newContextContent').value;
  if (!filename) { showToast('File name is required', 'error'); return; }
  try {
    await api.putSkillContextFile(name, filename, content);
    showToast('Context file added', 'success');
    closeModal();
    showSkillDetail(name);
  } catch (err) {
    showToast('Failed to add file: ' + err.message, 'error');
  }
}

async function editSkillContextFile(name, filename) {
  try {
    const file = await api.getSkillContextFile(name, filename);
    showModal(`Edit: ${filename}`, `
      <textarea id="editContextContent" class="form-textarea" rows="14">${escapeHtml(file.content)}</textarea>
    `, `
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveSkillContextFile('${name}','${filename}')">Save</button>
    `);
  } catch (err) {
    showToast('Failed to load file: ' + err.message, 'error');
  }
}

async function saveSkillContextFile(name, filename) {
  const content = document.getElementById('editContextContent').value;
  try {
    await api.putSkillContextFile(name, filename, content);
    showToast('File saved', 'success');
    closeModal();
    showSkillDetail(name);
  } catch (err) {
    showToast('Failed to save: ' + err.message, 'error');
  }
}

async function deleteSkillContextFile(name, filename) {
  if (!confirm(`Delete "${filename}"?`)) return;
  try {
    await api.deleteSkillContextFile(name, filename);
    showToast('File deleted', 'info');
    showSkillDetail(name);
  } catch (err) {
    showToast('Failed to delete: ' + err.message, 'error');
  }
}
