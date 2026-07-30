#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root=$(cd -- "$script_dir/../.." && pwd)
helper="$script_dir/create-source-bundle.sh"
workflow="$root/.github/workflows/source-bundle.yml"
request_workflow="$root/.github/workflows/source-bundle-request.yml"
processor_workflow="$root/.github/workflows/source-bundle-request-processor.yml"
temp_root=$(mktemp -d)
trap 'rm -rf "$temp_root"' EXIT

fail() {
  echo "test-create-source-bundle: FAIL: $*" >&2
  exit 1
}

python3 - "$workflow" "$request_workflow" "$processor_workflow" <<'PYWORKFLOW'
import pathlib
import re
import sys

automatic = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
gate = pathlib.Path(sys.argv[2]).read_text(encoding="utf-8")
processor = pathlib.Path(sys.argv[3]).read_text(encoding="utf-8")

refs = re.findall(r"^\s*uses:\s*([^\s#]+)", automatic + "\n" + processor, re.MULTILINE)
assert refs and all(re.fullmatch(r"[^@]+@[0-9a-f]{40}", ref) for ref in refs)

assert "workflow_dispatch" not in automatic
assert "inputs.source_ref" not in automatic
assert "TOOLING_REF: ${{ github.workflow_sha }}" in automatic
assert "REQUESTED_SOURCE:" in automatic and "github.event.pull_request.head.sha" in automatic
assert "SOURCE_REF:" in automatic and "github.head_ref" in automatic
assert automatic.count("uses: actions/checkout@") == 2
assert "ref: ${{ env.TOOLING_REF }}" in automatic and "path: tooling" in automatic
assert "ref: ${{ env.REQUESTED_SOURCE }}" in automatic and "path: source" in automatic
assert "id: source" in automatic and "working-directory: source" in automatic
assert "source_sha=$(git rev-parse --verify HEAD)" in automatic
assert "bash ../tooling/tools/local-agent/create-source-bundle.sh" in automatic
assert "--output ../source-artifact" in automatic
assert "steps.source.outputs.sha" in automatic
assert "name: teasescript-source-${{ steps.source.outputs.sha }}" in automatic

assert re.search(r"^on:\n  create:\n", gate, re.MULTILINE)
assert "permissions: {}" in gate
assert "source-bundle-request/" in gate
assert "^[0-9a-f]{40}$" in gate
assert "uses:" not in gate

assert re.search(r"^  workflow_run:\n    workflows: \[Source bundle request\]\n    types: \[completed\]", processor, re.MULTILINE)
assert "permissions: {}" in processor
assert "github.event.workflow_run.event == 'create'" in processor
assert "github.event.workflow_run.conclusion == 'success'" in processor
assert "^source-bundle-request\\/([0-9a-f]{40})\\/([a-z0-9][a-z0-9-]{0,31})$" in processor
assert "github.rest.git.getRef" in processor
assert "github.rest.repos.get" in processor
assert "github.rest.git.getCommit" in processor
assert "github.rest.repos.compareCommitsWithBasehead" in processor
assert "['ahead', 'identical']" in processor
assert "TOOLING_REF: ${{ github.workflow_sha }}" in processor
assert processor.count("uses: actions/checkout@") == 2
cleanup = processor.split("  cleanup-request:\n", 1)[1]
assert "uses: actions/checkout@" not in cleanup
assert "git init -q \"$cleanup_repo\"" in cleanup
assert "Check out requested source as data" in processor
assert "--event-name source-bundle-request" in processor
assert "artifact_id: ${{ steps.upload.outputs.artifact-id }}" in processor
assert "artifact_url: ${{ steps.upload.outputs.artifact-url }}" in processor
assert "artifact_digest: ${{ steps.upload.outputs.artifact-digest }}" in processor
assert "statuses: write" in processor
assert "github.rest.repos.createCommitStatus" in processor
assert "`artifact ${artifactId} ${artifactDigest}`" in processor
status_description = "artifact 8758008910 sha256:" + "a" * 64
status_match = re.fullmatch(r"artifact ([0-9]+) (sha256:[0-9a-f]{64})", status_description)
assert status_match and len(status_description) <= 140
assert "needs.publish-result.result == 'success'" in processor
assert "contents: write" in processor
assert '--force-with-lease="${request_ref}:${EXPECTED_REQUEST_SHA}"' in processor
assert "github.rest.git.deleteRef" not in processor

branch_pattern = re.compile(r"^source-bundle-request/([0-9a-f]{40})/([a-z0-9][a-z0-9-]{0,31})$")
valid_sha = "9a" * 20
assert branch_pattern.fullmatch(f"source-bundle-request/{valid_sha}/agent-149-1")
for invalid in (
    f"source-bundle-request/{valid_sha[:-1]}/agent-149-1",
    f"source-bundle-request/{valid_sha.upper()}/agent-149-1",
    f"source-bundle-request/{valid_sha}/Agent-149-1",
    f"source-bundle-request/{valid_sha}/bad_nonce",
    f"other/{valid_sha}/agent-149-1",
):
    assert not branch_pattern.fullmatch(invalid), invalid
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

# Prove exact-SHA request-ref cleanup and stale-ref preservation against a real bare remote.
cleanup_remote="$temp_root/request-cleanup.git"
cleanup_repo="$temp_root/request-cleanup"
git init -q --bare "$cleanup_remote"
git init -q "$cleanup_repo"
request_ref="refs/heads/source-bundle-request/$first_sha/cleanup-test"
git -C "$repo" push -q "$cleanup_remote" "$second_sha:$request_ref"
git -C "$cleanup_repo" push -q \
  --force-with-lease="${request_ref}:${second_sha}" \
  "$cleanup_remote" ":${request_ref}"
[[ -z $(git ls-remote --heads "$cleanup_remote" "$request_ref") ]] || fail "exact request ref was not deleted"

git -C "$repo" push -q "$cleanup_remote" "$second_sha:$request_ref"
git -C "$repo" push -q --force "$cleanup_remote" "$first_sha:$request_ref"
if git -C "$cleanup_repo" push -q \
  --force-with-lease="${request_ref}:${second_sha}" \
  "$cleanup_remote" ":${request_ref}" 2>/dev/null; then
  fail "stale cleanup deleted a moved request ref"
fi
[[ $(git ls-remote --heads "$cleanup_remote" "$request_ref" | awk '{print $1}') == "$first_sha" ]] || \
  fail "moved request ref was not preserved"

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
