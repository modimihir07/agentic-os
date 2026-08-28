const profileState = {
  profiles: [], selected: null, studio: null, catalog: null,
  tab: 'identity', editing: false, query: '', skillQuery: '',
  draftSoul: '', addSkills: new Set(), removeSkills: new Set(), preview: null,
  requestSeq: 0, mode: 'view', capabilities: [], templates: [],
  capabilityQuery: '', capabilityIntent: 'Todos', selectedCapability: null,
  loadout: [], persistedLoadout: [], powerMap: { version: 1, nodes: [], edges: [] },
  persistedPowerMap: { version: 1, nodes: [], edges: [] }, history: [], future: [],
  evolutionValidation: null, validationSeq: 0,
};
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

function confirmDiscardStudioChanges(action) {
  if (studioHasChanges() && !window.confirm('Hay cambios de Agent Studio sin aplicar. ¿Quieres descartarlos?')) return false;
  action();
  return true;
}

function bindStudioNavigationGuard() {
  window.agentStudioConfirmNavigation = () => (
    !studioHasChanges() || window.confirm('Hay cambios de Agent Studio sin aplicar. ¿Quieres descartarlos?')
  );
  if (window.agentStudioNavigationGuardBound) return;
  window.agentStudioNavigationGuardBound = true;
  window.addEventListener('beforeunload', event => {
    if (!studioHasChanges()) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

function renderProfileGate(message = '') {
  const content = document.getElementById('pageContent');
  content.innerHTML = `<section class="card profiles-gate">
    <div class="empty-state-icon">🔐</div>
    <h1 class="card-title">Agent Studio</h1>
    <p class="page-subtitle">Desbloquea el control plane de identidades Hermes. El token vive sólo en esta pestaña.</p>
    <form id="profileTokenForm" class="profiles-form">
      <label class="form-label" for="profileTokenInput">Token administrativo</label>
      <input class="form-input" id="profileTokenInput" type="password" autocomplete="off" required spellcheck="false">
      <button class="btn btn-primary" type="submit">Entrar al Studio</button>
      <div class="profiles-status profiles-error" role="status">${pEsc(message, '')}</div>
    </form>
  </section>`;
  document.getElementById('profileTokenForm').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    button.textContent = 'Abriendo universo…';
    sessionStorage.setItem(PROFILE_TOKEN_KEY, document.getElementById('profileTokenInput').value);
    try { await loadProfiles(); } catch (error) {
      sessionStorage.removeItem(PROFILE_TOKEN_KEY);
      renderProfileGate(error.status === 401 ? 'Token administrativo inválido.' : error.message);
    }
  });
}

function renderProfilesShell() {
  document.getElementById('pageContent').innerHTML = `<div class="studio-header">
    <div><span class="pg-kicker">IDENTITY CONTROL PLANE</span><h1 class="page-title">Agent Studio</h1><p class="page-subtitle">Observa, equipa y evoluciona perfiles Hermes reales con preview, backup y rollback.</p></div>
    <div class="profiles-toolbar"><button class="btn" id="profilesRefresh">↻ Actualizar</button><button class="btn btn-primary" id="profilesCreate">＋ Nuevo agente</button><button class="btn btn-ghost" id="profilesForget">Bloquear</button></div>
  </div>
  <div id="profilesStatus" class="profiles-status" role="status" aria-live="polite"></div>
  <div class="studio-layout">
    <aside class="card studio-roster"><div class="studio-roster-head"><h2>Agentes</h2><span class="badge badge-accent" id="profilesCount">0</span></div><input class="form-input" id="profileSearch" placeholder="Buscar agente…" autocomplete="off"><div id="profilesList" class="profiles-list"></div></aside>
    <section id="profileStage" class="studio-stage"><div class="empty-state"><div class="empty-state-icon">🧬</div><div class="empty-state-title">Selecciona un agente</div><div class="empty-state-desc">Abre su habitación para ver identidad y capacidades reales.</div></div></section>
    <aside id="profileInspector" class="card studio-inspector"><div class="empty-state"><div class="empty-state-icon">◫</div><div class="empty-state-title">Inspector</div></div></aside>
  </div>
  <div id="studioChangeBar" class="studio-change-bar" hidden></div>`;
  document.getElementById('profilesRefresh').onclick = () => confirmDiscardStudioChanges(() => loadProfiles(profileState.selected));
  document.getElementById('profilesCreate').onclick = () => confirmDiscardStudioChanges(() => { window.location.hash = 'agent-playground'; });
  document.getElementById('profilesForget').onclick = () => confirmDiscardStudioChanges(() => { sessionStorage.removeItem(PROFILE_TOKEN_KEY); renderProfileGate('Studio bloqueado.'); });
  document.getElementById('profileSearch').oninput = event => { profileState.query = event.target.value; renderProfileList(); };
  bindStudioNavigationGuard();
}

function renderProfileList() {
  const list = document.getElementById('profilesList');
  if (!list) return;
  const visible = profileState.profiles.filter(profile => `${profile.name} ${profile.description || ''}`.toLowerCase().includes(profileState.query.toLowerCase()));
  document.getElementById('profilesCount').textContent = profileState.profiles.length;
  list.innerHTML = visible.map((profile, index) => `<button type="button" class="profiles-list-item studio-agent-row${profile.name === profileState.selected ? ' active' : ''}" data-visible-index="${index}">
    <span class="studio-agent-dot ${profile.health === 'ok' ? 'ok' : ''}"></span><span><strong>${pEsc(profile.name)}</strong><small>${pEsc(profile.description, 'Sin descripción')}</small><em>${pEsc(profile.gateway, 'unknown')} · ${pEsc(profile.skills_count, 0)} skills</em></span>${profile.protected ? '<b class="studio-lock">◆</b>' : ''}
  </button>`).join('') || '<div class="empty-state"><div class="empty-state-title">Sin coincidencias</div></div>';
  list.onclick = event => {
    const button = event.target.closest('[data-visible-index]');
    if (!button) return;
    const profile = visible[Number(button.dataset.visibleIndex)];
    if (profile && profile.name !== profileState.selected) confirmDiscardStudioChanges(() => selectProfile(profile.name));
  };
}

async function loadProfiles(selectName = null) {
  if (!profileToken()) { renderProfileGate(); return; }
  const profiles = await profileRequest('/api/hermes/profiles');
  if (!document.getElementById('profilesList')) renderProfilesShell();
  profileState.profiles = profiles;
  profileState.selected = selectName && profiles.some(p => p.name === selectName) ? selectName : (profileState.selected && profiles.some(p => p.name === profileState.selected) ? profileState.selected : profiles[0]?.name || null);
  renderProfileList();
  if (profileState.selected) await selectProfile(profileState.selected);
  profileStatus(`${profiles.length} agentes sincronizados.`);
}

function resetStudioDraft(studio) {
  profileState.studio = studio;
  profileState.draftSoul = studio.soul || '';
  profileState.addSkills = new Set();
  profileState.removeSkills = new Set();
  profileState.preview = null;
  profileState.editing = false;
  profileState.tab = 'identity';
  profileState.mode = 'view';
  const available = new Set(profileState.capabilities.map(item => item.id));
  const storedLoadout = studio.metadata?.loadout || studio.metadata?.equipped_skills || [];
  profileState.loadout = Array.isArray(storedLoadout) ? storedLoadout.filter(item => available.has(item)).slice(0, 5) : [];
  profileState.persistedLoadout = [...profileState.loadout];
  profileState.powerMap = ProfilePowerMap.normalize(studio.metadata?.power_map);
  profileState.persistedPowerMap = ProfilePowerMap.normalize(profileState.powerMap);
  profileState.selectedCapability = profileState.loadout[0] || profileState.capabilities[0]?.id || null;
  profileState.history = [];
  profileState.future = [];
  profileState.evolutionValidation = null;
}

async function selectProfile(name) {
  const requestSeq = ++profileState.requestSeq;
  profileState.selected = name;
  renderProfileList();
  document.getElementById('profileStage').innerHTML = '<div class="loading"><div class="loading-spinner"></div><span>Abriendo habitación…</span></div>';
  try {
    const [studio, catalog] = await Promise.all([
      profileRequest(`/api/hermes/profiles/${encodeURIComponent(name)}/studio`),
      profileRequest(`/api/hermes/profiles/${encodeURIComponent(name)}/studio/capabilities`),
    ]);
    if (requestSeq !== profileState.requestSeq || profileState.selected !== name) return;
    profileState.capabilities = catalog.capabilities || [];
    profileState.templates = catalog.templates || [];
    profileState.catalog = { skills: profileState.capabilities };
    resetStudioDraft(studio);
    renderStudioWorkspace();
  } catch (error) {
    if (requestSeq === profileState.requestSeq) handleProfileError(error);
  }
}

function studioColor() {
  const color = profileState.studio?.metadata?.appearance?.primary_color;
  return { violet: '#8b7cff', cyan: '#2dd4bf', coral: '#fb7185', emerald: '#34d399', gold: '#fbbf24' }[color] || '#8b7cff';
}

function renderStudioWorkspace() {
  const studio = profileState.studio;
  if (!studio) return;
  if (profileState.mode === 'evolve') { renderEvolutionWorkbench(); return; }
  document.querySelector('.studio-layout')?.classList.remove('evolution-active');
  const p = studio.profile;
  const meta = studio.metadata || {};
  const displayName = meta.display_name || p.name;
  const stage = document.getElementById('profileStage');
  stage.innerHTML = `<div class="studio-room">
    <div class="studio-room-top"><span class="badge ${p.health === 'ok' ? 'badge-success' : ''}">${p.health === 'ok' ? '● HEALTHY' : '● ' + pEsc(p.health)}</span>${p.protected ? '<span class="badge badge-warning">PROTECTED · SOLO LECTURA</span>' : '<span class="badge">EDITABLE</span>'}</div>
    <div class="studio-avatar-orbit" style="--studio-agent-color:${studioColor()}"><div class="studio-avatar-core">${p.protected ? '◆' : '◉'}</div><span></span><span></span><span></span></div>
    <span class="pg-kicker">${pEsc(meta.archetype || 'HERMES PROFILE')}</span><h1>${pEsc(displayName)}</h1><code>${pEsc(p.name)}</code>
    <p>${pEsc(meta.mission || p.description, 'Perfil Hermes sin misión visual.')}</p>
    <div class="studio-vitals"><div><strong>${pEsc(p.skills_count, 0)}</strong><small>skills</small></div><div><strong>${pEsc(p.model, '—')}</strong><small>modelo</small></div><div><strong>${pEsc(p.gateway)}</strong><small>gateway</small></div></div>
    <div class="studio-stage-actions"><button class="btn btn-primary" id="studioEvolve" ${studio.read_only ? 'disabled' : ''}>✦ Evolucionar agente</button><button class="btn" id="studioBackup">Crear backup</button></div>
  </div>`;
  document.getElementById('studioEvolve').onclick = enterEvolutionMode;
  document.getElementById('studioBackup').onclick = () => backupProfile(p.name);
  renderStudioInspector();
  renderStudioChangeBar();
}

function evolutionSnapshot() {
  return {
    loadout: [...profileState.loadout],
    powerMap: ProfilePowerMap.normalize(profileState.powerMap),
    addSkills: [...profileState.addSkills],
    removeSkills: [...profileState.removeSkills],
  };
}

function restoreEvolutionSnapshot(snapshot) {
  profileState.loadout = [...snapshot.loadout];
  profileState.powerMap = ProfilePowerMap.normalize(snapshot.powerMap);
  profileState.addSkills = new Set(snapshot.addSkills);
  profileState.removeSkills = new Set(snapshot.removeSkills);
  profileState.selectedCapability = profileState.loadout.includes(profileState.selectedCapability)
    ? profileState.selectedCapability : profileState.loadout[0] || profileState.capabilities[0]?.id || null;
}

function rememberEvolution() {
  profileState.history.push(evolutionSnapshot());
  if (profileState.history.length > 30) profileState.history.shift();
  profileState.future = [];
}

function undoEvolution() {
  if (!profileState.history.length) return;
  profileState.future.push(evolutionSnapshot());
  restoreEvolutionSnapshot(profileState.history.pop());
  renderEvolutionWorkbench();
}

function redoEvolution() {
  if (!profileState.future.length) return;
  profileState.history.push(evolutionSnapshot());
  restoreEvolutionSnapshot(profileState.future.pop());
  renderEvolutionWorkbench();
}

function enterEvolutionMode() {
  if (!profileState.studio || profileState.studio.read_only) return;
  profileState.mode = 'evolve';
  profileState.editing = true;
  renderEvolutionWorkbench();
}

function exitEvolutionMode() {
  const close = () => { profileState.mode = 'view'; renderStudioWorkspace(); };
  if (studioHasChanges() && !window.confirm('Tu Blueprint tiene cambios sin aplicar. ¿Quieres salir y conservarlos en esta pestaña?')) return;
  close();
}

function capabilityStatus(capability) {
  if (profileState.addSkills.has(capability.id)) return ['POR AÑADIR', 'pending'];
  const installed = profileState.studio.skills.some(item => item.id === capability.id);
  if (capability.readiness === 'requires_setup') return ['REQUIERE SETUP', 'setup'];
  if (capability.readiness === 'design_only') return ['SOLO DISEÑO', 'design'];
  if (capability.readiness === 'available') return [installed ? 'INSTALADA · PROBAR' : 'DISPONIBLE', 'available'];
  if (installed) return ['INSTALADA', 'installed'];
  return ['LISTA PARA EQUIPAR', 'ready'];
}

function addCapabilityToBlueprint(capabilityId) {
  const capability = profileState.capabilities.find(item => item.id === capabilityId);
  if (!capability || profileState.loadout.includes(capabilityId)) return;
  if (profileState.loadout.length >= 5) { profileStatus('El loadout principal admite hasta cinco superpoderes.', true); return; }
  if (!capability.studio_mutable) { profileStatus('Este bloque tiene un namespace ambiguo y es sólo lectura.', true); return; }
  rememberEvolution();
  profileState.loadout.push(capabilityId);
  profileState.powerMap = ProfilePowerMap.addCapability(profileState.powerMap, capability, profileState.capabilities);
  if (!profileState.studio.skills.some(item => item.id === capabilityId)) profileState.addSkills.add(capabilityId);
  profileState.removeSkills.delete(capabilityId);
  profileState.selectedCapability = capabilityId;
  renderEvolutionWorkbench();
}

function removeCapabilityFromBlueprint(capabilityId) {
  if (!profileState.loadout.includes(capabilityId)) return;
  rememberEvolution();
  profileState.loadout = profileState.loadout.filter(item => item !== capabilityId);
  profileState.powerMap = ProfilePowerMap.removeCapability(profileState.powerMap, capabilityId);
  profileState.addSkills.delete(capabilityId);
  profileState.selectedCapability = profileState.loadout[0] || capabilityId;
  renderEvolutionWorkbench();
}

function applyEvolutionTemplate(templateId) {
  const template = profileState.templates.find(item => item.id === templateId);
  if (!template) return;
  rememberEvolution();
  const selected = [];
  for (const intent of template.intents) {
    const capability = profileState.capabilities.find(item => item.intent_category === intent && item.studio_mutable && !selected.includes(item.id));
    if (capability && selected.length < 5) selected.push(capability.id);
  }
  profileState.loadout = [];
  profileState.powerMap = ProfilePowerMap.empty();
  profileState.addSkills = new Set();
  profileState.removeSkills = new Set();
  for (const id of selected) {
    const capability = profileState.capabilities.find(item => item.id === id);
    profileState.loadout.push(id);
    profileState.powerMap = ProfilePowerMap.addCapability(profileState.powerMap, capability, profileState.capabilities);
    if (!profileState.studio.skills.some(item => item.id === id)) profileState.addSkills.add(id);
  }
  profileState.selectedCapability = selected[0] || null;
  renderEvolutionWorkbench();
}

function renderCapabilityPalette() {
  const query = profileState.capabilityQuery.toLowerCase();
  const visible = profileState.capabilities.filter(capability => {
    const searchable = `${capability.name} ${capability.superpower} ${capability.contribution} ${capability.intent_category}`.toLowerCase();
    return searchable.includes(query) && (profileState.capabilityIntent === 'Todos' || capability.intent_category === profileState.capabilityIntent);
  });
  return `<section class="capability-palette"><div class="evolution-panel-head"><div><span class="pg-kicker">BLOQUES</span><h2>Superpoderes</h2></div><span class="badge">${visible.length}/${profileState.capabilities.length}</span></div>
    <label class="sr-only" for="capabilitySearch">Buscar superpoderes por resultado</label><input id="capabilitySearch" class="form-input" aria-label="Buscar superpoderes por resultado" placeholder="¿Qué quieres que pueda hacer?" value="${pEsc(profileState.capabilityQuery, '')}">
    <div class="capability-intents"><button type="button" data-capability-intent="Todos" class="${profileState.capabilityIntent === 'Todos' ? 'active' : ''}">Todos</button>${['Descubrir', 'Pensar', 'Crear', 'Comunicar', 'Organizar', 'Proteger'].map(intent => `<button type="button" data-capability-intent="${intent}" class="${profileState.capabilityIntent === intent ? 'active' : ''}">${intent}</button>`).join('')}</div>
    <div class="capability-list">${visible.map((capability, index) => {
      const [status, statusClass] = capabilityStatus(capability);
      const equipped = profileState.loadout.includes(capability.id);
      return `<article class="capability-block ${equipped ? 'equipped' : ''}" data-capability-index="${index}"><button type="button" class="capability-block-main" data-inspect-capability="${index}"><span class="capability-icon">${pEsc(capability.icon, '🧩')}</span><span><strong>${pEsc(capability.name)}</strong><small>${pEsc(capability.superpower)}</small><em>Aporta al agente: ${pEsc(capability.contribution)}</em></span></button><div><span class="capability-state ${statusClass}">${status}</span><button type="button" class="btn btn-sm" data-toggle-capability="${index}">${equipped ? 'Retirar del loadout' : 'Añadir al agente'}</button></div></article>`;
    }).join('') || '<div class="power-map-empty"><strong>Sin coincidencias</strong><span>Prueba buscando por el resultado que quieres conseguir.</span></div>'}</div></section>`;
}

function renderEvolutionWorkbench() {
  document.querySelector('.studio-layout')?.classList.add('evolution-active');
  const stage = document.getElementById('profileStage');
  stage.innerHTML = `<div class="evolution-workbench"><header class="evolution-toolbar"><div><span class="pg-kicker">EVOLUTION MODE</span><h1>Mesa de construcción</h1><small>Blueprint sin aplicar · nada se ejecuta mientras diseñas</small></div><div><button class="btn btn-sm" id="evolutionUndo" ${profileState.history.length ? '' : 'disabled'}>↶ Deshacer</button><button class="btn btn-sm" id="evolutionRedo" ${profileState.future.length ? '' : 'disabled'}>↷ Rehacer</button><button class="btn" id="evolutionExit">Salir</button></div></header>
    <div class="evolution-templates"><span>Comenzar con un kit:</span>${profileState.templates.map(template => `<button type="button" data-evolution-template="${pEsc(template.id)}">${pEsc(template.icon)} ${pEsc(template.name)}</button>`).join('')}</div>
    <div class="evolution-build-grid">${renderCapabilityPalette()}<section class="power-map-shell"><div class="evolution-panel-head"><div><span class="pg-kicker">POWER MAP</span><h2>Cómo colaboran</h2></div><span class="badge badge-accent">${profileState.loadout.length}/5 equipados</span></div><div id="profilePowerMap"></div></section></div></div>`;
  ProfilePowerMap.render(document.getElementById('profilePowerMap'), profileState.powerMap, profileState.capabilities, profileState.selectedCapability);
  document.getElementById('evolutionUndo').onclick = undoEvolution;
  document.getElementById('evolutionRedo').onclick = redoEvolution;
  document.getElementById('evolutionExit').onclick = exitEvolutionMode;
  document.getElementById('capabilitySearch').oninput = event => { profileState.capabilityQuery = event.target.value; renderEvolutionWorkbench(); const input = document.getElementById('capabilitySearch'); input.focus(); input.setSelectionRange(input.value.length, input.value.length); };
  stage.onclick = event => {
    const intent = event.target.closest('[data-capability-intent]');
    if (intent) { profileState.capabilityIntent = intent.dataset.capabilityIntent; renderEvolutionWorkbench(); return; }
    const template = event.target.closest('[data-evolution-template]');
    if (template) { applyEvolutionTemplate(template.dataset.evolutionTemplate); return; }
    const visible = profileState.capabilities.filter(capability => `${capability.name} ${capability.superpower} ${capability.contribution} ${capability.intent_category}`.toLowerCase().includes(profileState.capabilityQuery.toLowerCase()) && (profileState.capabilityIntent === 'Todos' || capability.intent_category === profileState.capabilityIntent));
    const inspect = event.target.closest('[data-inspect-capability]');
    if (inspect) { profileState.selectedCapability = visible[Number(inspect.dataset.inspectCapability)]?.id; renderPowerMapInspector(); return; }
    const toggle = event.target.closest('[data-toggle-capability]');
    if (toggle) { const id = visible[Number(toggle.dataset.toggleCapability)]?.id; if (id) profileState.loadout.includes(id) ? removeCapabilityFromBlueprint(id) : addCapabilityToBlueprint(id); return; }
    const move = event.target.closest('[data-power-move]');
    if (move) { rememberEvolution(); profileState.powerMap = ProfilePowerMap.moveNode(profileState.powerMap, move.dataset.nodeId, Number(move.dataset.powerMove)); renderEvolutionWorkbench(); return; }
    const node = event.target.closest('[data-power-node]');
    if (node) { profileState.selectedCapability = node.dataset.powerNode; renderPowerMapInspector(); return; }
    if (event.target.closest('[data-power-quick-add]')) { document.getElementById('capabilitySearch').focus(); profileStatus('Elige un bloque compatible de la paleta.'); }
  };
  stage.onkeydown = event => {
    const capabilityId = ProfilePowerMap.keyboardNodeActivation(event);
    if (capabilityId) {
      event.preventDefault();
      profileState.selectedCapability = capabilityId;
      renderPowerMapInspector();
    }
  };
  renderPowerMapInspector();
  renderStudioChangeBar();
  validateEvolutionBlueprint();
}

async function validateEvolutionBlueprint() {
  const current = ++profileState.validationSeq;
  try {
    const validation = await profileRequest(`/api/hermes/profiles/${encodeURIComponent(profileState.selected)}/studio/evolution/validate`, {
      method: 'POST', body: JSON.stringify({ loadout: profileState.loadout, power_map: ProfilePowerMap.normalize(profileState.powerMap) }),
    });
    if (current !== profileState.validationSeq || profileState.mode !== 'evolve') return;
    profileState.evolutionValidation = validation;
    const banner = document.querySelector('.power-map-banner');
    if (banner) {
      const warnings = validation.warnings?.length || 0;
      banner.textContent = `◫ Mapa de capacidades · no ejecuta acciones · ${validation.readiness.ready}/${validation.readiness.total} listos${warnings ? ` · ${warnings} avisos` : ''}`;
      banner.title = (validation.warnings || []).join('\n');
    }
  } catch (error) {
    if (current !== profileState.validationSeq || profileState.mode !== 'evolve') return;
    profileState.evolutionValidation = null;
    const banner = document.querySelector('.power-map-banner');
    if (banner) { banner.textContent = `⚠ Blueprint por revisar: ${error.message}`; banner.classList.add('invalid'); }
  }
}

function renderPowerMapInspector() {
  const inspector = document.getElementById('profileInspector');
  const capability = profileState.capabilities.find(item => item.id === profileState.selectedCapability);
  if (!capability) { inspector.innerHTML = '<div class="power-map-empty"><strong>Inspector</strong><span>Selecciona un bloque para entender su superpoder.</span></div>'; return; }
  const equipped = profileState.loadout.includes(capability.id);
  const sideEffectLabel = { none: 'Sin efectos externos', read: 'Lectura', write: 'Puede escribir', send: 'Puede enviar', publish: 'Puede publicar', delete: 'Puede borrar', unknown: 'Efectos por verificar' }[capability.side_effects] || 'Por verificar';
  inspector.innerHTML = `<div class="power-inspector"><div class="power-inspector-hero"><span>${pEsc(capability.icon, '🧩')}</span><div><span class="pg-kicker">SUPERPODER</span><h2>${pEsc(capability.name)}</h2></div></div><p class="power-statement">${pEsc(capability.superpower)}</p><section><h3>Qué aporta al perfil</h3><p>${pEsc(capability.contribution)}</p></section><section><h3>Cómo funciona</h3><ol>${capability.workflow_steps.map(step => `<li>${pEsc(step)}</li>`).join('')}</ol></section><section class="power-io"><div><h3>Necesita</h3>${capability.inputs.map(port => `<span>${pEsc(port.label)} <em>${pEsc(port.type)}</em></span>`).join('')}</div><div><h3>Entrega</h3>${capability.outputs.map(port => `<span>${pEsc(port.label)} <em>${pEsc(port.type)}</em></span>`).join('')}</div></section><section><h3>Preparación y seguridad</h3><p><span class="capability-state ${capability.readiness}">${pEsc(capability.readiness)}</span> ${pEsc(capability.readiness_reason)}</p><p><strong>${pEsc(sideEffectLabel)}</strong></p><ul>${capability.requirements.map(item => `<li>${pEsc(item)}</li>`).join('')}</ul></section><details><summary>Detalles técnicos opcionales</summary><code>${pEsc(capability.id)}</code><p>Fuente: ${pEsc(capability.source)} · Estado: ${pEsc(capability.status)}</p></details><button class="btn btn-primary" id="inspectorTogglePower">${equipped ? 'Retirar del loadout' : 'Añadir al agente'}</button></div>`;
  document.getElementById('inspectorTogglePower').onclick = () => equipped ? removeCapabilityFromBlueprint(capability.id) : addCapabilityToBlueprint(capability.id);
}

function renderStudioInspector() {
  const studio = profileState.studio;
  const inspector = document.getElementById('profileInspector');
  const tabs = [
    ['identity', 'Identidad'], ['soul', 'SOUL'], ['skills', 'Skills'], ['advanced', 'Administración avanzada'],
  ];
  inspector.innerHTML = `<div class="studio-tabs">${tabs.map(([id, label]) => `<button class="studio-tab ${profileState.tab === id ? 'active' : ''}" data-studio-tab="${id}">${label}</button>`).join('')}</div><div id="studioInspectorBody" class="studio-inspector-body"></div>`;
  inspector.querySelector('.studio-tabs').onclick = event => { const button = event.target.closest('[data-studio-tab]'); if (button) { profileState.tab = button.dataset.studioTab; renderStudioInspector(); } };
  if (profileState.tab === 'soul') studioSoulEditor();
  else if (profileState.tab === 'skills') studioSkillCatalog();
  else if (profileState.tab === 'advanced') renderAdvancedProfileAdmin();
  else renderStudioIdentity();
}

function renderStudioIdentity() {
  const { profile, metadata, skills, revision, read_only: readOnly } = profileState.studio;
  const body = document.getElementById('studioInspectorBody');
  body.innerHTML = `<div class="studio-section-head"><div><span class="pg-kicker">AGENT CARD</span><h2>${pEsc(metadata?.display_name || profile.name)}</h2></div>${readOnly ? '<span class="badge badge-warning">READ ONLY</span>' : ''}</div>
    <dl class="profiles-meta"><div><dt>Modelo</dt><dd>${pEsc(profile.model)}</dd></div><div><dt>Proveedor</dt><dd>${pEsc(profile.provider)}</dd></div><div><dt>Gateway</dt><dd>${pEsc(profile.gateway)}</dd></div><div><dt>Skills</dt><dd>${pEsc(skills.length)}</dd></div></dl>
    <div class="studio-mission"><h3>Misión</h3><p>${pEsc(metadata?.mission || profile.description, 'Todavía no tiene una misión visual.')}</p></div>
    <div class="studio-readiness"><h3>Preparación verificable</h3><ul><li class="done">✓ Perfil Hermes descubierto</li><li class="${profile.soul_exists ? 'done' : ''}">${profile.soul_exists ? '✓' : '○'} SOUL.md</li><li class="${skills.length ? 'done' : ''}">${skills.length ? '✓' : '○'} ${skills.length} skills instaladas</li><li class="${profile.model ? 'done' : ''}">${profile.model ? '✓' : '○'} Modelo configurado</li><li>Gateway: ${pEsc(profile.gateway)}</li></ul></div>
    <small class="studio-revision">Revisión ${pEsc(revision.slice(0, 12))}</small>`;
}

function studioSoulEditor() {
  const body = document.getElementById('studioInspectorBody');
  const editable = profileState.editing && !profileState.studio.read_only;
  body.innerHTML = `<div class="studio-section-head"><div><span class="pg-kicker">IDENTITY SOURCE</span><h2>SOUL.md</h2></div><span class="badge">${editable ? 'EDITANDO' : 'PREVIEW'}</span></div>
    <p class="form-hint">La identidad estable del agente. Los cambios no se escriben hasta revisar y confirmar.</p>
    <textarea id="studioSoulEditor" class="form-textarea studio-code-editor" spellcheck="false" maxlength="100000" ${editable ? '' : 'readonly'}>${pEsc(profileState.draftSoul, '')}</textarea>
    ${editable ? '<div class="studio-editor-actions"><button class="btn btn-sm" id="studioResetSoul">Restaurar borrador</button><span id="studioSoulCount"></span></div>' : '<button class="btn btn-primary" id="studioBeginSoul">Editar identidad</button>'}`;
  if (editable) {
    const editor = document.getElementById('studioSoulEditor');
    const count = document.getElementById('studioSoulCount');
    const update = () => { profileState.draftSoul = editor.value; count.textContent = `${editor.value.length} caracteres`; renderStudioChangeBar(); };
    editor.oninput = update; update();
    document.getElementById('studioResetSoul').onclick = () => { profileState.draftSoul = profileState.studio.soul; studioSoulEditor(); renderStudioChangeBar(); };
  } else if (!profileState.studio.read_only) {
    document.getElementById('studioBeginSoul').onclick = () => { profileState.editing = true; studioSoulEditor(); renderStudioChangeBar(); };
  }
}

function effectiveSkillState(id) {
  const installed = profileState.studio.skills.some(skill => skill.id === id);
  if (profileState.addSkills.has(id)) return 'add';
  if (profileState.removeSkills.has(id)) return 'remove';
  return installed ? 'installed' : 'available';
}

function studioSkillIdsOverlap(left, right) {
  const a = left.split('/'); const b = right.split('/');
  const length = Math.min(a.length, b.length);
  return a.slice(0, length).join('/') === b.slice(0, length).join('/');
}

function studioSkillCatalog() {
  const body = document.getElementById('studioInspectorBody');
  const installed = profileState.studio.skills;
  const query = profileState.skillQuery.toLowerCase();
  const available = (profileState.catalog?.skills || []).filter(skill => !installed.some(item => item.id === skill.id) && `${skill.name} ${skill.description}`.toLowerCase().includes(query)).map(skill => ({ ...skill, studio_mutable: !installed.some(item => studioSkillIdsOverlap(item.id, skill.id)) }));
  body.innerHTML = `<div class="studio-section-head"><div><span class="pg-kicker">CAPABILITY INVENTORY</span><h2>Skills reales</h2></div><span class="badge">${installed.length} instaladas</span></div>
    <p class="form-hint">Instalada significa presente en el perfil; no implica que sus credenciales estén conectadas.</p>
    <div class="studio-skill-stack"><h3>Instaladas</h3>${installed.map((skill, index) => `<article class="studio-skill-card ${profileState.removeSkills.has(skill.id) ? 'pending-remove' : ''}"><button class="studio-skill-main" data-installed-skill="${index}"><strong>⚡ ${pEsc(skill.name)}</strong><small>${pEsc(skill.description)}</small><em>${pEsc(skill.id)}</em></button>${profileState.studio.read_only ? '' : `<button class="btn btn-sm ${profileState.removeSkills.has(skill.id) ? 'btn-primary' : 'btn-ghost'}" data-remove-skill="${index}" ${skill.studio_mutable ? '' : 'disabled title="Namespace anidado: inspección solamente"'}>${skill.studio_mutable ? (profileState.removeSkills.has(skill.id) ? 'Conservar' : 'Retirar') : 'Sólo lectura'}</button>`}</article>`).join('') || '<p class="page-subtitle">Sin skills instaladas.</p>'}</div>
    <div class="studio-skill-store"><h3>Catálogo aprobado</h3><input id="studioSkillSearch" class="form-input" placeholder="Buscar skills…" value="${pEsc(profileState.skillQuery)}"><div class="studio-skill-stack">${available.map((skill, index) => `<article class="studio-skill-card ${profileState.addSkills.has(skill.id) ? 'pending-add' : ''}"><div class="studio-skill-main"><strong>${profileState.addSkills.has(skill.id) ? '✓' : '＋'} ${pEsc(skill.name)}</strong><small>${pEsc(skill.description)}</small><em>${pEsc(skill.category)}</em></div>${profileState.studio.read_only ? '' : `<button class="btn btn-sm ${profileState.addSkills.has(skill.id) ? 'btn-primary' : ''}" data-add-skill="${index}" ${skill.studio_mutable ? '' : 'disabled title="Namespace solapado: no se puede añadir"'}>${skill.studio_mutable ? (profileState.addSkills.has(skill.id) ? 'Añadida' : 'Añadir') : 'No disponible'}</button>`}</article>`).join('') || '<p class="page-subtitle">No hay coincidencias.</p>'}</div></div>`;
  document.getElementById('studioSkillSearch').oninput = event => { profileState.skillQuery = event.target.value; studioSkillCatalog(); const input = document.getElementById('studioSkillSearch'); input.focus(); input.setSelectionRange(input.value.length, input.value.length); };
  body.onclick = event => {
    const inspect = event.target.closest('[data-installed-skill]');
    if (inspect) { inspectStudioSkill(installed[Number(inspect.dataset.installedSkill)].id); return; }
    const remove = event.target.closest('[data-remove-skill]');
    if (remove) { const id = installed[Number(remove.dataset.removeSkill)].id; profileState.removeSkills.has(id) ? profileState.removeSkills.delete(id) : profileState.removeSkills.add(id); studioSkillCatalog(); renderStudioChangeBar(); return; }
    const add = event.target.closest('[data-add-skill]');
    if (add) { const id = available[Number(add.dataset.addSkill)].id; profileState.addSkills.has(id) ? profileState.addSkills.delete(id) : profileState.addSkills.add(id); studioSkillCatalog(); renderStudioChangeBar(); }
  };
}

async function inspectStudioSkill(skillId) {
  try {
    const detail = await profileRequest(`/api/hermes/profiles/${encodeURIComponent(profileState.selected)}/studio/skills/${skillId.split('/').map(encodeURIComponent).join('/')}`);
    showModal(pEsc(detail.name), `<div class="studio-skill-detail"><span class="badge">${pEsc(detail.id)}</span><p>${pEsc(detail.description)}</p><pre>${pEsc(detail.content)}</pre></div>`, '<button class="btn" id="studioCloseSkill">Cerrar</button>');
    document.getElementById('studioCloseSkill').onclick = closeModal;
  } catch (error) { profileStatus(error.message, true); }
}

function renderAdvancedProfileAdmin() {
  const p = profileState.studio.profile;
  const stopped = String(p.gateway).toLowerCase() === 'stopped';
  const body = document.getElementById('studioInspectorBody');
  body.innerHTML = `<div class="studio-section-head"><div><span class="pg-kicker">OPERATIONS</span><h2>Administración avanzada</h2></div></div>
    <p class="form-hint">Operaciones de identidad exactas. La evolución de SOUL y skills se gestiona en las otras pestañas.</p>
    <form id="profileUpdateForm" class="profiles-form"><label class="form-label" for="profileDescription">Descripción de routing</label><textarea class="form-input" id="profileDescription" maxlength="2000" rows="4" ${p.protected ? 'readonly' : ''}>${pEsc(p.description, '')}</textarea>${p.protected ? '' : '<button class="btn btn-primary" type="submit">Guardar descripción</button>'}</form>
    <div class="profiles-actions"><button class="btn" id="profileBackup">Crear backup</button><button class="btn" id="profileRename" ${p.protected ? 'disabled' : ''}>Renombrar</button><button class="btn btn-danger" id="profileDelete" ${p.protected || !stopped ? 'disabled' : ''}>Eliminar</button></div>
    ${!p.protected && !stopped ? '<p class="form-hint">Detén el gateway antes de eliminar.</p>' : ''}`;
  if (!p.protected) document.getElementById('profileUpdateForm').onsubmit = event => updateDescription(event, p.name);
  document.getElementById('profileBackup').onclick = () => backupProfile(p.name);
  document.getElementById('profileRename').onclick = () => showRenameProfile(p.name);
  document.getElementById('profileDelete').onclick = () => showDeleteProfile(p.name);
}

function studioEvolutionBody(confirm = false) {
  const body = {
    expected_revision: profileState.studio.revision,
    soul: profileState.draftSoul,
    add_skills: [...profileState.addSkills],
    remove_skills: [...profileState.removeSkills],
    loadout: [...profileState.loadout],
    power_map: ProfilePowerMap.normalize(profileState.powerMap),
  };
  if (confirm) body.confirm = profileState.selected;
  return body;
}

function studioHasChanges() {
  if (!profileState.studio) return false;
  return profileState.draftSoul !== profileState.studio.soul
    || profileState.addSkills.size > 0 || profileState.removeSkills.size > 0
    || JSON.stringify(profileState.loadout) !== JSON.stringify(profileState.persistedLoadout)
    || JSON.stringify(ProfilePowerMap.normalize(profileState.powerMap)) !== JSON.stringify(ProfilePowerMap.normalize(profileState.persistedPowerMap));
}

function renderStudioChangeBar() {
  const bar = document.getElementById('studioChangeBar');
  if (!bar) return;
  const changed = studioHasChanges();
  bar.hidden = !profileState.editing && !changed;
  if (bar.hidden) return;
  const visualChanged = Number(JSON.stringify(profileState.loadout) !== JSON.stringify(profileState.persistedLoadout) || JSON.stringify(profileState.powerMap) !== JSON.stringify(profileState.persistedPowerMap));
  const count = Number(profileState.draftSoul !== profileState.studio.soul) + profileState.addSkills.size + profileState.removeSkills.size + visualChanged;
  bar.innerHTML = `<div><strong>Cambios pendientes: ${count}</strong><small>${profileState.draftSoul !== profileState.studio.soul ? 'SOUL · ' : ''}+${profileState.addSkills.size} skills · −${profileState.removeSkills.size} skills · ${profileState.loadout.length} bloques</small></div><div><button class="btn" id="studioDiscard">Descartar</button><button class="btn btn-primary" id="studioPreview" ${changed ? '' : 'disabled'}>Revisar evolución</button></div>`;
  document.getElementById('studioDiscard').onclick = () => { resetStudioDraft(profileState.studio); renderStudioWorkspace(); };
  document.getElementById('studioPreview').onclick = previewStudioEvolution;
}

async function previewStudioEvolution() {
  profileStatus('Generando preview sin escritura…');
  const operation = {
    profile: profileState.selected,
    requestSeq: profileState.requestSeq,
    body: studioEvolutionBody(),
  };
  try {
    const preview = await profileRequest(`/api/hermes/profiles/${encodeURIComponent(operation.profile)}/studio/preview`, { method: 'POST', body: JSON.stringify(operation.body) });
    if (profileState.selected !== operation.profile || profileState.requestSeq !== operation.requestSeq || JSON.stringify(studioEvolutionBody()) !== JSON.stringify(operation.body)) {
      throw new Error('El perfil o borrador cambió durante el preview. Revísalo de nuevo.');
    }
    profileState.preview = { ...operation, response: preview };
    const skillChanges = [...preview.add_skills.map(item => `＋ ${item}`), ...preview.remove_skills.map(item => `− ${item}`)];
    const loadoutBefore = preview.loadout_before.length ? preview.loadout_before.join('\n') : 'Sin loadout destacado';
    const loadoutAfter = preview.loadout.length ? preview.loadout.join('\n') : 'Sin loadout destacado';
    showModal('Revisar evolución', `<div class="studio-review"><div class="pg-spawn-warning">Todavía no se ha modificado Hermes. Al confirmar se creará y validará un backup antes de aplicar exactamente este Blueprint.</div><div class="evolution-review-summary"><div><small>ANTES</small><pre>${pEsc(loadoutBefore)}</pre></div><div><small>DESPUÉS · READINESS ${pEsc(preview.readiness_percent)}%</small><pre>${pEsc(loadoutAfter)}</pre></div></div>${preview.warnings?.length ? `<div class="evolution-warning">${preview.warnings.map(item => `<p>⚠ ${pEsc(item)}</p>`).join('')}</div>` : ''}<h3>SOUL.md</h3><pre>${pEsc(preview.soul_diff || 'Sin cambios en SOUL.md')}</pre><h3>Skills</h3><pre>${pEsc(skillChanges.join('\n') || 'Sin cambios de skills')}</pre><h3>Power Map</h3><pre>${pEsc(`${preview.power_map.nodes.length} bloques · ${preview.power_map.edges.length} conexiones tipadas · modo diseño`)}</pre><label class="form-label" for="studioExactConfirm">Escribe ${pEsc(operation.profile)} para confirmar</label><input class="form-input" id="studioExactConfirm" autocomplete="off" spellcheck="false"></div>`, '<button class="btn" id="studioCancelApply">Volver</button><button class="btn btn-primary" id="studioConfirmApply" disabled>Crear backup y aplicar</button>');
    document.getElementById('studioCancelApply').onclick = closeModal;
    const confirmInput = document.getElementById('studioExactConfirm');
    const applyButton = document.getElementById('studioConfirmApply');
    confirmInput.oninput = () => { applyButton.disabled = confirmInput.value !== operation.profile; };
    applyButton.onclick = applyStudioEvolution;
    profileStatus('Preview generado. Ningún archivo fue modificado.');
  } catch (error) { handleProfileError(error); }
}

async function applyStudioEvolution() {
  const button = document.getElementById('studioConfirmApply');
  const preview = profileState.preview;
  if (!preview || profileState.selected !== preview.profile || profileState.requestSeq !== preview.requestSeq || JSON.stringify(studioEvolutionBody()) !== JSON.stringify(preview.body)) {
    profileStatus('El perfil o borrador cambió. Genera un preview nuevo.', true);
    return;
  }
  button.disabled = true;
  button.textContent = 'Aplicando transacción…';
  try {
    const applyBody = { ...preview.body, confirm: preview.profile, preview_token: preview.response.preview_token };
    await profileRequest(`/api/hermes/profiles/${encodeURIComponent(preview.profile)}/studio/apply`, { method: 'POST', body: JSON.stringify(applyBody) });
    closeModal();
    showToast('Evolución aplicada y verificada. Backup creado.', 'success');
    await loadProfiles(profileState.selected);
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Crear backup y aplicar';
    profileStatus(error.message, true);
    const modalBody = document.querySelector('.modal-body');
    if (modalBody) { const warning = document.createElement('p'); warning.className = 'profiles-status profiles-error'; warning.textContent = error.message; modalBody.appendChild(warning); }
  }
}

function showProfileDialog(title, fields, submitText, onSubmit, danger = false) {
  showModal(pEsc(title), `<form id="profileDialogForm" class="profiles-form">${fields}<div id="profileDialogStatus" class="profiles-status profiles-error" role="status"></div><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" type="submit">${pEsc(submitText)}</button></form>`, '');
  document.getElementById('profileDialogForm').onsubmit = async event => { event.preventDefault(); try { await onSubmit(); closeModal(); } catch (error) { document.getElementById('profileDialogStatus').textContent = error.message; } };
}

async function updateDescription(event, name) {
  event.preventDefault();
  if (studioHasChanges() && !window.confirm('Hay cambios de Agent Studio sin aplicar. ¿Quieres descartarlos?')) return;
  try { await profileRequest(`/api/hermes/profiles/${encodeURIComponent(name)}`, { method: 'PATCH', body: JSON.stringify({ description: document.getElementById('profileDescription').value }) }); await loadProfiles(name); profileStatus('Descripción actualizada.'); } catch (error) { handleProfileError(error); }
}

async function backupProfile(name) {
  try { const result = await profileRequest(`/api/hermes/profiles/${encodeURIComponent(name)}/backup`, { method: 'POST' }); profileStatus(`Backup creado: ${result.filename}`); showToast('Backup Hermes creado.', 'success'); } catch (error) { handleProfileError(error); }
}

function showRenameProfile(name) {
  if (studioHasChanges() && !window.confirm('Hay cambios de Agent Studio sin aplicar. ¿Quieres descartarlos?')) return;
  showProfileDialog(`Renombrar ${name}`, `<label class="form-label" for="renamedProfile">Nuevo nombre</label><input class="form-input" id="renamedProfile" pattern="[a-z0-9][a-z0-9-]{1,62}[a-z0-9]" required><label class="form-label" for="renameConfirm">Escribe ${pEsc(name)} para confirmar</label><input class="form-input" id="renameConfirm" required>`, 'Renombrar', async () => { const result = await profileRequest(`/api/hermes/profiles/${encodeURIComponent(name)}`, { method: 'PATCH', body: JSON.stringify({ name: document.getElementById('renamedProfile').value, confirm: document.getElementById('renameConfirm').value }) }); await loadProfiles(result.name); });
}

function showDeleteProfile(name) {
  if (studioHasChanges() && !window.confirm('Hay cambios de Agent Studio sin aplicar. ¿Quieres descartarlos?')) return;
  showProfileDialog(`Eliminar ${name}`, `<p>Se creará un backup y después se eliminará permanentemente el perfil.</p><label class="form-label" for="deleteConfirm">Escribe ${pEsc(name)} para confirmar</label><input class="form-input" id="deleteConfirm" required>`, 'Eliminar perfil', async () => { const confirm = document.getElementById('deleteConfirm').value; await profileRequest(`/api/hermes/profiles/${encodeURIComponent(name)}?confirm=${encodeURIComponent(confirm)}`, { method: 'DELETE' }); await loadProfiles(); }, true);
}

function handleProfileError(error) {
  if (error.status === 401) { sessionStorage.removeItem(PROFILE_TOKEN_KEY); renderProfileGate('El token expiró o fue rechazado.'); return; }
  if (error.status === 409 && String(error.message).includes('reload Studio')) { profileStatus('El perfil cambió externamente. Tu borrador se conserva; actualiza cuando estés listo.', true); return; }
  profileStatus(error.message || 'La operación falló.', true);
}

async function renderProfiles() {
  if (!profileToken()) { renderProfileGate(); return; }
  try { await loadProfiles(); } catch (error) { handleProfileError(error); }
}
