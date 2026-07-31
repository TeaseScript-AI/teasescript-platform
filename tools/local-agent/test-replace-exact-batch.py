#!/usr/bin/env python3
"""Standard-library tests for replace-exact-batch.py."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).with_name("replace-exact-batch.py")
SPEC = importlib.util.spec_from_file_location("replace_exact_batch", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class BatchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.first = self.root / "first.bin"
        self.second = self.root / "second.bin"
        self.plan = self.root / "plan.json"

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def write_plan(self, operations) -> None:
        self.plan.write_text(
            json.dumps({"formatVersion": 1, "operations": operations}),
            encoding="utf-8",
        )

    def test_ordered_operations_write_one_file_once(self) -> None:
        self.first.write_text("alpha beta gamma\n", encoding="utf-8")
        self.write_plan([
            {"file": str(self.first), "oldText": "alpha", "newText": "ALPHA"},
            {"file": str(self.first), "oldText": "ALPHA beta", "newText": "done"},
        ])

        real_write = MODULE.CORE.atomic_write
        with mock.patch.object(MODULE.CORE, "atomic_write", wraps=real_write) as write:
            result = MODULE.run_plan(self.plan, dry_run=False)

        self.assertEqual(write.call_count, 1)
        self.assertEqual(result.operations, 2)
        self.assertEqual(result.files, 1)
        self.assertEqual(result.matches, 2)
        self.assertEqual(self.first.read_text(encoding="utf-8"), "done gamma\n")

    def test_multiple_files_are_validated_before_writing(self) -> None:
        self.first.write_text("OLD one\n", encoding="utf-8")
        self.second.write_text("OLD two\n", encoding="utf-8")
        self.write_plan([
            {"file": str(self.first), "oldText": "OLD", "newText": "NEW"},
            {"file": str(self.second), "oldText": "MISSING", "newText": "NEW"},
        ])

        with self.assertRaisesRegex(MODULE.CORE.ReplaceExactError, r"operations\[1\]"):
            MODULE.run_plan(self.plan, dry_run=False)

        self.assertEqual(self.first.read_text(encoding="utf-8"), "OLD one\n")
        self.assertEqual(self.second.read_text(encoding="utf-8"), "OLD two\n")

    def test_dry_run_changes_nothing(self) -> None:
        self.first.write_text("OLD", encoding="utf-8")
        self.write_plan([
            {"file": str(self.first), "oldText": "OLD", "newText": "NEW"}
        ])

        result = MODULE.run_plan(self.plan, dry_run=True)

        self.assertEqual(result.changed_files, 1)
        self.assertEqual(self.first.read_text(encoding="utf-8"), "OLD")

    def test_file_inputs_remain_byte_exact(self) -> None:
        old = self.root / "old.bin"
        new = self.root / "new.bin"
        self.first.write_bytes(b"before\r\nOLD\x00after")
        old.write_bytes(b"OLD\x00")
        new.write_bytes(b"NEW\x00")
        self.write_plan([
            {
                "file": str(self.first),
                "oldFile": str(old),
                "newFile": str(new),
            }
        ])

        MODULE.run_plan(self.plan, dry_run=False)

        self.assertEqual(self.first.read_bytes(), b"before\r\nNEW\x00after")

    def test_unknown_field_is_rejected(self) -> None:
        self.first.write_text("OLD", encoding="utf-8")
        self.write_plan([
            {
                "file": str(self.first),
                "oldText": "OLD",
                "newText": "NEW",
                "expected_count": 1,
            }
        ])

        with self.assertRaisesRegex(MODULE.CORE.ReplaceExactError, "expected_count"):
            MODULE.run_plan(self.plan, dry_run=False)

        self.assertEqual(self.first.read_text(encoding="utf-8"), "OLD")

    def test_boolean_expected_count_is_rejected(self) -> None:
        self.first.write_text("OLD", encoding="utf-8")
        self.write_plan([
            {
                "file": str(self.first),
                "oldText": "OLD",
                "newText": "NEW",
                "expectedCount": True,
            }
        ])

        with self.assertRaisesRegex(MODULE.CORE.ReplaceExactError, "positive integer"):
            MODULE.run_plan(self.plan, dry_run=False)

    def test_duplicate_operation_field_is_rejected(self) -> None:
        self.first.write_text("OLD", encoding="utf-8")
        self.plan.write_text(
            '{"formatVersion":1,"operations":[{"file":'
            + json.dumps(str(self.first))
            + ',"oldText":"OLD","oldText":"OTHER","newText":"NEW"}]}',
            encoding="utf-8",
        )

        with self.assertRaisesRegex(
            MODULE.CORE.ReplaceExactError,
            "Duplicate JSON field: oldText",
        ):
            MODULE.run_plan(self.plan, dry_run=False)

        self.assertEqual(self.first.read_text(encoding="utf-8"), "OLD")

    def test_later_write_failure_reports_partial_application(self) -> None:
        self.first.write_text("OLD one", encoding="utf-8")
        self.second.write_text("OLD two", encoding="utf-8")
        self.write_plan([
            {"file": str(self.first), "oldText": "OLD", "newText": "NEW"},
            {"file": str(self.second), "oldText": "OLD", "newText": "NEW"},
        ])

        real_write = MODULE.CORE.atomic_write
        calls = 0

        def fail_second(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise MODULE.CORE.ReplaceExactError("simulated write failure")
            return real_write(*args, **kwargs)

        with mock.patch.object(MODULE.CORE, "atomic_write", side_effect=fail_second):
            with self.assertRaisesRegex(
                MODULE.BatchPartiallyAppliedError,
                "after replacing 1 file",
            ):
                MODULE.run_plan(self.plan, dry_run=False)

        self.assertEqual(self.first.read_text(encoding="utf-8"), "NEW one")
        self.assertEqual(self.second.read_text(encoding="utf-8"), "OLD two")

    def test_first_unsynced_write_reports_current_target(self) -> None:
        self.first.write_text("OLD one", encoding="utf-8")
        self.write_plan([
            {"file": str(self.first), "oldText": "OLD", "newText": "NEW"}
        ])

        real_write = MODULE.CORE.atomic_write

        def replace_then_fail(*args, **kwargs):
            real_write(*args, **kwargs)
            raise MODULE.CORE.ReplacementAppliedButUnsyncedError(
                "simulated directory synchronization failure"
            )

        with mock.patch.object(
            MODULE.CORE,
            "atomic_write",
            side_effect=replace_then_fail,
        ):
            with self.assertRaises(MODULE.BatchPartiallyAppliedError) as raised:
                MODULE.run_plan(self.plan, dry_run=False)

        message = str(raised.exception)
        self.assertIn("1 file(s) may have changed", message)
        self.assertIn(str(self.first), message)
        self.assertEqual(self.first.read_text(encoding="utf-8"), "NEW one")

    def test_later_unsynced_write_reports_all_possible_targets(self) -> None:
        self.first.write_text("OLD one", encoding="utf-8")
        self.second.write_text("OLD two", encoding="utf-8")
        self.write_plan([
            {"file": str(self.first), "oldText": "OLD", "newText": "NEW"},
            {"file": str(self.second), "oldText": "OLD", "newText": "NEW"},
        ])

        real_write = MODULE.CORE.atomic_write
        calls = 0

        def fail_second_after_replace(*args, **kwargs):
            nonlocal calls
            calls += 1
            real_write(*args, **kwargs)
            if calls == 2:
                raise MODULE.CORE.ReplacementAppliedButUnsyncedError(
                    "simulated directory synchronization failure"
                )

        with mock.patch.object(
            MODULE.CORE,
            "atomic_write",
            side_effect=fail_second_after_replace,
        ):
            with self.assertRaises(MODULE.BatchPartiallyAppliedError) as raised:
                MODULE.run_plan(self.plan, dry_run=False)

        message = str(raised.exception)
        self.assertIn("2 file(s) may have changed", message)
        self.assertIn(str(self.first), message)
        self.assertIn(str(self.second), message)
        self.assertEqual(self.first.read_text(encoding="utf-8"), "NEW one")
        self.assertEqual(self.second.read_text(encoding="utf-8"), "NEW two")

    def test_cli_success_output_is_one_line(self) -> None:
        self.first.write_text("OLD OLD", encoding="utf-8")
        self.write_plan([
            {
                "file": str(self.first),
                "oldText": "OLD",
                "newText": "NEW",
                "expectedCount": 2,
            }
        ])

        completed = subprocess.run(
            [sys.executable, str(SCRIPT), "--plan", str(self.plan)],
            check=True,
            text=True,
            capture_output=True,
        )

        self.assertEqual(len(completed.stdout.strip().splitlines()), 1)
        self.assertIn("1 operation(s) with 2 match(es)", completed.stdout)
        self.assertEqual(self.first.read_text(encoding="utf-8"), "NEW NEW")


if __name__ == "__main__":
    unittest.main(verbosity=2)
