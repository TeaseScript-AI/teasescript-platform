#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$script_dir/../.." && pwd)
workflow="$root/.github/workflows/phase1-delete-test-artifact.yml"

python3 - "$workflow" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text(encoding="utf-8")

assert len(text.encode("utf-8")) <= 4 * 1024
assert text.startswith("name: Phase 1 deleted artifact proof\n")
assert "\n  push:\n" in text
assert "branches: [main]" in text
assert "- .github/workflows/phase1-delete-test-artifact.yml" in text
assert "\npermissions: {}\n" in text
assert text.count("\n  delete-fixture:\n") == 1
assert "if: github.event_name == 'push'" in text
assert "runs-on: ubuntu-24.04" in text
assert "timeout-minutes: 2" in text
assert re.search(r"(?m)^      actions: write$", text)
assert re.search(r"(?m)^      contents: write$", text)
assert re.search(r"(?m)^      statuses: write$", text)
assert "issues:" not in text
assert "secrets." not in text
assert "actions/checkout@" not in text
assert "const artifactId = 8908406686;" in text
assert "const sourceSha = '251dbc07c7dde066de5714d973a381d505cb0186';" in text
assert "github.rest.actions.getArtifact" in text
assert "artifact.name !== expectedName" in text
assert "artifact.expired === true" in text
assert "github.rest.actions.deleteArtifact" in text
assert "context: 'source-bundle/deleted-artifact-proof-v1'" in text
assert "github.rest.git.deleteRef" in text
assert "ref: `heads/${branch}`" in text
for branch in (
    "agent/issue-234-deleted-artifact-proof",
    "agent/issue-234-deleted-artifact-proof-receiver",
    "agent/issue-234-deleted-artifact-proof-target",
    "agent/issue-234-deleted-artifact-proof-pr",
    "agent/issue-234-deleted-artifact-proof-final",
    "agent/issue-234-deleted-artifact-proof-current",
    "agent/issue-234-deleted-artifact-proof-use-this",
    "agent/issue-234-deleted-artifact-proof-actual",
    "agent-patch-publication/issue-234-deleted-artifact-proof",
    "agent-patch-publication/issue-234-deleted-artifact-proof-v2",
):
    assert f"'{branch}'" in text

for ref in re.findall(r"(?m)^\s+uses:\s+([^\s#]+)", text):
    assert re.fullmatch(r"[^@\s]+@[0-9a-f]{40}", ref), ref

print("phase1 deleted artifact proof workflow assertions passed")
PY
