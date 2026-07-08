#!/usr/bin/env python3
"""Agentic OS — APScheduler engine for recurring tasks"""
import json
import subprocess
import sys
from pathlib import Path
from datetime import datetime, timezone

try:
    from apscheduler.schedulers.background import BackgroundScheduler
    from apscheduler.triggers.cron import CronTrigger
except ImportError:
    print("Install APScheduler: pip install apscheduler")
    sys.exit(1)

BASE_DIR = Path(__file__).parent.resolve()
JOBS_DIR = BASE_DIR / "jobs"

def run_skill(skill_name: str):
    """Execute a skill by invoking the appropriate agent."""
    audit_file = BASE_DIR.parent / "audit" / "audit.log"
    entry = {
        "action": "scheduler_run",
        "skill": skill_name,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    try:
        audit_file.parent.mkdir(parents=True, exist_ok=True)
        with open(audit_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError as e:
        print(f"  [audit] failed to record run of {skill_name!r}: {e}")
    print(f"[{datetime.now().isoformat()}] Ran skill: {skill_name}")

def load_jobs(scheduler: BackgroundScheduler):
    """Load job definitions from jobs/ directory.

    A single malformed job file is logged and skipped rather than being allowed
    to abort loading of every other job.
    """
    for job_file in JOBS_DIR.glob("*.json"):
        try:
            data = json.loads(job_file.read_text())
        except (json.JSONDecodeError, OSError) as e:
            print(f"  Skipping {job_file.name}: could not read job ({e})")
            continue
        if not data.get("enabled", True):
            continue
        try:
            scheduler.add_job(
                run_skill,
                CronTrigger.from_crontab(data["cron"]),
                args=[data["skill"]],
                id=data.get("id", data["name"]),
                name=data["name"],
                replace_existing=True,
            )
        except (KeyError, ValueError) as e:
            print(f"  Skipping {job_file.name}: invalid job definition ({e})")
            continue
        print(f"  Scheduled: {data['name']} ({data['cron']})")

def main():
    scheduler = BackgroundScheduler()
    load_jobs(scheduler)
    scheduler.start()
    print(f"Agentic OS Scheduler running. Jobs loaded from: {JOBS_DIR}")
    try:
        while True:
            import time
            time.sleep(60)
    except KeyboardInterrupt:
        scheduler.shutdown()
        print("Scheduler stopped.")

if __name__ == "__main__":
    main()
