"""Unit tests for ``scheduler/scheduler.py``."""
import importlib
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SCHEDULER_DIR = REPO_ROOT / "scheduler"
if str(SCHEDULER_DIR) not in sys.path:
    sys.path.insert(0, str(SCHEDULER_DIR))


@pytest.fixture()
def scheduler_module(tmp_path, monkeypatch):
    sched = importlib.import_module("scheduler")
    base = tmp_path / "scheduler"
    (base / "jobs").mkdir(parents=True)
    (tmp_path / "audit").mkdir()
    monkeypatch.setattr(sched, "BASE_DIR", base)
    monkeypatch.setattr(sched, "JOBS_DIR", base / "jobs")
    return sched


def test_run_job_appends_audit(scheduler_module, monkeypatch, capsys):
    # run_skill was replaced by run_job, which invokes skills through the
    # live server API — stub that HTTP call out for a hermetic test.
    monkeypatch.setattr(
        scheduler_module, "run_skill_via_api",
        lambda skill, agent="auto": {"ok": True, "data": {"result": "done"}},
    )
    scheduler_module.run_job({"name": "Heartbeat", "skill": "heartbeat"})
    audit_file = scheduler_module.BASE_DIR.parent / "audit" / "audit.log"
    entries = [json.loads(line) for line in audit_file.read_text().strip().splitlines()]
    assert entries[0]["action"] == "scheduler_run"
    assert entries[0]["skill"] == "heartbeat"
    assert entries[0]["stage"] == "start"
    assert entries[-1]["stage"] == "done"
    assert "timestamp" in entries[0]
    assert "Firing job 'Heartbeat'" in capsys.readouterr().out


def test_load_jobs_registers_enabled(scheduler_module):
    (scheduler_module.JOBS_DIR / "hb.json").write_text(json.dumps({
        "id": "hb1", "name": "Heartbeat", "skill": "heartbeat",
        "cron": "*/5 * * * *", "enabled": True,
    }))
    sched = scheduler_module.BackgroundScheduler()
    scheduler_module.load_jobs(sched)
    jobs = sched.get_jobs()
    assert len(jobs) == 1
    assert jobs[0].id == "hb1"
    assert jobs[0].name == "Heartbeat"


def test_load_jobs_skips_disabled(scheduler_module):
    (scheduler_module.JOBS_DIR / "off.json").write_text(json.dumps({
        "id": "off1", "name": "Disabled", "skill": "x",
        "cron": "0 0 * * *", "enabled": False,
    }))
    sched = scheduler_module.BackgroundScheduler()
    scheduler_module.load_jobs(sched)
    assert sched.get_jobs() == []


def test_load_jobs_falls_back_to_name_as_id(scheduler_module):
    (scheduler_module.JOBS_DIR / "noid.json").write_text(json.dumps({
        "name": "NoId", "skill": "x", "cron": "0 0 * * *", "enabled": True,
    }))
    sched = scheduler_module.BackgroundScheduler()
    scheduler_module.load_jobs(sched)
    assert sched.get_jobs()[0].id == "NoId"
