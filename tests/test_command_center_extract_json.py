"""Unit tests for command_center_api.extract_json (Part 6 §3): the
model-agnostic JSON / tool-call extractor, mirrored in Rust (dispatch.rs) and
TS (extract-json.ts). Pure function — no Harness/server needed.

Run with: python3 tests/run_all.py  (or: python3 tests/test_command_center_extract_json.py)
"""
import sys
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import command_center_api as cc  # noqa: E402


class ExtractJsonTests(unittest.TestCase):
    def test_plain_object(self):
        self.assertEqual(cc.extract_json('{"tool": "x", "args": {}}')["tool"], "x")

    def test_strips_closed_think_block_first(self):
        v = cc.extract_json('<think>let me think about {"fake": 1}</think>{"tool": "real", "args": {}}')
        self.assertEqual(v["tool"], "real")

    def test_drops_unclosed_think_block(self):
        self.assertIsNone(cc.extract_json('<think>still thinking about {"tool":"x"}'))

    def test_prefers_a_json_fence(self):
        text = 'Sure, here you go:\n```json\n{"tool": "fenced", "args": {"a": 1}}\n```\nHope that helps.'
        self.assertEqual(cc.extract_json(text)["tool"], "fenced")

    def test_tries_each_brace_span_when_first_is_junk(self):
        text = """note: {this isn't json} but then {"tool": "second", "args": {}}"""
        self.assertEqual(cc.extract_json(text)["tool"], "second")

    def test_ignores_braces_inside_string_values(self):
        text = '{"tool": "x", "args": {"note": "use { and } in prose"}}'
        v = cc.extract_json(text)
        self.assertEqual(v["tool"], "x")
        self.assertEqual(v["args"]["note"], "use { and } in prose")

    def test_repairs_trailing_commas_and_smart_quotes(self):
        text = "{“tool”: “x”, “args”: {“a”: 1,},}"
        v = cc.extract_json(text)
        self.assertEqual(v["tool"], "x")
        self.assertEqual(v["args"]["a"], 1)

    def test_accepts_tool_call_tag_wrapper(self):
        text = '<tool_call>{"tool": "wrapped", "args": {}}</tool_call>'
        self.assertEqual(cc.extract_json(text)["tool"], "wrapped")

    def test_normalizes_name_arguments_shape(self):
        text = '{"name": "whatsapp.list_messages", "arguments": {"limit": 5}}'
        v = cc.extract_json(text)
        self.assertEqual(v["tool"], "whatsapp.list_messages")
        self.assertEqual(v["args"]["limit"], 5)
        self.assertEqual(v["name"], "whatsapp.list_messages")

    def test_none_when_no_json_at_all(self):
        self.assertIsNone(cc.extract_json("just a plain sentence, no JSON here"))

    def test_none_on_empty_input(self):
        self.assertIsNone(cc.extract_json(""))
        self.assertIsNone(cc.extract_json(None))


if __name__ == "__main__":
    unittest.main()
