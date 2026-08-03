#!/usr/bin/env bash
set -euo pipefail

mode=${1:?validation mode is required}

verify_identity() {
  : "${TARGET_BRANCH:?TARGET_BRANCH is required}"
  : "${CANDIDATE_COMMIT_SHA:?CANDIDATE_COMMIT_SHA is required}"
  : "${EXPECTED_BASE_SHA:?EXPECTED_BASE_SHA is required}"
  : "${EXPECTED_RESULT_TREE_SHA:?EXPECTED_RESULT_TREE_SHA is required}"
  publication_bundle=${PUBLICATION_BUNDLE:-${RUNNER_TEMP:?RUNNER_TEMP is required}/publication/publication.bundle}

  git fetch --no-tags origin \
    "refs/heads/$TARGET_BRANCH:refs/remotes/origin/patch-target"
  test "$(git rev-parse refs/remotes/origin/patch-target)" = "$EXPECTED_BASE_SHA"
  git fetch --no-tags "$publication_bundle" \
    "refs/heads/patch-publication-candidate:refs/heads/test-candidate"
  git checkout --detach refs/heads/test-candidate
  test "$(git rev-parse HEAD)" = "$CANDIDATE_COMMIT_SHA"
  test "$(git show -s --format=%P HEAD)" = "$EXPECTED_BASE_SHA"
  test "$(git show -s --format=%T HEAD)" = "$EXPECTED_RESULT_TREE_SHA"
}

run_repository_checks() {
  npm ci --no-audit --no-fund &&
    npm run check
}

validate_profile() {
  local profile=${1:?validation profile is required}
  case "$profile" in
    docs)
      echo "Documentation-only validation: executable checks are skipped because the trusted classifier proved that every changed path is non-executable documentation. Candidate commit, parent, tree, bundle, artifact, and target-base identity checks still run."
      ;;

    source)
      echo "Repository validation: install the locked dependency graph and run the complete configured build/test suite to prevent source, build, package, and test regressions. Workflow transport and permission tests are skipped because no workflow or local-agent path changed."
      run_repository_checks
      ;;

    full)
      echo "Full validation: first run workflow/local-agent security regressions, then repository build/tests. This prevents transport, permission, cleanup, candidate-verification, source, build, and runtime regressions."
      bash tools/local-agent/check-local-agent.sh
      run_repository_checks
      ;;

    *)
      echo "Unknown candidate validation profile: $profile" >&2
      exit 2
      ;;
  esac
}

case "$mode" in
  verify-identity) verify_identity ;;
  validate-profile) validate_profile "${2-}" ;;
  *)
    echo "Unknown candidate validation mode: $mode" >&2
    exit 2
    ;;
esac
