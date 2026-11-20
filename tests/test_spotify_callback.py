"""Spotify OAuth callback relay (os_api.spotify_router): state validation,
one-time pop, TTL, and the access-log redaction of the code.

Run with: python3 tests/run_all.py  (or: python3 tests/test_spotify_callback.py)
"""
import logging
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import Harness  # noqa: E402

import os_api  # noqa: E402

STATE = "A" * 31 + "b"  # 32 url-safe chars


class SpotifyStoreTests(unittest.TestCase):
    def setUp(self):
        os_api._spotify_results.clear()

    def test_pop_is_one_time(self):
        os_api.spotify_store(STATE, {"code": "c1"}, now=100.0)
        self.assertEqual(os_api.spotify_take(STATE, now=101.0), {"code": "c1"})
        self.assertEqual(os_api.spotify_take(STATE, now=102.0), {"pending": True})

    def test_ttl_expires(self):
        os_api.spotify_store(STATE, {"code": "c1"}, now=100.0)
        self.assertEqual(os_api.spotify_take(STATE, now=100.0 + 301), {"pending": True})
        self.assertNotIn(STATE, os_api._spotify_results)

    def test_store_prunes_expired_and_caps_size(self):
        os_api.spotify_store("x" * 32, {"code": "old"}, now=0.0)
        os_api.spotify_store(STATE, {"code": "new"}, now=1000.0)
        self.assertNotIn("x" * 32, os_api._spotify_results)
        for i in range(os_api._SPOTIFY_MAX + 5):
            os_api.spotify_store(f"{i:032d}", {"code": str(i)}, now=2000.0 + i)
        self.assertLessEqual(len(os_api._spotify_results), os_api._SPOTIFY_MAX)
        self.assertIn(f"{os_api._SPOTIFY_MAX + 4:032d}", os_api._spotify_results)

    def test_access_log_redacts_code(self):
        rec = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1, '%s - "%s %s HTTP/%s" %d', ("127.0.0.1:5", "GET", f"/api/spotify/callback?code=SECRET&state={STATE}", "1.1", 200), None)
        os_api._RedactSpotifyCode().filter(rec)
        self.assertNotIn("SECRET", rec.getMessage())
        self.assertIn(f"state={STATE}", rec.getMessage())


class SpotifyRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.h = Harness()
        cls.h.start()

    @classmethod
    def tearDownClass(cls):
        cls.h.stop()

    def setUp(self):
        os_api._spotify_results.clear()

    def test_callback_then_pending_once(self):
        status, body = self.h.request("GET", f"/api/spotify/callback?code=AQBcode-_1&state={STATE}")
        self.assertEqual(status, 200)
        self.assertIn(b"Spotify connected", body)
        self.assertNotIn(b"AQBcode", body)
        self.assertEqual(self.h.api("GET", f"/api/spotify/pending?state={STATE}"), (200, {"code": "AQBcode-_1"}))
        self.assertEqual(self.h.api("GET", f"/api/spotify/pending?state={STATE}"), (200, {"pending": True}))

    def test_denied_is_relayed(self):
        status, _ = self.h.request("GET", f"/api/spotify/callback?error=access_denied&state={STATE}")
        self.assertEqual(status, 200)
        self.assertEqual(self.h.api("GET", f"/api/spotify/pending?state={STATE}")[1], {"error": "access_denied"})

    def test_bad_state_rejected(self):
        status, _ = self.h.request("GET", "/api/spotify/callback?code=abc&state=short")
        self.assertEqual(status, 400)
        status, _ = self.h.request("GET", "/api/spotify/callback?code=abc&state=" + "a" * 31 + "%3B")
        self.assertEqual(status, 400)
        self.assertEqual(os_api._spotify_results, {})
        self.assertEqual(self.h.api("GET", "/api/spotify/pending?state=bad")[0], 400)

    def test_callback_without_code_or_error_rejected(self):
        status, _ = self.h.request("GET", f"/api/spotify/callback?state={STATE}")
        self.assertEqual(status, 400)
        status, _ = self.h.request("GET", f"/api/spotify/callback?code=a%20b&state={STATE}")
        self.assertEqual(status, 400)
        self.assertEqual(os_api._spotify_results, {})


if __name__ == "__main__":
    unittest.main()
