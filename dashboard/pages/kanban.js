let kanbanData = null;

function getAllKanbanTasks() {
  return Object.values(kanbanData?.columns || {}).flat();
}

async function renderKanban() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <div class="page-title">Kanban Board</div>
        <div class="page-subtitle">Visual task management — track, prioritize, and organize work</div>
      </div>
      <div class="btn-group">
        <button class="btn btn-primary" onclick="showAddKanbanTask()">+ Add Task</button>
        <button class="btn btn-ghost" onclick="renderKanban()">🔄 Refresh</button>
      </div>
    </div>
    <div class="kanban-toolbar">
      <input class="form-input" id="kanbanFilterInput" placeholder="Filter tasks..." oninput="filterKanbanTasks()" style="flex:1;max-width:280px">
      <select class="form-select" id="kanbanFilterPriority" onchange="filterKanbanTasks()" style="width:120px">
        <option value="all">All Priorities</option>
        <option value="high">High</option>
        <option value="medium">Medium</option>
        <option value="low">Low</option>
      </select>
      <select class="form-select" id="kanbanFilterCategory" onchange="filterKanbanTasks()" style="width:140px">
        <option value="all">All Categories</option>
        <option value="development">Development</option>
        <option value="devops">DevOps</option>
        <option value="study">Study</option>
        <option value="content">Content</option>
        <option value="general">General</option>
      </select>
    </div>
    <div class="kanban-board" id="kanbanBoard">
      <div class="skeleton" style="height:400px"></div>
    </div>
  `;
  await loadKanbanData();
}

async function loadKanbanData() {
  try {
    const data = await api.getKanbanBoard();
    kanbanData = data;
    renderKanbanBoard();
  } catch (err) {
    const board = document.getElementById('kanbanBoard');
    if (board) board.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📋</div><div class="empty-state-title">Failed to load kanban</div><div class="empty-state-desc">${escapeHtml(err.message)}</div></div>`;
  }
}

function renderKanbanBoard() {
  const board = document.getElementById('kanbanBoard');
  if (!board || !kanbanData) return;
  const columnsObj = kanbanData.columns || {};
  const columns = Object.keys(columnsObj);
  const allTasks = getAllKanbanTasks();
  const filterText = (document.getElementById('kanbanFilterInput')?.value || '').toLowerCase();
  const filterPriority = document.getElementById('kanbanFilterPriority')?.value || 'all';
  const filterCategory = document.getElementById('kanbanFilterCategory')?.value || 'all';
  const columnLabels = { triage: 'Triage', todo: 'To Do', ready: 'Ready', in_progress: 'In Progress', blocked: 'Blocked', done: 'Done', backlog: 'Backlog', review: 'Review' };
  const columnIcons = { triage: '🔍', todo: '📝', ready: '✅', in_progress: '🔄', blocked: '🚫', done: '🎉', backlog: '📋', review: '🔍' };
  board.innerHTML = columns.map(col => {
    let colTasks = (columnsObj[col] || []).filter(t => {
      if (filterText) return (t.title || '').toLowerCase().includes(filterText) || (t.body || t.description || '').toLowerCase().includes(filterText);
      return true;
    }).filter(t => filterPriority === 'all' || (t.priority || 'medium') === filterPriority)
      .filter(t => filterCategory === 'all' || (t.category || 'general') === filterCategory);
    return `
      <div class="kanban-column" data-column="${col}">
        <div class="kanban-column-header">
          <div class="kanban-column-title">
            <span>${columnIcons[col] || '📌'}</span>
            ${columnLabels[col] || col}
            <span class="kanban-count">${colTasks.length}</span>
          </div>
        </div>
        <div class="kanban-column-body" ondragover="event.preventDefault()" ondrop="onKanbanDrop(event, '${col}')">
          ${colTasks.length === 0 ? `<div class="kanban-empty">No tasks</div>` :
            colTasks.map(t => `
              <div class="kanban-card" draggable="true" ondragstart="onKanbanDrag(event, '${t.id}')" onclick="showKanbanDetail('${t.id}')">
                <div class="kanban-card-header">
                  <span class="kanban-priority priority-${t.priority || 'medium'}">${t.priority || 'medium'}</span>
                </div>
                <div class="kanban-card-title">${escapeHtml(t.title)}</div>
                ${t.body ? `<div class="kanban-card-desc">${escapeHtml(t.body.substring(0, 80))}${t.body.length > 80 ? '...' : ''}</div>` : ''}
                <div class="kanban-card-meta">
                  ${t.assignee ? `<span>👤 ${escapeHtml(t.assignee)}</span>` : ''}
                </div>
                ${t.status === 'blocked' ? `<div class="kanban-blocked-badge">🚫 Blocked</div>` : ''}
              </div>
            `).join('')}
        </div>
      </div>
    `;
  }).join('');
}

function showAddKanbanTask() {
  const modal = document.getElementById('modalContainer');
  modal.innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this)closeModal()">
      <div class="modal" style="max-width:520px">
        <div class="modal-header">
          <div class="modal-title">Add Kanban Task</div>
          <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">Title *</label>
            <input class="form-input" id="kanbanTitle" placeholder="e.g., Implement login page">
          </div>
          <div class="form-group">
            <label class="form-label">Description</label>
            <textarea class="form-textarea" id="kanbanDescription" rows="2" placeholder="Brief description"></textarea>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Status</label>
              <select class="form-select" id="kanbanStatus">
                <option value="triage">Triage</option>
                <option value="todo">To Do</option>
                <option value="ready">Ready</option>
                <option value="in_progress">In Progress</option>
                <option value="blocked">Blocked</option>
                <option value="done">Done</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Priority</label>
              <select class="form-select" id="kanbanPriority">
                <option value="low">Low</option>
                <option value="medium" selected>Medium</option>
                <option value="high">High</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Category</label>
              <select class="form-select" id="kanbanCategory">
                <option value="general">General</option>
                <option value="development">Development</option>
                <option value="devops">DevOps</option>
                <option value="study">Study</option>
                <option value="content">Content</option>
              </select>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Assigned To</label>
              <select class="form-select" id="kanbanAssigned">
                <option value="">Unassigned</option>
                <option value="opencode">opencode (auto-run)</option>
                <option value="hermes">Hermes (auto-run)</option>
                <option value="gemini">Gemini CLI (auto-run)</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Target Date</label>
              <input class="form-input" id="kanbanDate" type="date">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Tags (comma separated)</label>
            <input class="form-input" id="kanbanTags" placeholder="e.g., frontend, api">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="createKanbanTask()">Add Task</button>
        </div>
      </div>
    </div>
  `;
}

async function createKanbanTask() {
  const title = document.getElementById('kanbanTitle').value.trim();
  if (!title) { showToast('Title is required', 'error'); return; }
  const tagsStr = document.getElementById('kanbanTags').value.trim();
  const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(Boolean) : [];
  try {
    await api.createKanbanTask({
      title,
      body: document.getElementById('kanbanDescription').value.trim(),
      status: document.getElementById('kanbanStatus').value,
      priority: document.getElementById('kanbanPriority').value,
      assignee: document.getElementById('kanbanAssigned').value.trim(),
    });
    showToast('Task added to kanban board!', 'success');
    closeModal();
    renderKanban();
  } catch (err) {
    showToast('Failed to create task: ' + err.message, 'error');
  }
}

let kanbanDraggedId = null;
function onKanbanDrag(e, id) {
  kanbanDraggedId = id;
  e.dataTransfer.effectAllowed = 'move';
}
async function onKanbanDrop(e, status) {
  e.preventDefault();
  if (!kanbanDraggedId) return;
  try {
    await api.updateKanbanTask(kanbanDraggedId, { status });
    kanbanDraggedId = null;
    renderKanban();
  } catch (err) {
    showToast('Failed to move task: ' + err.message, 'error');
  }
}

const KANBAN_AGENTS = ['opencode', 'hermes', 'gemini'];

function closeKanbanDetailModal() {
  if (window._kanbanDetailPoll) { clearInterval(window._kanbanDetailPoll); window._kanbanDetailPoll = null; }
  closeModal();
}

async function showKanbanDetail(id) {
  const task = getAllKanbanTasks().find(t => t.id === id);
  if (!task) return;
  renderKanbanDetailModal(task);

  if (window._kanbanDetailPoll) clearInterval(window._kanbanDetailPoll);
  if (task.status === 'in_progress') {
    window._kanbanDetailPoll = setInterval(async () => {
      try {
        const fresh = await api.getKanbanTask(id);
        if (fresh.status !== 'in_progress') {
          clearInterval(window._kanbanDetailPoll);
          window._kanbanDetailPoll = null;
          renderKanban();
        }
        if (document.getElementById('kanbanDetailModal')) renderKanbanDetailModal(fresh);
      } catch {}
    }, 3000);
  }
}

function renderKanbanDetailModal(task) {
  const modal = document.getElementById('modalContainer');
  const canDispatch = KANBAN_AGENTS.includes(task.assignee) && task.status !== 'in_progress' && task.status !== 'done';
  const comments = task.comments || [];
  modal.innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this)closeKanbanDetailModal()">
      <div class="modal" id="kanbanDetailModal" style="max-width:560px">
        <div class="modal-header">
          <div class="modal-title">${escapeHtml(task.title)}</div>
          <button class="modal-close" onclick="closeKanbanDetailModal()">✕</button>
        </div>
        <div class="modal-body">
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
            <span class="badge badge-${task.status === 'done' ? 'success' : task.status === 'in_progress' ? 'info' : 'warning'}">${task.status}</span>
            <span class="kanban-priority priority-${task.priority || 'medium'}">${task.priority}</span>
            ${task.status === 'blocked' ? `<span class="badge badge-danger">🚫 Blocked</span>` : ''}
            ${task.status === 'in_progress' ? `<span class="badge badge-info">🔄 Agent running…</span>` : ''}
          </div>
          ${task.body ? `<div style="margin-bottom:12px;color:var(--text-secondary);font-size:13px">${escapeHtml(task.body)}</div>` : ''}
          <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:12px;font-size:12px">
            ${task.assignee ? `<span>👤 <strong>${escapeHtml(task.assignee)}</strong>${KANBAN_AGENTS.includes(task.assignee) ? ' 🤖' : ''}</span>` : ''}
            <span>📅 <strong>${task.created || 'N/A'}</strong></span>
            ${task.completed_at ? `<span>✅ <strong>${task.completed_at}</strong></span>` : ''}
          </div>
          ${task.block_reason ? `<div style="margin-bottom:12px;font-size:12px;color:var(--red)">🚫 ${escapeHtml(task.block_reason)}</div>` : ''}
          ${comments.length ? `
            <div style="margin-bottom:12px">
              <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted);margin-bottom:6px">Activity</div>
              ${comments.map(c => `<div style="padding:8px 10px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-sm);font-size:12px;white-space:pre-wrap;margin-bottom:6px">${escapeHtml(c.message)}</div>`).join('')}
            </div>
          ` : ''}
          <div style="display:flex;gap:4px;flex-wrap:wrap">
            ${canDispatch ? `<button class="btn btn-sm btn-primary" onclick="dispatchKanbanTask('${task.id}')">🤖 Dispatch to ${escapeHtml(task.assignee)}</button>` : ''}
            ${task.status !== 'done' ? `<button class="btn btn-sm btn-ghost" onclick="completeKanbanTask('${task.id}')">✅ Mark Done</button>` : ''}
            ${task.status !== 'blocked' ? `<button class="btn btn-sm btn-ghost" onclick="blockKanbanTask('${task.id}')">🚫 Block</button>` : `<button class="btn btn-sm btn-ghost" onclick="unblockKanbanTask('${task.id}')">🔓 Unblock</button>`}
            <button class="btn btn-sm btn-ghost" onclick="deleteKanbanTask('${task.id}')" style="color:var(--red)">🗑 Delete</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

async function dispatchKanbanTask(id) {
  try {
    await api.dispatchKanbanTask(id);
    showToast('Task dispatched to agent 🤖', 'success');
    await loadKanbanData();
    const fresh = getAllKanbanTasks().find(t => t.id === id);
    if (fresh) showKanbanDetail(id);
  } catch (err) {
    showToast('Failed to dispatch: ' + err.message, 'error');
  }
}

async function completeKanbanTask(id) {
  try {
    await api.completeKanbanTask(id);
    closeModal();
    renderKanban();
    showToast('Task completed! ✅', 'success');
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

async function blockKanbanTask(id) {
  try {
    await api.blockKanbanTask(id);
    closeModal();
    renderKanban();
    showToast('Task blocked 🚫', 'warning');
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

async function unblockKanbanTask(id) {
  try {
    await api.unblockKanbanTask(id);
    closeModal();
    renderKanban();
    showToast('Task unblocked 🔓', 'success');
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

async function deleteKanbanTask(id) {
  if (!confirm('Delete this task?')) return;
  try {
    await api.deleteKanbanTask(id);
    closeModal();
    renderKanban();
    showToast('Task deleted', 'info');
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

function filterKanbanTasks() {
  renderKanbanBoard();
}
