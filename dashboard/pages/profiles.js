const profileState = { profiles: [], selected: null };
const PROFILE_TOKEN_KEY = 'agenticOsProfileAdminToken';

function profileToken() { return sessionStorage.getItem(PROFILE_TOKEN_KEY) || ''; }
function pEsc(value, fallback = '—') { return escapeHtml(value == null || value === '' ? fallback : String(value)); }

async function profileRequest(path, options = {}) {
  const headers = { ...(options.headers || {}), 'X-Agentic-OS-Admin': profileToken() };
  if (options.body) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.detail || `Request failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function profileStatus(message, error = false) {
  const node = document.getElementById('profilesStatus');
  if (!node) return;
  node.textContent = message || '';
  node.classList.toggle('profiles-error', error);
}

function renderProfileGate(message = '') {
  const content = document.getElementById('pageContent');
  content.innerHTML = `<section class="card profiles-gate">
    <div class="empty-state-icon">🔐</div>
    <h1 class="card-title">Hermes Profile Hub</h1>
    <p class="page-subtitle">Enter the separate administrative token. It is kept only for this browser tab.</p>
    <form id="profileTokenForm" class="profiles-form">
      <label class="form-label" for="profileTokenInput">Admin token</label>
      <input class="form-input" id="profileTokenInput" type="password" autocomplete="off" required spellcheck="false">
      <button class="btn btn-primary" type="submit">Unlock Profiles</button>
      <div class="profiles-status profiles-error" role="status">${pEsc(message, '')}</div>
    </form>
  </section>`;
  document.getElementById('profileTokenForm').addEventListener('submit', async event => {
    event.preventDefault();
    const token = document.getElementById('profileTokenInput').value;
    sessionStorage.setItem(PROFILE_TOKEN_KEY, token);
    try { await loadProfiles(); } catch (error) {
      sessionStorage.removeItem(PROFILE_TOKEN_KEY);
      renderProfileGate(error.status === 401 ? 'Invalid admin token.' : error.message);
    }
  });
}

function renderProfilesShell() {
  document.getElementById('pageContent').innerHTML = `<div class="profiles-header">
    <div><h1 class="page-title">Hermes Profiles</h1><p class="page-subtitle">Manage isolated identities with backups and exact confirmations.</p></div>
    <div class="profiles-toolbar"><button class="btn" id="profilesRefresh">Refresh</button><button class="btn btn-primary" id="profilesCreate">New profile</button><button class="btn btn-ghost" id="profilesForget">Lock</button></div>
  </div>
  <div id="profilesStatus" class="profiles-status" role="status" aria-live="polite"></div>
  <div class="profiles-layout">
    <section class="card"><div class="card-header"><h2 class="card-title">Profiles</h2><span class="badge badge-accent" id="profilesCount">0</span></div><div id="profilesList" class="profiles-list"></div></section>
    <section class="card" id="profileDetail" aria-label="Profile details"><div class="empty-state"><div class="empty-state-icon">👤</div><div class="empty-state-title">Select a profile</div></div></section>
  </div>`;
  document.getElementById('profilesRefresh').onclick = () => loadProfiles(profileState.selected);
  document.getElementById('profilesCreate').onclick = showCreateProfile;
  document.getElementById('profilesForget').onclick = () => { sessionStorage.removeItem(PROFILE_TOKEN_KEY); renderProfileGate('Admin token removed.'); };
}

function renderProfileList() {
  const list = document.getElementById('profilesList');
  document.getElementById('profilesCount').textContent = profileState.profiles.length;
  list.innerHTML = profileState.profiles.map((profile, index) => `<button type="button" class="profiles-list-item${profile.name === profileState.selected ? ' active' : ''}" data-index="${index}">
    <strong>${pEsc(profile.name)}</strong><span>${pEsc(profile.description, 'No description')}</span><small>${pEsc(profile.gateway, 'unknown')} · ${pEsc(profile.model, 'no model')}</small>
  </button>`).join('');
  list.onclick = event => {
    const button = event.target.closest('[data-index]');
    if (!button) return;
    const profile = profileState.profiles[Number(button.dataset.index)];
    if (profile) selectProfile(profile.name);
  };
}

async function loadProfiles(selectName = null) {
  if (!profileToken()) { renderProfileGate(); return; }
  const profiles = await profileRequest('/api/hermes/profiles');
  if (!document.getElementById('profilesList')) renderProfilesShell();
  profileState.profiles = profiles;
  profileState.selected = selectName && profiles.some(p => p.name === selectName) ? selectName : null;
  renderProfileList();
  if (profileState.selected) await selectProfile(profileState.selected);
  profileStatus(`${profiles.length} profiles loaded.`);
}

async function selectProfile(name) {
  profileState.selected = name;
  renderProfileList();
  const detail = document.getElementById('profileDetail');
  detail.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  try {
    const p = await profileRequest(`/api/hermes/profiles/${encodeURIComponent(name)}`);
    const stopped = String(p.gateway).toLowerCase() === 'stopped';
    detail.innerHTML = `<div class="profiles-detail-head"><div><h2 class="page-title">${pEsc(p.name)}</h2><p class="page-subtitle">${pEsc(p.description, 'No description')}</p></div>${p.protected ? '<span class="badge">Protected</span>' : ''}</div>
      <dl class="profiles-meta"><div><dt>Model</dt><dd>${pEsc(p.model)}</dd></div><div><dt>Provider</dt><dd>${pEsc(p.provider)}</dd></div><div><dt>Gateway</dt><dd>${pEsc(p.gateway)}</dd></div><div><dt>Skills</dt><dd>${pEsc(p.skills_count, '0')}</dd></div><div><dt>Alias</dt><dd>${pEsc(p.alias)}</dd></div><div><dt>Health</dt><dd>${pEsc(p.health)}</dd></div></dl>
      <form id="profileUpdateForm" class="profiles-form"><label class="form-label" for="profileDescription">Description</label><textarea class="form-input" id="profileDescription" maxlength="2000" rows="4">${pEsc(p.description, '')}</textarea><button class="btn btn-primary" type="submit">Save description</button></form>
      <div class="profiles-actions"><button class="btn" id="profileBackup">Create backup</button><button class="btn" id="profileRename" ${p.protected ? 'disabled' : ''}>Rename</button><button class="btn btn-danger" id="profileDelete" ${p.protected || !stopped ? 'disabled' : ''}>Delete</button></div>
      ${!p.protected && !stopped ? '<p class="form-hint">Stop the gateway before deletion.</p>' : ''}`;
    document.getElementById('profileUpdateForm').onsubmit = event => updateDescription(event, p.name);
    document.getElementById('profileBackup').onclick = () => backupProfile(p.name);
    document.getElementById('profileRename').onclick = () => showRenameProfile(p.name);
    document.getElementById('profileDelete').onclick = () => showDeleteProfile(p.name);
  } catch (error) { handleProfileError(error); }
}

function showProfileDialog(title, fields, submitText, onSubmit, danger = false) {
  showModal(pEsc(title), `<form id="profileDialogForm" class="profiles-form">${fields}<div id="profileDialogStatus" class="profiles-status profiles-error" role="status"></div><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" type="submit">${pEsc(submitText)}</button></form>`, '');
  document.getElementById('profileDialogForm').onsubmit = async event => {
    event.preventDefault();
    try { await onSubmit(); closeModal(); } catch (error) { document.getElementById('profileDialogStatus').textContent = error.message; }
  };
}

function showCreateProfile() {
  showProfileDialog('New Hermes profile', `<label class="form-label" for="newProfileName">Name</label><input class="form-input" id="newProfileName" pattern="[a-z0-9][a-z0-9-]{1,62}[a-z0-9]" required><label class="form-label" for="newProfileDescription">Description</label><textarea class="form-input" id="newProfileDescription" maxlength="2000"></textarea>`, 'Create', async () => {
    const created = await profileRequest('/api/hermes/profiles', { method: 'POST', body: JSON.stringify({ name: document.getElementById('newProfileName').value, description: document.getElementById('newProfileDescription').value }) });
    await loadProfiles(created.name);
  });
}

async function updateDescription(event, name) {
  event.preventDefault();
  try {
    await profileRequest(`/api/hermes/profiles/${encodeURIComponent(name)}`, { method: 'PATCH', body: JSON.stringify({ description: document.getElementById('profileDescription').value }) });
    await loadProfiles(name); profileStatus('Description updated.');
  } catch (error) { handleProfileError(error); }
}

async function backupProfile(name) {
  try {
    const result = await profileRequest(`/api/hermes/profiles/${encodeURIComponent(name)}/backup`, { method: 'POST' });
    profileStatus(`Backup created: ${result.filename}`);
  } catch (error) { handleProfileError(error); }
}

function showRenameProfile(name) {
  showProfileDialog(`Rename ${name}`, `<label class="form-label" for="renamedProfile">New name</label><input class="form-input" id="renamedProfile" pattern="[a-z0-9][a-z0-9-]{1,62}[a-z0-9]" required><label class="form-label" for="renameConfirm">Type ${pEsc(name)} to confirm</label><input class="form-input" id="renameConfirm" required>`, 'Rename', async () => {
    const result = await profileRequest(`/api/hermes/profiles/${encodeURIComponent(name)}`, { method: 'PATCH', body: JSON.stringify({ name: document.getElementById('renamedProfile').value, confirm: document.getElementById('renameConfirm').value }) });
    await loadProfiles(result.name);
  });
}

function showDeleteProfile(name) {
  showProfileDialog(`Delete ${name}`, `<p>This creates a backup, then permanently deletes the profile.</p><label class="form-label" for="deleteConfirm">Type ${pEsc(name)} to confirm</label><input class="form-input" id="deleteConfirm" required>`, 'Delete profile', async () => {
    const confirm = document.getElementById('deleteConfirm').value;
    await profileRequest(`/api/hermes/profiles/${encodeURIComponent(name)}?confirm=${encodeURIComponent(confirm)}`, { method: 'DELETE' });
    await loadProfiles();
  }, true);
}

function handleProfileError(error) {
  if (error.status === 401) { sessionStorage.removeItem(PROFILE_TOKEN_KEY); renderProfileGate('Admin token expired or was rejected.'); return; }
  profileStatus(error.message || 'Request failed.', true);
}

async function renderProfiles() {
  if (!profileToken()) { renderProfileGate(); return; }
  try { await loadProfiles(); } catch (error) { handleProfileError(error); }
}
