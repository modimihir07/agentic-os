// Brain Search — query the centralized brain index (brain/ notes,
// skill learnings, chat history) via /api/brain-index/search.

async function renderBrainSearch() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h1 class="page-title">Brain Search</h1>
        <p class="page-subtitle">Full-text search across your unified knowledge: notes, skill learnings, chat history</p>
      </div>
      <button class="btn btn-secondary" onclick="brainSearchIngest()">⟳ Re-ingest</button>
    </div>
    <div class="card mb-4">
      <div class="flex gap-2 items-center">
        <input id="brainQuery" class="form-input" style="flex:1" placeholder="Search the brain… (e.g. router, gemini, deployment)" onkeydown="if(event.key==='Enter')brainSearchRun()" />
        <select id="brainSource" class="form-input" style="max-width:180px">
          <option value="">All sources</option>
          <option value="brain">📝 Notes (brain/)</option>
          <option value="skill-learning">🧠 Skill learnings</option>
          <option value="chat">💬 Chat history</option>
        </select>
        <button class="btn btn-primary" onclick="brainSearchRun()">Search</button>
      </div>
      <div id="brainStats" class="mt-2" style="font-size:11px;color:var(--text-muted)"></div>
    </div>
    <div id="brainResults"><div class="empty-state"><div class="empty-state-icon">🔍</div><div class="empty-state-title">Search your brain</div><div class="empty-state-desc">Type a query above to search across all indexed knowledge.</div></div></div>
  `;
  // Load stats + initial hint.
  try {
    const s = await api.getBrainIndexStats();
    const parts = Object.entries(s)
      .filter(([k]) => k !== 'total')
      .map(([k, v]) => `${k}: ${v}`);
    document.getElementById('brainStats').textContent =
      `Indexed: ${s.total || 0} docs (${parts.join(' · ')})`;
  } catch (e) {
    document.getElementById('brainStats').textContent = 'Index not built yet — click Re-ingest.';
  }
}

async function brainSearchRun() {
  const q = document.getElementById('brainQuery').value.trim();
  const source = document.getElementById('brainSource').value;
  const box = document.getElementById('brainResults');
  if (!q) { box.innerHTML = '<div class="empty-state"><div class="empty-state-title">Enter a search term</div></div>'; return; }
  box.innerHTML = '<div class="loading"><div class="loading-spinner"></div><span>Searching…</span></div>';
  try {
    const data = await api.getBrainIndexSearch(q, source);
    if (!data.results.length) {
      box.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🔍</div><div class="empty-state-title">No results</div><div class="empty-state-desc">Nothing matched "' + escapeHtml(q) + '"' + (source ? ' in ' + escapeHtml(source) : '') + '.</div></div>';
      return;
    }
    box.innerHTML = `<div class="page-subtitle mb-2">${data.count} result(s) for "${escapeHtml(q)}"</div>` +
      data.results.map(r => {
        const srcIcon = { 'brain': '📝', 'skill-learning': '🧠', 'chat': '💬', 'agent-note': '🤖' }[r.source] || '📄';
        const agent = r.agent ? `<span class="badge badge-accent" style="font-size:10px;margin-left:6px">${escapeHtml(r.agent)}</span>` : '';
        return `
          <div class="card mb-2" style="border-left:4px solid var(--accent)">
            <div class="flex items-center gap-2 mb-1">
              <span>${srcIcon}</span>
              <strong style="font-size:13px">${escapeHtml(r.title)}</strong>
              <span class="badge" style="font-size:10px;opacity:.7">${escapeHtml(r.source)}</span>
              ${agent}
            </div>
            <div style="font-size:12px;color:var(--text-muted);white-space:pre-wrap">${escapeHtml(r.snippet || '')}</div>
          </div>`;
      }).join('');
  } catch (err) {
    box.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠</div><div class="empty-state-title">Search failed</div><div class="empty-state-desc">${escapeHtml(err.message)}</div></div>`;
  }
}

async function brainSearchIngest() {
  const btn = event && event.target;
  if (btn) { btn.disabled = true; btn.textContent = 'Ingesting…'; }
  try {
    const r = await api.brainIndexIngest();
    const s = r.stats || {};
    if (btn) btn.textContent = '✓ Re-ingest';
    const statEl = document.getElementById('brainStats');
    if (statEl) {
      const parts = Object.entries(s).filter(([k]) => k !== 'total').map(([k, v]) => `${k}: ${v}`);
      statEl.textContent = `Indexed: ${s.total || 0} docs (${parts.join(' · ')})`;
    }
  } catch (e) {
    if (btn) btn.textContent = 'Ingest failed';
  } finally {
    if (btn) setTimeout(() => { btn.disabled = false; btn.textContent = '⟳ Re-ingest'; }, 1500);
  }
}
