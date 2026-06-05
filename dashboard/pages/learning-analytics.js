async function renderLearningAnalytics() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <div class="page-title">Learning Analytics</div>
        <div class="page-subtitle">Skill evaluation scores and performance trends</div>
      </div>
      <div class="btn-group">
        <button class="btn btn-ghost" onclick="renderLearningAnalytics()">🔄 Refresh</button>
      </div>
    </div>
    <div class="section-title">Skill Scores</div>
    <div id="skillScoresGrid" class="grid grid-3" style="margin-bottom:20px">
      <div class="skeleton" style="height:100px"></div>
      <div class="skeleton" style="height:100px"></div>
      <div class="skeleton" style="height:100px"></div>
    </div>
    <div class="section-title">Score Trends</div>
    <div id="trendCharts" class="grid grid-2"></div>
    <div class="section-title">Skill Details</div>
    <div id="skillDetailsList"></div>
  `;
  try {
    const [skillData, trendData] = await Promise.all([api.getSkillAnalytics(), api.getTrendAnalytics()]);
    const skills = skillData.skills || [];
    const trends = trendData.trends || {};
    const grid = document.getElementById('skillScoresGrid');
    if (grid) {
      if (skills.length === 0) {
        grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-state-icon">📊</div><div class="empty-state-title">No skill data yet</div><div class="empty-state-desc">Skill evaluations will appear here as they accumulate</div></div>`;
      } else {
        const topSkills = skills.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 6);
        grid.innerHTML = topSkills.map(s => {
          const pct = Math.round((s.score || 0) * 100);
          return `
            <div class="card chart-card" style="position:relative">
              <div style="font-size:13px;font-weight:600;margin-bottom:4px;text-transform:capitalize">${escapeHtml(s.name)}</div>
              <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">${s.evals || 0} evaluations</div>
              <div style="display:flex;align-items:center;gap:12px">
                <div style="flex:1;height:6px;background:var(--bg-dim);border-radius:99px;overflow:hidden">
                  <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,var(--accent),var(--accent-light));border-radius:99px;transition:width 0.6s ease"></div>
                </div>
                <span style="font-size:14px;font-weight:700;color:var(--accent-light)">${pct}%</span>
              </div>
            </div>
          `;
        }).join('');
      }
    }
    const trendSection = document.getElementById('trendCharts');
    if (trendSection) {
      const trendEntries = Object.entries(trends).slice(0, 4);
      if (trendEntries.length === 0) {
        trendSection.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-state-icon">📈</div><div class="empty-state-title">No trend data</div><div class="empty-state-desc">Trends will appear after multiple evaluations</div></div>`;
      } else {
        trendSection.innerHTML = trendEntries.map(([name, history]) => {
          const vals = (history || []).slice(-10);
          const maxVal = Math.max(...vals, 0.01);
          const chartHeight = 120;
          return `
            <div class="card chart-card">
              <div style="font-size:13px;font-weight:600;margin-bottom:8px;text-transform:capitalize">${escapeHtml(name)}</div>
              <div style="display:flex;align-items:flex-end;gap:3px;height:${chartHeight}px;padding-top:20px">
                ${vals.map((v, i) => {
                  const h = (v / maxVal) * (chartHeight - 25);
                  return `<div style="flex:1;height:${h}px;background:linear-gradient(180deg,var(--accent),var(--accent-light));border-radius:3px 3px 0 0;min-height:4px;transition:height 0.3s ease" title="${(v * 100).toFixed(0)}%"></div>`;
                }).join('')}
              </div>
              <div style="display:flex;justify-content:space-between;margin-top:4px">
                <span class="text-xs text-muted">${vals.length} data points</span>
                <span class="text-xs text-muted">Avg: ${(vals.reduce((a, b) => a + b, 0) / vals.length * 100).toFixed(0)}%</span>
              </div>
            </div>
          `;
        }).join('');
      }
    }
    const details = document.getElementById('skillDetailsList');
    if (details) {
      if (skills.length === 0) {
        details.innerHTML = '';
      } else {
        details.innerHTML = skills.map(s => {
          const pct = Math.round((s.score || 0) * 100);
          return `
            <div class="card" style="margin-bottom:8px">
              <div style="display:flex;align-items:center;justify-content:space-between">
                <div>
                  <div style="font-weight:600;text-transform:capitalize">${escapeHtml(s.name)}</div>
                  <div class="text-muted text-sm">${s.evals || 0} evaluations · Best: ${((s.best || 0) * 100).toFixed(0)}%</div>
                </div>
                <span style="font-size:16px;font-weight:700;color:${pct >= 70 ? 'var(--green)' : pct >= 40 ? 'var(--yellow)' : 'var(--red)'}">${pct}%</span>
              </div>
            </div>
          `;
        }).join('');
      }
    }
  } catch (err) {
    showToast('Failed to load analytics: ' + err.message, 'error');
  }
}
