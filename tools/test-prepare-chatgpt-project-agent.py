#!/usr/bin/env python3
"""Focused tests for the ChatGPT project-agent tools/runtime split."""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "tools" / "local-agent"))
from compact_unittest import run_compact_unittest

PREPARE = REPO_ROOT / "tools" / "prepare-chatgpt-project-agent.py"
SETUP = REPO_ROOT / "tools" / "setup-chatgpt-project-agent.sh"
BUNDLE = REPO_ROOT / "tools" / "chatgpt-project-agent"
PROJECT_README = REPO_ROOT / "docs" / "chatgpt-project" / "README-FIRST.md"

SPEC = importlib.util.spec_from_file_location("prepare_chatgpt_project_agent", PREPARE)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def run(command: list[str], *, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_checksums(root: Path, filename: str = "SHA256SUMS") -> None:
    lines = []
    for path in sorted(root.rglob("*")):
        if path.is_file() and not path.is_symlink() and path.name != filename:
            lines.append(f"{sha256(path)}  {path.relative_to(root).as_posix()}")
    (root / filename).write_text("\n".join(lines) + "\n", encoding="utf-8")


def create_tar_zst(root: Path, output: Path) -> None:
    tar_path = output.with_suffix("")
    with tarfile.open(tar_path, "w") as archive:
        archive.add(root, arcname=root.name)
    with output.open("wb") as handle:
        subprocess.run(["zstd", "-q", "-1", "-c", str(tar_path)], stdout=handle, check=True)
    tar_path.unlink()


def create_tools_tar_gz(output: Path, source: Path = BUNDLE) -> None:
    with tarfile.open(output, "w:gz") as archive:
        archive.add(source, arcname="chatgpt-project-agent")


class ChatGPTProjectAgentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="chatgpt-project-agent-test-")
        self.root = Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def create_legacy_bootstrap(self) -> Path:
        parent = self.root / "legacy-parent"
        root = parent / "legacy-bootstrap-v5"
        for relative in (
            "runtime/node-v24.18.0-linux-x64/bin",
            "runtime/node-v26.5.0-linux-x64/bin",
            "npm-cache-seed/_cacache",
            "optional-tools/ts-morph/packages",
            "optional-tools/tiktoken-cp313-linux-x86_64/wheels",
            "optional-tools/tiktoken-cp313-linux-x86_64/tokenizer",
            "bin",
            "tools",
        ):
            (root / relative).mkdir(parents=True, exist_ok=True)
        for version in ("24.18.0", "26.5.0"):
            for executable in ("node", "npm"):
                path = root / f"runtime/node-v{version}-linux-x64/bin/{executable}"
                path.write_text(f"fake {executable} {version}\n", encoding="utf-8")
                path.chmod(0o755)
        (root / "npm-cache-seed/_cacache/value").write_text("cache\n", encoding="utf-8")
        (root / "optional-tools/ts-morph/packages/ts-morph-28.0.0.tgz").write_bytes(b"ts-morph")
        write_checksums(root / "optional-tools/ts-morph")
        token = root / "optional-tools/tiktoken-cp313-linux-x86_64"
        (token / "wheels/tiktoken.whl").write_bytes(b"wheel")
        (token / "tokenizer/o200k_base.tiktoken").write_bytes(b"vocabulary")
        (token / "MANIFEST.json").write_text('{"formatVersion":1}\n', encoding="utf-8")
        (token / "README.txt").write_text("human documentation\n", encoding="utf-8")
        (token / "install-offline.sh").write_text("#!/bin/sh\n", encoding="utf-8")
        (token / "verify-installed.py").write_text("print('verify')\n", encoding="utf-8")
        write_checksums(token)
        (root / "README.md").write_text("legacy human documentation\n", encoding="utf-8")
        (root / "bin/setup-workspace.sh").write_text("#!/bin/sh\n", encoding="utf-8")
        (root / "tools/test-prepare-source-review.py").write_text("test\n", encoding="utf-8")
        (root / "CACHE-SEED-ID").write_text("seed\n", encoding="utf-8")
        (root / "PACKAGE-INVENTORY.json").write_text("{}\n", encoding="utf-8")
        (root / "MANIFEST.json").write_text(
            json.dumps(
                {
                    "formatVersion": 5,
                    "platform": "linux-x64",
                    "layout": "single-extract-preexpanded-runtime-and-cache",
                }
            )
            + "\n",
            encoding="utf-8",
        )
        write_checksums(root)
        archive = self.root / "legacy.tar.zst"
        create_tar_zst(root, archive)
        return archive

    def build_runtime(self, name: str = "runtime.tar.zst") -> Path:
        output = self.root / name
        completed = run(
            [
                sys.executable,
                "-B",
                str(PREPARE),
                "runtime",
                "--legacy-bootstrap",
                str(self.create_legacy_bootstrap()),
                "--output",
                str(output),
                "--compression-level",
                "1",
            ]
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return output

    def test_refresh_concatenates_every_source_exactly_and_keeps_one_python_tool(self) -> None:
        completed = run([sys.executable, "-B", str(PREPARE), "refresh"])
        self.assertEqual(completed.returncode, 0, completed.stderr)
        expected = b"".join(path.read_bytes() for path in MODULE.COMBINED_README_SOURCES)
        self.assertEqual(PROJECT_README.read_bytes(), expected)
        self.assertEqual(
            sorted(path.relative_to(BUNDLE).as_posix() for path in BUNDLE.rglob("*.py")),
            ["tools/prepare-source-review.py"],
        )
        self.assertTrue((BUNDLE / "TOOLS-MANIFEST.json").is_file())
        self.assertTrue((BUNDLE / "TOOLS-INVENTORY.json").is_file())
        self.assertTrue((BUNDLE / "TOOLS-SHA256SUMS").is_file())
        self.assertEqual(
            {
                path.relative_to(BUNDLE).as_posix()
                for path in BUNDLE.rglob("*")
                if path.is_file() or path.is_symlink()
            },
            MODULE.EXPECTED_BUNDLE_FILES,
        )

    def test_runtime_split_keeps_payload_and_removes_maintainable_files(self) -> None:
        runtime = self.build_runtime()
        extracted = self.root / "runtime-extracted"
        extracted.mkdir()
        completed = run(["tar", "--zstd", "-xf", str(runtime), "-C", str(extracted)])
        self.assertEqual(completed.returncode, 0, completed.stderr)
        root = extracted / "chatgpt-project-agent-runtime-linux-x64"
        self.assertTrue((root / "runtime/node-v24.18.0-linux-x64/bin/node").is_file())
        self.assertTrue((root / "dependencies/tiktoken-cp313-linux-x86_64/wheels/tiktoken.whl").is_file())
        self.assertTrue((root / "optional-tools/ts-morph/packages/ts-morph-28.0.0.tgz").is_file())
        self.assertFalse((root / "README.md").exists())
        self.assertFalse((root / "bin").exists())
        self.assertFalse((root / "tools").exists())
        self.assertFalse((root / "dependencies/tiktoken-cp313-linux-x86_64/README.txt").exists())
        self.assertFalse((root / "dependencies/tiktoken-cp313-linux-x86_64/install-offline.sh").exists())
        self.assertFalse((root / "dependencies/tiktoken-cp313-linux-x86_64/verify-installed.py").exists())

    def test_setup_combines_tar_gz_and_tar_zst_into_installed_layout(self) -> None:
        runtime = self.build_runtime()
        tools = self.root / "tools.tar.gz"
        create_tools_tar_gz(tools)
        output = self.root / "installed"
        completed = run(
            [
                str(SETUP),
                "--tools-archive",
                str(tools),
                "--runtime-archive",
                str(runtime),
                "--output",
                str(output),
            ]
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertTrue((output / "bin/prepare-agent-workspace.sh").is_file())
        self.assertTrue((output / "runtime/node-v24.18.0-linux-x64/bin/node").is_file())
        self.assertTrue((output / "dependencies/tiktoken-cp313-linux-x86_64/wheels/tiktoken.whl").is_file())
        self.assertEqual(
            sorted(path.relative_to(output).as_posix() for path in output.rglob("*.py")),
            ["tools/prepare-source-review.py"],
        )

    def test_setup_rejects_unsafe_tools_archive(self) -> None:
        malicious = self.root / "malicious.tar.gz"
        with tarfile.open(malicious, "w:gz") as archive:
            info = tarfile.TarInfo("../escape")
            value = b"bad"
            info.size = len(value)
            archive.addfile(info, io.BytesIO(value))
        runtime = self.build_runtime()
        completed = run(
            [
                str(SETUP),
                "--tools-archive",
                str(malicious),
                "--runtime-archive",
                str(runtime),
                "--output",
                str(self.root / "unsafe-output"),
                "--verify-only",
            ]
        )
        self.assertEqual(completed.returncode, 1)
        self.assertIn("unsafe archive path", completed.stderr)

    def test_workspace_help_marks_tiktoken_mandatory_and_compatibility_only(self) -> None:
        completed = run([str(BUNDLE / "bin/prepare-agent-workspace.sh"), "--help"])
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("mandatory TikToken", completed.stdout)
        self.assertIn("compatibility no-op", completed.stdout)
        setup_text = (BUNDLE / "bin/setup-workspace.sh").read_text(encoding="utf-8")
        self.assertIn('"$script_dir/install-tiktoken-offline.sh" "$repo"', setup_text)
        self.assertNotIn("if ((with_tiktoken))", setup_text)


if __name__ == "__main__":
    run_compact_unittest("chatgpt-project-agent")
