async function renderPrompts() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h1 class="page-title">Prompt Library</h1>
        <p class="page-subtitle">Reusable templates for common agent tasks</p>
      </div>
    </div>
    <div id="promptGrid" class="grid grid-3"></div>
  `;

  try {
    const prompts = await api.getPrompts();
    const entries = Object.entries(prompts);
    const grid = document.getElementById('promptGrid');

    if (entries.length === 0) {
      grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><div class="empty-state-icon">📝</div><div class="empty-state-title">No prompt templates</div></div>';
      return;
    }

    grid.innerHTML = entries.map(([name, content]) => {
      const displayName = name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const preview = content.slice(0, 180);
      const lines = content.split('\n').length;
      return `<div class="skill-card" onclick="viewPrompt('${encodeURIComponent(name)}')">
        <div class="skill-card-header">
          <div class="skill-card-icon">📝</div>
          <div class="skill-card-name">${escapeHtml(displayName)}</div>
        </div>
        <div class="skill-card-desc"><pre style="background:none;border:none;padding:0;max-height:100px;overflow:hidden;font-size:11px;color:var(--text-muted)">${escapeHtml(preview)}${preview.length >= 180 ? '...' : ''}</pre></div>
        <div class="skill-card-footer"><span class="badge badge-info">${lines} lines</span></div>
      </div>`;
    }).join('');
  } catch (err) {
    document.getElementById('promptGrid').innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-state-icon">⚠</div><div class="empty-state-title">${escapeHtml(err.message)}</div></div>`;
  }
}

async function viewPrompt(encodedName) {
  const name = decodeURIComponent(encodedName);
  let content = '';
  try {
    const prompts = await api.getPrompts();
    content = prompts[name] || '';
  } catch {}

  const displayName = escapeHtml(name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()));

  // Store raw content for clipboard copy (avoids HTML entity encoding issue)
  window._promptCopyContent = content;

  showModal(`Prompt: ${displayName}`, `
    <pre style="white-space:pre-wrap;font-size:12px;max-height:60vh;overflow:auto">${escapeHtml(content)}</pre>
  `, `
    <button class="btn btn-primary" onclick="copyPromptFromModal()">📋 Copy</button>
    <button class="btn btn-ghost" onclick="closeModal()">Close</button>
  `);
}

function copyPromptFromModal() {
  const text = window._promptCopyContent || '';
  navigator.clipboard.writeText(text).then(() => {
    showToast('Copied to clipboard', 'success');
  }).catch(() => {
    showToast('Failed to copy', 'error');
  });
}
