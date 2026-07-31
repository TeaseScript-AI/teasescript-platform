#!/usr/bin/env python3
"""Standard-library tests for extract-exact-context.py."""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest

from pathlib import Path
from unittest import mock

from compact_unittest import run_compact_unittest


SCRIPT = Path(__file__).with_name("extract-exact-context.py")
SPEC = importlib.util.spec_from_file_location("extract_exact_context", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class ExtractExactContextTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.target = self.root / "target.bin"

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def run_cli(self, *arguments: str) -> subprocess.CompletedProcess[bytes]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), *arguments],
            capture_output=True,
            check=False,
        )

    def test_unique_direct_anchors_emit_only_inclusive_raw_bytes(self) -> None:
        self.target.write_bytes(b"header\r\nSTART\r\nbody\x00\r\nEND\r\nfooter")

        completed = self.run_cli(
            "--file",
            str(self.target),
            "--start-text",
            "START",
            "--end-text",
            "END",
        )

        self.assertEqual(completed.returncode, 0)
        self.assertEqual(completed.stdout, b"START\r\nbody\x00\r\nEND")
        self.assertEqual(completed.stderr, b"")

    def test_byte_exact_anchor_files_support_non_utf8_bytes(self) -> None:
        start = self.root / "start.bin"
        end = self.root / "end.bin"
        start.write_bytes(b"\xffSTART")
        end.write_bytes(b"END\xfe")
        self.target.write_bytes(b"prefix\xffSTART\x80middleEND\xfesuffix")

        completed = self.run_cli(
            "--file",
            str(self.target),
            "--start-file",
            str(start),
            "--end-file",
            str(end),
        )

        self.assertEqual(completed.returncode, 0)
        self.assertEqual(completed.stdout, b"\xffSTART\x80middleEND\xfe")
        self.assertEqual(completed.stderr, b"")

    def test_repeated_start_fails_with_three_bounded_locations(self) -> None:
        self.target.write_bytes(b"START one\nSTART two\nSTART three\nSTART four\nEND\n")

        completed = self.run_cli(
            "--file",
            str(self.target),
            "--start-text",
            "START",
            "--end-text",
            "END",
        )

        self.assertEqual(completed.returncode, 1)
        self.assertEqual(completed.stdout, b"")
        self.assertIn(b"found at least 4", completed.stderr)
        self.assertEqual(completed.stderr.count(b"- "), 3)
        self.assertIn(b"no context was emitted", completed.stderr)

    def test_repeated_end_fails_instead_of_choosing_nearest(self) -> None:
        self.target.write_bytes(b"START\nEND one\nEND two\n")

        completed = self.run_cli(
            "--file",
            str(self.target),
            "--start-text",
            "START",
            "--end-text",
            "END",
        )

        self.assertEqual(completed.returncode, 1)
        self.assertEqual(completed.stdout, b"")
        self.assertIn(b"end anchor expected 1 match, found 2", completed.stderr)

    def test_missing_anchor_fails_without_fuzzy_guess(self) -> None:
        self.target.write_bytes(b"START\nbody\nEND\n")

        completed = self.run_cli(
            "--file",
            str(self.target),
            "--start-text",
            "STALE START",
            "--end-text",
            "END",
        )

        self.assertEqual(completed.returncode, 1)
        self.assertEqual(completed.stdout, b"")
        self.assertIn(b"start anchor expected 1 match, found 0", completed.stderr)
        self.assertNotIn(b"nearest", completed.stderr)

    def test_end_before_start_fails_with_locations(self) -> None:
        self.target.write_bytes(b"END\nmiddle\nSTART\n")

        completed = self.run_cli(
            "--file",
            str(self.target),
            "--start-text",
            "START",
            "--end-text",
            "END",
        )

        self.assertEqual(completed.returncode, 1)
        self.assertEqual(completed.stdout, b"")
        self.assertIn(b"end anchor occurs before start anchor", completed.stderr)
        self.assertIn(b":3", completed.stderr)
        self.assertIn(b":1", completed.stderr)

    def test_overlapping_boundaries_fail_instead_of_truncating_start_anchor(self) -> None:
        self.target.write_bytes(b"ABCDE suffix")

        completed = self.run_cli(
            "--file",
            str(self.target),
            "--start-text",
            "ABCDE",
            "--end-text",
            "BCD",
        )

        self.assertEqual(completed.returncode, 1)
        self.assertEqual(completed.stdout, b"")
        self.assertIn(b"anchors overlap", completed.stderr)

    def test_empty_direct_anchor_is_rejected(self) -> None:
        self.target.write_bytes(b"START END")

        completed = self.run_cli(
            "--file",
            str(self.target),
            "--start-text",
            "",
            "--end-text",
            "END",
        )

        self.assertEqual(completed.returncode, 1)
        self.assertEqual(completed.stdout, b"")
        self.assertIn(b"start anchor must not be empty", completed.stderr)

    def test_overlapping_anchor_occurrences_are_ambiguous(self) -> None:
        self.target.write_bytes(b"aaa END")

        completed = self.run_cli(
            "--file",
            str(self.target),
            "--start-text",
            "aa",
            "--end-text",
            "END",
        )

        self.assertEqual(completed.returncode, 1)
        self.assertIn(b"start anchor expected 1 match, found 2", completed.stderr)

    def test_symlink_and_directory_targets_are_rejected(self) -> None:
        real = self.root / "real.bin"
        real.write_bytes(b"START END")
        symlink = self.root / "symlink.bin"
        symlink.symlink_to(real)

        symlink_result = self.run_cli(
            "--file",
            str(symlink),
            "--start-text",
            "START",
            "--end-text",
            "END",
        )
        directory_result = self.run_cli(
            "--file",
            str(self.root),
            "--start-text",
            "START",
            "--end-text",
            "END",
        )

        self.assertEqual(symlink_result.returncode, 1)
        self.assertIn(b"symbolic link", symlink_result.stderr)
        self.assertEqual(directory_result.returncode, 1)
        self.assertIn(b"regular file", directory_result.stderr)

    def test_target_file_limit_is_enforced_before_output(self) -> None:
        with self.target.open("wb") as target_file:
            target_file.truncate(MODULE.MAX_TARGET_BYTES + 1)

        completed = self.run_cli(
            "--file",
            str(self.target),
            "--start-text",
            "START",
            "--end-text",
            "END",
        )

        self.assertEqual(completed.returncode, 1)
        self.assertEqual(completed.stdout, b"")
        self.assertIn(b"limit is 16777216", completed.stderr)

    def test_selected_byte_limit_is_context_efficient(self) -> None:
        body = b"x" * MODULE.MAX_SELECTED_BYTES
        self.target.write_bytes(b"START" + body + b"END")

        completed = self.run_cli(
            "--file",
            str(self.target),
            "--start-text",
            "START",
            "--end-text",
            "END",
        )

        self.assertEqual(completed.returncode, 1)
        self.assertEqual(completed.stdout, b"")
        self.assertIn(b"selected region is", completed.stderr)
        self.assertIn(b"limit is 16384", completed.stderr)

    def test_selected_line_limit_is_context_efficient(self) -> None:
        selected = b"START\n" + (b"line\n" * (MODULE.MAX_SELECTED_LINES - 1)) + b"END"
        self.target.write_bytes(selected)

        completed = self.run_cli(
            "--file",
            str(self.target),
            "--start-text",
            "START",
            "--end-text",
            "END",
        )

        self.assertEqual(completed.returncode, 1)
        self.assertEqual(completed.stdout, b"")
        self.assertIn(b"selected region is 201 lines", completed.stderr)
        self.assertIn(b"limit is 200", completed.stderr)

    def test_oversized_anchor_file_is_rejected(self) -> None:
        anchor = self.root / "anchor.bin"
        anchor.write_bytes(b"x" * (MODULE.MAX_ANCHOR_BYTES + 1))
        self.target.write_bytes(b"START END")

        completed = self.run_cli(
            "--file",
            str(self.target),
            "--start-file",
            str(anchor),
            "--end-text",
            "END",
        )

        self.assertEqual(completed.returncode, 1)
        self.assertEqual(completed.stdout, b"")
        self.assertIn(b"start anchor exceeds 16384 bytes", completed.stderr)

    def test_target_change_after_read_fails_before_output(self) -> None:
        self.target.write_bytes(b"START body END")
        real_check = MODULE.require_unchanged_target

        def change_then_check(path: Path, expected) -> None:
            replacement = path.with_name("replacement.bin")
            replacement.write_bytes(b"changed")
            os.replace(replacement, path)
            real_check(path, expected)

        with mock.patch.object(
            MODULE,
            "require_unchanged_target",
            side_effect=change_then_check,
        ):
            with self.assertRaisesRegex(
                MODULE.ExtractExactContextError,
                "target changed after it was read",
            ):
                MODULE.extract_exact_context(self.target, b"START", b"END")

    def test_target_change_between_lstat_and_open_is_rejected(self) -> None:
        self.target.write_bytes(b"START body END")
        replacement = self.root / "replacement.bin"
        replacement.write_bytes(b"START changed END")
        real_open = MODULE.os.open
        changed = False

        def change_then_open(path, flags):
            nonlocal changed
            if Path(path) == self.target and not changed:
                changed = True
                os.replace(replacement, self.target)
            return real_open(path, flags)

        with mock.patch.object(MODULE.os, "open", side_effect=change_then_open):
            with self.assertRaisesRegex(
                MODULE.ExtractExactContextError,
                "target changed while being opened",
            ):
                MODULE.extract_exact_context(self.target, b"START", b"END")

    def test_control_characters_in_paths_do_not_inject_diagnostic_lines(self) -> None:
        unusual = self.root / "target\nwith-tab\t.bin"
        unusual.write_bytes(b"START\nSTART\nEND")

        completed = self.run_cli(
            "--file",
            str(unusual),
            "--start-text",
            "START",
            "--end-text",
            "END",
        )

        self.assertEqual(completed.returncode, 1)
        self.assertIn(b"target\\nwith-tab\\t.bin", completed.stderr)
        self.assertNotIn(b"target\nwith-tab\t.bin", completed.stderr)

    def test_diagnostic_output_is_hard_bounded(self) -> None:
        nested = self.root
        for index in range(12):
            nested = nested / (f"segment-{index}-" + "x" * 40)
            nested.mkdir()
        long_target = nested / "target.bin"
        long_target.write_bytes(b"START\nSTART\nSTART\nSTART\nEND")

        completed = self.run_cli(
            "--file",
            str(long_target),
            "--start-text",
            "START",
            "--end-text",
            "END",
        )

        self.assertEqual(completed.returncode, 1)
        self.assertEqual(completed.stdout, b"")
        self.assertLessEqual(len(completed.stderr), MODULE.MAX_DIAGNOSTIC_BYTES)
        self.assertTrue(completed.stderr.endswith(b"no context was emitted\n"))

    def test_file_and_text_anchor_inputs_are_mutually_exclusive(self) -> None:
        anchor = self.root / "anchor.bin"
        anchor.write_bytes(b"START")
        self.target.write_bytes(b"START END")

        completed = self.run_cli(
            "--file",
            str(self.target),
            "--start-file",
            str(anchor),
            "--start-text",
            "START",
            "--end-text",
            "END",
        )

        self.assertEqual(completed.returncode, 2)
        self.assertEqual(completed.stdout, b"")
        self.assertIn(b"not allowed with argument", completed.stderr)


if __name__ == "__main__":
    run_compact_unittest("extract-exact-context")
