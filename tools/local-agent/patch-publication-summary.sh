#!/usr/bin/env bash
set -euo pipefail

{
  printf '## Patch publication result\n\n'
  printf -- '- target branch: `%s`\n' "$TARGET_BRANCH"
  printf -- '- published commit: `%s`\n' "${PUBLISHED_COMMIT_SHA:-none}"
  printf -- '- prepare: `%s`\n' "$PREPARE_RESULT"
  printf -- '- test: `%s`\n' "$TEST_RESULT"
  printf -- '- publish: `%s`\n' "$PUBLISH_RESULT"
  printf -- '- transfer cleanup: `%s`\n' "${TRANSFER_CLEANUP_STATUS:-failed}"
  printf -- '- command cleanup: `%s`\n' "${COMMENT_CLEANUP_STATUS:-failed}"
} >> "$GITHUB_STEP_SUMMARY"
