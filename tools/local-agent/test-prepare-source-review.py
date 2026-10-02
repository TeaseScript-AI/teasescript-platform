#!/usr/bin/env python3
"""Fail-closed tests for prepare-source-review.py."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import unittest
import warnings
import zipfile

from compact_unittest import run_compact_unittest

SCRIPT = Path(__file__).parents[1] / "chatgpt-project-agent" / "tools" / "prepare-source-review.py"
REPOSITORY = "TeaseScript-AI/teasescript-platform"
# The target CLI is intentionally stdlib-only; skip ambient sitecustomize
# so host-specific packages cannot affect its subprocess boundary or startup cost.
STDLIB_PYTHON = (sys.executable, "-S")


def run(command: list[str], *, cwd: Path | None = None) -> str:
    completed = subprocess.run(
        command,
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if completed.returncode != 0:
        raise AssertionError(
            f"command failed: {' '.join(command)}\n"
            f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
        )
    return completed.stdout.strip()


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


class PrepareSourceReviewTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="prepare-source-review-")
        self.root = Path(self.temporary.name)
        self.repository = self.root / "repository"
        self.repository.mkdir()
        run(["git", "init", "-q", "-b", "main"], cwd=self.repository)
        run(["git", "config", "user.name", "Test"], cwd=self.repository)
        run(["git", "config", "user.email", "test@example.invalid"], cwd=self.repository)
        (self.repository / "example.txt").write_text("base\n", encoding="utf-8")
        run(["git", "add", "example.txt"], cwd=self.repository)
        run(["git", "commit", "-q", "-m", "Base"], cwd=self.repository)
        self.base = run(["git", "rev-parse", "HEAD"], cwd=self.repository)
        (self.repository / "example.txt").write_text("base\nhead\n", encoding="utf-8")
        run(["git", "commit", "-qam", "Head"], cwd=self.repository)
        self.head = run(["git", "rev-parse", "HEAD"], cwd=self.repository)
        self.tree = run(["git", "rev-parse", "HEAD^{tree}"], cwd=self.repository)
        run(["git", "update-ref", "refs/heads/source-bundle", self.head], cwd=self.repository)
        bundle_path = self.root / "repository.bundle"
        run(
            [
                "git",
                "bundle",
                "create",
                str(bundle_path),
                "HEAD",
                "refs/heads/source-bundle",
            ],
            cwd=self.repository,
        )
        self.bundle = bundle_path.read_bytes()
        self.manifest = {
            "formatVersion": 1,
            "repository": REPOSITORY,
            "commitSha": self.head,
            "treeSha": self.tree,
            "sourceRef": "test-source",
            "bundleRef": "refs/heads/source-bundle",
            "eventName": "test",
            "bundleSha256": sha256(self.bundle),
        }
        self.artifact = self.root / "artifact.zip"
        self.write_valid_artifact(self.artifact)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def manifest_bytes(self, value: dict[str, object] | None = None) -> bytes:
        return (json.dumps(value or self.manifest, indent=2) + "\n").encode()

    def valid_entries(
        self,
        *,
        manifest: bytes | None = None,
        bundle: bytes | None = None,
        checksums: bytes | None = None,
    ) -> dict[str, bytes]:
        actual_manifest = manifest if manifest is not None else self.manifest_bytes()
        actual_bundle = bundle if bundle is not None else self.bundle
        actual_checksums = checksums
        if actual_checksums is None:
            actual_checksums = (
                f"{sha256(actual_bundle)}  repository.bundle\n"
                f"{sha256(actual_manifest)}  manifest.json\n"
            ).encode()
        return {
            "repository.bundle": actual_bundle,
            "manifest.json": actual_manifest,
            "SHA256SUMS": actual_checksums,
        }

    def write_zip(
        self,
        path: Path,
        entries: list[tuple[str, bytes, int | None]],
    ) -> None:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                for name, value, mode in entries:
                    if mode is None:
                        archive.writestr(name, value)
                    else:
                        info = zipfile.ZipInfo(name)
                        info.create_system = 3
                        info.external_attr = mode << 16
                        archive.writestr(info, value)

    def write_valid_artifact(self, path: Path, **overrides: bytes) -> None:
        entries = self.valid_entries(**overrides)
        self.write_zip(path, [(name, value, None) for name, value in entries.items()])

    def set_unsupported_compression(self, path: Path, method: int = 99) -> None:
        value = bytearray(path.read_bytes())
        for signature, offset in ((b"PK\x03\x04", 8), (b"PK\x01\x02", 10)):
            start = 0
            while True:
                index = value.find(signature, start)
                if index < 0:
                    break
                value[index + offset : index + offset + 2] = method.to_bytes(2, "little")
                start = index + len(signature)
        path.write_bytes(value)

    def invoke(
        self,
        artifact: Path | None = None,
        *,
        output: Path | None = None,
        digest: str | None = None,
        repository: str = REPOSITORY,
        head: str | None = None,
        merge_base: str | None = None,
    ) -> subprocess.CompletedProcess[str]:
        actual_artifact = artifact or self.artifact
        actual_output = output or (self.root / "review")
        command = [
            *STDLIB_PYTHON,
            "-B",
            str(SCRIPT),
            "--artifact",
            str(actual_artifact),
            "--artifact-sha256",
            digest or sha256(actual_artifact.read_bytes()),
            "--expected-repository",
            repository,
            "--expected-head",
            head or self.head,
            "--expected-merge-base",
            merge_base or self.base,
            "--output",
            str(actual_output),
        ]
        return subprocess.run(command, text=True, capture_output=True, check=False)

    def assert_failure(self, completed: subprocess.CompletedProcess[str], text: str) -> None:
        self.assertEqual(completed.returncode, 1)
        self.assertEqual(completed.stdout, "")
        self.assertIn(text, completed.stderr)

    def test_success_creates_exact_clean_checkout_with_compact_output(self) -> None:
        output = self.root / "review"
        completed = self.invoke(output=output)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(len(completed.stdout.splitlines()), 1)
        self.assertIn("prepare-source-review: PASS", completed.stdout)
        self.assertEqual(run(["git", "rev-parse", "HEAD"], cwd=output), self.head)
        self.assertEqual(run(["git", "rev-parse", "HEAD^{tree}"], cwd=output), self.tree)
        self.assertEqual(run(["git", "status", "--porcelain"], cwd=output), "")
        self.assertEqual(run(["git", "remote"], cwd=output), "")

    def test_outer_digest_mismatch(self) -> None:
        completed = self.invoke(digest="0" * 64)
        self.assert_failure(completed, "outer artifact SHA-256 mismatch")

    def test_path_traversal_entry(self) -> None:
        entries = self.valid_entries()
        path = self.root / "traversal.zip"
        values = [(name, value, None) for name, value in entries.items()]
        values.append(("../escape", b"bad", None))
        self.write_zip(path, values)
        self.assert_failure(self.invoke(path), "unsafe ZIP entry")

    def test_absolute_entry(self) -> None:
        entries = self.valid_entries()
        path = self.root / "absolute.zip"
        values = [(name, value, None) for name, value in entries.items()]
        values.append(("/escape", b"bad", None))
        self.write_zip(path, values)
        self.assert_failure(self.invoke(path), "unsafe ZIP entry")

    def test_symlink_entry(self) -> None:
        entries = self.valid_entries()
        path = self.root / "symlink.zip"
        values = []
        for name, value in entries.items():
            mode = stat.S_IFLNK | 0o777 if name == "manifest.json" else None
            values.append((name, value, mode))
        self.write_zip(path, values)
        self.assert_failure(self.invoke(path), "symbolic-link ZIP entry")

    def test_duplicate_entry(self) -> None:
        entries = self.valid_entries()
        path = self.root / "duplicate.zip"
        values = [(name, value, None) for name, value in entries.items()]
        values.append(("manifest.json", entries["manifest.json"], None))
        self.write_zip(path, values)
        self.assert_failure(self.invoke(path), "duplicate ZIP entry")

    def test_missing_and_extra_payload_files(self) -> None:
        entries = self.valid_entries()
        valid = [(name, value, None) for name, value in entries.items()]
        cases = {
            "missing": [entry for entry in valid if entry[0] != "SHA256SUMS"],
            "extra": [*valid, ("extra.txt", b"extra", None)],
        }
        for name, values in cases.items():
            with self.subTest(name):
                path = self.root / f"shape-{name}.zip"
                self.write_zip(path, values)
                self.assert_failure(self.invoke(path), "unexpected artifact payload")

    def test_unsupported_zip_compression_is_compact_failure(self) -> None:
        path = self.root / "unsupported-compression.zip"
        self.write_valid_artifact(path)
        self.set_unsupported_compression(path)
        completed = self.invoke(path)
        self.assert_failure(completed, "cannot extract ZIP archive")
        self.assertNotIn("Traceback", completed.stderr)
        self.assertEqual(len(completed.stderr.splitlines()), 1)

    def test_internal_checksum_mismatch(self) -> None:
        path = self.root / "checksum.zip"
        entries = self.valid_entries()
        entries["manifest.json"] += b" "
        self.write_zip(path, [(name, value, None) for name, value in entries.items()])
        self.assert_failure(self.invoke(path), "SHA-256 mismatch for manifest.json")

    def test_malformed_manifest(self) -> None:
        path = self.root / "malformed.zip"
        self.write_valid_artifact(path, manifest=b"{not json}\n")
        self.assert_failure(self.invoke(path), "cannot parse manifest.json")

    def test_repository_mismatch(self) -> None:
        completed = self.invoke(repository="Other/Repository")
        self.assert_failure(completed, "repository mismatch")

    def test_head_mismatch(self) -> None:
        completed = self.invoke(head="1" * 40)
        self.assert_failure(completed, "head mismatch")

    def test_merge_base_absent_from_bundle_history(self) -> None:
        # A real sibling tip of the base exists locally but is not in the bundle.
        unbundled_sibling_tip = run(
            [
                "git",
                "commit-tree",
                self.tree,
                "-p",
                self.base,
                "-m",
                "Advanced base tip",
            ],
            cwd=self.repository,
        )
        for name, merge_base in (
            ("fabricated", "2" * 40),
            ("unbundled-sibling-tip", unbundled_sibling_tip),
        ):
            with self.subTest(name):
                completed = self.invoke(
                    output=self.root / f"review-{name}", merge_base=merge_base
                )
                self.assert_failure(
                    completed, "expected merge base is absent from bundle history"
                )

    def test_unrelated_bundled_commit_is_not_accepted_as_merge_base(self) -> None:
        unrelated = run(
            ["git", "commit-tree", self.tree, "-m", "Unrelated history"],
            cwd=self.repository,
        )
        run(
            ["git", "update-ref", "refs/heads/unrelated", unrelated],
            cwd=self.repository,
        )
        bundle_path = self.root / "unrelated.bundle"
        run(
            [
                "git",
                "bundle",
                "create",
                str(bundle_path),
                "HEAD",
                "refs/heads/source-bundle",
                "refs/heads/unrelated",
            ],
            cwd=self.repository,
        )
        bundle = bundle_path.read_bytes()
        manifest = dict(self.manifest)
        manifest["bundleSha256"] = sha256(bundle)
        artifact = self.root / "unrelated.zip"
        self.write_valid_artifact(
            artifact,
            manifest=self.manifest_bytes(manifest),
            bundle=bundle,
        )
        completed = self.invoke(artifact, merge_base=unrelated)
        self.assert_failure(
            completed,
            "expected merge base is not an ancestor of head",
        )

    def test_bundle_verification_failure(self) -> None:
        path = self.root / "bad-bundle.zip"
        bad_bundle = b"not a git bundle\n"
        manifest = dict(self.manifest)
        manifest["bundleSha256"] = sha256(bad_bundle)
        self.write_valid_artifact(
            path,
            manifest=self.manifest_bytes(manifest),
            bundle=bad_bundle,
        )
        output = self.root / "bad-bundle-review"
        self.assert_failure(self.invoke(path, output=output), "bundle")
        self.assertFalse(output.exists())

    def test_incomplete_bundle_fails_standalone_verification(self) -> None:
        bundle_path = self.root / "incomplete.bundle"
        run(
            [
                "git",
                "bundle",
                "create",
                str(bundle_path),
                "HEAD",
                "refs/heads/source-bundle",
                f"^{self.base}",
            ],
            cwd=self.repository,
        )
        incomplete = bundle_path.read_bytes()
        manifest = dict(self.manifest)
        manifest["bundleSha256"] = sha256(incomplete)
        path = self.root / "incomplete.zip"
        self.write_valid_artifact(
            path,
            manifest=self.manifest_bytes(manifest),
            bundle=incomplete,
        )
        output = self.root / "incomplete-review"
        self.assert_failure(self.invoke(path, output=output), "bundle")
        self.assertFalse(output.exists())

    def test_existing_output_path_is_rejected(self) -> None:
        output = self.root / "existing"
        output.mkdir()
        self.assert_failure(self.invoke(output=output), "output path already exists")

    def test_filesystem_failures_are_compact_and_name_the_path(self) -> None:
        # The rows reach different handlers; a row this platform cannot reproduce is skipped.
        parent_file = self.root / "existing-file"
        parent_file.write_text("not a directory\n", encoding="utf-8")
        unreadable = Path("/proc/self/mem")
        read_only_parent = Path("/sys")
        try:
            read_only = bool(os.statvfs(read_only_parent).f_flag & os.ST_RDONLY)
        except (AttributeError, OSError):
            read_only = False
        # Each row: name, reproducible here, pattern naming the offending path, invoke arguments.
        rows = (
            (
                "output parent is a file",
                True,
                re.escape(str(parent_file)),
                {"output": parent_file / "review"},
            ),
            (
                "unreadable artifact",
                unreadable.exists(),
                r"/proc/(?:self|\d+)/mem",
                {
                    "artifact": unreadable,
                    "output": self.root / "read-failure-review",
                    "digest": "0" * 64,
                },
            ),
            (
                "read-only output parent",
                read_only,
                re.escape(f"{read_only_parent}/"),
                {"output": read_only_parent / f"prepare-source-review-{os.getpid()}"},
            ),
        )
        for name, available, path_pattern, arguments in rows:
            with self.subTest(name):
                if not available:
                    self.skipTest(f"{name} cannot be reproduced on this platform")
                completed = self.invoke(**arguments)
                self.assertEqual(completed.returncode, 1)
                self.assertEqual(completed.stdout, "")
                self.assertEqual(len(completed.stderr.splitlines()), 1)
                self.assertNotIn("Traceback", completed.stderr)
                self.assertRegex(completed.stderr, path_pattern)

    def test_late_tree_mismatch_leaves_no_output_or_temporary_checkout(self) -> None:
        # The tree mismatch is detected only after extraction, bundle verification and cloning.
        path = self.root / "late-failure.zip"
        manifest = dict(self.manifest)
        manifest["treeSha"] = "3" * 40
        self.write_valid_artifact(path, manifest=self.manifest_bytes(manifest))
        output = self.root / "atomic-review"
        inventory = sorted(entry.name for entry in self.root.iterdir())
        self.assert_failure(self.invoke(path, output=output), "cloned tree mismatch")
        self.assertFalse(output.exists())
        self.assertEqual(sorted(entry.name for entry in self.root.iterdir()), inventory)

    def test_dangling_symlink_output_is_rejected(self) -> None:
        output = self.root / "dangling-output"
        os.symlink(self.root / "missing-target", output)
        self.assert_failure(self.invoke(output=output), "output path already exists")

    def test_symlink_artifact_argument_is_rejected(self) -> None:
        link = self.root / "artifact-link.zip"
        os.symlink(self.artifact, link)
        self.assert_failure(self.invoke(link), "regular non-symlink file")


if __name__ == "__main__":
    run_compact_unittest("prepare-source-review")
