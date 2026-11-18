"""Security hardening tests — path-traversal / injection guards (v4.0).

Validates the strict allowlist validation added in commit 4af5ea3:
skill names, kanban task ids, journal dates, scheduler job names, backup files.
"""
import sys
import unittest
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import Harness  # noqa: E402


class SecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.h = Harness()
        cls.h.start()

    @classmethod
    def tearDownClass(cls):
        cls.h.stop()

    # ── traversal payloads (URL-encoded so they stay single-segment) ─
    TRAVERSALS = [
        quote("../../etc/passwd"),
        quote("..%2F..%2Fetc%2Fpasswd"),
        quote("....//....//etc/passwd"),
        quote("%2e%2e/settings"),
        quote("..%5c..%5csettings"),
    ]

    def test_skill_traversal_rejected(self):
        for evil in self.TRAVERSALS:
            status, _ = self.h.api("GET", f"/api/skills/{evil}")
            self.assertNotEqual(status, 200, f"skill traversal slipped through: {evil}")

    def test_skill_run_traversal_rejected(self):
        for evil in [quote("../../settings"), quote("..%2F..%2Fdata%2Fsettings")]:
            status, _ = self.h.api("POST", f"/api/skills/{evil}/run",
                                   {"agent": "opencode", "input": "x"})
            self.assertNotEqual(status, 200, f"skill run traversal slipped: {evil}")

    def test_skill_eval_traversal_rejected(self):
        for evil in [quote("../../settings"), quote("..%2F..%2Fdata")]:
            status, _ = self.h.api("GET", f"/api/skills/{evil}/eval")
            self.assertNotEqual(status, 200, f"skill eval traversal slipped: {evil}")

    def test_skill_invalid_chars_rejected(self):
        for evil in ["heartbeat.", ".hidden", quote("a b"), "a*b", quote("a\u00e9")]:
            status, _ = self.h.api("GET", f"/api/skills/{evil}")
            self.assertNotEqual(status, 200, f"invalid skill name accepted: {evil}")

    def test_skill_valid_name_works(self):
        status, data = self.h.api("GET", "/api/skills/heartbeat")
        self.assertEqual(status, 200)
        self.assertEqual(data.get("name"), "heartbeat")

    def test_kanban_traversal_rejected(self):
        for evil in ["../../settings", "..%2F..%2Fdata%2Fsettings"]:
            status, _ = self.h.api("GET", f"/api/kanban/tasks/{evil}")
            self.assertNotEqual(status, 200, f"kanban traversal slipped: {evil}")

    def test_kanban_invalid_id_rejected(self):
        for evil in ["..", ".", "a/b", "a\\b", ""]:
            status, _ = self.h.api("GET", f"/api/kanban/tasks/{evil}")
            self.assertNotEqual(status, 200, f"invalid kanban id accepted: {evil}")

    def test_journal_traversal_rejected(self):
        status, _ = self.h.api("GET", "/api/journal/entries/../../settings")
        self.assertNotEqual(status, 200)
        status, _ = self.h.api("GET", "/api/journal/entries/2026-06-05%2F..%2F..%2Fetc%2Fpasswd")
        self.assertNotEqual(status, 200)

    def test_journal_bad_date_format_rejected(self):
        for evil in ["2026-6-5", quote("2026/06/05"), "2026.06.05", "06-05-2026", "20260605"]:
            status, _ = self.h.api("GET", f"/api/journal/entries/{evil}")
            # 400 = validator rejection, 404 = slash decoded before routing
            self.assertIn(status, (400, 404), f"bad date accepted: {evil}")

    def test_journal_valid_date_works(self):
        status, _ = self.h.api("GET", "/api/journal/entries/2026-06-05")
        self.assertEqual(status, 200)

    def test_scheduler_job_traversal_rejected(self):
        status, _ = self.h.api(
            "POST", "/api/scheduler/jobs",
            {"name": "../../evil", "skill": "heartbeat", "cron": "* * * * *"},
        )
        self.assertEqual(status, 400)

    def test_scheduler_job_invalid_name_rejected(self):
        status, _ = self.h.api(
            "POST", "/api/scheduler/jobs",
            {"name": "evil/../x", "skill": "heartbeat", "cron": "* * * * *"},
        )
        self.assertEqual(status, 400)

    def test_scheduler_job_valid_name_works(self):
        status, data = self.h.api(
            "POST", "/api/scheduler/jobs",
            {"name": "test-job-v4", "skill": "heartbeat", "cron": "0 0 * * *"},
        )
        self.assertEqual(status, 200)
        self.assertEqual(data.get("name"), "test-job-v4")
        # cleanup
        self.h.api("DELETE", f"/api/scheduler/jobs/{data['id']}")

    def test_backup_restore_traversal_rejected(self):
        for evil in ["../../etc/passwd", "agentic-os.tar.gz", "..%2F..%2Fsettings"]:
            status, _ = self.h.api("POST", "/api/backup/restore", {"file": evil})
            self.assertEqual(status, 400, f"backup traversal slipped: {evil}")

    def test_brain_file_traversal_rejected(self):
        for evil in ["../../etc/passwd", "..%2F..%2Fserver.py"]:
            status, _ = self.h.api("GET", f"/api/brain/{evil}")
            self.assertNotEqual(status, 200, f"brain traversal slipped: {evil}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
