#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/../.." && pwd)
project_root="$repo_root/tools/chatgpt-project-agent"
setup_source="$repo_root/tools/setup-chatgpt-project-agent.sh"
system_prompt="$repo_root/docs/chatgpt-project/SYSTEM-PROMPT.txt"
builder="$script_dir/build-chatgpt-project-agent-release.sh"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/test-chatgpt-project-agent.XXXXXX")
trap 'rm -rf -- "$tmp"' EXIT

python3 - \
  "$project_root" \
  "$setup_source" \
  "$system_prompt" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

project_root = Path(sys.argv[1])
setup_source = Path(sys.argv[2]).read_text()
system_prompt = Path(sys.argv[3]).read_text()
workspace_setup = (project_root / "bin/setup-workspace.sh").read_text()
tiktoken_installer = (project_root / "bin/install-tiktoken-offline.sh").read_text()
ts_morph_installer = (project_root / "bin/install-ts-morph-offline.sh").read_text()
manifest = json.loads((project_root / "MANIFEST.json").read_text())

SYSTEM_PROMPT_MAX_CHARACTERS = 8_000
if len(system_prompt) > SYSTEM_PROMPT_MAX_CHARACTERS:
    raise SystemExit(
        "ChatGPT project system prompt exceeds the 8,000-character external limit: "
        f"{len(system_prompt)}"
    )

if "target exists; use --replace or --target" not in setup_source:
    raise SystemExit("setup script does not fail safely for an existing target")
if "tools/runtime archive path conflict" not in setup_source or "filter=\"data\"" not in setup_source:
    raise SystemExit("setup script lacks conflict or safe-extraction enforcement")

expected_manifest = {
    "formatVersion": 1,
    "bundle": "chatgpt-project-agent-tools",
    "platform": "linux-x64",
    "installRoot": "chatgpt-project-agent",
    "runtimeContract": 1,
}
for key, value in expected_manifest.items():
    if manifest.get(key) != value:
        raise SystemExit(f"unexpected tools manifest {key}: {manifest.get(key)!r}")
if manifest.get("normalEntryPoint") != "bin/prepare-agent-workspace.sh":
    raise SystemExit("tools manifest lacks the normal workspace entrypoint")

if "optional-tools" in ts_morph_installer or "dependencies/ts-morph" not in ts_morph_installer:
    raise SystemExit("ts-morph installer does not use the final dependency path")
if "if ((with_ts_morph))" in workspace_setup or "ts-morph=required" not in workspace_setup:
    raise SystemExit("workspace setup still models ts-morph as optional")
if "npm cache verify" not in workspace_setup or "if ((debug_verify))" not in workspace_setup:
    raise SystemExit("complete npm-cache verification is not bounded to debug mode")
if "--no-index" not in tiktoken_installer or "--only-binary=:all:" not in tiktoken_installer:
    raise SystemExit("TikToken installer lacks strict offline binary-only installation")
if "--check-environment" not in tiktoken_installer or "refresh the runtime archive" not in tiktoken_installer:
    raise SystemExit("TikToken installer lacks the required compatibility diagnostic")
for required_offline_detail in (
    "TIKTOKEN_CACHE_DIR",
    "fb374d419588a4632f3f557e76b4b70aebbca790",
    'tiktoken.get_encoding("o200k_base")',
):
    if required_offline_detail not in tiktoken_installer:
        raise SystemExit(
            f"TikToken installer lacks standard offline tokenizer support: {required_offline_detail}"
        )
if "446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d" not in tiktoken_installer:
    raise SystemExit("TikToken installer lacks the official o200k_base vocabulary digest")

python_files = sorted(path.relative_to(project_root).as_posix() for path in project_root.rglob("*.py"))
if python_files != ["tools/prepare-source-review.py"]:
    raise SystemExit(f"tools bundle must contain one Python tool, found: {python_files!r}")
PY

for script in \
  "$setup_source" \
  "$builder" \
  "$project_root/bin/prepare-agent-workspace.sh" \
  "$project_root/bin/setup-workspace.sh" \
  "$project_root/bin/install-tiktoken-offline.sh" \
  "$project_root/bin/install-ts-morph-offline.sh"; do
  bash -n "$script"
  bash "$script" --help >/dev/null
done

runtime_parent="$tmp/runtime-source"
runtime_root="$runtime_parent/chatgpt-project-agent"
mkdir -p \
  "$runtime_root/runtime/node-v24.18.0-linux-x64/bin" \
  "$runtime_root/runtime/node-v26.5.0-linux-x64/bin" \
  "$runtime_root/npm-cache-seed/_cacache/content-v2" \
  "$runtime_root/dependencies/tiktoken-cp313-linux-x86_64/wheels" \
  "$runtime_root/dependencies/tiktoken-cp313-linux-x86_64/tokenizer" \
  "$runtime_root/dependencies/ts-morph/packages"

cat > "$runtime_root/RUNTIME-MANIFEST.json" <<'JSON'
{
  "formatVersion": 1,
  "bundle": "chatgpt-project-agent-runtime",
  "platform": "linux-x64",
  "installRoot": "chatgpt-project-agent",
  "runtimeContract": 1,
  "node": {"authoritative": "24.18.0", "compatibility": "26.5.0"},
  "tiktoken": {"version": "0.13.0", "pythonAbi": "cp313"},
  "tsMorph": {"version": "28.0.0"}
}
JSON
printf 'synthetic-cache-seed\n' > "$runtime_root/CACHE-SEED-ID"
printf '%s\n' '{"formatVersion":1,"packages":[]}' > "$runtime_root/PACKAGE-INVENTORY.json"
printf 'cache fixture\n' > "$runtime_root/npm-cache-seed/_cacache/content-v2/fixture"

for pair in '24.18.0 24' '26.5.0 26'; do
  set -- $pair
  version=$1
  major=$2
  cat > "$runtime_root/runtime/node-v${version}-linux-x64/bin/node" <<NODE
#!/usr/bin/env bash
printf 'v${version}\\n'
NODE
  cat > "$runtime_root/runtime/node-v${version}-linux-x64/bin/npm" <<NODE
#!/usr/bin/env bash
printf 'synthetic npm for Node ${major}\\n'
NODE
  chmod +x \
    "$runtime_root/runtime/node-v${version}-linux-x64/bin/node" \
    "$runtime_root/runtime/node-v${version}-linux-x64/bin/npm"
done

printf '%s\n' '{"formatVersion":1,"bundle":"synthetic-tiktoken"}' > \
  "$runtime_root/dependencies/tiktoken-cp313-linux-x86_64/MANIFEST.json"
printf 'synthetic vocabulary\n' > \
  "$runtime_root/dependencies/tiktoken-cp313-linux-x86_64/tokenizer/o200k_base.tiktoken"
printf 'synthetic wheel\n' > \
  "$runtime_root/dependencies/tiktoken-cp313-linux-x86_64/wheels/tiktoken-0.13.0-cp313.whl"
(
  cd "$runtime_root/dependencies/tiktoken-cp313-linux-x86_64"
  sha256sum MANIFEST.json tokenizer/o200k_base.tiktoken wheels/tiktoken-0.13.0-cp313.whl > SHA256SUMS
)
printf 'synthetic package\n' > "$runtime_root/dependencies/ts-morph/packages/ts-morph-28.0.0.tgz"
(
  cd "$runtime_root/dependencies/ts-morph"
  sha256sum packages/ts-morph-28.0.0.tgz > SHA256SUMS
)

nonempty_release="$tmp/nonempty-release"
mkdir -p "$nonempty_release"
printf 'stale\n' > "$nonempty_release/stale-file"
set +e
bash "$builder" --runtime-root "$runtime_root" --output "$nonempty_release" \
  >"$tmp/nonempty-release.out" 2>"$tmp/nonempty-release.err"
status=$?
set -e
[[ $status != 0 && -f "$nonempty_release/stale-file" ]] || {
  printf 'test-chatgpt-project-agent: FAIL: non-empty release output was accepted or modified\n' >&2
  exit 1
}
grep -F 'output directory must be empty' "$tmp/nonempty-release.err" >/dev/null

release="$tmp/release"
bash "$builder" --runtime-root "$runtime_root" --output "$release" >/dev/null
expected_release=(
  README-FIRST.md
  chatgpt-project-agent-runtime-linux-x64.tar.zst
  chatgpt-project-agent-tools-linux-x64.tar.gz
  setup-chatgpt-project-agent.sh
)
mapfile -t actual_release < <(find "$release" -mindepth 1 -maxdepth 1 -type f -printf '%f\n' | sort)
if tar -tzf "$release/chatgpt-project-agent-tools-linux-x64.tar.gz" | grep -F 'SYSTEM-PROMPT' >/dev/null; then
  printf 'test-chatgpt-project-agent: FAIL: system prompt entered the tools archive\n' >&2
  exit 1
fi
if tar --zstd -tf "$release/chatgpt-project-agent-runtime-linux-x64.tar.zst" | \
  grep -F 'SYSTEM-PROMPT' >/dev/null; then
  printf 'test-chatgpt-project-agent: FAIL: system prompt entered the runtime archive\n' >&2
  exit 1
fi
[[ "${actual_release[*]}" == "${expected_release[*]}" ]] || {
  printf 'test-chatgpt-project-agent: FAIL: unexpected release files: %s\n' "${actual_release[*]}" >&2
  exit 1
}

cat > "$tmp/python3.13" <<'PYTHON'
#!/usr/bin/env bash
set -euo pipefail
if [[ ${1-} == -S && ${2-} == - ]]; then
  cat >/dev/null
  printf 'cpython 3.13.0 on linux x86_64\n'
  exit 0
fi
if [[ ${1-} == -m && ${2-} == pip && ${3-} == --version ]]; then
  printf 'pip 25.0 from synthetic\n'
  exit 0
fi
printf 'unexpected synthetic Python invocation: %q\n' "$*" >&2
exit 1
PYTHON
chmod +x "$tmp/python3.13"

install="$tmp/install"
PYTHON_BIN="$tmp/python3.13" bash "$release/setup-chatgpt-project-agent.sh" --target "$install" >/dev/null
[[ -x "$install/bin/prepare-agent-workspace.sh" ]] || {
  printf 'test-chatgpt-project-agent: FAIL: installed entrypoint is missing\n' >&2
  exit 1
}
[[ -f "$install/dependencies/tiktoken-cp313-linux-x86_64/README.md" ]] || {
  printf 'test-chatgpt-project-agent: FAIL: maintained dependency README is missing\n' >&2
  exit 1
}
[[ ! -e "$install/README-FIRST.md" ]] || {
  printf 'test-chatgpt-project-agent: FAIL: project wayfinder was installed as a second README-FIRST.md\n' >&2
  exit 1
}

printf 'preserve me\n' > "$install/existing-marker"
set +e
PYTHON_BIN="$tmp/python3.13" bash "$release/setup-chatgpt-project-agent.sh" --target "$install" \
  >"$tmp/existing.out" 2>"$tmp/existing.err"
status=$?
set -e
[[ $status != 0 && -f "$install/existing-marker" ]] || {
  printf 'test-chatgpt-project-agent: FAIL: existing target was not refused safely\n' >&2
  exit 1
}
grep -F 'use --replace or --target' "$tmp/existing.err" >/dev/null

symlink_target="$tmp/install-link"
ln -s "$install" "$symlink_target"
set +e
PYTHON_BIN="$tmp/python3.13" bash "$release/setup-chatgpt-project-agent.sh" \
  --target "$symlink_target" --replace >"$tmp/symlink-target.out" 2>"$tmp/symlink-target.err"
status=$?
set -e
[[ $status != 0 && -L "$symlink_target" && -f "$install/existing-marker" ]] || {
  printf 'test-chatgpt-project-agent: FAIL: symbolic-link target was not refused safely\n' >&2
  exit 1
}
grep -F 'refusing to replace symbolic-link target' "$tmp/symlink-target.err" >/dev/null

bad_tools="$tmp/missing-command.tar.gz"
bad_tools_parent="$tmp/bad-tools-parent"
mkdir -p "$bad_tools_parent"
cp -a "$project_root" "$bad_tools_parent/chatgpt-project-agent"
rm "$bad_tools_parent/chatgpt-project-agent/bin/prepare-agent-workspace.sh"
tar -czf "$bad_tools" -C "$bad_tools_parent" chatgpt-project-agent
set +e
PYTHON_BIN="$tmp/python3.13" bash "$release/setup-chatgpt-project-agent.sh" \
  --tools "$bad_tools" --target "$install" --replace >"$tmp/missing.out" 2>"$tmp/missing.err"
status=$?
set -e
[[ $status != 0 && -f "$install/existing-marker" ]] || {
  printf 'test-chatgpt-project-agent: FAIL: failed replacement damaged the existing installation\n' >&2
  exit 1
}
grep -F 'tools archive is missing required regular file' "$tmp/missing.err" >/dev/null

bad_runtime_parent="$tmp/bad-runtime-parent"
cp -a "$runtime_parent" "$bad_runtime_parent"
printf 'conflict\n' > "$bad_runtime_parent/chatgpt-project-agent/README.md"
bad_runtime="$tmp/conflict-runtime.tar.zst"
tar --zstd -cf "$bad_runtime" -C "$bad_runtime_parent" chatgpt-project-agent
set +e
PYTHON_BIN="$tmp/python3.13" bash "$release/setup-chatgpt-project-agent.sh" \
  --runtime "$bad_runtime" --target "$tmp/conflict-install" >"$tmp/conflict.out" 2>"$tmp/conflict.err"
status=$?
set -e
[[ $status != 0 && ! -e "$tmp/conflict-install" ]] || {
  printf 'test-chatgpt-project-agent: FAIL: conflicting archives were accepted\n' >&2
  exit 1
}
grep -F 'tools/runtime archive path conflict' "$tmp/conflict.err" >/dev/null

mismatch_parent="$tmp/mismatch-runtime-parent"
cp -a "$runtime_parent" "$mismatch_parent"
python3 - "$mismatch_parent/chatgpt-project-agent/RUNTIME-MANIFEST.json" <<'PY'
import json
import sys
from pathlib import Path
path = Path(sys.argv[1])
value = json.loads(path.read_text())
value["runtimeContract"] = 2
path.write_text(json.dumps(value))
PY
mismatch_runtime="$tmp/mismatch-runtime.tar.zst"
tar --zstd -cf "$mismatch_runtime" -C "$mismatch_parent" chatgpt-project-agent
set +e
PYTHON_BIN="$tmp/python3.13" bash "$release/setup-chatgpt-project-agent.sh" \
  --runtime "$mismatch_runtime" --target "$tmp/mismatch-install" >"$tmp/mismatch.out" 2>"$tmp/mismatch.err"
status=$?
set -e
[[ $status != 0 && ! -e "$tmp/mismatch-install" ]] || {
  printf 'test-chatgpt-project-agent: FAIL: incompatible runtime contract was accepted\n' >&2
  exit 1
}
grep -F "runtimeContract' must be 1" "$tmp/mismatch.err" >/dev/null

malicious_tools="$tmp/path-traversal.tar.gz"
python3 - "$malicious_tools" "$project_root/MANIFEST.json" <<'PY'
import io
import sys
import tarfile
from pathlib import Path

archive = Path(sys.argv[1])
manifest = Path(sys.argv[2]).read_bytes()
with tarfile.open(archive, "w:gz") as tar:
    root = tarfile.TarInfo("chatgpt-project-agent")
    root.type = tarfile.DIRTYPE
    tar.addfile(root)
    info = tarfile.TarInfo("chatgpt-project-agent/MANIFEST.json")
    info.size = len(manifest)
    tar.addfile(info, io.BytesIO(manifest))
    payload = b"escape\n"
    bad = tarfile.TarInfo("chatgpt-project-agent/../../escape")
    bad.size = len(payload)
    tar.addfile(bad, io.BytesIO(payload))
PY
set +e
PYTHON_BIN="$tmp/python3.13" bash "$release/setup-chatgpt-project-agent.sh" \
  --tools "$malicious_tools" --target "$tmp/traversal-install" >"$tmp/traversal.out" 2>"$tmp/traversal.err"
status=$?
set -e
[[ $status != 0 && ! -e "$tmp/escape" && ! -e "$tmp/traversal-install" ]] || {
  printf 'test-chatgpt-project-agent: FAIL: path traversal archive was accepted\n' >&2
  exit 1
}
grep -F 'unsafe archive path' "$tmp/traversal.err" >/dev/null

nested_tools="$tmp/nested-under-symlink.tar.gz"
python3 - "$nested_tools" "$project_root/MANIFEST.json" <<'PY'
import io
import sys
import tarfile
from pathlib import Path

archive = Path(sys.argv[1])
manifest = Path(sys.argv[2]).read_bytes()
with tarfile.open(archive, "w:gz") as tar:
    root = tarfile.TarInfo("chatgpt-project-agent")
    root.type = tarfile.DIRTYPE
    tar.addfile(root)
    info = tarfile.TarInfo("chatgpt-project-agent/MANIFEST.json")
    info.size = len(manifest)
    tar.addfile(info, io.BytesIO(manifest))
    alias = tarfile.TarInfo("chatgpt-project-agent/alias")
    alias.type = tarfile.SYMTYPE
    alias.linkname = "docs"
    tar.addfile(alias)
    payload = b"nested\n"
    nested = tarfile.TarInfo("chatgpt-project-agent/alias/nested.txt")
    nested.size = len(payload)
    tar.addfile(nested, io.BytesIO(payload))
PY
set +e
PYTHON_BIN="$tmp/python3.13" bash "$release/setup-chatgpt-project-agent.sh" \
  --tools "$nested_tools" --target "$tmp/nested-install" >"$tmp/nested.out" 2>"$tmp/nested.err"
status=$?
set -e
[[ $status != 0 && ! -e "$tmp/nested-install" ]] || {
  printf 'test-chatgpt-project-agent: FAIL: archive entry nested below a symlink was accepted\n' >&2
  exit 1
}
grep -F 'archive non-directory entry contains nested paths' "$tmp/nested.err" >/dev/null

PYTHON_BIN="$tmp/python3.13" bash "$release/setup-chatgpt-project-agent.sh" \
  --target "$install" --replace >/dev/null
[[ ! -e "$install/existing-marker" && -x "$install/bin/prepare-agent-workspace.sh" ]] || {
  printf 'test-chatgpt-project-agent: FAIL: successful replacement did not install the complete tree\n' >&2
  exit 1
}

printf 'test-chatgpt-project-agent: PASS\n'
