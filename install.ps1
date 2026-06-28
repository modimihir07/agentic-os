$ErrorActionPreference = "Stop"

Write-Host "=== Agentic OS Windows Installer ==="
Write-Host ""

function Test-Command {
    param([string]$Name)
    return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

# Check Python
if (Test-Command "python") {
    Write-Host "Python: $(python --version)"
} elseif (Test-Command "py") {
    Write-Host "Python: $(py --version)"
} else {
    Write-Host "ERROR: Python 3.10+ required. Install from https://www.python.org/downloads/ or winget install Python.Python.3.12"
    exit 1
}

# Install Python dependencies
Write-Host "Installing Python dependencies..."
if (Test-Command "python") {
    python -m pip install -r requirements.txt --quiet
} else {
    py -m pip install -r requirements.txt --quiet
}

# Check Node.js (for opencode and Gemini CLI)
if (Test-Command "node") {
    Write-Host "Node.js: $(node --version)"
} else {
    Write-Host "WARNING: Node.js not found. opencode and Gemini CLI require Node.js 18+."
    Write-Host "  Install from https://nodejs.org/ or run: winget install OpenJS.NodeJS.LTS"
}

# Check opencode
if (Test-Command "opencode") {
    $opencodeVersion = (& opencode --version 2>$null)
    if ($LASTEXITCODE -eq 0 -and $opencodeVersion) {
        Write-Host "opencode: $opencodeVersion"
    } else {
        Write-Host "opencode: installed"
    }
} else {
    Write-Host "WARNING: opencode not found. Install via: npm install -g @opencode/cli"
}

# Check Gemini CLI
if (Test-Command "gemini") {
    Write-Host "Gemini CLI: found"
} else {
    Write-Host "WARNING: Gemini CLI not found. Install via: npm install -g @google/gemini-cli"
}

# Check Hermes Agent
if (Test-Command "hermes") {
    Write-Host "Hermes Agent: found"
} else {
    Write-Host "WARNING: Hermes Agent not found. Native Windows installer support is not confirmed by this project."
    Write-Host "  Check upstream Hermes Agent documentation for current Windows support."
    Write-Host "  If no native installer is available, use WSL for Hermes Agent."
}

# Create required directories
New-Item -ItemType Directory -Force -Path "backups", "audit" | Out-Null

# Initialize git if not already initialized
if (-not (Test-Path ".git")) {
    Write-Host "Initializing git repository..."
    git init | Out-Null
    if (-not (Test-Path ".gitignore")) {
        New-Item -ItemType File -Path ".gitignore" | Out-Null
    }
    $gitignore = Get-Content ".gitignore" -ErrorAction SilentlyContinue
    foreach ($entry in @("audit/*", "backups/*.tar.gz", "data/settings.json")) {
        if ($gitignore -notcontains $entry) {
            Add-Content ".gitignore" $entry
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

    throw "Python 3.10+ is required. Install it from https://www.python.org/downloads/ and check 'Add Python to PATH'."
}

$python = Resolve-Python
$pythonCommand = $python.Command
$pythonArgs = @($python.Args)
$pythonVersion = & $pythonCommand @pythonArgs --version
Write-Host "Python: $pythonVersion"

Write-Host "Installing Python dependencies..."
& $pythonCommand @pythonArgs -m pip install -r requirements.txt --quiet

# Check Node.js (for opencode)
if (Get-Command node -ErrorAction SilentlyContinue) {
    Write-Host "Node.js: $(node --version)"
} else {
    Write-Warning "Node.js not found. opencode requires Node 18+. Install from https://nodejs.org/."
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
    Write-Warning "Hermes Agent not found. See the Hermes Agent documentation for Windows installation guidance."
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

Write-Host ""
Write-Host "=== Installation complete! ==="
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Edit data/settings.json with your API keys"
Write-Host "  2. Run python .\server.py to launch the dashboard"
Write-Host "  3. Open http://127.0.0.1:8080 in your browser"
Write-Host ""
Write-Host "Optional agent CLI reminders:"
Write-Host "  opencode: npm install -g @opencode/cli"
Write-Host "  Gemini:   npm install -g @google/gemini-cli"
Write-Host "  Hermes:   Use upstream docs for native Windows support, or WSL if native support is unavailable."
Write-Host "  2. Run .\start.ps1 to launch the dashboard"
Write-Host "  3. Open http://127.0.0.1:8080 in your browser"
