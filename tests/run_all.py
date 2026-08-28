#!/usr/bin/env python3
"""Zero-dependency test runner for Agentic OS (v0.4.0).

Usage:  python3 tests/run_all.py

Runs every tests/test_*.py module. Each module boots its own isolated
Harness (temp state dir), so no real project data is ever touched.
Requires: python3 + installed deps (fastapi, uvicorn) — no pytest/httpx.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import test_core  # noqa: E402
import test_security  # noqa: E402
import test_kanban_journal  # noqa: E402
import test_memory_scheduler  # noqa: E402
import test_v040  # noqa: E402
import test_agent_playground  # noqa: E402
import test_agent_studio  # noqa: E402
import test_agent_block_world  # noqa: E402


def main() -> int:
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    for module in (test_core, test_security, test_kanban_journal,
                   test_memory_scheduler, test_v040, test_agent_playground,
                   test_agent_studio, test_agent_block_world):
        suite.addTests(loader.loadTestsFromModule(module))
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
