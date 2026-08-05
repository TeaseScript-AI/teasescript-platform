#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: install-tiktoken-offline.sh REPOSITORY

Install and verify TikToken 0.13.0 and its complete required dependency set from
the installed runtime payload into Git-local state.
USAGE
}

if [[ ${1-} == -h || ${1-} == --help ]]; then
  usage
  exit 0
fi
[[ $# == 1 ]] || { usage >&2; exit 2; }
repo_dir=$(cd -- "$1" && pwd)
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
bundle_dir=$(cd -- "$script_dir/.." && pwd)
tool_dir="$bundle_dir/dependencies/tiktoken-cp313-linux-x86_64"
python_bin=${PYTHON_BIN:-python3.13}
o200k_base_sha256=446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d

command -v "$python_bin" >/dev/null 2>&1 || {
  printf 'install-tiktoken-offline: FAIL: CPython 3.13 is required; set PYTHON_BIN when needed\n' >&2
  exit 1
}
python_path=$(command -v "$python_bin")
"$python_path" - <<'PY'
import platform
import sys
if sys.version_info[:2] != (3, 13) or platform.python_implementation() != "CPython":
    raise SystemExit(f"requires CPython 3.13, found {platform.python_implementation()} {sys.version.split()[0]}")
if not sys.platform.startswith("linux") or platform.machine().lower() not in {"x86_64", "amd64"}:
    raise SystemExit(f"requires Linux x86-64, found {sys.platform} {platform.machine()}")
PY

[[ -d "$tool_dir/wheels" && -f "$tool_dir/tokenizer/o200k_base.tiktoken" ]] || {
  printf 'install-tiktoken-offline: FAIL: runtime TikToken payload is incomplete\n' >&2
  exit 1
}
git_dir=$(git -C "$repo_dir" rev-parse --absolute-git-dir 2>/dev/null) || {
  printf 'install-tiktoken-offline: FAIL: target is not a Git worktree: %s\n' "$repo_dir" >&2
  exit 1
}
state_dir="$git_dir/teasescript-agent"
target="$state_dir/python-cp313"
vocabulary="$tool_dir/tokenizer/o200k_base.tiktoken"
vocabulary_sha256=$("$python_path" - "$vocabulary" <<'PY'
from __future__ import annotations
import hashlib
import sys
from pathlib import Path
print(hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest())
PY
)
if [[ "$vocabulary_sha256" != "$o200k_base_sha256" ]]; then
  printf 'install-tiktoken-offline: FAIL: o200k_base tokenizer SHA-256 mismatch: expected %s, found %s\n' \
    "$o200k_base_sha256" "$vocabulary_sha256" >&2
  exit 1
fi
mkdir -p "$state_dir"

verify_install() {
  PYTHONPATH="$target" "$python_path" - "$vocabulary" "$o200k_base_sha256" <<'PY'
from __future__ import annotations
import sys
from importlib.metadata import version
from pathlib import Path
path = Path(sys.argv[1]).resolve()
expected_hash = sys.argv[2]
import tiktoken
from tiktoken.load import load_tiktoken_bpe
if version("tiktoken") != "0.13.0":
    raise SystemExit(f"unexpected tiktoken version: {version('tiktoken')}")
ranks = load_tiktoken_bpe(str(path), expected_hash=expected_hash)
if not ranks:
    raise SystemExit("tokenizer vocabulary is empty")
print("verified tiktoken=0.13.0")
PY
}

if [[ -d "$target" ]]; then
  verify_install >/dev/null
else
  temporary=$(mktemp -d "$state_dir/.python-cp313.tmp-XXXXXX")
  trap 'rm -rf -- "${temporary:-}"' EXIT
  rmdir "$temporary"
  mkdir -p "$temporary"
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
export TEASESCRIPT_O200K_TOKENIZER=$(printf '%q' "$vocabulary")
export TEASESCRIPT_PYTHON313=$(printf '%q' "$python_path")
ACTIVATE
cat > "$state_dir/run-python313" <<RUNNER
#!/usr/bin/env bash
set -euo pipefail
export PYTHONPATH=$(printf '%q' "$target")\${PYTHONPATH:+:\$PYTHONPATH}
export TEASESCRIPT_O200K_TOKENIZER=$(printf '%q' "$vocabulary")
exec $(printf '%q' "$python_path") "\$@"
RUNNER
chmod +x "$state_dir/run-python313"

printf 'install-tiktoken-offline: PASS repo=%s python=%s version=0.13.0\n' \
  "$repo_dir" "$($python_path --version 2>&1)"
