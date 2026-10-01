#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
runner="$root/tools/local-agent/run-compact.sh"
tmp=$(mktemp -d -t run-compact-test-XXXXXX)
trap 'rm -rf "$tmp"' EXIT

success_output=$(
  "$runner" --label sample-success --log "$tmp/success.log" -- \
    bash -c 'printf "hidden success noise\n"; printf "hidden success stderr noise\n" >&2' \
    2>"$tmp/success.stderr"
)
[[ "$success_output" == 'sample-success: PASS' ]]
if grep -q 'hidden success' "$tmp/success.stderr"; then exit 1; fi
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

# The payload is read from a file so the printed command cannot contain the middle sentinel.
printf 'HEAD-%s%s%s-TAIL' "$(printf 'x%.0s' {1..300})" MIDDLE-SENTINEL "$(printf 'y%.0s' {1..300})" \
  >"$tmp/large.payload"
set +e
"$runner" --label large-failure --log "$tmp/large.log" --max-output-bytes 120 -- \
  bash -c 'cat "$1"; exit 9' large-failure "$tmp/large.payload" \
  >"$tmp/large.stdout" 2>"$tmp/large.stderr"
status=$?
set -e
[[ $status -eq 9 ]]
[[ ! -s "$tmp/large.stdout" ]]
grep -q 'output truncated' "$tmp/large.stderr"
grep -q 'complete log:' "$tmp/large.stderr"
if grep -q 'MIDDLE-SENTINEL' "$tmp/large.stderr"; then exit 1; fi
cmp -s "$tmp/large.payload" "$tmp/large.log"
excerpt_head=$(grep -o 'HEAD-x*' "$tmp/large.stderr")
excerpt_tail=$(grep -o 'y*-TAIL' "$tmp/large.stderr")
[[ -n "$excerpt_head" && -n "$excerpt_tail" ]]
((${#excerpt_head} + ${#excerpt_tail} <= 120))

printf 'run-compact: PASS\n'
