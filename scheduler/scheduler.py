#!/usr/bin/env python3
"""Agentic OS — APScheduler engine for recurring tasks.

Loads job definitions from scheduler/jobs/*.json and, when each cron
trigger fires, actually executes the referenced skill by calling the
running Agentic OS server's /api/skills/{name}/run endpoint. Running
skills through the API means they go through the same code path as the
dashboard: real agent invocation, real agent-health stats, and real
eval-score population.

If the server isn't reachable, the job is logged (audit) but skipped,
so the scheduler never crashes the loop.
"""
import json
import subprocess
import sys
import time
from pathlib import Path
from datetime import datetime, timezone

try:
    from apscheduler.schedulers.background import BackgroundScheduler
    from apscheduler.triggers.cron import CronTrigger
except ImportError:
    print("Install APScheduler: pip install apscheduler")
    sys.exit(1)

import urllib.request
import urllib.error

BASE_DIR = Path(__file__).parent.resolve()
JOBS_DIR = BASE_DIR / "jobs"
# Server URL — same host, main API port. Override with AGENTIC_OS_URL env.
SERVER_URL = "http://127.0.0.1:8080"
RUN_TIMEOUT = 300  # seconds per skill run


def log_audit(entry: dict):
    audit_file = BASE_DIR.parent / "audit" / "audit.log"
    entry["timestamp"] = datetime.now(timezone.utc).isoformat()
    try:
        audit_file.parent.mkdir(parents=True, exist_ok=True)
        with open(audit_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError as e:
        print(f"  [audit] failed to record: {e}")


def run_skill_via_api(skill_name: str, agent: str = "auto") -> dict:
    """Invoke a skill through the live server API.

    Returns a dict with at least {'ok': bool, 'reason'/'output': ...}.
    """
    url = f"{SERVER_URL}/api/skills/{skill_name}/run"
    payload = json.dumps({"input": "", "agent": agent}).encode()
    req = urllib.request.Request(
        url, data=payload, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=RUN_TIMEOUT) as resp:
            data = json.loads(resp.read())
            return {"ok": True, "data": data}
    except urllib.error.HTTPError as e:
        return {"ok": False, "reason": f"HTTP {e.code}: {e.reason}"}
    except urllib.error.URLError as e:
        return {"ok": False, "reason": f"server unreachable: {e.reason}"}
    except Exception as e:  # timeout, json error, etc.
        return {"ok": False, "reason": str(e)}


def run_job(job: dict):
    skill = job.get("skill")
    name = job.get("name", skill)
    agent = job.get("agent", "auto")
    print(f"[{datetime.now().isoformat()}] Firing job '{name}' -> skill '{skill}'")
    log_audit({"action": "scheduler_run", "job": name, "skill": skill, "stage": "start"})

    if not skill:
        log_audit({"action": "scheduler_run", "job": name, "error": "no skill defined"})
        return

    result = run_skill_via_api(skill, agent)
    if result["ok"]:
        data = result["data"]
        log_audit({
            "action": "scheduler_run",
            "job": name,
            "skill": skill,
            "agent": data.get("agent"),
            "run_id": data.get("run_id"),
            "stage": "done",
        })
        print(f"  -> OK (agent={data.get('agent')}, run_id={data.get('run_id')})")
    else:
        reason = result["reason"]
        log_audit({"action": "scheduler_run", "job": name, "skill": skill, "error": reason})
        print(f"  -> FAILED: {reason}")


def load_jobs(scheduler: BackgroundScheduler):
    if not JOBS_DIR.exists():
        print(f"No jobs directory at {JOBS_DIR}")
        return
    for job_file in sorted(JOBS_DIR.glob("*.json")):
        try:
            data = json.loads(job_file.read_text())
        except (json.JSONDecodeError, KeyError) as e:
            print(f"  Skipping malformed job file {job_file.name}: {e}")
            continue
        if not data.get("enabled", True):
            print(f"  Skipping disabled job: {data.get('name', job_file.stem)}")
            continue
        cron = data.get("cron")
        skill = data.get("skill")
        if not cron or not skill:
            print(f"  Skipping job {data.get('name')}: missing cron or skill")
            continue
        scheduler.add_job(
            run_job,
            CronTrigger.from_crontab(cron),
            args=[data],
            id=data.get("id", data["name"]),
            name=data.get("name", skill),
            replace_existing=True,
            max_instances=1,
            coalesce=True,
        )
        print(f"  Scheduled: {data.get('name')} (skill={skill}, cron={cron})")


def main():
    scheduler = BackgroundScheduler()
    load_jobs(scheduler)
    scheduler.start()
    print(f"Agentic OS Scheduler running. Jobs loaded from: {JOBS_DIR}")
    print("Server API target: " + SERVER_URL)
    try:
        while True:
            time.sleep(60)
    except KeyboardInterrupt:
        scheduler.shutdown()
        print("Scheduler stopped.")


if __name__ == "__main__":
    main()
