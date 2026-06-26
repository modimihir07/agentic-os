$ErrorActionPreference = "Stop"

Write-Host "Starting Agentic OS Dashboard..."
Write-Host ""

if (-not (Test-Path server.py)) {
    Write-Error "server.py not found. Are you in the right directory?"
    exit 1
}

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

& $pythonCommand @pythonArgs -m pip install -r requirements.txt --quiet

$port = & $pythonCommand @pythonArgs -c "import json; f=open('data/settings.json'); d=json.load(f); print(d.get('dashboard',{}).get('port',8080)); f.close()" 2>$null
if (-not $port) { $port = "8080" }

Write-Host "Dashboard: http://127.0.0.1:$port"
Write-Host "Press Ctrl+C to stop"
Write-Host ""

& $pythonCommand @pythonArgs server.py --port $port
