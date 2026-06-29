let setupStep = 0;
const setupSteps = [
  { title: 'Welcome', desc: 'Configure Agentic OS for your environment' },
  { title: 'Agent Discovery', desc: 'Detecting installed agents...' },
  { title: 'Preferences', desc: 'Choose your defaults' },
  { title: 'Ready', desc: 'All set!' },
];

async function renderSetupWizard() {
  const content = document.getElementById('pageContent');
  setupStep = 0;
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h1 class="page-title">Setup Wizard</h1>
        <p class="page-subtitle">Guided configuration for Agentic OS</p>
      </div>
    </div>
    <div class="card" style="max-width:640px;margin:0 auto">
      <div id="wizardBody"></div>
    </div>
  `;
  renderWizardStep();
}

async function renderWizardStep() {
  const body = document.getElementById('wizardBody');
  if (!body) return;
  const step = setupSteps[setupStep];
  if (!step) { finishSetup(); return; }

  body.innerHTML = `
    <div style="margin-bottom:24px">
      <div style="display:flex;gap:6px;margin-bottom:20px">
        ${setupSteps.map((s, i) => `<div style="flex:1;height:4px;border-radius:2px;background:${i <= setupStep ? 'var(--accent)' : 'var(--border)'}"></div>`).join('')}
      </div>
      <h2 style="margin-bottom:4px;font-size:20px">${step.title}</h2>
      <p style="color:var(--text-muted);font-size:13px">${step.desc}</p>
    </div>
    <div id="wizardContent"></div>
    <div class="flex justify-between mt-4" style="padding-top:16px;border-top:1px solid var(--border)">
      <button class="btn btn-ghost" onclick="prevWizardStep()" ${setupStep === 0 ? 'disabled' : ''}>← Back</button>
      <button class="btn btn-primary" onclick="nextWizardStep()">${setupStep === setupSteps.length - 1 ? '✓ Complete' : 'Continue →'}</button>
    </div>
  `;

  const wc = document.getElementById('wizardContent');

  switch (setupStep) {
    case 0:
      wc.innerHTML = `
        <div style="text-align:center;padding:12px 0">
          <div style="font-size:48px;margin-bottom:16px">⬡</div>
          <p style="font-size:14px;color:var(--text-secondary);line-height:1.6">Agentic OS coordinates <strong>opencode</strong>, <strong>Hermes Agent</strong>, and <strong>Gemini CLI</strong> into a unified multi-agent orchestration platform. This wizard will help you get everything configured.</p>
        </div>
      `;
      break;

    case 1:
      wc.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
      try {
        const status = await api.getStatus();
        const agents = status.agents || [];
        wc.innerHTML = `
          <div class="grid grid-2">
            ${agents.map(a => {
              const sc = statusColor(a.status);
              const safeStatus = ({online:'online',offline:'offline',warning:'warning'})[a.status] || 'offline';
              return `<div class="agent-card">
                <div class="agent-dot ${safeStatus}" style="width:14px;height:14px"></div>
                <div>
                  <div style="font-weight:600;font-size:14px">${escapeHtml(a.name)}</div>
                  <div style="font-size:12px;color:${sc.text}">${escapeHtml(a.status)}</div>
                </div>
              </div>`;
            }).join('')}
          </div>
          ${agents.some(a => a.status === 'offline') ? `<div class="card mt-3" style="background:var(--yellow-dim);border-color:transparent;padding:12px"><div class="flex items-center gap-2"><span>⚠</span><span style="font-size:13px">Some agents are offline. Install missing agents to enable full functionality.</span></div></div>` : ''}
        `;
      } catch (err) {
        wc.innerHTML = `<div class="card" style="background:var(--red-dim);border-color:transparent;padding:12px"><div class="flex items-center gap-2"><span>✕</span><span style="font-size:13px">${escapeHtml(err.message)}</span></div></div>`;
      }
      break;

    case 2:
      wc.innerHTML = `
        <div class="form-group">
          <label class="form-label">Default Agent for Unknown Tasks</label>
          <select id="wizDefault" class="form-select">
            <option value="opencode">opencode — Best for code/DevOps</option>
            <option value="hermes">Hermes — Best for memory/scheduling</option>
            <option value="gemini">Gemini CLI — Best for research</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Dashboard Theme</label>
          <select id="wizTheme" class="form-select">
            <option value="dark">Dark (default)</option>
            <option value="light">Light</option>
          </select>
        </div>
      `;
      break;

    case 3:
      wc.innerHTML = `
        <div style="text-align:center;padding:20px 0">
          <div style="font-size:56px;margin-bottom:16px">✓</div>
          <h3 style="font-size:18px;margin-bottom:8px">Agentic OS is ready!</h3>
          <p style="font-size:13px;color:var(--text-muted)">All components are configured. Start exploring the Dashboard or run a skill.</p>
        </div>
      `;
      break;
  }
}

function nextWizardStep() {
  if (setupStep < setupSteps.length - 1) { setupStep++; renderWizardStep(); }
  else { finishSetup(); }
}

function prevWizardStep() {
  if (setupStep > 0) { setupStep--; renderWizardStep(); }
}

function finishSetup() {
  showToast('Setup complete!', 'success');
  navigate('dashboard');
}
