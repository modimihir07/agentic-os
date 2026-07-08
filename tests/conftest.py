"""Shared pytest fixtures for the Agentic OS test suite.

The application code (``server.py``) computes a number of module-level path
constants from ``BASE_DIR`` at import time. To keep tests hermetic — no writes
to the real repository — the fixtures below redirect every one of those
constants at a temporary directory and rebuild the minimal folder layout the
endpoints expect.
"""
import importlib
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


@pytest.fixture()
def server_module(tmp_path, monkeypatch):
    """Import ``server`` with all filesystem paths redirected to ``tmp_path``.

    Returns the imported module with its path globals patched so tests can
    exercise endpoints without touching the real project directories.
    """
    server = importlib.import_module("server")

    base = tmp_path
    for sub in ["data", "data/kanban", "brain", "brain/journal", "audit",
                "skills", "scheduler/jobs", "registry", "standards",
                "prompts", "backups", "agents"]:
        (base / sub).mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(server, "BASE_DIR", base)
    monkeypatch.setattr(server, "KANBAN_DIR", base / "data" / "kanban")
    monkeypatch.setattr(server, "GOALS_FILE", base / "data" / "goals.json")
    monkeypatch.setattr(server, "JOURNAL_DIR", base / "brain" / "journal")
    monkeypatch.setattr(server, "CHAT_HISTORY_FILE",
                        base / "data" / "chat-history.json")
    monkeypatch.setattr(server, "_terminal_cwd", str(base))

    return server


@pytest.fixture()
def client(server_module):
    from fastapi.testclient import TestClient

    with TestClient(server_module.app) as c:
        yield c
