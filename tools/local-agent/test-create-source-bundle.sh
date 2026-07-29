#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root=$(cd -- "$script_dir/../.." && pwd)
helper="$script_dir/create-source-bundle.sh"
workflow="$root/.github/workflows/source-bundle.yml"
temp_root=$(mktemp -d)
trap 'rm -rf "$temp_root"' EXIT

fail() {
  echo "test-create-source-bundle: FAIL: $*" >&2
  exit 1
}

python3 - "$workflow" <<'PYWORKFLOW'
import pathlib
import re
import sys

text = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
refs = re.findall(r"^\s*uses:\s*([^\s#]+)", text, re.MULTILINE)
assert refs and all(re.fullmatch(r"[^@]+@[0-9a-f]{40}", ref) for ref in refs)
assert re.search(r"^  workflow_dispatch:\n    inputs:\n      source_ref:\n", text, re.MULTILINE)
assert "Branch, tag, pull-request ref, or full commit SHA to bundle" in text
assert "TOOLING_REF:" in text and "github.event.repository.default_branch" in text
assert "REQUESTED_SOURCE:" in text and "inputs.source_ref" in text
assert "SOURCE_REF:" in text and "github.head_ref" in text
assert text.count("uses: actions/checkout@") == 2
assert "ref: ${{ env.TOOLING_REF }}" in text and "path: tooling" in text
assert "ref: ${{ env.REQUESTED_SOURCE }}" in text and "path: source" in text
assert "id: source" in text and "working-directory: source" in text
assert "source_sha=$(git rev-parse --verify HEAD)" in text
assert "bash ../tooling/tools/local-agent/create-source-bundle.sh" in text
assert "--output ../source-artifact" in text
assert "steps.source.outputs.sha" in text
assert "name: teasescript-source-${{ steps.source.outputs.sha }}" in text
PYWORKFLOW

repo="$temp_root/repository"
mkdir -p "$repo"
git -C "$repo" init -q
git -C "$repo" config user.name "Source Bundle Test"
git -C "$repo" config user.email "source-bundle-test@example.invalid"

printf 'first\n' > "$repo/example.txt"
git -C "$repo" add example.txt
git -C "$repo" commit -q -m "Add first fixture"
first_sha=$(git -C "$repo" rev-parse HEAD)

printf 'second\n' >> "$repo/example.txt"
git -C "$repo" commit -qam "Extend fixture"
second_sha=$(git -C "$repo" rev-parse HEAD)
second_tree=$(git -C "$repo" rev-parse 'HEAD^{tree}')

# Create unrelated refs whose commit must not enter the source bundle.
unrelated_sha=$(printf 'Unrelated fixture\n' | git -C "$repo" commit-tree "$second_tree")
git -C "$repo" branch unrelated "$unrelated_sha"
git -C "$repo" tag unrelated-tag "$unrelated_sha"

# Preserve and restore a pre-existing local ref with the helper's temporary name.
git -C "$repo" update-ref refs/heads/source-bundle "$first_sha"

output="$temp_root/output"
(
  cd "$repo"
  bash "$helper" \
      --output "$output" \
      --repository TeaseScript-AI/teasescript-platform \
      --source-sha "$second_sha" \
      --source-ref fixture-branch \
      --event-name test
)

[[ -f "$output/repository.bundle" ]] || fail "repository.bundle missing"
[[ -f "$output/manifest.json" ]] || fail "manifest.json missing"
[[ -f "$output/SHA256SUMS" ]] || fail "SHA256SUMS missing"

(
  cd "$output"
  sha256sum --check SHA256SUMS >/dev/null
)

[[ $(jq -r '.formatVersion' "$output/manifest.json") == 1 ]] || fail "formatVersion mismatch"
[[ $(jq -r '.repository' "$output/manifest.json") == TeaseScript-AI/teasescript-platform ]] || fail "repository mismatch"
[[ $(jq -r '.commitSha' "$output/manifest.json") == "$second_sha" ]] || fail "commit SHA mismatch"
[[ $(jq -r '.treeSha' "$output/manifest.json") == "$second_tree" ]] || fail "tree SHA mismatch"
[[ $(jq -r '.sourceRef' "$output/manifest.json") == fixture-branch ]] || fail "source ref mismatch"
[[ $(jq -r '.bundleRef' "$output/manifest.json") == refs/heads/source-bundle ]] || fail "bundle ref mismatch"
[[ $(jq -r '.eventName' "$output/manifest.json") == test ]] || fail "event name mismatch"
[[ $(jq -r '.bundleSha256' "$output/manifest.json") == "$(sha256sum "$output/repository.bundle" | awk '{print $1}')" ]] || fail "bundle checksum mismatch"
[[ $(git -C "$repo" rev-parse refs/heads/source-bundle) == "$first_sha" ]] || fail "pre-existing temporary ref was not restored"

bundle_heads=$(git bundle list-heads "$output/repository.bundle")
[[ "$bundle_heads" != *"refs/heads/unrelated"* ]] || fail "unrelated branch entered bundle heads"
[[ "$bundle_heads" != *"refs/tags/unrelated-tag"* ]] || fail "unrelated tag entered bundle heads"

verifier="$temp_root/verifier.git"
git init -q --bare "$verifier"
git -C "$verifier" bundle verify "$output/repository.bundle" >/dev/null

clone="$temp_root/clone"
git -c init.defaultBranch=main clone -q "$output/repository.bundle" "$clone"
[[ $(git -C "$clone" rev-parse HEAD) == "$second_sha" ]] || fail "cloned HEAD mismatch"
[[ $(git -C "$clone" rev-parse 'HEAD^{tree}') == "$second_tree" ]] || fail "cloned tree mismatch"
[[ -z $(git -C "$clone" status --porcelain) ]] || fail "cloned worktree is dirty"
if git -C "$clone" cat-file -e "${unrelated_sha}^{commit}" 2>/dev/null; then
  fail "unrelated commit entered cloned bundle"
fi

# Refuse a source SHA that does not equal the checked-out HEAD.
if (
  cd "$repo"
  bash "$helper" \
    --output "$temp_root/should-not-exist" \
    --repository TeaseScript-AI/teasescript-platform \
    --source-sha "$first_sha" \
    --source-ref fixture-branch \
    --event-name test
) >/dev/null 2>&1; then
  fail "helper accepted a source SHA different from HEAD"
fi
[[ ! -e "$temp_root/should-not-exist" ]] || fail "failed run created output"

# Refuse overwriting an existing output path.
mkdir "$temp_root/existing"
if (
  cd "$repo"
  bash "$helper" \
    --output "$temp_root/existing" \
    --repository TeaseScript-AI/teasescript-platform \
    --source-sha "$second_sha" \
    --source-ref fixture-branch \
    --event-name test
) >/dev/null 2>&1; then
  fail "helper overwrote an existing output path"
fi

printf 'test-create-source-bundle: PASS\n'
