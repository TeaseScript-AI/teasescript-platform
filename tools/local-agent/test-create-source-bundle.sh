#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ ${TEASESCRIPT_COMPACT_TEST_INNER:-0} != 1 ]]; then
  log=$(mktemp -t source-bundle-workflow-XXXXXX.log)
  rm -f "$log"
  exec "$script_dir/run-compact.sh" \
    --label source-bundle-workflow \
    --log "$log" \
    -- env TEASESCRIPT_COMPACT_TEST_INNER=1 bash "$0" "$@"
fi
root=$(cd -- "$script_dir/../.." && pwd)
helper="$script_dir/create-source-bundle.sh"
workflow="$root/.github/workflows/source-bundle.yml"
request_workflow="$root/.github/workflows/source-bundle-request.yml"
processor_workflow="$root/.github/workflows/source-bundle-request-processor.yml"
index_workflow="$root/.github/workflows/source-bundle-index.yml"
artifact_router_workflow="$root/.github/workflows/patch-publication.yml"
artifact_request_workflow="$root/.github/workflows/artifact-mailbox-worker.yml"
connector_acquisition="$root/docs/agents/CONNECTOR-SOURCE-ACQUISITION.md"
development_workflow="$root/docs/DEVELOPMENT-WORKFLOW.md"
agents_file="$root/AGENTS.md"
temp_root=$(mktemp -d)
trap 'rm -rf "$temp_root"' EXIT

fail() {
  echo "test-create-source-bundle: FAIL: $*" >&2
  exit 1
}

python3 - \
  "$workflow" \
  "$request_workflow" \
  "$processor_workflow" \
  "$index_workflow" \
  "$artifact_router_workflow" \
  "$artifact_request_workflow" \
  "$connector_acquisition" \
  "$development_workflow" \
  "$agents_file" <<'PYWORKFLOW'
import pathlib
import re
import sys

automatic = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
gate = pathlib.Path(sys.argv[2]).read_text(encoding="utf-8")
processor = pathlib.Path(sys.argv[3]).read_text(encoding="utf-8")
index = pathlib.Path(sys.argv[4]).read_text(encoding="utf-8")
artifact_router = pathlib.Path(sys.argv[5]).read_text(encoding="utf-8")
artifact_request = pathlib.Path(sys.argv[6]).read_text(encoding="utf-8")
acquisition = pathlib.Path(sys.argv[7]).read_text(encoding="utf-8")
development = pathlib.Path(sys.argv[8]).read_text(encoding="utf-8")
agents = pathlib.Path(sys.argv[9]).read_text(encoding="utf-8")

refs = re.findall(
    r"^\s*uses:\s*([^\s#]+)",
    automatic + "\n" + processor + "\n" + index + "\n" + artifact_request,
    re.MULTILINE,
)
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
assert "cancel-in-progress: true" in automatic
assert "retention-days: 7" in automatic
assert "retention-days: 1" not in automatic
assert "runs-on: ubuntu-24.04" in automatic
assert "timeout-minutes: 5" in automatic

assert re.search(r"^on:\n  create:\n", gate, re.MULTILINE)
assert "permissions: {}" in gate
assert "source-bundle-request/" in gate
assert "^[0-9a-f]{40}$" in gate
assert "uses:" not in gate
assert "runs-on: ubuntu-24.04" in gate
assert "timeout-minutes: 3" in gate

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
assert "\n  validate:\n" not in processor
assert processor.count("\n  bundle:\n") == 1
assert "TOOLING_REF: ${{ github.workflow_sha }}" in processor
assert processor.count("uses: actions/checkout@") == 2
cleanup = processor.split("  cleanup-request:\n", 1)[1]
assert "uses: actions/checkout@" not in cleanup
cleanup_condition = cleanup.split("    needs:", 1)[0]
assert "needs.bundle.outputs.request_validated == 'true'" in cleanup_condition
assert "needs.publish-result.result == 'success'" in cleanup_condition
assert "needs.bundle.result == 'success'" not in cleanup_condition
assert "git init -q \"$cleanup_repo\"" in cleanup
assert "Check out requested source as data" in processor
assert "--event-name source-bundle-request" in processor
assert "artifact_id: ${{ steps.upload.outputs.artifact-id }}" in processor
assert "artifact_url: ${{ steps.upload.outputs.artifact-url }}" in processor
assert "artifact_digest: ${{ steps.upload.outputs.artifact-digest }}" in processor
assert "request_validated: ${{ steps.request.outputs.validated }}" in processor
assert "needs.bundle.outputs.request_validated == 'true'" in processor
assert "statuses: write" in processor
assert "actions: read" in processor
assert "github.rest.repos.createCommitStatus" in processor
assert "github.rest.actions.getArtifact" in processor
assert "github.rest.actions.getWorkflowRun" in processor
assert "/^[0-9a-f]{64}$/.test(artifactDigest)" in processor
assert "/^sha256:[0-9a-f]{64}$/.test(artifactDigest)" not in processor
assert "artifact.digest !== `sha256:${artifactDigest}`" in processor
assert "artifact.name !== `teasescript-source-${sourceSha}`" in processor
assert "producer.path !== '.github/workflows/source-bundle-request-processor.yml'" in processor
assert "artifactUrl !== expectedArtifactUrl" in processor
assert "`artifact ${artifactIdText} sha256:${artifactDigest}`" in processor
assert "context: 'source-bundle/artifact-v1'" in processor
assert "if (!succeeded)" in processor
assert "retention-days: 7" in processor
assert "retention-days: 1" not in processor
artifact_digest = "a" * 64
assert re.fullmatch(r"[0-9a-f]{64}", artifact_digest)
status_description = f"artifact 8758008910 sha256:{artifact_digest}"
status_match = re.fullmatch(r"artifact ([0-9]+) sha256:([0-9a-f]{64})", status_description)
assert status_match and len(status_description) <= 140
assert "needs.publish-result.result == 'success'" in processor
assert processor.count("runs-on: ubuntu-24.04") == 3
assert processor.count("timeout-minutes:") == 3
assert "contents: write" in processor
assert '--force-with-lease="${request_ref}:${EXPECTED_REQUEST_SHA}"' in processor
assert "github.rest.git.deleteRef" not in processor

assert re.search(
    r"^  workflow_run:\n    workflows: \[Source bundle\]\n    types: \[completed\]",
    index,
    re.MULTILINE,
)
assert "permissions: {}" in index
assert "actions: read" in index
assert "statuses: write" in index
assert "contents:" not in index
assert "actions/checkout@" not in index
assert "actions/download-artifact@" not in index
assert "github.rest.actions.listWorkflowRunArtifacts" in index
assert "github.paginate(" not in index
assert "const artifacts = artifactResponse.data.artifacts" in index
assert "Array.isArray(artifacts)" in index
assert "artifact?.name === expectedName" in index
assert "run.pull_requests || []" in index
assert "new Set(matchingPulls.map((pull) => pull.head.sha))" in index
assert "pull.head.sha" in index
assert "run.head_sha" in index
assert "run.path !== '.github/workflows/source-bundle.yml'" in index
assert "run.conclusion !== 'success'" in index
assert "run.repository?.id !== repository.id" in index
assert "artifact.workflow_run?.id !== run.id" in index
assert "artifact.expires_at" in index
assert "context: 'source-bundle/artifact-v1'" in index
assert "state: 'success'" in index
assert "core.setFailed" in index
assert "runs-on: ubuntu-24.04" in index
assert "timeout-minutes: 3" in index

assert re.search(r"^  issue_comment:\n    types: \[created\]", artifact_router, re.MULTILINE)
assert "permissions: {}" in artifact_router
artifact_route = artifact_router.split("  mailbox:\n", 1)[1].split("\n  prepare:\n", 1)[0]
assert "uses: ./.github/workflows/artifact-mailbox-worker.yml" in artifact_route
assert "pull-requests: read" in artifact_route
assert "pull-requests: write" not in artifact_route
assert "author_association" not in artifact_route
assert re.search(r"^  workflow_call:\n", artifact_request, re.MULTILINE)
assert "issue_comment:" not in artifact_request
assert "permissions: {}" in artifact_request
assert "github.event.issue.number == 235" in artifact_request
assert "startsWith(github.event.comment.body, '/artifact source ')" in artifact_request
assert "group: source-bundle-artifact-request" in artifact_request
assert "queue: max" in artifact_request
assert "pull-requests: read" in artifact_request
assert "pull-requests: write" not in artifact_request
assert "cancel-in-progress: false" in artifact_request
job_prefix = artifact_request.split("    runs-on:", 1)[0]
assert "github.event.comment.author_association" in job_prefix
assert "[\"OWNER\",\"MEMBER\",\"COLLABORATOR\"]" in job_prefix
assert job_prefix.index("    if:") < job_prefix.index("    concurrency:")
assert "actions: read" in artifact_request
assert "contents: read" in artifact_request
assert "issues: write" in artifact_request
assert "statuses: write" in artifact_request
assert "contents: write" not in artifact_request
assert "workflows: write" not in artifact_request
assert artifact_request.count("uses: actions/checkout@") == 2
assert "ref: ${{ github.workflow_sha }}" in artifact_request
assert "repository: ${{ steps.resolve.outputs.source_repository }}" in artifact_request
assert "ref: ${{ steps.resolve.outputs.source_sha }}" in artifact_request
production_guard = "steps.resolve.outputs.resolved == 'true' && steps.resolve.outputs.cache_hit == 'false'"
assert artifact_request.count(production_guard) == 5
assert artifact_request.count("persist-credentials: false") == 2
assert "source-bundle-artifact-request.cjs" in artifact_request
assert "request.resolveRequest" in artifact_request
assert "request.completeRequest" in artifact_request
assert "request.reportProductionFailure" in artifact_request
assert "--event-name source-bundle-artifact-request" in artifact_request
assert "retention-days: 7" in artifact_request
assert "steps.finalize.outcome != 'success'" in artifact_request
assert "SOURCE_SHA: ${{ steps.resolve.outputs.source_sha }}" in artifact_request
assert "sourceSha: process.env.SOURCE_SHA" in artifact_request
assert "runs-on: ubuntu-24.04" in artifact_request
assert "timeout-minutes: 8" in artifact_request

assert acquisition.startswith("# Connector-local source acquisition\n")
assert "## Fixed-index lookup first" in acquisition
assert "## Current regeneration route on a confirmed miss" in acquisition
assert "## Temporary compatibility fallback" in acquisition
assert "## Prepare the local checkout" in acquisition
for universal in (development, agents):
    for moving_detail in ("/artifact source ", "source-bundle-request/", "90-second", "#235"):
        assert moving_detail not in universal, (moving_detail, universal[:80])

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
