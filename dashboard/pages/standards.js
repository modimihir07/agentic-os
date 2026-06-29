async function renderStandards() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h1 class="page-title">Standards</h1>
        <p class="page-subtitle">Project conventions and coding standards</p>
      </div>
      <button class="btn btn-primary" onclick="runDiscovery()">🔍 Discover Patterns</button>
    </div>
    <div id="standardsContent"><div class="loading"><div class="loading-spinner"></div></div></div>
  `;

  try {
    const data = await api.getStandards();
    const standards = data.standards || [];
    const index = data.index || '';
    const container = document.getElementById('standardsContent');

    let html = '';

    if (index) {
      html += `<div class="card"><div class="card-header"><span class="card-title">📐 Standards Index</span></div><pre style="font-size:12px">${escapeHtml(index)}</pre></div>`;
    }

    if (standards.length === 0) {
      html += '<div class="empty-state"><div class="empty-state-icon">📐</div><div class="empty-state-title">No standards defined</div><div class="empty-state-desc">Run "Discover Patterns" to extract conventions from your codebase</div></div>';
    } else {
      html += `<div class="grid grid-2">${standards.map(s => `
        <div class="card" style="cursor:pointer" onclick="viewStandard('${encodeURIComponent(s.name)}')">
          <div class="card-header"><span class="card-title">${escapeHtml(s.name.replace(/-/g, ' '))}</span></div>
          <pre style="max-height:200px;overflow:hidden;font-size:12px">${escapeHtml(s.content.slice(0, 300))}${s.content.length > 300 ? '...' : ''}</pre>
        </div>
      `).join('')}</div>`;
    }

    container.innerHTML = html;
  } catch (err) {
    document.getElementById('standardsContent').innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠</div><div class="empty-state-title">${escapeHtml(err.message)}</div></div>`;
  }
}

async function viewStandard(encodedName) {
  const name = decodeURIComponent(encodedName);
  let content = '';
  try {
    const data = await api.getStandards();
    const std = (data.standards || []).find(s => s.name === name);
    if (std) content = std.content;
  } catch {}

  showModal(`Standard: ${escapeHtml(name.replace(/-/g, ' '))}`, `
    <pre style="white-space:pre-wrap;font-size:12px;max-height:60vh;overflow:auto">${escapeHtml(content)}</pre>
  `, `
    <button class="btn btn-ghost" onclick="closeModal()">Close</button>
  `);
}

async function runDiscovery() {
  try {
    const r = await api.discoverStandards();
    showToast(r.message || 'Discovery started', 'success');
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}
