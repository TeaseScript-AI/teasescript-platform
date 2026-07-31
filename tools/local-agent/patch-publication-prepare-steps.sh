#!/usr/bin/env bash
set -euo pipefail

step="${1:?prepare step is required}"

case "$step" in
  read-manifest)
    git fetch --no-tags origin \
      "refs/heads/$TRANSFER_BRANCH:refs/remotes/origin/patch-transfer"
    actual_transfer_sha="$(git rev-parse refs/remotes/origin/patch-transfer)"
    if [[ "$actual_transfer_sha" != "$EXPECTED_TRANSFER_SHA" ]]; then
      echo "Transfer branch moved: expected $EXPECTED_TRANSFER_SHA, found $actual_transfer_sha" >&2
      exit 1
    fi
    git show \
      "refs/remotes/origin/patch-transfer:.agent-patch-publication/manifest.json" \
      > "$RUNNER_TEMP/manifest.json"
    ;;

  verify-manifest)
    actual_manifest_sha256="$(sha256sum "$RUNNER_TEMP/manifest.json" | awk '{print $1}')"
    if [[ "$actual_manifest_sha256" != "$EXPECTED_MANIFEST_SHA256" ]]; then
      echo "Manifest SHA-256 mismatch: expected $EXPECTED_MANIFEST_SHA256, found $actual_manifest_sha256" >&2
      exit 1
    fi
    ;;

  materialize)
    python3 -B "$RUNNER_TEMP/patch-publication.py" materialize-patch \
      --repository "$GITHUB_WORKSPACE" \
      --manifest "$RUNNER_TEMP/manifest.json" \
      --transfer-ref refs/remotes/origin/patch-transfer \
      --output-patch "$RUNNER_TEMP/change.patch" \
      --expected-target-branch "$EXPECTED_TARGET_BRANCH" \
      --default-branch "$DEFAULT_BRANCH" \
      --github-output "$GITHUB_OUTPUT"
    ;;

  inspect)
    args=(
      inspect-request
      --repository "$GITHUB_WORKSPACE"
      --manifest "$RUNNER_TEMP/manifest.json"
      --patch "$RUNNER_TEMP/change.patch"
      --transfer-branch "$TRANSFER_BRANCH"
      --expected-target-branch "$EXPECTED_TARGET_BRANCH"
      --default-branch "$DEFAULT_BRANCH"
      --github-output "$GITHUB_OUTPUT"
    )
    python3 -B "$RUNNER_TEMP/patch-publication.py" "${args[@]}"
    ;;

  checkout-base)
    git fetch --no-tags origin \
      "refs/heads/$TARGET_BRANCH:refs/remotes/origin/patch-target"
    actual_base_sha="$(git rev-parse refs/remotes/origin/patch-target)"
    if [[ "$actual_base_sha" != "$EXPECTED_BASE_SHA" ]]; then
      echo "Target branch moved: expected $EXPECTED_BASE_SHA, found $actual_base_sha" >&2
      exit 1
    fi
    git checkout --detach "$EXPECTED_BASE_SHA"
    ;;

  prepare)
    args=(
      prepare
      --repository "$GITHUB_WORKSPACE"
      --manifest "$RUNNER_TEMP/manifest.json"
      --patch "$RUNNER_TEMP/change.patch"
      --transfer-branch "$TRANSFER_BRANCH"
      --expected-target-branch "$EXPECTED_TARGET_BRANCH"
      --default-branch "$DEFAULT_BRANCH"
      --output-directory "$RUNNER_TEMP/publication"
      --github-output "$GITHUB_OUTPUT"
    )
    python3 -B "$RUNNER_TEMP/patch-publication.py" "${args[@]}"
    ;;

  *)
    echo "Unknown prepare step: $step" >&2
    exit 2
    ;;
esac
