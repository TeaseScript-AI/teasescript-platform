#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: create-source-bundle.sh \
  --output DIRECTORY \
  --repository OWNER/REPOSITORY \
  --source-sha COMMIT_SHA \
  --source-ref REF_NAME \
  --event-name EVENT_NAME

Create a verified read-only Git bundle artifact for one exact checked-out commit.
The current HEAD must equal --source-sha.
USAGE
}

output_dir=
repository=
source_sha=
source_ref=
event_name=

while (($# > 0)); do
  case "$1" in
    --output)
      (($# >= 2)) || { echo "create-source-bundle: error: --output requires a value" >&2; exit 2; }
      output_dir=$2
      shift 2
      ;;
    --repository)
      (($# >= 2)) || { echo "create-source-bundle: error: --repository requires a value" >&2; exit 2; }
      repository=$2
      shift 2
      ;;
    --source-sha)
      (($# >= 2)) || { echo "create-source-bundle: error: --source-sha requires a value" >&2; exit 2; }
      source_sha=$2
      shift 2
      ;;
    --source-ref)
      (($# >= 2)) || { echo "create-source-bundle: error: --source-ref requires a value" >&2; exit 2; }
      source_ref=$2
      shift 2
      ;;
    --event-name)
      (($# >= 2)) || { echo "create-source-bundle: error: --event-name requires a value" >&2; exit 2; }
      event_name=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "create-source-bundle: error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

for required in output_dir repository source_sha source_ref event_name; do
  if [[ -z ${!required} ]]; then
    echo "create-source-bundle: error: missing required argument: $required" >&2
    usage >&2
    exit 2
  fi
done

for command in git jq sha256sum mktemp; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "create-source-bundle: error: required command not found: $command" >&2
    exit 1
  }
done

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  echo "create-source-bundle: error: current directory is not a Git worktree" >&2
  exit 1
}

if [[ ! "$repository" =~ ^[^/[:space:]]+/[^/[:space:]]+$ ]]; then
  echo "create-source-bundle: error: --repository must use OWNER/REPOSITORY format" >&2
  exit 2
fi
if [[ ! "$source_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "create-source-bundle: error: --source-sha must be a full lowercase 40-character commit SHA" >&2
  exit 2
fi

canonical_source_sha=$(git rev-parse --verify "${source_sha}^{commit}")
head_sha=$(git rev-parse --verify HEAD)
if [[ "$head_sha" != "$canonical_source_sha" ]]; then
  echo "create-source-bundle: error: HEAD $head_sha does not equal source commit $canonical_source_sha" >&2
  exit 1
fi

if [[ -e "$output_dir" ]]; then
  echo "create-source-bundle: error: output path already exists: $output_dir" >&2
  exit 1
fi

output_parent=$(dirname "$output_dir")
mkdir -p "$output_parent"
temp_dir=$(mktemp -d "$output_parent/.source-bundle.XXXXXX")
temp_ref=refs/heads/source-bundle
previous_ref=
ref_existed=false
published=false

cleanup() {
  if [[ "$ref_existed" == true ]]; then
    git update-ref "$temp_ref" "$previous_ref" >/dev/null 2>&1 || true
  else
    git update-ref -d "$temp_ref" >/dev/null 2>&1 || true
  fi
  if [[ "$published" != true ]]; then
    rm -rf "$temp_dir"
  fi
}
trap cleanup EXIT

if previous_ref=$(git rev-parse --verify "$temp_ref" 2>/dev/null); then
  ref_existed=true
fi

git update-ref "$temp_ref" "$canonical_source_sha"
git bundle create "$temp_dir/repository.bundle" HEAD "$temp_ref"
git bundle verify "$temp_dir/repository.bundle" >/dev/null 2>&1

mapfile -t bundle_heads < <(git bundle list-heads "$temp_dir/repository.bundle")
expected_head_line="$canonical_source_sha HEAD"
expected_ref_line="$canonical_source_sha $temp_ref"
if [[ " ${bundle_heads[*]} " != *" $expected_head_line "* ]] ||
   [[ " ${bundle_heads[*]} " != *" $expected_ref_line "* ]]; then
  echo "create-source-bundle: error: bundle heads do not contain the expected commit and ref" >&2
  printf 'bundle head: %s\n' "${bundle_heads[@]}" >&2
  exit 1
fi

tree_sha=$(git rev-parse --verify "${canonical_source_sha}^{tree}")
bundle_sha256=$(sha256sum "$temp_dir/repository.bundle" | awk '{print $1}')

jq -n \
  --arg repository "$repository" \
  --arg commitSha "$canonical_source_sha" \
  --arg treeSha "$tree_sha" \
  --arg sourceRef "$source_ref" \
  --arg bundleRef "$temp_ref" \
  --arg eventName "$event_name" \
  --arg bundleSha256 "$bundle_sha256" \
  '{
    formatVersion: 1,
    repository: $repository,
    commitSha: $commitSha,
    treeSha: $treeSha,
    sourceRef: $sourceRef,
    bundleRef: $bundleRef,
    eventName: $eventName,
    bundleSha256: $bundleSha256
  }' > "$temp_dir/manifest.json"

(
  cd "$temp_dir"
  sha256sum repository.bundle manifest.json > SHA256SUMS
  sha256sum --check SHA256SUMS >/dev/null
)

mv "$temp_dir" "$output_dir"
published=true

printf 'created source bundle for %s (tree %s) at %s\n' \
  "$canonical_source_sha" "$tree_sha" "$output_dir"
