#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: install-tiktoken-offline.sh REPOSITORY

Install the optional CPython 3.13 TikToken toolchain into Git-local agent state.
It is used only by repository-owned token-aware patch-publication tooling.
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
tool_dir="$bundle_dir/optional-tools/tiktoken-cp313-linux-x86_64"
python_bin=${PYTHON_BIN:-python3.13}

command -v "$python_bin" >/dev/null 2>&1 || {
  printf 'install-tiktoken-offline: FAIL: CPython 3.13 is required; set PYTHON_BIN when needed\n' >&2
  exit 1
}
python_path=$(command -v "$python_bin")
git_dir=$(git -C "$repo_dir" rev-parse --absolute-git-dir 2>/dev/null) || {
  printf 'install-tiktoken-offline: FAIL: target is not a Git worktree: %s\n' "$repo_dir" >&2
  exit 1
}
state_dir="$git_dir/teasescript-agent"
target="$state_dir/python-cp313"
vocabulary="$tool_dir/tokenizer/o200k_base.tiktoken"
mkdir -p "$state_dir"

if [[ -d "$target" ]]; then
  PYTHONPATH="$target" "$python_path" "$tool_dir/verify-installed.py" "$vocabulary" >/dev/null
else
  temporary=$(mktemp -d "$state_dir/.python-cp313.tmp-XXXXXX")
  trap 'rm -rf -- "${temporary:-}"' EXIT
  rmdir "$temporary"
  PYTHON_BIN="$python_path" "$tool_dir/install-offline.sh" "$temporary" >/dev/null
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

printf 'install-tiktoken-offline: PASS repo=%s python=%s version=0.13.0 activate=%s run=%s\n' \
  "$repo_dir" "$($python_path --version 2>&1)" "$state_dir/activate-tiktoken.sh" "$state_dir/run-python313"
