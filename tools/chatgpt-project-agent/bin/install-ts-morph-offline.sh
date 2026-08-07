#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: install-ts-morph-offline.sh REPOSITORY

Install ts-morph 28.0.0 plus its nine dependencies from bundled tarballs.
The target package.json and root package-lock.json are not passed to npm and
remain unchanged.
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
tool_dir="$bundle_dir/dependencies/ts-morph"

command -v npm >/dev/null 2>&1 || {
  printf 'install-ts-morph-offline: FAIL: npm is required\n' >&2
  exit 1
}
[[ -f "$repo_dir/package.json" ]] || {
  printf 'install-ts-morph-offline: FAIL: target lacks package.json: %s\n' "$repo_dir" >&2
  exit 1
}
[[ -f "$tool_dir/SHA256SUMS" && -d "$tool_dir/packages" ]] || {
  printf 'install-ts-morph-offline: FAIL: runtime ts-morph payload is incomplete: %s\n' "$tool_dir" >&2
  exit 1
}
(
  cd -- "$tool_dir"
  sha256sum -c SHA256SUMS >/dev/null
) || {
  printf 'install-ts-morph-offline: FAIL: runtime ts-morph payload checksum verification failed\n' >&2
  exit 1
}

stage_dir=$(mktemp -d "${TMPDIR:-/tmp}/ts-morph-offline.XXXXXX")
trap 'rm -rf -- "$stage_dir"' EXIT
printf '%s\n' '{"private":true}' > "$stage_dir/package.json"

packages=(
  "$tool_dir/packages/ts-morph-28.0.0.tgz"
  "$tool_dir/packages/common-0.29.0.tgz"
  "$tool_dir/packages/code-block-writer-13.0.3.tgz"
  "$tool_dir/packages/minimatch-10.0.3.tgz"
  "$tool_dir/packages/path-browserify-1.0.1.tgz"
  "$tool_dir/packages/tinyglobby-0.2.16.tgz"
  "$tool_dir/packages/brace-expansion-5.0.1.tgz"
  "$tool_dir/packages/fdir-6.5.0.tgz"
  "$tool_dir/packages/picomatch-4.0.5.tgz"
  "$tool_dir/packages/balanced-match-4.0.1.tgz"
)

printf 'install-ts-morph-offline: INFO: staging bundled packages\n' >&2
(
  cd -- "$stage_dir"
  npm install --offline --ignore-scripts --no-audit --no-fund \
    --package-lock=false --save=false "${packages[@]}" >/dev/null
)

installed_packages=(
  "@isaacs/balanced-match"
  "@isaacs/brace-expansion"
  "@ts-morph/common"
  "code-block-writer"
  "fdir"
  "minimatch"
  "path-browserify"
  "picomatch"
  "tinyglobby"
  "ts-morph"
)

mkdir -p -- "$repo_dir/node_modules"
for package_name in "${installed_packages[@]}"; do
  source_path="$stage_dir/node_modules/$package_name"
  target_path="$repo_dir/node_modules/$package_name"
  [[ -d "$source_path" ]] || {
    printf 'install-ts-morph-offline: FAIL: staged package missing: %s\n' "$package_name" >&2
    exit 1
  }
  mkdir -p -- "$(dirname -- "$target_path")"
  rm -rf -- "$target_path"
  cp -a -- "$source_path" "$target_path"
done
rm -f -- "$repo_dir/node_modules/.package-lock.json"

printf 'install-ts-morph-offline: PASS repo=%s version=28.0.0 packages=10\n' "$repo_dir"
