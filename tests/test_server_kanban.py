"""Tests for the Kanban board endpoints and autonomous dispatch logic."""
import json

import pytest


@pytest.fixture()
def sync_threads(server_module, monkeypatch):
    """Run ``threading.Thread`` targets synchronously so dispatch is deterministic."""
    class _SyncThread:
        def __init__(self, target=None, args=(), kwargs=None, daemon=None):
            self._target = target
            self._args = args
            self._kwargs = kwargs or {}

        def start(self):
            if self._target:
                self._target(*self._args, **self._kwargs)

    monkeypatch.setattr(server_module.threading, "Thread", _SyncThread)
    return server_module


def _create(client, **kw):
    payload = {"title": "T", "body": "", "status": "triage",
               "priority": "medium", "assignee": ""}
    payload.update(kw)
    return client.post("/api/kanban/tasks", json=payload).json()


def test_board_empty(client):
    body = client.get("/api/kanban/board").json()
    assert body["total"] == 0
    assert set(body["columns"]) == {"triage", "todo", "ready", "in_progress", "blocked", "done"}


def test_create_and_get_task(client):
    task = _create(client, title="Write tests", assignee="")
    assert task["title"] == "Write tests"
    assert task["status"] == "triage"
    fetched = client.get(f"/api/kanban/tasks/{task['id']}").json()
    assert fetched["id"] == task["id"]


def test_get_missing_task_404(client):
    assert client.get("/api/kanban/tasks/abc123").status_code == 404


def test_board_groups_by_status(client):
    _create(client, status="todo")
    _create(client, status="done")
    board = client.get("/api/kanban/board").json()
    assert len(board["columns"]["todo"]) == 1
    assert len(board["columns"]["done"]) == 1
    assert board["total"] == 2
    # filter by status query
    filtered = client.get("/api/kanban/board?status=todo").json()
    assert filtered["total"] == 1


def test_update_task(client):
    task = _create(client)
    updated = client.patch(f"/api/kanban/tasks/{task['id']}",
                           json={"title": "renamed", "priority": "high"}).json()
    assert updated["title"] == "renamed"
    assert updated["priority"] == "high"


def test_update_missing_404(client):
    assert client.patch("/api/kanban/tasks/abc123", json={"title": "x"}).status_code == 404


def test_complete_block_unblock(client):
    task = _create(client)
    tid = task["id"]
    assert client.post(f"/api/kanban/tasks/{tid}/complete", json={"summary": "done!"}).json()["status"] == "done"
    assert client.post(f"/api/kanban/tasks/{tid}/block", json={"reason": "stuck"}).json()["status"] == "blocked"
    unblocked = client.post(f"/api/kanban/tasks/{tid}/unblock").json()
    assert unblocked["status"] == "ready"
    assert unblocked["block_reason"] == ""


def test_comments(client):
    task = _create(client)
    updated = client.post(f"/api/kanban/tasks/{task['id']}/comments", json={"message": "hi there"}).json()
    assert updated["comments"][0]["message"] == "hi there"


def test_links_add_and_remove(client):
    parent = _create(client)
    child = _create(client)
    r = client.post("/api/kanban/links", json={"parent_id": parent["id"], "child_id": child["id"]})
    assert r.json() == {"status": "linked"}
    linked = client.get(f"/api/kanban/tasks/{parent['id']}").json()
    assert {"parent": parent["id"], "child": child["id"]} in linked["links"]
    r = client.delete(f"/api/kanban/links?parent_id={parent['id']}&child_id={child['id']}")
    assert r.json() == {"status": "unlinked"}
    unlinked = client.get(f"/api/kanban/tasks/{parent['id']}").json()
    assert unlinked["links"] == []


def test_link_missing_task_404(client):
    parent = _create(client)
    assert client.post("/api/kanban/links",
                       json={"parent_id": parent["id"], "child_id": "abcdef"}).status_code == 404


def test_specify_moves_triage_to_todo(client):
    task = _create(client, status="triage")
    assert client.post(f"/api/kanban/tasks/{task['id']}/specify").json()["status"] == "todo"


def test_decompose_creates_children(client):
    task = _create(client, body="- first subtask\n- second subtask\n\n")
    body = client.post(f"/api/kanban/tasks/{task['id']}/decompose").json()
    assert body["parent"] == task["id"]
    assert len(body["children"]) == 2
    titles = [c["title"] for c in body["children"]]
    assert "first subtask" in titles


def test_dispatch_requires_valid_assignee(client):
    task = _create(client, assignee="")
    assert client.post(f"/api/kanban/tasks/{task['id']}/dispatch").status_code == 400


def test_create_with_agent_assignee_dispatches(client, sync_threads, monkeypatch):
    monkeypatch.setattr(sync_threads, "execute_agent", lambda agent, prompt: "agent finished the job")
    task = _create(client, title="Do work", assignee="opencode")
    # With synchronous dispatch, the task runs to completion immediately.
    assert task["status"] == "done"
    assert task["summary"].startswith("agent finished")
    assert any("opencode" in c["message"] for c in task["comments"])


def test_dispatch_failure_blocks_task(client, sync_threads, monkeypatch):
    monkeypatch.setattr(sync_threads, "execute_agent", lambda agent, prompt: "⚠ Agent not installed")
    task = _create(client, title="Do work", assignee="hermes")
    assert task["status"] == "blocked"
    assert "not installed" in task["block_reason"]


def test_bulk_dispatch_endpoint(client, sync_threads, monkeypatch):
    monkeypatch.setattr(sync_threads, "execute_agent", lambda agent, prompt: "ok done")

    # Write task files directly so they start eligible (todo/ready with an agent
    # assignee) — going through the create endpoint would auto-dispatch them.
    def _seed(tid, status, assignee):
        sync_threads.save_kanban_task({
            "id": tid, "title": "t", "body": "", "status": status,
            "priority": "medium", "assignee": assignee, "comments": [], "links": [],
        })

    _seed("aaaaaa", "todo", "gemini")
    _seed("bbbbbb", "ready", "opencode")
    _seed("cccccc", "triage", "")  # not eligible
    body = client.post("/api/kanban/dispatch").json()
    assert len(body["dispatched"]) == 2
