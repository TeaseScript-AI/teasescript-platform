#!/usr/bin/env python3
"""Standard-library regression tests for patch-publication.py."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

from pathlib import Path
from typing import Callable

from compact_unittest import run_compact_unittest


SCRIPT = Path(__file__).with_name("patch-publication.py")
PREPARE_SCRIPT = Path(__file__).with_name("prepare-patch-publication.py")
TRANSFER_BRANCH = "agent-patch-publication/test-request"
TARGET_BRANCH = "feat/test-target"
# The target CLI is intentionally stdlib-only; skip ambient sitecustomize
# so host-specific packages cannot affect its subprocess boundary or startup cost.
STDLIB_PYTHON = (sys.executable, "-S")

MODULE_SPEC = importlib.util.spec_from_file_location("patch_publication", SCRIPT)
assert MODULE_SPEC is not None and MODULE_SPEC.loader is not None
PATCH_PUBLICATION = importlib.util.module_from_spec(MODULE_SPEC)
sys.modules[MODULE_SPEC.name] = PATCH_PUBLICATION
MODULE_SPEC.loader.exec_module(PATCH_PUBLICATION)


def run(
    args: list[str],
    *,
    cwd: Path,
    check: bool = True,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy() if env is None else env.copy()
    environment.pop("TEASESCRIPT_O200K_TOKENIZER", None)
    completed = subprocess.run(
        args,
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        env=environment,
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
        patch = self.patch.read_bytes()
        value: dict[str, object] = {
            "formatVersion": 2,
            "targetBranch": TARGET_BRANCH,
            "expectedBaseSha": self.base_sha,
            "expectedResultTreeSha": self.result_tree,
            "patchSizeBytes": len(patch),
            "patchSha256": hashlib.sha256(patch).hexdigest(),
            "parts": [
                {
                    "path": (
                        ".agent-patch-publication/parts/"
                        "change.patch.part-0001-of-0001"
                    ),
                    "sizeBytes": len(patch),
                    "sha256": hashlib.sha256(patch).hexdigest(),
                }
            ],
            "commitMessage": "Apply tested local patch",
        }
        value.update(overrides)
        self.manifest.write_text(
            json.dumps(value, indent=2) + "\n", encoding="utf-8"
        )

    def command(self, command: str, *extra: str) -> list[str]:
        args = [
            *STDLIB_PYTHON,
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

    def create_transfer_payload(
        self,
        *,
        manifest_overrides: dict[str, object] | None = None,
        omit_part: int | None = None,
        extra_file: bool = False,
        invalid_utf8_part: int | None = None,
    ) -> tuple[Path, str, list[Path]]:
        worktree = self.root / f"transfer-{len(list(self.root.glob('transfer-*')))}"
        branch = f"transfer-payload-{worktree.name}"
        run(
            [
                "git",
                "worktree",
                "add",
                "-q",
                "-b",
                branch,
                str(worktree),
                self.base_sha,
            ],
            cwd=self.repo,
        )
        transfer_root = worktree / ".agent-patch-publication"
        transfer_root.mkdir()
        patch = self.patch.read_bytes()
        part_paths: list[Path] = []
        midpoint = max(1, len(patch) // 2)
        while midpoint < len(patch) and patch[midpoint] & 0xC0 == 0x80:
            midpoint += 1
        parts = [patch[:midpoint], patch[midpoint:]]
        if invalid_utf8_part is not None:
            parts[invalid_utf8_part - 1] = b"\xff\xfeinvalid\n"
        parts_root = transfer_root / "parts"
        parts_root.mkdir()
        manifest_parts: list[dict[str, object]] = []
        for index, value in enumerate(parts, start=1):
            relative = (
                ".agent-patch-publication/parts/change.patch.part-"
                f"{index:04d}-of-{len(parts):04d}"
            )
            path = worktree / relative
            part_paths.append(path)
            if omit_part != index:
                path.write_bytes(value)
            manifest_parts.append(
                {
                    "path": relative,
                    "sizeBytes": len(value),
                    "sha256": hashlib.sha256(value).hexdigest(),
                }
            )
        reconstructed = b"".join(parts)
        manifest_value = {
            "formatVersion": 2,
            "targetBranch": TARGET_BRANCH,
            "expectedBaseSha": self.base_sha,
            "expectedResultTreeSha": self.result_tree,
            "patchSizeBytes": len(reconstructed),
            "patchSha256": hashlib.sha256(reconstructed).hexdigest(),
            "parts": manifest_parts,
            "commitMessage": "Apply tested local patch",
        }
        if extra_file:
            (parts_root / "unexpected.txt").write_text(
                "unexpected\n", encoding="utf-8"
            )
        if manifest_overrides:
            manifest_value.update(manifest_overrides)
        manifest_path = transfer_root / "manifest.json"
        manifest_path.write_text(
            json.dumps(manifest_value, indent=2) + "\n", encoding="utf-8"
        )
        git(worktree, "add", ".agent-patch-publication")
        git(worktree, "commit", "-q", "-m", "Add transfer payload")
        return manifest_path, f"refs/heads/{branch}", part_paths

    def materialize_command(
        self, manifest: Path, transfer_ref: str, output: Path
    ) -> list[str]:
        return [
            *STDLIB_PYTHON,
            str(SCRIPT),
            "materialize-patch",
            "--repository",
            str(self.repo),
            "--manifest",
            str(manifest),
            "--transfer-ref",
            transfer_ref,
            "--output-patch",
            str(output),
            "--default-branch",
            "main",
            "--expected-target-branch",
            TARGET_BRANCH,
        ]

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
        self.assertEqual(metadata["formatVersion"], 2)
        self.assertEqual(metadata["validationProfile"], "full")
        self.assertTrue((self.output / "publication.bundle").is_file())

        verify_repo = self.root / "verify"
        run(["git", "clone", "-q", str(self.repo), str(verify_repo)], cwd=self.root)
        verified = run(
            [
                *STDLIB_PYTHON,
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

    def test_validation_profiles_are_conservative(self) -> None:
        cases = (
            (("docs/TESTING.md", "README.md"), "docs"),
            (("src/parser.ts", "tests/parser.test.ts"), "source"),
            (("docs/TESTING.md", "src/parser.ts"), "source"),
            ((".github/workflows/ci.yml",), "full"),
            (("tools/local-agent/patch-publication.py",), "full"),
            (("unknown/generated-file.bin",), "full"),
            (("docs/guide.txt",), "full"),
        )
        for paths, expected in cases:
            with self.subTest(paths=paths):
                self.assertEqual(
                    PATCH_PUBLICATION.validation_profile_for_paths(paths),
                    expected,
                )

        with self.assertRaisesRegex(
            PATCH_PUBLICATION.PublicationError,
            "cannot classify an empty candidate change",
        ):
            PATCH_PUBLICATION.validation_profile_for_paths(())

    def test_staged_paths_expose_rename_and_deletion_boundaries(self) -> None:
        repository = self.root / "path-classification"
        repository.mkdir()
        git(repository, "init", "-q", "-b", "main")
        git(repository, "config", "user.name", "Test User")
        git(repository, "config", "user.email", "test@example.invalid")
        workflow = repository / ".github/workflows/old.yml"
        workflow.parent.mkdir(parents=True)
        workflow.write_text("name: old\n", encoding="utf-8")
        deleted = repository / "docs/deleted.md"
        deleted.parent.mkdir(parents=True)
        deleted.write_text("old\n", encoding="utf-8")
        git(repository, "add", ".")
        git(repository, "commit", "-q", "-m", "base")

        renamed = repository / "docs/old-workflow.md"
        git(
            repository,
            "mv",
            str(workflow.relative_to(repository)),
            str(renamed.relative_to(repository)),
        )
        deleted.unlink()
        git(repository, "add", "-A")

        paths = PATCH_PUBLICATION.staged_paths(repository)
        self.assertEqual(
            set(paths),
            {
                ".github/workflows/old.yml",
                "docs/deleted.md",
                "docs/old-workflow.md",
            },
        )
        self.assertEqual(
            PATCH_PUBLICATION.validation_profile_for_paths(paths),
            "full",
        )

    def test_inspect_rejects_wrong_patch_digest(self) -> None:
        self.write_manifest(patchSha256="0" * 64)
        completed = run(
            self.command("inspect-request"), cwd=self.repo, check=False
        )
        self.assertEqual(completed.returncode, 1)
        self.assertIn("patch SHA-256 mismatch", completed.stderr)

    def test_materializes_parts_and_prepares_candidate(self) -> None:
        manifest, transfer_ref, _parts = self.create_transfer_payload()
        materialized = self.root / "materialized-v2.patch"
        completed = run(
            self.materialize_command(manifest, transfer_ref, materialized),
            cwd=self.repo,
        )
        self.assertIn("format=2", completed.stdout)
        self.assertEqual(materialized.read_bytes(), self.patch.read_bytes())
        self.manifest = manifest
        self.patch = materialized
        run(
            self.command("prepare", "--output-directory", str(self.output)),
            cwd=self.repo,
        )
        self.assertTrue((self.output / "publication.bundle").is_file())

    def test_transfer_payload_modes_fail_closed(self) -> None:
        cases = (
            ("manifest-executable", "manifest", "executable"),
            ("manifest-symlink", "manifest", "symlink"),
            ("part-executable", "part", "executable"),
            ("part-symlink", "part", "symlink"),
        )
        for name, entry_kind, mutation in cases:
            with self.subTest(name=name):
                manifest, transfer_ref, parts = self.create_transfer_payload()
                worktree = manifest.parents[1]
                selected = manifest if entry_kind == "manifest" else parts[0]
                verified_manifest = manifest
                if entry_kind == "manifest" and mutation == "symlink":
                    verified_manifest = self.root / f"verified-{name}.json"
                    verified_manifest.write_bytes(manifest.read_bytes())

                if mutation == "executable":
                    selected.chmod(0o755)
                else:
                    selected.unlink()
                    target = (
                        "parts/change.patch.part-0001-of-0002"
                        if entry_kind == "manifest"
                        else "../manifest.json"
                    )
                    selected.symlink_to(target)

                git(worktree, "add", "-A", ".agent-patch-publication")
                git(worktree, "commit", "-q", "-m", f"Make {name}")
                output = self.root / f"{name}.patch"
                completed = run(
                    self.materialize_command(
                        verified_manifest, transfer_ref, output
                    ),
                    cwd=self.repo,
                    check=False,
                )
                self.assertEqual(completed.returncode, 1)
                self.assertIn(
                    "transfer payload path must be a regular non-executable file",
                    completed.stderr,
                )
                self.assertIn(
                    selected.relative_to(worktree).as_posix(), completed.stderr
                )
                self.assertFalse(output.exists())

    def test_local_manifest_copy_must_match_exact_transfer_bytes(self) -> None:
        manifest, transfer_ref, _parts = self.create_transfer_payload()
        local_manifest = self.root / "verified-manifest-copy.json"
        local_manifest.write_bytes(manifest.read_bytes() + b"\n")
        output = self.root / "manifest-mismatch.patch"
        completed = run(
            self.materialize_command(local_manifest, transfer_ref, output),
            cwd=self.repo,
            check=False,
        )
        self.assertEqual(completed.returncode, 1)
        self.assertIn(
            "transfer manifest bytes differ from the verified local manifest",
            completed.stderr,
        )
        self.assertFalse(output.exists())

    def test_missing_and_extra_parts_fail_closed(self) -> None:
        cases = (
            ({"omit_part": 2}, "missing file(s)"),
            ({"extra_file": True}, "unexpected file(s)"),
        )
        for kwargs, expected in cases:
            with self.subTest(expected=expected):
                manifest, transfer_ref, _parts = self.create_transfer_payload(**kwargs)
                completed = run(
                    self.materialize_command(
                        manifest, transfer_ref, self.root / f"{expected}.patch"
                    ),
                    cwd=self.repo,
                    check=False,
                )
                self.assertEqual(completed.returncode, 1)
                self.assertIn(expected, completed.stderr)

    def test_part_size_hash_and_utf8_errors_name_the_part(self) -> None:
        for kind in ("size", "hash", "utf8"):
            with self.subTest(kind=kind):
                if kind == "utf8":
                    manifest, transfer_ref, parts = self.create_transfer_payload(
                        invalid_utf8_part=2
                    )
                else:
                    manifest, transfer_ref, parts = self.create_transfer_payload()
                    value = json.loads(manifest.read_text(encoding="utf-8"))
                    if kind == "size":
                        value["parts"][1]["sizeBytes"] += 1
                        value["patchSizeBytes"] += 1
                    else:
                        value["parts"][1]["sha256"] = "0" * 64
                    manifest.write_text(
                        json.dumps(value, indent=2) + "\n", encoding="utf-8"
                    )
                    git(manifest.parents[1], "add", str(manifest.relative_to(manifest.parents[1])))
                    git(manifest.parents[1], "commit", "-q", "-m", f"Corrupt {kind}")
                completed = run(
                    self.materialize_command(
                        manifest, transfer_ref, self.root / f"bad-{kind}.patch"
                    ),
                    cwd=self.repo,
                    check=False,
                )
                self.assertEqual(completed.returncode, 1)
                self.assertIn(
                    parts[1].relative_to(manifest.parents[1]).as_posix(),
                    completed.stderr,
                )

    def test_final_digest_and_canonical_order_fail_closed(self) -> None:
        manifest, transfer_ref, _parts = self.create_transfer_payload()
        value = json.loads(manifest.read_text(encoding="utf-8"))
        value["patchSha256"] = "0" * 64
        manifest.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
        worktree = manifest.parents[1]
        git(worktree, "add", ".agent-patch-publication/manifest.json")
        git(worktree, "commit", "-q", "-m", "Corrupt final digest")
        completed = run(
            self.materialize_command(
                manifest, transfer_ref, self.root / "bad-final.patch"
            ),
            cwd=self.repo,
            check=False,
        )
        self.assertEqual(completed.returncode, 1)
        self.assertIn("reconstructed patch SHA-256 mismatch", completed.stderr)

        manifest2, transfer_ref2, _parts2 = self.create_transfer_payload()
        value2 = json.loads(manifest2.read_text(encoding="utf-8"))
        value2["parts"].reverse()
        manifest2.write_text(json.dumps(value2, indent=2) + "\n", encoding="utf-8")
        worktree2 = manifest2.parents[1]
        git(worktree2, "add", ".agent-patch-publication/manifest.json")
        git(worktree2, "commit", "-q", "-m", "Reverse part order")
        completed2 = run(
            self.materialize_command(
                manifest2, transfer_ref2, self.root / "bad-order.patch"
            ),
            cwd=self.repo,
            check=False,
        )
        self.assertEqual(completed2.returncode, 1)
        self.assertIn(".path must be exactly", completed2.stderr)

        manifest3, transfer_ref3, _parts3 = self.create_transfer_payload()
        value3 = json.loads(manifest3.read_text(encoding="utf-8"))
        value3["parts"][1] = dict(value3["parts"][0])
        manifest3.write_text(json.dumps(value3, indent=2) + "\n", encoding="utf-8")
        worktree3 = manifest3.parents[1]
        git(worktree3, "add", ".agent-patch-publication/manifest.json")
        git(worktree3, "commit", "-q", "-m", "Duplicate first part")
        completed3 = run(
            self.materialize_command(
                manifest3, transfer_ref3, self.root / "bad-duplicate.patch"
            ),
            cwd=self.repo,
            check=False,
        )
        self.assertEqual(completed3.returncode, 1)
        self.assertIn(".path must be exactly", completed3.stderr)

    def test_invalid_path_and_transport_limits_fail_closed(self) -> None:
        cases: list[tuple[str, Callable[[dict[str, object]], None], str]] = []

        def invalid_path(value: dict[str, object]) -> None:
            value["parts"][0]["path"] = ".agent-patch-publication/parts/../escape"

        def oversized_part(value: dict[str, object]) -> None:
            old_size = value["parts"][0]["sizeBytes"]
            value["parts"][0]["sizeBytes"] = 256 * 1024 + 1
            value["patchSizeBytes"] += 256 * 1024 + 1 - old_size

        def oversized_patch(value: dict[str, object]) -> None:
            value["patchSizeBytes"] = 64 * 1024 * 1024 + 1

        def too_many_parts(value: dict[str, object]) -> None:
            value["parts"] = [dict(value["parts"][0]) for _ in range(1025)]
            value["patchSizeBytes"] = 1025

        cases.extend(
            [
                ("path", invalid_path, ".path must be exactly"),
                ("part-size", oversized_part, ".sizeBytes must be between"),
                ("patch-size", oversized_patch, "patchSizeBytes must be between"),
                ("part-count", too_many_parts, "between 1 and 1024 entries"),
            ]
        )
        for name, mutate, expected in cases:
            with self.subTest(name=name):
                manifest, transfer_ref, _parts = self.create_transfer_payload()
                value = json.loads(manifest.read_text(encoding="utf-8"))
                mutate(value)
                manifest.write_text(
                    json.dumps(value, indent=2) + "\n", encoding="utf-8"
                )
                worktree = manifest.parents[1]
                git(worktree, "add", ".agent-patch-publication/manifest.json")
                git(worktree, "commit", "-q", "-m", f"Invalidate {name}")
                completed = run(
                    self.materialize_command(
                        manifest, transfer_ref, self.root / f"invalid-{name}.patch"
                    ),
                    cwd=self.repo,
                    check=False,
                )
                self.assertEqual(completed.returncode, 1)
                self.assertIn(expected, completed.stderr)

    def test_one_part_repair_succeeds_on_new_transfer_commit(self) -> None:
        manifest, transfer_ref, parts = self.create_transfer_payload()
        manifest_digest = hashlib.sha256(manifest.read_bytes()).hexdigest()
        correct_part = parts[1].read_bytes()
        parts[1].write_text("wrong but valid UTF-8\n", encoding="utf-8")
        worktree = manifest.parents[1]
        git(worktree, "add", str(parts[1].relative_to(worktree)))
        git(worktree, "commit", "-q", "-m", "Upload bad second part")
        bad_transfer_sha = git(self.repo, "rev-parse", transfer_ref)
        first_attempt = run(
            self.materialize_command(
                manifest, transfer_ref, self.root / "first-attempt.patch"
            ),
            cwd=self.repo,
            check=False,
        )
        self.assertEqual(first_attempt.returncode, 1)
        self.assertIn("part size mismatch", first_attempt.stderr)

        parts[1].write_bytes(correct_part)
        git(worktree, "add", str(parts[1].relative_to(worktree)))
        git(worktree, "commit", "-q", "-m", "Repair only second part")
        repaired_transfer_sha = git(self.repo, "rev-parse", transfer_ref)
        self.assertNotEqual(repaired_transfer_sha, bad_transfer_sha)
        self.assertEqual(hashlib.sha256(manifest.read_bytes()).hexdigest(), manifest_digest)
        repaired = self.root / "repaired.patch"
        run(self.materialize_command(manifest, transfer_ref, repaired), cwd=self.repo)
        self.assertEqual(repaired.read_bytes(), self.patch.read_bytes())

    def test_generator_rejects_dirty_repository_non_head_and_existing_output(self) -> None:
        repository = self.root / "generator-errors"
        repository.mkdir()
        git(repository, "init", "-q", "-b", "main")
        git(repository, "config", "user.name", "Generator Test")
        git(repository, "config", "user.email", "generator@example.invalid")
        (repository / "example.txt").write_text("base\n", encoding="utf-8")
        git(repository, "add", "example.txt")
        git(repository, "commit", "-q", "-m", "Base")
        base = git(repository, "rev-parse", "HEAD")
        (repository / "example.txt").write_text("changed\n", encoding="utf-8")
        git(repository, "add", "example.txt")
        git(repository, "commit", "-q", "-m", "Change")
        head = git(repository, "rev-parse", "HEAD")

        def generator(*extra: str) -> list[str]:
            # Keep the normal interpreter here: prepare-patch-publication may load
            # the installed TikToken package for token-aware splitting.
            return [
                sys.executable,
                str(PREPARE_SCRIPT),
                "--repository",
                str(repository),
                "--target-branch",
                TARGET_BRANCH,
                "--expected-base-sha",
                base,
                "--output-directory",
                str(self.root / "generator-output"),
                *extra,
            ]

        non_head = run(
            generator("--tested-commit", base), cwd=repository, check=False
        )
        self.assertEqual(non_head.returncode, 1)
        self.assertIn("must be the current HEAD", non_head.stderr)

        (repository / "dirty.txt").write_text("dirty\n", encoding="utf-8")
        dirty = run(generator("--tested-commit", head), cwd=repository, check=False)
        self.assertEqual(dirty.returncode, 1)
        self.assertIn("must be clean", dirty.stderr)
        (repository / "dirty.txt").unlink()

        output = self.root / "generator-output"
        output.mkdir()
        existing = run(
            generator("--tested-commit", head), cwd=repository, check=False
        )
        self.assertEqual(existing.returncode, 1)
        self.assertIn("output path already exists", existing.stderr)

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
                *STDLIB_PYTHON,
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

    def test_verify_rejects_invalid_or_mismatched_profile(self) -> None:
        run(
            self.command("prepare", "--output-directory", str(self.output)),
            cwd=self.repo,
        )
        metadata_path = self.output / "publication.json"
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        metadata["validationProfile"] = "skip-everything"
        metadata_path.write_text(json.dumps(metadata) + "\n", encoding="utf-8")
        invalid = run(
            [
                *STDLIB_PYTHON,
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
        self.assertEqual(invalid.returncode, 1)
        self.assertIn("validationProfile must be one of", invalid.stderr)

        metadata["validationProfile"] = "full"
        metadata_path.write_text(json.dumps(metadata) + "\n", encoding="utf-8")
        mismatch = run(
            [
                *STDLIB_PYTHON,
                str(SCRIPT),
                "verify-bundle",
                "--repository",
                str(self.repo),
                "--metadata",
                str(metadata_path),
                "--bundle",
                str(self.output / "publication.bundle"),
                "--expected-validation-profile",
                "source",
            ],
            cwd=self.repo,
            check=False,
        )
        self.assertEqual(mismatch.returncode, 1)
        self.assertIn("validation profile mismatch", mismatch.stderr)


if __name__ == "__main__":
    run_compact_unittest("patch-publication")
