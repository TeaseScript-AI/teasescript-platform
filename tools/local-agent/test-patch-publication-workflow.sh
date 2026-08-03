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

python3 - "$workflow" \
  "$root/tools/local-agent/patch-publication-request.cjs" \
  "$root/tools/local-agent/patch-publication-cleanup-comment.cjs" \
  "$root/tools/local-agent/patch-publication-cleanup-transfer.sh" \
  "$root/tools/local-agent/patch-publication-prepare-steps.sh" \
  "$root/tools/local-agent/patch-publication-validate-candidate.sh" \
  "$root/tools/local-agent/patch-publication-summary.sh" \
  "$root/.github/workflows/ci.yml" <<'PY'
import pathlib, re, subprocess, sys, tempfile, textwrap
workflow_path, request_path, cleanup_path, transfer_path, prepare_path, validator_path, summary_path, ci_path = map(pathlib.Path, sys.argv[1:])
text = workflow_path.read_text(encoding="utf-8")
ci_text = ci_path.read_text(encoding="utf-8")
request_text = request_path.read_text(encoding="utf-8")
cleanup_text = cleanup_path.read_text(encoding="utf-8")
transfer_text = transfer_path.read_text(encoding="utf-8")
prepare_text = prepare_path.read_text(encoding="utf-8")
validator_text = validator_path.read_text(encoding="utf-8")
summary_text = summary_path.read_text(encoding="utf-8")
assert len(text.encode("utf-8")) <= 12 * 1024
assert "patch-publication-request.cjs" in text
assert "patch-publication-cleanup-comment.cjs" in text
assert "patch-publication-cleanup-transfer.sh" in text
assert "patch-publication-prepare-steps.sh" in text
assert "patch-publication-validate-candidate.sh" in text
assert "patch-publication-summary.sh" in text
assert text.count("ref: ${{ github.workflow_sha }}") >= 5
assert "\n  request:\n" not in text
assert text.count("\n  prepare:\n") == 1
prepare = text.split("  prepare:\n", 1)[1].split("\n  test:\n", 1)[0]
assert "issues: read" in prepare and "pull-requests: read" in prepare
assert prepare.index("Validate publication command") < prepare.index("Read exact transfer manifest")
assert "request_validated: ${{ steps.bind.outputs.validated }}" in prepare
assert "fetch-depth: 1" in prepare
assert "([0-9a-f]{64})$" in request_text
assert "Patch publication commands must be placed on a pull request." in request_text
assert "github.rest.git.getRef" in request_text
assert "github.rest.repos.getContent" in request_text
assert "context.payload.comment.id" in request_text
assert "expected_transfer_sha" in text
assert "comment_id: ${{ steps.request.outputs.comment_id }}" in text
assert "Read exact transfer manifest" in text
preserve_tools = prepare.split(
    "      - name: Preserve trusted publication tools\n", 1
)[1].split("\n      - name:", 1)[0]
assert '"$RUNNER_TEMP/patch-publication.py"' in preserve_tools
assert '"$RUNNER_TEMP/patch-publication-prepare-steps.sh"' in preserve_tools
assert prepare.index("Preserve trusted publication tools") < prepare.index("Read exact transfer manifest")
trusted_prepare_driver = 'bash "$RUNNER_TEMP/patch-publication-prepare-steps.sh"'
assert prepare.count(trusted_prepare_driver) == 6
assert "bash tools/local-agent/patch-publication-prepare-steps.sh" not in prepare
assert 'actual_transfer_sha="$(git rev-parse refs/remotes/origin/patch-transfer)"' in prepare_text
assert 'sha256sum "$RUNNER_TEMP/manifest.json"' in prepare_text
assert "materialize-patch" in prepare_text
assert "refs/remotes/origin/patch-transfer" in prepare_text
assert "preserved_retry" in transfer_text
assert '[[ "$PUBLISH_RESULT" != success ]]' in transfer_text
assert '--force-with-lease="${transfer_ref}:${EXPECTED_TRANSFER_SHA}"' in transfer_text
assert "preserved_changed" in transfer_text
assert "cleanup-transfer:" in text and "cleanup-comment:" in text
assert text.count("runs-on: ubuntu-24.04") == 5
assert "timeout-minutes: 30" not in text
assert "validation_profile: ${{ steps.prepare.outputs.validation_profile }}" in text
test_job = text.split("  test:\n", 1)[1].split("\n  publish:\n", 1)[0]
assert test_job.index("Preserve trusted candidate validation driver") < test_job.index("Verify exact candidate identity and target base")
assert "needs.prepare.outputs.validation_profile != 'docs'" in test_job
assert 'bash "$RUNNER_TEMP/validate-candidate" validate-profile "${{ needs.prepare.outputs.validation_profile }}"' in test_job
assert "run: bash tools/local-agent/check-local-agent.sh" not in test_job
assert "run: npm ci --no-audit --no-fund" not in test_job
assert 'case "$mode" in' in validator_text
assert 'verify-identity) verify_identity' in validator_text
assert 'validate-profile) validate_profile' in validator_text
assert 'bash tools/local-agent/check-local-agent.sh' in validator_text
assert 'run_repository_checks' in validator_text
assert 'tooling_pid' not in validator_text
assert 'repository_pid' not in validator_text
assert "Documentation-only validation" in validator_text
assert "Repository validation" in validator_text
assert "Full validation" in validator_text
assert "needs.request" not in text
assert "needs.prepare.outputs.request_validated == 'true'" in text
assert "cancel-in-progress: true" in ci_text
assert "runs-on: ubuntu-24.04" in ci_text
assert "timeout-minutes: 5" in ci_text
assert "run: bash tools/local-agent/check-local-agent.sh" in ci_text
assert "run: npm ci --no-audit --no-fund" in ci_text

publish = text.split("  publish:\n", 1)[1].split("  cleanup-transfer:\n", 1)[0]
permission_header = publish.split("    outputs:\n", 1)[0]
assert re.search(r"(?m)^    permissions:\n      contents: read$", permission_header)
assert "contents: write" not in permission_header

checkout = publish.split(
    "      - name: Check out trusted workflow revision\n", 1
)[1].split("\n      - name:", 1)[0]
assert "persist-credentials: false" in checkout
assert "persist-credentials: true" not in checkout

verify_marker = "      - name: Verify candidate without executing it\n"
token_marker = "      - name: Create scoped patch publisher token\n"
push_marker = "      - name: Publish by non-force fast-forward\n"
assert publish.index(verify_marker) < publish.index(token_marker) < publish.index(push_marker)
assert '--expected-validation-profile "$VALIDATION_PROFILE"' in publish

token_step = publish.split(token_marker, 1)[1].split("\n      - name:", 1)[0]
assert "id: patch-publisher-token" in token_step
assert (
    "uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1"
) in token_step
token_inputs = {}
for line in token_step.split("        with:\n", 1)[1].splitlines():
    match = re.fullmatch(r"          ([a-z][a-z0-9-]*): (.+)", line)
    assert match, f"unsupported patch publisher input syntax: {line.strip()}"
    key, value = match.groups()
    assert key not in token_inputs
    token_inputs[key] = value
assert token_inputs == {
    "client-id": "${{ vars.PATCH_PUBLISHER_CLIENT_ID }}",
    "private-key": "${{ secrets.PATCH_PUBLISHER_PRIVATE_KEY }}",
    "permission-contents": "write",
    "permission-workflows": "write",
}

push_step = publish.split(push_marker, 1)[1]
assert (
    "PATCH_PUBLISHER_TOKEN: ${{ steps.patch-publisher-token.outputs.token }}"
) in push_step
assert (
    '"https://x-access-token:${PATCH_PUBLISHER_TOKEN}'
    '@github.com/${GITHUB_REPOSITORY}.git"'
) in push_step
assert "git push --porcelain origin" not in push_step

assert text.count("${{ vars.PATCH_PUBLISHER_CLIENT_ID }}") == 1
assert text.count("${{ secrets.PATCH_PUBLISHER_PRIVATE_KEY }}") == 1
assert text.count("${{ steps.patch-publisher-token.outputs.token }}") == 1
for forbidden in ["${{ github.token }}", "secrets.GITHUB_TOKEN", "GITHUB_TOKEN:"]:
    assert forbidden not in publish
# This guard intentionally accepts one canonical block-style YAML subset.
# Any alternative structure must fail closed rather than bypass action scanning.
def line_indentation(line):
    return len(line) - len(line.lstrip(" "))


def is_comment_or_empty(value):
    return re.fullmatch(r"[ \t]*(?:#.*)?", value) is not None


def parse_plain_mapping_entry(value, scope, job_name, source_line):
    match = re.fullmatch(
        r"(?P<key>[A-Za-z_][A-Za-z0-9_-]*|<<)[ \t]*:[ \t]*(?P<value>.*)",
        value,
    )
    if not match:
        raise AssertionError(
            f"workflow {scope} must use unquoted plain mapping keys in job "
            f"{job_name}: {source_line.strip()}"
        )
    key = match.group("key")
    scalar = match.group("value")
    if key == "<<" or re.match(r"[&*!]", scalar.lstrip()):
        raise AssertionError(
            f"workflow YAML anchors, aliases, tags, and merge keys are unsupported "
            f"in job {job_name}: {source_line.strip()}"
        )
    return key, scalar


def parse_uses_scalar(scalar, job_name, source_line):
    scalar_patterns = [
        r"(?P<ref>[^\\\s#'\"|>\[\]{},]+)(?:[ \t]+#.*)?",
        r"'(?P<ref>[^']+)'(?:[ \t]+#.*)?",
        r'"(?P<ref>[^"\\]+)"(?:[ \t]+#.*)?',
    ]
    for pattern in scalar_patterns:
        match = re.fullmatch(pattern, scalar)
        if not match:
            continue
        ref = match.group("ref")
        action_match = re.fullmatch(
            r"(?P<path>[^@\\\s]+)@(?P<pin>[0-9a-f]{40})",
            ref,
        )
        assert action_match, (
            f"workflow action refs must use one immutable 40-hex pin in job "
            f"{job_name}: {source_line.strip()}"
        )
        path_segments = action_match.group("path").split("/")
        assert (
            len(path_segments) >= 2
            and all(
                segment not in {"", ".", ".."}
                and re.fullmatch(r"[A-Za-z0-9_.-]+", segment)
                for segment in path_segments
            )
        ), (
            f"workflow action refs must use canonical owner/repository[/path] "
            f"syntax in job {job_name}: {source_line.strip()}"
        )
        return ref
    raise AssertionError(
        f"unsupported workflow uses scalar in job {job_name}: {source_line.strip()}"
    )


def parse_job_properties(job_lines, job_name):
    significant = [
        (index, line, line_indentation(line))
        for index, line in enumerate(job_lines[1:], start=1)
        if line.strip() and not line.lstrip().startswith("#")
    ]
    assert significant, f"workflow job {job_name} has no properties"
    property_indent = min(indentation for _, _, indentation in significant)
    assert property_indent == 4, (
        f"workflow job properties must use four-space indentation in job {job_name}"
    )

    properties = []
    for index, line, indentation in significant:
        if indentation > property_indent:
            continue
        assert indentation == property_indent, (
            f"workflow job properties must use four-space indentation in job "
            f"{job_name}: {line.strip()}"
        )
        key, scalar = parse_plain_mapping_entry(
            line[4:],
            "job properties",
            job_name,
            line,
        )
        properties.append((index, key, scalar))
    return properties


def collect_action_refs(job_lines, job_name, properties):
    steps_headers = [
        (index, scalar)
        for index, key, scalar in properties
        if key == "steps"
    ]
    assert len(steps_headers) <= 1, (
        f"workflow job {job_name} must have at most one steps mapping"
    )
    if not steps_headers:
        return []
    steps_start, steps_scalar = steps_headers[0]
    assert is_comment_or_empty(steps_scalar), (
        f"workflow steps must use canonical block sequence syntax in job {job_name}"
    )
    steps_start += 1
    steps_end = len(job_lines)
    for index in range(steps_start, len(job_lines)):
        line = job_lines[index]
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line_indentation(line) <= 4:
            steps_end = index
            break

    body = job_lines[steps_start:steps_end]
    significant = [
        (index, line, line_indentation(line))
        for index, line in enumerate(body)
        if line.strip() and not line.lstrip().startswith("#")
    ]
    if not significant:
        return []

    step_starts = []
    for index, line, indentation in significant:
        if indentation > 6:
            continue
        assert indentation == 6, (
            f"workflow steps must use six-space sequence indentation in job "
            f"{job_name}: {line.strip()}"
        )
        match = re.fullmatch(r"      -(?: (?P<body>.*))?", line)
        assert match, (
            f"workflow step entries must use one space after '-' in job "
            f"{job_name}: {line.strip()}"
        )
        step_starts.append((index, match.group("body") or ""))
    assert step_starts, f"workflow job {job_name} has no canonical step definitions"

    refs = []
    for position, (start, first_body) in enumerate(step_starts):
        end = step_starts[position + 1][0] if position + 1 < len(step_starts) else len(body)
        fields = []
        if first_body:
            fields.append((first_body, body[start]))
        for line in body[start + 1:end]:
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            indentation = line_indentation(line)
            if indentation > 8:
                continue
            assert indentation == 8, (
                f"workflow step fields must use eight-space indentation in job "
                f"{job_name}: {line.strip()}"
            )
            fields.append((line[8:], line))
        assert fields, f"workflow job {job_name} contains an empty step"
        for field, source_line in fields:
            key, scalar = parse_plain_mapping_entry(
                field,
                "step fields",
                job_name,
                source_line,
            )
            if key == "uses":
                refs.append(parse_uses_scalar(scalar, job_name, source_line))
    return refs


def collect_job_level_refs(job_lines, job_name, properties):
    uses_headers = [
        (index, scalar)
        for index, key, scalar in properties
        if key == "uses"
    ]
    assert len(uses_headers) <= 1, (
        f"workflow job {job_name} must have at most one job-level uses field"
    )
    if not uses_headers:
        return []
    assert not any(key == "steps" for _, key, _ in properties), (
        f"workflow job {job_name} cannot combine job-level uses with steps"
    )
    index, scalar = uses_headers[0]
    return [parse_uses_scalar(scalar, job_name, job_lines[index])]


def assert_job_contents_access(job_lines, job_name, properties):
    permission_headers = [
        (index, scalar)
        for index, key, scalar in properties
        if key == "permissions"
    ]
    assert len(permission_headers) == 1, (
        f"checkout job {job_name} must have one explicit permissions mapping"
    )
    permissions_start, permissions_scalar = permission_headers[0]
    assert is_comment_or_empty(permissions_scalar), (
        f"checkout job {job_name} permissions must use canonical block mapping syntax"
    )
    permissions_start += 1
    permissions_end = len(job_lines)
    for index in range(permissions_start, len(job_lines)):
        line = job_lines[index]
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line_indentation(line) <= 4:
            permissions_end = index
            break

    entries = []
    for line in job_lines[permissions_start:permissions_end]:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indentation = line_indentation(line)
        assert indentation == 6, (
            f"workflow permission entries must use six-space indentation in job "
            f"{job_name}: {line.strip()}"
        )
        entries.append(
            parse_plain_mapping_entry(
                line[6:],
                "permission entries",
                job_name,
                line,
            )
        )
    assert entries, f"checkout job {job_name} has an empty permissions mapping"
    contents_entries = [scalar for key, scalar in entries if key == "contents"]
    assert len(contents_entries) == 1, (
        f"checkout job {job_name} lacks exactly one contents read/write permission"
    )
    assert re.fullmatch(
        r"(?:read|write)[ \t]*(?:#.*)?",
        contents_entries[0],
    ), f"checkout job {job_name} lacks exactly one contents read/write permission"


def parse_top_level_properties(lines):
    properties = []
    seen = set()
    for index, line in enumerate(lines):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indentation = line_indentation(line)
        if indentation > 0:
            continue
        match = re.fullmatch(
            r"(?P<key>[A-Za-z_][A-Za-z0-9_-]*|<<)[ \t]*:[ \t]*(?P<value>.*)",
            line,
        )
        assert match, (
            "workflow top-level keys must use unquoted plain mapping syntax: "
            f"{line.strip()}"
        )
        key = match.group("key")
        scalar = match.group("value")
        assert key != "<<" and not re.match(r"[&*!]", scalar.lstrip()), (
            "workflow top-level anchors, aliases, tags, and merge keys are unsupported: "
            f"{line.strip()}"
        )
        assert key not in seen, f"workflow top-level key {key} must be unique"
        seen.add(key)
        properties.append((index, key, scalar))
    return properties


def assert_checkout_jobs_have_contents_access(workflow_text):
    lines = workflow_text.splitlines()
    top_level = parse_top_level_properties(lines)
    jobs_headers = [
        (index, scalar)
        for index, key, scalar in top_level
        if key == "jobs"
    ]
    assert len(jobs_headers) == 1, "workflow must contain exactly one jobs mapping"
    jobs_header, jobs_scalar = jobs_headers[0]
    assert is_comment_or_empty(jobs_scalar), (
        "workflow jobs must use canonical block mapping syntax"
    )
    jobs_start = jobs_header + 1
    jobs_end = next(
        (index for index, _, _ in top_level if index > jobs_header),
        len(lines),
    )

    job_headers = []
    pattern = re.compile(
        r"^  (?P<name>[A-Za-z_][A-Za-z0-9_-]*):[ \t]*(?:#.*)?$"
    )
    for index in range(jobs_start, jobs_end):
        line = lines[index]
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indentation = line_indentation(line)
        if indentation > 2:
            continue
        assert indentation == 2, (
            f"workflow job keys must use two-space indentation: {line.strip()}"
        )
        match = pattern.fullmatch(line)
        assert match, (
            "workflow job keys must be unquoted valid GitHub job IDs: "
            f"{line.strip()}"
        )
        job_headers.append((index, match.group("name")))
    assert job_headers, "workflow jobs mapping has no job definitions"

    all_refs = []
    for position, (start, job_name) in enumerate(job_headers):
        end = job_headers[position + 1][0] if position + 1 < len(job_headers) else jobs_end
        job_lines = lines[start:end]
        properties = parse_job_properties(job_lines, job_name)
        job_level_refs = collect_job_level_refs(job_lines, job_name, properties)
        step_refs = collect_action_refs(job_lines, job_name, properties)
        refs = job_level_refs + step_refs
        all_refs.extend(refs)
        if any(
            ref.rsplit("@", 1)[0].lower() == "actions/checkout"
            for ref in step_refs
        ):
            assert_job_contents_access(job_lines, job_name, properties)
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


def assert_rejected(workflow_text, expected_fragment):
    try:
        assert_checkout_jobs_have_contents_access(workflow_text)
    except AssertionError as error:
        assert expected_fragment in str(error), str(error)
    else:
        raise AssertionError("unsafe or unsupported workflow syntax was not rejected")


refs = assert_checkout_jobs_have_contents_access(text)
assert refs
checkout_sha = "0" * 40
for uses_lines in [
    [f"- uses: actions/checkout@{checkout_sha}"],
    [f'- uses: "actions/checkout@{checkout_sha}"'],
    [f"- uses: 'actions/checkout@{checkout_sha}'"],
    [f"- uses: Actions/Checkout@{checkout_sha}"],
]:
    assert_rejected(
        make_checkout_job(uses_lines),
        "lacks exactly one contents read/write permission",
    )

assert_rejected(
    make_checkout_job([f"- uses:  actions/checkout@{checkout_sha}"]),
    "lacks exactly one contents read/write permission",
)
reusable_sha = "1" * 40
reusable_ref = f"example/repository/.github/workflows/reusable.yml@{reusable_sha}"
reusable_job = "\n".join(
    [
        "jobs:",
        "  reusable:",
        f"    uses: {reusable_ref}",
        "",
    ]
)
assert assert_checkout_jobs_have_contents_access(reusable_job) == [reusable_ref]
for unpinned_reusable_ref in [
    "example/repository/.github/workflows/reusable.yml@main",
    "./.github/workflows/reusable.yml",
]:
    assert_rejected(
        reusable_job.replace(reusable_ref, unpinned_reusable_ref),
        "one immutable 40-hex pin",
    )
assert_rejected(
    reusable_job.replace(
        f"    uses: {reusable_ref}",
        "    steps:\n      - run: echo invalid\n"
        f"    uses: {reusable_ref}",
    ),
    "cannot combine job-level uses with steps",
)

subdirectory_ref = f"example/action/subdirectory@{checkout_sha}"
assert assert_checkout_jobs_have_contents_access(
    make_checkout_job([f"- uses: {subdirectory_ref}"])
) == [subdirectory_ref]
for noncanonical_action_ref in [
    f"actions//checkout@{checkout_sha}",
    f"/actions/checkout@{checkout_sha}",
    f"actions/checkout/@{checkout_sha}",
    f"actions/checkout/.@{checkout_sha}",
    f"actions/checkout/..@{checkout_sha}",
]:
    assert_rejected(
        make_checkout_job([f"- uses: {noncanonical_action_ref}"]),
        "canonical owner/repository[/path] syntax",
    )
for hidden_jobs_key in [
    '"jobs":',
    r'"jo\u0062s":',
    '? jobs\n: null',
    '<<: *workflow',
]:
    duplicate_jobs = "\n".join(
        [
            make_checkout_job([f"- uses: example/action@{checkout_sha}"]).rstrip(),
            hidden_jobs_key,
            "  hidden_checkout:",
            "    runs-on: ubuntu-latest",
            "    permissions:",
            "      issues: write",
            "    steps:",
            f"      - uses: actions/checkout@{checkout_sha}",
            "",
        ]
    )
    assert_rejected(duplicate_jobs, "top-level")

assert_rejected(
    make_checkout_job([f"- uses: example/action@{checkout_sha}"])
    + "\njobs:\n  duplicate: {}\n",
    "top-level key jobs must be unique",
)
for noncanonical_lines in [
    [f" - uses: actions/checkout@{checkout_sha}"],
    ["-    name: Hidden checkout", f"     uses: actions/checkout@{checkout_sha}"],
]:
    assert_rejected(make_checkout_job(noncanonical_lines), "workflow")

for escaped_checkout in (
    r"actions\/checkout",
    r"actions\x2fcheckout",
    r"actions\u002fcheckout",
):
    assert_rejected(
        make_checkout_job([f'- uses: "{escaped_checkout}@{checkout_sha}"']),
        "unsupported workflow uses scalar",
    )

for hidden_uses_lines in [
    ["- uses: >-", f"    actions/checkout@{checkout_sha}"],
    ["- uses: *checkout"],
    [f'- "uses": "actions/checkout@{checkout_sha}"'],
    ["- ? uses", f"  : actions/checkout@{checkout_sha}"],
    [f'- "u\\u0073es": actions/checkout@{checkout_sha}'],
    [f"- !!str uses: actions/checkout@{checkout_sha}"],
    [f"- {{ uses: actions/checkout@{checkout_sha} }}"],
]:
    assert_rejected(make_checkout_job(hidden_uses_lines), "workflow")

aliased_checkout_jobs = "\n".join(
    [
        "jobs:",
        "  anchor_source:",
        "    runs-on: ubuntu-latest",
        "    permissions:",
        "      contents: read",
        "    steps: &checkout_steps",
        f"      - uses: actions/checkout@{checkout_sha}",
        "  anchor_target:",
        "    runs-on: ubuntu-latest",
        "    permissions:",
        "      issues: write",
        "    steps: *checkout_steps",
        "",
    ]
)
assert_rejected(aliased_checkout_jobs, "anchors, aliases")
assert_rejected(
    make_checkout_job(["- &checkout_step", f"  uses: actions/checkout@{checkout_sha}"]),
    "workflow",
)

for permissions in [
    "      contents: read\n      contents: none",
    '      "contents": none',
    "      contents: *permission",
]:
    permission_job = make_checkout_job(
        [f"- uses: actions/checkout@{checkout_sha}"]
    ).replace("      issues: write", permissions)
    assert_rejected(permission_job, "permission")

nested_uses_input_job = "\n".join(
    [
        "jobs:",
        "  nested_uses_input:",
        "    runs-on: ubuntu-latest",
        "    permissions:",
        "      contents: read",
        "    steps:",
        f"      - uses: example/action@{checkout_sha}",
        "        with:",
        "          uses: candidate-controlled-input",
        "",
    ]
)
assert assert_checkout_jobs_have_contents_access(nested_uses_input_job) == [
    f"example/action@{checkout_sha}"
]
run_text_only_job = make_checkout_job([f"- run: echo actions/checkout@{checkout_sha}"])
assert assert_checkout_jobs_have_contents_access(run_text_only_job) == []
multiline_run_text_job = make_checkout_job(
    ["- run: |", f"    uses: actions/checkout@{checkout_sha}"]
)
assert assert_checkout_jobs_have_contents_access(multiline_run_text_job) == []

transfer_cleanup = text.split("  cleanup-transfer:\n", 1)[1].split("  cleanup-comment:\n", 1)[0]
comment_cleanup = text.split("  cleanup-comment:\n", 1)[1]
assert "contents: write" in transfer_cleanup and "issues: write" not in transfer_cleanup
assert "contents: read" in comment_cleanup
assert "pull-requests: write" in comment_cleanup
assert "issues: write" not in comment_cleanup and "contents: write" not in comment_cleanup
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
! grep -qx 'validation_profile=docs' "$prepare_output"
python3 - "$output/publication.json" <<'PY'
import json, pathlib, sys
metadata = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
assert metadata["validationProfile"] == "full"
PY

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

if git -C "$tmp/publisher" push --porcelain origin "$candidate:refs/heads/$target" >/dev/null 2>&1; then
  echo 'candidate push unexpectedly succeeded after target race' >&2
  exit 1
fi
test "$(git --git-dir="$remote" rev-parse "refs/heads/$target")" = "$race"

git --git-dir="$remote" update-ref "refs/heads/$target" "$base" "$race"
git -C "$tmp/publisher" push -q origin "$candidate:refs/heads/$target"
test "$(git --git-dir="$remote" rev-parse "refs/heads/$target")" = "$candidate"

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
run_cleanup failure "$changed_output"
test "$(git --git-dir="$remote" rev-parse "refs/heads/$transfer")" = "$changed_transfer_sha"
grep -qx 'cleanup_status=preserved_changed' "$changed_output"

# Successful V2 publication removes only the exact authorized transfer ref.
git --git-dir="$remote" update-ref "refs/heads/$transfer" \
  "$expected_transfer_sha" "$changed_transfer_sha"
removed_output="$tmp/cleanup-removed.out"
run_cleanup success "$removed_output"
! git --git-dir="$remote" show-ref --verify "refs/heads/$transfer" >/dev/null 2>&1
grep -qx 'cleanup_status=removed' "$removed_output"

echo 'patch-publication workflow checks passed'
