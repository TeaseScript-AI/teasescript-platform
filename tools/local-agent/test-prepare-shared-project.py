#!/usr/bin/env python3
"""Focused tests for the shared-project bootstrap staging helper."""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from compact_unittest import run_compact_unittest

SCRIPT = Path(__file__).with_name("prepare-shared-project.py")
SPEC = importlib.util.spec_from_file_location("prepare_shared_project", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def run(command: list[str], *, cwd: Path | None = None) -> None:
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


class PrepareSharedProjectTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="prepare-shared-project-")
        self.root = Path(self.temporary.name)
        self.sources = self.root / "sources"
        self.sources.mkdir()
        self.shared_files = {
            "README-FIRST.md": self.sources / "README-FIRST.md",
            "TEASESCRIPT-AI-DEVELOPMENT-WORKFLOW-CONTEXT.md": (
                self.sources / "TEASESCRIPT-AI-DEVELOPMENT-WORKFLOW-CONTEXT.md"
            ),
            "LOCAL-AGENT-BOOTSTRAP.md": self.sources / "LOCAL-AGENT-BOOTSTRAP.md",
        }
        self.shared_files["README-FIRST.md"].write_text(
            "\n".join(
                [
                    "README-FIRST.md",
                    "TEASESCRIPT-AI-DEVELOPMENT-WORKFLOW-CONTEXT.md",
                    "LOCAL-AGENT-BOOTSTRAP.md",
                    MODULE.STABLE_ARCHIVE_NAME,
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        self.shared_files[
            "TEASESCRIPT-AI-DEVELOPMENT-WORKFLOW-CONTEXT.md"
        ].write_text(
            f"{MODULE.STABLE_ARCHIVE_NAME}\n{MODULE.NORMAL_ENTRY_POINT}\n",
            encoding="utf-8",
        )
        self.shared_files["LOCAL-AGENT-BOOTSTRAP.md"].write_text(
            "\n".join(
                [
                    MODULE.STABLE_ARCHIVE_NAME,
                    MODULE.STABLE_DIRECTORY_NAME,
                    MODULE.NORMAL_ENTRY_POINT,
                    "sole normal bootstrap entry point",
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        self.archive = self.create_archive("bootstrap-v5")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def create_archive(
        self,
        root_name: str,
        *,
        normal_entry_point: str = MODULE.NORMAL_ENTRY_POINT,
        include_entry_point: bool = True,
        format_version: int = 5,
        platform: str = "linux-x64",
        layout: str = "single-extract-preexpanded-runtime-and-cache",
        missing_help_option: str | None = None,
    ) -> Path:
        package_parent = self.root / f"package-{root_name}"
        package_root = package_parent / root_name
        (package_root / "bin").mkdir(parents=True)
        manifest = {
            "formatVersion": format_version,
            "platform": platform,
            "layout": layout,
            "normalEntryPoint": normal_entry_point,
        }
        (package_root / "MANIFEST.json").write_text(
            json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
        )
        (package_root / "README.md").write_text(
            f"Normal use: {MODULE.NORMAL_ENTRY_POINT}\n", encoding="utf-8"
        )
        if include_entry_point:
            entry_point = package_root / MODULE.NORMAL_ENTRY_POINT
            help_options = sorted(
                MODULE.EXPECTED_ENTRY_POINT_OPTIONS - {missing_help_option}
                if missing_help_option
                else MODULE.EXPECTED_ENTRY_POINT_OPTIONS
            )
            entry_point.write_text(
                "#!/usr/bin/env bash\n"
                "if [[ ${1-} == --help ]]; then\n"
                "  echo 'Normal agent entry point'\n"
                f"  echo '{' '.join(help_options)}'\n"
                "  exit 0\n"
                "fi\n"
                "exit 2\n",
                encoding="utf-8",
            )
            entry_point.chmod(0o755)
        checksummed = ["MANIFEST.json", "README.md"]
        if include_entry_point:
            checksummed.append(MODULE.NORMAL_ENTRY_POINT)
        completed = subprocess.run(
            ["sha256sum", *checksummed],
            cwd=package_root,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )
        (package_root / "SHA256SUMS").write_text(
            completed.stdout, encoding="utf-8"
        )
        archive = self.root / f"{root_name}.tar.zst"
        run(["tar", "--zstd", "-cf", str(archive), "-C", str(package_parent), root_name])
        return archive

    def test_stages_exact_stable_inventory_and_normalizes_archive_root(self) -> None:
        output = self.root / "replacement"
        manifest = MODULE.prepare_replacement(
            bootstrap_archive=self.archive,
            output_directory=output,
            shared_files=self.shared_files,
        )
        self.assertEqual(manifest["formatVersion"], 5)
        self.assertEqual(
            {path.name for path in output.iterdir()},
            set(self.shared_files) | {MODULE.STABLE_ARCHIVE_NAME},
        )
        listed = subprocess.run(
            ["tar", "--zstd", "-tf", str(output / MODULE.STABLE_ARCHIVE_NAME)],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        ).stdout.splitlines()
        self.assertTrue(listed)
        self.assertTrue(
            all(
                line == f"{MODULE.STABLE_DIRECTORY_NAME}/"
                or line.startswith(f"{MODULE.STABLE_DIRECTORY_NAME}/")
                for line in listed
            )
        )
        for name, source in self.shared_files.items():
            self.assertEqual((output / name).read_bytes(), source.read_bytes())

    def test_rejects_retired_or_unstable_shared_routing(self) -> None:
        self.shared_files["README-FIRST.md"].write_text(
            "tools/work-packages/README.md\n", encoding="utf-8"
        )
        with self.assertRaisesRegex(MODULE.PreparationError, "retired or unstable"):
            MODULE.prepare_replacement(
                bootstrap_archive=self.archive,
                output_directory=self.root / "replacement",
                shared_files=self.shared_files,
            )

    def test_rejects_manifest_entry_point_mismatch(self) -> None:
        archive = self.create_archive(
            "bootstrap-wrong-entry",
            normal_entry_point="bin/other.sh",
        )
        with self.assertRaisesRegex(MODULE.PreparationError, "normalEntryPoint"):
            MODULE.prepare_replacement(
                bootstrap_archive=archive,
                output_directory=self.root / "replacement",
                shared_files=self.shared_files,
            )

    def test_rejects_stale_bootstrap_release(self) -> None:
        archive = self.create_archive("bootstrap-v4", format_version=4)
        with self.assertRaisesRegex(MODULE.PreparationError, "formatVersion"):
            MODULE.prepare_replacement(
                bootstrap_archive=archive,
                output_directory=self.root / "replacement",
                shared_files=self.shared_files,
            )

    def test_rejects_missing_documented_entry_point_option(self) -> None:
        archive = self.create_archive(
            "bootstrap-missing-option",
            missing_help_option="--with-tiktoken",
        )
        with self.assertRaisesRegex(MODULE.PreparationError, "--with-tiktoken"):
            MODULE.prepare_replacement(
                bootstrap_archive=archive,
                output_directory=self.root / "replacement",
                shared_files=self.shared_files,
            )

    def test_rejects_missing_normal_entry_point(self) -> None:
        archive = self.create_archive("bootstrap-missing-entry", include_entry_point=False)
        with self.assertRaisesRegex(MODULE.PreparationError, "lacks required members"):
            MODULE.prepare_replacement(
                bootstrap_archive=archive,
                output_directory=self.root / "replacement",
                shared_files=self.shared_files,
            )

    def test_refuses_to_overlay_an_existing_output_directory(self) -> None:
        output = self.root / "replacement"
        output.mkdir()
        (output / "old.txt").write_text("old\n", encoding="utf-8")
        with self.assertRaisesRegex(MODULE.PreparationError, "already exists"):
            MODULE.prepare_replacement(
                bootstrap_archive=self.archive,
                output_directory=output,
                shared_files=self.shared_files,
            )
        self.assertEqual((output / "old.txt").read_text(), "old\n")


if __name__ == "__main__":
    run_compact_unittest("prepare-shared-project")
