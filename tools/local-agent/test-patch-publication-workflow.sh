#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ ${TEASESCRIPT_COMPACT_TEST_INNER:-0} != 1 ]]; then
  log=$(mktemp -t patch-publication-workflow-XXXXXX.log)
  rm -f "$log"
  exec "$script_dir/run-compact.sh" \
    --label patch-publication-workflow \
    --log "$log" \
    -- env TEASESCRIPT_COMPACT_TEST_INNER=1 bash "$0" "$@"
fi
root="$(cd "$script_dir/../.." && pwd)"
workflow="$root/.github/workflows/patch-publication.yml"
script="$root/tools/local-agent/patch-publication.py"
target='feat/test-target'
transfer='agent-patch-publication/integration-test'

tmp="$(mktemp -d -t patch-publication-workflow-XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
publish_body="$tmp/publish-body.sh"

python3 - "$workflow" \
  "$root/tools/local-agent/patch-publication-request.cjs" \
  "$root/tools/local-agent/patch-publication-cleanup-comment.cjs" \
  "$root/.github/workflows/ci.yml" \
  "$publish_body" <<'PY'
import pathlib, re, subprocess, sys, tempfile, textwrap
workflow_path, request_path, cleanup_path, ci_path, publish_body_path = map(pathlib.Path, sys.argv[1:])
text = workflow_path.read_text(encoding="utf-8")
ci_text = ci_path.read_text(encoding="utf-8")
assert "patch-publication-request.cjs" in text
assert "patch-publication-cleanup-comment.cjs" in text
assert "patch-publication-cleanup-transfer.sh" in text
assert "patch-publication-prepare-steps.sh" in text
assert "patch-publication-validate-candidate.sh" in text
assert "patch-publication-summary.sh" in text
assert "comment_id: ${{ steps.request.outputs.comment_id }}" in text
assert "validation_profile: ${{ steps.prepare.outputs.validation_profile }}" in text
assert "needs.prepare.outputs.request_validated == 'true'" in text
assert "run: bash tools/local-agent/check-local-agent.sh" in ci_text


def workflow_jobs(text):
    parts = re.split(r"(?m)^  ([A-Za-z0-9_-]+):\n", text.split("\njobs:\n", 1)[1])
    return dict(zip(parts[1::2], parts[2::2]))


def job_steps(job):
    steps = []
    for chunk in re.split(r"(?m)^      - ", job.split("    steps:\n", 1)[1])[1:]:
        fields = {}
        key = None
        for line in ("        " + chunk).splitlines():
            match = re.fullmatch(r"        ([a-z-]+):[ ]?(.*)", line)
            if match:
                key, value = match.groups()
                fields[key] = [value] if value else []
            elif line.strip():
                fields[key].append(line[10:] if line.startswith(" " * 10) else line.strip())
        steps.append(fields)
    return steps


def run_body(step):
    lines = step.get("run", [])
    return "\n".join(lines[1:] if lines[:1] == ["|"] else lines)


def mapping(step, field):
    return dict(line.split(": ", 1) for line in step.get(field, []) if not line.startswith(" "))


def step_index(steps, role, predicate):
    matches = [index for index, step in enumerate(steps) if predicate(step)]
    assert len(matches) == 1, role
    return matches[0]


def permissions(job):
    block = re.search(r"(?m)^    permissions:\n((?:      .*\n)+)", job).group(1)
    return dict(line.strip().split(": ", 1) for line in block.splitlines())


jobs = workflow_jobs(text)
steps = {name: job_steps(job) for name, job in jobs.items() if "    steps:\n" in job}

# Every job checks out only the trusted workflow revision and never persists checkout credentials.
checkouts = [
    step for job in steps.values() for step in job
    if step.get("uses", [""])[0].startswith("actions/checkout@")
]
assert checkouts
for step in checkouts:
    checkout_inputs = mapping(step, "with")
    assert checkout_inputs.get("ref") == "${{ github.workflow_sha }}", step["name"]
    assert checkout_inputs.get("persist-credentials") == "false", step["name"]

assert {"issues": "read", "pull-requests": "read"}.items() <= permissions(jobs["prepare"]).items()
assert "request_validated: ${{ steps.bind.outputs.validated }}" in jobs["prepare"]
prepare = steps["prepare"]
# The command is validated before any driver reads the transfer, and every driver call uses the
# trusted copy preserved before the first call; the only other driver mention is that preservation.
driver_call = re.compile(r'bash "\$RUNNER_TEMP/patch-publication-prepare-steps\.sh" ([a-z-]+)')
driver_steps = [
    (index, run_body(step)) for index, step in enumerate(prepare)
    if "patch-publication-prepare-steps.sh" in run_body(step)
]
driver_calls = {
    driver_call.fullmatch(body).group(1): index
    for index, body in driver_steps if driver_call.fullmatch(body)
}
preservation = [(index, body) for index, body in driver_steps if not driver_call.fullmatch(body)]
assert len(preservation) == 1, preservation
preserve_index, preserve_body = preservation[0]
assert '"$RUNNER_TEMP/patch-publication.py"' in preserve_body
assert '"$RUNNER_TEMP/patch-publication-prepare-steps.sh"' in preserve_body
assert driver_calls and preserve_index < min(driver_calls.values())
request_index = step_index(prepare, "request validation", lambda step: step.get("id") == ["request"])
assert request_index < driver_calls["read-manifest"]

test_job = jobs["test"]
validator_index = step_index(
    steps["test"],
    "validator preservation",
    lambda step: "tools/local-agent/patch-publication-validate-candidate.sh" in run_body(step),
)
identity_index = step_index(
    steps["test"],
    "candidate identity verification",
    lambda step: run_body(step) == 'bash "$RUNNER_TEMP/validate-candidate" verify-identity',
)
assert validator_index < identity_index
assert "needs.prepare.outputs.validation_profile != 'docs'" in test_job
assert 'bash "$RUNNER_TEMP/validate-candidate" validate-profile "${{ needs.prepare.outputs.validation_profile }}"' in test_job

publish_job = jobs["publish"]
publish = steps["publish"]
assert permissions(publish_job) == {"contents": "read"}
verify_index = step_index(publish, "candidate verification", lambda step: step.get("id") == ["verify"])
token_index = step_index(
    publish, "token creation", lambda step: step.get("id") == ["patch-publisher-token"]
)
push_index = step_index(publish, "publication push", lambda step: "git push" in run_body(step))
assert verify_index < token_index < push_index
assert '--expected-validation-profile "$VALIDATION_PROFILE"' in run_body(publish[verify_index])

token_step = publish[token_index]
assert re.fullmatch(
    r"actions/create-github-app-token@[0-9a-f]{40}(?: +#.*)?", token_step["uses"][0]
)
assert sorted(token_step["with"]) == [
    "client-id: ${{ vars.PATCH_PUBLISHER_CLIENT_ID }}",
    "permission-contents: write",
    "permission-workflows: write",
    "private-key: ${{ secrets.PATCH_PUBLISHER_PRIVATE_KEY }}",
]

push_step = publish[push_index]
assert mapping(push_step, "env")["PATCH_PUBLISHER_TOKEN"] == "${{ steps.patch-publisher-token.outputs.token }}"
assert (
    '"https://x-access-token:${PATCH_PUBLISHER_TOKEN}'
    '@github.com/${GITHUB_REPOSITORY}.git"'
) in run_body(push_step)
publish_body_path.write_text(run_body(push_step) + "\n", encoding="utf-8")

assert text.count("${{ vars.PATCH_PUBLISHER_CLIENT_ID }}") == 1
assert text.count("${{ secrets.PATCH_PUBLISHER_PRIVATE_KEY }}") == 1
assert text.count("${{ steps.patch-publisher-token.outputs.token }}") == 1
for forbidden in ["${{ github.token }}", "secrets.GITHUB_TOKEN", "GITHUB_TOKEN:"]:
    assert forbidden not in publish_job

transfer_cleanup = jobs["cleanup-transfer"]
comment_cleanup = jobs["cleanup-comment"]
assert "contents: write" in transfer_cleanup and "issues: write" not in transfer_cleanup
assert "contents: read" in comment_cleanup
assert "pull-requests: write" in comment_cleanup
assert "issues: write" not in comment_cleanup and "contents: write" not in comment_cleanup

with tempfile.TemporaryDirectory() as temporary:
    temporary_path = pathlib.Path(temporary)
    cleanup_test = temporary_path / "test-cleanup-comment.cjs"
    cleanup_test.write_text(
        textwrap.dedent(
            r'''
            const assert = require('node:assert/strict');
            const cleanup = require(process.argv[2]);

            const commentId = 5135720427;
            const issueNumber = 154;
            const transferBranch = 'agent-patch-publication/154-delaytest';
            const manifestSha = 'a'.repeat(64);
            const command = `/publish-patch ${transferBranch} ${manifestSha}`;
            const issueUrl = 'https://api.github.test/repos/example/repository/issues/154';

            function makeContext() {
              return {
                repo: { owner: 'example', repo: 'repository' },
                payload: {
                  issue: {
                    number: issueNumber,
                    url: issueUrl,
                    pull_request: {},
                  },
                  comment: {
                    id: commentId,
                    body: command,
                  },
                },
              };
            }

            async function runCase(options = {}) {
              const outputs = {};
              const failures = [];
              const warnings = [];
              const notices = [];
              let deleteCalls = 0;
              const getArgs = [];
              const deleteArgs = [];
              const context = makeContext();
              if (options.mutateContext) {
                options.mutateContext(context);
              }
              const github = {
                rest: {
                  issues: {
                    getComment: async (args) => {
                      getArgs.push(args);
                      if (options.getComment) {
                        return options.getComment(args);
                      }
                      return { data: { id: commentId, issue_url: issueUrl, body: command } };
                    },
                    deleteComment: async (args) => {
                      deleteCalls += 1;
                      deleteArgs.push(args);
                      if (options.deleteComment) {
                        return options.deleteComment(args);
                      }
                      return { status: 204 };
                    },
                  },
                },
              };
              const core = {
                setOutput: (name, value) => { outputs[name] = value; },
                setFailed: (message) => { failures.push(message); },
                warning: (message) => { warnings.push(message); },
                notice: (message) => { notices.push(message); },
              };
              const processMock = {
                env: {
                  COMMENT_ID: String(commentId),
                  ISSUE_NUMBER: String(issueNumber),
                  TRANSFER_BRANCH: transferBranch,
                  EXPECTED_MANIFEST_SHA256: manifestSha,
                },
              };
              let thrown = null;
              try {
                await cleanup({ github, context, core, process: processMock });
              } catch (error) {
                thrown = error;
              }
              const exactComment = { owner: 'example', repo: 'repository', comment_id: commentId };
              for (const args of [...getArgs, ...deleteArgs]) {
                assert.deepEqual(args, exactComment);
              }
              const getCalls = getArgs.length;
              return { outputs, failures, warnings, notices, getCalls, deleteCalls, thrown };
            }

            (async () => {
              let result = await runCase();
              assert.equal(result.outputs.cleanup_status, 'removed');
              assert.equal(result.getCalls, 1);
              assert.equal(result.deleteCalls, 1);
              assert.deepEqual(result.failures, []);
              assert.equal(result.thrown, null);

              result = await runCase({
                getComment: async () => {
                  const error = new Error('missing');
                  error.status = 404;
                  throw error;
                },
              });
              assert.equal(result.outputs.cleanup_status, 'already_absent');
              assert.equal(result.getCalls, 1);
              assert.equal(result.deleteCalls, 0);
              assert.deepEqual(result.failures, []);

              result = await runCase({
                getComment: async () => ({
                  data: { id: commentId, issue_url: issueUrl, body: `${command} edited` },
                }),
              });
              assert.equal(result.outputs.cleanup_status, 'preserved_changed');
              assert.equal(result.getCalls, 1);
              assert.equal(result.deleteCalls, 0);
              assert.equal(result.warnings.length, 1);

              result = await runCase({
                getComment: async () => ({
                  data: { id: commentId, issue_url: `${issueUrl}-other`, body: command },
                }),
              });
              assert.equal(result.outputs.cleanup_status, 'preserved_changed');
              assert.equal(result.getCalls, 1);
              assert.equal(result.deleteCalls, 0);

              result = await runCase({
                getComment: async () => ({
                  data: { id: commentId + 1, issue_url: issueUrl, body: command },
                }),
              });
              assert.equal(result.outputs.cleanup_status, 'preserved_changed');
              assert.equal(result.getCalls, 1);
              assert.equal(result.deleteCalls, 0);

              result = await runCase({
                mutateContext: (context) => { context.payload.issue.number += 1; },
              });
              assert.equal(result.outputs.cleanup_status, 'failed');
              assert.equal(result.getCalls, 0);
              assert.equal(result.deleteCalls, 0);
              assert.equal(result.failures.length, 1);

              result = await runCase({
                deleteComment: async () => {
                  const error = new Error('missing during delete');
                  error.status = 404;
                  throw error;
                },
              });
              assert.equal(result.outputs.cleanup_status, 'already_absent');
              assert.equal(result.getCalls, 1);
              assert.equal(result.deleteCalls, 1);
              assert.deepEqual(result.failures, []);
              assert.equal(result.thrown, null);

              result = await runCase({ deleteComment: async () => ({ status: 202 }) });
              assert.equal(result.outputs.cleanup_status, 'failed');
              assert.equal(result.getCalls, 1);
              assert.equal(result.deleteCalls, 1);
              assert.equal(result.failures.length, 1);

              result = await runCase({
                getComment: async () => {
                  const error = new Error('server error');
                  error.status = 500;
                  throw error;
                },
              });
              assert.equal(result.outputs.cleanup_status, 'failed');
              assert.equal(result.getCalls, 1);
              assert.equal(result.deleteCalls, 0);
              assert.equal(result.thrown?.message, 'server error');

              result = await runCase({
                deleteComment: async () => {
                  const error = new Error('delete server error');
                  error.status = 500;
                  throw error;
                },
              });
              assert.equal(result.outputs.cleanup_status, 'failed');
              assert.equal(result.getCalls, 1);
              assert.equal(result.deleteCalls, 1);
              assert.equal(result.thrown?.message, 'delete server error');
            })().catch((error) => {
              console.error(error);
              process.exitCode = 1;
            });
            '''
        ).lstrip(),
        encoding="utf-8",
    )
    subprocess.run(["node", str(cleanup_test), str(cleanup_path)], check=True)

    request_test = temporary_path / "test-request.cjs"
    request_test.write_text(
        textwrap.dedent(
            r'''
            const assert = require('node:assert/strict');
            const crypto = require('node:crypto');
            const publicationRequest = require(process.argv[2]);

            const commentId = 5135720427;
            const issueNumber = 154;
            const transferBranch = 'agent-patch-publication/154-delaytest';
            const transferSha = 'b'.repeat(40);
            const validManifest = Buffer.from('{"formatVersion": 2}\n');
            const repository = { owner: 'example', repo: 'repository' };
            const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

            async function runCase(options = {}) {
              const manifest = options.manifest || validManifest;
              const calls = [];
              const outputs = {};
              const failures = [];
              const context = {
                actor: 'maintainer',
                repo: repository,
                issue: { ...repository, number: issueNumber },
                payload: {
                  repository: { full_name: 'example/repository' },
                  issue: { number: issueNumber, pull_request: options.ordinaryIssue ? undefined : {} },
                  comment: {
                    id: commentId,
                    body: options.body || `/publish-patch ${transferBranch} ${digest(manifest)}`,
                  },
                },
              };
              const github = {
                rest: {
                  repos: {
                    getCollaboratorPermissionLevel: async (args) => {
                      calls.push(['permission', args]);
                      return { data: { permission: options.permission || 'write' } };
                    },
                    getContent: async (args) => {
                      calls.push(['manifest', args]);
                      return {
                        data: { type: 'file', encoding: 'base64', content: manifest.toString('base64') },
                      };
                    },
                  },
                  pulls: {
                    get: async (args) => {
                      calls.push(['pull', args]);
                      const headRepository = options.headRepository || 'example/repository';
                      return { data: { head: { ref: 'feat/test-target', repo: { full_name: headRepository } } } };
                    },
                  },
                  git: {
                    getRef: async (args) => {
                      calls.push(['transfer', args]);
                      return { data: { object: { type: options.transferType || 'commit', sha: transferSha } } };
                    },
                  },
                },
              };
              const core = {
                setOutput: (name, value) => { outputs[name] = value; },
                setFailed: (message) => { failures.push(message); },
              };
              await publicationRequest({ github, context, core });
              return { outputs, failures, calls: Object.fromEntries(calls) };
            }

            (async () => {
              const accepted = await runCase();
              assert.deepEqual(accepted.failures, []);
              assert.deepEqual(accepted.outputs, {
                transfer_branch: transferBranch,
                expected_transfer_sha: transferSha,
                expected_manifest_sha256: digest(validManifest),
                expected_target_branch: 'feat/test-target',
                issue_number: String(issueNumber),
                comment_id: String(commentId),
              });
              assert.deepEqual(accepted.calls, {
                permission: { ...repository, username: 'maintainer' },
                pull: { ...repository, pull_number: issueNumber },
                transfer: { ...repository, ref: `heads/${transferBranch}` },
                manifest: { ...repository, path: '.agent-patch-publication/manifest.json', ref: transferSha },
              });

              const manifestSha = digest(validManifest);
              const beforeTransfer = ['transfer', 'manifest'];
              for (const [label, options, unread] of [
                ['ordinary issue', { ordinaryIssue: true }, beforeTransfer],
                ['malformed command', { body: `/publish-patch ${transferBranch}` }, beforeTransfer],
                ['malformed branch', { body: `/publish-patch agent-patch-publication/../main ${manifestSha}` }, beforeTransfer],
                ['foreign branch namespace', { body: `/publish-patch feat/other ${manifestSha}` }, beforeTransfer],
                ['insufficient permission', { permission: 'read' }, beforeTransfer],
                ['foreign pull-request head', { headRepository: 'fork/repository' }, beforeTransfer],
                ['non-commit transfer', { transferType: 'tag' }, ['manifest']],
                ['wrong manifest digest', { body: `/publish-patch ${transferBranch} ${'c'.repeat(64)}` }, []],
                ['old manifest format', { manifest: Buffer.from('{"formatVersion": 1}\n') }, []],
                ['non-integer manifest format', { manifest: Buffer.from('{"formatVersion": "2"}\n') }, []],
              ]) {
                const result = await runCase(options);
                assert.equal(result.failures.length, 1, label);
                assert.deepEqual(result.outputs, {}, label);
                for (const call of unread) {
                  assert.equal(result.calls[call], undefined, `${label}: ${call}`);
                }
              }
            })().catch((error) => {
              console.error(error);
              process.exitCode = 1;
            });
            '''
        ).lstrip(),
        encoding="utf-8",
    )
    subprocess.run(["node", str(request_test), str(request_path)], check=True)
PY

cleanup_script="$root/tools/local-agent/patch-publication-cleanup-transfer.sh"
prepare_script="$root/tools/local-agent/patch-publication-prepare-steps.sh"
source_repo="$tmp/source"
remote="$tmp/remote.git"
output="$tmp/publication"
manifest="$tmp/manifest.json"
patch="$tmp/change.patch"
prepare_output="$tmp/prepare-output"
untrusted_marker="$tmp/untrusted-prepare-driver-ran"

git init -q -b main "$source_repo"
git -C "$source_repo" config user.name 'Test Author'
git -C "$source_repo" config user.email test@example.invalid
mkdir -p "$source_repo/tools/local-agent"
cat > "$source_repo/tools/local-agent/patch-publication-prepare-steps.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
touch "$UNTRUSTED_MARKER"
printf 'validation_profile=docs\n' >> "$GITHUB_OUTPUT"
SH
chmod +x "$source_repo/tools/local-agent/patch-publication-prepare-steps.sh"
printf 'before\n' > "$source_repo/example.txt"
git -C "$source_repo" add example.txt tools/local-agent/patch-publication-prepare-steps.sh
git -C "$source_repo" commit -q -m base
base="$(git -C "$source_repo" rev-parse HEAD)"
git -C "$source_repo" branch "$target"
printf 'after\n' > "$source_repo/example.txt"
git -C "$source_repo" add example.txt
git -C "$source_repo" commit -q -m candidate
local_commit="$(git -C "$source_repo" rev-parse HEAD)"
tree="$(git -C "$source_repo" show -s --format=%T "$local_commit")"
git -C "$source_repo" diff --binary --full-index --no-renames "$base" "$local_commit" > "$patch"
git -C "$source_repo" reset -q --hard "$base"

python3 - "$manifest" "$target" "$base" "$tree" "$patch" <<'PY'
import hashlib, json, pathlib, sys
out, target, base, tree, patch = sys.argv[1:]
patch_path = pathlib.Path(patch)
patch_bytes = patch_path.read_bytes()
part_path = ".agent-patch-publication/parts/change.patch.part-0001-of-0001"
data = {
    "formatVersion": 2,
    "targetBranch": target,
    "expectedBaseSha": base,
    "expectedResultTreeSha": tree,
    "patchSizeBytes": len(patch_bytes),
    "patchSha256": hashlib.sha256(patch_bytes).hexdigest(),
    "parts": [{
        "path": part_path,
        "sizeBytes": len(patch_bytes),
        "sha256": hashlib.sha256(patch_bytes).hexdigest(),
    }],
    "commitMessage": "candidate",
}
pathlib.Path(out).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY

git -C "$source_repo" switch -q -c "$transfer"
mkdir -p "$source_repo/.agent-patch-publication/parts"
cp "$patch" "$source_repo/.agent-patch-publication/parts/change.patch.part-0001-of-0001"
cp "$manifest" "$source_repo/.agent-patch-publication/manifest.json"
git -C "$source_repo" add .agent-patch-publication
git -C "$source_repo" commit -q -m 'transfer payload'
expected_transfer_sha="$(git -C "$source_repo" rev-parse HEAD)"
expected_manifest_sha256="$(sha256sum "$manifest" | awk '{print $1}')"

git init -q --bare "$remote"
git --git-dir="$remote" symbolic-ref HEAD refs/heads/main
git -C "$source_repo" push -q "$remote" \
  "$base:refs/heads/main" \
  "$base:refs/heads/$target" \
  "$expected_transfer_sha:refs/heads/$transfer"
rm -f "$manifest" "$patch"

git clone -q "$remote" "$tmp/publisher"
install -m 0755 "$script" "$tmp/patch-publication.py"
install -m 0755 "$prepare_script" "$tmp/patch-publication-prepare-steps.sh"
: > "$prepare_output"
(
  cd "$tmp/publisher"
  RUNNER_TEMP="$tmp" \
  GITHUB_WORKSPACE="$tmp/publisher" \
  GITHUB_OUTPUT="$prepare_output" \
  UNTRUSTED_MARKER="$untrusted_marker" \
  TRANSFER_BRANCH="$transfer" \
  EXPECTED_TRANSFER_SHA="$expected_transfer_sha" \
  EXPECTED_MANIFEST_SHA256="$expected_manifest_sha256" \
  EXPECTED_TARGET_BRANCH="$target" \
  DEFAULT_BRANCH=main \
    bash "$tmp/patch-publication-prepare-steps.sh" read-manifest
  RUNNER_TEMP="$tmp" EXPECTED_MANIFEST_SHA256="$expected_manifest_sha256" \
    bash "$tmp/patch-publication-prepare-steps.sh" verify-manifest
  RUNNER_TEMP="$tmp" GITHUB_WORKSPACE="$tmp/publisher" GITHUB_OUTPUT="$prepare_output" \
    EXPECTED_TARGET_BRANCH="$target" DEFAULT_BRANCH=main \
    bash "$tmp/patch-publication-prepare-steps.sh" materialize
  RUNNER_TEMP="$tmp" GITHUB_WORKSPACE="$tmp/publisher" GITHUB_OUTPUT="$prepare_output" \
    TRANSFER_BRANCH="$transfer" EXPECTED_TARGET_BRANCH="$target" DEFAULT_BRANCH=main \
    bash "$tmp/patch-publication-prepare-steps.sh" inspect
  RUNNER_TEMP="$tmp" TARGET_BRANCH="$target" EXPECTED_BASE_SHA="$base" \
    bash "$tmp/patch-publication-prepare-steps.sh" checkout-base
  RUNNER_TEMP="$tmp" GITHUB_WORKSPACE="$tmp/publisher" GITHUB_OUTPUT="$prepare_output" \
    TRANSFER_BRANCH="$transfer" EXPECTED_TARGET_BRANCH="$target" DEFAULT_BRANCH=main \
    bash "$tmp/patch-publication-prepare-steps.sh" prepare
)
test ! -e "$untrusted_marker"
grep -qx 'validation_profile=full' "$prepare_output"
! grep -qx 'validation_profile=docs' "$prepare_output" || {
  echo 'full-profile preparation also reported the docs validation profile' >&2
  exit 1
}
python3 - "$output/publication.json" <<'PY'
import json, pathlib, sys
metadata = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
assert metadata["validationProfile"] == "full"
PY

# Run the trusted driver steps in workflow order; each case differs in one authorized identity.
run_prepare_case() {
  local name="$1" case_remote="$2" transfer_sha="$3" manifest_sha="$4"
  case_temp="$tmp/prepare-$name"
  mkdir -p "$case_temp"
  git clone -q "$case_remote" "$case_temp/workspace"
  install -m 0755 "$script" "$case_temp/patch-publication.py"
  install -m 0755 "$prepare_script" "$case_temp/patch-publication-prepare-steps.sh"
  : > "$case_temp/output"
  failed_step=
  for step in read-manifest verify-manifest materialize inspect checkout-base prepare; do
    if ! (
      cd "$case_temp/workspace"
      RUNNER_TEMP="$case_temp" GITHUB_WORKSPACE="$case_temp/workspace" GITHUB_OUTPUT="$case_temp/output" \
        TRANSFER_BRANCH="$transfer" EXPECTED_TRANSFER_SHA="$transfer_sha" \
        EXPECTED_MANIFEST_SHA256="$manifest_sha" EXPECTED_TARGET_BRANCH="$target" DEFAULT_BRANCH=main \
        TARGET_BRANCH="$target" EXPECTED_BASE_SHA="$base" \
        bash "$case_temp/patch-publication-prepare-steps.sh" "$step"
    ) >/dev/null 2>&1; then
      failed_step="$step"
      break
    fi
  done
}

moved_remote="$tmp/moved-transfer-remote.git"
git clone -q --bare "$remote" "$moved_remote"
moved_transfer_sha="$(git -C "$source_repo" commit-tree "$expected_transfer_sha^{tree}" \
  -p "$expected_transfer_sha" -m 'moved transfer')"
git -C "$source_repo" push -q "$moved_remote" "$moved_transfer_sha:refs/heads/$transfer"
run_prepare_case moved-transfer "$moved_remote" "$expected_transfer_sha" "$expected_manifest_sha256"
[[ $failed_step == read-manifest && ! -e "$case_temp/change.patch" && ! -e "$case_temp/publication" &&
  "$(git --git-dir="$moved_remote" rev-parse "refs/heads/$target")" == "$base" ]] || {
  echo 'moved transfer ref was not rejected before materialization' >&2
  exit 1
}

changed_manifest_sha256="$(
  { git -C "$source_repo" show "$expected_transfer_sha:.agent-patch-publication/manifest.json"; echo; } |
    sha256sum | awk '{print $1}'
)"
run_prepare_case changed-manifest "$remote" "$expected_transfer_sha" "$changed_manifest_sha256"
[[ $failed_step == verify-manifest && ! -e "$case_temp/change.patch" && ! -e "$case_temp/publication" &&
  "$(git --git-dir="$remote" rev-parse "refs/heads/$target")" == "$base" ]] || {
  echo 'changed manifest digest was not rejected before materialization' >&2
  exit 1
}

candidate="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["candidateCommitSha"])' "$output/publication.json")"
python3 -B "$script" verify-bundle \
  --repository "$tmp/publisher" \
  --metadata "$output/publication.json" \
  --bundle "$output/publication.bundle"
git -C "$tmp/publisher" fetch -q --no-tags "$output/publication.bundle" \
  refs/heads/patch-publication-candidate:refs/heads/candidate

git clone -q "$remote" "$tmp/racer"
git -C "$tmp/racer" config user.name 'Race Writer'
git -C "$tmp/racer" config user.email race@example.invalid
git -C "$tmp/racer" checkout -q "$target"
printf 'moved\n' > "$tmp/racer/race.txt"
git -C "$tmp/racer" add race.txt
git -C "$tmp/racer" commit -q -m 'move target'
race="$(git -C "$tmp/racer" rev-parse HEAD)"
git -C "$tmp/racer" push -q origin "$target"

# Run the publish step's actual run body, extracted by the static checks above; a fixture-only Git
# wrapper routes its authenticated GitHub URL to the bare remote and passes every other argument through.
publish_url='https://x-access-token:test-token@github.com/example/repository.git'
publish_calls="$tmp/publish-calls"
mkdir -p "$tmp/publish-bin"
cat > "$tmp/publish-bin/git" <<WRAPPER
#!/usr/bin/env bash
printf '%s\\n' "\$*" >> $(printf '%q' "$publish_calls")
args=()
for arg in "\$@"; do
  if [[ \$arg == $(printf '%q' "$publish_url") ]]; then
    args+=($(printf '%q' "$remote"))
  else
    args+=("\$arg")
  fi
done
exec $(printf '%q' "$(command -v git)") "\${args[@]}"
WRAPPER
chmod +x "$tmp/publish-bin/git"
run_publish() {
  (
    cd "$tmp/publisher"
    PATH="$tmp/publish-bin:$PATH" TARGET_BRANCH="$target" CANDIDATE_COMMIT_SHA="$candidate" \
      PATCH_PUBLISHER_TOKEN=test-token GITHUB_REPOSITORY=example/repository \
      bash --noprofile --norc -eo pipefail "$publish_body"
  ) >/dev/null 2>&1
}

if run_publish; then
  echo 'workflow publication unexpectedly succeeded after target race' >&2
  exit 1
fi
test "$(git --git-dir="$remote" rev-parse "refs/heads/$target")" = "$race"

git --git-dir="$remote" update-ref "refs/heads/$target" "$base" "$race"
run_publish
test "$(git --git-dir="$remote" rev-parse "refs/heads/$target")" = "$candidate"
grep -F -- "$publish_url $candidate:refs/heads/$target" "$publish_calls" >/dev/null

run_cleanup() {
  local publish_result="$1"
  local output_file="$2"
  : > "$output_file"
  (
    cd "$tmp/publisher"
    GH_TOKEN=test-token \
    GITHUB_REPOSITORY=example/repository \
    RUNNER_TEMP="$tmp" \
    PATCH_PUBLICATION_TEST_REMOTE_URL="$remote" \
    TRANSFER_BRANCH="$transfer" \
    EXPECTED_TRANSFER_SHA="$expected_transfer_sha" \
    PUBLISH_RESULT="$publish_result" \
    GITHUB_OUTPUT="$output_file" \
      bash "$cleanup_script"
  )
}

# A failed or skipped V2 publication preserves the unchanged exact transfer ref
# so one bad part can be replaced without regenerating the manifest.
retry_output="$tmp/cleanup-retry.out"
run_cleanup failure "$retry_output"
test "$(git --git-dir="$remote" rev-parse "refs/heads/$transfer")" = "$expected_transfer_sha"
grep -qx 'cleanup_status=preserved_retry' "$retry_output"

# A transfer ref that moved after authorization is preserved and reported as changed.
git -C "$tmp/racer" checkout -q -B transfer-update "origin/$transfer"
printf 'new transfer payload\n' > "$tmp/racer/transfer.txt"
git -C "$tmp/racer" add transfer.txt
git -C "$tmp/racer" commit -q -m 'replace transfer payload'
changed_transfer_sha="$(git -C "$tmp/racer" rev-parse HEAD)"
git -C "$tmp/racer" push -q origin "HEAD:refs/heads/$transfer"
changed_output="$tmp/cleanup-changed.out"
for publish_result in failure success; do
  run_cleanup "$publish_result" "$changed_output"
  test "$(git --git-dir="$remote" rev-parse "refs/heads/$transfer")" = "$changed_transfer_sha"
  grep -qx 'cleanup_status=preserved_changed' "$changed_output"
done

# Successful V2 publication removes only the exact authorized transfer ref.
git --git-dir="$remote" update-ref "refs/heads/$transfer" \
  "$expected_transfer_sha" "$changed_transfer_sha"
removed_output="$tmp/cleanup-removed.out"
run_cleanup success "$removed_output"
! git --git-dir="$remote" show-ref --verify "refs/heads/$transfer" >/dev/null 2>&1 || {
  echo 'successful cleanup did not remove the authorized transfer ref' >&2
  exit 1
}
grep -qx 'cleanup_status=removed' "$removed_output"

# The summary reports each supplied result under its own field and reports missing cleanup as failed.
summary_script="$root/tools/local-agent/patch-publication-summary.sh"
summary="$tmp/summary.md"
published_sha="$(printf 'c%.0s' {1..40})"
GITHUB_STEP_SUMMARY="$summary" TARGET_BRANCH=feat/summary-target PUBLISHED_COMMIT_SHA="$published_sha" \
  PREPARE_RESULT=success TEST_RESULT=failure PUBLISH_RESULT=skipped \
  TRANSFER_CLEANUP_STATUS=preserved_retry COMMENT_CLEANUP_STATUS=already_absent \
  bash "$summary_script"
for field in "target branch=feat/summary-target" "published commit=$published_sha" \
  prepare=success test=failure publish=skipped \
  "transfer cleanup=preserved_retry" "command cleanup=already_absent"; do
  grep -E -- "(^|[^[:alnum:]])${field%%=*}[^[:alnum:]]" "$summary" | grep -F -- "${field#*=}" >/dev/null || {
    echo "publication summary did not report ${field#*=} as its ${field%%=*}" >&2
    exit 1
  }
done
: > "$summary"
GITHUB_STEP_SUMMARY="$summary" TARGET_BRANCH=feat/summary-target \
  PREPARE_RESULT=success TEST_RESULT=success PUBLISH_RESULT=skipped \
  bash "$summary_script"
[[ $(grep -c -w failed "$summary") == 2 ]] && ! grep -Eq '[0-9a-f]{40}' "$summary" || {
  echo 'publication summary did not report missing cleanup statuses as failed' >&2
  exit 1
}

echo 'patch-publication workflow checks passed'
