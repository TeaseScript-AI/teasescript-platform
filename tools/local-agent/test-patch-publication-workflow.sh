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

python3 -B "$root/tools/local-agent/test-prepare-patch-publication.py"

python3 - "$workflow" \
  "$root/tools/local-agent/patch-publication-request.cjs" \
  "$root/tools/local-agent/patch-publication-cleanup-comment.cjs" \
  "$root/tools/local-agent/patch-publication-cleanup-transfer.sh" \
  "$root/tools/local-agent/patch-publication-prepare-steps.sh" \
  "$root/tools/local-agent/patch-publication-summary.sh" <<'PY'
import pathlib, re, subprocess, sys, tempfile, textwrap
workflow_path, request_path, cleanup_path, transfer_path, prepare_path, summary_path = map(pathlib.Path, sys.argv[1:])
text = workflow_path.read_text(encoding="utf-8")
request_text = request_path.read_text(encoding="utf-8")
cleanup_text = cleanup_path.read_text(encoding="utf-8")
transfer_text = transfer_path.read_text(encoding="utf-8")
prepare_text = prepare_path.read_text(encoding="utf-8")
summary_text = summary_path.read_text(encoding="utf-8")
assert len(text.encode("utf-8")) <= 12 * 1024
assert "patch-publication-request.cjs" in text
assert "patch-publication-cleanup-comment.cjs" in text
assert "patch-publication-cleanup-transfer.sh" in text
assert "patch-publication-prepare-steps.sh" in text
assert "patch-publication-summary.sh" in text
assert text.count("ref: ${{ github.workflow_sha }}") >= 6
assert "([0-9a-f]{64})$" in request_text
assert "Patch publication commands must be placed on a pull request." in request_text
assert "github.rest.git.getRef" in request_text
assert "github.rest.repos.getContent" in request_text
assert "context.payload.comment.id" in request_text
assert "expected_transfer_sha" in text
assert "format_version" in text
assert "comment_id: ${{ steps.request.outputs.comment_id }}" in text
assert "Read exact transfer manifest" in text
assert 'actual_transfer_sha="$(git rev-parse refs/remotes/origin/patch-transfer)"' in prepare_text
assert 'sha256sum "$RUNNER_TEMP/manifest.json"' in prepare_text
assert "materialize-patch" in prepare_text
assert "refs/remotes/origin/patch-transfer" in prepare_text
assert "preserved_retry" in transfer_text
assert '[[ "$FORMAT_VERSION" == 2 && "$PUBLISH_RESULT" != success ]]' in transfer_text
assert '--force-with-lease="${transfer_ref}:${EXPECTED_TRANSFER_SHA}"' in transfer_text
assert "preserved_changed" in transfer_text
assert "cleanup-transfer:" in text and "cleanup-comment:" in text
def parse_uses_ref(line, job_name):
    if re.match(r'^(?:      -[ \t]+|        )["\']uses["\'][ \t]*:', line):
        raise AssertionError(
            f"workflow uses keys must be unquoted in job {job_name}: {line.strip()}"
        )
    match = re.fullmatch(
        r"^(?:      -[ \t]+|        )uses[ \t]*:[ \t]*(?P<scalar>.*)",
        line,
    )
    if not match:
        return None

    scalar = match.group("scalar")
    scalar_patterns = [
        r"(?P<ref>[^\s#'\"|>]+)(?:[ \t]+#.*)?",
        r"'(?P<ref>[^']+)'(?:[ \t]+#.*)?",
        r'"(?P<ref>[^"]+)"(?:[ \t]+#.*)?',
    ]
    for pattern in scalar_patterns:
        scalar_match = re.fullmatch(pattern, scalar)
        if scalar_match:
            ref = scalar_match.group("ref")
            assert re.fullmatch(r"[^@\s]+@[0-9a-f]{40}", ref), (
                f"workflow action refs must use one immutable 40-hex pin in job "
                f"{job_name}: {line.strip()}"
            )
            return ref
    raise AssertionError(
        f"unsupported workflow uses scalar in job {job_name}: {line.strip()}"
    )


def assert_checkout_jobs_have_contents_access(workflow_text):
    lines = workflow_text.splitlines()
    jobs_headers = [
        index
        for index, line in enumerate(lines)
        if re.fullmatch(r"jobs:[ \t]*(?:#.*)?", line)
    ]
    assert len(jobs_headers) == 1, "workflow must contain exactly one jobs mapping"
    jobs_start = jobs_headers[0] + 1
    jobs_end = len(lines)
    for index in range(jobs_start, len(lines)):
        line = lines[index]
        if line.strip() and not line[0].isspace() and not line.lstrip().startswith("#"):
            jobs_end = index
            break

    job_headers = []
    job_header_pattern = re.compile(
        r"^  (?P<name>[A-Za-z_][A-Za-z0-9_-]*):[ \t]*(?:#.*)?$"
    )
    for index in range(jobs_start, jobs_end):
        line = lines[index]
        if not line.startswith("  ") or line.startswith("    "):
            continue
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = job_header_pattern.fullmatch(line)
        assert match, (
            "workflow job keys must be unquoted valid GitHub job IDs: "
            f"{line.strip()}"
        )
        job_headers.append((index, match.group("name")))

    assert job_headers, "workflow jobs mapping has no job definitions"
    all_refs = []
    for position, (start, job_name) in enumerate(job_headers):
        end = (
            job_headers[position + 1][0]
            if position + 1 < len(job_headers)
            else jobs_end
        )
        job_lines = lines[start:end]
        refs = [
            ref
            for line in job_lines
            if (ref := parse_uses_ref(line, job_name)) is not None
        ]
        all_refs.extend(refs)
        if not any(ref.rsplit("@", 1)[0].lower() == "actions/checkout" for ref in refs):
            continue

        permission_headers = [
            index
            for index, line in enumerate(job_lines)
            if re.fullmatch(r"    permissions:[ \t]*(?:#.*)?", line)
        ]
        assert len(permission_headers) == 1, (
            f"checkout job {job_name} must have one explicit permissions mapping"
        )
        permissions_start = permission_headers[0] + 1
        permissions_end = len(job_lines)
        for index in range(permissions_start, len(job_lines)):
            line = job_lines[index]
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            indentation = len(line) - len(line.lstrip())
            if indentation <= 4:
                permissions_end = index
                break

        permissions_lines = job_lines[permissions_start:permissions_end]
        contents_entries = [
            line
            for line in permissions_lines
            if re.fullmatch(
                r"      contents:[ \t]*(?:read|write)[ \t]*(?:#.*)?",
                line,
            )
        ]
        assert len(contents_entries) == 1, (
            f"checkout job {job_name} lacks exactly one contents read/write permission"
        )
    return all_refs


def make_checkout_job(uses_lines):
    return "\n".join(
        [
            "jobs:",
            "  cleanup_comment: # trusted cleanup",
            "    runs-on: ubuntu-latest",
            "    permissions:",
            "      issues: write",
            "    steps:",
            *[f"      {line}" for line in uses_lines],
            "",
        ]
    )


def assert_missing_contents_rejected(workflow_text):
    try:
        assert_checkout_jobs_have_contents_access(workflow_text)
    except AssertionError as error:
        assert str(error) == (
            "checkout job cleanup_comment lacks exactly one contents read/write permission"
        )
    else:
        raise AssertionError("checkout job without contents access was not rejected")


def assert_unsupported_uses_rejected(workflow_text, expected_fragment):
    try:
        assert_checkout_jobs_have_contents_access(workflow_text)
    except AssertionError as error:
        assert expected_fragment in str(error)
    else:
        raise AssertionError("unsupported workflow uses syntax was not rejected")


refs = assert_checkout_jobs_have_contents_access(text)
assert refs
checkout_sha = "0" * 40
for uses_lines in [
    [f"- uses: actions/checkout@{checkout_sha}"],
    [f"- uses:  actions/checkout@{checkout_sha}"],
    [f'- uses: "actions/checkout@{checkout_sha}"'],
    [f"- uses: 'actions/checkout@{checkout_sha}'"],
    [f"- uses: Actions/Checkout@{checkout_sha}"],
]:
    assert_missing_contents_rejected(make_checkout_job(uses_lines))

assert_unsupported_uses_rejected(
    make_checkout_job(["- uses: >-", f"    actions/checkout@{checkout_sha}"]),
    "unsupported workflow uses scalar",
)
assert_unsupported_uses_rejected(
    make_checkout_job(["- uses: *checkout"]),
    "workflow action refs must use one immutable 40-hex pin",
)
assert_unsupported_uses_rejected(
    make_checkout_job([f'- "uses": "actions/checkout@{checkout_sha}"']),
    "workflow uses keys must be unquoted",
)
run_text_only_job = make_checkout_job(
    [f"- run: echo actions/checkout@{checkout_sha}"]
)
assert assert_checkout_jobs_have_contents_access(run_text_only_job) == []
multiline_run_text_job = make_checkout_job(
    ["- run: |", f"    uses: actions/checkout@{checkout_sha}"]
)
assert assert_checkout_jobs_have_contents_access(multiline_run_text_job) == []
quoted_checkout_job = make_checkout_job(
    [f"- uses: actions/checkout@{checkout_sha}"]
).replace(
    "cleanup_comment: # trusted cleanup",
    '"cleanup_comment":',
)
try:
    assert_checkout_jobs_have_contents_access(quoted_checkout_job)
except AssertionError as error:
    assert str(error) == (
        'workflow job keys must be unquoted valid GitHub job IDs: "cleanup_comment":'
    )
else:
    raise AssertionError("quoted workflow job key was not rejected")
transfer_cleanup = text.split("  cleanup-transfer:\n", 1)[1].split("  cleanup-comment:\n", 1)[0]
comment_cleanup = text.split("  cleanup-comment:\n", 1)[1]
assert "contents: write" in transfer_cleanup and "issues: write" not in transfer_cleanup
assert "contents: read" in comment_cleanup and "issues: write" in comment_cleanup
assert "pull-requests: write" not in comment_cleanup and "contents: write" not in comment_cleanup
assert "github.rest.issues.getComment" in cleanup_text
assert "github.rest.issues.deleteComment" in cleanup_text
assert "github.rest.issues.createComment" not in request_text + cleanup_text
assert "context.payload.issue.url" in cleanup_text
assert "comment.data.id !== commentId" in cleanup_text
assert "comment.data.body.trim() !== expectedCommand" in cleanup_text
assert "deletion.status !== 204" in cleanup_text
assert "failed_identity" not in cleanup_text
assert "command cleanup:" in summary_text
assert "github.rest.git.deleteRef" not in request_text + cleanup_text
assert 'patch-transfer:.agent-patch-publication/change.patch' not in prepare_text
subprocess.run(["node", "--check", str(request_path)], check=True)
subprocess.run(["node", "--check", str(cleanup_path)], check=True)
subprocess.run(["bash", "-n", str(transfer_path)], check=True)
subprocess.run(["bash", "-n", str(prepare_path)], check=True)
subprocess.run(["bash", "-n", str(summary_path)], check=True)

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
              const context = makeContext();
              if (options.mutateContext) {
                options.mutateContext(context);
              }
              const github = {
                rest: {
                  issues: {
                    getComment: options.getComment || (async () => ({
                      data: {
                        id: commentId,
                        issue_url: issueUrl,
                        body: command,
                      },
                    })),
                    deleteComment: async (args) => {
                      deleteCalls += 1;
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
              return { outputs, failures, warnings, notices, deleteCalls, thrown };
            }

            (async () => {
              let result = await runCase();
              assert.equal(result.outputs.cleanup_status, 'removed');
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
              assert.equal(result.deleteCalls, 0);
              assert.deepEqual(result.failures, []);

              result = await runCase({
                getComment: async () => ({
                  data: { id: commentId, issue_url: issueUrl, body: `${command} edited` },
                }),
              });
              assert.equal(result.outputs.cleanup_status, 'preserved_changed');
              assert.equal(result.deleteCalls, 0);
              assert.equal(result.warnings.length, 1);

              result = await runCase({
                getComment: async () => ({
                  data: { id: commentId, issue_url: `${issueUrl}-other`, body: command },
                }),
              });
              assert.equal(result.outputs.cleanup_status, 'preserved_changed');
              assert.equal(result.deleteCalls, 0);

              result = await runCase({
                mutateContext: (context) => { context.payload.issue.number += 1; },
              });
              assert.equal(result.outputs.cleanup_status, 'failed');
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
              assert.equal(result.deleteCalls, 1);
              assert.deepEqual(result.failures, []);
              assert.equal(result.thrown, null);

              result = await runCase({ deleteComment: async () => ({ status: 202 }) });
              assert.equal(result.outputs.cleanup_status, 'failed');
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
PY

tmp="$(mktemp -d -t patch-publication-workflow-XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
cleanup_script="$root/tools/local-agent/patch-publication-cleanup-transfer.sh"
source_repo="$tmp/source"
remote="$tmp/remote.git"
output="$tmp/publication"
manifest="$tmp/manifest.json"
patch="$tmp/change.patch"

git init -q -b main "$source_repo"
git -C "$source_repo" config user.name 'Test Author'
git -C "$source_repo" config user.email test@example.invalid
printf 'before\n' > "$source_repo/example.txt"
git -C "$source_repo" add example.txt
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
data = {
    "formatVersion": 1,
    "targetBranch": target,
    "expectedBaseSha": base,
    "expectedResultTreeSha": tree,
    "patchSha256": hashlib.sha256(pathlib.Path(patch).read_bytes()).hexdigest(),
    "commitMessage": "candidate",
}
pathlib.Path(out).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY

GIT_AUTHOR_DATE='2000-01-01T00:00:00+00:00' \
GIT_COMMITTER_DATE='2000-01-01T00:00:00+00:00' \
python3 -B "$script" prepare \
  --repository "$source_repo" \
  --manifest "$manifest" \
  --patch "$patch" \
  --transfer-branch "$transfer" \
  --default-branch main \
  --expected-target-branch "$target" \
  --output-directory "$output"

candidate="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["candidateCommitSha"])' "$output/publication.json")"
git init -q --bare "$remote"
git -C "$source_repo" push -q "$remote" \
  "$base:refs/heads/$target" \
  "$base:refs/heads/$transfer"

expected_transfer_sha="$(git --git-dir="$remote" rev-parse "refs/heads/$transfer")"
git clone -q "$remote" "$tmp/publisher"
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

if git -C "$tmp/publisher" push --porcelain origin "$candidate:refs/heads/$target" >/dev/null 2>&1; then
  echo 'candidate push unexpectedly succeeded after target race' >&2
  exit 1
fi
test "$(git --git-dir="$remote" rev-parse "refs/heads/$target")" = "$race"

git --git-dir="$remote" update-ref "refs/heads/$target" "$base" "$race"
git -C "$tmp/publisher" push -q origin "$candidate:refs/heads/$target"
test "$(git --git-dir="$remote" rev-parse "refs/heads/$target")" = "$candidate"

run_cleanup() {
  local format_version="$1"
  local publish_result="$2"
  local output_file="$3"
  : > "$output_file"
  (
    cd "$tmp/publisher"
    GH_TOKEN=test-token \
    GITHUB_REPOSITORY=example/repository \
    RUNNER_TEMP="$tmp" \
    PATCH_PUBLICATION_TEST_REMOTE_URL="$remote" \
    TRANSFER_BRANCH="$transfer" \
    EXPECTED_TRANSFER_SHA="$expected_transfer_sha" \
    FORMAT_VERSION="$format_version" \
    PUBLISH_RESULT="$publish_result" \
    GITHUB_OUTPUT="$output_file" \
      bash "$cleanup_script"
  )
}

# A failed or skipped V2 publication preserves the unchanged exact transfer ref
# so one bad part can be replaced without regenerating the manifest.
retry_output="$tmp/cleanup-retry.out"
run_cleanup 2 failure "$retry_output"
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
run_cleanup 2 failure "$changed_output"
test "$(git --git-dir="$remote" rev-parse "refs/heads/$transfer")" = "$changed_transfer_sha"
grep -qx 'cleanup_status=preserved_changed' "$changed_output"

# Successful V2 publication removes only the exact authorized transfer ref.
git --git-dir="$remote" update-ref "refs/heads/$transfer" \
  "$expected_transfer_sha" "$changed_transfer_sha"
removed_output="$tmp/cleanup-removed.out"
run_cleanup 2 success "$removed_output"
! git --git-dir="$remote" show-ref --verify "refs/heads/$transfer" >/dev/null 2>&1
grep -qx 'cleanup_status=removed' "$removed_output"

echo 'patch-publication workflow checks passed'
