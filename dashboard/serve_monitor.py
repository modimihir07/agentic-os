#!/usr/bin/env python3
"""
Agentic-OS :: Localhost Agent-Time Monitor Server
-------------------------------------------------
Stdlib-only HTTP server (no pip deps) that serves the project folder on
localhost and exposes two action endpoints:

  GET  /                          -> redirects to the monitor dashboard
  GET  /dashboard/pages/agent-time-monitor.html  -> the dashboard
  GET  /agent-time.json           -> computed total-agent-time report
  GET  /graphify-out/graph.html   -> graphify code knowledge graph
  POST /recompute                 -> re-run the time analyzer, return summary
  POST /sync-mnemoverse           -> push total time to Mnemoverse (graceful)

Run:  python3 dashboard/serve_monitor.py [--port 8765]
Then open:  http://localhost:8765/dashboard/pages/agent-time-monitor.html
"""
import json
import os
import subprocess
import sys
import urllib.request
import urllib.error
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from functools import partial

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # agentic-os/
ANALYZER = os.path.join(ROOT, "scripts", "analyze_agent_time.py")
AGENT_TIME = os.path.join(ROOT, "data", "agent-time.json")
MNEMOVERSE_URL = "https://core.mnemoverse.com/api/v1/memory/write"
DASHBOARD = "/dashboard/pages/agent-time-monitor.html"
DEFAULT_PORT = int(os.environ.get("MONITOR_PORT", "8765"))


def run_analyzer():
    """Recompute agent-time.json. Returns (ok, summary_dict)."""
    try:
        proc = subprocess.run(
            [sys.executable, ANALYZER],
            cwd=ROOT, capture_output=True, text=True, timeout=120,
        )
        if proc.returncode != 0:
            return False, {"error": proc.stderr.strip() or "analyzer exited non-zero"}
        with open(AGENT_TIME, "r", encoding="utf-8") as f:
            data = json.load(f)
        return True, {
            "total_seconds": data["total_seconds"],
            "total_human": data["total_human"],
            "agents": len(data.get("agents", {})),
            "events": data.get("event_count", 0),
        }
    except Exception as e:
        return False, {"error": str(e)}


def sync_mnemoverse(api_key=None):
    """Write the total agent time to Mnemoverse. Graceful on missing key/offline."""
    api_key = api_key or os.environ.get("MNEMOVERSE_API_KEY", "")
    if not api_key:
        return False, {
            "error": "no MNEMOVERSE_API_KEY set",
            "hint": "export MNEMOVERSE_API_KEY=mk_live_... then click again",
        }
    try:
        with open(AGENT_TIME, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        return False, {"error": "cannot read agent-time.json: " + str(e)}

    content = (
        f"Agentic-OS total AI-agent time on project: {data['total_human']} "
        f"across {len(data.get('agents', {}))} agents "
        f"({data.get('event_count', 0)} logged events). "
        f"Method: {data.get('method')}. Last computed {data.get('generated_at')}."
    )
    payload = json.dumps({
        "content": content,
        "concepts": ["agentic-os", "agent-time", "agentic-metrics", "ai-agent-usage"],
        "domain": "agentic-os",
    }).encode("utf-8")
    req = urllib.request.Request(
        MNEMOVERSE_URL, data=payload, method="POST",
        headers={"Content-Type": "application/json", "X-Api-Key": api_key},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = resp.read().decode("utf-8", "replace")
            try:
                j = json.loads(body)
            except Exception:
                j = {"raw": body[:200]}
            return True, {"message": "memory written to Mnemoverse", "response": j}
    except urllib.error.HTTPError as e:
        return False, {"error": f"HTTP {e.code}: {e.read().decode('utf-8','replace')[:200]}"}
    except urllib.error.URLError as e:
        return False, {"error": "network error: " + str(e.reason),
                       "hint": "Mnemoverse unreachable from this host"}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def _send_json(self, obj, code=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self.send_response(302)
            self.send_header("Location", DASHBOARD)
            self.end_headers()
            return
        # Default: serve files from ROOT (html, json, graph.html, etc.)
        super().do_GET()

    def do_POST(self):
        if self.path == "/recompute":
            ok, summary = run_analyzer()
            self._send_json({"ok": ok, **summary}, 200 if ok else 500)
            return
        if self.path == "/sync-mnemoverse":
            ok, result = sync_mnemoverse()
            self._send_json({"ok": ok, **result}, 200 if ok else 200)
            return
        self._send_json({"ok": False, "error": "unknown endpoint"}, 404)

    def log_message(self, fmt, *args):
        sys.stderr.write("[monitor] " + (fmt % args) + "\n")


def main():
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=DEFAULT_PORT)
    p.add_argument("--host", default="127.0.0.1")
    args = p.parse_args()

    # ensure a fresh agent-time.json exists
    if not os.path.exists(AGENT_TIME):
        ok, s = run_analyzer()
        print(("recompute ok" if ok else "recompute failed: " + str(s)))

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://{args.host}:{args.port}{DASHBOARD}"
    print("Agentic-OS Agent-Time Monitor")
    print(f"  serving : {ROOT}")
    print(f"  dashboard: {url}")
    print(f"  mnemoverse: {'ENABLED (key set)' if os.environ.get('MNEMOVERSE_API_KEY') else 'disabled (set MNEMOVERSE_API_KEY to enable sync)'}")
    print("  ctrl-c to stop")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped.")


if __name__ == "__main__":
    main()
