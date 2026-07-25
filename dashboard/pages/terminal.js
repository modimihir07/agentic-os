async function renderTerminal() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h1 class="page-title">Terminal</h1>
        <p class="page-subtitle">Full bash shell in the browser — WSL environment</p>
      </div>
      <div class="btn-group">
        <button class="btn btn-ghost" onclick="terminalReconnect()">↻ Reconnect</button>
        <button class="btn btn-ghost" onclick="terminalClear()">✕ Clear</button>
        <span id="terminalStatus" class="nav-badge" style="background:var(--yellow)">Connecting...</span>
      </div>
    </div>
    <div class="terminal-container">
      <div id="terminal"></div>
    </div>
  `;

  // Load xterm.js from CDN (with fallback)
  try {
    await loadScript('https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js');
    await loadScript('https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js');
  } catch (err) {
    // Fallback to unpkg
    await loadScript('https://unpkg.com/xterm@5.3.0/lib/xterm.min.js');
    await loadScript('https://unpkg.com/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js');
  }

  // Verify Terminal and FitAddon are available
  if (typeof Terminal === 'undefined') {
    throw new Error('xterm.js failed to load from CDN');
  }

  // Initialize terminal
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Courier New', monospace",
    theme: {
      background: '#0d1117',
      foreground: '#c9d1d9',
      cursor: '#58a6ff',
      selection: '#264f78',
      black: '#0d1117',
      red: '#ff7b72',
      green: '#3fb950',
      yellow: '#d29922',
      blue: '#58a6ff',
      magenta: '#bc8cff',
      cyan: '#39d2c0',
      white: '#c9d1d9',
    },
    scrollback: 50000,
    allowProposedApi: true,
    convertEol: true,
  });

  const FitAddonClass = window.FitAddon?.FitAddon || window.FitAddon;
  if (!FitAddonClass) {
    throw new Error('xterm FitAddon failed to load');
  }
  const fitAddon = new FitAddonClass();
  term.loadAddon(fitAddon);
  term.open(document.getElementById('terminal'));
  fitAddon.fit();

  window._agenticTerm = term;
  window._agenticFit = fitAddon;

  // Connect WebSocket
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsPort = 8082;
  const wsUrl = `${protocol}//${window.location.hostname}:${wsPort}`;
  const statusEl = document.getElementById('terminalStatus');

  try {
    const ws = new WebSocket(wsUrl);
    window._agenticWs = ws;

    ws.onopen = () => {
      statusEl.textContent = 'Connected';
      statusEl.style.background = 'var(--green)';
      term.writeln('\x1b[32m✓ Connected to Agentic OS terminal\x1b[0m');
      term.writeln(`\x1b[90m  WSL • ${navigator.userAgent.includes('Windows') ? 'Windows browser → WSL shell' : 'Linux shell'}\x1b[0m\r\n`);
      ws.send(JSON.stringify({ action: 'resize', cols: term.cols, rows: term.rows }));
    };

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        term.write(event.data);
      }
    };

    ws.onclose = () => {
      statusEl.textContent = 'Disconnected';
      statusEl.style.background = 'var(--red)';
      term.writeln('\r\n\x1b[31m✕ Connection closed\x1b[0m');
    };

    ws.onerror = () => {
      statusEl.textContent = 'Error';
      statusEl.style.background = 'var(--red)';
    };

    // Send input
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: 'input', data: data }));
      }
    });

    // Resize handler with debounce
    let resizeTimeout;
    const resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        fitAddon.fit();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ action: 'resize', cols: term.cols, rows: term.rows }));
        }
      }, 100);
    });
    resizeObserver.observe(document.getElementById('terminal'));
    window._agenticResize = resizeObserver;

  } catch (err) {
    statusEl.textContent = 'Failed';
    statusEl.style.background = 'var(--red)';
    term.writeln(`\x1b[31mError: ${err.message}\x1b[0m`);
  }

  term.focus();
}

function terminalReconnect() {
  if (window._agenticWs) window._agenticWs.close();
  if (window._agenticResize) window._agenticResize.disconnect();
  renderTerminal();
}

function terminalClear() {
  if (window._agenticTerm) {
    window._agenticTerm.clear();
    // Also send clear escape sequence to PTY
    if (window._agenticWs && window._agenticWs.readyState === WebSocket.OPEN) {
      window._agenticWs.send(JSON.stringify({ action: 'input', data: '\x0c' }));
    }
  }
}
