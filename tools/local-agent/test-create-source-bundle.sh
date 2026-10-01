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
index_workflow="$root/.github/workflows/source-bundle-index.yml"
artifact_router_workflow="$root/.github/workflows/patch-publication.yml"
artifact_request_workflow="$root/.github/workflows/artifact-mailbox-worker.yml"
temp_root=$(mktemp -d)
trap 'rm -rf "$temp_root"' EXIT

fail() {
  echo "test-create-source-bundle: FAIL: $*" >&2
  exit 1
}

python3 - \
  "$workflow" \
  "$index_workflow" \
  "$artifact_router_workflow" \
  "$artifact_request_workflow" <<'PYWORKFLOW'
import pathlib
import re
import sys

automatic = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
index = pathlib.Path(sys.argv[2]).read_text(encoding="utf-8")
artifact_router = pathlib.Path(sys.argv[3]).read_text(encoding="utf-8")
artifact_request = pathlib.Path(sys.argv[4]).read_text(encoding="utf-8")

USES = re.compile(r"^[ \t]*(?:-[ \t]+)?uses[ \t]*:[ \t]*(?P<value>.*)$")


def action_refs(text):
    refs = []
    for line in text.splitlines():
        match = USES.match(line)
        if match:
            value = re.sub(r"[ \t]+#.*$", "", match.group("value")).strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
                value = value[1:-1]
            refs.append(value)
    return refs


def assert_immutable_pins(text):
    refs = action_refs(text)
    assert refs and all(re.fullmatch(r"[^@\s'\"]+@[0-9a-f]{40}", ref) for ref in refs), refs


pin = "d23441a48e516b6c34aea4fa41551a30e30af803"
assert action_refs(f"      - uses: 'actions/checkout@{pin}' # v6\n        uses: \"a/b@{pin}\"") == [
    f"actions/checkout@{pin}",
    f"a/b@{pin}",
]
for mutable in ["      - uses: actions/checkout@v6", '        uses: "actions/checkout@main"']:
    try:
        assert_immutable_pins(f"        uses: actions/checkout@{pin}\n{mutable}\n")
    except AssertionError:
        pass
    else:
        raise AssertionError(f"mutable action ref was accepted: {mutable}")
for workflow_text in (automatic, index, artifact_request):
    assert_immutable_pins(workflow_text)

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


def workflow_steps(text):
    steps = []
    for chunk in re.split(r"(?m)^      - ", text.split("    steps:\n", 1)[1])[1:]:
        fields = {}
        key = None
        for line in ("        " + chunk).splitlines():
            match = re.fullmatch(r"        ([a-z-]+):[ ]?(.*)", line)
            if match:
                key, value = match.groups()
                fields[key] = [value] if value else []
            elif line.strip():
                fields[key].append(line.strip())
        steps.append(fields)
    return steps


def step_condition(step):
    condition = " ".join(line for line in step["if"] if line != ">-").strip()
    condition = re.sub(r"^\$\{\{(.*)\}\}$", r"\1", condition)
    assert "||" not in condition, condition
    return {part.strip() for part in condition.split("&&")}


worker = workflow_steps(artifact_request)


def worker_step(role, predicate):
    matches = [step for step in worker if predicate(step)]
    assert len(matches) == 1, role
    return matches[0]


def uses_action(step, action):
    return step.get("uses", [""])[0].startswith(f"{action}@")


trusted = worker_step(
    "trusted checkout",
    lambda step: uses_action(step, "actions/checkout") and "path: tooling" in step["with"],
)
selected = worker_step(
    "selected checkout",
    lambda step: uses_action(step, "actions/checkout") and "path: source" in step["with"],
)
resolve = worker_step("resolve", lambda step: step.get("id") == ["resolve"])
create = worker_step(
    "bundle creation",
    lambda step: any("create-source-bundle.sh" in line for line in step.get("run", [])),
)
finalize = worker_step("finalize", lambda step: step.get("id") == ["finalize"])
report = worker_step(
    "failure report",
    lambda step: any("reportProductionFailure" in line for line in step.get("with", [])),
)
assert {"ref: ${{ github.workflow_sha }}", "persist-credentials: false"} <= set(trusted["with"])
assert {
    "repository: ${{ steps.resolve.outputs.source_repository }}",
    "ref: ${{ steps.resolve.outputs.source_sha }}",
    "persist-credentials: false",
} <= set(selected["with"])
assert create["run"][:2] == ["|", "cd source"]
assert create["run"][2].startswith("bash ../tooling/tools/local-agent/create-source-bundle.sh ")

# Only trusted tooling checkout and resolution run on a cache hit; every later step is gated.
production_guard = {
    "steps.resolve.outputs.resolved == 'true'",
    "steps.resolve.outputs.cache_hit == 'false'",
}
for step in worker:
    if step is trusted or step is resolve:
        assert "if" not in step, step["name"]
    else:
        assert production_guard <= step_condition(step), step["name"]
assert step_condition(report) == production_guard | {
    "always()",
    "steps.finalize.outcome != 'success'",
}

trusted_module = "require('./tooling/tools/local-agent/source-bundle-artifact-request.cjs');"
for step, call in (
    (resolve, "await request.resolveRequest({ github, context, core });"),
    (finalize, "await request.completeRequest({"),
    (report, "await request.reportProductionFailure({"),
):
    assert f"const request = {trusted_module}" in step["with"] and call in step["with"], step["name"]
for step in worker:
    for line in step.get("env", []):
        name, value = line.split(": ", 1)
        if name == "ISSUE_NUMBER":
            expected = "${{ github.event.issue.number }}"
        elif name.startswith("ARTIFACT_"):
            expected = f"${{{{ steps.upload.outputs.{name.lower().replace('_', '-')} }}}}"
        else:
            expected = f"${{{{ steps.resolve.outputs.{name.lower()} }}}}"
        assert value == expected, line
# Each request call receives exactly the inputs its role requires, specified here independently of
# the workflow, and every input is supplied through a declared environment entry.
request_inputs = {
    "requestCommentId": "REQUEST_COMMENT_ID",
    "requestAuthor": "REQUEST_AUTHOR",
    "requestBodySha256": "REQUEST_BODY_SHA256",
    "issueNumber": "ISSUE_NUMBER",
    "selector": "SELECTOR",
    "sourceSha": "SOURCE_SHA",
}
required_inputs = (
    (
        finalize,
        {
            **request_inputs,
            "selectorType": "SELECTOR_TYPE",
            "sourceRepository": "SOURCE_REPOSITORY",
            "sourceRef": "SOURCE_REF",
            "pullNumber": "PULL_NUMBER",
            "headRepository": "HEAD_REPOSITORY",
            "headRef": "HEAD_REF",
            "baseSha": "BASE_SHA",
            "mergeBaseSha": "MERGE_BASE_SHA",
            "artifactId": "ARTIFACT_ID",
            "artifactUrl": "ARTIFACT_URL",
            "artifactDigest": "ARTIFACT_DIGEST",
        },
    ),
    (report, request_inputs),
)
for step, expected in required_inputs:
    inputs = dict(
        re.fullmatch(r"(\w+): process\.env\.(\w+),", line).groups()
        for line in step["with"]
        if "process.env." in line
    )
    assert inputs == expected, step["name"]
    assert {line.split(":", 1)[0] for line in step["env"]} == set(expected.values()), step["name"]
assert artifact_request.count("persist-credentials: false") == 2
assert "source-bundle-artifact-request.cjs" in artifact_request
assert "request.resolveRequest" in artifact_request
assert "request.completeRequest" in artifact_request
assert "request.reportProductionFailure" in artifact_request
assert "--event-name source-bundle-artifact-request" in artifact_request
assert "SOURCE_SHA: ${{ steps.resolve.outputs.source_sha }}" in artifact_request
assert "sourceSha: process.env.SOURCE_SHA" in artifact_request

PYWORKFLOW

# Run the index workflow's actual github-script body against recorded GitHub/core mocks.
index_script="$temp_root/source-bundle-index.js"
python3 - "$index_workflow" "$index_script" <<'PYEXTRACT'
import pathlib
import sys
import textwrap

text = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
assert text.count("          script: |\n") == 1
lines = []
for line in text.split("          script: |\n", 1)[1].splitlines():
    if line.strip() and not line.startswith("            "):
        break
    lines.append(line)
pathlib.Path(sys.argv[2]).write_text(textwrap.dedent("\n".join(lines)) + "\n", encoding="utf-8")
PYEXTRACT

node - "$index_script" <<'NODE'
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const indexScript = fs.readFileSync(process.argv[2], "utf8");
const publishIndex = new AsyncFunction("github", "context", "core", indexScript);
const REPOSITORY_ID = 1309933950;
const FORK_ID = 22002;
const RUN_ID = 4242;
const ARTIFACT_ID = 77;
const PUSH_SHA = "1".repeat(40);
const PULL_SHA = "2".repeat(40);
const DIGEST = "a".repeat(64);

function pushRun() {
  return {
    id: RUN_ID,
    name: "Source bundle",
    path: ".github/workflows/source-bundle.yml",
    status: "completed",
    conclusion: "success",
    event: "push",
    repository: { id: REPOSITORY_ID },
    head_repository: { id: REPOSITORY_ID },
    head_branch: "main",
    head_sha: PUSH_SHA,
    pull_requests: [],
  };
}

function pullRun() {
  return {
    ...pushRun(),
    event: "pull_request",
    head_repository: { id: FORK_ID },
    head_branch: "feature/source-bundle",
    head_sha: PULL_SHA,
    pull_requests: [
      {
        base: { repo: { id: REPOSITORY_ID } },
        head: { repo: { id: FORK_ID }, ref: "feature/source-bundle", sha: PULL_SHA },
      },
    ],
  };
}

function artifact(sourceSha) {
  return {
    id: ARTIFACT_ID,
    name: `teasescript-source-${sourceSha}`,
    digest: `sha256:${DIGEST}`,
    expired: false,
    expires_at: "2099-01-01T00:00:00Z",
    workflow_run: { id: RUN_ID },
  };
}

async function invoke(run, artifacts) {
  const calls = { listed: [], statuses: [], failures: [] };
  const github = {
    rest: {
      actions: {
        async listWorkflowRunArtifacts(input) {
          calls.listed.push(input);
          return { data: { artifacts } };
        },
      },
      repos: {
        async createCommitStatus(input) {
          calls.statuses.push(input);
          return { data: input };
        },
      },
    },
  };
  const context = {
    payload: { workflow_run: run, repository: { id: REPOSITORY_ID, default_branch: "main" } },
    repo: { owner: "TeaseScript-AI", repo: "teasescript-platform" },
    serverUrl: "https://github.com",
  };
  const core = {
    setFailed(message) {
      calls.failures.push(String(message));
    },
  };
  await publishIndex(github, context, core);
  return calls;
}

(async () => {
  for (const [run, sourceSha] of [
    [pushRun(), PUSH_SHA],
    [pullRun(), PULL_SHA],
  ]) {
    const calls = await invoke(run, [artifact(sourceSha)]);
    assert.deepEqual(calls.failures, []);
    assert.equal(calls.listed.length, 1);
    assert.equal(calls.listed[0].run_id, RUN_ID);
    assert.equal(calls.statuses.length, 1);
    const { description, ...status } = calls.statuses[0];
    assert.deepEqual(status, {
      owner: "TeaseScript-AI",
      repo: "teasescript-platform",
      sha: sourceSha,
      state: "success",
      context: "source-bundle/artifact-v1",
      target_url: `https://github.com/TeaseScript-AI/teasescript-platform/actions/runs/${RUN_ID}/artifacts/${ARTIFACT_ID}`,
    });
    assert.ok(description.includes(`sha256:${DIGEST}`), description);
  }

  const inconsistentPull = pullRun();
  inconsistentPull.pull_requests.push({
    ...inconsistentPull.pull_requests[0],
    head: { ...inconsistentPull.pull_requests[0].head, sha: PUSH_SHA },
  });
  const foreignBasePull = pullRun();
  foreignBasePull.pull_requests[0].base = { repo: { id: FORK_ID } };
  const rejected = [
    ["untrusted producer path", { ...pushRun(), path: ".github/workflows/other.yml" }],
    ["failed producer", { ...pushRun(), conclusion: "failure" }],
    ["foreign producer repository", { ...pushRun(), repository: { id: FORK_ID } }],
    ["push outside default branch", { ...pushRun(), head_branch: "feature/source-bundle" }],
    ["push from fork head", { ...pushRun(), head_repository: { id: FORK_ID } }],
    ["inconsistent pull identities", inconsistentPull],
    ["pull from another base repository", foreignBasePull],
    ["artifact for another SHA", pushRun(), [artifact(PULL_SHA)]],
    ["duplicate artifacts", pushRun(), [artifact(PUSH_SHA), { ...artifact(PUSH_SHA), id: 78 }]],
    ["expired artifact", pushRun(), [{ ...artifact(PUSH_SHA), expired: true }]],
    ["past retention", pushRun(), [{ ...artifact(PUSH_SHA), expires_at: "2020-01-01T00:00:00Z" }]],
    ["missing expiry", pushRun(), [{ ...artifact(PUSH_SHA), expires_at: undefined }]],
    ["malformed digest", pushRun(), [{ ...artifact(PUSH_SHA), digest: `sha256:${"a".repeat(63)}` }]],
    ["foreign artifact run", pushRun(), [{ ...artifact(PUSH_SHA), workflow_run: { id: RUN_ID + 1 } }]],
    ["invalid artifact ID", pushRun(), [{ ...artifact(PUSH_SHA), id: 0 }]],
    ["malformed artifact list", pushRun(), null],
  ];
  for (const [label, run, artifacts = [artifact(run.pull_requests.length ? PULL_SHA : PUSH_SHA)]] of rejected) {
    const calls = await invoke(run, artifacts);
    assert.deepEqual(calls.statuses, [], label);
    assert.equal(calls.failures.length, 1, label);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
NODE

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
