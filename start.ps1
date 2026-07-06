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

$configuredPort = & $pythonCommand @pythonArgs -c "import json; f=open('data/settings.json'); d=json.load(f); print(int(d.get('dashboard',{}).get('port',8080))); f.close()" 2>$null
if (-not $configuredPort) { $configuredPort = "8080" }
$configuredPort = [int]$configuredPort

function Find-FreePort {
    param([int]$StartPort, [int]$MaxAttempts = 20)
    for ($p = $StartPort; $p -lt $StartPort + $MaxAttempts; $p++) {
        $listener = $null
        try {
            $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse("127.0.0.1"), $p)
            $listener.Start()
            return $p
        } catch {
            continue
        } finally {
            if ($listener) { $listener.Stop() }
        }
    }
    throw "No free port found between $StartPort and $($StartPort + $MaxAttempts - 1). Close some other application or free a port and retry."
}

$port = Find-FreePort -StartPort $configuredPort
if ($port -ne $configuredPort) {
    Write-Warning "Port $configuredPort is already in use (another app, or a leftover Agentic OS process) - using $port instead."
}

Write-Host "Dashboard: http://127.0.0.1:$port"
Write-Host "Press Ctrl+C to stop"
Write-Host ""

Start-Job -ScriptBlock { Start-Sleep -Seconds 2; Start-Process "http://127.0.0.1:$using:port" } | Out-Null

& $pythonCommand @pythonArgs server.py --port $port
