#!/bin/bash
# tools/corpus/baseline.sh <built tree> <its full SHA>      the hook: fills the baseline of a new `main`'s src/ tree
# tools/corpus/baseline.sh status <commit or built tree>     one line: what the baseline of its src/ tree holds
#
# The stored baseline (owner, 2026-10-30; keyed by the `src/` tree, #1541): the corpus runner's runs of one tree, stored
# so that a pull request runs only its head against them (`run.mjs <area> <head> --baseline <baseline>/<area>`).
# tests/families/baselines.mjs reads and writes every baseline, ~/work/baselines/<src tree>/: its MANIFEST (what its runs
# depend on, the commits stored there, each area's PLAN), shards that count only once verified, `state` and `prune`.
# Builders store with `run.mjs <area> <tree> --store ~/work/baselines --shard i/16`. `status` prints `state --read-only`
# of the commit's shared tree (`sx-tree` builds it once where it is missing) as one line, and exits as it does: 0 only
# when every area is complete, 2 where the baseline is not this tool's or holds runs of other inputs.
#
# The hook, installed on a worker as ~/work/trees/hooks/baseline, which `sx-tree` runs with each new `main`'s tree and
# SHA, fills what builders did not store. It retires what `prune` finds (and names a baseline it keeps for foreign
# contents), makes or joins the tree's baseline (`state`, which appends the commit) and returns at once where the
# baseline is not this tool's, holds foreign contents or the runs of other inputs, every area is complete or a writer is
# storing one. Else it removes the tree's SUPERSEDED (the tree is the current one again) and queues one job per shard to
# store that has no job pending or running (`sx-queue status`): 16 per area or its PLAN's count (`sx-queue add --owner
# baseline`, priority 7, of which the queue runs at most two at once, lead 2026-10-31, so a fill takes idle cores). Jobs
# run the copy of this script the call left in the baseline (baseline.sh) and the tree's runner (`--store`), which ends
# at once where its shard verifies or another running writer stores it; a job ends 0 where its shard then verifies or
# is being stored.
#
# Supersession (#1513, by tree): the first job to start decides under the baseline's .start.lock. Where its tree is
# the current one (the `src/` tree of the clone's origin/main), it removes SUPERSEDED and writes STARTED; where it is not
# and the fill has not STARTED, it writes SUPERSEDED (the current tree) and every such job ends at once; a STARTED fill
# runs to its end. SUPERSEDED is undone where the tree is current again, by the hook or by a job. A builder's store is
# never superseded. A marker that could not be written fails the job.
#
# A tree whose runner has no baselines.mjs (from before #1541) is skipped, unless BASELINE_RUNNER names a built
# checkout that has one. BASELINE_PRIORITY (7), BASELINE_MEM (3G, each job's memory cap) and BASELINE_REPO (the clone
# that resolves the current tree, else sx-tree's) override the defaults.
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
  # whether the fill runs, decided by its first job (see above)
  exec {start}>> "$out/.start.lock"
  flock "$start"
  if [ "$current" = "${out##*/}" ]; then
    rm -f "$out/SUPERSEDED"
    if [ ! -e "$out/STARTED" ]; then
      { date -u +%Y-%m-%dT%H:%M:%SZ > "$out/STARTED.tmp" && mv "$out/STARTED.tmp" "$out/STARTED"; } || exit 1
    fi
  elif [ ! -e "$out/STARTED" ]; then
    { echo "$current" > "$out/SUPERSEDED.tmp" && mv "$out/SUPERSEDED.tmp" "$out/SUPERSEDED"; } || exit 1
    echo "baseline ${out##*/}: ${folder##*/} $i/$n superseded by the current tree $current"
    exit 0
  fi
  exec {start}>&-
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
node "$modules/baselines.mjs" prune "$root" | jq -r 'if .pruned then "baseline \(.pruned): removed with its trees"
  else "baseline \(.kept): kept for its foreign contents: \(.foreign | join(", "))" end' || fail "pruning $root failed"
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
exec {lock}>> "$out/.queue.lock"
if ! flock -n "$lock"; then
  echo "baseline $sha: another call is queueing $out"
  exit 0
fi
# the tree is the current one again: its fill runs (see above)
rm -f "$out/SUPERSEDED"
# the jobs run this copy, so that a later install does not change a fill already queued
{ cp "$0" "$out/baseline.sh.tmp" && mv "$out/baseline.sh.tmp" "$out/baseline.sh"; } || fail "this script could not be copied"
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
      --name "baseline-${src:0:9}-$area-$i" -- bash "$out/baseline.sh" --job "$out" "$tree" "$runner" "$folder" "$i" \
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
