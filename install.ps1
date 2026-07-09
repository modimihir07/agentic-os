$ErrorActionPreference = "Stop"

Write-Host "=== Agentic OS Installer ==="
Write-Host ""

function Resolve-Python {
    $candidates = @(
        @{ Command = "py"; Args = @("-3.10") },
        @{ Command = "py"; Args = @("-3") },
        @{ Command = "python"; Args = @() }
    )

    foreach ($candidate in $candidates) {
        $cmd = Get-Command $candidate.Command -ErrorAction SilentlyContinue
        if (-not $cmd) { continue }

        try {
            & $candidate.Command @($candidate.Args) --version *> $null
            return $candidate
        } catch {
            continue
        }
    }

    throw "Python 3.10+ is required. Install it from https://www.python.org/downloads/ (check 'Add Python to PATH') or run: winget install Python.Python.3.12"
}

$python = Resolve-Python
$pythonCommand = $python.Command
$pythonArgs = @($python.Args)
$pythonVersion = & $pythonCommand @pythonArgs --version
Write-Host "Python: $pythonVersion"

Write-Host "Installing Python dependencies..."
& $pythonCommand @pythonArgs -m pip install -r requirements.txt --quiet

# Check Node.js (for opencode and Gemini CLI)
if (Get-Command node -ErrorAction SilentlyContinue) {
    Write-Host "Node.js: $(node --version)"
} else {
    Write-Warning "Node.js not found. opencode and Gemini CLI require Node 18+. Install from https://nodejs.org/ or run: winget install OpenJS.NodeJS.LTS"
}

# Check opencode
if (Get-Command opencode -ErrorAction SilentlyContinue) {
    $opencodeVersion = try { opencode --version } catch { "installed" }
    Write-Host "opencode: $opencodeVersion"
} else {
    Write-Warning "opencode not found. Install via: npm install -g @opencode/cli"
}

# Check Hermes
if (Get-Command hermes -ErrorAction SilentlyContinue) {
    Write-Host "Hermes: found"
} else {
    Write-Warning "Hermes Agent not found. Native Windows support is not confirmed by this project - check the upstream Hermes Agent documentation, and use WSL if no native installer is available."
}

# Check Gemini CLI
if (Get-Command gemini -ErrorAction SilentlyContinue) {
    Write-Host "Gemini CLI: found"
} else {
    Write-Warning "Gemini CLI not found. Install via: npm install -g @google/gemini-cli"
}

New-Item -ItemType Directory -Force -Path backups, audit | Out-Null

if (-not (Test-Path .git)) {
    Write-Host "Initializing git repository..."
    git init
    foreach ($entry in @("audit/*", "backups/*.tar.gz", "data/settings.json")) {
        if (-not (Test-Path .gitignore) -or -not (Select-String -Path .gitignore -Pattern ([regex]::Escape($entry)) -Quiet)) {
            Add-Content -Path .gitignore -Value $entry
        }
    }
}

$launcher = Join-Path $PSScriptRoot "Launch-Dashboard.bat"
$desktop = [Environment]::GetFolderPath("Desktop")
if ((Test-Path $launcher) -and (Test-Path $desktop)) {
    try {
        $shortcutPath = Join-Path $desktop "Agentic OS Dashboard.lnk"
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $launcher
        $shortcut.WorkingDirectory = $PSScriptRoot
        $shortcut.Description = "Launch the Agentic OS dashboard"
        $shortcut.Save()
        Write-Host "Desktop shortcut created: $shortcutPath"
    } catch {
        Write-Warning "Could not create Desktop shortcut: $_"
    }
}

Write-Host ""
Write-Host "=== Installation complete! ==="
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Edit data/settings.json with your API keys"
Write-Host "  2. Double-click the 'Agentic OS Dashboard' shortcut on your Desktop"
Write-Host "     (or run .\start.ps1 / .\Launch-Dashboard.bat manually)"
Write-Host "  3. Your browser will open automatically once the server is ready"
Write-Host ""
Write-Host "Optional agent CLI reminders:"
Write-Host "  opencode: npm install -g @opencode/cli"
Write-Host "  Gemini:   npm install -g @google/gemini-cli"
Write-Host "  Hermes:   Use upstream docs for native Windows support, or WSL if native support is unavailable."
