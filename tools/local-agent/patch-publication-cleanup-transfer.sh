#!/usr/bin/env bash
set -euo pipefail
[[ "$TRANSFER_BRANCH" =~ ^agent-patch-publication/[A-Za-z0-9][A-Za-z0-9._/-]{0,215}$ ]]
[[ "$TRANSFER_BRANCH" != *".."* ]]
[[ "$TRANSFER_BRANCH" != *"//"* ]]
[[ "$TRANSFER_BRANCH" != */ ]]
[[ "$EXPECTED_TRANSFER_SHA" =~ ^[0-9a-f]{40}$ ]]

cleanup_repo="$RUNNER_TEMP/patch-publication-cleanup"
git init -q "$cleanup_repo"
cd "$cleanup_repo"
remote_url="${PATCH_PUBLICATION_TEST_REMOTE_URL:-https://github.com/${GITHUB_REPOSITORY}.git}"
auth_header="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')"
transfer_ref="refs/heads/$TRANSFER_BRANCH"
cleanup_status=failed
cleanup_failed=0

if [[ "$PUBLISH_RESULT" != success ]]; then
  set +e
  remote_output="$(git -c "http.https://github.com/.extraheader=$auth_header" \
    ls-remote --heads "$remote_url" "$transfer_ref" 2>&1)"
  remote_result=$?
  set -e
  if [[ $remote_result -ne 0 ]]; then
    echo "$remote_output" >&2
    cleanup_status=failed
    cleanup_failed=1
  elif [[ -z "$remote_output" ]]; then
    cleanup_status=already_absent
  else
    current_transfer_sha="${remote_output%%$'\t'*}"
    if [[ "$current_transfer_sha" == "$EXPECTED_TRANSFER_SHA" ]]; then
      cleanup_status=preserved_retry
    else
      cleanup_status=preserved_changed
    fi
  fi
else
  set +e
  push_output="$(git -c "http.https://github.com/.extraheader=$auth_header" \
    push --porcelain \
    --force-with-lease="${transfer_ref}:${EXPECTED_TRANSFER_SHA}" \
    "$remote_url" ":${transfer_ref}" 2>&1)"
  push_result=$?
  set -e

  if [[ $push_result -eq 0 ]]; then
    cleanup_status=removed
  else
    set +e
    remote_output="$(git -c "http.https://github.com/.extraheader=$auth_header" \
      ls-remote --heads "$remote_url" "$transfer_ref" 2>&1)"
    remote_result=$?
    set -e
    if [[ $remote_result -ne 0 ]]; then
      echo "$push_output" >&2
      echo "$remote_output" >&2
      cleanup_status=failed
      cleanup_failed=1
    elif [[ -z "$remote_output" ]]; then
      cleanup_status=already_absent
    else
      current_transfer_sha="${remote_output%%$'\t'*}"
      if [[ "$current_transfer_sha" != "$EXPECTED_TRANSFER_SHA" ]]; then
        cleanup_status=preserved_changed
      else
        echo "$push_output" >&2
        cleanup_status=failed
        cleanup_failed=1
      fi
    fi
  fi
fi

echo "cleanup_status=$cleanup_status" >> "$GITHUB_OUTPUT"
if [[ $cleanup_failed -ne 0 ]]; then
  exit 1
fi
