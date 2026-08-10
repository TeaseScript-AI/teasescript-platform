#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: setup-chatgpt-project-agent.sh [OPTIONS]

Assemble the ChatGPT project-agent tools and runtime archives into one verified
installation.

Options:
  --tools FILE      Tools archive (default: sibling stable filename)
  --runtime FILE    Runtime archive (default: sibling stable filename)
  --target DIR      Installation directory (default: /mnt/data/chatgpt-project-agent)
  --replace         Replace an existing target only after assembly succeeds
  -h, --help        Show this help
USAGE
}

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
tools_archive="$script_dir/chatgpt-project-agent-tools-linux-x64.tar.gz"
runtime_archive="$script_dir/chatgpt-project-agent-runtime-linux-x64.tar.zst"
target=/mnt/data/chatgpt-project-agent
replace=0

while (($#)); do
  case "$1" in
    --tools) (($# >= 2)) || { usage >&2; exit 2; }; tools_archive=$2; shift 2 ;;
    --runtime) (($# >= 2)) || { usage >&2; exit 2; }; runtime_archive=$2; shift 2 ;;
    --target) (($# >= 2)) || { usage >&2; exit 2; }; target=$2; shift 2 ;;
    --replace) replace=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'setup-chatgpt-project-agent: FAIL: unknown or incomplete argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

command -v python3 >/dev/null 2>&1 || {
  printf 'setup-chatgpt-project-agent: FAIL: python3 is required to validate archives\n' >&2
  exit 1
}
command -v zstd >/dev/null 2>&1 || {
  printf 'setup-chatgpt-project-agent: FAIL: zstd is required to read the runtime archive\n' >&2
  exit 1
}

[[ -f "$tools_archive" && ! -L "$tools_archive" ]] || {
  printf 'setup-chatgpt-project-agent: FAIL: tools archive is not a regular file: %s\n' "$tools_archive" >&2
  exit 1
}
[[ -f "$runtime_archive" && ! -L "$runtime_archive" ]] || {
  printf 'setup-chatgpt-project-agent: FAIL: runtime archive is not a regular file: %s\n' "$runtime_archive" >&2
  exit 1
}

target=$(python3 -S - "$target" <<'PY'
import os
import sys

print(os.path.abspath(os.path.expanduser(sys.argv[1])))
PY
)
[[ "$target" != / ]] || {
  printf 'setup-chatgpt-project-agent: FAIL: refusing target /\n' >&2
  exit 2
}
if [[ -e "$target" || -L "$target" ]]; then
  ((replace)) || {
    printf 'setup-chatgpt-project-agent: FAIL: target exists; use --replace or --target: %s\n' "$target" >&2
    exit 1
  }
  [[ ! -L "$target" ]] || {
    printf 'setup-chatgpt-project-agent: FAIL: refusing to replace symbolic-link target: %s\n' "$target" >&2
    exit 1
  }
fi

parent=$(dirname -- "$target")
base=$(basename -- "$target")
mkdir -p -- "$parent"
temporary=$(mktemp -d "$parent/.${base}.install.XXXXXX")
backup=
cleanup() {
  status=$?
  if [[ -n "$backup" && -e "$backup" && ! -e "$target" ]]; then
    mv -- "$backup" "$target" || true
  fi
  rm -rf -- "$temporary"
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

printf 'setup-chatgpt-project-agent: INFO: normal setup takes about 2-3 seconds in the target environment\n'
printf 'setup-chatgpt-project-agent: INFO: validating tools archive\n'
runtime_tar="$temporary/runtime.tar"
printf 'setup-chatgpt-project-agent: INFO: decompressing runtime archive\n'
zstd -q -d -c -- "$runtime_archive" > "$runtime_tar"

python3 -S - "$tools_archive" "$runtime_tar" "$temporary" <<'PY'
from __future__ import annotations

import json
import os
import posixpath
import stat
import sys
import tarfile
from pathlib import Path, PurePosixPath

TOOLS_ARCHIVE = Path(sys.argv[1])
RUNTIME_TAR = Path(sys.argv[2])
DESTINATION = Path(sys.argv[3])
ROOT = "chatgpt-project-agent"


def fail(message: str) -> SystemExit:
    return SystemExit(f"setup-chatgpt-project-agent: FAIL: {message}")


def clean_name(name: str) -> str:
    if not name or "\x00" in name or any(ord(character) < 32 for character in name):
        raise fail(f"unsafe archive path: {name!r}")
    path = PurePosixPath(name)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise fail(f"unsafe archive path: {name!r}")
    if path.parts[0] != ROOT:
        raise fail(f"archive entry is outside {ROOT}/: {name!r}")
    return path.as_posix()


def resolved_link(member: tarfile.TarInfo) -> str:
    link = PurePosixPath(member.linkname)
    if link.is_absolute():
        raise fail(f"absolute archive link is not allowed: {member.name!r}")
    if member.issym():
        combined = PurePosixPath(member.name).parent.joinpath(link)
    else:
        combined = link
    normalized = posixpath.normpath(combined.as_posix())
    path = PurePosixPath(normalized)
    if not path.parts or path.parts[0] != ROOT or ".." in path.parts:
        raise fail(f"archive link escapes {ROOT}/: {member.name!r} -> {member.linkname!r}")
    return path.as_posix()


def inspect(archive: tarfile.TarFile, label: str) -> tuple[dict[str, tarfile.TarInfo], set[str]]:
    members: dict[str, tarfile.TarInfo] = {}
    payload: set[str] = set()
    for member in archive.getmembers():
        name = clean_name(member.name)
        if name in members:
            raise fail(f"duplicate {label} archive entry: {name}")
        members[name] = member
        if member.isdir():
            continue
        if member.isreg():
            payload.add(name)
            continue
        if member.issym() or member.islnk():
            resolved_link(member)
            payload.add(name)
            continue
        raise fail(f"unsupported {label} archive entry type: {name}")
    return members, payload


def load_manifest(archive: tarfile.TarFile, members: dict[str, tarfile.TarInfo], relative: str) -> dict[str, object]:
    name = f"{ROOT}/{relative}"
    member = members.get(name)
    if member is None or not member.isreg() or member.size > 64 * 1024:
        raise fail(f"missing or invalid manifest: {name}")
    extracted = archive.extractfile(member)
    if extracted is None:
        raise fail(f"cannot read manifest: {name}")
    try:
        value = json.load(extracted)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise fail(f"cannot parse {name}: {error}") from error
    if not isinstance(value, dict):
        raise fail(f"manifest must be an object: {name}")
    return value


def require_manifest(manifest: dict[str, object], *, bundle: str) -> None:
    expected = {
        "formatVersion": 1,
        "bundle": bundle,
        "platform": "linux-x64",
        "installRoot": ROOT,
        "runtimeContract": 1,
    }
    for key, value in expected.items():
        if manifest.get(key) != value:
            raise fail(f"{bundle} manifest field {key!r} must be {value!r}")


try:
    tools = tarfile.open(TOOLS_ARCHIVE, mode="r:gz")
    runtime = tarfile.open(RUNTIME_TAR, mode="r:")
except (tarfile.TarError, OSError) as error:
    raise fail(f"cannot open archive: {error}") from error

with tools, runtime:
    tools_members, tools_payload = inspect(tools, "tools")
    runtime_members, runtime_payload = inspect(runtime, "runtime")

    shared_paths = sorted(set(tools_members) & set(runtime_members))
    for name in shared_paths:
        if not (tools_members[name].isdir() and runtime_members[name].isdir()):
            raise fail(f"tools/runtime archive path conflict: {name}")

    payload_names = tools_payload | runtime_payload
    sorted_names = sorted(set(tools_members) | set(runtime_members))
    for index, name in enumerate(sorted_names[:-1]):
        # In lexical order, the first descendant immediately follows its prefix.
        if name in payload_names and sorted_names[index + 1].startswith(f"{name}/"):
            raise fail(f"archive non-directory entry contains nested paths: {name}")

    tools_manifest = load_manifest(tools, tools_members, "MANIFEST.json")
    runtime_manifest = load_manifest(runtime, runtime_members, "RUNTIME-MANIFEST.json")
    require_manifest(tools_manifest, bundle="chatgpt-project-agent-tools")
    require_manifest(runtime_manifest, bundle="chatgpt-project-agent-runtime")

    if tools_manifest.get("normalEntryPoint") != "bin/prepare-agent-workspace.sh":
        raise fail("tools manifest normalEntryPoint must be 'bin/prepare-agent-workspace.sh'")

    required_tools = tools_manifest.get("requiredPaths")
    if not isinstance(required_tools, list) or not required_tools:
        raise fail("tools manifest requiredPaths must be a non-empty array")
    canonical_required_tools = {
        "bin/prepare-agent-workspace.sh",
        "bin/setup-workspace.sh",
        "bin/install-tiktoken-offline.sh",
        "bin/install-ts-morph-offline.sh",
        "tools/prepare-source-review.py",
        "docs/LOCAL-AGENT-BOOTSTRAP.md",
        "docs/DEVELOPMENT-WORKFLOW-CONTEXT.md",
        "docs/PROJECT-INSTRUCTIONS.txt",
        "docs/CODEX-MODEL-SELECTION.md",
        "docs/CODEX-PROMPTING.md",
    }
    if not canonical_required_tools.issubset(set(required_tools)):
        raise fail("tools manifest omits a canonical required path")
    for relative in required_tools:
        name = f"{ROOT}/{relative}"
        member = tools_members.get(name) if isinstance(relative, str) else None
        if member is None or not member.isreg():
            raise fail(f"tools archive is missing required regular file: {relative!r}")

    required_runtime = (
        "RUNTIME-MANIFEST.json",
        "CACHE-SEED-ID",
        "PACKAGE-INVENTORY.json",
        "runtime/node-v24.18.0-linux-x64/bin/node",
        "runtime/node-v24.18.0-linux-x64/bin/npm",
        "runtime/node-v26.5.0-linux-x64/bin/node",
        "runtime/node-v26.5.0-linux-x64/bin/npm",
        "dependencies/tiktoken-cp313-linux-x86_64/MANIFEST.json",
        "dependencies/tiktoken-cp313-linux-x86_64/SHA256SUMS",
        "dependencies/tiktoken-cp313-linux-x86_64/tokenizer/o200k_base.tiktoken",
        "dependencies/ts-morph/SHA256SUMS",
        "dependencies/ts-morph/packages/ts-morph-28.0.0.tgz",
    )
    for relative in required_runtime:
        if f"{ROOT}/{relative}" not in runtime_payload:
            raise fail(f"runtime archive is missing required path: {relative}")
    if not any(name.startswith(f"{ROOT}/npm-cache-seed/_cacache/") for name in runtime_payload):
        raise fail("runtime archive lacks the npm cache seed")
    if not any(name.startswith(f"{ROOT}/dependencies/tiktoken-cp313-linux-x86_64/wheels/") for name in runtime_payload):
        raise fail("runtime archive lacks TikToken wheels")

    tools.extractall(DESTINATION, filter="data")
    runtime.extractall(DESTINATION, filter="data")

installed = DESTINATION / ROOT
if (installed / "README-FIRST.md").exists():
    raise fail("installed tree must not contain README-FIRST.md")
if any(path.is_file() for path in installed.rglob("SYSTEM-PROMPT.txt")):
    raise fail("installed tree must not contain the ChatGPT project system prompt")
for relative in required_tools:
    path = installed / relative
    if not path.is_file():
        raise fail(f"installed required path is not a file: {relative}")
for relative in required_runtime:
    path = installed / relative
    if not path.is_file():
        raise fail(f"installed runtime path is not a file: {relative}")
PY

install_root="$temporary/chatgpt-project-agent"
rm -f -- "$runtime_tar"

printf 'setup-chatgpt-project-agent: INFO: checking installed entrypoints\n'
for script in \
  "$install_root/bin/prepare-agent-workspace.sh" \
  "$install_root/bin/setup-workspace.sh" \
  "$install_root/bin/install-tiktoken-offline.sh" \
  "$install_root/bin/install-ts-morph-offline.sh"; do
  bash -n -- "$script"
  bash "$script" --help >/dev/null
done
"$install_root/runtime/node-v24.18.0-linux-x64/bin/node" --version | grep -Fx 'v24.18.0' >/dev/null
"$install_root/runtime/node-v26.5.0-linux-x64/bin/node" --version | grep -Fx 'v26.5.0' >/dev/null
bash "$install_root/bin/install-tiktoken-offline.sh" --check-environment >/dev/null

if [[ -e "$target" || -L "$target" ]]; then
  backup="$parent/.${base}.backup.$$.${RANDOM}"
  mv -- "$target" "$backup"
fi
if ! mv -- "$install_root" "$target"; then
  if [[ -n "$backup" && -e "$backup" && ! -e "$target" ]]; then
    mv -- "$backup" "$target"
    backup=
  fi
  printf 'setup-chatgpt-project-agent: FAIL: cannot place completed installation\n' >&2
  exit 1
fi
if [[ -n "$backup" ]]; then
  rm -rf -- "$backup" || {
    printf 'setup-chatgpt-project-agent: WARN: old installation remains at %s\n' "$backup" >&2
  }
  backup=
fi

printf 'setup-chatgpt-project-agent: PASS target=%s\n' "$target"
