#!/usr/bin/env python3
"""
Integration abstraction layer for Agentic OS.

Design:
- Each adapter implements a tiny, uniform interface.
- The OS only talks to manager.run_pipeline(); it never calls
  adapter-specific endpoints directly.
- Adapters are optional. If a service is disabled or missing
  credentials, the manager records a skip/error and continues.

Adapter contract:
  create_project(name, description, **kwargs) -> dict with at least id/name
  update_project(external_id, updates) -> dict or None
  append_note(target_id, text) -> dict or None
  create_task(project_id, title, **kwargs) -> dict or None
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

# ---- config loader -----------------------------------------------------------

import json
import os
from pathlib import Path

INTEGRATIONS_DIR = Path(__file__).parent
CONFIG_FILE = INTEGRATIONS_DIR / "config.json"


def _load_json(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def load_integration_config() -> Dict[str, Any]:
    cfg = _load_json(CONFIG_FILE)
    return cfg


# ---- result helpers ----------------------------------------------------------

class Result:
    def __init__(self, ok: bool, data: Any = None, error: Optional[str] = None):
        self.ok = ok
        self.data = data
        self.error = error

    def to_dict(self) -> Dict[str, Any]:
        return {"ok": self.ok, "data": self.data, "error": self.error}


def _fail(error: str) -> Result:
    return Result(False, None, error)


def _ok(data: Any) -> Result:
    return Result(True, data, None)


# ---- adapter types -----------------------------------------------------------

class BaseAdapter:
    """Override only what this integration supports."""

    name: str = "base"

    def enabled(self, cfg: Dict[str, Any]) -> bool:
        return bool(cfg.get("enabled", False))

    def create_project(self, name: str, description: str = "", **kwargs: Any) -> Result:
        return _fail("not implemented")

    def update_project(self, external_id: str, updates: Dict[str, Any]) -> Result:
        return _fail("not implemented")

    def append_note(self, target_id: str, text: str) -> Result:
        return _fail("not implemented")

    def create_task(self, project_id: str, title: str, **kwargs: Any) -> Result:
        return _fail("not implemented")
