import json
import os
import shutil
import stat
import sys
import urllib.error
import urllib.request
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import Harness


class AgentPlaygroundTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.h = Harness()
        cls.addClassCleanup(cls.h.stop)
        cls.hermes_home = cls.h.tmp / "hermes-home"
        (cls.hermes_home / "profiles").mkdir(parents=True)
        (cls.hermes_home / "profile.yaml").write_text("name: default\ndescription: Test default\n")
        cls.catalog = cls.h.tmp / "approved-skills"
        for skill_id, description in (
            ("research/scout", "Find and compare evidence."),
            ("software-development/builder", "Build and verify software."),
            ("creative/storyteller", "Turn ideas into clear stories."),
            ("productivity/operator", "Coordinate repeatable work."),
        ):
            folder = cls.catalog / skill_id
            folder.mkdir(parents=True)
            (folder / "SKILL.md").write_text(
                f"---\nname: {Path(skill_id).name}\ndescription: {description}\n---\n# Skill\n"
            )
        cls.fake_cli = cls.h.tmp / "fake-hermes"
        cls.fake_cli.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, pathlib, shutil, sys\n"
            "args=sys.argv[1:]; root=pathlib.Path(os.environ['HERMES_HOME'])\n"
            "log=pathlib.Path(os.environ['FAKE_HERMES_LOG']); log.parent.mkdir(parents=True, exist_ok=True)\n"
            "with log.open('a') as h: h.write(json.dumps(args)+'\\n')\n"
            "if args[0]=='-p':\n"
            " assert args[2:]==['gateway','stop']; sys.exit(0)\n"
            "assert args[0]=='profile'\n"
            "action=args[1]\n"
            "def home(name): return root if name=='default' else root/'profiles'/name\n"
            "if action=='create':\n"
            " name=args[2]; target=home(name); target.mkdir(parents=True)\n"
            " desc=args[args.index('--description')+1] if '--description' in args else ''\n"
            " (target/'profile.yaml').write_text('name: '+name+'\\ndescription: '+json.dumps(desc)+'\\n')\n"
            " (target/'.env').write_text('OPENAI_API_KEY=test-placeholder-key\\n')\n"
            "elif action=='show':\n"
            " name=args[2]; target=home(name)\n"
            " if not target.is_dir(): sys.exit(2)\n"
            " count=len(list((target/'skills').rglob('SKILL.md'))) if (target/'skills').is_dir() else 0\n"
            " print('Profile: '+name); print('Model:   —'); print('Gateway: stopped'); print('Skills:  '+str(count)); print('Alias:   —')\n"
            "elif action=='delete':\n"
            " name=args[2]\n"
            " if name.startswith('delete-fails'): sys.exit(9)\n"
            " shutil.rmtree(home(name))\n"
            "elif action=='describe':\n"
            " name=args[2]; desc=args[args.index('--text')+1]; p=home(name)/'profile.yaml'\n"
            " p.write_text('name: '+name+'\\ndescription: '+json.dumps(desc)+'\\n')\n"
            "else: sys.exit(3)\n"
        )
        cls.fake_cli.chmod(0o700)
        os.environ.update({
            "AGENTIC_OS_ADMIN_TOKEN": "playground-test-token",
            "AGENTIC_OS_HERMES_HOME": str(cls.hermes_home),
            "AGENTIC_OS_HERMES_BIN": str(cls.fake_cli),
            "AGENTIC_OS_HERMES_PROFILE": "agentic-os",
            "AGENTIC_OS_SKILL_CATALOG": str(cls.catalog),
            "AGENTIC_OS_HERMES_BACKUP_DIR": str(cls.h.tmp / "backups"),
            "AGENTIC_OS_AUDIT_FILE": str(cls.h.tmp / "audit" / "profiles.jsonl"),
            "FAKE_HERMES_LOG": str(cls.h.tmp / "fake-hermes.jsonl"),
        })
        cls.h.start()

    def request(self, method, path, body=None, admin=True):
        headers = {"Content-Type": "application/json"}
        if admin:
            headers["X-Agentic-OS-Admin"] = "playground-test-token"
        request = urllib.request.Request(
            self.h.base_url + path,
            data=json.dumps(body).encode() if body is not None else None,
            method=method,
            headers=headers,
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.status, json.loads(response.read() or b"null")
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read() or b"null")

    def valid_draft(self, name="luma-agent"):
        return {
            "name": name,
            "display_name": "Luma",
            "archetype": "explorer",
            "appearance": {
                "base": "orb", "primary_color": "violet",
                "face": "curious", "accessory": "visor", "biome": "library",
            },
            "communication": {
                "detail": "balanced", "tone": "warm", "initiative": "ask-first",
            },
            "mission": "Investigar oportunidades y convertir evidencia en decisiones claras.",
            "boundaries": ["No publicar ni enviar nada sin aprobación"],
            "equipped_skills": ["research/scout"],
        }

    def test_catalog_is_admin_only_and_sanitized(self):
        status, _ = self.request("GET", "/api/playground/catalog", admin=False)
        self.assertEqual(status, 401)
        status, catalog = self.request("GET", "/api/playground/catalog")
        self.assertEqual(status, 200)
        self.assertEqual(len(catalog["archetypes"]), 5)
        self.assertEqual({item["id"] for item in catalog["skills"]}, {
            "research/scout", "software-development/builder",
            "creative/storyteller", "productivity/operator",
        })
        serialized = json.dumps(catalog)
        self.assertNotIn(str(self.h.tmp), serialized)
        self.assertNotIn("SKILL.md", serialized)
        self.assertNotIn(".env", serialized)

    def test_preview_validates_without_writing_profile(self):
        draft = self.valid_draft("preview-only-agent")
        status, preview = self.request("POST", "/api/playground/preview", draft)
        self.assertEqual(status, 200)
        self.assertEqual(preview["agent_card"]["name"], "preview-only-agent")
        self.assertIn("# Identidad", preview["soul_preview"])
        self.assertIn("No publicar", preview["soul_preview"])
        self.assertFalse((self.hermes_home / "profiles" / "preview-only-agent").exists())

    def test_preview_rejects_unknown_or_excess_skills(self):
        draft = self.valid_draft()
        draft["equipped_skills"] = ["research/scout", "creative/storyteller", "productivity/operator", "software-development/builder"]
        self.assertEqual(self.request("POST", "/api/playground/preview", draft)[0], 400)
        draft["equipped_skills"] = ["research/not-real"]
        self.assertEqual(self.request("POST", "/api/playground/preview", draft)[0], 400)

    def test_spawn_creates_isolated_profile_and_room(self):
        name = "spawned-luma"
        target = self.hermes_home / "profiles" / name
        shutil.rmtree(target, ignore_errors=True)
        self.addCleanup(shutil.rmtree, target, True)
        status, room = self.request("POST", "/api/playground/spawn", self.valid_draft(name))
        self.assertEqual(status, 200)
        self.assertEqual(room["agent"]["name"], name)
        self.assertTrue((target / "SOUL.md").is_file())
        metadata = target / ".agent-playground" / "avatar.json"
        self.assertTrue(metadata.is_file())
        self.assertEqual(stat.S_IMODE(metadata.stat().st_mode), 0o600)
        self.assertTrue((target / "skills" / "research" / "scout" / "SKILL.md").is_file())
        self.assertFalse((target / ".env").exists())
        self.assertFalse((target / "cron").exists())
        self.assertFalse((target / "plugins").exists())
        self.assertEqual(room["agent"]["gateway"], "stopped")
        calls = [json.loads(line) for line in Path(os.environ["FAKE_HERMES_LOG"]).read_text().splitlines()]
        self.assertIn(["-p", name, "gateway", "stop"], calls)

        status, fetched = self.request("GET", f"/api/playground/agents/{name}")
        self.assertEqual(status, 200)
        self.assertEqual(fetched["metadata"]["display_name"], "Luma")

    def test_sensitive_skill_file_is_rejected_and_manual_rollback_is_verified(self):
        source = self.catalog / "research" / "leaky"
        (source / "scripts").mkdir(parents=True)
        (source / "SKILL.md").write_text("---\nname: leaky\ndescription: Unsafe fixture.\n---\n")
        (source / "scripts" / ".env").write_text("REAL_TOKEN=do-not-copy\n")
        self.addCleanup(shutil.rmtree, source, True)
        name = "delete-fails-leaky"
        target = self.hermes_home / "profiles" / name
        draft = self.valid_draft(name)
        draft["equipped_skills"] = ["research/leaky"]
        status, response = self.request("POST", "/api/playground/spawn", draft)
        self.assertEqual(status, 502)
        self.assertFalse(target.exists())
        self.assertIn("rolled back", response["detail"].lower())

    def test_provider_secret_after_128k_is_rejected(self):
        source = self.catalog / "research" / "deep-leaky"
        (source / "references").mkdir(parents=True)
        (source / "SKILL.md").write_text("---\nname: deep-leaky\ndescription: Unsafe deep fixture.\n---\n")
        (source / "references" / "large.txt").write_bytes(
            b"A" * 150_000 + b"\nOPENAI_API_KEY=sk-real-looking-secret-value-123456\n"
        )
        self.addCleanup(shutil.rmtree, source, True)
        name = "deep-secret-agent"
        target = self.hermes_home / "profiles" / name
        draft = self.valid_draft(name)
        draft["equipped_skills"] = ["research/deep-leaky"]
        status, response = self.request("POST", "/api/playground/spawn", draft)
        self.assertEqual(status, 502)
        self.assertFalse(target.exists())
        self.assertIn("rolled back", response["detail"].lower())

    def test_json_provider_secret_is_rejected(self):
        source = self.catalog / "research" / "json-leaky"
        (source / "references").mkdir(parents=True)
        (source / "SKILL.md").write_text("---\nname: json-leaky\ndescription: Unsafe JSON fixture.\n---\n")
        (source / "references" / "config.json").write_text(
            '{"OPENAI_API_KEY": "sk_live_json_secret_1234567890"}\n'
        )
        self.addCleanup(shutil.rmtree, source, True)
        name = "json-secret-agent"
        target = self.hermes_home / "profiles" / name
        draft = self.valid_draft(name)
        draft["equipped_skills"] = ["research/json-leaky"]
        status, response = self.request("POST", "/api/playground/spawn", draft)
        self.assertEqual(status, 502)
        self.assertFalse(target.exists())
        self.assertIn("rolled back", response["detail"].lower())

    def test_appearance_update_is_allowlisted(self):
        name = "appearance-agent"
        target = self.hermes_home / "profiles" / name
        shutil.rmtree(target, ignore_errors=True)
        self.addCleanup(shutil.rmtree, target, True)
        self.assertEqual(self.request("POST", "/api/playground/spawn", self.valid_draft(name))[0], 200)
        status, room = self.request("PATCH", f"/api/playground/agents/{name}/appearance", {
            "base": "bot", "primary_color": "coral", "face": "focused",
            "accessory": "antenna", "biome": "workshop",
        })
        self.assertEqual(status, 200)
        self.assertEqual(room["metadata"]["appearance"]["base"], "bot")
        self.assertEqual(self.request("PATCH", f"/api/playground/agents/{name}/appearance", {
            "base": "../../escape", "primary_color": "coral", "face": "focused",
            "accessory": "antenna", "biome": "workshop",
        })[0], 400)
    def test_frontend_exposes_five_step_playground(self):
        index = (Path(__file__).parents[1] / "dashboard" / "index.html").read_text()
        script_path = Path(__file__).parents[1] / "dashboard" / "pages" / "agent-playground.js"
        self.assertIn('href="#agent-playground"', index)
        self.assertTrue(script_path.is_file())
        script = script_path.read_text()
        for marker in (
            "renderAgentPlayground", "renderAvatarBuilder", "renderPurposeStep",
            "renderArchetypeStep", "renderSkillStoreStep", "renderAgentReview",
            "renderAgentRoom", "renderAvatarSvg",
        ):
            self.assertIn(marker, script)
        self.assertIn("api.previewPlaygroundAgent", script)
        self.assertIn("api.spawnPlaygroundAgent", script)


if __name__ == "__main__":
    unittest.main()
