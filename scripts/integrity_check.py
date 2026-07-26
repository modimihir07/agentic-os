#!/usr/bin/env python3
"""
Agentic-OS Codebase Integrity Check  (run hourly via cron)

Detects STALE state in the codebase — references that contradict the
single source of truth:

  SOURCE OF TRUTH
  - dashboard port ........ data/settings.json -> dashboard.port  (currently 8080)
  - canonical repo ........ github.com/zumayaaustin-creator/agentic-os
  - canonical location .... /home/austin/agentic-os
  - terminal endpoint ..... /ws/terminal on the MAIN port (NOT a separate 8082)

Any contradiction of the above is reported as a finding. This script is
read-only: it never edits files. It prints a report and exits 0 if clean,
1 if any finding, 2 on a check error (so the cron can alert).

Run:  python3 scripts/integrity_check.py
"""
import json
import re
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
SETTINGS = BASE / "data" / "settings.json"

# ── Source of truth ────────────────────────────────────────────────
TRUTH = {
    "expected_port": 8080,          # overwritten below from settings.json if present
    "canonical_repo": "zumayaaustin-creator/agentic-os",
    "canonical_location": "/home/austin/agentic-os",
    "terminal_endpoint": "/ws/terminal",
}
STALE_PATTERNS = [
    (r"modimihir07", "stale GitHub repo (should be zumayaaustin-creator/agentic-os)"),
    (r"Desktop/Agentic\s*OS\s*Project", "stale project location (should be /home/austin/agentic-os)"),
    (r"127\.0\.0\.1:8082", "dead port 8082 referenced (terminal consolidated to /ws/terminal on main port)"),
    (r"port\s*8082", "dead port 8082 referenced"),
    (r":8081", "stale port 8081 referenced as the server/terminal port"),
    (r"wsPort\s*=\s*8082", "terminal.js still targets dead 8082"),
    (r"action:\s*'(input|resize|output)'", "terminal.js uses wrong 'action:' protocol (backend expects 'type:')"),
]
# Files to skip (build artifacts, venv, node_modules)
SKIP_DIRS = {"venv", "node_modules", "__pycache__", ".git", "graphify-out"}
SKIP_EXT = {".pyc"}

findings = []


def add(file, line_no, detail, excerpt):
    findings.append(f"[{file}:{line_no}] {detail}\n      > {excerpt.strip()[:120]}")


def load_truth():
    if SETTINGS.exists():
        try:
            s = json.loads(SETTINGS.read_text(encoding="utf-8"))
            p = int(s.get("dashboard", {}).get("port", 8080))
            TRUTH["expected_port"] = p
        except Exception:
            pass


def scan_text_files():
    for p in BASE.rglob("*"):
        if not p.is_file():
            continue
        if any(part in SKIP_DIRS for part in p.relative_to(BASE).parts):
            continue
        if p.name == "integrity_check.py":
            continue  # don't flag our own pattern strings
        # only scan text-like files
        if p.suffix.lower() not in {
            ".md", ".py", ".js", ".ts", ".html", ".json", ".sh", ".yml", ".yaml", ".toml", ".ini", ".txt"
        }:
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        rel = p.relative_to(BASE)
        for pat, desc in STALE_PATTERNS:
            for m in re.finditer(pat, text, re.IGNORECASE):
                # find line number
                line_no = text.count("\n", 0, m.start()) + 1
                excerpt = text.splitlines()[line_no - 1] if line_no <= len(text.splitlines()) else ""
                add(str(rel), line_no, desc, excerpt)


def check_live_server():
    """Confirm the running server is on the expected port and serving."""
    import urllib.request
    port = TRUTH["expected_port"]
    url = f"http://127.0.0.1:{port}/"
    try:
        with urllib.request.urlopen(url, timeout=4) as r:
            if r.status != 200:
                findings.append(f"[LIVE] server on :{port} returned HTTP {r.status} (expected 200)")
    except Exception as e:
        findings.append(f"[LIVE] server NOT reachable on :{port} ({type(e).__name__}: {e})")


def check_terminal_endpoint():
    """The terminal page must reference /ws/terminal and the main host."""
    tjs = BASE / "dashboard" / "pages" / "terminal.js"
    if not tjs.exists():
        findings.append("[terminal.js] file missing — Terminal page broken")
        return
    txt = tjs.read_text(encoding="utf-8", errors="ignore")
    if "/ws/terminal" not in txt:
        findings.append("[terminal.js] does NOT connect to /ws/terminal (terminal disconnected from OS)")
    if "wsPort" in txt or ":8082" in txt or "port 8082" in txt:
        findings.append("[terminal.js] still references dead 8082 port")


def check_agent_enabled():
    """opencode should be enabled (it is the code/DevOps agent)."""
    if not SETTINGS.exists():
        return
    try:
        s = json.loads(SETTINGS.read_text(encoding="utf-8"))
        oc = s.get("agent_preferences", {}).get("opencode", {})
        if oc.get("enabled") is not True:
            findings.append(f"[settings.json] opencode.enabled={oc.get('enabled')!r} (expected true)")
    except Exception:
        pass


def main():
    load_truth()
    scan_text_files()
    check_terminal_endpoint()
    check_agent_enabled()
    check_live_server()

    print("=" * 64)
    print("  Agentic-OS Integrity Check")
    print(f"  port(source of truth) = {TRUTH['expected_port']}")
    print("=" * 64)
    if not findings:
        print("  ✓ CLEAN — no stale references detected.")
        return 0
    print(f"  ✗ {len(findings)} FINDING(S):\n")
    for f in findings:
        print("   - " + f)
    print()
    return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(f"CHECK ERROR: {type(e).__name__}: {e}")
        sys.exit(2)
