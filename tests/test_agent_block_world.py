import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))


class CapabilityCatalogTests(unittest.TestCase):
    def test_fallback_capability_is_human_readable_and_conservative(self):
        from capability_catalog import enrich_capability

        capability = enrich_capability({
            "id": "research/arxiv",
            "name": "arxiv",
            "description": "Search and compare academic papers.",
            "category": "research",
            "source": "approved-local",
            "status": "available",
        })

        self.assertEqual(capability["intent_category"], "Descubrir")
        self.assertIn("evidencia", capability["superpower"].lower())
        self.assertIn("Aporta", capability["contribution"])
        self.assertEqual(capability["readiness"], "design_only")
        self.assertEqual(capability["side_effects"], "unknown")
        self.assertEqual(capability["inputs"][0]["type"], "any")
        self.assertEqual(capability["outputs"][0]["type"], "structured")
        self.assertNotIn("path", capability)

    def test_curated_capability_overrides_copy_but_not_identity(self):
        from capability_catalog import enrich_capability

        capability = enrich_capability({
            "id": "creative/storyteller",
            "name": "storyteller",
            "description": "Draft stories.",
            "category": "creative",
            "source": "approved-local",
            "status": "available",
        }, {
            "name": "Narrador visual",
            "superpower": "Convierte ideas en historias claras y memorables.",
            "contribution": "Aporta una narrativa coherente al agente.",
            "side_effects": "none",
            "workflow_steps": ["Entender", "Estructurar", "Redactar", "Revisar"],
            "inputs": [{"id": "idea", "label": "Idea", "type": "text"}],
            "outputs": [{"id": "story", "label": "Historia", "type": "text"}],
        })

        self.assertEqual(capability["id"], "creative/storyteller")
        self.assertEqual(capability["source"], "approved-local")
        self.assertEqual(capability["name"], "Narrador visual")
        self.assertEqual(capability["side_effects"], "none")
        self.assertEqual(len(capability["workflow_steps"]), 4)

    def test_curated_catalog_file_has_only_governed_fields(self):
        from capability_catalog import load_curated_catalog

        catalog = load_curated_catalog(ROOT / "dashboard" / "data" / "skill-capabilities.json")
        self.assertGreaterEqual(len(catalog), 5)
        for skill_id, item in catalog.items():
            self.assertRegex(skill_id, r"^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$")
            self.assertNotIn("path", item)
            self.assertNotIn("token", json.dumps(item).lower())
            self.assertNotIn("password", json.dumps(item).lower())


class PowerMapTests(unittest.TestCase):
    def setUp(self):
        from capability_catalog import enrich_capability

        self.capabilities = {
            "research/scout": enrich_capability({
                "id": "research/scout", "name": "Scout",
                "description": "Find evidence.", "category": "research",
                "source": "approved-local", "status": "available",
            }, {
                "readiness": "ready",
                "inputs": [{"id": "question", "label": "Pregunta", "type": "research_query"}],
                "outputs": [{"id": "evidence", "label": "Evidencia", "type": "structured"}],
            }),
            "creative/writer": enrich_capability({
                "id": "creative/writer", "name": "Writer",
                "description": "Write a clear answer.", "category": "creative",
                "source": "approved-local", "status": "available",
            }, {
                "readiness": "ready",
                "inputs": [{"id": "context", "label": "Contexto", "type": "structured"}],
                "outputs": [{"id": "draft", "label": "Borrador", "type": "text"}],
            }),
        }

    def test_valid_power_map_is_design_only_and_has_readiness(self):
        from power_map import validate_power_map

        result = validate_power_map({
            "version": 1,
            "nodes": [
                {"id": "n1", "capability_id": "research/scout", "x": 100, "y": 120},
                {"id": "n2", "capability_id": "creative/writer", "x": 420, "y": 120},
            ],
            "edges": [
                {"id": "e1", "source": "n1", "source_port": "evidence", "target": "n2", "target_port": "context"},
            ],
        }, self.capabilities, ["research/scout", "creative/writer"])

        self.assertFalse(result["executable"])
        self.assertEqual(result["map"]["version"], 1)
        self.assertEqual(result["readiness_percent"], 100)
        self.assertEqual(result["warnings"], [])

    def test_incompatible_edge_is_rejected_with_explanation(self):
        from power_map import PowerMapError, validate_power_map

        invalid = {
            "version": 1,
            "nodes": [
                {"id": "n1", "capability_id": "creative/writer", "x": 100, "y": 120},
                {"id": "n2", "capability_id": "research/scout", "x": 420, "y": 120},
            ],
            "edges": [
                {"id": "e1", "source": "n1", "source_port": "draft", "target": "n2", "target_port": "question"},
            ],
        }
        with self.assertRaisesRegex(PowerMapError, "compatible"):
            validate_power_map(invalid, self.capabilities, list(self.capabilities))

    def test_design_only_block_never_counts_as_runtime_ready(self):
        from power_map import validate_power_map

        capabilities = dict(self.capabilities)
        capabilities["research/scout"] = {**capabilities["research/scout"], "readiness": "design_only"}
        result = validate_power_map({
            "version": 1,
            "nodes": [{"id": "n1", "capability_id": "research/scout", "x": 10, "y": 20}],
            "edges": [],
        }, capabilities, ["research/scout"])

        self.assertEqual(result["readiness"], {"ready": 0, "total": 1})
        self.assertEqual(result["readiness_percent"], 0)
        self.assertIn("no demuestran ejecución automática", " ".join(result["warnings"]))

    def test_unknown_capability_and_oversized_map_are_rejected(self):
        from power_map import PowerMapError, validate_power_map

        with self.assertRaises(PowerMapError):
            validate_power_map({
                "version": 1,
                "nodes": [{"id": "n1", "capability_id": "unknown/x", "x": 0, "y": 0}],
                "edges": [],
            }, self.capabilities, [])

        with self.assertRaises(PowerMapError):
            validate_power_map({
                "version": 1,
                "nodes": [
                    {"id": f"n{i}", "capability_id": "research/scout", "x": i, "y": i}
                    for i in range(41)
                ],
                "edges": [],
            }, self.capabilities, ["research/scout"])


class EvolutionModeFrontendTests(unittest.TestCase):
    def test_frontend_exposes_block_world_evolution_mode(self):
        profiles = (ROOT / "dashboard" / "pages" / "profiles.js").read_text()
        power_map = ROOT / "dashboard" / "pages" / "profile-power-map.js"
        index = (ROOT / "dashboard" / "index.html").read_text()
        app = (ROOT / "dashboard" / "app.js").read_text()

        self.assertTrue(power_map.is_file())
        power_source = power_map.read_text()
        for marker in (
            "enterEvolutionMode", "renderEvolutionWorkbench", "renderCapabilityPalette",
            "renderPowerMapInspector", "Power Map", "Mapa de capacidades · no ejecuta acciones",
            "Blueprint sin aplicar", "Superpoder", "Aporta al agente",
        ):
            self.assertIn(marker, profiles + power_source)
        self.assertIn("profile-power-map.js", index)
        self.assertIn("const APP_VERSION = '0.7.4';", app)
        self.assertNotIn("slice(0, 30)", profiles)
        self.assertIn('profileState.removeSkills = new Set();', profiles)
        self.assertIn('aria-label="Buscar superpoderes por resultado"', profiles)
        self.assertIn("ProfilePowerMap.keyboardNodeActivation(event)", profiles)

    def test_power_map_keyboard_activation_ignores_nested_controls(self):
        helper = ROOT / "dashboard" / "pages" / "profile-power-map.js"
        script = f"""
global.window = {{}};
require({json.dumps(str(helper))});
const activate = window.ProfilePowerMap.keyboardNodeActivation;
function target(nodeId, interactive) {{
  return {{ closest(selector) {{
    if (selector === 'button, a, input, select, textarea') return interactive ? {{}} : null;
    if (selector === '[data-power-node]') return nodeId ? {{ dataset: {{ powerNode: nodeId }} }} : null;
    return null;
  }} }};
}}
if (activate({{ key: 'Enter', target: target('cap/a', true) }}) !== null) process.exit(1);
if (activate({{ key: ' ', target: target('cap/a', true) }}) !== null) process.exit(2);
if (activate({{ key: 'Enter', target: target('cap/a', false) }}) !== 'cap/a') process.exit(3);
if (activate({{ key: ' ', target: target('cap/a', false) }}) !== 'cap/a') process.exit(4);
if (activate({{ key: 'Tab', target: target('cap/a', false) }}) !== null) process.exit(5);
"""
        subprocess.run(["node", "-e", script], check=True)


if __name__ == "__main__":
    unittest.main()
