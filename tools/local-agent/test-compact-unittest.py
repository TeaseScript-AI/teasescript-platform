#!/usr/bin/env python3
"""Regression tests for compact unittest output."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from compact_unittest import run_compact_unittest

TOOLS = Path(__file__).resolve().parent


class CompactUnittestTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="compact-unittest-")
        self.root = Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def run_fixture(self, source: str) -> subprocess.CompletedProcess[str]:
        fixture = self.root / "fixture.py"
        fixture.write_text(source, encoding="utf-8")
        environment = os.environ.copy()
        environment["PYTHONPATH"] = str(TOOLS)
        return subprocess.run(
            [sys.executable, "-B", str(fixture)],
            text=True,
            capture_output=True,
            env=environment,
            check=False,
        )

    def test_success_is_one_line(self) -> None:
        completed = self.run_fixture(
            "import unittest\n"
            "from compact_unittest import run_compact_unittest\n\n"
            "class Example(unittest.TestCase):\n"
            "    def test_ok(self):\n"
            "        self.assertTrue(True)\n\n"
            "if __name__ == '__main__':\n"
            "    run_compact_unittest('fixture-suite')\n"
        )
        self.assertEqual(completed.returncode, 0)
        self.assertEqual(completed.stdout, "fixture-suite: PASS (1 tests)\n")
        self.assertEqual(completed.stderr, "")

    def test_failure_keeps_identity_traceback_and_assertion(self) -> None:
        completed = self.run_fixture(
            "import unittest\n"
            "from compact_unittest import run_compact_unittest\n\n"
            "class Example(unittest.TestCase):\n"
            "    def test_failure(self):\n"
            "        self.assertEqual(1, 2)\n\n"
            "if __name__ == '__main__':\n"
            "    run_compact_unittest('fixture-suite')\n"
        )
        self.assertEqual(completed.returncode, 1)
        self.assertEqual(completed.stdout, "")
        self.assertIn("test_failure", completed.stderr)
        self.assertIn("Traceback", completed.stderr)
        self.assertIn("AssertionError: 1 != 2", completed.stderr)
        self.assertIn("FAILED", completed.stderr)


if __name__ == "__main__":
    run_compact_unittest("compact-unittest")
