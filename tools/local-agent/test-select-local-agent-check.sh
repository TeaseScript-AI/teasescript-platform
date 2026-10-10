#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
selector="$script_dir/select-local-agent-check.sh"
tmp=$(mktemp -d -t select-local-agent-check-XXXXXX)
trap 'rm -rf "$tmp"' EXIT

git init -q "$tmp/repo"
cd "$tmp/repo"
git config user.email test@example.invalid
git config user.name test
mkdir -p .github/workflows docs/chatgpt-project src tools/chatgpt-project-agent tools/local-agent
for path in .github/workflows/ci.yml docs/chatgpt-project/SYSTEM-PROMPT.txt docs/TESTING.md src/index.ts \
  tools/chatgpt-project-agent/MANIFEST.json tools/local-agent/run-compact.sh tools/setup-chatgpt-project-agent.sh .nvmrc; do
  printf 'base\n' >"$path"
done
git add -A
git commit -q -m base
base=$(git rev-parse HEAD)

# Expects the selector's output for one change, made on a fresh branch from the base commit.
expect() {
  local expected=$1 label=$2
  shift 2
  git checkout -q --detach "$base"
  "$@"
  git add -A
  git commit -q -m "$label"
  local actual
  actual=$(bash "$selector" "$base" HEAD)
  [[ $actual == "run=$expected" ]] || {
    printf 'test-select-local-agent-check: FAIL: %s gave %s, expected run=%s\n' "$label" "$actual" "$expected" >&2
    exit 1
  }
}

# Appends to each given file, creating it when needed.
append() {
  local path
  for path; do printf x >>"$path"; done
}

expect false 'product source and documentation' append src/index.ts docs/TESTING.md
expect false 'a near miss of an input name' append tools/setup-chatgpt-project-agent.shx
expect true 'a workflow edit' append .github/workflows/ci.yml
expect true 'the project prompt' append docs/chatgpt-project/SYSTEM-PROMPT.txt
expect true 'the project-agent tools' append tools/chatgpt-project-agent/MANIFEST.json
expect true 'the setup script' append tools/setup-chatgpt-project-agent.sh
expect true 'the local-agent tools' append tools/local-agent/run-compact.sh
expect true 'the Node version' append .nvmrc
# A rename out of an input path must still count: the suites read the old path.
expect true 'a workflow renamed out of .github' git mv .github/workflows/ci.yml docs/ci.yml
# Git quotes such a name in its default output; the selector must read the raw path.
expect true 'a workflow with a non-ASCII name' append "$(printf '.github/workflows/caf\303\251.yml')"

if bash "$selector" "$base" 0000000000000000000000000000000000000000 >/dev/null 2>&1; then
  printf 'test-select-local-agent-check: FAIL: an unknown commit did not fail the selection\n' >&2
  exit 1
fi
printf 'test-select-local-agent-check: PASS\n'
