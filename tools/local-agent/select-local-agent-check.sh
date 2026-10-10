#!/usr/bin/env bash
set -euo pipefail

# Usage: select-local-agent-check.sh BASE HEAD
# Prints `run=true` when the change from BASE to HEAD touches a repository path that check-local-agent.sh reads, else
# `run=false`. Any Git or grep failure exits nonzero, so CI never skips the suites by mistake. The suites also run on
# the Node version from .nvmrc.
(($# == 2)) || {
  printf 'Usage: select-local-agent-check.sh BASE HEAD\n' >&2
  exit 2
}
inputs='^(\.github/|tools/local-agent/|tools/chatgpt-project-agent/|tools/setup-chatgpt-project-agent\.sh$|docs/chatgpt-project/|\.nvmrc$)'

changed=$(mktemp)
trap 'rm -f "$changed"' EXIT
# Raw NUL-separated paths: no quoting of unusual names, and a rename lists its old path too.
git diff --name-only --no-renames -z "$1" "$2" >"$changed"
status=0
grep -qzE "$inputs" "$changed" || status=$?
case $status in
  0) echo run=true ;;
  1) echo run=false ;;
  *) exit "$status" ;;
esac
