#!/usr/bin/env bash
set -euo pipefail

echo "=== Agentic OS Installer ==="
echo ""

# Detect OS
OS="$(uname -s)"
case "$OS" in
    Linux)   OS="linux" ;;
    Darwin)  OS="macos" ;;
    *)       echo "Unsupported OS: $OS"; exit 1 ;;
esac
echo "Detected OS: $OS"

# Check Python
if command -v python &>/dev/null; then
    PYTHON="python"
elif command -v python3 &>/dev/null; then
    PYTHON="python3"
else
    echo "ERROR: Python 3.10+ required. Install from https://www.python.org/downloads/ or your OS package manager."
    exit 1
fi
echo "Python: $($PYTHON --version)"

# Check pip
if ! $PYTHON -m pip --version &>/dev/null; then
    echo "Installing pip..."
    $PYTHON -m ensurepip --upgrade
fi

# Install Python deps
echo "Installing Python dependencies..."
$PYTHON -m pip install -r requirements.txt --quiet

# Check Node.js (for opencode)
if command -v node &>/dev/null; then
    echo "Node.js: $(node --version)"
else
    echo "WARNING: Node.js not found. opencode requires Node 18+."
    echo "  Install via: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash - && sudo apt install -y nodejs"
fi

# Check opencode
if command -v opencode &>/dev/null; then
    echo "opencode: $(opencode --version 2>/dev/null || echo 'installed')"
else
    echo "WARNING: opencode not found. Install via: npm install -g @opencode/cli"
fi

# Check Hermes
if command -v hermes &>/dev/null; then
    echo "Hermes: found"
else
    echo "WARNING: Hermes Agent not found. Install via: curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash"
fi

# Check Gemini CLI
if command -v gemini &>/dev/null; then
    echo "Gemini CLI: found"
else
    echo "WARNING: Gemini CLI not found. Install via: npm install -g @google/gemini-cli"
fi

# Create required directories
mkdir -p backups audit

# Initialize git if not already
if [ ! -d .git ]; then
    echo "Initializing git repository..."
    git init
    grep -qxF "audit/*" .gitignore || echo "audit/*" >> .gitignore
    grep -qxF "backups/*.tar.gz" .gitignore || echo "backups/*.tar.gz" >> .gitignore
    grep -qxF "data/settings.json" .gitignore || echo "data/settings.json" >> .gitignore
fi

echo ""
echo "=== Installation complete! ==="
echo ""
echo "Next steps:"
echo "  1. Edit data/settings.json with your API keys"
echo "  2. Run ./start.sh to launch the dashboard"
echo "  3. Open http://127.0.0.1:8080 in your browser"
