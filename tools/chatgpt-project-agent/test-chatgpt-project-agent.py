#!/usr/bin/env python3
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest

SCRIPT_DIR = Path(__file__).resolve().parent
MODULE_PATH = SCRIPT_DIR / "prepare-release.py"
SPEC = importlib.util.spec_from_file_location("chatgpt_project_agent_release", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load release helper")
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)

SETUP = SCRIPT_DIR / "setup-chatgpt-project-agent.sh"
INSTALL_ROOT = "chatgpt-project-agent-linux-x64"


class ChatGptProjectAgentTests(unittest.TestCase):
    maxDiff = None

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="chatgpt-project-agent-test-")
        self.root = Path(self.temp.name)
        self.tools_archive = self.root / "chatgpt-project-agent-tools-linux-x64.tar.zst"
        self.quiet_call(release.build_tools, self.tools_archive, 3)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def quiet_call(self, function, *args, **kwargs):
        with contextlib.redirect_stdout(io.StringIO()):
            return function(*args, **kwargs)

    def make_legacy_bootstrap(self) -> Path:
        legacy = self.root / "legacy" / "teasescript-agent-bootstrap-linux-x64-v5"
        required_files = {
            "runtime/node-v24.18.0-linux-x64/bin/node": "#!/bin/sh\necho v24.18.0\n",
            "runtime/node-v24.18.0-linux-x64/bin/npm": "#!/bin/sh\nexit 0\n",
            "runtime/node-v26.5.0-linux-x64/bin/node": "#!/bin/sh\necho v26.5.0\n",
            "runtime/node-v26.5.0-linux-x64/bin/npm": "#!/bin/sh\nexit 0\n",
            "npm-cache-seed/_cacache/content-v2/fixture": "cache\n",
            "optional-tools/ts-morph/packages/fixture.tgz": "ts-morph\n",
            "optional-tools/tiktoken-cp313-linux-x86_64/tokenizer/o200k_base.tiktoken": "tokenizer\n",
            "CACHE-SEED-ID": "fixture-cache-seed\n",
            "PACKAGE-INVENTORY.json": '{"formatVersion":1,"packages":[]}\n',
        }
        for relative, content in required_files.items():
            path = legacy / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
            if path.name in {"node", "npm"}:
                path.chmod(0o755)
        node = legacy / "runtime/node-v24.18.0-linux-x64/bin/node"
        os.link(node, node.with_name("node-hardlink"))
        os.symlink("node", node.with_name("node-link"))
        manifest = {
            "formatVersion": 5,
            "platform": "linux-x64",
            "layout": "single-extract-preexpanded-runtime-and-cache",
            "normalEntryPoint": "bin/prepare-agent-workspace.sh",
        }
        (legacy / "MANIFEST.json").write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        release.write_checksums(legacy, "SHA256SUMS")
        archive = self.root / "legacy.tar.zst"
        release.create_tar_zst(legacy, archive, 3)
        return archive

    def build_runtime(self) -> Path:
        output = self.root / "chatgpt-project-agent-runtime-linux-x64.tar.zst"
        self.quiet_call(release.build_runtime, self.make_legacy_bootstrap(), output, 3)
        return output

    def run_setup(
        self,
        runtime: Path,
        output: Path,
        tools: Path | None = None,
        verify_only: bool = False,
    ):
        if tools is None:
            tools = self.tools_archive
        command = [
            str(SETUP),
            "--tools-archive",
            str(tools),
            "--runtime-archive",
            str(runtime),
            "--output",
            str(output),
        ]
        if verify_only:
            command.append("--verify-only")
        return subprocess.run(command, text=True, capture_output=True)

    def archive_names(self, archive_path: Path) -> list[str]:
        process = subprocess.Popen(["zstd", "-q", "-d", "-c", str(archive_path)], stdout=subprocess.PIPE)
        assert process.stdout is not None
        with tarfile.open(fileobj=process.stdout, mode="r|") as archive:
            names = [member.name for member in archive]
        process.stdout.close()
        self.assertEqual(process.wait(), 0)
        return names

    def test_tools_archive_is_deterministic_and_excludes_project_only_sources(self) -> None:
        first = self.root / "first.tar.zst"
        second = self.root / "second.tar.zst"
        self.quiet_call(release.build_tools, first, 3)
        self.quiet_call(release.build_tools, second, 3)
        self.assertEqual(first.read_bytes(), second.read_bytes())
        names = self.archive_names(first)
        self.assertIn(f"{INSTALL_ROOT}/tools/prepare-source-review.py", names)
        self.assertIn(f"{INSTALL_ROOT}/docs/CODEX-MODEL-SELECTION.md", names)
        self.assertFalse(any("PROJECT-INSTRUCTIONS" in name for name in names))
        self.assertFalse(any(name.endswith("README-FIRST.md") for name in names))

    def test_runtime_archive_is_deterministic(self) -> None:
        legacy = self.make_legacy_bootstrap()
        first = self.root / "runtime-first.tar.zst"
        second = self.root / "runtime-second.tar.zst"
        self.quiet_call(release.build_runtime, legacy, first, 3)
        self.quiet_call(release.build_runtime, legacy, second, 3)
        self.assertEqual(first.read_bytes(), second.read_bytes())

    def test_runtime_split_setup_and_internal_links(self) -> None:
        runtime = self.build_runtime()
        output = self.root / "installed"
        result = self.run_setup(runtime, output)
        self.assertEqual(result.returncode, 0, result.stderr)
        node = output / "runtime/node-v24.18.0-linux-x64/bin/node"
        hardlink = node.with_name("node-hardlink")
        symlink = node.with_name("node-link")
        self.assertTrue(os.path.samefile(node, hardlink))
        self.assertTrue(symlink.is_symlink())
        self.assertEqual(os.readlink(symlink), "node")
        self.assertTrue((output / "bin/prepare-agent-workspace.sh").is_file())
        self.assertTrue(os.access(output / "bin/prepare-agent-workspace.sh", os.X_OK))

    def test_failed_refresh_preserves_existing_installation(self) -> None:
        runtime = self.build_runtime()
        output = self.root / "installed"
        success = self.run_setup(runtime, output)
        self.assertEqual(success.returncode, 0, success.stderr)
        marker = output / "existing-installation-marker"
        marker.write_text("keep\n", encoding="utf-8")
        original_node = (output / "runtime/node-v24.18.0-linux-x64/bin/node").read_bytes()

        extracted = self.root / "corrupt-extracted"
        runtime_root = release.safe_extract_tar_zst(runtime, extracted)
        (runtime_root / "runtime/node-v24.18.0-linux-x64/bin/node").write_text(
            "tampered\n", encoding="utf-8"
        )
        corrupt = self.root / "corrupt-runtime.tar.zst"
        release.create_tar_zst(runtime_root, corrupt, 3)
        failure = self.run_setup(corrupt, output)
        self.assertNotEqual(failure.returncode, 0)
        self.assertIn("mismatch", failure.stderr)
        self.assertEqual(marker.read_text(encoding="utf-8"), "keep\n")
        self.assertEqual(
            (output / "runtime/node-v24.18.0-linux-x64/bin/node").read_bytes(),
            original_node,
        )

    def rebuild_runtime(self, runtime: Path, name: str, mutate) -> Path:
        extracted = self.root / f"{name}-extracted"
        runtime_root = release.safe_extract_tar_zst(runtime, extracted)
        mutate(runtime_root)
        release.write_inventory(runtime_root, release.RUNTIME_INVENTORY)
        release.write_checksums(runtime_root, release.RUNTIME_CHECKSUMS)
        output = self.root / f"{name}.tar.zst"
        release.create_tar_zst(runtime_root, output, 3)
        return output

    def test_setup_rejects_unsupported_runtime_manifest(self) -> None:
        runtime = self.build_runtime()

        def mutate(root: Path) -> None:
            manifest_path = root / release.RUNTIME_MANIFEST
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["formatVersion"] = 2
            manifest_path.write_text(
                json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
            )

        invalid = self.rebuild_runtime(runtime, "invalid-manifest", mutate)
        result = self.run_setup(invalid, self.root / "unused", verify_only=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unsupported runtime manifest", result.stderr)

    def test_setup_rejects_runtime_contract_mismatch(self) -> None:
        runtime = self.build_runtime()

        def mutate(root: Path) -> None:
            manifest_path = root / release.RUNTIME_MANIFEST
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["runtimeContract"]["node"]["compatibility"] = "99.0.0"
            manifest_path.write_text(
                json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
            )

        invalid = self.rebuild_runtime(runtime, "contract-mismatch", mutate)
        result = self.run_setup(invalid, self.root / "unused", verify_only=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("tools/runtime contract mismatch", result.stderr)

    def test_setup_rejects_tools_runtime_path_conflict(self) -> None:
        runtime = self.build_runtime()

        def mutate(root: Path) -> None:
            conflict = root / "bin/prepare-agent-workspace.sh"
            conflict.parent.mkdir(parents=True, exist_ok=True)
            conflict.write_text("runtime conflict\n", encoding="utf-8")

        invalid = self.rebuild_runtime(runtime, "path-conflict", mutate)
        result = self.run_setup(invalid, self.root / "unused", verify_only=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("tools/runtime path conflicts", result.stderr)

    def test_setup_rejects_symlink_escape(self) -> None:
        runtime = self.build_runtime()
        raw_tar = self.root / "unsafe-link.tar"
        with tarfile.open(raw_tar, mode="w") as archive:
            root = tarfile.TarInfo(INSTALL_ROOT)
            root.type = tarfile.DIRTYPE
            root.mode = 0o755
            archive.addfile(root)
            link = tarfile.TarInfo(f"{INSTALL_ROOT}/escape-link")
            link.type = tarfile.SYMTYPE
            link.linkname = "../../escape"
            link.mode = 0o777
            archive.addfile(link)
        unsafe = self.root / "unsafe-link.tar.zst"
        with unsafe.open("wb") as target:
            subprocess.run(
                ["zstd", "-q", "-f", "-T1", "-3", "--stdout", str(raw_tar)],
                check=True,
                stdout=target,
            )
        result = self.run_setup(runtime, self.root / "unused", tools=unsafe, verify_only=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("archive link escapes root", result.stderr)
        self.assertFalse((self.root / "escape").exists())

    def test_setup_rejects_archive_path_traversal(self) -> None:
        runtime = self.build_runtime()
        raw_tar = self.root / "unsafe.tar"
        with tarfile.open(raw_tar, mode="w") as archive:
            info = tarfile.TarInfo("../escape")
            payload = b"escape\n"
            info.size = len(payload)
            archive.addfile(info, io.BytesIO(payload))
        unsafe = self.root / "unsafe.tar.zst"
        with unsafe.open("wb") as target:
            subprocess.run(
                ["zstd", "-q", "-f", "-T1", "-3", "--stdout", str(raw_tar)],
                check=True,
                stdout=target,
            )
        result = self.run_setup(runtime, self.root / "unused", tools=unsafe, verify_only=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unsafe archive path", result.stderr)
        self.assertFalse((self.root / "escape").exists())

    def test_setup_rejects_non_directory_output(self) -> None:
        runtime = self.build_runtime()
        output = self.root / "installed"
        output.write_text("do not replace\n", encoding="utf-8")
        result = self.run_setup(runtime, output)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("non-directory output", result.stderr)
        self.assertEqual(output.read_text(encoding="utf-8"), "do not replace\n")

    def test_project_staging_has_at_most_five_files(self) -> None:
        runtime = self.build_runtime()
        research = self.root / "TeaseScript-AI-Research-Archive.zip"
        research.write_bytes(b"research fixture")
        output = self.root / "project-folder"
        self.quiet_call(release.stage_project, runtime, output, research, self.tools_archive)
        names = sorted(path.name for path in output.iterdir())
        self.assertEqual(
            names,
            [
                "README-FIRST.md",
                "TeaseScript-AI-Research-Archive.zip",
                "chatgpt-project-agent-runtime-linux-x64.tar.zst",
                "chatgpt-project-agent-tools-linux-x64.tar.zst",
                "setup-chatgpt-project-agent.sh",
            ],
        )
        self.assertFalse(any("PROJECT-INSTRUCTIONS" in name for name in names))


if __name__ == "__main__":
    unittest.main(verbosity=2)
