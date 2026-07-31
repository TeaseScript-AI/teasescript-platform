#!/usr/bin/env python3
"""Standard-library tests for replace-exact.py."""

from __future__ import annotations

import importlib.util
import os
import stat
import subprocess
import sys
import tempfile
import unittest

from pathlib import Path
from unittest import mock

from compact_unittest import run_compact_unittest


SCRIPT = Path(__file__).with_name("replace-exact.py")
SPEC = importlib.util.spec_from_file_location("replace_exact", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class ReplaceExactTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.target = self.root / "target.bin"
        self.old = self.root / "old.bin"
        self.new = self.root / "new.bin"

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def call(self, *, expected: int = 1, dry_run: bool = False):
        return MODULE.replace_exact(
            self.target, self.old, self.new, expected, dry_run
        )

    def test_exact_replacement_preserves_crlf_no_final_newline_and_mode(self) -> None:
        self.target.write_bytes(b"before\r\nOLD\r\nafter")
        self.target.chmod(0o640)
        self.old.write_bytes(b"OLD")
        self.new.write_bytes(b"NEW")

        result = self.call()

        self.assertEqual(result, (1, 18, 18, True))
        self.assertEqual(self.target.read_bytes(), b"before\r\nNEW\r\nafter")
        self.assertEqual(stat.S_IMODE(self.target.stat().st_mode), 0o640)

    def test_wrong_match_count_changes_nothing(self) -> None:
        self.target.write_bytes(b"OLD OLD")
        self.old.write_bytes(b"OLD")
        self.new.write_bytes(b"NEW")
        before = self.target.read_bytes()

        with self.assertRaisesRegex(MODULE.ReplaceExactError, "found 2"):
            self.call(expected=1)

        self.assertEqual(self.target.read_bytes(), before)

    def test_deletion_with_empty_replacement(self) -> None:
        self.target.write_bytes(b"before\nREMOVE\nafter\n")
        self.old.write_bytes(b"REMOVE\n")
        self.new.write_bytes(b"")

        self.call()

        self.assertEqual(self.target.read_bytes(), b"before\nafter\n")

    def test_empty_old_is_rejected(self) -> None:
        self.target.write_bytes(b"content")
        self.old.write_bytes(b"")
        self.new.write_bytes(b"replacement")

        with self.assertRaisesRegex(MODULE.ReplaceExactError, "must not be empty"):
            self.call()

        self.assertEqual(self.target.read_bytes(), b"content")

    def test_dry_run_changes_nothing(self) -> None:
        self.target.write_bytes(b"OLD")
        self.old.write_bytes(b"OLD")
        self.new.write_bytes(b"NEW")

        result = self.call(dry_run=True)

        self.assertEqual(result, (1, 3, 3, True))
        self.assertEqual(self.target.read_bytes(), b"OLD")

    def test_noop_is_reported_as_unchanged(self) -> None:
        self.target.write_bytes(b"SAME")
        self.old.write_bytes(b"SAME")
        self.new.write_bytes(b"SAME")

        completed = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--file",
                str(self.target),
                "--old",
                str(self.old),
                "--new",
                str(self.new),
            ],
            check=True,
            text=True,
            capture_output=True,
        )

        self.assertIn("unchanged 1 match(es)", completed.stdout)
        self.assertEqual(self.target.read_bytes(), b"SAME")

    def test_multiple_expected_matches(self) -> None:
        self.target.write_bytes(b"OLD OLD OLD")
        self.old.write_bytes(b"OLD")
        self.new.write_bytes(b"NEW")

        result = self.call(expected=3)

        self.assertEqual(result, (3, 11, 11, True))
        self.assertEqual(self.target.read_bytes(), b"NEW NEW NEW")

    def test_symlink_target_is_rejected(self) -> None:
        real = self.root / "real.bin"
        real.write_bytes(b"OLD")
        self.target.symlink_to(real)
        self.old.write_bytes(b"OLD")
        self.new.write_bytes(b"NEW")

        with self.assertRaisesRegex(MODULE.ReplaceExactError, "symbolic link"):
            self.call()

        self.assertEqual(real.read_bytes(), b"OLD")

    def test_directory_target_is_rejected(self) -> None:
        self.target.mkdir()
        self.old.write_bytes(b"OLD")
        self.new.write_bytes(b"NEW")

        with self.assertRaisesRegex(MODULE.ReplaceExactError, "regular file"):
            self.call()

    def test_post_replace_sync_failure_reports_applied_state(self) -> None:
        self.target.write_bytes(b"OLD")
        self.old.write_bytes(b"OLD")
        self.new.write_bytes(b"NEW")

        real_fsync = MODULE.os.fsync
        calls = 0

        def fail_second_fsync(fd: int) -> None:
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("simulated directory fsync failure")
            real_fsync(fd)

        with mock.patch.object(MODULE.os, "fsync", side_effect=fail_second_fsync):
            with self.assertRaisesRegex(
                MODULE.ReplacementAppliedButUnsyncedError,
                "Replacement was applied",
            ):
                self.call()

        self.assertEqual(self.target.read_bytes(), b"NEW")


    def test_concurrent_change_after_validation_is_not_overwritten(self) -> None:
        self.target.write_bytes(b"prefix OLD suffix")
        self.old.write_bytes(b"OLD")
        self.new.write_bytes(b"NEW")

        real_atomic_write = MODULE.atomic_write

        def concurrent_change(path, data, mode, expected_fingerprint):
            concurrent = path.with_name(f".{path.name}.concurrent")
            concurrent.write_bytes(b"CONCURRENT CHANGE")
            os.replace(concurrent, path)
            return real_atomic_write(path, data, mode, expected_fingerprint)

        with mock.patch.object(
            MODULE,
            "atomic_write",
            side_effect=concurrent_change,
        ):
            with self.assertRaisesRegex(
                MODULE.ReplaceExactError,
                "Target changed after validation",
            ):
                self.call()

        self.assertEqual(self.target.read_bytes(), b"CONCURRENT CHANGE")


    def test_direct_text_replacement(self) -> None:
        self.target.write_text("const limit = 10;\n", encoding="utf-8")

        completed = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--file",
                str(self.target),
                "--old-text",
                "const limit = 10;",
                "--new-text",
                "const limit = 20;",
            ],
            check=True,
            text=True,
            capture_output=True,
        )

        self.assertIn("replaced 1 match(es)", completed.stdout)
        self.assertEqual(
            self.target.read_text(encoding="utf-8"),
            "const limit = 20;\n",
        )

    def test_direct_text_deletion_requires_explicit_empty_argument(self) -> None:
        self.target.write_text("before obsolete after", encoding="utf-8")

        subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--file",
                str(self.target),
                "--old-text",
                "obsolete ",
                "--new-text",
                "",
            ],
            check=True,
            text=True,
            capture_output=True,
        )

        self.assertEqual(
            self.target.read_text(encoding="utf-8"),
            "before after",
        )

    def test_direct_text_is_utf8(self) -> None:
        self.target.write_bytes("hé OLD".encode("utf-8"))

        subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--file",
                str(self.target),
                "--old-text",
                "hé OLD",
                "--new-text",
                "hé NEW",
            ],
            check=True,
            text=True,
            capture_output=True,
        )

        self.assertEqual(self.target.read_bytes(), "hé NEW".encode("utf-8"))

    def test_file_and_text_input_are_mutually_exclusive(self) -> None:
        self.target.write_bytes(b"OLD")
        self.old.write_bytes(b"OLD")

        completed = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--file",
                str(self.target),
                "--old",
                str(self.old),
                "--old-text",
                "OLD",
                "--new-text",
                "NEW",
            ],
            text=True,
            capture_output=True,
        )

        self.assertEqual(completed.returncode, 2)
        self.assertIn("not allowed with argument", completed.stderr)
        self.assertEqual(self.target.read_bytes(), b"OLD")


if __name__ == "__main__":
    run_compact_unittest("replace-exact")
