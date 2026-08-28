"""Validated explanatory capability maps for Agent Studio.

These maps describe composition only. They never execute skills.
"""
from __future__ import annotations

import json
import math
import re
from typing import Any

_ID_RE = re.compile(r"[A-Za-z0-9._-]{1,80}")
_MAX_BYTES = 100_000
_MAX_NODES = 40
_MAX_EDGES = 80


class PowerMapError(ValueError):
    """Raised when a capability map cannot be represented safely."""


def ports_compatible(source_type: str, target_type: str) -> bool:
    """Conservative local compatibility resolver shared by validation and UI."""
    return source_type == target_type or source_type == "any" or target_type == "any"


def _node(raw: Any, capabilities: dict[str, dict[str, Any]]) -> dict[str, Any]:
    if not isinstance(raw, dict) or set(raw) != {"id", "capability_id", "x", "y"}:
        raise PowerMapError("Invalid Power Map node")
    node_id = raw.get("id")
    capability_id = raw.get("capability_id")
    if not isinstance(node_id, str) or not _ID_RE.fullmatch(node_id):
        raise PowerMapError("Invalid Power Map node ID")
    if not isinstance(capability_id, str) or capability_id not in capabilities:
        raise PowerMapError("Unknown capability in Power Map")
    coordinates = []
    for field in ("x", "y"):
        value = raw.get(field)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise PowerMapError("Invalid Power Map coordinates")
        if not -10_000 <= float(value) <= 10_000:
            raise PowerMapError("Power Map coordinates are out of bounds")
        coordinates.append(round(float(value), 2))
    return {"id": node_id, "capability_id": capability_id, "x": coordinates[0], "y": coordinates[1]}


def _edge(raw: Any) -> dict[str, str]:
    allowed = {"id", "source", "source_port", "target", "target_port"}
    if not isinstance(raw, dict) or set(raw) != allowed:
        raise PowerMapError("Invalid Power Map edge")
    result: dict[str, str] = {}
    for field in allowed:
        value = raw.get(field)
        if not isinstance(value, str) or not _ID_RE.fullmatch(value):
            raise PowerMapError("Invalid Power Map edge")
        result[field] = value
    if result["source"] == result["target"]:
        raise PowerMapError("Power Map self-connections are not allowed")
    return result


def _port(capability: dict[str, Any], direction: str, port_id: str) -> dict[str, str] | None:
    return next((item for item in capability.get(direction, []) if item.get("id") == port_id), None)


def _has_cycle(nodes: list[dict[str, Any]], edges: list[dict[str, str]]) -> bool:
    outgoing: dict[str, list[str]] = {node["id"]: [] for node in nodes}
    indegree = {node["id"]: 0 for node in nodes}
    for edge in edges:
        outgoing[edge["source"]].append(edge["target"])
        indegree[edge["target"]] += 1
    queue = [node_id for node_id, degree in indegree.items() if degree == 0]
    visited = 0
    while queue:
        current = queue.pop()
        visited += 1
        for target in outgoing[current]:
            indegree[target] -= 1
            if indegree[target] == 0:
                queue.append(target)
    return visited != len(nodes)


def validate_power_map(
    value: Any,
    capabilities: dict[str, dict[str, Any]],
    loadout: list[str],
) -> dict[str, Any]:
    """Validate and normalize a bounded, design-only capability map."""
    try:
        encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise PowerMapError("Invalid Power Map payload") from exc
    if len(encoded) > _MAX_BYTES:
        raise PowerMapError("Power Map payload is too large")
    if not isinstance(value, dict) or set(value) != {"version", "nodes", "edges"} or value.get("version") != 1:
        raise PowerMapError("Invalid Power Map schema")
    if not isinstance(value.get("nodes"), list) or len(value["nodes"]) > _MAX_NODES:
        raise PowerMapError("Power Map has too many nodes")
    if not isinstance(value.get("edges"), list) or len(value["edges"]) > _MAX_EDGES:
        raise PowerMapError("Power Map has too many edges")
    if not isinstance(loadout, list) or len(loadout) > 5 or len(set(loadout)) != len(loadout):
        raise PowerMapError("Invalid capability loadout")
    if any(not isinstance(item, str) or item not in capabilities for item in loadout):
        raise PowerMapError("Unknown capability in loadout")

    nodes = [_node(item, capabilities) for item in value["nodes"]]
    if len({item["id"] for item in nodes}) != len(nodes):
        raise PowerMapError("Duplicate Power Map node ID")
    edges = [_edge(item) for item in value["edges"]]
    if len({item["id"] for item in edges}) != len(edges):
        raise PowerMapError("Duplicate Power Map edge ID")
    node_map = {item["id"]: item for item in nodes}
    for edge in edges:
        if edge["source"] not in node_map or edge["target"] not in node_map:
            raise PowerMapError("Power Map edge references a missing node")
        source_capability = capabilities[node_map[edge["source"]]["capability_id"]]
        target_capability = capabilities[node_map[edge["target"]]["capability_id"]]
        source_port = _port(source_capability, "outputs", edge["source_port"])
        target_port = _port(target_capability, "inputs", edge["target_port"])
        if source_port is None or target_port is None:
            raise PowerMapError("Power Map edge references an unknown port")
        if not ports_compatible(source_port["type"], target_port["type"]):
            raise PowerMapError(
                f"Ports are not compatible: {source_port['type']} cannot connect to {target_port['type']}"
            )
    if _has_cycle(nodes, edges):
        raise PowerMapError("Power Map cycles are not supported in design mode")

    warnings: list[str] = []
    mapped = {node["capability_id"] for node in nodes}
    missing = [item for item in loadout if item not in mapped]
    if missing:
        warnings.append("Hay superpoderes equipados que todavía no aparecen en el mapa.")
    states = {item: capabilities[item].get("readiness", capabilities[item].get("status", "design_only")) for item in loadout}
    pending = [item for item, state in states.items() if state == "requires_setup"]
    design_only = [item for item, state in states.items() if state == "design_only"]
    available = [item for item, state in states.items() if state == "available"]
    if pending:
        warnings.append("Algunos superpoderes requieren configuración externa antes de usarse.")
    if design_only:
        warnings.append("Algunos bloques describen un procedimiento, pero no demuestran ejecución automática.")
    if available:
        warnings.append("Algunos bloques están disponibles, pero todavía requieren una prueba antes de considerarse listos.")
    ready_count = sum(state == "ready" for state in states.values())
    readiness_percent = 100 if not loadout else round(100 * ready_count / len(loadout))
    return {
        "map": {"version": 1, "nodes": nodes, "edges": edges},
        "loadout": list(loadout),
        "warnings": warnings,
        "readiness": {"ready": ready_count, "total": len(loadout)},
        "readiness_percent": readiness_percent,
        "executable": False,
        "execution_reason": "Mapa explicativo: las skills procedurales no se ejecutan automáticamente.",
    }


def empty_power_map() -> dict[str, Any]:
    return {"version": 1, "nodes": [], "edges": []}


def composition_templates() -> list[dict[str, Any]]:
    """Human-oriented blueprints. Matching is by intent category at runtime."""
    return [
        {"id": "research-decide", "name": "Investigar y decidir", "icon": "🔎", "intents": ["Descubrir", "Pensar", "Proteger"]},
        {"id": "create-approve", "name": "Crear y publicar con aprobación", "icon": "🎨", "intents": ["Crear", "Proteger", "Comunicar"]},
        {"id": "repeatable-ops", "name": "Operar un proceso repetible", "icon": "⚙️", "intents": ["Organizar", "Pensar", "Proteger"]},
        {"id": "analyze-report", "name": "Analizar y reportar", "icon": "📊", "intents": ["Descubrir", "Pensar", "Comunicar"]},
        {"id": "sales-support", "name": "Preparar y apoyar ventas", "icon": "🤝", "intents": ["Descubrir", "Pensar", "Comunicar", "Proteger"]},
    ]
