#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/../.." && pwd)
project_root="$repo_root/tools/chatgpt-project-agent"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/test-chatgpt-project-agent.XXXXXX")
trap 'rm -rf -- "$tmp"' EXIT

python3 - "$project_root/docs/PROJECT-INSTRUCTIONS.txt" "$project_root/bin/setup-workspace.sh" "$project_root/bin/install-tiktoken-offline.sh" <<'PY'
from pathlib import Path
import sys

instructions = Path(sys.argv[1]).read_text()
setup = Path(sys.argv[2]).read_text()
installer = Path(sys.argv[3]).read_text()

required_route = (
    "1. Read applicable `AGENTS.md` files first.\n"
    "2. Read the repository `README-FIRST.md` and the assigned issue or pull request."
)
if required_route not in instructions:
    raise SystemExit("project instructions do not preserve the accepted startup order")
if "Read `CURRENT-DESIGN.md` for architecture-affecting or broad cross-component work" not in instructions:
    raise SystemExit("project instructions do not use the progressive CURRENT-DESIGN route")
for obsolete in ("docs/references/", "source-examples/"):
    if obsolete in instructions:
        raise SystemExit(f"project instructions still reference nonexistent path: {obsolete}")
if 'fs.readFileSync(process.argv[1],"utf8")' not in setup or '"$repo/node_modules/ts-morph/package.json"' not in setup:
    raise SystemExit("ts-morph detection is not anchored to the target repository")
if "446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d" not in installer:
    raise SystemExit("installer lacks the official o200k_base vocabulary digest")
if "load_tiktoken_bpe(str(path), expected_hash=expected_hash)" not in installer:
    raise SystemExit("installer does not pass the expected vocabulary hash to TikToken")
PY

bundle="$tmp/chatgpt-project-agent"
mkdir -p \
  "$bundle/bin" \
  "$bundle/dependencies/tiktoken-cp313-linux-x86_64/wheels" \
  "$bundle/dependencies/tiktoken-cp313-linux-x86_64/tokenizer" \
  "$tmp/repository"
cp "$project_root/bin/install-tiktoken-offline.sh" "$bundle/bin/"
printf 'altered vocabulary fixture\n' > \
  "$bundle/dependencies/tiktoken-cp313-linux-x86_64/tokenizer/o200k_base.tiktoken"
cat > "$tmp/python3.13" <<'PYTHON'
#!/usr/bin/env bash
set -euo pipefail
if [[ $# == 1 && $1 == - ]]; then
  cat >/dev/null
  exit 0
fi
exec python3 "$@"
PYTHON
chmod +x "$tmp/python3.13"
git init -q "$tmp/repository"

set +e
PYTHON_BIN="$tmp/python3.13" bash "$bundle/bin/install-tiktoken-offline.sh" \
  "$tmp/repository" >"$tmp/stdout" 2>"$tmp/stderr"
status=$?
set -e
if [[ $status == 0 ]]; then
  printf 'test-chatgpt-project-agent: FAIL: altered o200k_base vocabulary was accepted\n' >&2
  exit 1
fi
grep -F 'o200k_base tokenizer SHA-256 mismatch' "$tmp/stderr" >/dev/null || {
  cat "$tmp/stderr" >&2
  printf 'test-chatgpt-project-agent: FAIL: altered vocabulary did not reach the focused digest check\n' >&2
  exit 1
}

bash -n "$project_root/bin/install-tiktoken-offline.sh"
bash -n "$project_root/bin/setup-workspace.sh"
printf 'test-chatgpt-project-agent: PASS\n'
