let journalCurrentDate = '';

async function renderJournal() {
  const today = new Date().toISOString().split('T')[0];
  journalCurrentDate = today;
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <div class="page-title">Journal</div>
        <div class="page-subtitle">Daily entries and notes — auto-saved to brain/journal/</div>
      </div>
      <div class="btn-group">
        <input class="form-input" type="date" id="journalDatePicker" value="${today}" onchange="loadJournalEntry(this.value)" style="width:160px">
        <button class="btn btn-ghost" onclick="renderJournal()">🔄 Refresh</button>
      </div>
    </div>
    <div class="flex gap-3" style="margin-bottom:16px">
      <div class="metric-tile" style="flex:1">
        <div class="metric-tile-value" id="journalTotalCount">0</div>
        <div class="metric-tile-label">Total Entries</div>
      </div>
      <div class="metric-tile" style="flex:1">
        <div class="metric-tile-value" id="journalWordCount">0</div>
        <div class="metric-tile-label">Words Today</div>
      </div>
      <div class="metric-tile" style="flex:1">
        <div class="metric-tile-value" id="journalStreak">0</div>
        <div class="metric-tile-label">Day Streak</div>
      </div>
    </div>
    <div class="flex gap-3" style="margin-bottom:16px">
      <div style="flex:1;display:flex;gap:8px">
        <input class="form-input" id="journalSearchInput" placeholder="Search entries..." style="flex:1">
        <button class="btn btn-ghost" onclick="searchJournal()">🔍 Search</button>
      </div>
    </div>
    <div class="journal-entry" id="journalEditor">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div style="font-weight:600;font-size:14px" id="journalDateLabel">${formatDateDisplay(today)}</div>
        <div>
          <span class="badge badge-info" id="journalSaveStatus">Auto-save on</span>
        </div>
      </div>
      <textarea id="journalText" placeholder="Write your daily entry here... Markdown supported." oninput="scheduleJournalSave()"></textarea>
    </div>
    <div id="journalEntriesList" style="margin-top:16px"></div>
  `;
  loadJournalEntry(today);
  loadJournalEntries();
}

function formatDateDisplay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

let journalSaveTimer = null;
function scheduleJournalSave() {
  if (journalSaveTimer) clearTimeout(journalSaveTimer);
  journalSaveTimer = setTimeout(saveJournalEntry, 2000);
  const status = document.getElementById('journalSaveStatus');
  if (status) status.textContent = 'Unsaved changes...';
}

async function saveJournalEntry() {
  const textarea = document.getElementById('journalText');
  if (!textarea) return;
  const content = textarea.value;
  const date = journalCurrentDate;
  try {
    await api.saveJournalEntry(date, content);
    const status = document.getElementById('journalSaveStatus');
    if (status) status.textContent = 'Saved ✓';
    const words = content.trim() ? content.trim().split(/\s+/).length : 0;
    const wc = document.getElementById('journalWordCount');
    if (wc) wc.textContent = words;
  } catch (err) {
    const status = document.getElementById('journalSaveStatus');
    if (status) status.textContent = 'Save failed';
  }
}

async function loadJournalEntry(date) {
  journalCurrentDate = date;
  const label = document.getElementById('journalDateLabel');
  if (label) label.textContent = formatDateDisplay(date);
  const textarea = document.getElementById('journalText');
  if (!textarea) return;
  try {
    const data = await api.getJournalEntry(date);
    textarea.value = data.content || '';
    const words = data.content ? data.content.trim().split(/\s+/).length : 0;
    const wc = document.getElementById('journalWordCount');
    if (wc) wc.textContent = words;
    const status = document.getElementById('journalSaveStatus');
    if (status) status.textContent = 'Loaded ✓';
  } catch (err) {
    textarea.value = '';
  }
}

async function loadJournalEntries() {
  try {
    const data = await api.getJournalEntries();
    const entries = data.entries || [];
    const totalEl = document.getElementById('journalTotalCount');
    if (totalEl) totalEl.textContent = entries.length;
    let streak = 0;
    const today = new Date();
    for (let i = 0; i < 365; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const ds = d.toISOString().split('T')[0];
      if (entries.some(e => e.date === ds)) { streak++; }
      else if (i > 0) break;
    }
    const streakEl = document.getElementById('journalStreak');
    if (streakEl) streakEl.textContent = streak;
    const list = document.getElementById('journalEntriesList');
    if (!list) return;
    if (entries.length === 0) {
      list.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📓</div><div class="empty-state-title">No journal entries yet</div><div class="empty-state-desc">Write your first entry above</div></div>`;
      return;
    }
    list.innerHTML = `
      <div class="section-title">Recent Entries</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        ${entries.slice(0, 30).map(e => `
          <button class="btn btn-sm ${e.date === journalCurrentDate ? 'btn-primary' : 'btn-ghost'}" onclick="loadJournalEntry('${e.date}');document.getElementById('journalDatePicker').value='${e.date}'">
            ${e.date}
          </button>
        `).join('')}
      </div>
    `;
  } catch (err) {
    showToast('Failed to load entries: ' + err.message, 'error');
  }
}

async function searchJournal() {
  const q = document.getElementById('journalSearchInput').value.trim();
  if (!q) { loadJournalEntries(); return; }
  try {
    const data = await api.searchJournal(q);
    const results = data.results || [];
    const list = document.getElementById('journalEntriesList');
    if (!list) return;
    if (results.length === 0) {
      list.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🔍</div><div class="empty-state-title">No results for "${escapeHtml(q)}"</div></div>`;
      return;
    }
    list.innerHTML = `
      <div class="section-title">Results for "${escapeHtml(q)}"</div>
      ${results.map(r => `
        <div class="card" style="cursor:pointer;margin-bottom:8px" onclick="loadJournalEntry('${r.date}');document.getElementById('journalDatePicker').value='${r.date}'">
          <div style="font-size:13px;font-weight:600;margin-bottom:4px">${r.date}</div>
          <div class="text-muted text-sm">${escapeHtml(r.preview)}</div>
        </div>
      `).join('')}
    `;
  } catch (err) {
    showToast('Search failed: ' + err.message, 'error');
  }
}
