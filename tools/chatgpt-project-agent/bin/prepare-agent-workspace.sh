#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: prepare-agent-workspace.sh \
  --artifact FILE --artifact-sha256 SHA256 --expected-head SHA \
  [--expected-merge-base SHA] [--expected-repository OWNER/REPO] \
  --output DIRECTORY [--node 24|26] [--with-ts-morph] [--with-tiktoken] \
  [--debug-verify-bootstrap] [--check]

Normal ChatGPT project-agent entrypoint. Verify a downloaded source artifact,
create the exact clean checkout, install the locked dependency graph offline,
prepare Node 24/26 runners, and install and verify mandatory ts-morph and
TikToken. The two --with-* flags remain accepted as compatibility no-ops.
USAGE
}

artifact=
digest=
repository=TeaseScript-AI/teasescript-platform
head=
merge_base=
output=
node_major=24
run_check=0
debug_verify=0

while (($#)); do
  case "$1" in
    --artifact) (($# >= 2)) || { usage >&2; exit 2; }; artifact=$2; shift 2 ;;
    --artifact-sha256) (($# >= 2)) || { usage >&2; exit 2; }; digest=$2; shift 2 ;;
    --expected-repository) (($# >= 2)) || { usage >&2; exit 2; }; repository=$2; shift 2 ;;
    --expected-head) (($# >= 2)) || { usage >&2; exit 2; }; head=$2; shift 2 ;;
    --expected-merge-base) (($# >= 2)) || { usage >&2; exit 2; }; merge_base=$2; shift 2 ;;
    --output) (($# >= 2)) || { usage >&2; exit 2; }; output=$2; shift 2 ;;
    --node) (($# >= 2)) || { usage >&2; exit 2; }; node_major=$2; shift 2 ;;
    --with-ts-morph|--with-tiktoken) shift ;;
    --debug-verify-bootstrap) debug_verify=1; shift ;;
    --check) run_check=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'prepare-agent-workspace: FAIL: unknown or incomplete argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

[[ -n "$artifact" && -n "$digest" && -n "$head" && -n "$output" ]] || {
  usage >&2
  exit 2
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
printf 'prepare-agent-workspace: INFO: verifying and exposing exact source checkout\n' >&2
"${prepare[@]}"

setup=("$script_dir/setup-workspace.sh" --node "$node_major")
((debug_verify == 0)) || setup+=(--debug-verify-bootstrap)
((run_check == 0)) || setup+=(--check)
setup+=("$output")
"${setup[@]}"
