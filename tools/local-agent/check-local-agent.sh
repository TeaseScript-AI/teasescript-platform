#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
log_dir=${1:-${RUNNER_TEMP:-/tmp}/teasescript-local-agent-logs}
mkdir -p "$log_dir"

run_source_review_group() {
  python3 -S -B "$script_dir/test-prepare-source-review.py"
}

run_patch_publication_group() {
  python3 -S -B "$script_dir/test-patch-publication.py"
}

run_short_checks_group() {
  python3 -B "$script_dir/test-compact-unittest.py"
  bash "$script_dir/test-run-compact.sh"
  bash "$script_dir/run-compact.sh" \
    --label source-bundle-workflow \
    --log "$log_dir/source-bundle-workflow.log" \
    -- env TEASESCRIPT_COMPACT_TEST_INNER=1 \
      bash "$script_dir/test-create-source-bundle.sh"
  node "$script_dir/test-source-bundle-artifact-request.cjs"
  bash "$script_dir/test-chatgpt-project-agent.sh"
  python3 -B "$script_dir/test-prepare-patch-publication.py"
  bash "$script_dir/test-patch-publication-validate-candidate.sh"
  bash "$script_dir/run-compact.sh" \
    --label patch-publication-workflow \
    --log "$log_dir/patch-publication-workflow.log" \
    -- env TEASESCRIPT_COMPACT_TEST_INNER=1 \
      bash "$script_dir/test-patch-publication-workflow.sh"
}

group_names=(source-review patch-publication short-checks)
group_functions=(run_source_review_group run_patch_publication_group run_short_checks_group)
group_pids=()
group_statuses=()

for index in "${!group_names[@]}"; do
  group_log="$log_dir/${group_names[$index]}.group.log"
  : > "$group_log"
  "${group_functions[$index]}" >"$group_log" 2>&1 &
  group_pids+=("$!")
done

overall_status=0
for index in "${!group_pids[@]}"; do
  if wait "${group_pids[$index]}"; then
    group_statuses+=(0)
  else
    group_status=$?
    group_statuses+=("$group_status")
    overall_status=1
  fi
done

for index in "${!group_names[@]}"; do
  group_log="$log_dir/${group_names[$index]}.group.log"
  cat "$group_log"
  if ((group_statuses[index] == 0)); then
    rm -f "$group_log"
  else
    printf '%s: FAIL (exit %d; complete log: %s)\n' \
      "${group_names[$index]}" "${group_statuses[$index]}" "$group_log" >&2
  fi
done

exit "$overall_status"
