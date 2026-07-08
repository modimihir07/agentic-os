"""Unit tests for the pure helper functions in ``server.py``."""
import json

import pytest


def test_read_file_missing_returns_empty(server_module, tmp_path):
    assert server_module.read_file(tmp_path / "nope.txt") == ""


def test_read_write_file_roundtrip(server_module, tmp_path):
    target = tmp_path / "note.txt"
    assert server_module.write_file(target, "hello") is True
    assert server_module.read_file(target) == "hello"


def test_list_dir_missing_returns_empty(server_module, tmp_path):
    assert server_module.list_dir(tmp_path / "absent") == []


def test_list_dir_skips_hidden_and_sorts(server_module, tmp_path):
    d = tmp_path / "things"
    d.mkdir()
    (d / "b.txt").write_text("")
    (d / "a.txt").write_text("")
    (d / ".hidden").write_text("")
    assert server_module.list_dir(d) == ["a.txt", "b.txt"]


def test_get_timestamp_is_iso_utc(server_module):
    ts = server_module.get_timestamp()
    # datetime.fromisoformat round-trips a valid ISO 8601 string.
    from datetime import datetime

    parsed = datetime.fromisoformat(ts)
    assert parsed.tzinfo is not None


def test_append_audit_writes_entry(server_module):
    server_module.append_audit({"action": "unit_test"})
    audit_file = server_module.BASE_DIR / "audit" / "audit.log"
    lines = audit_file.read_text().strip().splitlines()
    assert len(lines) == 1
    entry = json.loads(lines[0])
    assert entry["action"] == "unit_test"
    assert "timestamp" in entry
    assert len(entry["id"]) == 8


def test_get_cors_origins_defaults(server_module, monkeypatch):
    monkeypatch.delenv("AGENTIC_OS_CORS_ORIGINS", raising=False)
    origins = server_module.get_cors_origins()
    assert "http://localhost:8080" in origins
    assert "http://127.0.0.1:8080" in origins


def test_get_cors_origins_reads_port_from_settings(server_module, monkeypatch):
    monkeypatch.delenv("AGENTIC_OS_CORS_ORIGINS", raising=False)
    settings = server_module.BASE_DIR / "data" / "settings.json"
    settings.write_text(json.dumps({"dashboard": {"port": 9000}}))
    origins = server_module.get_cors_origins()
    assert "http://localhost:9000" in origins
    assert "http://127.0.0.1:9000" in origins


def test_get_cors_origins_includes_env_extras(server_module, monkeypatch):
    monkeypatch.setenv("AGENTIC_OS_CORS_ORIGINS", "https://a.example, https://b.example ")
    origins = server_module.get_cors_origins()
    assert "https://a.example" in origins
    assert "https://b.example" in origins


def test_get_cors_origins_bad_settings_falls_back(server_module):
    settings = server_module.BASE_DIR / "data" / "settings.json"
    settings.write_text("{ not valid json")
    origins = server_module.get_cors_origins()
    assert "http://localhost:8080" in origins


@pytest.mark.parametrize("which_result,expected", [(None, "offline"), ("/usr/bin/opencode", "online")])
def test_check_agent_opencode(server_module, monkeypatch, which_result, expected):
    monkeypatch.setattr(server_module.shutil, "which", lambda name: which_result)
    assert server_module.check_agent("opencode") == {"name": "opencode", "status": expected}


def test_check_agent_unknown_is_offline(server_module):
    assert server_module.check_agent("mystery")["status"] == "offline"


def test_check_agent_gemini_warning_when_not_logged_in(server_module, monkeypatch, tmp_path):
    monkeypatch.setattr(server_module.shutil, "which", lambda name: "/usr/bin/gemini")
    monkeypatch.setattr(server_module.Path, "home", staticmethod(lambda: tmp_path))
    # No oauth creds file -> installed but not logged in -> warning.
    assert server_module.check_agent("gemini")["status"] == "warning"


def test_check_agent_gemini_online_when_logged_in(server_module, monkeypatch, tmp_path):
    monkeypatch.setattr(server_module.shutil, "which", lambda name: "/usr/bin/gemini")
    monkeypatch.setattr(server_module.Path, "home", staticmethod(lambda: tmp_path))
    creds = tmp_path / ".gemini" / "oauth_creds.json"
    creds.parent.mkdir(parents=True)
    creds.write_text('{"token": "ya29.abc"}')
    assert server_module.check_agent("gemini")["status"] == "online"


def test_clean_hermes_output_empty(server_module):
    assert server_module.clean_hermes_output("") == ""


def test_clean_hermes_output_extracts_box_content(server_module):
    raw = "Query: hi\n╭─ box\nHello there\nSecond line\n╰─ end\nDuration: 1s"
    assert server_module.clean_hermes_output(raw) == "Hello there\nSecond line"


def test_clean_hermes_output_fallback_without_box(server_module):
    raw = "Query: hi\nInitializing...\nActual answer here"
    assert "Actual answer here" in server_module.clean_hermes_output(raw)


def test_kanban_task_path_rejects_bad_id(server_module):
    with pytest.raises(server_module.HTTPException):
        server_module.kanban_task_path("../../etc/passwd")


def test_kanban_task_path_rejects_empty(server_module):
    with pytest.raises(server_module.HTTPException):
        server_module.kanban_task_path("")


def test_kanban_task_path_accepts_valid_id(server_module):
    path = server_module.kanban_task_path("abc123")
    assert path.name == "abc123.json"
    assert path.parent == server_module.KANBAN_DIR.resolve()


def test_load_save_chat_history_roundtrip(server_module):
    assert server_module.load_chat_history() == {"messages": []}
    server_module.save_chat_message({"content": "hi"})
    assert server_module.load_chat_history()["messages"][-1]["content"] == "hi"


def test_save_chat_message_caps_at_200(server_module):
    for i in range(210):
        server_module.save_chat_message({"content": str(i)})
    history = server_module.load_chat_history()
    assert len(history["messages"]) == 200
    assert history["messages"][-1]["content"] == "209"
