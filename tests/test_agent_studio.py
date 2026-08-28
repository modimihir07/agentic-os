import json
import os
import shutil
import stat
import sys
import tarfile
import tempfile
import urllib.error
import urllib.request
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import Harness


class AgentStudioTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.h = Harness()
        cls.addClassCleanup(cls.h.stop)
        cls.hermes_home = cls.h.tmp / "studio-hermes"
        cls.profiles = cls.hermes_home / "profiles"
        cls.profiles.mkdir(parents=True)
        (cls.hermes_home / "profile.yaml").write_text("name: default\ndescription: Protected default\n")
        (cls.hermes_home / "SOUL.md").write_text("# Default\n")

        cls.target = cls.profiles / "studio-agent"
        (cls.target / "skills" / "research" / "old-skill").mkdir(parents=True)
        (cls.target / "profile.yaml").write_text("name: studio-agent\ndescription: Studio fixture\n")
        (cls.target / "SOUL.md").write_text("# Studio Agent\n\nOriginal identity.\n")
        (cls.target / "skills" / "research" / "old-skill" / "SKILL.md").write_text(
            "---\nname: old-skill\ndescription: Existing workflow.\n---\n# Old skill\n"
        )

        cls.catalog = cls.h.tmp / "studio-catalog"
        new_skill = cls.catalog / "research" / "new-skill"
        new_skill.mkdir(parents=True)
        (new_skill / "SKILL.md").write_text(
            "---\nname: new-skill\ndescription: Approved replacement workflow.\n---\n# New skill\n"
        )
        root_skill = cls.catalog / "team"
        root_skill.mkdir(parents=True)
        (root_skill / "SKILL.md").write_text(
            "---\nname: team\ndescription: Conflicts with an existing skill namespace.\n---\n# Team skill\n"
        )

        cls.fake_cli = cls.h.tmp / "studio-hermes-cli"
        cls.fake_cli.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, pathlib, sys, tarfile\n"
            "args=sys.argv[1:]; root=pathlib.Path(os.environ['HERMES_HOME'])\n"
            "log=pathlib.Path(os.environ['STUDIO_CLI_LOG'])\n"
            "with log.open('a') as h: h.write(json.dumps(args)+'\\n')\n"
            "assert args[0]=='profile'\n"
            "action=args[1]; name=args[2]; home=root if name=='default' else root/'profiles'/name\n"
            "if action=='show':\n"
            " count=len(list((home/'skills').rglob('SKILL.md'))) if (home/'skills').is_dir() else 0\n"
            " print('Profile: '+name); print('Model: test-model (test-provider)'); print('Gateway: stopped'); print('Skills: '+str(count)); print('Alias: —')\n"
            "elif action=='export':\n"
            " out=pathlib.Path(args[args.index('--output')+1]); out.parent.mkdir(parents=True, exist_ok=True)\n"
            " with tarfile.open(out, 'w:gz') as archive: archive.add(home, arcname=name)\n"
            "else: sys.exit(3)\n"
        )
        cls.fake_cli.chmod(0o700)
        os.environ.update({
            "AGENTIC_OS_ADMIN_TOKEN": "studio-test-token",
            "AGENTIC_OS_HERMES_HOME": str(cls.hermes_home),
            "AGENTIC_OS_HERMES_BIN": str(cls.fake_cli),
            "AGENTIC_OS_HERMES_PROFILE": "agentic-os",
            "AGENTIC_OS_SKILL_CATALOG": str(cls.catalog),
            "AGENTIC_OS_HERMES_BACKUP_DIR": str(cls.h.tmp / "studio-backups"),
            "AGENTIC_OS_AUDIT_FILE": str(cls.h.tmp / "studio-audit.jsonl"),
            "STUDIO_CLI_LOG": str(cls.h.tmp / "studio-cli.jsonl"),
        })
        cls.h.start()

    def setUp(self):
        shutil.rmtree(self.target, ignore_errors=True)
        (self.target / "skills" / "research" / "old-skill").mkdir(parents=True)
        (self.target / "profile.yaml").write_text("name: studio-agent\ndescription: Studio fixture\n")
        (self.target / "SOUL.md").write_text("# Studio Agent\n\nOriginal identity.\n")
        (self.target / "skills" / "research" / "old-skill" / "SKILL.md").write_text(
            "---\nname: old-skill\ndescription: Existing workflow.\n---\n# Old skill\n"
        )
        (self.target / "skills" / "research" / "old-skill" / "references").mkdir()
        (self.target / "skills" / "research" / "old-skill" / "references" / "note.md").write_text("version one\n")
        shutil.rmtree(self.h.tmp / "studio-backups", ignore_errors=True)
        (self.h.tmp / "studio-cli.jsonl").unlink(missing_ok=True)

    def request(self, method, path, body=None, admin=True):
        headers = {"Content-Type": "application/json"}
        if admin:
            headers["X-Agentic-OS-Admin"] = "studio-test-token"
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

    def studio(self):
        status, payload = self.request("GET", "/api/hermes/profiles/studio-agent/studio")
        self.assertEqual(status, 200)
        return payload

    def apply(self, body):
        preview_body = {key: body[key] for key in (
            "expected_revision", "soul", "add_skills", "remove_skills", "loadout", "power_map"
        ) if key in body}
        status, preview = self.request(
            "POST", "/api/hermes/profiles/studio-agent/studio/preview", preview_body,
        )
        if status != 200:
            return status, preview
        apply_body = {**body, "preview_token": preview["preview_token"]}
        return self.request("POST", "/api/hermes/profiles/studio-agent/studio/apply", apply_body)

    def test_capability_catalog_explains_superpowers_without_paths(self):
        status, payload = self.request(
            "GET", "/api/hermes/profiles/studio-agent/studio/capabilities"
        )
        self.assertEqual(status, 200)
        self.assertFalse(payload["executable"])
        self.assertGreaterEqual(len(payload["capabilities"]), 2)
        new_skill = next(item for item in payload["capabilities"] if item["id"] == "research/new-skill")
        for field in (
            "superpower", "contribution", "intent_category", "inputs", "outputs",
            "workflow_steps", "side_effects", "readiness",
        ):
            self.assertIn(field, new_skill)
        self.assertNotIn(str(self.h.tmp), json.dumps(payload))
        self.assertNotIn("path", json.dumps(payload).lower())

    def test_evolution_validate_is_design_only_and_does_not_write(self):
        before = self.studio()
        body = {
            "loadout": ["research/old-skill"],
            "power_map": {
                "version": 1,
                "nodes": [{
                    "id": "research", "capability_id": "research/old-skill",
                    "x": 180, "y": 160,
                }],
                "edges": [],
            },
        }
        status, payload = self.request(
            "POST", "/api/hermes/profiles/studio-agent/studio/evolution/validate", body,
        )
        self.assertEqual(status, 200)
        self.assertFalse(payload["executable"])
        self.assertFalse(payload["writes_state"])
        self.assertEqual(self.studio()["revision"], before["revision"])

    def test_apply_persists_reviewed_loadout_and_power_map(self):
        current = self.studio()
        power_map = {
            "version": 1,
            "nodes": [{
                "id": "builder", "capability_id": "research/new-skill",
                "x": 220, "y": 140,
            }],
            "edges": [],
        }
        status, result = self.apply({
            "expected_revision": current["revision"],
            "confirm": "studio-agent",
            "soul": current["soul"],
            "add_skills": ["research/new-skill"],
            "remove_skills": [],
            "loadout": ["research/new-skill"],
            "power_map": power_map,
        })
        self.assertEqual(status, 200)
        self.assertEqual(result["metadata"]["schema_version"], 2)
        self.assertEqual(result["metadata"]["loadout"], ["research/new-skill"])
        self.assertEqual(result["metadata"]["power_map"], power_map)
        stored = json.loads((self.target / ".agent-playground" / "avatar.json").read_text())
        self.assertEqual(stored["power_map"], power_map)

    def test_apply_rejects_blueprint_changed_after_preview(self):
        current = self.studio()
        original = {
            "expected_revision": current["revision"], "soul": current["soul"],
            "add_skills": [], "remove_skills": [],
            "loadout": ["research/old-skill"],
            "power_map": {"version": 1, "nodes": [], "edges": []},
        }
        status, preview = self.request(
            "POST", "/api/hermes/profiles/studio-agent/studio/preview", original,
        )
        self.assertEqual(status, 200)
        changed = {
            **original, "confirm": "studio-agent", "preview_token": preview["preview_token"],
            "loadout": [],
        }
        status, payload = self.request(
            "POST", "/api/hermes/profiles/studio-agent/studio/apply", changed,
        )
        self.assertEqual(status, 400)
        self.assertIn("preview", payload["detail"].lower())

    def test_preview_rejects_equipped_skill_that_will_not_be_installed(self):
        current = self.studio()
        body = {
            "expected_revision": current["revision"], "soul": current["soul"],
            "add_skills": [], "remove_skills": [],
            "loadout": ["research/new-skill"],
            "power_map": {
                "version": 1,
                "nodes": [{"id": "n1", "capability_id": "research/new-skill", "x": 1, "y": 2}],
                "edges": [],
            },
        }
        status, payload = self.request("POST", "/api/hermes/profiles/studio-agent/studio/preview", body)
        self.assertEqual(status, 400)
        self.assertIn("installed", payload["detail"])

    def test_metadata_publish_race_preserves_both_original_and_concurrent_versions(self):
        import agent_studio

        parent = self.target / ".agent-playground"
        parent.mkdir()
        avatar = parent / "avatar.json"
        avatar.write_text('{"original":true}\n')
        before, existed, mode, owner = agent_studio._metadata_state(self.target)
        snapshot_root = Path(tempfile.mkdtemp(prefix="studio-metadata-race-"))
        real_restore = agent_studio._restore_metadata_snapshot

        def publish_with_race(home, snapshot):
            if snapshot.name == "metadata-proposed":
                avatar.write_text('{"concurrent":true}\n')
            return real_restore(home, snapshot)

        try:
            with mock.patch.object(agent_studio, "_restore_metadata_snapshot", side_effect=publish_with_race):
                with self.assertRaises(agent_studio._OwnershipConflict):
                    agent_studio._install_metadata_transaction(
                        self.target, snapshot_root, {"schema_version": 2}, existed, mode, owner,
                    )
            self.assertEqual(json.loads(avatar.read_text()), {"concurrent": True})
            self.assertEqual(json.loads((snapshot_root / "metadata-before").read_text()), before)
        finally:
            shutil.rmtree(snapshot_root, ignore_errors=True)

    def test_studio_read_is_admin_only_and_returns_soul_and_skills(self):
        self.assertEqual(self.request("GET", "/api/hermes/profiles/studio-agent/studio", admin=False)[0], 401)
        payload = self.studio()
        self.assertEqual(payload["profile"]["name"], "studio-agent")
        self.assertEqual(payload["soul"], "# Studio Agent\n\nOriginal identity.\n")
        self.assertRegex(payload["revision"], r"^[0-9a-f]{64}$")
        self.assertEqual([item["id"] for item in payload["skills"]], ["research/old-skill"])
        self.assertEqual(payload["skills"][0]["description"], "Existing workflow.")
        self.assertNotIn(str(self.h.tmp), json.dumps(payload))

    def test_skill_detail_returns_reviewable_markdown_without_paths(self):
        status, payload = self.request("GET", "/api/hermes/profiles/studio-agent/studio/skills/research%2Fold-skill")
        self.assertEqual(status, 200)
        self.assertIn("# Old skill", payload["content"])
        self.assertEqual(payload["id"], "research/old-skill")
        self.assertNotIn(str(self.h.tmp), json.dumps(payload))

    def test_preview_is_no_write_and_reports_diff(self):
        before = self.studio()
        status, preview = self.request("POST", "/api/hermes/profiles/studio-agent/studio/preview", {
            "expected_revision": before["revision"],
            "soul": "# Studio Agent\n\nEvolved identity.\n",
            "add_skills": ["research/new-skill"],
            "remove_skills": ["research/old-skill"],
        })
        self.assertEqual(status, 200)
        self.assertFalse(preview["writes_state"])
        self.assertIn("-Original identity.", preview["soul_diff"])
        self.assertEqual(preview["add_skills"], ["research/new-skill"])
        self.assertEqual(preview["remove_skills"], ["research/old-skill"])
        self.assertRegex(preview["preview_token"], r"^[0-9a-f]{64}$")
        self.assertEqual((self.target / "SOUL.md").read_text(), before["soul"])
        self.assertTrue((self.target / "skills" / "research" / "old-skill").is_dir())
        self.assertFalse((self.target / "skills" / "research" / "new-skill").exists())

    def test_apply_rejects_concurrent_change_inside_installed_skill(self):
        before = self.studio()
        note = self.target / "skills" / "research" / "old-skill" / "references" / "note.md"
        note.write_text("version changed by another process\n")
        status, response = self.apply({
            "expected_revision": before["revision"],
            "confirm": "studio-agent",
            "soul": before["soul"] + "\nProposed change.\n",
            "add_skills": [],
            "remove_skills": [],
        })
        self.assertEqual(status, 409)
        self.assertIn("reload Studio", response["detail"])
        self.assertNotIn("Proposed change", (self.target / "SOUL.md").read_text())

    def test_apply_revalidates_revision_after_backup_before_mutation(self):
        import agent_studio

        current = self.studio()
        note = self.target / "skills" / "research" / "old-skill" / "references" / "note.md"
        original_backup = agent_studio._backup

        def concurrent_change_during_backup(name, manifest):
            result = original_backup(name, manifest)
            note.write_text("external change during backup\n")
            return result

        with mock.patch.object(agent_studio, "_backup", side_effect=concurrent_change_during_backup):
            status, response = self.apply({
                "expected_revision": current["revision"],
                "confirm": "studio-agent",
                "soul": current["soul"] + "\nMust not apply.\n",
                "add_skills": [],
                "remove_skills": [],
            })
        self.assertEqual(status, 409)
        self.assertIn("during backup", response["detail"])
        self.assertEqual(note.read_text(), "external change during backup\n")
        self.assertNotIn("Must not apply", (self.target / "SOUL.md").read_text())

    def test_apply_requires_current_revision_and_updates_transactionally(self):
        before = self.studio()
        body = {
            "expected_revision": before["revision"],
            "confirm": "studio-agent",
            "soul": "# Studio Agent\n\nEvolved identity.\n",
            "add_skills": ["research/new-skill"],
            "remove_skills": ["research/old-skill"],
        }
        wrong_confirmation = {**body, "confirm": "wrong-profile"}
        self.assertEqual(self.apply(wrong_confirmation)[0], 400)
        stale = {**body, "expected_revision": "0" * 64}
        self.assertEqual(self.apply(stale)[0], 409)
        status, updated = self.apply(body)
        self.assertEqual(status, 200)
        self.assertNotEqual(updated["revision"], before["revision"])
        self.assertEqual((self.target / "SOUL.md").read_text(), body["soul"])
        self.assertFalse((self.target / "skills" / "research" / "old-skill").exists())
        installed = self.target / "skills" / "research" / "new-skill" / "SKILL.md"
        self.assertTrue(installed.is_file())
        self.assertEqual(stat.S_IMODE(installed.stat().st_mode), 0o600)
        backups = list((self.h.tmp / "studio-backups").glob("studio-agent-*.tar.gz"))
        self.assertTrue(backups)
        self.assertTrue(all(stat.S_IMODE(path.stat().st_mode) == 0o600 for path in backups))
        calls = [json.loads(line) for line in (self.h.tmp / "studio-cli.jsonl").read_text().splitlines()]
        self.assertFalse(any("gateway" in call for call in calls))

    def test_invalid_backup_aborts_before_mutation(self):
        import agent_studio

        current = self.studio()
        original_run = agent_studio._run

        def corrupt_export(args, timeout=30):
            if args[:2] == ["profile", "export"]:
                destination = Path(args[args.index("--output") + 1])
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(b"not a tar archive")
                return "exported"
            return original_run(args, timeout=timeout)

        with mock.patch.object(agent_studio, "_run", side_effect=corrupt_export):
            status, response = self.apply({
                "expected_revision": current["revision"],
                "confirm": "studio-agent",
                "soul": current["soul"] + "\nMust not be written.\n",
                "add_skills": [],
                "remove_skills": [],
            })
        self.assertEqual(status, 502)
        self.assertIn("rolled back", response["detail"].lower())
        self.assertNotIn("Must not be written", (self.target / "SOUL.md").read_text())

    def test_matching_root_but_incomplete_backup_is_rejected(self):
        import agent_studio
        from profile_backup import profile_manifest

        archive_path = self.h.tmp / "studio-backups" / "partial.tar.gz"
        archive_path.parent.mkdir(parents=True, exist_ok=True)
        dummy = self.h.tmp / "dummy.txt"
        dummy.write_text("not a profile backup\n")
        with tarfile.open(archive_path, "w:gz") as archive:
            archive.add(dummy, arcname="studio-agent/dummy.txt")
        with self.assertRaises(OSError):
            agent_studio._verify_backup(
                archive_path, "studio-agent", profile_manifest(self.target, managed_only=True),
            )

    def test_tree_signature_hashes_auxiliary_file_contents(self):
        import agent_studio

        root = self.target / "skills" / "research" / "old-skill"
        note = root / "references" / "note.md"
        info = note.stat()
        before = agent_studio._tree_signature(root)
        note.write_text("version two\n")
        self.assertEqual(note.stat().st_size, info.st_size)
        os.utime(note, ns=(info.st_atime_ns, info.st_mtime_ns))
        self.assertNotEqual(before, agent_studio._tree_signature(root))

    def test_backup_for_wrong_profile_root_aborts_before_mutation(self):
        import agent_studio

        current = self.studio()
        original_run = agent_studio._run

        def wrong_root_export(args, timeout=60):
            if args[:2] == ["profile", "export"]:
                destination = Path(args[args.index("--output") + 1])
                destination.parent.mkdir(parents=True, exist_ok=True)
                payload = self.h.tmp / "wrong-root.txt"
                payload.write_text("not this profile\n")
                with tarfile.open(destination, "w:gz") as archive:
                    archive.add(payload, arcname="different-profile/SOUL.md")
                return ""
            return original_run(args, timeout=timeout)

        with mock.patch.object(agent_studio, "_run", side_effect=wrong_root_export):
            status, response = self.apply({
                "expected_revision": current["revision"],
                "confirm": "studio-agent",
                "soul": current["soul"] + "\nMust not be written.\n",
                "add_skills": [],
                "remove_skills": [],
            })
        self.assertEqual(status, 502)
        self.assertIn("rolled back", response["detail"].lower())
        self.assertNotIn("Must not be written", (self.target / "SOUL.md").read_text())

    def test_failed_add_never_deletes_preexisting_skill_namespace(self):
        existing = self.target / "skills" / "team" / "existing"
        existing.mkdir(parents=True)
        (existing / "SKILL.md").write_text("---\nname: existing\ndescription: Must survive.\n---\n")
        current = self.studio()
        status, response = self.apply({
            "expected_revision": current["revision"],
            "confirm": "studio-agent",
            "soul": current["soul"],
            "add_skills": ["team"],
            "remove_skills": [],
        })
        self.assertEqual(status, 400)
        self.assertIn("overlap", response["detail"].lower())
        self.assertTrue((existing / "SKILL.md").is_file())

    def test_nested_installed_skill_namespaces_are_explicitly_read_only(self):
        parent = self.target / "skills" / "team"
        child = parent / "existing"
        child.mkdir(parents=True)
        (parent / "SKILL.md").write_text("---\nname: team\ndescription: Parent.\n---\n")
        (child / "SKILL.md").write_text("---\nname: existing\ndescription: Child.\n---\n")
        studio = self.studio()
        nested = [item for item in studio["skills"] if item["id"] in {"team", "team/existing"}]
        self.assertEqual(len(nested), 2)
        self.assertTrue(all(item["studio_mutable"] is False for item in nested))
        status, response = self.request("POST", "/api/hermes/profiles/studio-agent/studio/preview", {
            "expected_revision": studio["revision"],
            "soul": studio["soul"],
            "add_skills": [],
            "remove_skills": ["team"],
        })
        self.assertEqual(status, 400)
        self.assertIn("nested", response["detail"].lower())

    def test_apply_requires_preview_token_bound_to_exact_payload(self):
        current = self.studio()
        body = {
            "expected_revision": current["revision"],
            "confirm": "studio-agent",
            "soul": current["soul"] + "\nBound preview.\n",
            "add_skills": [],
            "remove_skills": [],
        }
        self.assertEqual(self.request("POST", "/api/hermes/profiles/studio-agent/studio/apply", body)[0], 400)
        preview_body = {key: body[key] for key in ("expected_revision", "soul", "add_skills", "remove_skills")}
        preview = self.request("POST", "/api/hermes/profiles/studio-agent/studio/preview", preview_body)[1]
        tampered = {**body, "soul": body["soul"] + "tampered\n", "preview_token": preview["preview_token"]}
        self.assertEqual(self.request("POST", "/api/hermes/profiles/studio-agent/studio/apply", tampered)[0], 400)
        self.assertNotIn("tampered", (self.target / "SOUL.md").read_text())

    def test_overlapping_nested_skill_changes_are_rejected_before_write(self):
        parent = self.target / "skills" / "nested"
        child = parent / "child"
        child.mkdir(parents=True)
        (parent / "SKILL.md").write_text("---\nname: nested\n---\n")
        (child / "SKILL.md").write_text("---\nname: child\n---\n")
        current = self.studio()
        status, response = self.request("POST", "/api/hermes/profiles/studio-agent/studio/preview", {
            "expected_revision": current["revision"],
            "soul": current["soul"],
            "add_skills": [],
            "remove_skills": ["nested", "nested/child"],
        })
        self.assertEqual(status, 400)
        self.assertIn("overlapping", response["detail"].lower())
        self.assertTrue((child / "SKILL.md").is_file())

    def test_rollback_preserves_original_absence_of_soul(self):
        import agent_studio

        (self.target / "SOUL.md").unlink()
        current = self.studio()
        original_audit = agent_studio._audit

        def fail_success(action, profile, result):
            if action == "studio_apply" and result == "success":
                raise OSError("simulated audit failure")
            return original_audit(action, profile, result)

        with mock.patch.object(agent_studio, "_audit", side_effect=fail_success):
            status, response = self.apply({
                "expected_revision": current["revision"],
                "confirm": "studio-agent",
                "soul": "# Temporary soul\n",
                "add_skills": [],
                "remove_skills": [],
            })
        self.assertEqual(status, 502)
        self.assertIn("rolled back", response["detail"].lower())
        self.assertFalse((self.target / "SOUL.md").exists())

    def test_atomic_skill_removal_failure_leaves_original_tree_untouched(self):
        import agent_studio

        current = self.studio()
        source = self.target / "skills" / "research" / "old-skill"
        note = source / "references" / "note.md"
        def fail_source_rename(home, skill_id, snapshot_root, snapshot_name):
            raise OSError("simulated atomic rename failure")

        with mock.patch.object(agent_studio, "_move_skill_to_snapshot", side_effect=fail_source_rename):
            status, response = self.apply({
                "expected_revision": current["revision"],
                "confirm": "studio-agent",
                "soul": current["soul"],
                "add_skills": [],
                "remove_skills": ["research/old-skill"],
            })
        self.assertEqual(status, 502)
        self.assertIn("rolled back", response["detail"].lower())
        self.assertTrue((source / "SKILL.md").is_file())
        self.assertEqual(note.read_text(), "version one\n")

    def test_unowned_destination_created_during_failed_add_is_preserved(self):
        import agent_studio

        current = self.studio()
        destination = self.target / "skills" / "research" / "new-skill"

        def concurrent_add(skill_id, home):
            destination.mkdir(parents=True)
            (destination / "sentinel.txt").write_text("external\n")
            raise OSError("simulated concurrent writer")

        with mock.patch.object(agent_studio, "_copy_skill", side_effect=concurrent_add):
            status, response = self.apply({
                "expected_revision": current["revision"],
                "confirm": "studio-agent",
                "soul": current["soul"],
                "add_skills": ["research/new-skill"],
                "remove_skills": [],
            })
        self.assertEqual(status, 500)
        self.assertIn("manual intervention", response["detail"].lower())
        self.assertEqual((destination / "sentinel.txt").read_text(), "external\n")

    def test_added_tree_is_preserved_if_ownership_capture_fails(self):
        import agent_studio

        current = self.studio()
        destination = self.target / "skills" / "research" / "new-skill"
        original_owner = agent_studio._tree_owner

        def fail_new_tree_owner(path):
            if Path(path) == destination:
                raise OSError("simulated ownership capture failure")
            return original_owner(path)

        with mock.patch.object(agent_studio, "_tree_owner", side_effect=fail_new_tree_owner):
            status, response = self.apply({
                "expected_revision": current["revision"],
                "confirm": "studio-agent",
                "soul": current["soul"],
                "add_skills": ["research/new-skill"],
                "remove_skills": [],
            })
        self.assertEqual(status, 500)
        self.assertIn("manual intervention", response["detail"].lower())
        self.assertTrue((destination / "SKILL.md").is_file())

    def test_concurrent_change_to_added_tree_is_restored_not_deleted(self):
        import agent_studio

        current = self.studio()
        destination = self.target / "skills" / "research" / "new-skill"
        original_owner = agent_studio._tree_owner
        injected = False

        def inject_after_capture(path):
            nonlocal injected
            owner = original_owner(path)
            if Path(path) == destination and not injected:
                injected = True
                (destination / "sentinel.txt").write_text("external\n")
            return owner

        with mock.patch.object(agent_studio, "_tree_owner", side_effect=inject_after_capture):
            status, response = self.apply({
                "expected_revision": current["revision"],
                "confirm": "studio-agent",
                "soul": current["soul"],
                "add_skills": ["research/new-skill"],
                "remove_skills": [],
            })
        self.assertEqual(status, 500)
        self.assertIn("manual intervention", response["detail"].lower())
        self.assertEqual((destination / "sentinel.txt").read_text(), "external\n")

    def test_soul_replacement_immediately_before_mutation_is_preserved(self):
        import agent_studio

        current = self.studio()
        soul_path = self.target / "SOUL.md"
        original_move = agent_studio._move_soul_to_snapshot
        injected = False

        def replace_before_move(home, snapshot_root, snapshot_name):
            nonlocal injected
            if snapshot_name == "soul-before" and not injected:
                injected = True
                soul_path.unlink()
                soul_path.write_text("# External replacement immediately before mutation\n")
            return original_move(home, snapshot_root, snapshot_name)

        with mock.patch.object(agent_studio, "_move_soul_to_snapshot", side_effect=replace_before_move):
            status, response = self.apply({
                "expected_revision": current["revision"],
                "confirm": "studio-agent",
                "soul": "# Proposed transaction SOUL\n",
                "add_skills": [],
                "remove_skills": [],
            })
        self.assertEqual(status, 502)
        self.assertIn("rolled back", response["detail"].lower())
        self.assertEqual(soul_path.read_text(), "# External replacement immediately before mutation\n")

    def test_soul_replacement_immediately_after_publication_is_preserved(self):
        import agent_studio

        current = self.studio()
        soul_path = self.target / "SOUL.md"
        original_restore = agent_studio._restore_soul_snapshot
        injected = False

        def replace_after_publish(home, snapshot):
            nonlocal injected
            result = original_restore(home, snapshot)
            if snapshot.name == "soul-proposed" and not injected:
                injected = True
                soul_path.unlink()
                soul_path.write_text("# External replacement after publication\n")
            return result

        with mock.patch.object(agent_studio, "_restore_soul_snapshot", side_effect=replace_after_publish):
            status, response = self.apply({
                "expected_revision": current["revision"],
                "confirm": "studio-agent",
                "soul": "# Proposed transaction SOUL\n",
                "add_skills": [],
                "remove_skills": [],
            })
        self.assertEqual(status, 500)
        self.assertIn("manual intervention", response["detail"].lower())
        self.assertEqual(soul_path.read_text(), "# External replacement after publication\n")

    def test_soul_mutation_after_owner_capture_is_preserved(self):
        import agent_studio

        current = self.studio()
        soul_path = self.target / "SOUL.md"
        original_restore = agent_studio._restore_soul_snapshot
        injected = False

        def mutate_before_publish(home, snapshot):
            nonlocal injected
            if snapshot.name == "soul-proposed" and not injected:
                injected = True
                snapshot.write_text("# External concurrent SOUL\n")
            return original_restore(home, snapshot)

        with mock.patch.object(agent_studio, "_restore_soul_snapshot", side_effect=mutate_before_publish):
            status, response = self.apply({
                "expected_revision": current["revision"],
                "confirm": "studio-agent",
                "soul": "# Proposed transaction SOUL\n",
                "add_skills": [],
                "remove_skills": [],
            })
        self.assertEqual(status, 500)
        self.assertIn("manual intervention", response["detail"].lower())
        self.assertEqual(soul_path.read_text(), "# External concurrent SOUL\n")

    def test_replacement_immediately_before_remove_is_preserved(self):
        import agent_studio

        current = self.studio()
        source = self.target / "skills" / "research" / "old-skill"
        original_move = agent_studio._move_skill_to_snapshot

        def replace_before_rename(home, skill_id, snapshot_root, snapshot_name):
            shutil.rmtree(source)
            source.mkdir(parents=True)
            (source / "SKILL.md").write_text("---\nname: old-skill\n---\n# External replacement\n")
            (source / "sentinel.txt").write_text("external\n")
            return original_move(home, skill_id, snapshot_root, snapshot_name)

        with mock.patch.object(agent_studio, "_move_skill_to_snapshot", side_effect=replace_before_rename):
            status, response = self.apply({
                "expected_revision": current["revision"],
                "confirm": "studio-agent",
                "soul": current["soul"],
                "add_skills": [],
                "remove_skills": ["research/old-skill"],
            })
        self.assertEqual(status, 502)
        self.assertIn("rolled back", response["detail"].lower())
        self.assertEqual((source / "sentinel.txt").read_text(), "external\n")

    def test_concurrent_recreation_during_remove_is_preserved_with_snapshot(self):
        import agent_studio

        current = self.studio()
        source = self.target / "skills" / "research" / "old-skill"
        original_move = agent_studio._move_skill_to_snapshot

        def recreate_after_rename(home, skill_id, snapshot_root, snapshot_name):
            result = original_move(home, skill_id, snapshot_root, snapshot_name)
            source.mkdir(parents=True)
            (source / "SKILL.md").write_text("---\nname: old-skill\n---\n# Concurrent\n")
            (source / "sentinel.txt").write_text("external\n")
            return result

        with mock.patch.object(agent_studio, "_move_skill_to_snapshot", side_effect=recreate_after_rename):
            status, response = self.apply({
                "expected_revision": current["revision"],
                "confirm": "studio-agent",
                "soul": current["soul"],
                "add_skills": [],
                "remove_skills": ["research/old-skill"],
            })
        self.assertEqual(status, 500)
        self.assertIn("manual intervention", response["detail"].lower())
        self.assertEqual((source / "sentinel.txt").read_text(), "external\n")
        snapshots = list(self.target.glob(".agent-studio-txn-*/removed-0/SKILL.md"))
        self.assertEqual(len(snapshots), 1)

    def test_apply_rolls_back_if_success_audit_fails(self):
        import agent_studio

        os.chmod(self.target / "SOUL.md", 0o666)
        current = self.studio()
        soul_before = current["soul"]
        original_audit = agent_studio._audit

        def fail_success(action, profile, result):
            if action == "studio_apply" and result == "success":
                raise OSError("simulated audit failure")
            return original_audit(action, profile, result)

        with mock.patch.object(agent_studio, "_audit", side_effect=fail_success):
            status, response = self.apply({
                "expected_revision": current["revision"],
                "confirm": "studio-agent",
                "soul": soul_before + "\nThis must roll back.\n",
                "add_skills": ["research/new-skill"],
                "remove_skills": ["research/old-skill"],
            })
        self.assertEqual(status, 502)
        self.assertFalse(self.target.joinpath("skills", "research", "new-skill").exists())
        self.assertTrue(self.target.joinpath("skills", "research", "old-skill", "SKILL.md").is_file())
        self.assertIn("rolled back", response["detail"].lower())
        self.assertEqual((self.target / "SOUL.md").read_text(), soul_before)
        self.assertEqual(stat.S_IMODE((self.target / "SOUL.md").stat().st_mode), 0o666)

    def test_rollback_retains_soul_quarantine_for_late_open_fd_writes(self):
        import agent_studio

        current = self.studio()
        soul_path = self.target / "SOUL.md"
        original_owner = agent_studio._file_owner
        fd_holder = []

        def fail_success_audit(action, target, status):
            if action == "studio_apply" and status == "success":
                fd_holder.append(os.open(soul_path, os.O_RDWR))
                raise OSError("simulated audit failure")

        def mutate_after_owner(path):
            owner = original_owner(path)
            if Path(path).name == "soul-current" and fd_holder:
                fd = fd_holder.pop()
                os.ftruncate(fd, 0)
                os.write(fd, b"# External late SOUL write\n")
                os.close(fd)
            return owner

        with mock.patch.object(agent_studio, "_audit", side_effect=fail_success_audit), mock.patch.object(
            agent_studio, "_file_owner", side_effect=mutate_after_owner
        ):
            status, response = self.apply({
                "expected_revision": current["revision"],
                "confirm": "studio-agent",
                "soul": "# Proposed SOUL for rollback\n",
                "add_skills": [],
                "remove_skills": [],
            })
        self.assertEqual(status, 502)
        self.assertIn("rolled back", response["detail"].lower())
        self.assertEqual(soul_path.read_text(), "# Studio Agent\n\nOriginal identity.\n")
        retained = list(self.target.glob(".agent-studio-txn-*/soul-current"))
        self.assertEqual(len(retained), 1)
        self.assertEqual(retained[0].read_text(), "# External late SOUL write\n")

    def test_rollback_retains_added_skill_quarantine_for_late_open_fd_writes(self):
        import agent_studio

        current = self.studio()
        installed = self.target / "skills" / "research" / "new-skill" / "SKILL.md"
        original_owner = agent_studio._tree_owner
        fd_holder = []

        def fail_success_audit(action, target, status):
            if action == "studio_apply" and status == "success":
                fd_holder.append(os.open(installed, os.O_RDWR))
                raise OSError("simulated audit failure")

        def mutate_after_owner(path):
            owner = original_owner(path)
            if Path(path).name.startswith("added-rollback-") and fd_holder:
                fd = fd_holder.pop()
                os.ftruncate(fd, 0)
                os.write(fd, b"# External late skill write\n")
                os.close(fd)
            return owner

        with mock.patch.object(agent_studio, "_audit", side_effect=fail_success_audit), mock.patch.object(
            agent_studio, "_tree_owner", side_effect=mutate_after_owner
        ):
            status, response = self.apply({
                "expected_revision": current["revision"],
                "confirm": "studio-agent",
                "soul": current["soul"],
                "add_skills": ["research/new-skill"],
                "remove_skills": [],
            })
        self.assertEqual(status, 502)
        self.assertIn("rolled back", response["detail"].lower())
        self.assertFalse(installed.exists())
        retained = list(self.target.glob(".agent-studio-txn-*/added-rollback-*/SKILL.md"))
        self.assertEqual(len(retained), 1)
        self.assertEqual(retained[0].read_text(), "# External late skill write\n")

    def test_advanced_profile_hub_cannot_mutate_protected_profiles(self):
        soul_path = self.hermes_home / "SOUL.md"
        original = soul_path.read_text()
        try:
            status, response = self.request("PATCH", "/api/hermes/profiles/default", {
                "soul": "# Forbidden advanced mutation\n",
            })
            observed = soul_path.read_text()
        finally:
            soul_path.write_text(original)
        self.assertEqual(status, 409)
        self.assertIn("protected", response["detail"].lower())
        self.assertEqual(observed, original)

    def test_protected_profiles_are_read_only(self):
        current = self.request("GET", "/api/hermes/profiles/default/studio")[1]
        status, response = self.request("POST", "/api/hermes/profiles/default/studio/apply", {
            "expected_revision": current["revision"],
            "soul": "# Changed\n",
            "add_skills": [],
            "remove_skills": [],
        })
        self.assertEqual(status, 409)
        self.assertIn("read-only", response["detail"].lower())
        self.assertEqual((self.hermes_home / "SOUL.md").read_text(), "# Default\n")

    def test_profiles_frontend_exposes_agent_studio(self):
        script = (Path(__file__).parents[1] / "dashboard" / "pages" / "profiles.js").read_text()
        for marker in (
            "Agent Studio", "renderStudioWorkspace", "studioSoulEditor",
            "studioSkillCatalog", "previewStudioEvolution", "applyStudioEvolution",
            "Cambios pendientes", "Administración avanzada",
            "confirmDiscardStudioChanges", "requestSeq", "studioExactConfirm",
            "preview_token", "profileState.preview", "Tu borrador se conserva",
            "studio_mutable", "Namespace anidado",
        ):
            self.assertIn(marker, script)
        app = (Path(__file__).parents[1] / "dashboard" / "app.js").read_text()
        self.assertIn("agentStudioConfirmNavigation", app)
        self.assertIn("window.history.replaceState", app)

    def test_all_profile_mutators_share_the_same_interprocess_lock(self):
        root = Path(__file__).parents[1]
        self.assertIn("from profile_lock import profile_process_lock", (root / "agent_studio.py").read_text())
        self.assertIn("from profile_lock import profile_process_lock", (root / "playground.py").read_text())
        self.assertGreaterEqual((root / "playground.py").read_text().count("with LOCK, _profile_process_lock():"), 2)
        hub = (root / "profile_hub.py").read_text()
        self.assertIn("from profile_lock import profile_process_lock", hub)
        self.assertGreaterEqual(hub.count("with LOCK, _profile_process_lock():"), 4)
        lock_source = (root / "profile_lock.py").read_text()
        self.assertIn('os.getenv("AGENTIC_OS_HERMES_HOME")', lock_source)


if __name__ == "__main__":
    unittest.main()
