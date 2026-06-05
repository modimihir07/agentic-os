function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateX(20px)'; setTimeout(() => toast.remove(), 300); }, 3500);
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatDate(iso) {
  if (!iso) return '-';
  try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
}

function timeAgo(iso) {
  if (!iso) return '-';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function statusColor(status) {
  const s = (status || '').toLowerCase();
  if (['online', 'healthy', 'active', 'pass', 'ok'].includes(s)) return { bg: 'var(--green-dim)', dot: 'var(--green)', text: 'var(--green)' };
  if (['warning', 'warn', 'degraded'].includes(s)) return { bg: 'var(--yellow-dim)', dot: 'var(--yellow)', text: 'var(--yellow)' };
  if (['offline', 'error', 'fail', 'down'].includes(s)) return { bg: 'var(--red-dim)', dot: 'var(--red)', text: 'var(--red)' };
  return { bg: 'var(--bg-card)', dot: 'var(--text-muted)', text: 'var(--text-muted)' };
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const isCollapsed = sidebar.classList.toggle('collapsed');
  localStorage.setItem('sidebarCollapsed', isCollapsed);
  const icon = sidebar.querySelector('.toggle-icon');
  if (icon) {
    icon.style.transform = isCollapsed ? 'rotate(180deg)' : '';
  }
}

function toggleTheme() {
  const html = document.documentElement;
  const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
}

function loadTheme() {
  const saved = localStorage.getItem('theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  const sidebarCollapsed = localStorage.getItem('sidebarCollapsed');
  if (sidebarCollapsed === 'true') {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.add('collapsed');
    const icon = sidebar.querySelector('.toggle-icon');
    if (icon) icon.style.transform = 'rotate(180deg)';
  }
}

function showModal(title, bodyHtml, footerHtml) {
  const container = document.getElementById('modalContainer');
  container.innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <div class="modal-header">
          <span class="modal-title">${title}</span>
          <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <div class="modal-body">${bodyHtml}</div>
        ${footerHtml ? `<div class="modal-footer">${footerHtml}</div>` : ''}
      </div>
    </div>
  `;
}

function closeModal() {
  document.getElementById('modalContainer').innerHTML = '';
}

function handleGlobalSearch(value) {
  if (value.length < 2) return;
  if (window.location.hash !== '#skills') navigate('skills');
}

function renderSkeleton(count = 3) {
  return Array(count).fill(0).map(() =>
    `<div class="card"><div class="skeleton" style="height:20px;width:60%;margin-bottom:12px"></div><div class="skeleton" style="height:14px;width:90%;margin-bottom:8px"></div><div class="skeleton" style="height:14px;width:40%"></div></div>`
  ).join('');
}

const PAGE_TITLES = {
  dashboard: { title: 'Dashboard', breadcrumb: 'Overview' },
  skills: { title: 'Skills Hub', breadcrumb: 'Browse & execute skills' },
  memory: { title: 'Memory', breadcrumb: 'Shared brain context' },
  scheduler: { title: 'Scheduler', breadcrumb: 'Automated workflows' },
  audit: { title: 'Audit Log', breadcrumb: 'System activity trail' },
  cost: { title: 'Cost Analytics', breadcrumb: 'Usage & spending' },
  plugins: { title: 'Plugin Registry', breadcrumb: 'Manage plugins' },
  backups: { title: 'Backups', breadcrumb: 'Disaster recovery' },
  prompts: { title: 'Prompt Library', breadcrumb: 'Reusable templates' },
  standards: { title: 'Standards', breadcrumb: 'Project conventions' },
  settings: { title: 'Settings', breadcrumb: 'Configuration' },
  'setup-wizard': { title: 'Setup Wizard', breadcrumb: 'Guided configuration' },
  chat: { title: 'AI Chat', breadcrumb: 'Multi-agent terminal' },
  kanban: { title: 'Kanban Board', breadcrumb: 'Multi-agent task management' },
  goals: { title: 'Goals', breadcrumb: 'Project targets and progress' },
  journal: { title: 'Journal', breadcrumb: 'Daily entries and notes' },
  'agent-health': { title: 'Agent Health', breadcrumb: 'Real-time agent monitoring' },
  'smart-router': { title: 'Smart Router', breadcrumb: 'Task routing intelligence' },
  'learning-analytics': { title: 'Learning Analytics', breadcrumb: 'Skill improvement tracking' },
  'session-replay': { title: 'Session Replay', breadcrumb: 'Conversation history playback' },
};
