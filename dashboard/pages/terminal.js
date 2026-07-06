async function renderTerminal() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h1 class="page-title">Terminal</h1>
        <p class="page-subtitle">Run shell commands directly on this machine</p>
      </div>
      <div class="btn-group">
        <button class="btn" onclick="clearTerminal()">🗑 Clear</button>
      </div>
    </div>
    <div class="terminal-panel" onclick="focusTerminalInput()">
      <div id="terminalOutput" class="terminal-output"></div>
      <div class="terminal-input-row">
        <span class="terminal-prompt" id="terminalPrompt">$</span>
        <input id="terminalInput" class="terminal-input" type="text" autocomplete="off" spellcheck="false" onkeydown="handleTerminalKey(event)">
      </div>
    </div>
  `;

  window._terminalHistory = window._terminalHistory || [];
  window._terminalHistoryIndex = window._terminalHistory.length;
  window._terminalBusy = false;

  try {
    const session = await api.getTerminalSession();
    updateTerminalPrompt(session.cwd);
  } catch {
    appendTerminalLine('Could not reach the terminal backend.', 'stderr');
  }

  document.getElementById('terminalInput').focus();
}

function focusTerminalInput() {
  const input = document.getElementById('terminalInput');
  if (input) input.focus();
}

function updateTerminalPrompt(cwd) {
  const prompt = document.getElementById('terminalPrompt');
  if (prompt) prompt.textContent = `${cwd} $`;
}

function appendTerminalLine(text, kind = '') {
  const output = document.getElementById('terminalOutput');
  if (!output || !text) return;
  const line = document.createElement('div');
  if (kind) line.className = `terminal-line-${kind}`;
  line.textContent = text;
  output.appendChild(line);
  output.scrollTop = output.scrollHeight;
}

function clearTerminal() {
  const output = document.getElementById('terminalOutput');
  if (output) output.innerHTML = '';
}

async function handleTerminalKey(e) {
  const input = e.target;

  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (window._terminalHistoryIndex > 0) {
      window._terminalHistoryIndex--;
      input.value = window._terminalHistory[window._terminalHistoryIndex] || '';
    }
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (window._terminalHistoryIndex < window._terminalHistory.length - 1) {
      window._terminalHistoryIndex++;
      input.value = window._terminalHistory[window._terminalHistoryIndex] || '';
    } else {
      window._terminalHistoryIndex = window._terminalHistory.length;
      input.value = '';
    }
    return;
  }
  if (e.key !== 'Enter' || window._terminalBusy) return;

  const command = input.value.trim();
  input.value = '';
  if (!command) return;

  window._terminalHistory.push(command);
  window._terminalHistoryIndex = window._terminalHistory.length;

  appendTerminalLine(command, 'cmd');

  if (command === 'clear' || command === 'cls') {
    clearTerminal();
    return;
  }

  window._terminalBusy = true;
  input.disabled = true;
  try {
    const r = await api.runTerminalCommand(command);
    if (r.stdout) appendTerminalLine(r.stdout.replace(/\n$/, ''));
    if (r.stderr) appendTerminalLine(r.stderr.replace(/\n$/, ''), 'stderr');
    if (r.timed_out) appendTerminalLine('Command timed out after 60s.', 'info');
    updateTerminalPrompt(r.cwd);
  } catch (err) {
    appendTerminalLine(`Error: ${err.message}`, 'stderr');
  } finally {
    window._terminalBusy = false;
    input.disabled = false;
    input.focus();
  }
}
