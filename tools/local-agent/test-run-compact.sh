#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
runner="$root/tools/local-agent/run-compact.sh"
tmp=$(mktemp -d -t run-compact-test-XXXXXX)
trap 'rm -rf "$tmp"' EXIT

success_output=$(
  "$runner" --label sample-success --log "$tmp/success.log" -- \
    bash -c 'printf "hidden success noise\n"'
)
[[ "$success_output" == 'sample-success: PASS' ]]
[[ ! -e "$tmp/success.log" ]]

set +e
"$runner" --label sample-failure --log "$tmp/failure.log" -- \
  bash -c 'printf "diagnostic line\n"; exit 7' \
  >"$tmp/failure.stdout" 2>"$tmp/failure.stderr"
status=$?
set -e
[[ $status -eq 7 ]]
[[ ! -s "$tmp/failure.stdout" ]]
grep -q '^sample-failure: FAIL (exit 7)$' "$tmp/failure.stderr"
grep -q '^command:' "$tmp/failure.stderr"
grep -q 'diagnostic line' "$tmp/failure.stderr"
[[ -f "$tmp/failure.log" ]]

set +e
"$runner" --label large-failure --log "$tmp/large.log" --max-output-bytes 120 -- \
  python3 -c 'import sys; print("HEAD-" + "a" * 300 + "-TAIL"); sys.exit(9)' \
  >"$tmp/large.stdout" 2>"$tmp/large.stderr"
status=$?
set -e
[[ $status -eq 9 ]]
grep -q 'output truncated' "$tmp/large.stderr"
grep -q 'complete log:' "$tmp/large.stderr"
grep -q 'HEAD-' "$tmp/large.stderr"
grep -q -- '-TAIL' "$tmp/large.stderr"
[[ $(wc -c <"$tmp/large.log") -gt 120 ]]

printf 'run-compact: PASS\n'
