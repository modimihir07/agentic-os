const pageCache = {};

const PAGE_BASE = '/dashboard/pages/';

async function loadPage(name) {
  if (pageCache[name]) return pageCache[name];
  try {
    await loadScript(`${PAGE_BASE}${name}.js`);
    pageCache[name] = true;
  } catch (err) {
    showToast(`Failed to load page: ${name}`, 'error');
    throw err;
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.body.appendChild(script);
  });
}

async function navigate(page) {
  const hash = page || window.location.hash.slice(1) || 'dashboard';
  if (!hash) { window.location.hash = 'dashboard'; return; }

  // Show loading bar
  const bar = document.getElementById('topLoadingBar');
  if (bar) { bar.classList.add('active'); bar.style.width = '30%'; }

  document.querySelectorAll('.nav-item, .bottom-nav-item').forEach(el => el.classList.remove('active'));
  const navItem = document.querySelector(`[data-page="${hash}"]`);
  if (navItem) navItem.classList.add('active');

  const info = PAGE_TITLES[hash] || { title: 'Unknown', breadcrumb: '' };
  document.getElementById('pageTitle').textContent = info.title;
  document.getElementById('pageBreadcrumb').textContent = info.breadcrumb;

  const content = document.getElementById('pageContent');
  content.innerHTML = `<div class="loading"><div class="loading-spinner"></div><span>Loading ${info.title}...</span></div>`;

  try {
    await loadPage(hash);
    const renderFn = window[`render${capitalize(hash.replace(/-./g, m => m[1].toUpperCase()))}`];
    if (renderFn) {
      content.innerHTML = '';
      content.className = 'page-content page-enter';
      if (bar) bar.style.width = '70%';
      await renderFn();
      if (bar) { bar.style.width = '100%'; setTimeout(() => { bar.style.width = '0'; bar.classList.remove('active'); }, 400); }
    } else {
      content.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🔍</div><div class="empty-state-title">Page not found</div><div class="empty-state-desc">The page "${hash}" doesn't have a render function</div></div>`;
      if (bar) { bar.style.width = '0'; bar.classList.remove('active'); }
    }
  } catch (err) {
    content.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠</div><div class="empty-state-title">Failed to load</div><div class="empty-state-desc">${escapeHtml(err.message)}</div><button class="btn btn-primary mt-3" onclick="navigate('dashboard')">Go to Dashboard</button></div>`;
    if (bar) { bar.style.width = '0'; bar.classList.remove('active'); }
  }
}

function capitalize(str) { return str.charAt(0).toUpperCase() + str.slice(1); }

async function updateAgentStatus() {
  try {
    const status = await api.getStatus();
    const agents = status.agents || [];
    const bar = document.getElementById('agentStatusBar');
    const online = agents.filter(a => a.status === 'online').length;
    const total = agents.length;
    const dot = bar.querySelector('.agent-dot');
    if (online === total) { dot.className = 'agent-dot online'; bar.querySelector('span').textContent = 'All agents online'; }
    else if (online > 0) { dot.className = 'agent-dot warning'; bar.querySelector('span').textContent = `${online}/${total} online`; }
    else { dot.className = 'agent-dot offline'; bar.querySelector('span').textContent = 'All agents offline'; }

    const badge = document.getElementById('skillCount');
    if (badge && status.skills_count !== undefined) badge.textContent = status.skills_count;
  } catch {
    const bar = document.getElementById('agentStatusBar');
    if (bar) { bar.querySelector('.agent-dot').className = 'agent-dot offline'; bar.querySelector('span').textContent = 'Disconnected'; }
  }
}

window.addEventListener('hashchange', () => navigate());
window.addEventListener('DOMContentLoaded', () => {
  loadTheme();
  navigate(window.location.hash.slice(1) || 'dashboard');
  updateAgentStatus();
  setInterval(updateAgentStatus, 15000);
});
