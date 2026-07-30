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

python3 - "$workflow" <<'PY'
import pathlib, re, subprocess, sys, tempfile
text = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
refs = re.findall(r"^\s*uses:\s*([^\s#]+)", text, re.MULTILINE)
assert refs and all(re.fullmatch(r"[^@]+@[0-9a-f]{40}", ref) for ref in refs)
assert "([0-9a-f]{64})$" in text
assert "Patch publication commands must be placed on a pull request." in text
assert "github.rest.git.getRef" in text
assert "github.rest.repos.getContent" in text
assert "expected_transfer_sha" in text
assert "format_version" in text
assert "comment_id: ${{ steps.request.outputs.comment_id }}" in text
assert "context.payload.comment.id" in text
assert "Read exact transfer manifest" in text
assert 'actual_transfer_sha="$(git rev-parse refs/remotes/origin/patch-transfer)"' in text
assert "Verify authorized manifest digest" in text
assert 'sha256sum "$RUNNER_TEMP/manifest.json"' in text
assert "materialize-patch" in text
assert "refs/remotes/origin/patch-transfer" in text
assert "preserved_retry" in text
assert '[[ "$FORMAT_VERSION" == 2 && "$PUBLISH_RESULT" != success ]]' in text
assert '--force-with-lease="${transfer_ref}:${EXPECTED_TRANSFER_SHA}"' in text
assert "preserved_changed" in text
assert "cleanup-transfer:" in text and "cleanup-comment:" in text
transfer_cleanup = text.split("  cleanup-transfer:\n", 1)[1].split("  cleanup-comment:\n", 1)[0]
comment_cleanup = text.split("  cleanup-comment:\n", 1)[1]
assert "contents: write" in transfer_cleanup and "issues: write" not in transfer_cleanup
assert "uses: actions/checkout@" not in transfer_cleanup
assert "git init -q \"$cleanup_repo\"" in transfer_cleanup
assert "issues: write" in comment_cleanup and "contents: write" not in comment_cleanup
assert "github.rest.issues.getComment" in comment_cleanup
assert "github.rest.issues.deleteComment" in comment_cleanup
assert "github.rest.issues.createComment" not in text
assert "comment.data.body.trim() !== expectedCommand" in comment_cleanup
assert "github.rest.git.deleteRef" not in text
assert 'patch-transfer:.agent-patch-publication/change.patch' not in text

lines = text.splitlines()
scripts = []
for index, line in enumerate(lines):
    if line.strip() != "script: |":
        continue
    indent = len(line) - len(line.lstrip())
    body = []
    for candidate in lines[index + 1:]:
        candidate_indent = len(candidate) - len(candidate.lstrip())
        if candidate.strip() and candidate_indent <= indent:
            break
        body.append(candidate[indent + 2:] if candidate.strip() else "")
    scripts.append("\n".join(body))
assert len(scripts) == 2
with tempfile.TemporaryDirectory() as temporary:
    for index, script in enumerate(scripts):
        path = pathlib.Path(temporary, f"github-script-{index}.js")
        path.write_text(f"(async function () {{\n{script}\n}});\n", encoding="utf-8")
        subprocess.run(["node", "--check", str(path)], check=True)
PY

tmp="$(mktemp -d -t patch-publication-workflow-XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
cleanup_script="$tmp/cleanup-transfer.sh"
python3 - "$workflow" "$cleanup_script" <<'PYCLEANUP'
import pathlib
import sys

workflow = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8").splitlines()
output = pathlib.Path(sys.argv[2])
step_index = next(
    index
    for index, line in enumerate(workflow)
    if line.strip() == "- name: Clean up exact transfer ref"
)
run_index = next(
    index
    for index in range(step_index + 1, len(workflow))
    if workflow[index].strip() == "run: |"
)
run_indent = len(workflow[run_index]) - len(workflow[run_index].lstrip())
body = []
for line in workflow[run_index + 1 :]:
    indent = len(line) - len(line.lstrip())
    if line.strip() and indent <= run_indent:
        break
    body.append(line[run_indent + 2 :] if line.strip() else "")
assert body
script = "\n".join(body) + "\n"
old_remote = 'remote_url="https://github.com/${GITHUB_REPOSITORY}.git"'
new_remote = 'remote_url="${PATCH_PUBLICATION_TEST_REMOTE_URL:?}"'
assert script.count(old_remote) == 1
script = script.replace(old_remote, new_remote)
output.write_text(
    "#!/usr/bin/env bash\nset -euo pipefail\n" + script,
    encoding="utf-8",
)
PYCLEANUP
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
