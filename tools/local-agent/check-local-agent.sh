#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
log_dir=${1:-${RUNNER_TEMP:-/tmp}/teasescript-local-agent-logs}
mkdir -p "$log_dir"

python3 -B "$script_dir/test-compact-unittest.py"
bash "$script_dir/test-run-compact.sh"
bash "$script_dir/run-compact.sh" \
  --label source-bundle-workflow \
  --log "$log_dir/source-bundle-workflow.log" \
  -- env TEASESCRIPT_COMPACT_TEST_INNER=1 \
    bash "$script_dir/test-create-source-bundle.sh"
python3 -B "$script_dir/test-prepare-source-review.py"
python3 -B "$script_dir/test-prepare-patch-publication.py"
python3 -B "$script_dir/test-patch-publication.py"
bash "$script_dir/test-patch-publication-validate-candidate.sh"
bash "$script_dir/run-compact.sh" \
  --label patch-publication-workflow \
  --log "$log_dir/patch-publication-workflow.log" \
  -- env TEASESCRIPT_COMPACT_TEST_INNER=1 \
    bash "$script_dir/test-patch-publication-workflow.sh"
