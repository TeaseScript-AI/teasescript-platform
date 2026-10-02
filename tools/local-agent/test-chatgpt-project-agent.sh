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

python3 - "$system_prompt" <<'PY'
import sys
from pathlib import Path

system_prompt = Path(sys.argv[1]).read_text()

SYSTEM_PROMPT_MAX_CHARACTERS = 8_000
if len(system_prompt) > SYSTEM_PROMPT_MAX_CHARACTERS:
    raise SystemExit(
        "ChatGPT project system prompt exceeds the 8,000-character external limit: "
        f"{len(system_prompt)}"
    )
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

# Synthetic CPython: runs the installer's real host probe against controlled host facts and records
# installation, verification and runner calls.
cat > "$tmp/python3.13" <<'PYTHON'
#!/usr/bin/env bash
set -euo pipefail
record() {
  [[ -z ${PYTHON_CALLS-} ]] || printf '%s\n' "$*" >> "$PYTHON_CALLS"
}
if [[ ${1-} == -S && ${2-} == - ]]; then
  exec python3 -S -c '
import os, sys, types
version = os.environ.get("FAKE_PYTHON_VERSION", "3.13.0")
sys.version_info = (*(int(part) for part in version.split(".")), "final", 0)
sys.version = version + " (synthetic)"
sys.implementation = types.SimpleNamespace(name=os.environ.get("FAKE_PYTHON_IMPLEMENTATION", "cpython"))
sys.platform = os.environ.get("FAKE_PYTHON_PLATFORM", "linux")
machine = os.environ.get("FAKE_PYTHON_MACHINE", "x86_64")
os.uname = lambda: types.SimpleNamespace(machine=machine)
exec(compile(sys.stdin.read(), "<installer host probe>", "exec"))
'
fi
if [[ ${1-} == --version ]]; then
  printf 'Python %s\n' "${FAKE_PYTHON_VERSION:-3.13.0}"
  exit 0
fi
if [[ ${1-} == -m && ${2-} == pip && ${3-} == --version ]]; then
  printf 'pip 25.0 from synthetic\n'
  exit 0
fi
if [[ ${1-} == -m && ${2-} == pip && ${3-} == install ]]; then
  record "$@"
  while (($#)); do
    [[ $1 != --target ]] || mkdir -p "$2"
    shift
  done
  exit 0
fi
if [[ ${1-} == - ]]; then
  cat >/dev/null
  record "verify ${2-} ${3-} cache=${TIKTOKEN_CACHE_DIR-}"
  exit 0
fi
if [[ ${1-} == runner-probe ]]; then
  record "runner cache=${TIKTOKEN_CACHE_DIR-} tokenizer=${TEASESCRIPT_O200K_TOKENIZER-} path=${PYTHONPATH-}"
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

workspace_repo() {
  local repo="$tmp/workspace-$1"
  git init -q "$repo"
  printf '{}\n' > "$repo/package.json"
  printf '{}\n' > "$repo/package-lock.json"
  printf '%s\n' "$repo"
}

# Run the installed setup-workspace.sh with recording npm/Node and a recording TikToken installer.
workspace_bundle="$tmp/workspace-bundle"
cp -a "$install" "$workspace_bundle"
setup_workspace="$workspace_bundle/bin/setup-workspace.sh"
setup_calls="$tmp/setup-calls"
node_bin="$workspace_bundle/runtime/node-v24.18.0-linux-x64/bin"
# Resolve the real executable first: a version-manager shim on PATH can loop once setup prepends node_bin.
real_node=$(node -p 'process.execPath')
cat > "$node_bin/node" <<NODE
#!/usr/bin/env bash
set -euo pipefail
if [[ \${1-} == --version ]]; then
  printf 'v24.18.0\\n'
  exit 0
fi
exec $(printf '%q' "$real_node") "\$@"
NODE
cat > "$node_bin/npm" <<'NPM'
#!/usr/bin/env bash
set -euo pipefail
printf 'npm %s @%s cache=%s\n' "$*" "$PWD" "${npm_config_cache-}" >> "$CALLS"
if [[ ${1-} == ci && -n ${FAKE_TS_MORPH_VERSION-} ]]; then
  mkdir -p node_modules/ts-morph
  printf '{"version":"%s"}\n' "$FAKE_TS_MORPH_VERSION" > node_modules/ts-morph/package.json
fi
NPM
cat > "$workspace_bundle/bin/install-tiktoken-offline.sh" <<'STUB'
#!/usr/bin/env bash
printf 'tiktoken %s\n' "$*" >> "$CALLS"
exit "${FAKE_TIKTOKEN_STATUS:-0}"
STUB
chmod +x "$node_bin/node" "$node_bin/npm" "$workspace_bundle/bin/install-tiktoken-offline.sh"

run_setup() {
  local repo=$1
  shift
  : > "$setup_calls"
  (cd "$repo" && env CALLS="$setup_calls" "$@" >/dev/null 2>&1)
}

# An offline npm ci in the repository whose npm cache is Git-local state of that repository.
offline_install() {
  [[ $1 == "npm ci "* && " $1 " == *" --offline "* && $1 == *" @$repo cache=$repo/.git/"* ]]
}

# Normal setup runs exactly the offline install, then the TikToken installer, without cache verification.
repo=$(workspace_repo normal)
run_setup "$repo" FAKE_TS_MORPH_VERSION=28.0.0 bash "$setup_workspace" "$repo"
mapfile -t calls < "$setup_calls"
[[ ${#calls[@]} == 2 ]] && offline_install "${calls[0]}" && [[ ${calls[1]} == "tiktoken $repo" ]] || {
  printf 'test-chatgpt-project-agent: FAIL: normal setup did not run exactly the required offline operations\n' >&2
  exit 1
}

# Debug setup additionally verifies that same cache before installing.
repo=$(workspace_repo debug)
run_setup "$repo" FAKE_TS_MORPH_VERSION=28.0.0 bash "$setup_workspace" --debug-verify-bootstrap "$repo"
mapfile -t calls < "$setup_calls"
[[ ${#calls[@]} == 3 && ${calls[0]} == "npm cache verify @$repo cache="* ]] && offline_install "${calls[1]}" &&
  [[ ${calls[0]##* cache=} == "${calls[1]##* cache=}" && ${calls[2]} == "tiktoken $repo" ]] || {
  printf 'test-chatgpt-project-agent: FAIL: debug setup did not verify the npm cache before installation\n' >&2
  exit 1
}

# Without ts-morph the bundled fallback must run; its failure is fatal before TikToken.
repo=$(workspace_repo missing-ts-morph)
set +e
run_setup "$repo" bash "$setup_workspace" "$repo"
status=$?
set -e
[[ $status != 0 ]] &&
  grep -F -- '--offline --ignore-scripts' "$setup_calls" |
  grep -F "$workspace_bundle/dependencies/ts-morph/packages/ts-morph-28.0.0.tgz" >/dev/null &&
  ! grep -q '^tiktoken' "$setup_calls" || {
  printf 'test-chatgpt-project-agent: FAIL: missing ts-morph did not run the bundled fallback fatally\n' >&2
  exit 1
}

repo=$(workspace_repo tiktoken-failure)
set +e
run_setup "$repo" FAKE_TS_MORPH_VERSION=28.0.0 FAKE_TIKTOKEN_STATUS=9 bash "$setup_workspace" "$repo"
status=$?
set -e
[[ $status != 0 ]] || {
  printf 'test-chatgpt-project-agent: FAIL: TikToken installation failure was not fatal\n' >&2
  exit 1
}

# Run the installed TikToken installer with the recording interpreter.
tiktoken_installer="$install/bin/install-tiktoken-offline.sh"
tiktoken_payload="$install/dependencies/tiktoken-cp313-linux-x86_64"
vocabulary="$tiktoken_payload/tokenizer/o200k_base.tiktoken"
python_calls="$tmp/python-calls"
# Fixture only: report the official o200k_base digest for the synthetic vocabulary bytes so the
# successful path can run; the bad-vocabulary case below uses the real sha256sum.
official_digest_bin="$tmp/official-digest-bin"
mkdir -p "$official_digest_bin"
cat > "$official_digest_bin/sha256sum" <<SHIM
#!/usr/bin/env bash
if [[ \$# == 1 ]] && cmp -s -- "\$1" $(printf '%q' "$vocabulary"); then
  printf '%s  %s\\n' 446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d "\$1"
  exit 0
fi
exec $(printf '%q' "$(command -v sha256sum)") "\$@"
SHIM
chmod +x "$official_digest_bin/sha256sum"

run_tiktoken() {
  : > "$python_calls"
  env PYTHON_BIN="$tmp/python3.13" PYTHON_CALLS="$python_calls" "$@" \
    bash "$tiktoken_installer" "$repo" >/dev/null 2>&1
}

# Each row breaks one host fact checked by the installer's own probe.
for host in FAKE_PYTHON_VERSION=3.12.0 FAKE_PYTHON_IMPLEMENTATION=pypy \
  FAKE_PYTHON_PLATFORM=darwin FAKE_PYTHON_MACHINE=aarch64; do
  repo=$(workspace_repo "tiktoken-incompatible-${host%%=*}")
  set +e
  run_tiktoken PATH="$official_digest_bin:$PATH" "$host"
  status=$?
  set -e
  [[ $status != 0 && ! -s "$python_calls" && ! -e "$repo/.git/teasescript-agent" ]] || {
    printf 'test-chatgpt-project-agent: FAIL: incompatible host Python (%s) reached installation\n' "$host" >&2
    exit 1
  }
done

repo=$(workspace_repo tiktoken-bad-vocabulary)
state="$repo/.git/teasescript-agent"
set +e
run_tiktoken
status=$?
set -e
[[ $status != 0 && ! -s "$python_calls" && ! -e "$state/tiktoken-cache" && ! -e "$state/python-cp313" &&
  ! -e "$state/run-python313" ]] || {
  printf 'test-chatgpt-project-agent: FAIL: unofficial tokenizer vocabulary was accepted\n' >&2
  exit 1
}

repo=$(workspace_repo tiktoken)
state="$repo/.git/teasescript-agent"
run_tiktoken PATH="$official_digest_bin:$PATH"
pip_install=$(grep '^-m pip install ' "$python_calls")
for required in --no-index --only-binary=:all: "--find-links $tiktoken_payload/wheels" tiktoken==0.13.0; do
  [[ " $pip_install " == *" $required "* ]] || {
    printf 'test-chatgpt-project-agent: FAIL: TikToken pip installation lacks %s\n' "$required" >&2
    exit 1
  }
done
# TikToken caches a vocabulary under the SHA-1 of its source URL.
cache_key=$(printf '%s' https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken | sha1sum)
cache_key=${cache_key%% *}
cmp -s "$vocabulary" "$state/tiktoken-cache/$cache_key" &&
  grep -Fx "verify $vocabulary 446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d cache=$state/tiktoken-cache" \
    "$python_calls" >/dev/null || {
  printf 'test-chatgpt-project-agent: FAIL: TikToken cache was not prepared and verified offline\n' >&2
  exit 1
}
: > "$python_calls"
env -u PYTHONPATH PYTHON_CALLS="$python_calls" "$state/run-python313" runner-probe
[[ "$(cat "$python_calls")" == "runner cache=$state/tiktoken-cache tokenizer=$vocabulary path=$state/python-cp313" ]] || {
  printf 'test-chatgpt-project-agent: FAIL: generated Python runner lacks the offline TikToken environment\n' >&2
  exit 1
}

printf 'test-chatgpt-project-agent: PASS\n'
