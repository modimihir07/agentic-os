"""Zero-dependency test harness for Agentic OS (v4.0).

Boots the real FastAPI app (server.app) in-process on a free port with ALL
state redirected to a temporary directory, so tests never touch real
brain/, data/, scheduler/jobs/, audit/ or backups/. Runs on the Python
standard library only (urllib + threading + unittest) — no pytest, no httpx.

Run:  python3 tests/run_all.py
"""
import json
import shutil
import socket
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import server  # noqa: E402  (must import after sys.path setup)
import scheduler.scheduler as sched  # noqa: E402
import brain.memory_search as mem  # noqa: E402


def get_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Harness:
    """Boots server.app against an isolated temp state dir."""

    def __init__(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="agentic-os-test-"))
        self.port = get_free_port()
        self.base_url = f"http://127.0.0.1:{self.port}"
        self._server_thread = None
        self._uvicorn = None
        self._seed_state()
        self._redirect_paths()

    # ── isolation ─────────────────────────────────────────────
    def _redirect_paths(self):
        """Point every module path global at the temp dir."""
        server.BASE_DIR = self.tmp
        server.ERROR_LOG_FILE = self.tmp / "data" / "error-log.json"
        server.CIRCUIT_BREAKER_FILE = self.tmp / "data" / "circuit-breaker.json"
        server.CHAT_HISTORY_FILE = self.tmp / "data" / "chat-history.json"
        server.KANBAN_DIR = self.tmp / "data" / "kanban"
        server.GOALS_FILE = self.tmp / "data" / "goals.json"
        server.JOURNAL_DIR = self.tmp / "brain" / "journal"
        server.UPLOAD_DIR = self.tmp / "data" / "uploads"

        sched.BASE_DIR = self.tmp / "scheduler"
        sched.JOBS_DIR = self.tmp / "scheduler" / "jobs"
        sched.HISTORY_FILE = self.tmp / "data" / "scheduler-history.json"

        mem.BASE_DIR = self.tmp / "brain"
        mem.DB_PATH = self.tmp / "data" / "memory.db"
        # memory_search caches a thread-local connection at import time
        # (init_db() runs on import), so drop it before re-initializing
        # against the temp DB to avoid touching the real data/memory.db.
        if hasattr(mem._local, "conn") and mem._local.conn is not None:
            mem._local.conn.close()
            del mem._local.conn
        mem.init_db()

    def _seed_state(self):
        """Create the minimal dir structure the app expects."""
        for d in [
            "data/kanban",
            "brain/journal",
            "scheduler/jobs",
            "audit",
            "backups",
            "skills",
            "registry",
            "standards",
            "prompts",
            "agents/opencode",
            "agents/agy",
        ]:
            (self.tmp / d).mkdir(parents=True, exist_ok=True)
        # Copy real read-only content (skills, brain notes) so endpoints
        # behave realistically, without ever writing back to the repo.
        for src, dst in [
            (PROJECT_ROOT / "skills", self.tmp / "skills"),
            (PROJECT_ROOT / "brain", self.tmp / "brain"),
            (PROJECT_ROOT / "prompts", self.tmp / "prompts"),
            (PROJECT_ROOT / "standards", self.tmp / "standards"),
            (PROJECT_ROOT / "registry", self.tmp / "registry"),
            (PROJECT_ROOT / "scheduler" / "jobs", self.tmp / "scheduler" / "jobs"),
        ]:
            if src.is_dir():
                for item in src.iterdir():
                    if item.is_dir():
                        shutil.copytree(item, dst / item.name, dirs_exist_ok=True)
                    elif item.is_file():
                        shutil.copy2(item, dst / item.name)

    # ── lifecycle ─────────────────────────────────────────────
    def start(self):
        import uvicorn

        config = uvicorn.Config(
            server.app,
            host="127.0.0.1",
            port=self.port,
            log_level="warning",
        )
        self._uvicorn = uvicorn.Server(config)
        self._server_thread = threading.Thread(
            target=self._uvicorn.run, daemon=True
        )
        self._server_thread.start()
        self._wait_ready()

    def _wait_ready(self, timeout: float = 20.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                status, _ = self.request("GET", "/api/status")
                if status == 200:
                    return
            except Exception:
                pass
            time.sleep(0.2)
        raise RuntimeError("Server did not become ready in time")

    def stop(self):
        if self._uvicorn:
            self._uvicorn.should_exit = True
        if self._server_thread:
            self._server_thread.join(timeout=10)
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ── HTTP helper (stdlib only) ─────────────────────────────
    def request(self, method: str, path: str, body: dict = None,
                timeout: float = 15.0) -> tuple:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            self.base_url + path, data=data, method=method,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                return resp.status, raw
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def api(self, method: str, path: str, body: dict = None,
            timeout: float = 15.0) -> tuple:
        """Returns (status_code, parsed_json_or_raw_text)."""
        status, raw = self.request(method, path, body, timeout)
        try:
            parsed = json.loads(raw.decode("utf-8")) if raw else None
        except (json.JSONDecodeError, UnicodeDecodeError):
            parsed = raw.decode("utf-8", errors="replace") if raw else None
        return status, parsed

    # ── multipart upload helper (stdlib only) ──────────────────
    def upload(self, path: str, fields: dict, filename: str,
               content: bytes, timeout: float = 15.0) -> tuple:
        """POST multipart/form-data: returns (status, parsed_json_or_text)."""
        boundary = "----agenticostestboundary"
        body = b""
        for key, value in fields.items():
            body += (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="{key}"\r\n\r\n'
                f"{value}\r\n"
            ).encode()
        body += (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; '
            f'filename="{filename}"\r\n'
            "Content-Type: application/octet-stream\r\n\r\n"
        ).encode()
        body += content + b"\r\n"
        body += f"--{boundary}--\r\n".encode()

        req = urllib.request.Request(
            self.base_url + path,
            data=body,
            method="POST",
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                status = resp.status
        except urllib.error.HTTPError as e:
            status, raw = e.code, e.read()
        try:
            parsed = json.loads(raw.decode("utf-8")) if raw else None
        except (json.JSONDecodeError, UnicodeDecodeError):
            parsed = raw.decode("utf-8", errors="replace") if raw else None
        return status, parsed
