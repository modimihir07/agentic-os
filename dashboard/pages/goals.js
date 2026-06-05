async function renderGoals() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <div class="page-title">Goals</div>
        <div class="page-subtitle">Project targets, task lists, and progress tracking</div>
      </div>
      <div class="btn-group">
        <button class="btn btn-primary" onclick="showCreateGoalModal()">+ New Goal</button>
        <button class="btn btn-ghost" onclick="renderGoals()">🔄 Refresh</button>
      </div>
    </div>
    <div class="flex gap-3" style="margin-bottom:16px">
      <div class="metric-tile" style="flex:1">
        <div class="metric-tile-value" id="goalTotalCount">0</div>
        <div class="metric-tile-label">Total Goals</div>
      </div>
      <div class="metric-tile" style="flex:1">
        <div class="metric-tile-value" id="goalActiveCount">0</div>
        <div class="metric-tile-label">Active</div>
      </div>
      <div class="metric-tile" style="flex:1">
        <div class="metric-tile-value" id="goalCompleteCount">0</div>
        <div class="metric-tile-label">Completed</div>
      </div>
      <div class="metric-tile" style="flex:1">
        <div class="metric-tile-value" id="goalAvgProgress">0%</div>
        <div class="metric-tile-label">Avg Progress</div>
      </div>
    </div>
    <div class="grid grid-3" id="goalList"></div>
  `;
  try {
    const data = await api.getGoals();
    const goals = data.goals || [];
    const list = document.getElementById('goalList');
    const totalEl = document.getElementById('goalTotalCount');
    const activeEl = document.getElementById('goalActiveCount');
    const completeEl = document.getElementById('goalCompleteCount');
    const avgEl = document.getElementById('goalAvgProgress');
    if (!list) return;
    if (goals.length === 0) {
      list.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-state-icon">🎯</div><div class="empty-state-title">No goals yet</div><div class="empty-state-desc">Create your first goal to start tracking progress</div></div>`;
      if (totalEl) totalEl.textContent = '0';
      if (activeEl) activeEl.textContent = '0';
      if (completeEl) completeEl.textContent = '0';
      if (avgEl) avgEl.textContent = '0%';
      return;
    }
    const active = goals.filter(g => g.status === 'active').length;
    const done = goals.filter(g => g.status === 'completed').length;
    const avgProg = Math.round(goals.reduce((s, g) => s + (g.progress || 0), 0) / goals.length);
    if (totalEl) totalEl.textContent = goals.length;
    if (activeEl) activeEl.textContent = active;
    if (completeEl) completeEl.textContent = done;
    if (avgEl) avgEl.textContent = avgProg + '%';
    list.innerHTML = goals.map(g => `
      <div class="goal-card">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <span class="badge badge-${g.status === 'completed' ? 'success' : g.status === 'active' ? 'info' : 'warning'}">${g.status}</span>
          <span class="badge badge-accent">${g.category}</span>
          ${g.target_date ? `<span class="text-muted text-xs">🎯 ${g.target_date}</span>` : ''}
        </div>
        <div class="goal-card-title">${escapeHtml(g.title)}</div>
        ${g.description ? `<div class="text-muted text-sm" style="margin-bottom:8px">${escapeHtml(g.description)}</div>` : ''}
        <div class="goal-card-progress">
          <div class="goal-card-progress-bar"><div class="goal-card-progress-fill" style="width:${g.progress || 0}%"></div></div>
          <div class="goal-card-progress-text">${g.progress || 0}%</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:12px;padding-top:10px;border-top:1px solid var(--border)">
          <button class="btn btn-sm ${g.status !== 'completed' ? 'btn-primary' : 'btn-ghost'}" onclick="updateGoalProgress('${g.id}', ${Math.min((g.progress || 0) + 25, 100)})">
            ${g.status !== 'completed' ? '+25%' : '✅ Done'}
          </button>
          ${g.status !== 'completed' ? `<button class="btn btn-sm btn-ghost" onclick="completeGoal('${g.id}')">Mark Complete</button>` : ''}
          <button class="btn btn-sm btn-ghost" onclick="deleteGoal('${g.id}')" style="margin-left:auto;color:var(--red)">🗑</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    showToast('Failed to load goals: ' + err.message, 'error');
  }
}

function showCreateGoalModal() {
  const modal = document.getElementById('modalContainer');
  modal.innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <div class="modal-header">
          <div class="modal-title">Create New Goal</div>
          <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">Title *</label>
            <input class="form-input" id="goalTitle" placeholder="e.g., Complete CloudMart Phase 2">
          </div>
          <div class="form-group">
            <label class="form-label">Description</label>
            <textarea class="form-textarea" id="goalDesc" placeholder="What does this goal involve?" rows="3"></textarea>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Category</label>
              <select class="form-select" id="goalCategory">
                <option value="general">General</option>
                <option value="development">Development</option>
                <option value="study">Study</option>
                <option value="devops">DevOps</option>
                <option value="personal">Personal</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Target Date</label>
              <input class="form-input" id="goalDate" type="date">
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="createGoal()">Create Goal</button>
        </div>
      </div>
    </div>
  `;
}

async function createGoal() {
  const title = document.getElementById('goalTitle').value.trim();
  if (!title) { showToast('Title is required', 'error'); return; }
  try {
    await api.createGoal({
      title,
      description: document.getElementById('goalDesc').value.trim(),
      category: document.getElementById('goalCategory').value,
      target_date: document.getElementById('goalDate').value,
    });
    showToast('Goal created!', 'success');
    closeModal();
    renderGoals();
  } catch (err) {
    showToast('Failed to create goal: ' + err.message, 'error');
  }
}

async function updateGoalProgress(id, progress) {
  try {
    const status = progress >= 100 ? 'completed' : 'active';
    await api.updateGoal(id, { progress, status });
    renderGoals();
  } catch (err) {
    showToast('Failed to update goal: ' + err.message, 'error');
  }
}

async function completeGoal(id) {
  try {
    await api.updateGoal(id, { progress: 100, status: 'completed' });
    showToast('Goal completed! 🎉', 'success');
    renderGoals();
  } catch (err) {
    showToast('Failed to complete goal: ' + err.message, 'error');
  }
}

async function deleteGoal(id) {
  if (!confirm('Delete this goal?')) return;
  try {
    await api.deleteGoal(id);
    showToast('Goal deleted', 'info');
    renderGoals();
  } catch (err) {
    showToast('Failed to delete goal: ' + err.message, 'error');
  }
}
