#!/usr/bin/env python3
"""Focused regressions for token-aware sequential payload preparation."""

from __future__ import annotations

import gzip
import importlib.util
import io
import json
import os
import shutil
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

    def prepare_small_payload(
        self, name: str
    ) -> tuple[Path, Path, dict[str, object]]:
        repository = self.root / f"{name}-repository"
        repository.mkdir()
        git(repository, "init", "-q", "-b", "main")
        git(repository, "config", "user.name", "Test")
        git(repository, "config", "user.email", "test@example.invalid")
        (repository / "base.txt").write_text("base\n")
        git(repository, "add", "base.txt")
        git(repository, "commit", "-q", "-m", "Base")
        base = git(repository, "rev-parse", "HEAD")
        (repository / "change.txt").write_text("change\n")
        git(repository, "add", "change.txt")
        git(repository, "commit", "-q", "-m", "Add change")

        output = self.root / f"{name}-payload"
        run(
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
        )
        plan = json.loads((output / "upload-plan.json").read_text())
        return repository, output, plan

    def write_completed_upload_state(
        self, output: Path, plan: dict[str, object]
    ) -> None:
        files = plan["files"]
        assert isinstance(files, list)
        state = {
            "stateVersion": 3,
            "completedUploads": [
                {
                    "index": item["index"],
                    "path": item["path"],
                    "gitBlobSha": item["expectedGitBlobSha"],
                }
                for item in files
            ],
        }
        (output / "upload-state.json").write_text(json.dumps(state) + "\n")

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

    def test_rename_aware_patches_are_compact_self_contained_and_exact(self) -> None:
        def prepare_case(
            name: str,
            *,
            source_path: str,
            target_path: str,
            original: bytes,
            changed: bytes | None = None,
        ) -> tuple[bytes, bytes]:
            repository = self.root / f"{name}-repository"
            repository.mkdir()
            git(repository, "init", "-q", "-b", "main")
            git(repository, "config", "user.name", "Test")
            git(repository, "config", "user.email", "test@example.invalid")

            source = repository / source_path
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_bytes(original)
            git(repository, "add", source_path)
            git(repository, "commit", "-q", "-m", "Add original file")
            base = git(repository, "rev-parse", "HEAD")

            target = repository / target_path
            target.parent.mkdir(parents=True, exist_ok=True)
            git(repository, "mv", source_path, target_path)
            if changed is not None:
                target.write_bytes(changed)
            git(repository, "add", "-A")
            git(repository, "commit", "-q", "-m", "Move file")
            tested = git(repository, "rev-parse", "HEAD")
            expected_tree = git(repository, "show", "-s", "--format=%T", tested)

            output = self.root / f"{name}-payload"
            configured_tokenizer = os.environ.pop(
                "TEASESCRIPT_O200K_TOKENIZER", None
            )
            try:
                prepared = run_cli(
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
                    "--output-directory",
                    str(output),
                )
            finally:
                if configured_tokenizer is not None:
                    os.environ["TEASESCRIPT_O200K_TOKENIZER"] = configured_tokenizer
            self.assertEqual(prepared.returncode, 0, prepared.stderr)

            manifest = json.loads(
                (output / SUPPORT.TRANSFER_DIRECTORY / "manifest.json").read_text()
            )
            patch = b"".join(
                (output / entry["path"]).read_bytes()
                for entry in manifest["parts"]
            )
            self.assertEqual(len(patch), manifest["patchSizeBytes"])
            self.assertEqual(SUPPORT.sha256_bytes(patch), manifest["patchSha256"])

            no_rename = subprocess.run(
                [
                    "git",
                    "diff",
                    "--binary",
                    "--full-index",
                    "--no-renames",
                    base,
                    tested,
                ],
                cwd=repository,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=True,
            ).stdout

            patch_path = self.root / f"{name}.patch"
            patch_path.write_bytes(patch)
            applied = self.root / f"{name}-applied"
            run(
                [
                    "git",
                    "worktree",
                    "add",
                    "-q",
                    "-b",
                    f"apply-{name}",
                    str(applied),
                    base,
                ],
                cwd=repository,
            )
            run(
                ["git", "apply", "--check", "--index", "--binary", str(patch_path)],
                cwd=applied,
            )
            run(
                ["git", "apply", "--index", "--binary", str(patch_path)],
                cwd=applied,
            )
            self.assertEqual(git(applied, "write-tree"), expected_tree)
            self.assertEqual((applied / target_path).read_bytes(), changed or original)
            self.assertFalse((applied / source_path).exists())
            return patch, no_rename

        text = "".join(
            f"line {index:05d}: canonical historical material\n"
            for index in range(3_000)
        ).encode()
        text_changed = text.replace(
            b"line 01500: canonical historical material",
            b"line 01500: superseded historical material",
        )

        pure_text, pure_text_without_renames = prepare_case(
            "text-rename",
            source_path="current/document.md",
            target_path="history/document.md",
            original=text,
        )
        self.assertIn(b"similarity index 100%", pure_text)
        self.assertIn(b"rename from current/document.md", pure_text)
        self.assertIn(b"rename to history/document.md", pure_text)
        self.assertLess(len(pure_text) * 20, len(pure_text_without_renames))

        edited_text, edited_text_without_renames = prepare_case(
            "text-rename-edit",
            source_path="current/document.md",
            target_path="history/document.md",
            original=text,
            changed=text_changed,
        )
        self.assertIn(b"rename from current/document.md", edited_text)
        self.assertIn(b"rename to history/document.md", edited_text)
        self.assertIn(b"superseded historical material", edited_text)
        self.assertLess(len(edited_text) * 20, len(edited_text_without_renames))
        split_parts, _ = SUPPORT.split_utf8_patch(
            edited_text,
            maximum_bytes=160,
        )
        self.assertGreater(len(split_parts), 1)
        self.assertEqual(b"".join(split_parts), edited_text)

        binary = bytes((index * 37) % 256 for index in range(8_192))
        binary_changed = bytearray(binary)
        binary_changed[4_000:4_008] = b"CHANGED!"

        pure_binary, pure_binary_without_renames = prepare_case(
            "binary-rename",
            source_path="current/data.bin",
            target_path="history/data.bin",
            original=binary,
        )
        self.assertIn(b"similarity index 100%", pure_binary)
        self.assertIn(b"rename from current/data.bin", pure_binary)
        self.assertIn(b"rename to history/data.bin", pure_binary)
        self.assertNotIn(b"GIT binary patch", pure_binary)
        self.assertLess(len(pure_binary) * 5, len(pure_binary_without_renames))

        edited_binary, edited_binary_without_renames = prepare_case(
            "binary-rename-edit",
            source_path="current/data.bin",
            target_path="history/data.bin",
            original=binary,
            changed=bytes(binary_changed),
        )
        self.assertIn(b"rename from current/data.bin", edited_binary)
        self.assertIn(b"rename to history/data.bin", edited_binary)
        self.assertIn(b"GIT binary patch", edited_binary)
        self.assertLess(len(edited_binary) * 3, len(edited_binary_without_renames))

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

        shown = run_cli("--output-directory", str(output), "--show-next-action")
        shown_alias = run_cli(
            "--output-directory", str(output), "--show-next-upload"
        )
        self.assertEqual(shown.returncode, 0)
        self.assertEqual(shown_alias.returncode, 0)
        self.assertEqual(shown_alias.stdout, shown.stdout)
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

        payload_repository = self.root / "payload-tree"
        payload_repository.mkdir()
        git(payload_repository, "init", "-q", "-b", "main")
        shutil.copytree(
            output / SUPPORT.TRANSFER_DIRECTORY,
            payload_repository / SUPPORT.TRANSFER_DIRECTORY,
        )
        git(payload_repository, "add", SUPPORT.TRANSFER_DIRECTORY)
        self.assertEqual(
            plan["expectedTransferTreeSha"],
            git(payload_repository, "write-tree"),
        )

        self.write_completed_upload_state(output, plan)
        tree_action = run_cli(
            "--output-directory", str(output), "--show-next-action"
        )
        tree_action_alias = run_cli(
            "--output-directory", str(output), "--show-next-upload"
        )
        self.assertEqual(tree_action.returncode, 0)
        self.assertEqual(tree_action_alias.returncode, 0)
        self.assertEqual(tree_action_alias.stdout, tree_action.stdout)
        self.assertIn("stage=create-transfer-tree", tree_action.stdout)
        self.assertIn('"tree_elements":', tree_action.stdout)
        self.assertNotIn("publicationCommand=", tree_action.stdout)

        wrong_tree = run_cli(
            "--output-directory",
            str(output),
            "--record-tree-sha",
            "0" * 40,
        )
        self.assertEqual(wrong_tree.returncode, 1)
        self.assertIn("do not advance", wrong_tree.stderr)
        state = json.loads((output / "upload-state.json").read_text())
        self.assertNotIn("transferTreeSha", state)

        tree_sha = str(plan["expectedTransferTreeSha"])
        recorded_tree = run_cli(
            "--output-directory", str(output), "--record-tree-sha", tree_sha
        )
        self.assertEqual(recorded_tree.returncode, 0)
        commit_action = run_cli(
            "--output-directory", str(output), "--show-next-upload"
        )
        self.assertIn("stage=create-transfer-commit", commit_action.stdout)
        self.assertIn(f'"tree_sha": "{tree_sha}"', commit_action.stdout)
        self.assertIn(f'"parent_sha": "{base}"', commit_action.stdout)
        self.assertNotIn("<returned-tree-sha>", commit_action.stdout)

        commit_sha = "1" * 40
        recorded_commit = run_cli(
            "--output-directory",
            str(output),
            "--record-commit-sha",
            commit_sha,
        )
        self.assertEqual(recorded_commit.returncode, 0)
        branch_action = run_cli(
            "--output-directory", str(output), "--show-next-upload"
        )
        self.assertIn("stage=create-transfer-branch", branch_action.stdout)
        self.assertIn(f'"sha": "{commit_sha}"', branch_action.stdout)
        self.assertNotIn("<returned-commit-sha>", branch_action.stdout)
        self.assertNotIn("publicationCommand=", branch_action.stdout)

        wrong_branch_name = run_cli(
            "--output-directory",
            str(output),
            "--record-branch-created",
            "wrong-transfer-branch",
        )
        self.assertEqual(wrong_branch_name.returncode, 1)
        self.assertIn("do not advance", wrong_branch_name.stderr)

        recorded_branch_creation = run_cli(
            "--output-directory",
            str(output),
            "--record-branch-created",
            str(plan["transferBranch"]),
        )
        self.assertEqual(recorded_branch_creation.returncode, 0)
        verify_branch = run_cli(
            "--output-directory", str(output), "--show-next-upload"
        )
        self.assertEqual(verify_branch.returncode, 0)
        self.assertIn("stage=verify-transfer-branch", verify_branch.stdout)
        self.assertIn("connector=GitHub.compare_commits", verify_branch.stdout)
        self.assertIn(f'"base": "{commit_sha}"', verify_branch.stdout)
        self.assertIn(
            f'"head": "{plan["transferBranch"]}"', verify_branch.stdout
        )
        self.assertNotIn("stage=create-transfer-branch", verify_branch.stdout)

        resumed_verification = run_cli(
            "--output-directory", str(output), "--show-next-upload"
        )
        self.assertEqual(resumed_verification.returncode, 0)
        self.assertIn("stage=verify-transfer-branch", resumed_verification.stdout)
        self.assertNotIn(
            "stage=create-transfer-branch", resumed_verification.stdout
        )

        wrong_branch_status = run_cli(
            "--output-directory",
            str(output),
            "--record-branch-status",
            "ahead",
        )
        self.assertEqual(wrong_branch_status.returncode, 1)
        self.assertIn("not identical", wrong_branch_status.stderr)

        recorded_branch = run_cli(
            "--output-directory",
            str(output),
            "--record-branch-status",
            "identical",
        )
        self.assertEqual(recorded_branch.returncode, 0)
        ready = run_cli("--output-directory", str(output), "--show-next-upload")
        self.assertEqual(ready.returncode, 0)
        self.assertIn("stage=ready-to-publish", ready.stdout)
        self.assertIn(str(plan["publicationCommand"]), ready.stdout)
        self.assertIn(str(plan["expectedResultTreeSha"]), ready.stdout)
        self.assertIn("postPublicationChecklist=", ready.stdout)

        reset_after_ready = run_cli(
            "--output-directory",
            str(output),
            "--reset-upload-index",
            str(first["index"]),
        )
        self.assertEqual(reset_after_ready.returncode, 0)
        self.assertIn("clearedPublicationState=true", reset_after_ready.stdout)
        reset_state = json.loads((output / "upload-state.json").read_text())
        self.assertNotIn("transferTreeSha", reset_state)
        self.assertNotIn("transferCommitSha", reset_state)
        self.assertNotIn("transferBranchCreated", reset_state)
        self.assertNotIn("transferBranchSha", reset_state)

    def test_post_upload_stage_reset_preserves_verified_blobs(self) -> None:
        _, output, plan = self.prepare_small_payload("stage-reset")
        self.write_completed_upload_state(output, plan)
        completed_uploads = json.loads(
            (output / "upload-state.json").read_text()
        )["completedUploads"]

        tree_sha = str(plan["expectedTransferTreeSha"])
        first_commit_sha = "1" * 40
        second_commit_sha = "2" * 40
        run_cli(
            "--output-directory", str(output), "--record-tree-sha", tree_sha
        )
        run_cli(
            "--output-directory",
            str(output),
            "--record-commit-sha",
            first_commit_sha,
        )

        replacement_without_reset = run_cli(
            "--output-directory",
            str(output),
            "--record-commit-sha",
            second_commit_sha,
        )
        self.assertEqual(replacement_without_reset.returncode, 1)
        self.assertIn("already recorded", replacement_without_reset.stderr)

        reset_commit = run_cli(
            "--output-directory",
            str(output),
            "--reset-publication-stage",
            "commit",
        )
        self.assertEqual(reset_commit.returncode, 0)
        self.assertIn("preservedVerifiedBlobs=true", reset_commit.stdout)
        state = json.loads((output / "upload-state.json").read_text())
        self.assertEqual(state["completedUploads"], completed_uploads)
        self.assertEqual(state["transferTreeSha"], tree_sha)
        self.assertNotIn("transferCommitSha", state)

        run_cli(
            "--output-directory",
            str(output),
            "--record-commit-sha",
            second_commit_sha,
        )
        run_cli(
            "--output-directory",
            str(output),
            "--record-branch-created",
            str(plan["transferBranch"]),
        )

        reset_branch = run_cli(
            "--output-directory",
            str(output),
            "--reset-publication-stage",
            "branch",
        )
        self.assertEqual(reset_branch.returncode, 0)
        state = json.loads((output / "upload-state.json").read_text())
        self.assertEqual(state["completedUploads"], completed_uploads)
        self.assertEqual(state["transferTreeSha"], tree_sha)
        self.assertEqual(state["transferCommitSha"], second_commit_sha)
        self.assertNotIn("transferBranchCreated", state)
        self.assertNotIn("transferBranchSha", state)

        reset_tree = run_cli(
            "--output-directory",
            str(output),
            "--reset-publication-stage",
            "tree",
        )
        self.assertEqual(reset_tree.returncode, 0)
        state = json.loads((output / "upload-state.json").read_text())
        self.assertEqual(state["completedUploads"], completed_uploads)
        self.assertNotIn("transferTreeSha", state)
        self.assertNotIn("transferCommitSha", state)
        self.assertNotIn("transferBranchCreated", state)
        self.assertNotIn("transferBranchSha", state)

    def test_post_upload_actions_reject_out_of_order_and_malformed_state(self) -> None:
        _, output, plan = self.prepare_small_payload("ordering")

        early_tree = run_cli(
            "--output-directory",
            str(output),
            "--record-tree-sha",
            str(plan["expectedTransferTreeSha"]),
        )
        self.assertEqual(early_tree.returncode, 1)
        self.assertIn("before every blob is recorded", early_tree.stderr)

        self.write_completed_upload_state(output, plan)
        early_commit = run_cli(
            "--output-directory",
            str(output),
            "--record-commit-sha",
            "1" * 40,
        )
        self.assertEqual(early_commit.returncode, 1)
        self.assertIn("before the tree SHA", early_commit.stderr)
        early_branch = run_cli(
            "--output-directory",
            str(output),
            "--record-branch-created",
            "agent-patch-publication/early",
        )
        self.assertEqual(early_branch.returncode, 1)
        self.assertIn("before the commit SHA", early_branch.stderr)

        early_branch_status = run_cli(
            "--output-directory",
            str(output),
            "--record-branch-status",
            "identical",
        )
        self.assertEqual(early_branch_status.returncode, 1)
        self.assertIn("before branch creation", early_branch_status.stderr)

        malformed = json.loads((output / "upload-state.json").read_text())
        malformed["unexpected"] = True
        (output / "upload-state.json").write_text(json.dumps(malformed) + "\n")
        rejected = run_cli(
            "--output-directory", str(output), "--show-next-upload"
        )
        self.assertEqual(rejected.returncode, 1)
        self.assertIn("unknown fields", rejected.stderr)

    def test_generated_instructions_cover_complete_stateful_handoff(self) -> None:
        _, output, _ = self.prepare_small_payload("instructions")
        instructions = (output / "UPLOAD-INSTRUCTIONS.md").read_text()
        self.assertIn("exactly one next action at a time", instructions)
        self.assertIn("canonical `--show-next-action`", instructions)
        self.assertIn("`--show-next-upload` remains an exact compatibility alias", instructions)
        self.assertIn(
            "Record each returned SHA, branch name, or\ncomparison status",
            instructions,
        )
        self.assertIn("read-only exact branch comparison", instructions)
        self.assertIn("--reset-publication-stage", instructions)
        self.assertIn("never requires manual placeholder substitution", instructions)
        self.assertIn("Do not Base64-encode", instructions)


if __name__ == "__main__":
    run_compact_unittest("prepare-patch-publication")
