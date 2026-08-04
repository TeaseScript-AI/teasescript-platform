#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root="$(cd "$script_dir/../.." && pwd)"
workflow="$root/.github/workflows/issue-comment-diagnostic.yml"

python3 - "$workflow" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text(encoding="utf-8")

assert len(text.encode("utf-8")) <= 5 * 1024
assert text.startswith("name: Issue comment diagnostic\n")
assert "\n  push:\n" in text
assert "branches: [main]" in text
assert "- .github/workflows/issue-comment-diagnostic.yml" in text
assert "\n  issue_comment:\n    types: [created]\n" in text
assert "\npermissions: {}\n" in text
assert text.count("\n  confirm-load:\n") == 1
assert text.count("\n  confirm-comment:\n") == 1
assert text.count("runs-on: ubuntu-24.04") == 2
assert text.count("timeout-minutes: 2") == 2
assert text.count("actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3") == 2
assert "actions/checkout@" not in text
assert "secrets." not in text
assert "contents:" not in text
assert "pull-requests:" not in text
assert "actions:" not in text

load = text.split("  confirm-load:\n", 1)[1].split("\n  confirm-comment:\n", 1)[0]
assert "if: github.event_name == 'push'" in load
assert re.search(r"(?m)^      statuses: write$", load)
assert "issues:" not in load
assert "context: 'issue-comment/diagnostic-load-v1'" in load
assert "Diagnostic workflow loaded on main." in load
assert "target_url: runUrl" in load

comment = text.split("  confirm-comment:\n", 1)[1]
assert "github.event_name == 'issue_comment'" in comment
assert "github.event.issue.number == 235" in comment
assert "startsWith(github.event.comment.body, '/diagnose issue-comment ')" in comment
assert re.search(r"(?m)^      issues: write$", comment)
assert re.search(r"(?m)^      statuses: write$", comment)
assert "^\\/diagnose issue-comment ([A-Za-z0-9._-]{1,32})$" in comment
assert "github.rest.reactions.createForIssueComment" in comment
assert "content: 'eyes'" in comment
assert "github.rest.repos.createCommitStatus" in comment
assert "context: 'issue-comment/diagnostic-event-v1'" in comment
assert "description: `request ${commentId}; nonce ${nonce}`" in comment
assert "workflowRef: process.env.GITHUB_WORKFLOW_REF" in comment
assert "workflowSha: process.env.GITHUB_WORKFLOW_SHA" in comment
assert "target_url: runUrl" in comment

for ref in re.findall(r"(?m)^\s+uses:\s+([^\s#]+)", text):
    assert re.fullmatch(r"[^@\s]+@[0-9a-f]{40}", ref), ref

print("issue-comment diagnostic workflow assertions passed")
PY
