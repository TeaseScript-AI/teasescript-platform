#!/usr/bin/env python3
"""Turn one downloaded source-bundle artifact into a verified local checkout."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile

EXPECTED_FILES = {"SHA256SUMS", "manifest.json", "repository.bundle"}
EXPECTED_CHECKSUM_FILES = {"manifest.json", "repository.bundle"}
MAX_UNCOMPRESSED_BYTES = 128 * 1024 * 1024
MAX_METADATA_BYTES = 1024 * 1024
SHA1_RE = re.compile(r"^[0-9a-f]{40}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
REPOSITORY_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


class PreparationError(RuntimeError):
    """Expected validation or local preparation failure."""


def fail(message: str) -> PreparationError:
    return PreparationError(message)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Verify a downloaded TeaseScript source-bundle ZIP and atomically "
            "create a clean local review checkout."
        )
    )
    parser.add_argument("--artifact", required=True, type=Path)
    parser.add_argument("--artifact-sha256", required=True)
    parser.add_argument("--expected-repository", required=True)
    parser.add_argument("--expected-head", required=True)
    parser.add_argument(
        "--expected-merge-base",
        help=(
            "optional merge-base commit from compare_commits; must be present "
            "in the bundle and an ancestor of --expected-head"
        ),
    )
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run(command: list[str], *, cwd: Path | None = None) -> str:
    try:
        completed = subprocess.run(
            command,
            cwd=cwd,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
    except OSError as exc:
        raise fail(f"cannot run {command[0]}: {exc}") from exc
    if completed.returncode != 0:
        output = completed.stdout.strip()
        detail = f"\n{output}" if output else ""
        raise fail(
            f"command failed with exit code {completed.returncode}: "
            f"{' '.join(command)}{detail}"
        )
    return completed.stdout.strip()


def validate_arguments(args: argparse.Namespace) -> tuple[Path, Path]:
    artifact_input = args.artifact.expanduser()
    try:
        artifact_stat = artifact_input.lstat()
    except OSError as exc:
        raise fail(f"artifact is not accessible: {artifact_input}: {exc}") from exc
    if stat.S_ISLNK(artifact_stat.st_mode) or not stat.S_ISREG(artifact_stat.st_mode):
        raise fail("--artifact must name a regular non-symlink file")
    artifact = artifact_input.resolve()

    if not SHA256_RE.fullmatch(args.artifact_sha256):
        raise fail("--artifact-sha256 must be 64 lowercase hexadecimal characters")
    if not REPOSITORY_RE.fullmatch(args.expected_repository):
        raise fail("--expected-repository must use OWNER/REPOSITORY format")
    if not SHA1_RE.fullmatch(args.expected_head):
        raise fail("--expected-head must be a full lowercase 40-character Git SHA-1")
    if args.expected_merge_base is not None and not SHA1_RE.fullmatch(
        args.expected_merge_base
    ):
        raise fail(
            "--expected-merge-base must be a full lowercase 40-character Git SHA-1"
        )

    output_input = args.output.expanduser()
    try:
        output_exists = output_input.exists() or output_input.is_symlink()
    except OSError as exc:
        raise fail(f"output path is not accessible: {output_input}: {exc}") from exc
    if output_exists:
        raise fail(f"output path already exists: {output_input}")
    try:
        output = output_input.resolve()
    except (OSError, RuntimeError) as exc:
        raise fail(f"output path cannot be resolved: {output_input}: {exc}") from exc
    if output == artifact:
        raise fail("--output must not equal --artifact")
    try:
        output.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise fail(f"cannot create output parent: {output.parent}: {exc}") from exc
    if not output.parent.is_dir():
        raise fail(f"output parent is not a directory: {output.parent}")
    return artifact, output


def validate_zip_info(info: zipfile.ZipInfo) -> None:
    name = info.filename
    path = PurePosixPath(name)
    if (
        not name
        or "\\" in name
        or path.is_absolute()
        or len(path.parts) != 1
        or any(part in {"", ".", ".."} for part in path.parts)
    ):
        raise fail(f"unsafe ZIP entry: {name!r}")
    if info.is_dir():
        raise fail(f"unexpected ZIP directory: {name!r}")
    mode = (info.external_attr >> 16) & 0xFFFF
    file_type = stat.S_IFMT(mode)
    if file_type == stat.S_IFLNK:
        raise fail(f"symbolic-link ZIP entry is not allowed: {name!r}")
    if file_type not in {0, stat.S_IFREG}:
        raise fail(f"non-regular ZIP entry is not allowed: {name!r}")


def extract_artifact(artifact: Path, destination: Path) -> None:
    try:
        with zipfile.ZipFile(artifact) as archive:
            infos = archive.infolist()
            names: set[str] = set()
            total = 0
            for info in infos:
                validate_zip_info(info)
                if info.filename in names:
                    raise fail(f"duplicate ZIP entry: {info.filename}")
                names.add(info.filename)
                total += info.file_size
                if total > MAX_UNCOMPRESSED_BYTES:
                    raise fail("artifact exceeds the 128 MiB uncompressed safety limit")
                if info.filename in {"SHA256SUMS", "manifest.json"} and (
                    info.file_size > MAX_METADATA_BYTES
                ):
                    raise fail(f"metadata file is unexpectedly large: {info.filename}")
            if names != EXPECTED_FILES:
                missing = sorted(EXPECTED_FILES - names)
                extra = sorted(names - EXPECTED_FILES)
                raise fail(f"unexpected artifact payload: missing={missing}, extra={extra}")

            destination.mkdir(mode=0o700)
            for info in infos:
                target = destination / info.filename
                with archive.open(info) as source, target.open("xb") as sink:
                    shutil.copyfileobj(source, sink, length=1024 * 1024)
    except PreparationError:
        raise
    except (
        zipfile.BadZipFile,
        zipfile.LargeZipFile,
        NotImplementedError,
        OSError,
        EOFError,
        RuntimeError,
    ) as exc:
        raise fail(f"cannot extract ZIP archive: {exc}") from exc


def parse_checksums(path: Path) -> dict[str, str]:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise fail(f"cannot read SHA256SUMS: {exc}") from exc
    checksums: dict[str, str] = {}
    for line_number, line in enumerate(text.splitlines(), start=1):
        match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9._-]+)", line)
        if match is None:
            raise fail(f"invalid SHA256SUMS line {line_number}")
        digest, name = match.groups()
        if name in checksums:
            raise fail(f"duplicate SHA256SUMS entry: {name}")
        checksums[name] = digest
    if set(checksums) != EXPECTED_CHECKSUM_FILES:
        raise fail("SHA256SUMS must contain exactly manifest.json and repository.bundle")
    return checksums


def verify_internal_checksums(directory: Path) -> str:
    checksums = parse_checksums(directory / "SHA256SUMS")
    for name, expected in checksums.items():
        actual = sha256_file(directory / name)
        if not hmac.compare_digest(actual, expected):
            raise fail(f"SHA-256 mismatch for {name}: expected {expected}, got {actual}")
    return checksums["repository.bundle"]


def require_string(manifest: dict[str, object], key: str) -> str:
    value = manifest.get(key)
    if not isinstance(value, str) or not value:
        raise fail(f"manifest field {key!r} must be a non-empty string")
    return value


def verify_manifest(
    path: Path,
    *,
    expected_repository: str,
    expected_head: str,
    bundle_sha256: str,
) -> tuple[str, str]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise fail(f"cannot parse manifest.json: {exc}") from exc
    if not isinstance(value, dict):
        raise fail("manifest.json must contain a JSON object")
    if value.get("formatVersion") != 1:
        raise fail("unsupported manifest formatVersion; expected 1")

    repository = require_string(value, "repository")
    commit = require_string(value, "commitSha")
    tree = require_string(value, "treeSha")
    require_string(value, "sourceRef")
    bundle_ref = require_string(value, "bundleRef")
    require_string(value, "eventName")
    manifest_bundle_sha = require_string(value, "bundleSha256")

    if repository != expected_repository:
        raise fail(f"repository mismatch: expected {expected_repository}, got {repository}")
    if commit != expected_head:
        raise fail(f"head mismatch: expected {expected_head}, got {commit}")
    if not SHA1_RE.fullmatch(commit) or not SHA1_RE.fullmatch(tree):
        raise fail("manifest commitSha and treeSha must be full lowercase Git SHA-1 values")
    if bundle_ref != "refs/heads/source-bundle":
        raise fail(f"unexpected manifest bundleRef: {bundle_ref}")
    if not SHA256_RE.fullmatch(manifest_bundle_sha):
        raise fail("manifest bundleSha256 is invalid")
    if not hmac.compare_digest(manifest_bundle_sha, bundle_sha256):
        raise fail("manifest bundleSha256 does not match repository.bundle")
    return commit, tree


def verify_bundle_heads(bundle: Path, expected_head: str) -> None:
    output = run(["git", "bundle", "list-heads", str(bundle)])
    heads: dict[str, str] = {}
    for line in output.splitlines():
        try:
            sha, ref = line.split(" ", 1)
        except ValueError as exc:
            raise fail(f"unexpected git bundle list-heads output: {line!r}") from exc
        heads[ref] = sha
    for ref in ("HEAD", "refs/heads/source-bundle"):
        if heads.get(ref) != expected_head:
            raise fail(
                f"bundle head mismatch for {ref}: expected {expected_head}, "
                f"got {heads.get(ref)!r}"
            )


def verify_and_expose_checkout(
    artifact_directory: Path,
    output: Path,
    *,
    expected_head: str,
    expected_tree: str,
    expected_merge_base: str | None,
) -> None:
    bundle = artifact_directory / "repository.bundle"
    verify_bundle_heads(bundle, expected_head)

    with tempfile.TemporaryDirectory(prefix="source-review-bare-", dir=output.parent) as name:
        bare = Path(name)
        run(["git", "init", "--bare", "--quiet", str(bare)])
        verification = run(["git", "-C", str(bare), "bundle", "verify", str(bundle)])
        if "complete history" not in verification.lower():
            raise fail("git bundle verify did not report complete history")

    temporary = Path(tempfile.mkdtemp(prefix=f".{output.name}.tmp-", dir=output.parent))
    try:
        temporary.rmdir()
        run(["git", "clone", "--quiet", str(bundle), str(temporary)])
        actual_head = run(["git", "-C", str(temporary), "rev-parse", "HEAD"])
        actual_tree = run(["git", "-C", str(temporary), "rev-parse", "HEAD^{tree}"])
        if actual_head != expected_head:
            raise fail(f"cloned HEAD mismatch: expected {expected_head}, got {actual_head}")
        if actual_tree != expected_tree:
            raise fail(f"cloned tree mismatch: expected {expected_tree}, got {actual_tree}")
        if expected_merge_base is not None:
            merge_base_check = subprocess.run(
                [
                    "git",
                    "-C",
                    str(temporary),
                    "cat-file",
                    "-e",
                    f"{expected_merge_base}^{{commit}}",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
            if merge_base_check.returncode != 0:
                raise fail(
                    "expected merge base is absent from bundle history: "
                    f"{expected_merge_base}"
                )
            relationship = subprocess.run(
                [
                    "git",
                    "-C",
                    str(temporary),
                    "merge-base",
                    "--is-ancestor",
                    expected_merge_base,
                    expected_head,
                ],
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                encoding="utf-8",
                errors="replace",
                check=False,
            )
            if relationship.returncode == 1:
                raise fail(
                    "expected merge base is not an ancestor of head: "
                    f"merge_base={expected_merge_base}, head={expected_head}"
                )
            if relationship.returncode != 0:
                detail = relationship.stdout.strip()
                suffix = f": {detail}" if detail else ""
                raise fail(
                    "cannot verify expected merge-base relationship" + suffix
                )
        run(["git", "-C", str(temporary), "fsck", "--full", "--strict"])
        status = run(
            [
                "git",
                "-C",
                str(temporary),
                "status",
                "--porcelain=v1",
                "--untracked-files=all",
            ]
        )
        if status:
            raise fail("cloned worktree is not clean")
        run(["git", "-C", str(temporary), "remote", "remove", "origin"])
        os.replace(temporary, output)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary, ignore_errors=True)


def main() -> int:
    args = parse_args()
    try:
        artifact, output = validate_arguments(args)
        outer_digest = sha256_file(artifact)
        if not hmac.compare_digest(outer_digest, args.artifact_sha256):
            raise fail(
                "outer artifact SHA-256 mismatch: "
                f"expected {args.artifact_sha256}, got {outer_digest}"
            )
        with tempfile.TemporaryDirectory(
            prefix="source-review-artifact-", dir=output.parent
        ) as temporary_name:
            extracted = Path(temporary_name)
            extracted.rmdir()
            extract_artifact(artifact, extracted)
            bundle_digest = verify_internal_checksums(extracted)
            head, tree = verify_manifest(
                extracted / "manifest.json",
                expected_repository=args.expected_repository,
                expected_head=args.expected_head,
                bundle_sha256=bundle_digest,
            )
            verify_and_expose_checkout(
                extracted,
                output,
                expected_head=head,
                expected_tree=tree,
                expected_merge_base=args.expected_merge_base,
            )
        merge_base = args.expected_merge_base or "none"
        print(
            f"prepare-source-review: PASS output={output} head={head} "
            f"tree={tree} merge_base={merge_base}"
        )
        return 0
    except PreparationError as exc:
        print(f"prepare-source-review: FAIL: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
