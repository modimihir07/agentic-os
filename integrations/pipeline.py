#!/usr/bin/env python3
"""
Abstraction Forge — local-first integration hub for Agentic OS.

Pipelines are stored as JSON state files so they survive restarts and do
not depend on any external service being reachable at load time.
"""

from __future__ import annotations

import copy
import json
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional


INTEGRATIONS_DIR = Path(__file__).parent
PIPELINES_FILE = INTEGRATIONS_DIR / "pipelines.json"
_local = threading.local()


def _timestamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _load_pipelines() -> Dict[str, Any]:
    if not PIPELINES_FILE.exists():
        return {"pipelines": {}}
    try:
        return json.loads(PIPELINES_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {"pipelines": {}}


def _save_pipelines(state: Dict[str, Any]) -> None:
    PIPELINES_FILE.write_text(json.dumps(state, indent=2, default=str), encoding="utf-8")


class Pipeline:
    def __init__(self, name: str, payload: Dict[str, Any]):
        self.name = name
        self.payload = copy.deepcopy(payload)
        self.created_at = _timestamp()
        self.updated_at = self.created_at
        self.status = "pending"
        self.results: Dict[str, Any] = {}
        self.error: Optional[str] = None


class PipelineManager:
    def __init__(self) -> None:
        PIPELINES_FILE.parent.mkdir(parents=True, exist_ok=True)
        _local.state = _load_pipelines()

    def save(self) -> None:
        _save_pipelines(_local.state)

    def create_pipeline(self, name: str, payload: Dict[str, Any]) -> Pipeline:
        p = Pipeline(name, payload)
        _local.state.setdefault("pipelines", {})[name] = {
            "name": name,
            "payload": p.payload,
            "created_at": p.created_at,
            "updated_at": p.updated_at,
            "status": p.status,
            "results": p.results,
            "error": p.error,
        }
        self.save()
        return p

    def list_pipelines(self) -> List[Dict[str, Any]]:
        return list(_local.state.get("pipelines", {}).values())

    def get_pipeline(self, name: str) -> Optional[Dict[str, Any]]:
        return _local.state.get("pipelines", {}).get(name)

    def record_result(self, name: str, adapter_name: str, result: Any) -> None:
        p = _local.state.setdefault("pipelines", {}).get(name)
        if not p:
            return
        p["results"][adapter_name] = result.to_dict()
        p["updated_at"] = _timestamp()
        self.save()
