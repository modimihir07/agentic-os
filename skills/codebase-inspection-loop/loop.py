#!/usr/bin/env python3
"""
codebase-inspection-loop — the deterministic engine behind the
`codebase-inspection-loop` skill.

This script does NOT call any AI. It maintains the loop's state so the
orchestrating agent (this Hermes session, via delegate_task) can run a
*looping* multi-round codebase inspection that is reproducible and
debuggable:

  ROUND 1  build a manifest of files -> seed the work queue
  ROUND N  the agent asks for the next batch (priority-ordered), spawns
           subagents (delegate_task) to inspect those files, records their
           findings, and new findings can enqueue MORE work (a true loop).
  END      when the queue drains or max_rounds is hit, a convergence report
           is produced.

State lives in  data/codebase-inspection/<run_id>/
  manifest.json   every file in the repo (rel path -> {loc, lang, weight})
  ledger.json     the work queue (todo / doing / done) + findings + rounds

Usage (run from the repo root, e.g. /home/austin/agentic-os):
  python3 skills/codebase-inspection-loop/loop.py init   [--path .] [--glob ...]
  python3 skills/codebase-inspection-loop/loop.py next   --run <id> [--limit 3]
  python3 skills/codebase-inspection-loop/loop.py record --run <id> --file <rel> \
          --summary "..." --severity low|medium|high|critical \
          --refs "a.py:12,b.py:40" [--enqueue "new/file.py:reason"]
  python3 skills/codebase-inspection-loop/loop.py report --run <id> [--json]

All commands print JSON to stdout (machine-readable for the agent to parse).
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent.parent
STATE_ROOT = BASE_DIR / "data" / "codebase-inspection"

# Files / dirs that are noise for a *code* inspection.
DEFAULT_EXCLUDES = [
    ".git", "node_modules", "__pycache__", ".venv", "venv", "env",
    ".mypy_cache", ".pytest_cache", "build", "dist", ".turbo",
    "backups", "graphify-out", "brain/graph",
]
# Match any path segment exactly OR any path containing these as a segment.
EXCLUDE_SEGMENTS = set(DEFAULT_EXCLUDES)

# Files larger than this (bytes) are skipped from the manifest (binary/asset).
MAX_FILE_BYTES = 500_000

# Language by extension -> rough per-line weight (bigger files = higher prio).
LANG_WEIGHT = {
    ".py": 1.0, ".js": 0.9, ".ts": 0.9, ".tsx": 0.95, ".jsx": 0.95,
    ".go": 1.0, ".rs": 1.0, ".java": 0.95, ".c": 0.9, ".cpp": 0.95,
    ".rb": 0.85, ".php": 0.85, ".sh": 0.7, ".sql": 0.7, ".yaml": 0.6,
    ".yml": 0.6, ".toml": 0.6, ".json": 0.5, ".md": 0.4, ".html": 0.6,
    ".css": 0.5,
}

SEVERITY_RANK = {"low": 1, "medium": 2, "high": 3, "critical": 4}


def _print(obj):
    print(json.dumps(obj, indent=2))


def _state_dir(run_id):
    return STATE_ROOT / run_id


def _load_json(path):
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except Exception:
        return {}


def _is_excluded(rel_parts):
    return any(seg in EXCLUDE_SEGMENTS for seg in rel_parts)


def cmd_init(args):
    root = Path(args.path).resolve()
    STATE_ROOT.mkdir(parents=True, exist_ok=True)
    import time
    run_id = "ci-" + time.strftime("%Y%m%d-%H%M%S")

    globs = args.glob or ["*"]
    manifest = {}
    for pat in globs:
        for p in root.rglob(pat):
            if not p.is_file():
                continue
            rel = p.relative_to(root)
            parts = rel.parts
            if _is_excluded(parts):
                continue
            try:
                size = p.stat().st_size
            except OSError:
                continue
            if size > MAX_FILE_BYTES:
                continue
            ext = p.suffix.lower()
            try:
                with p.open("r", encoding="utf-8", errors="ignore") as fh:
                    loc = sum(1 for _ in fh)
            except OSError:
                loc = 0
            language = ext.lstrip(".") or "txt"
            weight = round(LANG_WEIGHT.get(ext, 0.5) * max(loc, 1), 1)
            manifest[str(rel)] = {
                "loc": loc,
                "language": language,
                "size": size,
                "weight": weight,
            }

    # Seed the queue: each manifest file becomes a todo item.
    queue = {
        rel: {"rel": rel, "status": "todo", "weight": m["weight"],
              "reason": "initial sweep"}
        for rel, m in manifest.items()
    }
    ledger = {
        "run_id": run_id,
        "root": str(root),
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "max_rounds": args.max_rounds,
        "round": 0,
        "total_files": len(manifest),
        "queue": queue,
        "findings": [],
        "rounds": [],
    }
    sd = _state_dir(run_id)
    sd.mkdir(parents=True, exist_ok=True)
    (sd / "manifest.json").write_text(json.dumps(manifest, indent=2))
    (sd / "ledger.json").write_text(json.dumps(ledger, indent=2))
    _print({
        "status": "initialized",
        "run_id": run_id,
        "state_dir": str(sd),
        "files_discovered": len(manifest),
        "todo": len(queue),
    })


def _next_batch(ledger, limit):
    todos = [v for v in ledger["queue"].values() if v["status"] == "todo"]
    todos.sort(key=lambda v: v["weight"], reverse=True)
    batch = todos[:limit]
    for item in batch:
        item["status"] = "doing"
    return batch


def cmd_next(args):
    sd = _state_dir(args.run)
    ledger = _load_json(sd / "ledger.json")
    if not ledger:
        _print({"error": "run not found", "run": args.run})
        return 1
    ledger["round"] += 1
    batch = _next_batch(ledger, args.limit)
    remaining = sum(1 for v in ledger["queue"].values() if v["status"] != "done")
    converged = remaining == 0 or ledger["round"] >= ledger["max_rounds"]
    if converged:
        # Crisp stop: do not hand out more work. The batch already marked
        # `doing` stays pending (the agent should record every batch member
        # each round); the empty batch + converged flag is the signal to stop.
        batch = []
    # Snapshot what's being inspected this round.
    ledger["rounds"].append({
        "round": ledger["round"],
        "inspecting": [b["rel"] for b in batch],
        "pending_after": sum(1 for v in ledger["queue"].values()
                             if v["status"] == "todo"),
        "done": sum(1 for v in ledger["queue"].values()
                    if v["status"] == "done"),
    })
    (sd / "ledger.json").write_text(json.dumps(ledger, indent=2))
    _print({
        "run_id": args.run,
        "round": ledger["round"],
        "batch": batch,
        "remaining_total": remaining,
        "converged": converged,
        "max_rounds": ledger["max_rounds"],
    })


def cmd_record(args):
    sd = _state_dir(args.run)
    ledger = _load_json(sd / "ledger.json")
    if not ledger:
        _print({"error": "run not found", "run": args.run})
        return 1
    item = ledger["queue"].get(args.file)
    if not item:
        # Allow recording for a file not in the original manifest (enqueued).
        ledger["queue"][args.file] = {
            "rel": args.file, "status": "todo", "weight": 1.0,
            "reason": "enqueued during run",
        }
        item = ledger["queue"][args.file]
    item["status"] = "done"
    refs = [r.strip() for r in (args.refs or "").split(",") if r.strip()]
    finding = {
        "file": args.file,
        "round": ledger["round"],
        "severity": args.severity,
        "summary": args.summary,
        "refs": refs,
    }
    ledger["findings"].append(finding)

    # Optional: enqueue follow-up work discovered while inspecting.
    enqueued = []
    if args.enqueue:
        for spec in args.enqueue.split("|"):
            spec = spec.strip()
            if not spec:
                continue
            if ":" in spec:
                fpath, reason = spec.split(":", 1)
            else:
                fpath, reason = spec, "follow-up from inspection"
            fpath = fpath.strip()
            if fpath not in ledger["queue"]:
                ledger["queue"][fpath] = {
                    "rel": fpath, "status": "todo",
                    "weight": 2.0,  # follow-ups are high priority
                    "reason": reason.strip(),
                }
                enqueued.append(fpath)

    (sd / "ledger.json").write_text(json.dumps(ledger, indent=2))
    _print({
        "status": "recorded",
        "file": args.file,
        "severity": args.severity,
        "enqueued": enqueued,
        "total_findings": len(ledger["findings"]),
        "remaining": sum(1 for v in ledger["queue"].values()
                         if v["status"] != "done"),
    })


def cmd_report(args):
    sd = _state_dir(args.run)
    ledger = _load_json(sd / "ledger.json")
    if not ledger:
        _print({"error": "run not found", "run": args.run})
        return 1
    findings = ledger["findings"]
    by_sev = {}
    for f in findings:
        by_sev[f["severity"]] = by_sev.get(f["severity"], 0) + 1
    sev_order = ["critical", "high", "medium", "low"]
    by_sev = {k: by_sev.get(k, 0) for k in sev_order if k in by_sev}

    report = {
        "run_id": args.run,
        "root": ledger.get("root"),
        "rounds_completed": ledger.get("round"),
        "files_total": ledger.get("total_files"),
        "files_inspected": sum(1 for v in ledger["queue"].values()
                               if v["status"] == "done"),
        "findings_total": len(findings),
        "by_severity": by_sev,
        "top_findings": sorted(
            findings, key=lambda f: -SEVERITY_RANK.get(f["severity"], 0)
        )[:10],
    }
    if args.json:
        _print(report)
    else:
        lines = []
        lines.append(f"# Codebase Inspection Report — {args.run}")
        lines.append(f"Root: {report['root']}")
        lines.append(f"Rounds: {report['rounds_completed']} | "
                     f"Inspected: {report['files_inspected']}/{report['files_total']}")
        lines.append(f"Findings: {report['findings_total']} "
                     f"{report['by_severity']}")
        lines.append("")
        lines.append("## Top findings (by severity)")
        if not report["top_findings"]:
            lines.append("_No findings recorded._")
        for f in report["top_findings"]:
            refs = ", ".join(f["refs"]) if f["refs"] else f["file"]
            lines.append(f"- [{f['severity'].upper()}] {f['summary']} "
                         f"({refs})")
        _print({"report_markdown": "\n".join(lines)})
    return 0


def main():
    ap = argparse.ArgumentParser(description="codebase-inspection-loop engine")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("init")
    p.add_argument("--path", default=".")
    p.add_argument("--glob", action="append", help="repeatable; default '*'")
    p.add_argument("--max-rounds", type=int, default=8)
    p.set_defaults(func=cmd_init)

    p = sub.add_parser("next")
    p.add_argument("--run", required=True)
    p.add_argument("--limit", type=int, default=3)
    p.set_defaults(func=cmd_next)

    p = sub.add_parser("record")
    p.add_argument("--run", required=True)
    p.add_argument("--file", required=True)
    p.add_argument("--summary", required=True)
    p.add_argument("--severity", default="low",
                   choices=["low", "medium", "high", "critical"])
    p.add_argument("--refs", default="")
    p.add_argument("--enqueue", default="")
    p.set_defaults(func=cmd_record)

    p = sub.add_parser("report")
    p.add_argument("--run", required=True)
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_report)

    args = ap.parse_args()
    rc = args.func(args)
    sys.exit(rc or 0)


if __name__ == "__main__":
    main()
