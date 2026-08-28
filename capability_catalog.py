"""Governed, human-readable capability metadata for Agent Studio."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

_ID_RE = re.compile(r"[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*")
_ALLOWED_SIDE_EFFECTS = {"none", "read", "write", "send", "publish", "delete", "unknown"}
_ALLOWED_FIELDS = {
    "name", "icon", "intent_category", "superpower", "contribution", "use_when",
    "inputs", "outputs", "workflow_steps", "requirements", "side_effects",
    "readiness", "readiness_reason",
}
_INTENT_BY_CATEGORY = {
    "research": ("Descubrir", "🔎"),
    "media": ("Crear", "🎬"),
    "creative": ("Crear", "🎨"),
    "software-development": ("Crear", "🧱"),
    "github": ("Crear", "🧩"),
    "mlops": ("Pensar", "📊"),
    "position-sizing": ("Pensar", "📐"),
    "earnings-preview": ("Pensar", "📈"),
    "pre-trade-check": ("Proteger", "🛡️"),
    "governance": ("Proteger", "🛡️"),
    "devops": ("Organizar", "⚙️"),
    "productivity": ("Organizar", "📋"),
    "email": ("Comunicar", "✉️"),
    "social-media": ("Comunicar", "📣"),
    "autonomous-ai-agents": ("Organizar", "🧠"),
}


class CapabilityCatalogError(ValueError):
    """Raised when curated capability metadata is unsafe or malformed."""


def _plain(value: Any, fallback: str, maximum: int = 500) -> str:
    if not isinstance(value, str):
        return fallback
    cleaned = " ".join(value.replace("\r", " ").replace("\n", " ").split()).strip()
    if not cleaned or any(ord(character) < 32 for character in cleaned):
        return fallback
    return cleaned[:maximum]


def _string_list(value: Any, fallback: list[str], maximum_items: int = 8) -> list[str]:
    if not isinstance(value, list):
        return list(fallback)
    result = [_plain(item, "", 160) for item in value[:maximum_items]]
    return [item for item in result if item] or list(fallback)


def _ports(value: Any, fallback: list[dict[str, str]]) -> list[dict[str, str]]:
    if not isinstance(value, list) or not value:
        return [dict(item) for item in fallback]
    result = []
    for raw in value[:8]:
        if not isinstance(raw, dict) or set(raw) != {"id", "label", "type"}:
            return [dict(item) for item in fallback]
        port_id = _plain(raw.get("id"), "", 64)
        label = _plain(raw.get("label"), "", 80)
        port_type = _plain(raw.get("type"), "", 64)
        if not re.fullmatch(r"[A-Za-z0-9._-]+", port_id) or not re.fullmatch(r"[A-Za-z0-9._-]+", port_type) or not label:
            return [dict(item) for item in fallback]
        result.append({"id": port_id, "label": label, "type": port_type})
    return result


def load_curated_catalog(path: Path) -> dict[str, dict[str, Any]]:
    """Load a bounded JSON catalog without accepting arbitrary fields."""
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 250_000:
            raise CapabilityCatalogError("Curated capability catalog is unavailable")
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CapabilityCatalogError("Invalid curated capability catalog") from exc
    if not isinstance(raw, dict) or len(raw) > 500:
        raise CapabilityCatalogError("Invalid curated capability catalog")
    result: dict[str, dict[str, Any]] = {}
    for skill_id, item in raw.items():
        if not isinstance(skill_id, str) or not _ID_RE.fullmatch(skill_id) or not isinstance(item, dict):
            raise CapabilityCatalogError("Invalid curated capability entry")
        if not set(item).issubset(_ALLOWED_FIELDS):
            raise CapabilityCatalogError("Unknown curated capability field")
        result[skill_id] = dict(item)
    return result


def enrich_capability(skill: dict[str, Any], curated: dict[str, Any] | None = None) -> dict[str, Any]:
    """Turn technical skill inventory into a conservative capability block."""
    curated = curated or {}
    skill_id = _plain(skill.get("id"), "", 190)
    if not _ID_RE.fullmatch(skill_id):
        raise CapabilityCatalogError("Invalid skill identity")
    category = _plain(skill.get("category"), skill_id.split("/", 1)[0], 80)
    intent, default_icon = _INTENT_BY_CATEGORY.get(category, ("Organizar", "🧩"))
    description = _plain(skill.get("description"), "Procedimiento aprobado del catálogo local.", 500)
    name = _plain(curated.get("name"), _plain(skill.get("name"), skill_id.rsplit("/", 1)[-1], 120), 120)
    if intent == "Descubrir":
        default_superpower = f"Encuentra y organiza evidencia para: {description.rstrip('.')}"
        default_contribution = "Aporta evidencia trazable para que el agente decida con mejor fundamento."
    elif intent == "Pensar":
        default_superpower = f"Analiza información y la convierte en una conclusión útil: {description.rstrip('.')}"
        default_contribution = "Aporta estructura y criterio para convertir información en decisiones."
    elif intent == "Crear":
        default_superpower = f"Convierte una intención en un artefacto revisable: {description.rstrip('.')}"
        default_contribution = "Aporta capacidad de construcción con un resultado que puede verificarse."
    elif intent == "Comunicar":
        default_superpower = f"Prepara comunicación clara y gobernada: {description.rstrip('.')}"
        default_contribution = "Aporta una salida comprensible; cualquier envío sigue sujeto a aprobación."
    elif intent == "Proteger":
        default_superpower = f"Revisa riesgos y condiciones antes de avanzar: {description.rstrip('.')}"
        default_contribution = "Aporta un punto de control para reducir errores y acciones no autorizadas."
    else:
        default_superpower = f"Organiza un procedimiento reutilizable: {description.rstrip('.')}"
        default_contribution = "Aporta un bloque de trabajo repetible al perfil del agente."

    side_effects = _plain(curated.get("side_effects"), "unknown", 20)
    if side_effects not in _ALLOWED_SIDE_EFFECTS:
        side_effects = "unknown"
    readiness = _plain(curated.get("readiness"), "design_only", 30)
    if readiness not in {"ready", "available", "requires_setup", "design_only"}:
        readiness = "design_only"

    return {
        "id": skill_id,
        "name": name,
        "description": description,
        "category": category,
        "intent_category": _plain(curated.get("intent_category"), intent, 40),
        "icon": _plain(curated.get("icon"), default_icon, 8),
        "superpower": _plain(curated.get("superpower"), default_superpower, 500),
        "contribution": _plain(curated.get("contribution"), default_contribution, 500),
        "use_when": _string_list(curated.get("use_when"), ["Cuando este procedimiento ayude al objetivo actual"]),
        "inputs": _ports(curated.get("inputs"), [{"id": "input", "label": "Contexto", "type": "any"}]),
        "outputs": _ports(curated.get("outputs"), [{"id": "output", "label": "Resultado estructurado", "type": "structured"}]),
        "workflow_steps": _string_list(curated.get("workflow_steps"), ["Entender", "Procesar", "Verificar", "Entregar"]),
        "requirements": _string_list(curated.get("requirements"), ["Revisión humana del resultado"]),
        "side_effects": side_effects,
        "readiness": readiness,
        "readiness_reason": _plain(curated.get("readiness_reason"), "Bloque de diseño; la presencia de SKILL.md no demuestra ejecución automática.", 300),
        "source": _plain(skill.get("source"), "approved-local", 50),
        "status": _plain(skill.get("status"), "available", 30),
        "studio_mutable": bool(skill.get("studio_mutable", True)),
    }


def enrich_catalog(skills: list[dict[str, Any]], curated: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    return [enrich_capability(skill, curated.get(str(skill.get("id")), {})) for skill in skills]
