#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  install-tiktoken-offline.sh REPOSITORY
  install-tiktoken-offline.sh --check-environment

Install and verify TikToken 0.13.0 and its complete required dependency set from
the installed runtime payload into Git-local state. The environment check proves
that the host interpreter and bundled cp313 payload are compatible without
modifying a repository.
USAGE
}

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
bundle_dir=$(cd -- "$script_dir/.." && pwd)
tool_dir="$bundle_dir/dependencies/tiktoken-cp313-linux-x86_64"
python_bin=${PYTHON_BIN:-python3.13}
o200k_base_sha256=446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d
o200k_base_cache_key=fb374d419588a4632f3f557e76b4b70aebbca790
python_path=

check_environment() {
  command -v "$python_bin" >/dev/null 2>&1 || {
    printf 'install-tiktoken-offline: FAIL: CPython 3.13 was not found; bundled wheels require cp313 on Linux x86-64 (set PYTHON_BIN when needed)\n' >&2
    return 1
  }
  python_path=$(command -v "$python_bin")
  environment=$(
    # Skip host site customization: this probe needs only CPython's built-in
    # ABI/platform facts, not project or notebook packages.
    "$python_path" -S - <<'PY' 2>&1
import os
import sys

implementation = sys.implementation.name
machine = os.uname().machine
found = f"{implementation} {sys.version.split()[0]} on {sys.platform} {machine}"
if sys.version_info[:2] != (3, 13) or implementation != "cpython":
    raise SystemExit(f"found {found}; bundled wheels require CPython 3.13 (cp313)")
if not sys.platform.startswith("linux") or machine.lower() not in {"x86_64", "amd64"}:
    raise SystemExit(f"found {found}; bundled wheels require Linux x86-64")
print(found)
PY
  ) || {
    printf 'install-tiktoken-offline: FAIL: incompatible host Python: %s\n' "$environment" >&2
    printf 'install-tiktoken-offline: INFO: no network download or source build was attempted; refresh the runtime archive with wheels for the new Python ABI\n' >&2
    return 1
  }
  "$python_path" -m pip --version >/dev/null 2>&1 || {
    printf 'install-tiktoken-offline: FAIL: pip is unavailable in %s\n' "$python_path" >&2
    return 1
  }
  [[ -d "$tool_dir/wheels" && -f "$tool_dir/tokenizer/o200k_base.tiktoken" && -f "$tool_dir/SHA256SUMS" ]] || {
    printf 'install-tiktoken-offline: FAIL: runtime TikToken payload is incomplete: %s\n' "$tool_dir" >&2
    return 1
  }
  (
    cd -- "$tool_dir"
    sha256sum -c SHA256SUMS >/dev/null
  ) || {
    printf 'install-tiktoken-offline: FAIL: runtime TikToken payload checksum verification failed\n' >&2
    return 1
  }
}

if [[ ${1-} == -h || ${1-} == --help ]]; then
  usage
  exit 0
fi
if [[ ${1-} == --check-environment ]]; then
  [[ $# == 1 ]] || { usage >&2; exit 2; }
  check_environment
  printf 'install-tiktoken-offline: PASS environment=%s\n' "$($python_path --version 2>&1)"
  exit 0
fi
[[ $# == 1 ]] || { usage >&2; exit 2; }
repo_dir=$(cd -- "$1" && pwd)
check_environment

git_dir=$(git -C "$repo_dir" rev-parse --absolute-git-dir 2>/dev/null) || {
  printf 'install-tiktoken-offline: FAIL: target is not a Git worktree: %s\n' "$repo_dir" >&2
  exit 1
}
state_dir="$git_dir/teasescript-agent"
target="$state_dir/python-cp313"
vocabulary="$tool_dir/tokenizer/o200k_base.tiktoken"
tokenizer_cache="$state_dir/tiktoken-cache"
tokenizer_cache_file="$tokenizer_cache/$o200k_base_cache_key"
mkdir -p "$state_dir"

prepare_tokenizer_cache() {
  if [[ -f "$tokenizer_cache_file" ]] && \
    [[ "$(sha256sum "$tokenizer_cache_file" | awk '{print $1}')" == "$o200k_base_sha256" ]]; then
    return
  fi
  temporary_cache=$(mktemp -d "$state_dir/.tiktoken-cache.tmp-XXXXXX")
  trap 'rm -rf -- "${temporary:-}" "${temporary_cache:-}"' EXIT
  cp -- "$vocabulary" "$temporary_cache/$o200k_base_cache_key"
  [[ "$(sha256sum "$temporary_cache/$o200k_base_cache_key" | awk '{print $1}')" == "$o200k_base_sha256" ]] || {
    printf 'install-tiktoken-offline: FAIL: prepared tokenizer cache digest mismatch\n' >&2
    exit 1
  }
  rm -rf -- "$tokenizer_cache"
  mv -- "$temporary_cache" "$tokenizer_cache"
  temporary_cache=
  trap 'rm -rf -- "${temporary:-}" "${temporary_cache:-}"' EXIT
}

verify_install() {
  PYTHONPATH="$target" TIKTOKEN_CACHE_DIR="$tokenizer_cache" \
    "$python_path" - "$vocabulary" "$o200k_base_sha256" <<'PY'
from __future__ import annotations

import hashlib
import sys
from importlib.metadata import version
from pathlib import Path

vocabulary = Path(sys.argv[1]).resolve()
expected_hash = sys.argv[2]
actual_hash = hashlib.sha256(vocabulary.read_bytes()).hexdigest()
if actual_hash != expected_hash:
    raise SystemExit(
        f"vocabulary SHA-256 mismatch: expected {expected_hash}, found {actual_hash}"
    )

import tiktoken

if version("tiktoken") != "0.13.0":
    raise SystemExit(f"unexpected tiktoken version: {version('tiktoken')}")
encoding = tiktoken.get_encoding("o200k_base")
if not encoding.encode_ordinary('"TeaseScript offline token verification"'):
    raise SystemExit("tokenizer produced no tokens")
PY
}

prepare_tokenizer_cache

if [[ -d "$target" ]]; then
  verify_install >/dev/null
else
  temporary=$(mktemp -d "$state_dir/.python-cp313.tmp-XXXXXX")
  trap 'rm -rf -- "${temporary:-}"' EXIT
  printf 'install-tiktoken-offline: INFO: installing bundled wheels into Git-local state\n' >&2
  "$python_path" -m pip install \
    --no-index \
    --no-cache-dir \
    --disable-pip-version-check \
    --ignore-installed \
    --only-binary=:all: \
    --find-links "$tool_dir/wheels" \
    --target "$temporary" \
    "tiktoken==0.13.0" >/dev/null
  target_before=$target
  target=$temporary
  verify_install >/dev/null
  target=$target_before
  mv -- "$temporary" "$target"
  temporary=
  trap - EXIT
fi

cat > "$state_dir/activate-tiktoken.sh" <<ACTIVATE
export PYTHONPATH=$(printf '%q' "$target")\${PYTHONPATH:+:\$PYTHONPATH}
export TIKTOKEN_CACHE_DIR=$(printf '%q' "$tokenizer_cache")
export TEASESCRIPT_O200K_TOKENIZER=$(printf '%q' "$vocabulary")
export TEASESCRIPT_PYTHON313=$(printf '%q' "$python_path")
ACTIVATE
cat > "$state_dir/run-python313" <<RUNNER
#!/usr/bin/env bash
set -euo pipefail
export PYTHONPATH=$(printf '%q' "$target")\${PYTHONPATH:+:\$PYTHONPATH}
export TIKTOKEN_CACHE_DIR=$(printf '%q' "$tokenizer_cache")
export TEASESCRIPT_O200K_TOKENIZER=$(printf '%q' "$vocabulary")
exec $(printf '%q' "$python_path") "\$@"
RUNNER
chmod +x "$state_dir/run-python313"

printf 'install-tiktoken-offline: PASS repo=%s python=%s version=0.13.0\n' \
  "$repo_dir" "$($python_path --version 2>&1)"
