"""v4.0 feature tests: chat history filter, file uploads, memory graph, diff.

Run with: python3 tests/run_all.py  (or: python3 tests/test_v40.py)
"""
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import Harness  # noqa: E402

import server  # noqa: E402


class ChatHistoryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.h = Harness()
        cls.h.start()

    @classmethod
    def tearDownClass(cls):
        cls.h.stop()

    def _seed_message(self, content, agent="opencode"):
        msg = {
            "id": "seed1",
            "role": "user",
            "agent": agent,
            "content": content,
            "timestamp": "2026-08-11T12:00:00Z",
        }
        history = server.load_chat_history()
        history.setdefault("messages", []).append(msg)
        server.save_chat_message(msg)
    def test_history_empty_by_default(self):
        # Clear any messages seeded by prior tests in this class
        server.save_chat_message({"id": "clear", "role": "user", "agent": "opencode",
                                  "content": "", "timestamp": ""})
        history = server.load_chat_history()
        history["messages"] = []
        server.CHAT_HISTORY_FILE.write_text(__import__("json").dumps(history))
        status, data = self.h.api("GET", "/api/chat/history")
        self.assertEqual(status, 200)
        self.assertEqual(data["total"], 0)

    def test_history_search_filters(self):
        self._seed_message("terraform plan complete", "opencode")
        self._seed_message("pod restart completed", "agy")
        status, data = self.h.api("GET", "/api/chat/history?q=terraform")
        self.assertEqual(status, 200)
        self.assertEqual(data["total"], 1)
        self.assertIn("terraform", data["messages"][0]["content"])

    def test_history_agent_filter(self):
        self._seed_message("deploy the cluster", "opencode")
        self._seed_message("schedule the job", "agy")
        status, data = self.h.api("GET", "/api/chat/history?agent=agy")
        self.assertEqual(status, 200)
        self.assertEqual(data["total"], 1)
        self.assertEqual(data["messages"][0]["agent"], "agy")

    def test_history_limit(self):
        for i in range(5):
            self._seed_message(f"message number {i}")
        status, data = self.h.api("GET", "/api/chat/history?limit=2")
        self.assertEqual(status, 200)
        self.assertEqual(data["total"], 2)


class ChatUploadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.h = Harness()
        cls.h.start()

    @classmethod
    def tearDownClass(cls):
        cls.h.stop()

    def test_upload_valid_file(self):
        with mock.patch.object(server, "execute_agent", return_value="mock reply"):
            status, data = self.h.upload(
                "/api/chat/upload",
                {"agent": "opencode", "message": "review this"},
                "notes.md",
                b"# Notes\n\nsome content here",
            )
        self.assertEqual(status, 200)
        self.assertEqual(data["status"], "ok")
        self.assertEqual(data["file"], "notes.md")
        self.assertEqual(data["response"]["content"], "mock reply")
        # File must be stored in the isolated temp uploads dir
        saved = self.h.tmp / "data" / "uploads"
        self.assertTrue(saved.exists())
        files = list(saved.glob("*.md"))
        self.assertEqual(len(files), 1)
        self.assertIn(b"# Notes", files[0].read_bytes())

    def test_upload_agent_validation(self):
        status, _ = self.h.upload(
            "/api/chat/upload",
            {"agent": "bogus", "message": ""},
            "f.txt",
            b"x",
        )
        self.assertEqual(status, 400)

    def test_upload_invalid_extension(self):
        status, _ = self.h.upload(
            "/api/chat/upload",
            {"agent": "opencode", "message": ""},
            "virus.exe",
            b"x",
        )
        self.assertEqual(status, 400)

    def test_upload_oversized_file(self):
        status, _ = self.h.upload(
            "/api/chat/upload",
            {"agent": "opencode", "message": ""},
            "big.txt",
            b"x" * (2 * 1024 * 1024 + 1),
        )
        self.assertEqual(status, 413)

    def test_upload_traversal_filename_rejected(self):
        status, _ = self.h.upload(
            "/api/chat/upload",
            {"agent": "opencode", "message": ""},
            "..%2F..%2Fevil.txt",
            b"x",
        )
        self.assertEqual(status, 400)


class AgentNotInstalledTests(unittest.TestCase):
    """A missing CLI must be an HTTP 503 failure, never a 200 "reply" (chain poisoning)."""

    @classmethod
    def setUpClass(cls):
        cls.h = Harness()
        cls.h.start()

    @classmethod
    def tearDownClass(cls):
        cls.h.stop()

    def test_chat_missing_cli_is_503(self):
        with mock.patch.object(server, "resolve_cli", return_value=None):
            status, data = self.h.api("POST", "/api/chat", {"agent": "opencode", "message": "hi"})
        self.assertEqual(status, 503)
        self.assertIn("not installed", data["detail"])
        # Nothing is logged as a conversation turn.
        _, hist = self.h.api("GET", "/api/chat/history?q=hi")
        self.assertEqual(hist["total"], 0)

    def test_upload_missing_cli_is_503(self):
        with mock.patch.object(server, "resolve_cli", return_value=None):
            status, data = self.h.upload("/api/chat/upload", {"agent": "agy", "message": "x"}, "n.txt", b"x")
        self.assertEqual(status, 503)
        self.assertIn("not installed", data["detail"])

    def test_skill_run_missing_cli_is_503(self):
        with mock.patch.object(server, "resolve_cli", return_value=None):
            status, data = self.h.api("POST", "/api/skills/heartbeat/run", {"agent": "opencode", "input": ""})
        self.assertEqual(status, 503)
        self.assertIn("not installed", data["detail"])

    def test_hermes_is_rejected(self):
        status, _ = self.h.api("POST", "/api/chat", {"agent": "hermes", "message": "hi"})
        self.assertEqual(status, 400)


class MemoryGraphTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.h = Harness()
        cls.h.start()

    @classmethod
    def tearDownClass(cls):
        cls.h.stop()

    def test_memory_graph_endpoint(self):
        status, data = self.h.api("GET", "/api/memory/graph")
        self.assertEqual(status, 200)
        self.assertIn("nodes", data)
        self.assertIn("edges", data)
        self.assertIsInstance(data["nodes"], list)
        self.assertIsInstance(data["edges"], list)

    def test_memory_graph_has_nodes(self):
        (self.h.tmp / "brain" / "graph-note.md").write_text(
            "zephyrquadrant graph connectivity notes"
        )
        status, _ = self.h.api("POST", "/api/memory/reindex")
        self.assertEqual(status, 200)
        status, data = self.h.api("GET", "/api/memory/graph")
        self.assertEqual(status, 200)
        self.assertGreater(len(data["nodes"]), 0)


class DiffViewerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.h = Harness()
        cls.h.start()

    @classmethod
    def tearDownClass(cls):
        cls.h.stop()

    def test_diff_missing_file_param(self):
        status, _ = self.h.api("GET", "/api/diff")
        self.assertEqual(status, 400)

    def test_diff_nonexistent_file(self):
        status, _ = self.h.api("GET", "/api/diff?file=no/such/file.md")
        self.assertEqual(status, 404)

    def test_diff_traversal_rejected(self):
        status, _ = self.h.api("GET", "/api/diff?file=../../etc/passwd")
        self.assertEqual(status, 400)

    def test_diff_known_file_ok(self):
        # skills/ exists in the isolated state; git may not report a diff,
        # but the endpoint must still return 200 with changed=false
        status, data = self.h.api("GET", "/api/diff?file=skills/_template/SKILL.md")
        self.assertEqual(status, 200)
        self.assertIn("file", data)
        self.assertIn("changed", data)


if __name__ == "__main__":
    unittest.main()
