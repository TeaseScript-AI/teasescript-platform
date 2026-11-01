#!/bin/bash
# tools/corpus/baseline.sh <built tree> <its full SHA>      the hook: fills the baseline of a new `main`'s src/ tree
# tools/corpus/baseline.sh status <commit or built tree>     one line: what the baseline of its src/ tree holds
#
# The stored baseline (owner, 2026-10-30; keyed by the `src/` tree, #1541): the corpus runner's runs of one tree, stored
# so that a pull request runs only its head against them (`run.mjs <area> <head> --baseline <baseline>/<area>`).
# tests/families/baselines.mjs reads and writes every baseline, ~/work/baselines/<src tree>/: its MANIFEST (what its runs
# depend on, the commits stored there, each area's PLAN), shards that count only once verified, and `state`. Nothing
# removes a baseline. Builders store with `run.mjs <area> <tree> --store ~/work/baselines --shard i/16`, under
# `sx-sandbox --write ~/work/baselines/<src tree> --write <scratch>` (below). `status` prints `state --read-only` of the
# commit's shared tree (`sx-tree` builds it once where it is missing) as one line, and exits as it does: 0 only when
# every area is complete, 2 where the baseline is not this tool's or holds runs of other inputs.
#
# The sandbox (#1542, orchestrator 2's contract; `sx-sandbox`, bubblewrap): a store writes into its tree's baseline,
# ~/work/baselines/<src tree>/ (`git rev-parse <commit>:src`), and nothing else, its locks and temporary files and the
# MANIFEST it makes there included; a process may also write its TMPDIR scratch, and its own `--out`. The hook runs in
# a sandbox whose only writable places are that baseline and ~/queue/pending (the wrapper orchestrator 2 installs as
# the hook runs `sx-sandbox --write ~/work/baselines/<src tree> --write ~/queue/pending -- baseline.sh <tree> <sha>`),
# and queues each job so that it runs in one whose only writable places are that baseline and its own scratch in
# /dev/shm, its TMPDIR, removed when the job ends. A write anywhere else fails with EROFS. Reads are not limited.
#
# The hook, installed on a worker as ~/work/trees/hooks/baseline, which `sx-tree` runs with each new `main`'s tree and
# SHA, fills what builders did not store; it writes nothing itself, every write being the state module's. It makes or
# joins the tree's baseline (`state`, which appends the commit) and returns at once where the baseline is not this
# tool's, holds foreign contents or the
# runs of other inputs, every area is complete or a writer is storing one. Else `queue` leaves a copy of this script in
# the baseline for its jobs, so that a later install does not change a fill already queued, and undoes the tree's
# SUPERSEDED (the tree is the current one again); then the hook queues one job per shard to store that has no job
# pending or running (`sx-queue status`): 16 per area or its PLAN's count (`sx-queue add --owner baseline`, priority 7,
# of which the queue runs at most two at once, lead 2026-10-31, so a fill takes idle cores). `sx-tree` runs its hooks
# one at a time. A job runs the copy, decides with `start` (below) and runs the tree's runner (`--store`), which ends at
# once where its shard verifies or another running writer stores it; a job ends 0 where its shard then verifies or is
# being stored.
#
# Supersession (#1513, by tree; #1567): `start` decides for each job of a fill. Where the tree is the current one (the
# `src/` tree of the clone's origin/main), it undoes SUPERSEDED and writes STARTED, the time the fill began, once; where
# it is not, it writes SUPERSEDED (the current tree) and the job ends at once, also where the fill STARTED, so that the
# current tree's fill does not wait behind it. A job already storing finishes its shard; the shards stored stay and
# status reads them as any others, so a fill cut short stays incomplete. SUPERSEDED is undone where the tree is current
# again, by the hook (`queue`) or by a job, and the fill resumes with its stored shards. A builder's store is never
# superseded. A decision that could not be written fails the job.
#
# A tree whose runner has no baselines.mjs (from before #1541) is skipped, unless BASELINE_RUNNER names a built
# checkout that has one. BASELINE_PRIORITY (7), BASELINE_MEM (3G, each job's memory cap), BASELINE_REPO (the clone
# that resolves the current tree, else sx-tree's) and BASELINE_SANDBOX (sx-sandbox, as each job finds it) override the
# defaults.
set -uo pipefail
root=$HOME/work/baselines
repo=${BASELINE_REPO:-$HOME/src/teasescript-platform}
[ -n "${BASELINE_REPO:-}" ] || [ -d "$repo" ] || repo=$HOME/src/wqaed401/teasescript-platform

if [ "${1:-}" = --job ]; then
  # one shard of a fill, run by its queued job: --job <baseline> <tree> <runner> <area folder> <i> <N> <clone>
  out=$2 tree=$3 runner=$4 folder=$5 i=$6 n=$7 repo=$8
  if ! current=$(git -C "$repo" rev-parse --verify -q refs/remotes/origin/main:src); then
    echo "baseline ${out##*/}: $repo has no origin/main to name the current tree" >&2
    exit 1
  fi
  # whether the fill runs, decided by its first job through the state module (see above)
  if ! decided=$(node "$runner/tests/families/baselines.mjs" start "$out" "$current"); then
    echo "baseline ${out##*/}: $(jq -r .refused <<< "$decided" 2> /dev/null)" >&2
    exit 1
  fi
  if [ "$(jq -r .decision <<< "$decided")" = superseded ]; then
    echo "baseline ${out##*/}: ${folder##*/} $i/$n superseded by the current tree $current"
    exit 0
  fi
  ended=$(node "$runner/tests/families/run.mjs" "$folder" "$tree" --store "${out%/*}" --shard "$i/$n" | tee /dev/stderr |
    tail -n 1)
  grep -q '"verified":true\|"skipped":' <<< "$ended"
  exit
fi

if [ "${1:-}" = status ]; then
  if [ $# -ne 2 ]; then
    echo "usage: $0 status <commit or built tree>" >&2
    exit 2
  fi
  if [ -f "$2/.sha" ]; then tree=$2; elif ! tree=$(sx-tree "$2"); then exit 2; fi
  if [ ! -e "$tree/tests/families/baselines.mjs" ]; then
    echo "baseline $2: its runner predates the src/-tree baselines (#1541)" >&2
    exit 2
  fi
  lines=$(node "$tree/tests/families/baselines.mjs" state "$tree" "$root" --read-only)
  status=$?
  [ -n "$lines" ] || exit 2
  jq -rs --arg of "$2" '
    (map(select(.area))) as $areas | (map(select(.baseline)) | .[0]) as $baseline |
    if $baseline.refused then "baseline \($of): \($baseline.refused)"
    else "baseline \($of): src tree \($baseline.src), \($baseline.baseline): " + (
      if $baseline.complete then "complete: " + ([$areas[].area] | join(" "))
      else "incomplete: " + (
        ([$areas[] | select(.state == "complete") | .area] | if length > 0 then [join(" ") + " complete"] else [] end)
        + [$areas[] | select(.state != "complete")
            | .area + " " + .state + (if .shards then " \(.verified)/\(.shards)" else "" end)]
        | join("; "))
      end)
    end' <<< "$lines"
  exit "$status"
fi

if [ $# -ne 2 ] || ! [[ $2 =~ ^[0-9a-f]{40}$ ]]; then
  echo "usage: $0 <built tree> <its full SHA> | status <commit or built tree>" >&2
  exit 2
fi
tree=$1 sha=$2
if [ "$(cat "$tree/.sha" 2> /dev/null)" != "$sha" ] || [ ! -d "$tree/dist" ]; then
  echo "baseline $sha: $tree is no built tree of it" >&2
  exit 2
fi
runner=${BASELINE_RUNNER:-$tree}
modules=$runner/tests/families
if [ ! -e "$modules/baselines.mjs" ]; then
  echo "baseline $sha: skipped, the runner in $runner predates the src/-tree baselines (#1541)"
  exit 0
fi
fail() {
  echo "baseline $sha: $*" >&2
  exit 1
}
lines=$(node "$modules/baselines.mjs" state "$tree" "$root")
status=$?
baseline=$(tail -n 1 <<< "$lines")
src=$(jq -r '.src // empty' <<< "$baseline" 2> /dev/null)
out=$(jq -r '.baseline // empty' <<< "$baseline" 2> /dev/null)
[ -n "$src" ] && [ -n "$out" ] || fail "its state could not be read"
if [ "$status" = 2 ]; then
  echo "baseline $sha: no fill, $(jq -r .refused <<< "$baseline")"
  exit 0
fi
if [ "$status" = 0 ]; then
  echo "baseline $sha: complete in $out"
  exit 0
fi
if [ "$(jq -r .storing <<< "$baseline")" = true ]; then
  echo "baseline $sha: a writer is storing into $out"
  exit 0
fi
# the jobs run a copy of this script in the baseline, so that a later install does not change a fill already queued,
# and the tree is the current one again, so its SUPERSEDED is undone: both through the state module (see above)
if ! copied=$(node "$modules/baselines.mjs" queue "$out" "$0"); then
  echo "baseline $sha: no fill, $(jq -r .refused <<< "$copied" 2> /dev/null)"
  exit 0
fi
# each job runs the copy under the sandbox (above): only the baseline and the job's own scratch, its TMPDIR, are
# writable; the scratch is removed when the job ends
job='scratch=/dev/shm/baseline-job-$$
"${BASELINE_SANDBOX:-sx-sandbox}" --write "$1" --write "$scratch" -- env TMPDIR="$scratch" bash "$1/baseline.sh" --job "$@"
ended=$?
rm -rf -- "$scratch"
exit "$ended"'
# the jobs of the tree pending or running, by name (their files are <priority>-<time>-<name>.job): a shard with one is
# not queued again
waiting=$({ sx-queue status --pending && sx-queue status --running; } 2> /dev/null |
  sed -n "s/^[0-9]*-[0-9]*-\(baseline-${src:0:9}-.*\)\.job$/\1/p")
queued=0 unqueued=0
while IFS=$'\t' read -r folder n shards; do
  area=${folder##*/}
  if [ "$shards" = all ]; then shards=$(seq -s, 0 $((n - 1))); fi
  for i in ${shards//,/ }; do
    grep -qxF -- "baseline-${src:0:9}-$area-$i" <<< "$waiting" && continue
    if SX_HEAVY_MEM=${BASELINE_MEM:-3G} sx-queue add --owner baseline --priority "${BASELINE_PRIORITY:-7}" --dir "$out" \
      --name "baseline-${src:0:9}-$area-$i" -- bash -c "$job" baseline-job "$out" "$tree" "$runner" "$folder" "$i" \
      "$n" "$repo" > /dev/null; then
      queued=$((queued + 1))
    else
      unqueued=$((unqueued + 1))
    fi
  done
done < <(jq -r 'select(.area and .store and .store != [])
  | [.folder, (.shards // 16), (if .store == "all" then "all" else (.store | map(tostring) | join(",")) end)] | @tsv' \
  <<< "$lines")
jq -r 'select(.state == "another plan") | "baseline: \(.area) is planned otherwise, not filled"' <<< "$lines"
[ "$unqueued" -eq 0 ] || fail "$unqueued jobs not queued ($queued queued now); call again to queue them"
if [ "$queued" -eq 0 ]; then
  echo "baseline $sha: a fill of $out is queued or running"
else
  echo "baseline $sha: queued $queued jobs for src tree $src in $out"
fi
