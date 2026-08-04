#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: prepare-agent-workspace.sh \
  --artifact FILE --artifact-sha256 SHA256 --expected-head SHA \
  [--expected-merge-base SHA] [--expected-repository OWNER/REPO] \
  --output DIRECTORY [--node 24|26] [--with-ts-morph] [--with-tiktoken] [--check]

Normal agent entry point. Verify a downloaded source artifact, create the exact
clean checkout, run npm ci offline, and prepare exact Node runners. Full tests
run only with --check. GitHub artifact discovery/download remains a connector
step before this script.
USAGE
}

artifact=
digest=
repository=TeaseScript-AI/teasescript-platform
head=
merge_base=
output=
node_major=24
with_ts_morph=0
with_tiktoken=0
run_check=0

while (($#)); do
  case "$1" in
    --artifact) artifact=${2-}; shift 2 ;;
    --artifact-sha256) digest=${2-}; shift 2 ;;
    --expected-repository) repository=${2-}; shift 2 ;;
    --expected-head) head=${2-}; shift 2 ;;
    --expected-merge-base) merge_base=${2-}; shift 2 ;;
    --output) output=${2-}; shift 2 ;;
    --node) node_major=${2-}; shift 2 ;;
    --with-ts-morph) with_ts_morph=1; shift ;;
    --with-tiktoken) with_tiktoken=1; shift ;;
    --check) run_check=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "prepare-agent-workspace: FAIL: unknown or incomplete argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$artifact" && -n "$digest" && -n "$head" && -n "$output" ]] || {
  usage >&2; exit 2;
}
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
bundle_dir=$(cd -- "$script_dir/.." && pwd)
prepare=(
  python3 "$bundle_dir/tools/prepare-source-review.py"
  --artifact "$artifact"
  --artifact-sha256 "$digest"
  --expected-repository "$repository"
  --expected-head "$head"
  --output "$output"
)
[[ -z "$merge_base" ]] || prepare+=(--expected-merge-base "$merge_base")
"${prepare[@]}"

setup=("$script_dir/setup-workspace.sh" --node "$node_major")
((with_ts_morph == 0)) || setup+=(--with-ts-morph)
((with_tiktoken == 0)) || setup+=(--with-tiktoken)
((run_check == 0)) || setup+=(--check)
setup+=("$output")
"${setup[@]}"
