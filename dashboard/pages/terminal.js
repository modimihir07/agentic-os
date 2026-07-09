let _termInstance = null;
let _termSocket = null;

function loadXterm() {
  if (window.Terminal && window.FitAddon) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (!document.querySelector('link[data-xterm-css]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css';
      link.setAttribute('data-xterm-css', '1');
      document.head.appendChild(link);
    }
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js';
    script.onload = () => {
      const fitScript = document.createElement('script');
      fitScript.src = 'https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js';
      fitScript.onload = () => resolve();
      fitScript.onerror = () => reject(new Error('Failed to load xterm-addon-fit'));
      document.body.appendChild(fitScript);
    };
    script.onerror = () => reject(new Error('Failed to load xterm.js'));
    document.body.appendChild(script);
  });
}

function setTerminalStatus(kind, text) {
  const el = document.getElementById('terminalStatus');
  if (!el) return;
  el.textContent = text;
  el.className = `badge badge-${kind === 'online' ? 'success' : kind === 'offline' ? 'danger' : 'warning'}`;
}

function closeTerminalSession() {
  if (window._terminalResizeHandler) {
    window.removeEventListener('resize', window._terminalResizeHandler);
    window._terminalResizeHandler = null;
  }
  if (_termSocket) {
    try { _termSocket.close(); } catch {}
    _termSocket = null;
  }
  if (_termInstance) {
    try { _termInstance.dispose(); } catch {}
    _termInstance = null;
  }
}

async function renderTerminal() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h1 class="page-title">Terminal</h1>
        <p class="page-subtitle">A real, interactive shell running on this machine</p>
      </div>
      <div class="btn-group">
        <span id="terminalStatus" class="badge badge-warning">Connecting…</span>
      </div>
    </div>
    <div class="terminal-panel">
      <div id="xtermContainer" class="terminal-xterm-container"></div>
    </div>
  `;

  closeTerminalSession();

  try {
    await loadXterm();
  } catch (err) {
    document.getElementById('xtermContainer').innerHTML =
      `<div class="empty-state"><div class="empty-state-icon">⚠</div><div class="empty-state-title">Failed to load terminal library</div><div class="empty-state-desc">${escapeHtml(err.message || String(err))}</div></div>`;
    return;
  }

  const term = new window.Terminal({
    cursorBlink: true,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
    fontSize: 13,
    theme: { background: '#0a0e14', foreground: '#c9d1d9' },
  });
  const fitAddon = new window.FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(document.getElementById('xtermContainer'));
  fitAddon.fit();
  _termInstance = term;

  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${proto}//${window.location.host}/ws/terminal`);
  _termSocket = socket;

  socket.onopen = () => {
    setTerminalStatus('online', 'Connected');
    fitAddon.fit();
    socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    term.focus();
  };
  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'output') term.write(msg.data);
    } catch {}
  };
  socket.onclose = () => setTerminalStatus('offline', 'Disconnected');
  socket.onerror = () => setTerminalStatus('offline', 'Connection error');

  term.onData((data) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }));
  });

  const resizeHandler = () => {
    fitAddon.fit();
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  };
  window.addEventListener('resize', resizeHandler);
  window._terminalResizeHandler = resizeHandler;

  window.addEventListener('hashchange', closeTerminalSession, { once: true });
}
