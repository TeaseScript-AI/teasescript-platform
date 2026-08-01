#!/usr/bin/env python3
"""Focused regressions for token-aware sequential payload preparation."""

from __future__ import annotations

import gzip
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest

from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from compact_unittest import run_compact_unittest

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools/local-agent"
FIXTURES = TOOLS / "fixtures"
PREPARE = TOOLS / "prepare-patch-publication.py"
PR_174_PATCH_GZIP = FIXTURES / "pr-174-remove-v1.patch.gz"
sys.path.insert(0, str(TOOLS))

import patch_publication_plan as PLAN
import patch_publication_support as SUPPORT

SPEC = importlib.util.spec_from_file_location("prepare_patch_publication", PREPARE)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def run(args: list[str], *, cwd: Path, check: bool = True) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    environment.pop("TEASESCRIPT_O200K_TOKENIZER", None)
    completed = subprocess.run(
        args,
        cwd=cwd,
        env=environment,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if check and completed.returncode != 0:
        raise AssertionError(
            f"command failed: {' '.join(args)}\n"
            f"stdout: {completed.stdout}\nstderr: {completed.stderr}"
        )
    return completed


def git(repository: Path, *args: str) -> str:
    return run(["git", *args], cwd=repository).stdout.strip()


def run_cli(*args: str) -> subprocess.CompletedProcess[str]:
    stdout = io.StringIO()
    stderr = io.StringIO()
    original_argv = sys.argv
    try:
        sys.argv = [str(PREPARE), *args]
        with redirect_stdout(stdout), redirect_stderr(stderr):
            returncode = MODULE.main()
    finally:
        sys.argv = original_argv
    return subprocess.CompletedProcess(
        args=[str(PREPARE), *args],
        returncode=returncode,
        stdout=stdout.getvalue(),
        stderr=stderr.getvalue(),
    )


class PreparePatchPublicationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_token_bounded_split_reconstructs_exact_patch(self) -> None:
        patch = (
            "diff --git a/a.txt b/a.txt\n"
            + "alpha beta gamma\n" * 40
            + "diff --git a/b.txt b/b.txt\n"
            + "delta epsilon zeta\n" * 40
        ).encode()

        def count_tokens(value: bytes) -> int:
            return len(json.dumps(value.decode(), ensure_ascii=False))

        parts, counts = MODULE.split_utf8_patch(
            patch,
            maximum_bytes=512,
            target_tokens=180,
            count_tokens=count_tokens,
        )
        self.assertEqual(b"".join(parts), patch)
        self.assertGreater(len(parts), 2)
        self.assertTrue(all(len(part) <= 512 for part in parts))
        self.assertTrue(all(count is not None and count <= 180 for count in counts))

    def test_semantic_boundary_does_not_increase_minimum_part_count(self) -> None:
        patch = bytearray(b"x" * 301)
        marker = b"\ndiff --git "
        for offset in range(51, len(patch), 51):
            if offset + len(marker) <= len(patch):
                patch[offset : offset + len(marker)] = marker

        parts, counts = SUPPORT.split_utf8_patch(
            bytes(patch),
            maximum_bytes=100,
            target_tokens=100,
            count_tokens=len,
        )

        self.assertEqual(b"".join(parts), patch)
        self.assertEqual(len(parts), 4)
        self.assertTrue(all(len(part) <= 100 for part in parts))
        self.assertTrue(all(count is not None and count <= 100 for count in counts))

    def test_byte_fallback_preserves_minimum_count_across_utf8_boundaries(self) -> None:
        patch = b"xx\n" + ("é" * 5).encode()

        parts, counts = SUPPORT.split_utf8_patch(
            patch,
            maximum_bytes=5,
        )

        self.assertEqual(b"".join(parts), patch)
        self.assertEqual(len(parts), 3)
        self.assertTrue(all(len(part) <= 5 for part in parts))
        self.assertTrue(all(part.decode("utf-8") for part in parts))
        self.assertEqual(counts, [None, None, None])

    def test_semantic_boundary_is_kept_when_part_count_stays_minimal(self) -> None:
        marker = b"\ndiff --git "
        patch = b"x" * 85 + marker + b"y" * 70

        parts, _ = SUPPORT.split_utf8_patch(
            patch,
            maximum_bytes=100,
            target_tokens=100,
            count_tokens=len,
        )

        self.assertEqual(len(parts), 2)
        self.assertTrue(parts[0].endswith(b"\n"))
        self.assertTrue(parts[1].startswith(b"diff --git "))
        self.assertEqual(b"".join(parts), patch)

    def test_unusable_preferred_boundary_falls_back_to_bounded_end(self) -> None:
        patch = b"aaaaa\nQbbbbbbbb"

        def count_tokens(value: bytes) -> int:
            return 100 if value.startswith(b"Q") else len(value)

        parts, counts = SUPPORT.split_utf8_patch(
            patch,
            maximum_bytes=10,
            target_tokens=10,
            count_tokens=count_tokens,
        )

        self.assertEqual(parts, [patch[:10], patch[10:]])
        self.assertEqual(counts, [10, 5])
        self.assertEqual(b"".join(parts), patch)

    def test_transfer_branch_matches_workflow_contract(self) -> None:
        repository = self.root / "branch-repository"
        repository.mkdir()
        git(repository, "init", "-q", "-b", "main")

        valid = SUPPORT.TRANSFER_PREFIX + (
            "a" * (240 - len(SUPPORT.TRANSFER_PREFIX))
        )
        self.assertEqual(len(valid), 240)
        self.assertEqual(
            SUPPORT.validate_transfer_branch(valid, repository=repository), valid
        )

        invalid = {
            "too long": SUPPORT.TRANSFER_PREFIX
            + ("a" * (241 - len(SUPPORT.TRANSFER_PREFIX))),
            "unicode": SUPPORT.TRANSFER_PREFIX + "caf\u00e9",
            "prefix only": SUPPORT.TRANSFER_PREFIX,
            "double dot": SUPPORT.TRANSFER_PREFIX + "a..b",
            "double slash": SUPPORT.TRANSFER_PREFIX + "a//b",
            "trailing slash": SUPPORT.TRANSFER_PREFIX + "a/",
        }
        for label, branch in invalid.items():
            with self.subTest(label=label), self.assertRaises(
                SUPPORT.PreparationError
            ):
                SUPPORT.validate_transfer_branch(branch, repository=repository)

    def test_manifest_token_budget_is_enforced(self) -> None:
        temp_root = self.root / "token-budget"
        part_path = (
            temp_root
            / SUPPORT.PART_DIRECTORY
            / "change.patch.part-0001-of-0001"
        )
        part_path.parent.mkdir(parents=True)
        part_value = b"part\n"
        part_path.write_bytes(part_value)
        manifest_path = temp_root / SUPPORT.TRANSFER_DIRECTORY / "manifest.json"
        manifest_value = b'{"formatVersion": 2}\n'
        manifest_path.write_bytes(manifest_value)

        def count_tokens(value: bytes) -> int:
            return 101 if value == manifest_value else 1

        with self.assertRaisesRegex(
            SUPPORT.PreparationError,
            "manifest connector upload is estimated at 101 tokens",
        ):
            PLAN.upload_files_for_plan(
                temp_root=temp_root,
                manifest_path=manifest_path,
                manifest_parts=[{"path": str(part_path.relative_to(temp_root))}],
                token_counts=[1],
                count_tokens=count_tokens,
                maximum_upload_size_bytes=1024,
                target_upload_tokens=100,
            )

    def test_many_part_manifest_exceeding_byte_budget_fails(self) -> None:
        repository = self.root / "many-parts"
        repository.mkdir()
        git(repository, "init", "-q", "-b", "main")
        git(repository, "config", "user.name", "Test")
        git(repository, "config", "user.email", "test@example.invalid")
        (repository / "base.txt").write_text("base\n")
        git(repository, "add", "base.txt")
        git(repository, "commit", "-q", "-m", "Base")
        base = git(repository, "rev-parse", "HEAD")

        (repository / "large.txt").write_text("ordinary text line\n" * 70_000)
        git(repository, "add", "large.txt")
        git(repository, "commit", "-q", "-m", "Add large text file")

        output = self.root / "oversized-manifest"
        prepared = run(
            [
                sys.executable,
                str(PREPARE),
                "--repository",
                str(repository),
                "--repository-full-name",
                "TeaseScript-AI/teasescript-platform",
                "--target-branch",
                "feat/test-target",
                "--expected-base-sha",
                base,
                "--output-directory",
                str(output),
            ],
            cwd=repository,
            check=False,
        )
        self.assertEqual(prepared.returncode, 1)
        self.assertIn("manifest connector upload is", prepared.stderr)
        self.assertIn("configured 12288-byte upload ceiling", prepared.stderr)
        self.assertFalse(output.exists())

    def test_real_o200k_estimator_when_available(self) -> None:
        configured = os.environ.get("TEASESCRIPT_O200K_TOKENIZER")
        if configured is None or importlib.util.find_spec("tiktoken") is None:
            self.skipTest(
                "requires local TEASESCRIPT_O200K_TOKENIZER and importable tiktoken"
            )
        estimator = SUPPORT.load_token_estimator(Path(configured))
        patch = gzip.decompress(PR_174_PATCH_GZIP.read_bytes())
        self.assertEqual(len(patch), 43_250)
        self.assertEqual(
            SUPPORT.sha256_bytes(patch),
            "72ea10b56777779e920d1ea1e880ac20e6398fec273c40d88fd4f76d0be32a54",
        )
        parts, counts = SUPPORT.split_utf8_patch(
            patch,
            maximum_bytes=12 * 1024,
            target_tokens=3_000,
            count_tokens=estimator.count_bytes,
        )
        self.assertEqual(b"".join(parts), patch)
        self.assertEqual(len(parts), 4)
        self.assertTrue(all(len(part) <= 12 * 1024 for part in parts))
        self.assertTrue(all(count is not None and count <= 3_000 for count in counts))
        self.assertEqual(estimator.vocabulary_sha256, SUPPORT.O200K_BASE_SHA256)

    def test_multi_commit_range_and_one_file_at_a_time_upload(self) -> None:
        repository = self.root / "repository"
        repository.mkdir()
        git(repository, "init", "-q", "-b", "main")
        git(repository, "config", "user.name", "Test")
        git(repository, "config", "user.email", "test@example.invalid")
        (repository / "base.txt").write_text("base\n")
        git(repository, "add", "base.txt")
        git(repository, "commit", "-q", "-m", "Base")
        base = git(repository, "rev-parse", "HEAD")

        for name, marker in (("first.txt", "FIRST"), ("second.txt", "SECOND")):
            (repository / name).write_text(marker + "\n" + ("content line\n" * 400))
            git(repository, "add", name)
            git(repository, "commit", "-q", "-m", f"Add {name}")
        tested = git(repository, "rev-parse", "HEAD")

        output = self.root / "payload"
        prepared = run(
            [
                sys.executable,
                str(PREPARE),
                "--repository",
                str(repository),
                "--repository-full-name",
                "TeaseScript-AI/teasescript-platform",
                "--target-branch",
                "feat/test-target",
                "--expected-base-sha",
                base,
                "--tested-commit",
                tested,
                "--part-size-kib",
                "4",
                "--output-directory",
                str(output),
            ],
            cwd=repository,
        )
        self.assertIn("sizingMode=byteFallback", prepared.stdout)
        self.assertIn("prepare-patch-publication.py --output-directory", prepared.stdout)
        self.assertNotIn("patch_publication_prepare.py --output-directory", prepared.stdout)
        plan = json.loads((output / "upload-plan.json").read_text())
        self.assertEqual(plan["expectedBaseSha"], base)
        self.assertEqual(plan["testedCommitSha"], tested)
        self.assertGreater(len(plan["files"]), 2)
        first, second = plan["files"][:2]

        shown = run_cli("--output-directory", str(output), "--show-next-upload")
        self.assertEqual(shown.returncode, 0)
        self.assertIn(first["path"], shown.stdout)
        self.assertNotIn(second["path"], shown.stdout)
        self.assertIn('"encoding": "utf-8"', shown.stdout)

        wrong = run_cli(
            "--output-directory",
            str(output),
            "--record-upload-sha",
            "0" * 40,
        )
        self.assertEqual(wrong.returncode, 1)
        self.assertIn("do not advance", wrong.stderr)
        state = json.loads((output / "upload-state.json").read_text())
        self.assertEqual(state["completedUploads"], [])

        recorded = run_cli(
            "--output-directory",
            str(output),
            "--record-upload-sha",
            first["expectedGitBlobSha"],
        )
        self.assertEqual(recorded.returncode, 0)
        self.assertIn("nextUploadIndex=2", recorded.stdout)
        shown_second = run_cli(
            "--output-directory", str(output), "--show-next-upload"
        )
        self.assertEqual(shown_second.returncode, 0)
        self.assertIn(second["path"], shown_second.stdout)
        self.assertNotIn(first["path"], shown_second.stdout)

        reset = run_cli(
            "--output-directory",
            str(output),
            "--reset-upload-index",
            str(first["index"]),
        )
        self.assertEqual(reset.returncode, 0)
        self.assertIn(f"resetUpload={first['index']}", reset.stdout)
        shown_first_again = run_cli(
            "--output-directory", str(output), "--show-next-upload"
        )
        self.assertEqual(shown_first_again.returncode, 0)
        self.assertIn(first["path"], shown_first_again.stdout)
        self.assertNotIn(second["path"], shown_first_again.stdout)

        rerecorded = run_cli(
            "--output-directory",
            str(output),
            "--record-upload-sha",
            first["expectedGitBlobSha"],
        )
        self.assertEqual(rerecorded.returncode, 0)
        self.assertIn("nextUploadIndex=2", rerecorded.stdout)

        completed = {
            "stateVersion": 1,
            "completedUploads": [
                {
                    "index": item["index"],
                    "path": item["path"],
                    "gitBlobSha": item["expectedGitBlobSha"],
                }
                for item in plan["files"]
            ],
        }
        (output / "upload-state.json").write_text(json.dumps(completed) + "\n")
        final = run_cli("--output-directory", str(output), "--show-next-upload")
        self.assertEqual(final.returncode, 0)
        self.assertIn("createTreeArguments=", final.stdout)
        self.assertIn('"tree_elements":', final.stdout)
        self.assertIn(f'"parent_sha": "{base}"', final.stdout)
        self.assertIn(plan["publicationCommand"], final.stdout)


if __name__ == "__main__":
    run_compact_unittest("prepare-patch-publication")
