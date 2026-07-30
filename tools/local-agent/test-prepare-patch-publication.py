#!/usr/bin/env python3
"""Focused regressions for token-aware sequential payload preparation."""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools/local-agent"
PREPARE = TOOLS / "prepare-patch-publication.py"
sys.path.insert(0, str(TOOLS))

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
                "1",
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

        shown = run(
            [sys.executable, str(PREPARE), "--output-directory", str(output), "--show-next-upload"],
            cwd=repository,
        )
        self.assertIn(first["path"], shown.stdout)
        self.assertNotIn(second["path"], shown.stdout)
        self.assertIn('"encoding": "utf-8"', shown.stdout)

        wrong = run(
            [
                sys.executable,
                str(PREPARE),
                "--output-directory",
                str(output),
                "--record-upload-sha",
                "0" * 40,
            ],
            cwd=repository,
            check=False,
        )
        self.assertEqual(wrong.returncode, 1)
        self.assertIn("do not advance", wrong.stderr)
        state = json.loads((output / "upload-state.json").read_text())
        self.assertEqual(state["completedUploads"], [])

        recorded = run(
            [
                sys.executable,
                str(PREPARE),
                "--output-directory",
                str(output),
                "--record-upload-sha",
                first["expectedGitBlobSha"],
            ],
            cwd=repository,
        )
        self.assertIn("nextUploadIndex=2", recorded.stdout)
        shown_second = run(
            [sys.executable, str(PREPARE), "--output-directory", str(output), "--show-next-upload"],
            cwd=repository,
        )
        self.assertIn(second["path"], shown_second.stdout)
        self.assertNotIn(first["path"], shown_second.stdout)

        reset = run(
            [
                sys.executable,
                str(PREPARE),
                "--output-directory",
                str(output),
                "--reset-upload-index",
                str(first["index"]),
            ],
            cwd=repository,
        )
        self.assertIn(f"resetUpload={first['index']}", reset.stdout)
        shown_first_again = run(
            [sys.executable, str(PREPARE), "--output-directory", str(output), "--show-next-upload"],
            cwd=repository,
        )
        self.assertIn(first["path"], shown_first_again.stdout)
        self.assertNotIn(second["path"], shown_first_again.stdout)

        rerecorded = run(
            [
                sys.executable,
                str(PREPARE),
                "--output-directory",
                str(output),
                "--record-upload-sha",
                first["expectedGitBlobSha"],
            ],
            cwd=repository,
        )
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
        final = run(
            [sys.executable, str(PREPARE), "--output-directory", str(output), "--show-next-upload"],
            cwd=repository,
        )
        self.assertIn("createTreeArguments=", final.stdout)
        self.assertIn('"tree_elements":', final.stdout)
        self.assertIn(f'"parent_sha": "{base}"', final.stdout)
        self.assertIn(plan["publicationCommand"], final.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
