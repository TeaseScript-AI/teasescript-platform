#!/usr/bin/env python3
"""Standard-library regression tests for patch-publication.py."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("patch-publication.py")
TRANSFER_BRANCH = "agent-patch-publication/test-request"
TARGET_BRANCH = "feat/test-target"


def run(
    args: list[str],
    *,
    cwd: Path,
    check: bool = True,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        args,
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        env=env,
    )
    if check and completed.returncode != 0:
        raise AssertionError(
            f"command failed: {' '.join(args)}\n"
            f"stdout: {completed.stdout}\nstderr: {completed.stderr}"
        )
    return completed


def git(repository: Path, *args: str) -> str:
    return run(["git", *args], cwd=repository).stdout.strip()


class PatchPublicationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        git(self.repo, "init", "-q", "-b", "main")
        git(self.repo, "config", "user.name", "Test User")
        git(self.repo, "config", "user.email", "test@example.invalid")
        (self.repo / "example.txt").write_text("before\n", encoding="utf-8")
        git(self.repo, "add", "example.txt")
        git(self.repo, "commit", "-q", "-m", "base")
        self.base_sha = git(self.repo, "rev-parse", "HEAD")

        (self.repo / "example.txt").write_text("after\n", encoding="utf-8")
        (self.repo / "added.txt").write_text("new\n", encoding="utf-8")
        git(self.repo, "add", "example.txt", "added.txt")
        self.result_tree = git(self.repo, "write-tree")
        self.patch = self.root / "change.patch"
        self.patch.write_bytes(
            subprocess.run(
                ["git", "diff", "--cached", "--binary", "--full-index"],
                cwd=self.repo,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=True,
            ).stdout
        )
        git(self.repo, "reset", "--hard", "-q", self.base_sha)
        self.manifest = self.root / "manifest.json"
        self.output = self.root / "output"
        self.write_manifest()

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def write_manifest(self, **overrides: object) -> None:
        value: dict[str, object] = {
            "formatVersion": 1,
            "targetBranch": TARGET_BRANCH,
            "expectedBaseSha": self.base_sha,
            "expectedResultTreeSha": self.result_tree,
            "patchSha256": hashlib.sha256(self.patch.read_bytes()).hexdigest(),
            "commitMessage": "Apply tested local patch",
        }
        value.update(overrides)
        self.manifest.write_text(
            json.dumps(value, indent=2) + "\n", encoding="utf-8"
        )

    def command(self, command: str, *extra: str) -> list[str]:
        args = [
            sys.executable,
            str(SCRIPT),
            command,
            "--repository",
            str(self.repo),
        ]
        if command in {"inspect-request", "prepare"}:
            args.extend(
                [
                    "--manifest",
                    str(self.manifest),
                    "--patch",
                    str(self.patch),
                    "--transfer-branch",
                    TRANSFER_BRANCH,
                    "--default-branch",
                    "main",
                ]
            )
        args.extend(extra)
        return args

    def test_prepare_and_verify_bundle_round_trip(self) -> None:
        env = os.environ.copy()
        env.update(
            {
                "GIT_AUTHOR_DATE": "2000-01-01T00:00:00+00:00",
                "GIT_COMMITTER_DATE": "2000-01-01T00:00:00+00:00",
            }
        )
        completed = run(
            self.command(
                "prepare", "--output-directory", str(self.output)
            ),
            cwd=self.repo,
            env=env,
        )
        self.assertIn("prepared patch publication", completed.stdout)
        metadata = json.loads(
            (self.output / "publication.json").read_text(encoding="utf-8")
        )
        self.assertEqual(metadata["expectedBaseSha"], self.base_sha)
        self.assertEqual(metadata["expectedResultTreeSha"], self.result_tree)
        self.assertTrue((self.output / "publication.bundle").is_file())

        verify_repo = self.root / "verify"
        run(["git", "clone", "-q", str(self.repo), str(verify_repo)], cwd=self.root)
        verified = run(
            [
                sys.executable,
                str(SCRIPT),
                "verify-bundle",
                "--repository",
                str(verify_repo),
                "--metadata",
                str(self.output / "publication.json"),
                "--bundle",
                str(self.output / "publication.bundle"),
            ],
            cwd=verify_repo,
        )
        self.assertIn("verified publication bundle", verified.stdout)
        candidate = metadata["candidateCommitSha"]
        self.assertEqual(
            git(verify_repo, "show", "-s", "--format=%P", candidate), self.base_sha
        )
        self.assertEqual(
            git(verify_repo, "show", "-s", "--format=%T", candidate), self.result_tree
        )

    def test_inspect_rejects_wrong_patch_digest(self) -> None:
        self.write_manifest(patchSha256="0" * 64)
        completed = run(
            self.command("inspect-request"), cwd=self.repo, check=False
        )
        self.assertEqual(completed.returncode, 1)
        self.assertIn("patch SHA-256 mismatch", completed.stderr)

    def test_prepare_rejects_wrong_checked_out_base(self) -> None:
        (self.repo / "other.txt").write_text("other\n", encoding="utf-8")
        git(self.repo, "add", "other.txt")
        git(self.repo, "commit", "-q", "-m", "other")
        completed = run(
            self.command("prepare", "--output-directory", str(self.output)),
            cwd=self.repo,
            check=False,
        )
        self.assertEqual(completed.returncode, 1)
        self.assertIn("checked-out base mismatch", completed.stderr)

    def test_prepare_rejects_wrong_result_tree(self) -> None:
        self.write_manifest(expectedResultTreeSha="0" * 40)
        completed = run(
            self.command("prepare", "--output-directory", str(self.output)),
            cwd=self.repo,
            check=False,
        )
        self.assertEqual(completed.returncode, 1)
        self.assertIn("result tree mismatch", completed.stderr)

    def test_manifest_rejects_duplicate_fields(self) -> None:
        raw = self.manifest.read_text(encoding="utf-8").rstrip()[:-1]
        raw += ',\n  "targetBranch": "feat/other"\n}\n'
        self.manifest.write_text(raw, encoding="utf-8")
        completed = run(
            self.command("inspect-request"), cwd=self.repo, check=False
        )
        self.assertEqual(completed.returncode, 1)
        self.assertIn("duplicate JSON field", completed.stderr)

    def test_comment_bound_pull_request_must_match_target(self) -> None:
        completed = run(
            self.command(
                "inspect-request", "--expected-target-branch", "feat/different"
            ),
            cwd=self.repo,
            check=False,
        )
        self.assertEqual(completed.returncode, 1)
        self.assertIn("does not match the commented pull request", completed.stderr)

    def test_target_cannot_be_default_or_transfer_namespace(self) -> None:
        for branch in ("main", "agent-patch-publication/not-a-target"):
            with self.subTest(branch=branch):
                self.write_manifest(targetBranch=branch)
                completed = run(
                    self.command("inspect-request"), cwd=self.repo, check=False
                )
                self.assertEqual(completed.returncode, 1)

    def test_patch_cannot_modify_transfer_directory(self) -> None:
        transfer_file = self.repo / ".agent-patch-publication" / "payload.txt"
        transfer_file.parent.mkdir()
        transfer_file.write_text("forbidden\n", encoding="utf-8")
        git(self.repo, "add", str(transfer_file.relative_to(self.repo)))
        self.result_tree = git(self.repo, "write-tree")
        self.patch.write_bytes(
            subprocess.run(
                ["git", "diff", "--cached", "--binary", "--full-index"],
                cwd=self.repo,
                stdout=subprocess.PIPE,
                check=True,
            ).stdout
        )
        git(self.repo, "reset", "--hard", "-q", self.base_sha)
        self.write_manifest()
        completed = run(
            self.command("prepare", "--output-directory", str(self.output)),
            cwd=self.repo,
            check=False,
        )
        self.assertEqual(completed.returncode, 1)
        self.assertIn("must not modify the transfer directory", completed.stderr)

    def test_verify_rejects_tampered_metadata(self) -> None:
        env = os.environ.copy()
        env.update(
            {
                "GIT_AUTHOR_DATE": "2000-01-01T00:00:00+00:00",
                "GIT_COMMITTER_DATE": "2000-01-01T00:00:00+00:00",
            }
        )
        run(
            self.command("prepare", "--output-directory", str(self.output)),
            cwd=self.repo,
            env=env,
        )
        metadata_path = self.output / "publication.json"
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        metadata["expectedResultTreeSha"] = "0" * 40
        metadata_path.write_text(json.dumps(metadata) + "\n", encoding="utf-8")
        completed = run(
            [
                sys.executable,
                str(SCRIPT),
                "verify-bundle",
                "--repository",
                str(self.repo),
                "--metadata",
                str(metadata_path),
                "--bundle",
                str(self.output / "publication.bundle"),
            ],
            cwd=self.repo,
            check=False,
        )
        self.assertEqual(completed.returncode, 1)
        self.assertIn("candidate tree mismatch", completed.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
