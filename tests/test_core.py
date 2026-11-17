"""Core endpoint smoke tests for Agentic OS (v4.0).

Run with: python3 tests/run_all.py  (or: python3 tests/test_core.py)
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import Harness  # noqa: E402


class CoreEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.h = Harness()
        cls.h.start()

    @classmethod
    def tearDownClass(cls):
        cls.h.stop()

    def test_status_healthy(self):
        status, data = self.h.api("GET", "/api/status")
        self.assertEqual(status, 200)
        self.assertEqual(data.get("status"), "healthy")
        self.assertIn("agents", data)

    def test_three_agents_present(self):
        _, data = self.h.api("GET", "/api/status")
        names = {a.get("name") for a in data.get("agents", [])}
        # The core three must always be reported; v5's CLI hub adds claude / gemini / llm.
        self.assertTrue({"opencode", "hermes", "agy"} <= names, names)
        self.assertEqual(len(names), len(data.get("agents", [])), "duplicate agent names")

    def test_skills_list(self):
        status, data = self.h.api("GET", "/api/skills")
        self.assertEqual(status, 200)
        self.assertIsInstance(data, list)

    def test_brain_files(self):
        status, data = self.h.api("GET", "/api/brain")
        self.assertEqual(status, 200)
        self.assertIsInstance(data, dict)

    def test_scheduler_jobs(self):
        status, data = self.h.api("GET", "/api/scheduler/jobs")
        self.assertEqual(status, 200)
        self.assertIsInstance(data, list)

    def test_audit_log(self):
        status, data = self.h.api("GET", "/api/audit")
        self.assertEqual(status, 200)

    def test_cost_analytics(self):
        status, data = self.h.api("GET", "/api/cost")
        self.assertEqual(status, 200)

    def test_plugins(self):
        status, data = self.h.api("GET", "/api/plugins")
        self.assertEqual(status, 200)

    def test_prompts(self):
        status, data = self.h.api("GET", "/api/prompts")
        self.assertEqual(status, 200)

    def test_settings_masked(self):
        status, data = self.h.api("GET", "/api/settings")
        self.assertEqual(status, 200)
        text = str(data)
        self.assertNotIn("ghp_", text, "API token must be masked")

    def test_standards(self):
        status, data = self.h.api("GET", "/api/standards")
        self.assertEqual(status, 200)

    def test_kanban_board(self):
        status, data = self.h.api("GET", "/api/kanban/board")
        self.assertEqual(status, 200)

    def test_goals(self):
        status, data = self.h.api("GET", "/api/goals")
        self.assertEqual(status, 200)

    def test_journal_entries(self):
        status, data = self.h.api("GET", "/api/journal/entries")
        self.assertEqual(status, 200)

    def test_agent_health(self):
        status, data = self.h.api("GET", "/api/agents/health")
        self.assertEqual(status, 200)

    def test_skill_analytics(self):
        status, data = self.h.api("GET", "/api/analytics/skills")
        self.assertEqual(status, 200)

    def test_sessions_list(self):
        status, data = self.h.api("GET", "/api/sessions/list")
        self.assertEqual(status, 200)

    def test_backups_list(self):
        status, data = self.h.api("GET", "/api/backups")
        self.assertEqual(status, 200)

    def test_security_headers_present(self):
        import urllib.request

        req = urllib.request.Request(self.h.base_url + "/api/status")
        with urllib.request.urlopen(req, timeout=10) as resp:
            headers = dict(resp.headers)
        self.assertIn("x-content-type-options", headers)
        self.assertEqual(headers["x-content-type-options"], "nosniff")
        self.assertIn("x-frame-options", headers)
        self.assertIn("strict-transport-security", headers)

    def test_cors_restricted_to_localhost(self):
        import urllib.request

        req = urllib.request.Request(self.h.base_url + "/api/status")
        req.add_header("Origin", "http://evil.example.com")
        with urllib.request.urlopen(req, timeout=10) as resp:
            allow = resp.headers.get("access-control-allow-origin")
        self.assertIsNone(allow, "Non-localhost origin must not be allowed")

    def test_dashboard_served(self):
        status, _ = self.h.request("GET", "/")
        self.assertEqual(status, 200)

    def test_manifest_served(self):
        status, _ = self.h.request("GET", "/manifest.json")
        self.assertEqual(status, 200)


if __name__ == "__main__":
    unittest.main(verbosity=2)
