const PLAYGROUND_TOKEN_KEY = 'agenticOsProfileAdminToken';
const PLAYGROUND_DRAFT_KEY = 'agenticOsPlaygroundDraft';

const playgroundState = {
  catalog: null,
  agents: [],
  step: 1,
  room: null,
  preview: null,
  skillQuery: '',
  skillCategory: 'all',
  skillSearchTimer: null,
  draft: {
    name: '', display_name: '', archetype: 'explorer',
    appearance: { base: 'orb', primary_color: 'violet', face: 'curious', accessory: 'visor', biome: 'library' },
    communication: { detail: 'balanced', tone: 'warm', initiative: 'ask-first' },
    mission: '', boundaries: ['No publicar ni enviar nada sin aprobación'], equipped_skills: [],
  },
};

function pgEsc(value, fallback = '') { return escapeHtml(value == null || value === '' ? fallback : String(value)); }
function pgToken() { return sessionStorage.getItem(PLAYGROUND_TOKEN_KEY) || ''; }
function pgSaveDraft() { sessionStorage.setItem(PLAYGROUND_DRAFT_KEY, JSON.stringify(playgroundState.draft)); }

function pgRestoreDraft() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(PLAYGROUND_DRAFT_KEY) || 'null');
    if (saved && typeof saved === 'object') playgroundState.draft = { ...playgroundState.draft, ...saved };
  } catch { sessionStorage.removeItem(PLAYGROUND_DRAFT_KEY); }
}

function pgColor(name) {
  return { violet: '#8b7cff', cyan: '#2dd4bf', coral: '#fb7185', emerald: '#34d399', gold: '#fbbf24' }[name] || '#8b7cff';
}

function renderAvatarSvg(appearance = playgroundState.draft.appearance, label = playgroundState.draft.display_name || 'Nuevo agente') {
  const safe = {
    base: ['orb', 'bot', 'sprite'].includes(appearance.base) ? appearance.base : 'orb',
    face: ['curious', 'focused', 'friendly'].includes(appearance.face) ? appearance.face : 'curious',
    accessory: ['none', 'visor', 'antenna', 'headphones', 'crown'].includes(appearance.accessory) ? appearance.accessory : 'none',
    biome: ['library', 'workshop', 'studio', 'observatory', 'garden'].includes(appearance.biome) ? appearance.biome : 'library',
  };
  const color = pgColor(appearance.primary_color);
  const body = safe.base === 'bot'
    ? `<rect x="48" y="47" width="64" height="60" rx="18" fill="${color}"/><rect x="58" y="100" width="14" height="24" rx="7" fill="${color}"/><rect x="88" y="100" width="14" height="24" rx="7" fill="${color}"/>`
    : safe.base === 'sprite'
      ? `<path d="M80 35 C116 35 125 75 107 107 C96 127 64 127 53 107 C35 75 44 35 80 35Z" fill="${color}"/>`
      : `<circle cx="80" cy="78" r="45" fill="${color}"/><ellipse cx="80" cy="124" rx="30" ry="9" fill="rgba(0,0,0,.25)"/>`;
  const eyes = safe.face === 'focused'
    ? '<path d="M60 70l13 4M100 70l-13 4" stroke="#111827" stroke-width="5" stroke-linecap="round"/><circle cx="68" cy="78" r="4"/><circle cx="92" cy="78" r="4"/>'
    : '<circle cx="66" cy="75" r="6" fill="#111827"/><circle cx="94" cy="75" r="6" fill="#111827"/>';
  const mouth = safe.face === 'friendly' ? '<path d="M65 91 Q80 104 95 91" fill="none" stroke="#111827" stroke-width="5" stroke-linecap="round"/>' : '<path d="M70 94 Q80 99 90 94" fill="none" stroke="#111827" stroke-width="4" stroke-linecap="round"/>';
  const accessory = {
    none: '', visor: '<rect x="51" y="63" width="58" height="25" rx="12" fill="rgba(12,18,32,.62)" stroke="white" stroke-opacity=".5"/>',
    antenna: '<path d="M80 37V22" stroke="white" stroke-width="4"/><circle cx="80" cy="17" r="6" fill="#fbbf24"/>',
    headphones: '<path d="M46 75V64a34 34 0 0168 0v11" fill="none" stroke="#111827" stroke-width="8"/><rect x="40" y="70" width="12" height="25" rx="6"/><rect x="108" y="70" width="12" height="25" rx="6"/>',
    crown: '<path d="M56 42l8-18 16 14 16-14 8 18z" fill="#fbbf24" stroke="#fff" stroke-width="2"/>',
  }[safe.accessory];
  return `<svg class="pg-avatar-svg biome-${safe.biome}" viewBox="0 0 160 150" role="img" aria-label="Avatar de ${pgEsc(label)}"><defs><radialGradient id="pgGlow"><stop offset="0" stop-color="${color}" stop-opacity=".35"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient></defs><circle cx="80" cy="78" r="72" fill="url(#pgGlow)"/>${body}${eyes}${mouth}${accessory}</svg>`;
}

function pgGate(message = '') {
  document.getElementById('pageContent').innerHTML = `<section class="card pg-gate"><div class="pg-gate-orb">🧬</div><h1 class="page-title">Agent Playground</h1><p class="page-subtitle">Diseña, equipa y crea un agente Hermes real.</p><form id="pgTokenForm" class="profiles-form"><label class="form-label" for="pgToken">Admin token</label><input id="pgToken" class="form-input" type="password" autocomplete="off" required><button class="btn btn-primary" type="submit">Entrar al Playground</button><p class="profiles-status profiles-error" role="status">${pgEsc(message)}</p></form></section>`;
  document.getElementById('pgTokenForm').onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const status = form.querySelector('[role="status"]');
    button.disabled = true;
    button.textContent = 'Cargando mundo…';
    status.textContent = 'Consultando perfiles y catálogo aprobado…';
    sessionStorage.setItem(PLAYGROUND_TOKEN_KEY, document.getElementById('pgToken').value);
    try { await pgLoadWorld(); } catch (error) { sessionStorage.removeItem(PLAYGROUND_TOKEN_KEY); pgGate(error.status === 401 ? 'Token administrativo inválido.' : error.message); }
  };
}

async function renderAgentPlayground() {
  pgRestoreDraft();
  if (!pgToken()) { pgGate(); return; }
  try { await pgLoadWorld(); } catch (error) {
    if (error.status === 401) { sessionStorage.removeItem(PLAYGROUND_TOKEN_KEY); pgGate('La sesión administrativa terminó.'); }
    else document.getElementById('pageContent').innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠</div><div class="empty-state-title">No se pudo abrir el mundo</div><div class="empty-state-desc">${pgEsc(error.message)}</div></div>`;
  }
}

async function pgLoadWorld() {
  const [catalog, agents] = await Promise.all([api.getPlaygroundCatalog(), api.getPlaygroundAgents()]);
  playgroundState.catalog = catalog;
  playgroundState.agents = agents;
  playgroundState.room = null;
  renderAgentPlaza();
}

function renderAgentPlaza() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `<div class="pg-hero"><div><span class="pg-kicker">YOUR AGENT UNIVERSE</span><h1>Plaza de agentes</h1><p>Cada agente tiene una misión real, una identidad visual y un loadout de skills verificables.</p></div><div class="pg-hero-actions"><button class="btn btn-primary" id="pgCreate">＋ Crear agente</button><button class="btn" id="pgManage">Modo administrador</button><button class="btn btn-ghost" id="pgLock">Bloquear</button></div></div><section class="pg-plaza" id="pgPlaza"></section>`;
  const plaza = document.getElementById('pgPlaza');
  if (!playgroundState.agents.length) plaza.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🌌</div><div class="empty-state-title">Tu universo está vacío</div></div>';
  else plaza.innerHTML = playgroundState.agents.map((room, index) => {
    const agent = room.agent || {};
    const meta = room.metadata;
    const appearance = meta && meta.appearance ? meta.appearance : { base: 'orb', primary_color: agent.protected ? 'gold' : 'cyan', face: 'friendly', accessory: agent.protected ? 'crown' : 'none', biome: 'observatory' };
    return `<article class="pg-agent-card"><div class="pg-card-scene">${renderAvatarSvg(appearance, meta ? meta.display_name : agent.name)}</div><div class="pg-card-body"><div class="pg-card-head"><h2>${pgEsc(meta ? meta.display_name : agent.name)}</h2>${agent.protected ? '<span class="badge badge-warning">PROTECTED</span>' : ''}</div><p>${pgEsc(meta ? meta.mission : agent.description, 'Perfil Hermes sin ficha de Playground.')}</p><div class="pg-card-stats"><span>⚡ ${pgEsc(agent.skills_count, 0)} skills</span><span class="pg-health ${agent.health === 'ok' ? 'ok' : ''}">● ${pgEsc(agent.health, 'unknown')}</span></div><button class="btn btn-primary btn-sm pg-visit" data-agent-index="${index}">Visitar</button></div></article>`;
  }).join('');
  document.getElementById('pgCreate').onclick = pgStartCreation;
  document.getElementById('pgManage').onclick = () => { window.location.hash = 'profiles'; };
  document.getElementById('pgLock').onclick = () => { sessionStorage.removeItem(PLAYGROUND_TOKEN_KEY); pgGate('Playground bloqueado.'); };
  plaza.onclick = event => { const button = event.target.closest('[data-agent-index]'); if (button) renderAgentRoom(playgroundState.agents[Number(button.dataset.agentIndex)]); };
}

function pgStartCreation() {
  playgroundState.step = 1;
  playgroundState.room = null;
  playgroundState.preview = null;
  renderAvatarBuilder();
}

function pgWizardShell(title, subtitle, body, options = {}) {
  const steps = ['Apariencia', 'Propósito', 'Arquetipo', 'Skills', 'Ficha'];
  document.getElementById('pageContent').innerHTML = `<div class="pg-wizard-header"><button class="btn btn-ghost" id="pgExit">← Plaza</button><div class="pg-progress" aria-label="Progreso">${steps.map((name, i) => `<div class="pg-progress-step ${i + 1 <= playgroundState.step ? 'active' : ''}"><span>${i + 1}</span><small>${name}</small></div>`).join('')}</div></div><div class="pg-builder"><aside class="pg-avatar-stage"><span class="pg-kicker">LIVE AVATAR</span>${renderAvatarSvg()}<h2>${pgEsc(playgroundState.draft.display_name, 'Sin nombre')}</h2><p>${pgEsc(playgroundState.draft.mission, 'Tu misión aparecerá aquí.')}</p><div class="pg-loadout-mini">${playgroundState.draft.equipped_skills.map(skill => `<span>⚡ ${pgEsc(skill.split('/').pop())}</span>`).join('') || '<span>Inventario vacío</span>'}</div></aside><main class="card pg-step"><span class="pg-step-count">PASO ${playgroundState.step} DE 5</span><h1>${pgEsc(title)}</h1><p class="page-subtitle">${pgEsc(subtitle)}</p><div id="pgStepBody">${body}</div><p id="pgError" class="profiles-status profiles-error" role="status"></p><div class="pg-step-actions">${options.back === false ? '' : '<button class="btn" id="pgBack">Atrás</button>'}<button class="btn btn-primary" id="pgNext">${pgEsc(options.nextLabel || 'Continuar')} →</button></div></main></div>`;
  document.getElementById('pgExit').onclick = renderAgentPlaza;
  if (document.getElementById('pgBack')) document.getElementById('pgBack').onclick = pgPreviousStep;
}

function pgOptions(group, labels) {
  return playgroundState.catalog.appearance[group].map(value => `<button type="button" class="pg-option ${playgroundState.draft.appearance[group] === value ? 'selected' : ''}" data-appearance-group="${pgEsc(group)}" data-appearance-value="${pgEsc(value)}">${pgEsc(labels[value] || value)}</button>`).join('');
}

function renderAvatarBuilder() {
  playgroundState.step = 1;
  const labels = { orb: 'Orbe', bot: 'Bot', sprite: 'Espíritu', violet: 'Violeta', cyan: 'Cian', coral: 'Coral', emerald: 'Esmeralda', gold: 'Dorado', curious: 'Curioso', focused: 'Enfocado', friendly: 'Amable', none: 'Ninguno', visor: 'Visor', antenna: 'Antena', headphones: 'Audífonos', crown: 'Corona', library: 'Biblioteca', workshop: 'Taller', studio: 'Estudio', observatory: 'Observatorio', garden: 'Jardín' };
  const body = `<div class="pg-random-row"><p>Construye una identidad reconocible. La apariencia no cambia permisos.</p><button type="button" class="btn btn-sm" id="pgRandom">🎲 Aleatorio</button></div>${Object.keys(playgroundState.catalog.appearance).map(group => `<fieldset class="pg-choice-group"><legend>${pgEsc({ base: 'Forma', primary_color: 'Color', face: 'Expresión', accessory: 'Accesorio', biome: 'Bioma' }[group])}</legend><div class="pg-option-grid">${pgOptions(group, labels)}</div></fieldset>`).join('')}`;
  pgWizardShell('Diseña su avatar', 'Combina una forma, expresión y mundo visual.', body, { back: false });
  document.getElementById('pgStepBody').onclick = event => { const button = event.target.closest('[data-appearance-group]'); if (!button) return; playgroundState.draft.appearance[button.dataset.appearanceGroup] = button.dataset.appearanceValue; pgSaveDraft(); renderAvatarBuilder(); };
  document.getElementById('pgRandom').onclick = () => { Object.entries(playgroundState.catalog.appearance).forEach(([key, values]) => { playgroundState.draft.appearance[key] = values[Math.floor(Math.random() * values.length)]; }); pgSaveDraft(); renderAvatarBuilder(); };
  document.getElementById('pgNext').onclick = renderPurposeStep;
}

function renderPurposeStep() {
  playgroundState.step = 2;
  const d = playgroundState.draft;
  pgWizardShell('Define su propósito', 'Convierte una intención en una misión y límites observables.', `<div class="form-group"><label class="form-label" for="pgDisplayName">Nombre visible</label><input id="pgDisplayName" class="form-input" maxlength="60" value="${pgEsc(d.display_name)}" placeholder="Ej. Luma"></div><div class="form-group"><label class="form-label" for="pgName">Nombre técnico del perfil</label><input id="pgName" class="form-input" maxlength="64" value="${pgEsc(d.name)}" placeholder="luma-research"><small class="form-hint">Letras minúsculas, números y guiones.</small></div><div class="form-group"><label class="form-label" for="pgMission">¿Qué quieres conseguir con este agente?</label><textarea id="pgMission" class="form-textarea" rows="5" maxlength="2000" placeholder="Investigar oportunidades y convertir evidencia en decisiones claras.">${pgEsc(d.mission)}</textarea></div><div class="form-group"><label class="form-label" for="pgBoundary">¿Qué no debe hacer sin permiso?</label><textarea id="pgBoundary" class="form-textarea" rows="3" maxlength="300">${pgEsc(d.boundaries[0] || '')}</textarea></div>`);
  document.getElementById('pgBack').onclick = renderAvatarBuilder;
  document.getElementById('pgNext').onclick = () => { d.display_name = document.getElementById('pgDisplayName').value.trim(); d.name = document.getElementById('pgName').value.trim().toLowerCase(); d.mission = document.getElementById('pgMission').value.trim(); d.boundaries = [document.getElementById('pgBoundary').value.trim()].filter(Boolean); if (d.display_name.length < 2 || !/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(d.name) || d.mission.length < 10) { document.getElementById('pgError').textContent = 'Completa nombre, nombre técnico y una misión de al menos 10 caracteres.'; return; } pgSaveDraft(); renderArchetypeStep(); };
}

function renderArchetypeStep() {
  playgroundState.step = 3;
  const d = playgroundState.draft;
  const body = `<div class="pg-archetypes">${playgroundState.catalog.archetypes.map(item => `<button type="button" class="pg-archetype ${d.archetype === item.id ? 'selected' : ''}" data-archetype="${pgEsc(item.id)}"><span>${item.icon}</span><strong>${pgEsc(item.name)}</strong><small>${pgEsc(item.description)}</small></button>`).join('')}</div><div class="pg-personality"><label class="form-label">Nivel de detalle<select class="form-select" id="pgDetail"><option value="concise">Conciso</option><option value="balanced">Equilibrado</option><option value="detailed">Detallado</option></select></label><label class="form-label">Tono<select class="form-select" id="pgTone"><option value="formal">Formal</option><option value="balanced">Equilibrado</option><option value="warm">Cercano</option></select></label><label class="form-label">Iniciativa<select class="form-select" id="pgInitiative"><option value="reactive">Reactivo</option><option value="ask-first">Pregunta primero</option><option value="proactive-with-approval">Proactivo con aprobación</option></select></label></div>`;
  pgWizardShell('Elige su arquetipo', 'Define su especialidad inicial, no un límite permanente.', body);
  document.getElementById('pgDetail').value = d.communication.detail; document.getElementById('pgTone').value = d.communication.tone; document.getElementById('pgInitiative').value = d.communication.initiative;
  document.querySelector('.pg-archetypes').onclick = event => { const button = event.target.closest('[data-archetype]'); if (button) { d.archetype = button.dataset.archetype; pgSaveDraft(); renderArchetypeStep(); } };
  document.getElementById('pgBack').onclick = renderPurposeStep;
  document.getElementById('pgNext').onclick = () => { d.communication = { detail: document.getElementById('pgDetail').value, tone: document.getElementById('pgTone').value, initiative: document.getElementById('pgInitiative').value }; pgSaveDraft(); renderSkillStoreStep(); };
}

function renderSkillStoreStep() {
  playgroundState.step = 4;
  const categories = ['all', ...new Set(playgroundState.catalog.skills.map(skill => skill.category))];
  const archetype = playgroundState.catalog.archetypes.find(item => item.id === playgroundState.draft.archetype);
  const filtered = playgroundState.catalog.skills.filter(skill => (playgroundState.skillCategory === 'all' || skill.category === playgroundState.skillCategory) && `${skill.name} ${skill.description}`.toLowerCase().includes(playgroundState.skillQuery.toLowerCase())).sort((a, b) => Number(archetype.suggested_categories.includes(b.category)) - Number(archetype.suggested_categories.includes(a.category)) || a.name.localeCompare(b.name));
  const body = `<div class="pg-store-toolbar"><input class="form-input" id="pgSkillSearch" placeholder="Buscar skills..." value="${pgEsc(playgroundState.skillQuery)}"><select class="form-select" id="pgSkillCategory">${categories.map(category => `<option value="${pgEsc(category)}">${pgEsc(category === 'all' ? 'Todas las categorías' : category)}</option>`).join('')}</select><span class="pg-slot-count">${playgroundState.draft.equipped_skills.length}/3 slots</span></div><p class="form-hint">Una skill es un procedimiento especializado. Instalada no significa que sus credenciales estén conectadas.</p><div class="pg-skill-grid">${filtered.map((skill, index) => { const equipped = playgroundState.draft.equipped_skills.includes(skill.id); const suggested = archetype.suggested_categories.includes(skill.category); return `<button type="button" class="pg-skill ${equipped ? 'equipped' : ''}" data-skill-index="${index}"><span class="pg-skill-icon">${equipped ? '✓' : '⚡'}</span><strong>${pgEsc(skill.name)}</strong><small>${pgEsc(skill.description)}</small><footer><span>${pgEsc(skill.category)}</span>${suggested ? '<b>SUGERIDA</b>' : ''}</footer></button>`; }).join('') || '<div class="empty-state"><div class="empty-state-title">No hay coincidencias</div></div>'}</div>`;
  pgWizardShell('Equipa sus primeras skills', 'Elige un loadout pequeño y coherente. Podrás evolucionarlo después.', body);
  document.getElementById('pgSkillCategory').value = playgroundState.skillCategory;
  document.getElementById('pgSkillSearch').oninput = event => {
    playgroundState.skillQuery = event.target.value;
    clearTimeout(playgroundState.skillSearchTimer);
    playgroundState.skillSearchTimer = setTimeout(() => {
      renderSkillStoreStep();
      const input = document.getElementById('pgSkillSearch');
      if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    }, 160);
  };
  document.getElementById('pgSkillCategory').onchange = event => { playgroundState.skillCategory = event.target.value; renderSkillStoreStep(); };
  document.querySelector('.pg-skill-grid').onclick = event => { const button = event.target.closest('[data-skill-index]'); if (!button) return; const skill = filtered[Number(button.dataset.skillIndex)]; const equipped = playgroundState.draft.equipped_skills; if (equipped.includes(skill.id)) equipped.splice(equipped.indexOf(skill.id), 1); else if (equipped.length < 3) equipped.push(skill.id); else { document.getElementById('pgError').textContent = 'Sólo puedes equipar tres skills en el MVP.'; return; } pgSaveDraft(); renderSkillStoreStep(); };
  document.getElementById('pgBack').onclick = renderArchetypeStep;
  document.getElementById('pgNext').onclick = renderAgentReview;
}

async function renderAgentReview() {
  playgroundState.step = 5;
  pgWizardShell('Revisa su ficha', 'Nada se ha creado todavía. Confirma identidad, límites y loadout.', '<div class="loading"><div class="loading-spinner"></div><span>Generando ficha segura...</span></div>', { nextLabel: 'Crear agente' });
  document.getElementById('pgBack').onclick = renderSkillStoreStep;
  try {
    playgroundState.preview = await api.previewPlaygroundAgent(playgroundState.draft);
    const p = playgroundState.preview.agent_card;
    document.getElementById('pgStepBody').innerHTML = `<div class="pg-agent-sheet"><div><span class="pg-kicker">${pgEsc(p.archetype_icon)} ${pgEsc(p.archetype_name)}</span><h2>${pgEsc(p.display_name)}</h2><code>${pgEsc(p.name)}</code><p>${pgEsc(p.mission)}</p></div><dl><div><dt>Límites</dt><dd>${p.boundaries.map(pgEsc).join('<br>') || 'Aprobación humana'}</dd></div><div><dt>Comunicación</dt><dd>${pgEsc(p.communication.detail)} · ${pgEsc(p.communication.tone)} · ${pgEsc(p.communication.initiative)}</dd></div><div><dt>Loadout</dt><dd>${p.equipped_skills.map(skill => `⚡ ${pgEsc(skill)}`).join('<br>') || 'Sin skills iniciales'}</dd></div></dl><details><summary>Vista previa de identidad técnica</summary><pre>${pgEsc(playgroundState.preview.soul_preview)}</pre></details><div class="pg-spawn-warning">Crear agente generará un perfil Hermes real. El gateway permanecerá detenido y no se copiarán secretos.</div></div>`;
    document.getElementById('pgNext').onclick = pgSpawn;
  } catch (error) { document.getElementById('pgStepBody').innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠</div><div class="empty-state-title">Ficha inválida</div><div class="empty-state-desc">${pgEsc(error.message)}</div></div>`; document.getElementById('pgNext').disabled = true; }
}

async function pgSpawn() {
  const button = document.getElementById('pgNext');
  button.disabled = true; button.textContent = 'Incubando agente…';
  try {
    playgroundState.room = await api.spawnPlaygroundAgent(playgroundState.draft);
    sessionStorage.removeItem(PLAYGROUND_DRAFT_KEY);
    playgroundState.agents = await api.getPlaygroundAgents();
    renderAgentRoom(playgroundState.room, true);
  } catch (error) { button.disabled = false; button.textContent = 'Crear agente →'; document.getElementById('pgError').textContent = error.message; }
}

function renderAgentRoom(room, justSpawned = false) {
  const agent = room.agent || {}; const meta = room.metadata;
  const appearance = meta && meta.appearance ? meta.appearance : { base: 'orb', primary_color: 'cyan', face: 'friendly', accessory: 'none', biome: 'observatory' };
  document.getElementById('pageContent').innerHTML = `<div class="pg-room biome-${pgEsc(appearance.biome)}"><div class="pg-room-top"><button class="btn btn-ghost" id="pgRoomBack">← Plaza</button>${justSpawned ? '<span class="badge badge-success">AGENTE CREADO</span>' : ''}<button class="btn" id="pgRoomAdmin">Administrar perfil</button></div><div class="pg-room-scene">${renderAvatarSvg(appearance, meta ? meta.display_name : agent.name)}<div class="pg-room-identity"><span class="pg-kicker">${pgEsc(meta ? meta.archetype.toUpperCase() : 'HERMES PROFILE')}</span><h1>${pgEsc(meta ? meta.display_name : agent.name)}</h1><p>${pgEsc(meta ? meta.mission : agent.description, 'Perfil sin ficha de Playground.')}</p></div></div><div class="pg-room-panels"><section class="card"><h2>⚡ Loadout</h2><div class="pg-loadout">${meta && meta.equipped_skills.length ? meta.equipped_skills.map(skill => `<span>⚡ ${pgEsc(skill)}</span>`).join('') : '<p class="page-subtitle">Sin skills del Playground.</p>'}</div></section><section class="card"><h2>🩺 Preparación real</h2><ul class="pg-checklist"><li class="done">✓ Identidad ${meta ? 'creada' : 'heredada'}</li><li class="${agent.skills_count > 0 ? 'done' : ''}">${agent.skills_count > 0 ? '✓' : '○'} ${pgEsc(agent.skills_count, 0)} skills instaladas</li><li class="${agent.model ? 'done' : ''}">${agent.model ? '✓' : '○'} Modelo ${pgEsc(agent.model, 'pendiente')}</li><li class="${String(agent.gateway).toLowerCase() === 'stopped' ? 'done' : ''}">✓ Gateway: ${pgEsc(agent.gateway, 'unknown')}</li><li>○ Primera conversación por validar</li></ul></section><section class="card"><h2>🧬 Evolución</h2><p class="page-subtitle">Los hitos aparecerán cuando exista evidencia, no por tiempo ni actividad artificial.</p><div class="progress-bar"><div class="progress-fill" style="width:${meta ? '40' : '20'}%"></div></div><small>${meta ? 'Identidad y loadout configurados' : 'Perfil descubierto'}</small></section></div></div>`;
  document.getElementById('pgRoomBack').onclick = renderAgentPlaza;
  document.getElementById('pgRoomAdmin').onclick = () => { window.location.hash = 'profiles'; };
}

function pgPreviousStep() {
  ({ 2: renderAvatarBuilder, 3: renderPurposeStep, 4: renderArchetypeStep, 5: renderSkillStoreStep }[playgroundState.step] || renderAgentPlaza)();
}
