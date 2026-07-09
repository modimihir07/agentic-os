"""Endpoint tests for ``server.py`` exercised through FastAPI's TestClient."""
import json

import pytest


# ─── Status / static ──────────────────────────────────────────────

def test_status_ok(client, server_module, monkeypatch):
    monkeypatch.setattr(server_module.shutil, "which", lambda name: None)
    r = client.get("/api/status")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "healthy"
    assert {a["name"] for a in body["agents"]} == {"opencode", "hermes", "gemini"}
    assert body["skills_count"] == 0


def test_index_without_dashboard(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "Agentic OS" in r.text


def test_favicon_endpoints(client):
    for path in ("/favicon.ico", "/favicon.svg"):
        r = client.get(path)
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("image/svg")


# ─── Brain ─────────────────────────────────────────────────────────

def test_brain_list_and_get_and_update(client, server_module):
    brain = server_module.BASE_DIR / "brain"
    (brain / "memory.md").write_text("remember this")

    r = client.get("/api/brain")
    assert r.json()["memory.md"] == "remember this"

    r = client.get("/api/brain/memory.md")
    assert r.json() == {"name": "memory.md", "content": "remember this"}

    r = client.put("/api/brain/memory.md", json={"content": "new content"})
    assert r.status_code == 200
    assert (brain / "memory.md").read_text() == "new content"


def test_brain_get_missing_404(client):
    assert client.get("/api/brain/ghost.md").status_code == 404


# ─── Skills ────────────────────────────────────────────────────────

def _make_skill(server_module, name, skill_md="", eval_data=None, scores=None):
    d = server_module.BASE_DIR / "skills" / name
    d.mkdir(parents=True, exist_ok=True)
    if skill_md:
        (d / "SKILL.md").write_text(skill_md)
    if eval_data is not None:
        (d / "eval.json").write_text(json.dumps(eval_data))
    if scores is not None:
        (d / "score-history.json").write_text(json.dumps(scores))
    return d


def test_list_skills(client, server_module):
    _make_skill(server_module, "code-review", skill_md="Review code",
                eval_data={"criteria": ["clarity"]}, scores=[{"score": 8}])
    _make_skill(server_module, "_template", skill_md="ignored")
    skills = client.get("/api/skills").json()
    names = [s["name"] for s in skills]
    assert "code-review" in names
    assert "_template" not in names
    cr = next(s for s in skills if s["name"] == "code-review")
    assert cr["eval_criteria"] == ["clarity"]
    assert cr["scores"] == [{"score": 8}]


def test_get_skill_and_missing(client, server_module):
    _make_skill(server_module, "brainstorming", skill_md="Ideas",
                eval_data={"criteria": []}, scores=[{"score": 5}])
    r = client.get("/api/skills/brainstorming")
    assert r.json()["skill"] == "Ideas"
    assert client.get("/api/skills/nope").status_code == 404


def test_get_skill_eval(client, server_module):
    _make_skill(server_module, "tdd-cycle", scores=[{"score": 7}])
    assert client.get("/api/skills/tdd-cycle/eval").json() == {"scores": [{"score": 7}]}
    assert client.get("/api/skills/other/eval").json() == {"scores": []}


@pytest.mark.parametrize("name,expected_agent", [
    ("devops-audit", "opencode"),
    ("research-synthesis", "gemini"),
    ("generic-skill", "opencode"),
])
def test_run_skill_auto_routes(client, server_module, monkeypatch, name, expected_agent):
    _make_skill(server_module, name, skill_md="do stuff")
    captured = {}

    def fake_exec(agent, prompt):
        captured["agent"] = agent
        return "done"

    monkeypatch.setattr(server_module, "execute_agent", fake_exec)
    r = client.post(f"/api/skills/{name}/run", json={"input": "go", "agent": "auto"})
    assert r.status_code == 200
    assert r.json()["agent"] == expected_agent
    assert captured["agent"] == expected_agent


def test_run_skill_uses_skill_md_primary(client, server_module, monkeypatch):
    _make_skill(server_module, "meeting-notes", skill_md="Primary: hermes\nrest")
    monkeypatch.setattr(server_module, "execute_agent", lambda a, p: "ok")
    r = client.post("/api/skills/meeting-notes/run", json={"agent": "auto"})
    assert r.json()["agent"] == "hermes"


def test_run_skill_missing_404(client, server_module, monkeypatch):
    monkeypatch.setattr(server_module, "execute_agent", lambda a, p: "ok")
    assert client.post("/api/skills/ghost/run", json={}).status_code == 404


# ─── Scheduler jobs ────────────────────────────────────────────────

def test_scheduler_job_crud(client, server_module):
    assert client.get("/api/scheduler/jobs").json() == []
    created = client.post("/api/scheduler/jobs", json={
        "name": "nightly audit", "skill": "devops-audit", "cron": "0 0 * * *",
    }).json()
    assert created["name"] == "nightly audit"
    jobs = client.get("/api/scheduler/jobs").json()
    assert len(jobs) == 1
    # file name derives from the job name with spaces replaced.
    assert (server_module.BASE_DIR / "scheduler" / "jobs" / "nightly_audit.json").exists()

    assert client.delete(f"/api/scheduler/jobs/{created['id']}").json() == {"status": "deleted"}
    assert client.get("/api/scheduler/jobs").json() == []


def test_delete_missing_job_404(client):
    assert client.delete("/api/scheduler/jobs/deadbeef").status_code == 404


# ─── Audit ─────────────────────────────────────────────────────────

def test_audit_empty_and_limit(client, server_module):
    assert client.get("/api/audit").json() == {"entries": []}
    for i in range(5):
        server_module.append_audit({"action": "act", "n": i})
    entries = client.get("/api/audit?limit=2").json()["entries"]
    assert len(entries) == 2
    assert entries[-1]["n"] == 4


# ─── Cost ──────────────────────────────────────────────────────────

def test_cost_empty_then_record(client):
    assert client.get("/api/cost").json()["entries"] == []
    client.post("/api/cost/record", json={"agent": "gemini", "tokens": 10, "cost": 0.0, "model": "flash"})
    data = client.get("/api/cost").json()
    assert data["entries"][0]["agent"] == "gemini"
    assert data["entries"][0]["tokens"] == 10


# ─── Plugins ───────────────────────────────────────────────────────

def test_plugins_install_flow(client):
    assert client.get("/api/plugins").json() == {"plugins": []}
    assert client.post("/api/plugins/install", json={"name": "cool-plugin"}).json()["status"] == "installed"
    assert client.post("/api/plugins/install", json={"name": "cool-plugin"}).json()["status"] == "already_installed"
    assert client.post("/api/plugins/install", json={"name": ""}).status_code == 400
    assert client.get("/api/plugins").json()["plugins"][0]["name"] == "cool-plugin"


# ─── Settings ──────────────────────────────────────────────────────

def test_settings_get_empty_and_update_merges(client, server_module):
    assert client.get("/api/settings").json() == {}
    client.put("/api/settings", json={"settings": {"theme": "dark"}})
    client.put("/api/settings", json={"settings": {"port": 9000}})
    result = client.get("/api/settings").json()
    assert result == {"theme": "dark", "port": 9000}


# ─── Standards ─────────────────────────────────────────────────────

def test_standards_list_and_discover(client, server_module):
    std = server_module.BASE_DIR / "standards"
    (std / "naming.md").write_text("use snake_case")
    (std / "index.yml").write_text("standards: [naming]")
    body = client.get("/api/standards").json()
    assert any(s["name"] == "naming" for s in body["standards"])
    assert "snake_case" in body["standards"][0]["content"]
    assert client.post("/api/standards/discover").json()["status"] == "discovery_started"


# ─── Prompts ───────────────────────────────────────────────────────

def test_prompts_list(client, server_module):
    (server_module.BASE_DIR / "prompts" / "code-review.md").write_text("template body")
    assert client.get("/api/prompts").json()["code-review"] == "template body"


# ─── Backups ───────────────────────────────────────────────────────

def test_backup_create_list_restore(client, server_module):
    (server_module.BASE_DIR / "brain" / "memory.md").write_text("data")
    created = client.post("/api/backup").json()
    assert created["status"] == "ok"
    listed = client.get("/api/backups").json()
    assert any(b["name"] == created["file"] for b in listed)
    assert client.post("/api/backup/restore", json={"file": created["file"]}).json()["status"] == "restored"


def test_restore_missing_backup_404(client):
    assert client.post("/api/backup/restore", json={"file": "nope.tar.gz"}).status_code == 404


# ─── Chat ──────────────────────────────────────────────────────────

def test_chat_invalid_agent(client):
    assert client.post("/api/chat", json={"agent": "bogus", "message": "hi"}).status_code == 400


def test_chat_records_history(client, server_module, monkeypatch):
    monkeypatch.setattr(server_module, "execute_agent", lambda a, m: "hello from agent")
    r = client.post("/api/chat", json={"agent": "Gemini", "message": "hi"})
    assert r.status_code == 200
    assert r.json()["response"]["content"] == "hello from agent"
    history = client.get("/api/chat/history").json()["messages"]
    assert history[0]["role"] == "user"
    assert history[1]["role"] == "assistant"


# ─── Terminal ──────────────────────────────────────────────────────

def test_terminal_session_and_blank_command(client, server_module):
    assert client.get("/api/terminal/session").json()["cwd"]
    r = client.post("/api/terminal/run", json={"command": "   "})
    assert r.json()["returncode"] == 0


def test_terminal_cd_invalid_dir(client):
    r = client.post("/api/terminal/run", json={"command": "cd /this/does/not/exist"})
    assert r.json()["returncode"] == 1
    assert "no such directory" in r.json()["stderr"]


def test_terminal_run_echo(client):
    r = client.post("/api/terminal/run", json={"command": "echo hello-term"})
    assert r.json()["returncode"] == 0
    assert "hello-term" in r.json()["stdout"]


# ─── Goals ─────────────────────────────────────────────────────────

def test_goals_crud(client, server_module):
    assert client.get("/api/goals").json() == {"goals": []}
    created = client.post("/api/goals", json={"title": "Ship v1", "description": "launch"}).json()
    gid = created["id"]
    assert created["status"] == "active"
    updated = client.put(f"/api/goals/{gid}", json={"progress": 50}).json()
    assert updated["progress"] == 50
    assert client.put("/api/goals/missing", json={"progress": 1}).status_code == 404
    assert client.delete(f"/api/goals/{gid}").json() == {"status": "deleted"}
    assert client.get("/api/goals").json() == {"goals": []}


def test_goal_creation_syncs_active_projects(client, server_module):
    active = server_module.BASE_DIR / "brain" / "active-projects.md"
    active.write_text("# Projects\n")
    client.post("/api/goals", json={"title": "Docs", "description": "write docs"})
    assert "Docs" in active.read_text()


# ─── Journal ───────────────────────────────────────────────────────

def test_journal_save_get_list_search(client, server_module):
    assert client.get("/api/journal/entries").json() == {"entries": []}
    client.put("/api/journal/entries/2026-07-08", json={"content": "Today I tested code"})
    assert client.get("/api/journal/entries/2026-07-08").json()["content"] == "Today I tested code"
    entries = client.get("/api/journal/entries").json()["entries"]
    assert entries[0]["date"] == "2026-07-08"
    found = client.get("/api/journal/search?q=tested").json()["results"]
    assert found[0]["date"] == "2026-07-08"
    assert client.get("/api/journal/search?q=").json() == {"results": []}


# ─── Agent health ──────────────────────────────────────────────────

def test_agent_health(client, server_module, monkeypatch):
    monkeypatch.setattr(server_module.shutil, "which", lambda n: None)
    body = client.get("/api/agents/health").json()
    assert len(body["agents"]) == 3
    assert body["agents"][0]["success_rate"] == 100


def test_agent_stats_valid_and_invalid(client, server_module, monkeypatch):
    monkeypatch.setattr(server_module.shutil, "which", lambda n: None)
    assert client.get("/api/agents/opencode/stats").json()["name"] == "opencode"
    assert client.get("/api/agents/nope/stats").status_code == 400


def test_agent_health_refresh(client, server_module, monkeypatch):
    monkeypatch.setattr(server_module.shutil, "which", lambda n: None)
    assert len(client.post("/api/agents/health/refresh").json()["agents"]) == 3


# ─── Smart router ──────────────────────────────────────────────────

def test_router_suggest_high_confidence(client):
    body = client.post("/api/router/suggest", json={"task": "deploy docker infra with terraform"}).json()
    assert body["suggested_agent"] == "opencode"
    assert body["confidence"] == "high"


def test_router_suggest_low_confidence(client):
    body = client.post("/api/router/suggest", json={"task": "xyzzy"}).json()
    assert body["confidence"] == "low"


def test_router_route_valid_and_invalid(client):
    assert client.post("/api/router/route", json={"task": "t", "agent": "Hermes"}).json()["status"] == "routed"
    assert client.post("/api/router/route", json={"task": "t", "agent": "bad"}).json()["status"] == "error"


# ─── Analytics ─────────────────────────────────────────────────────

def test_skill_analytics(client, server_module):
    _make_skill(server_module, "code-review", scores=[{"score": 5}, {"score": 8}])
    _make_skill(server_module, "brainstorming", scores=[])
    body = client.get("/api/analytics/skills").json()["skills"]
    cr = next(s for s in body if s["name"] == "code-review")
    assert cr["total_runs"] == 2
    assert cr["avg_score"] == 6.5
    assert cr["trend"] == "up"


def test_trend_analytics(client, server_module):
    _make_skill(server_module, "tdd-cycle", scores=[{"score": 3, "date": "d1"}])
    body = client.get("/api/analytics/trends").json()["trends"]
    assert body[0]["name"] == "tdd-cycle"
    assert body[0]["scores"] == [3]


# ─── Session replay ────────────────────────────────────────────────

def test_sessions_list_empty(client, server_module, monkeypatch, tmp_path):
    monkeypatch.setattr(server_module.Path, "home", staticmethod(lambda: tmp_path))
    assert client.get("/api/sessions/list").json() == {"sessions": []}


def test_session_replay_not_found(client, server_module, monkeypatch, tmp_path):
    monkeypatch.setattr(server_module.Path, "home", staticmethod(lambda: tmp_path))
    body = client.get("/api/sessions/some-id/replay").json()
    assert body["content"] == "Session log not found"
