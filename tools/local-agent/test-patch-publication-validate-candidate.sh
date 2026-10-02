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
mkdir -p "$work/tools/local-agent" "$bin"

cat > "$work/tools/local-agent/check-local-agent.sh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf 'tooling\n' >> "$CALLS"
exit "${TOOLING_STATUS:-0}"
STUB
chmod +x "$work/tools/local-agent/check-local-agent.sh"

# Records the locked install as "ci" and the complete check as "check", whatever flags they use.
cat > "$bin/npm" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
case "${1-} ${2-}" in
  'ci '*) printf 'ci\n' >> "$CALLS"; exit "${CI_STATUS:-0}" ;;
  'run check') printf 'check\n' >> "$CALLS"; exit "${CHECK_STATUS:-0}" ;;
  *) printf 'npm %s\n' "$*" >> "$CALLS"; exit 64 ;;
esac
STUB
chmod +x "$bin/npm"

calls="$tmp/calls"
run_profile() {
  local profile="$1"
  shift
  (
    cd "$work"
    env PATH="$bin:$PATH" RUNNER_TEMP="$tmp/runner" CALLS="$calls" "$@" \
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

# Each rejected case differs from the accepted identity in exactly one value.
base_tree=$(git -C "$identity_repo" rev-parse "$base_sha^{tree}")
moved_base_sha=$(git -C "$identity_repo" commit-tree "$base_tree" -p "$base_sha" -m 'moved base')
moved_remote="$tmp/identity-moved-remote.git"
git clone -q --bare "$identity_remote" "$moved_remote"
git -C "$identity_repo" push -q "$moved_remote" "$moved_base_sha:refs/heads/feat/test-target"
wrong_parent_sha=$(git -C "$identity_repo" commit-tree "$candidate_tree" -p "$moved_base_sha" -m candidate)
wrong_parent_bundle="$tmp/wrong-parent.bundle"
git -C "$identity_repo" branch -f patch-publication-candidate "$wrong_parent_sha"
git -C "$identity_repo" bundle create "$wrong_parent_bundle" \
  refs/heads/patch-publication-candidate "^$base_sha"

identity_rejected() {
  local remote="$1" bundle="$2" candidate="$3" tree="$4" repo
  repo=$(mktemp -d "$tmp/identity-case-XXXXXX")
  git init -q "$repo"
  git -C "$repo" remote add origin "$remote"
  if (
    cd "$repo"
    env \
      TARGET_BRANCH=feat/test-target \
      CANDIDATE_COMMIT_SHA="$candidate" \
      EXPECTED_BASE_SHA="$base_sha" \
      EXPECTED_RESULT_TREE_SHA="$tree" \
      PUBLICATION_BUNDLE="$bundle" \
        bash "$runner" verify-identity >/dev/null 2>&1
  ); then
    echo "verify-identity unexpectedly accepted: $*" >&2
    exit 1
  fi
}

identity_rejected "$moved_remote" "$identity_bundle" "$candidate_sha" "$candidate_tree"
identity_rejected "$identity_remote" "$identity_bundle" "$wrong_parent_sha" "$candidate_tree"
identity_rejected "$identity_remote" "$wrong_parent_bundle" "$wrong_parent_sha" "$candidate_tree"
identity_rejected "$identity_remote" "$identity_bundle" "$candidate_sha" "$base_tree"

: > "$calls"
run_profile docs >/dev/null
test ! -s "$calls"

: > "$calls"
run_profile source >/dev/null
test "$(cat "$calls")" = $'ci\ncheck'

: > "$calls"
run_profile full >/dev/null
test "$(cat "$calls")" = $'tooling\nci\ncheck'

: > "$calls"
set +e
run_profile full TOOLING_STATUS=7 >/dev/null 2>&1
status=$?
set -e
test "$status" -eq 7
test "$(cat "$calls")" = 'tooling'

: > "$calls"
set +e
run_profile full CI_STATUS=8 >/dev/null 2>&1
status=$?
set -e
test "$status" -eq 8
test "$(cat "$calls")" = $'tooling\nci'

: > "$calls"
set +e
run_profile full CHECK_STATUS=9 >/dev/null 2>&1
status=$?
set -e
test "$status" -eq 9
test "$(cat "$calls")" = $'tooling\nci\ncheck'

if run_profile unknown >/dev/null 2>&1; then
  echo 'unknown validation profile unexpectedly succeeded' >&2
  exit 1
fi

if bash "$runner" unknown-mode >/dev/null 2>&1; then
  echo 'unknown validation mode unexpectedly succeeded' >&2
  exit 1
fi
