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
  "$artifact_request_workflow" \
  "$root/.github/workflows" <<'PYWORKFLOW'
import pathlib
import re
import sys

automatic = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
index = pathlib.Path(sys.argv[2]).read_text(encoding="utf-8")
artifact_router = pathlib.Path(sys.argv[3]).read_text(encoding="utf-8")
artifact_request = pathlib.Path(sys.argv[4]).read_text(encoding="utf-8")
workflow_directory = pathlib.Path(sys.argv[5])

USES = re.compile(r"^[ \t]*(?:-[ \t]+)?uses[ \t]*:[ \t]*(?P<value>.*)$")
FLOW_MAPPING = re.compile(r"^[ \t]*(?:-[ \t]+)?\{(?P<body>.*)\}[ \t]*(?:#.*)?$")
PINNED_REF = re.compile(r"[^@\s'\"]+@[0-9a-f]{40}")
LOCAL_WORKFLOW_REF = re.compile(r"\./\.github/workflows/[A-Za-z0-9_.-]+\.ya?ml")


def action_refs(text):
    values = []
    for line in text.splitlines():
        match = USES.match(line)
        if match:
            values.append(re.sub(r"[ \t]+#.*$", "", match.group("value")))
        flow = FLOW_MAPPING.match(line)
        if flow:
            values += re.findall(r"(?:^|,)[ \t]*uses[ \t]*:([^,]*)", flow.group("body"))
    refs = []
    for value in values:
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        refs.append(value)
    return refs


def assert_immutable_pins(text):
    refs = action_refs(text)
    for ref in refs:
        assert PINNED_REF.fullmatch(ref) or LOCAL_WORKFLOW_REF.fullmatch(ref), ref
    return refs


JOB_HEADER = r"  ([A-Za-z0-9_-]+):[ \t]*(?:#.*)?"


def workflow_jobs(text):
    section = re.split(r"(?m)^jobs:[ \t]*(?:#.*)?\n", text, maxsplit=1)[1]
    section = re.split(r"(?m)^(?=[^\s#])", section, maxsplit=1)[0]
    # Every two-space line must be a job header, so no job or checkout escapes the checks below.
    for line in section.splitlines():
        if re.match(r"  [^\s#]", line):
            assert re.fullmatch(JOB_HEADER, line), f"unsupported job header: {line}"
    parts = re.split(rf"(?m)^{JOB_HEADER}\n", section)
    return dict(zip(parts[1::2], parts[2::2]))


def grants_contents(text, indent):
    match = re.search(rf"(?m)^{indent}permissions:(.*)\n((?:{indent}  .*\n)*)", text)
    if match is None:
        return None
    # A commented-out entry grants nothing.
    entries = re.sub(r"(?m)#.*$", "", match.group(1) + "\n" + match.group(2))
    return re.search(r"\bcontents:[ \t]*(?:read|write)\b", entries) is not None


def assert_checkout_jobs_read_contents(text):
    # Job permissions replace workflow permissions; without either, the token can read contents.
    workflow_access = grants_contents(text, "")
    for name, job in workflow_jobs(text).items():
        if any(ref.startswith("actions/checkout@") for ref in action_refs(job)):
            access = grants_contents(job, "    ")
            if access is None:
                access = workflow_access is not False
            assert access, f"checkout job {name} cannot read contents"


def rejected(check, text):
    try:
        check(text)
    except AssertionError:
        return True
    return False


pin = "d23441a48e516b6c34aea4fa41551a30e30af803"
assert action_refs(f"      - uses: 'actions/checkout@{pin}' # v6\n        uses: \"a/b@{pin}\"") == [
    f"actions/checkout@{pin}",
    f"a/b@{pin}",
]
assert action_refs(f"      - {{name: Flow, uses: a/b@{pin}, with: {{ref: x}}}}") == [f"a/b@{pin}"]
for mutable in [
    "      - uses: actions/checkout@v6",
    '        uses: "actions/checkout@main"',
    "    uses: example/repository/.github/workflows/reusable.yml@main",
    "      - {uses: actions/checkout@v6}",
]:
    mixed = f"        uses: actions/checkout@{pin}\n{mutable}\n"
    assert rejected(assert_immutable_pins, mixed), mutable
assert_immutable_pins("    uses: ./.github/workflows/reusable.yml\n")


def checkout_workflow(job_permissions, step):
    lines = ["permissions: {}", "jobs:", "  job:", "    runs-on: ubuntu-24.04", *job_permissions]
    return "\n".join([*lines, "    steps:", f"      - {step}", ""])


checkout = f"uses: actions/checkout@{pin}"
read_contents = ["    permissions:", "      contents: read"]
assert_checkout_jobs_read_contents(checkout_workflow(read_contents, checkout))
for job_permissions in (
    [],
    ["    permissions:", "      issues: write"],
    ["    permissions:", "      # contents: read", "      issues: write"],
    ["    permissions: # contents: read", "      issues: write"],
):
    workflow_text = checkout_workflow(job_permissions, checkout)
    assert rejected(assert_checkout_jobs_read_contents, workflow_text), job_permissions
assert_checkout_jobs_read_contents(checkout_workflow([], f"run: echo actions/checkout@{pin}"))
commented_header = checkout_workflow([], checkout).replace("  job:\n", "  job: # main job\n")
assert rejected(assert_checkout_jobs_read_contents, commented_header)
assert rejected(assert_checkout_jobs_read_contents, commented_header.replace("  job:", '  "job":'))

workflow_paths = sorted([*workflow_directory.glob("*.yml"), *workflow_directory.glob("*.yaml")])
assert workflow_paths
workflow_refs = []
for path in workflow_paths:
    workflow_text = path.read_text(encoding="utf-8")
    workflow_refs += assert_immutable_pins(workflow_text)
    assert_checkout_jobs_read_contents(workflow_text)
# Guards the scanner itself: the repository's workflows do use Actions.
assert workflow_refs, "no workflow uses entries were found"

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
assert re.search(r"^  workflow_call:\n", artifact_request, re.MULTILINE)
assert "issue_comment:" not in artifact_request
assert "permissions: {}" in artifact_request
assert "github.event.issue.number == 235" in artifact_request
assert "startsWith(github.event.comment.body, '/artifact source ')" in artifact_request
assert "pull-requests: read" in artifact_request
assert "pull-requests: write" not in artifact_request
# One constant group serializes every request; queueing without cancellation keeps pending requests.
concurrency_lines = re.search(r"(?m)^    concurrency:\n((?:      .*\n)+)", artifact_request).group(1)
concurrency = dict(line.strip().split(": ", 1) for line in concurrency_lines.splitlines())
assert concurrency["group"] and "${{" not in concurrency["group"], concurrency
assert concurrency["queue"] == "max" and concurrency["cancel-in-progress"] == "false", concurrency
job_prefix = artifact_request.split("    runs-on:", 1)[0]
assert "github.event.comment.author_association" in job_prefix
assert "[\"OWNER\",\"MEMBER\",\"COLLABORATOR\"]" in job_prefix
assert "actions: read" in artifact_request
assert "contents: read" in artifact_request
assert "issues: write" in artifact_request
assert "statuses: write" in artifact_request
assert "contents: write" not in artifact_request
assert "workflows: write" not in artifact_request


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


def one_step(steps, role, predicate):
    matches = [step for step in steps if predicate(step)]
    assert len(matches) == 1, role
    return matches[0]


def uses_action(step, action):
    return step.get("uses", [""])[0].startswith(f"{action}@")


trusted = one_step(
    worker,
    "trusted checkout",
    lambda step: uses_action(step, "actions/checkout") and "path: tooling" in step["with"],
)
selected = one_step(
    worker,
    "selected checkout",
    lambda step: uses_action(step, "actions/checkout") and "path: source" in step["with"],
)
resolve = one_step(worker, "resolve", lambda step: step.get("id") == ["resolve"])
create = one_step(
    worker,
    "bundle creation",
    lambda step: any("create-source-bundle.sh" in line for line in step.get("run", [])),
)
finalize = one_step(worker, "finalize", lambda step: step.get("id") == ["finalize"])
report = one_step(
    worker,
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

# The automatic producer bundles the pull-request head on pull_request and the pushed commit on
# push. Its artifact name carries the SHA passed to the producer, which refuses any other HEAD.
producer = workflow_steps(automatic)
job_env_block = re.search(r"(?m)^    env:\n((?:      .*\n)+)", automatic).group(1)
job_env = dict(line.strip().split(": ", 1) for line in job_env_block.splitlines())


def resolved_ref(step):
    ref = next(line.split(": ", 1)[1] for line in step["with"] if line.startswith("ref: "))
    match = re.fullmatch(r"\$\{\{ env\.(\w+) \}\}", ref)
    return job_env[match.group(1)] if match else ref


requested_source = (
    "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}"
)
source_checkout = one_step(
    producer,
    "requested source checkout",
    lambda step: uses_action(step, "actions/checkout") and resolved_ref(step) == requested_source,
)
upload = one_step(producer, "upload", lambda step: uses_action(step, "actions/upload-artifact"))
artifact_name = next(line.split(": ", 1)[1] for line in upload["with"] if line.startswith("name: "))
name_match = re.fullmatch(
    r"teasescript-source-(\$\{\{ steps\.[\w-]+\.outputs\.[\w-]+ \}\})", artifact_name
)
assert name_match, artifact_name
producer_run = one_step(
    producer,
    "producer run",
    lambda step: any("create-source-bundle.sh" in line for line in step.get("run", [])),
)
argument = re.search(r'--source-sha (?:"([^"]+)"|(\S+))', " ".join(producer_run["run"]))
source_sha = argument.group(1) or argument.group(2)
variable = re.fullmatch(r"\$\{?(\w+)\}?", source_sha)
if variable:
    step_env = dict(line.split(": ", 1) for line in producer_run.get("env", []))
    source_sha = {**job_env, **step_env}[variable.group(1)]
assert source_sha == name_match.group(1), (source_sha, artifact_name)
# That SHA is HEAD of the requested checkout, and the producer bundles that same checkout.
source_path = next(line.split(": ", 1)[1] for line in source_checkout["with"] if line.startswith("path: "))
resolver_id = re.fullmatch(r"\$\{\{ steps\.([\w-]+)\.outputs\.[\w-]+ \}\}", source_sha).group(1)
resolver = one_step(producer, "source resolver", lambda step: step.get("id") == [resolver_id])
assert resolver.get("working-directory") == [source_path], resolver["name"]
assert any("git rev-parse --verify HEAD" in line for line in resolver["run"]), resolver["name"]
assert f"cd {source_path}" in producer_run["run"], producer_run["name"]

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

[[ $(git -C "$repo" rev-parse refs/heads/source-bundle) == "$first_sha" ]] || fail "pre-existing temporary ref was not restored"

# The real source-review consumer is the protocol oracle for the producer's manifest and bundle.
consumer_artifact="$temp_root/source-artifact.zip"
python3 - "$output" "$consumer_artifact" <<'PYZIP'
import pathlib
import sys
import zipfile

output, artifact = map(pathlib.Path, sys.argv[1:])
with zipfile.ZipFile(artifact, "w") as archive:
    for name in ("repository.bundle", "manifest.json", "SHA256SUMS"):
        archive.write(output / name, name)
PYZIP
python3 -S -B "$root/tools/chatgpt-project-agent/tools/prepare-source-review.py" \
  --artifact "$consumer_artifact" \
  --artifact-sha256 "$(sha256sum "$consumer_artifact" | awk '{print $1}')" \
  --expected-repository TeaseScript-AI/teasescript-platform \
  --expected-head "$second_sha" \
  --expected-merge-base "$first_sha" \
  --output "$temp_root/review" >/dev/null || fail "source-review consumer rejected the producer artifact"

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
