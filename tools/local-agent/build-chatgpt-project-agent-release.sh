#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: build-chatgpt-project-agent-release.sh --runtime-root DIRECTORY --output DIRECTORY

Create the stable ChatGPT project-folder files from the Git-canonical tools
source and a separately maintained final-layout runtime tree.
USAGE
}

runtime_root=
output=
while (($#)); do
  case "$1" in
    --runtime-root) (($# >= 2)) || { usage >&2; exit 2; }; runtime_root=$2; shift 2 ;;
    --output) (($# >= 2)) || { usage >&2; exit 2; }; output=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'build-chatgpt-project-agent-release: FAIL: unknown or incomplete argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
[[ -n "$runtime_root" && -n "$output" ]] || { usage >&2; exit 2; }

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/../.." && pwd)
tools_root="$repo_root/tools/chatgpt-project-agent"
runtime_root=$(cd -- "$runtime_root" && pwd)
[[ "$(basename -- "$runtime_root")" == chatgpt-project-agent ]] || {
  printf 'build-chatgpt-project-agent-release: FAIL: runtime root must be named chatgpt-project-agent\n' >&2
  exit 1
}

for required in \
  RUNTIME-MANIFEST.json CACHE-SEED-ID PACKAGE-INVENTORY.json \
  runtime/node-v24.18.0-linux-x64/bin/node runtime/node-v26.5.0-linux-x64/bin/node \
  dependencies/tiktoken-cp313-linux-x86_64/tokenizer/o200k_base.tiktoken \
  dependencies/ts-morph/packages/ts-morph-28.0.0.tgz; do
  [[ -e "$runtime_root/$required" ]] || {
    printf 'build-chatgpt-project-agent-release: FAIL: runtime root lacks %s\n' "$required" >&2
    exit 1
  }
done
for forbidden in README.md README-FIRST.md MANIFEST.json bin docs tools; do
  [[ ! -e "$runtime_root/$forbidden" ]] || {
    printf 'build-chatgpt-project-agent-release: FAIL: runtime root contains maintainable path: %s\n' "$forbidden" >&2
    exit 1
  }
done
if find "$runtime_root" -type f -name 'SYSTEM-PROMPT.txt' -print -quit | grep -q .; then
  printf 'build-chatgpt-project-agent-release: FAIL: runtime root contains the project system prompt\n' >&2
  exit 1
fi

if [[ -e "$output" || -L "$output" ]]; then
  [[ -d "$output" && ! -L "$output" ]] || {
    printf 'build-chatgpt-project-agent-release: FAIL: output is not a directory: %s\n' "$output" >&2
    exit 1
  }
  if find "$output" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
    printf 'build-chatgpt-project-agent-release: FAIL: output directory must be empty: %s\n' "$output" >&2
    exit 1
  fi
else
  mkdir -p -- "$output"
fi
output=$(cd -- "$output" && pwd)
temporary=$(mktemp -d "${TMPDIR:-/tmp}/chatgpt-project-agent-release.XXXXXX")
trap 'rm -rf -- "$temporary"' EXIT
mkdir -p "$temporary/tools-parent"
cp -a -- "$tools_root" "$temporary/tools-parent/chatgpt-project-agent"

common_tar=(--sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner)
tar "${common_tar[@]}" -czf "$output/chatgpt-project-agent-tools-linux-x64.tar.gz" \
  -C "$temporary/tools-parent" chatgpt-project-agent
ZSTD_CLEVEL=10 tar "${common_tar[@]}" --zstd \
  -cf "$output/chatgpt-project-agent-runtime-linux-x64.tar.zst" \
  -C "$(dirname -- "$runtime_root")" chatgpt-project-agent
install -m 0644 "$repo_root/docs/chatgpt-project/README-FIRST.md" "$output/README-FIRST.md"
install -m 0755 "$repo_root/tools/setup-chatgpt-project-agent.sh" "$output/setup-chatgpt-project-agent.sh"

printf 'build-chatgpt-project-agent-release: PASS output=%s\n' "$output"
