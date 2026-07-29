#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
workflow="$root/.github/workflows/patch-publication.yml"
script="$root/tools/local-agent/patch-publication.py"
target='feat/test-target'
transfer='agent-patch-publication/integration-test'

python3 - "$workflow" <<'PY'
import pathlib, re, sys
text = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
refs = re.findall(r"^\s*uses:\s*([^\s#]+)", text, re.MULTILINE)
assert refs and all(re.fullmatch(r"[^@]+@[0-9a-f]{40}", ref) for ref in refs)
assert "([0-9a-f]{64})$" in text
assert "Patch publication commands must be placed on a pull request." in text
assert "github.rest.git.getRef" in text
assert "expected_transfer_sha" in text
assert "Read exact transfer payload" in text
assert 'actual_transfer_sha="$(git rev-parse refs/remotes/origin/patch-transfer)"' in text
assert "Verify authorized manifest digest" in text
assert 'sha256sum "$RUNNER_TEMP/manifest.json"' in text
assert '--force-with-lease="${transfer_ref}:${EXPECTED_TRANSFER_SHA}"' in text
assert "preserved_changed" in text
assert "github.rest.git.deleteRef" not in text
PY

tmp="$(mktemp -d -t patch-publication-workflow-XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
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

git -C "$tmp/racer" checkout -q -B transfer-update "origin/$transfer"
printf 'new transfer payload\n' > "$tmp/racer/transfer.txt"
git -C "$tmp/racer" add transfer.txt
git -C "$tmp/racer" commit -q -m 'replace transfer payload'
changed_transfer_sha="$(git -C "$tmp/racer" rev-parse HEAD)"
git -C "$tmp/racer" push -q origin "HEAD:refs/heads/$transfer"

if git -C "$tmp/publisher" push --porcelain \
  --force-with-lease="refs/heads/$transfer:$expected_transfer_sha" \
  origin ":refs/heads/$transfer" >/dev/null 2>&1; then
  echo 'stale cleanup unexpectedly deleted a changed transfer ref' >&2
  exit 1
fi
test "$(git --git-dir="$remote" rev-parse "refs/heads/$transfer")" = "$changed_transfer_sha"

git --git-dir="$remote" update-ref "refs/heads/$transfer" \
  "$expected_transfer_sha" "$changed_transfer_sha"
git -C "$tmp/publisher" push -q \
  --force-with-lease="refs/heads/$transfer:$expected_transfer_sha" \
  origin ":refs/heads/$transfer"
! git --git-dir="$remote" show-ref --verify "refs/heads/$transfer" >/dev/null 2>&1

echo 'patch-publication workflow checks passed'
