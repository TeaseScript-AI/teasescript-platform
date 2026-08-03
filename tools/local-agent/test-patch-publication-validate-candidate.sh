#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ ${TEASESCRIPT_COMPACT_TEST_INNER:-0} != 1 ]]; then
  log=$(mktemp -t patch-candidate-validation-XXXXXX.log)
  rm -f "$log"
  exec "$script_dir/run-compact.sh" \
    --label patch-candidate-validation \
    --log "$log" \
    -- env TEASESCRIPT_COMPACT_TEST_INNER=1 bash "$0" "$@"
fi

runner="$script_dir/patch-publication-validate-candidate.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
work="$tmp/work"
bin="$tmp/bin"
sync="$tmp/sync"
mkdir -p "$work/tools/local-agent" "$bin" "$sync"

cat > "$work/tools/local-agent/check-local-agent.sh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf 'tooling\n' >> "$CALLS"
if [[ ${EXPECT_PARALLEL:-0} == 1 ]]; then
  touch "$SYNC/tooling-start"
  for _ in {1..100}; do
    [[ -e "$SYNC/repository-start" ]] && break
    sleep 0.01
  done
  [[ -e "$SYNC/repository-start" ]]
fi
exit "${TOOLING_STATUS:-0}"
STUB
chmod +x "$work/tools/local-agent/check-local-agent.sh"

cat > "$bin/npm" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf 'npm %s\n' "$*" >> "$CALLS"
case "$*" in
  'ci --no-audit --no-fund')
    if [[ ${EXPECT_PARALLEL:-0} == 1 ]]; then
      touch "$SYNC/repository-start"
      for _ in {1..100}; do
        [[ -e "$SYNC/tooling-start" ]] && break
        sleep 0.01
      done
      [[ -e "$SYNC/tooling-start" ]]
    fi
    exit "${CI_STATUS:-0}"
    ;;
  'run check') exit "${CHECK_STATUS:-0}" ;;
  *) exit 64 ;;
esac
STUB
chmod +x "$bin/npm"

calls="$tmp/calls"
run_profile() {
  local profile="$1"
  shift
  (
    cd "$work"
    env PATH="$bin:$PATH" RUNNER_TEMP="$tmp/runner" CALLS="$calls" SYNC="$sync" "$@" \
      bash "$runner" validate-profile "$profile"
  )
}

identity_repo="$tmp/identity-repository"
identity_remote="$tmp/identity-remote.git"
identity_bundle="$tmp/publication.bundle"
git init -q --bare "$identity_remote"
git init -q -b main "$identity_repo"
git -C "$identity_repo" config user.name 'Validation Test'
git -C "$identity_repo" config user.email 'validation@example.invalid'
printf 'base\n' > "$identity_repo/example.txt"
git -C "$identity_repo" add example.txt
git -C "$identity_repo" commit -q -m base
base_sha=$(git -C "$identity_repo" rev-parse HEAD)
git -C "$identity_repo" branch feat/test-target
git -C "$identity_repo" remote add origin "$identity_remote"
git -C "$identity_repo" push -q origin feat/test-target
printf 'candidate\n' > "$identity_repo/example.txt"
git -C "$identity_repo" commit -qam candidate
candidate_sha=$(git -C "$identity_repo" rev-parse HEAD)
candidate_tree=$(git -C "$identity_repo" rev-parse 'HEAD^{tree}')
git -C "$identity_repo" branch patch-publication-candidate
git -C "$identity_repo" bundle create "$identity_bundle" \
  refs/heads/patch-publication-candidate "^$base_sha"
git -C "$identity_repo" reset -q --hard "$base_sha"
(
  cd "$identity_repo"
  env \
    TARGET_BRANCH=feat/test-target \
    CANDIDATE_COMMIT_SHA="$candidate_sha" \
    EXPECTED_BASE_SHA="$base_sha" \
    EXPECTED_RESULT_TREE_SHA="$candidate_tree" \
    PUBLICATION_BUNDLE="$identity_bundle" \
      bash "$runner" verify-identity >/dev/null
)
test "$(git -C "$identity_repo" rev-parse HEAD)" = "$candidate_sha"

: > "$calls"
run_profile docs >/dev/null
test ! -s "$calls"

: > "$calls"
rm -f "$sync"/*
run_profile source >/dev/null
test "$(cat "$calls")" = $'npm ci --no-audit --no-fund\nnpm run check'

: > "$calls"
rm -f "$sync"/*
run_profile full EXPECT_PARALLEL=1 >/dev/null
grep -qx 'tooling' "$calls"
grep -qx 'npm ci --no-audit --no-fund' "$calls"
grep -qx 'npm run check' "$calls"

: > "$calls"
rm -f "$sync"/*
set +e
failure=$(run_profile full EXPECT_PARALLEL=1 TOOLING_STATUS=7 CHECK_STATUS=9 2>&1)
status=$?
set -e
test "$status" -eq 1
grep -q 'tooling_status=7 repository_status=9' <<<"$failure"

: > "$calls"
rm -f "$sync"/*
set +e
failure=$(run_profile full EXPECT_PARALLEL=1 CI_STATUS=8 2>&1)
status=$?
set -e
test "$status" -eq 1
grep -q 'tooling_status=0 repository_status=8' <<<"$failure"
test "$(grep -c '^npm run check$' "$calls" || true)" -eq 0

if run_profile unknown >/dev/null 2>&1; then
  echo 'unknown validation profile unexpectedly succeeded' >&2
  exit 1
fi

if bash "$runner" unknown-mode >/dev/null 2>&1; then
  echo 'unknown validation mode unexpectedly succeeded' >&2
  exit 1
fi
