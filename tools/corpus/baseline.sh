#!/bin/bash
# tools/corpus/baseline.sh <built tree> <its full SHA>   the hook: fills the baseline of a new `main`'s src/ tree
# tools/corpus/baseline.sh status <commit>               one line: what the baseline of the commit's src/ tree holds
#
# The stored baseline (owner, 2026-10-30): the corpus runner's runs of one tree, stored so that a pull request runs only
# its head against them (`tests/families/run.mjs <area> <head> --baseline <baseline>/<area>`). A baseline is keyed by
# its `src/` tree (lead, 2026-10-31): ~/work/baselines/<src tree>/, named by `git rev-parse <commit>:src` and shared by
# every commit with that tree, so a merge that leaves `src/` as it was is an alias of the baseline before it and makes
# no new one. Its MANIFEST names each commit known to share it (appended, never rewritten). The runner writes it
# (`run.mjs <area> <tree> --store ~/work/baselines --shard i/16`): an area in <baseline>/<area>/, one file per shard,
# each whole or not at all, beside PLAN (the set of the area's sources and its count of shards) and, once every shard is
# stored, SHA256SUMS; an area whose SHA256SUMS are missing or do not verify is not complete. Builders store their base
# this way; `status` says which areas a commit's tree holds, and exits 0 only when every area is complete.
#
# The hook, installed on a worker as ~/work/trees/hooks/baseline, which `sx-tree` runs with each new `main`'s tree and
# SHA, fills what builders did not store. It appends the commit to its tree's MANIFEST, then returns at once where every
# area is complete, a writer is storing one (a running writer's claim) or a fill is queued (QUEUED); else it queues one
# job per shard not stored of each area not complete (`sx-queue add --owner baseline`, priority 7, of which the queue runs
# at most two at once, lead 2026-10-31, so the fill takes idle cores), writes QUEUED and returns. The areas are the
# folders of tests/families/ with generators and the type-core fixture (tools/corpus/fixture/), in 16 shards each (an
# area already begun, in its PLAN's count). A job runs the tree's runner, which skips a shard stored or being stored, so
# a duplicate job ends at once, and ends 0 once its shard is stored; a job whose area has every shard stored writes its
# missing SHA256SUMS. After a job died, remove QUEUED and call again. Jobs run the copy of this script the call left in
# the baseline. A baseline goes with its trees: once none of the trees its MANIFEST names remains (`sx-tree --prune`)
# and no writer is storing, the next call removes it; a folder of the per-commit hook (#1512) goes with its tree.
#
# A fill none of whose jobs has started is skipped when a newer `main`'s is queued (#1513, by tree): the first job of
# the fill to start decides for all of them, under the baseline's .start.lock. When another baseline has QUEUED and its
# MANIFEST names a commit on the clone's origin/main that descends from a commit of this one, and from which none of
# this one's commits descends, it writes SUPERSEDED (that commit) and every job of the fill ends without running; else
# it writes STARTED and every job runs. Baselines differ by tree, so a merge that leaves `src/` as it was supersedes
# nothing. A marker that could not be written fails the job and leaves the decision to the next. A builder's store is
# never superseded.
#
# A tree whose runner cannot store a baseline (from before this script) is skipped, unless BASELINE_RUNNER names a built
# checkout whose runner and fixture area run it instead. BASELINE_PRIORITY (7), BASELINE_MEM (3G, each job's memory cap)
# and BASELINE_REPO (the clone that resolves commits, else sx-tree's) override the defaults.
set -uo pipefail
root=$HOME/work/baselines
repo=${BASELINE_REPO:-$HOME/src/teasescript-platform}
[ -n "${BASELINE_REPO:-}" ] || [ -d "$repo" ] || repo=$HOME/src/wqaed401/teasescript-platform

# whether a claim (the pid and start time of its writer, as the runner writes it) names a running process
running() {
  local pid start
  read -r pid start < "$1" 2> /dev/null && [ -n "$start" ] &&
    [ "$(sed 's/.*) //' "/proc/$pid/stat" 2> /dev/null | cut -d' ' -f20)" = "$start" ]
}

# whether a writer is storing a shard of the area in folder $1
claimed() {
  local claim
  for claim in "$1"/.*.claim; do
    [ -e "$claim" ] && running "$claim" && return 0
  done
  return 1
}

# whether a writer is storing into the baseline in folder $1
storing() {
  local area
  for area in "$1"/*/; do
    claimed "${area%/}" && return 0
  done
  return 1
}

# the commits the MANIFEST of the baseline in folder $1 names
commits() { sed -n 's/^commit \([0-9a-f]\{40\}\) .*/\1/p' "$1/MANIFEST" 2> /dev/null; }

# the commit of a newer `main`'s fill queued beside the baseline in folder $1, if any (see above)
superseding() {
  local out=$1 other newer own descends
  for other in "${out%/*}"/*/; do
    other=${other%/}
    [ "$other" != "$out" ] && [ -e "$other/QUEUED" ] &&
      [ "$(head -n 1 "$other/MANIFEST" 2> /dev/null)" = "baseline 3" ] || continue
    for newer in $(commits "$other"); do
      git -C "$repo" merge-base --is-ancestor "$newer" refs/remotes/origin/main 2> /dev/null || continue
      descends=0
      for own in $(commits "$out"); do
        # (a commit of this baseline that is newer still)
        git -C "$repo" merge-base --is-ancestor "$newer" "$own" 2> /dev/null && continue 2
        git -C "$repo" merge-base --is-ancestor "$own" "$newer" 2> /dev/null && descends=1
      done
      if [ "$descends" = 1 ]; then
        echo "$newer"
        return 0
      fi
    done
  done
  return 1
}

if [ "${1:-}" = --job ]; then
  # one shard of a fill, run by its queued job: --job <baseline> <tree> <runner> <area folder> <i> <N> <clone>
  out=$2 tree=$3 runner=$4 folder=$5 i=$6 n=$7 repo=$8
  # whether the fill runs, decided by its first job and bound by the marker (see above)
  exec {start}>> "$out/.start.lock"
  flock "$start"
  if [ ! -e "$out/STARTED" ] && [ ! -e "$out/SUPERSEDED" ]; then
    marker=STARTED value=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    if newer=$(superseding "$out"); then marker=SUPERSEDED value=$newer; fi
    { echo "$value" > "$out/$marker.tmp" && mv "$out/$marker.tmp" "$out/$marker"; } || exit 1
  fi
  exec {start}>&-
  if [ -e "$out/SUPERSEDED" ]; then
    echo "baseline ${out##*/}: ${folder##*/} $i/$n superseded by $(cat "$out/SUPERSEDED")"
    exit 0
  fi
  node "$runner/tests/families/run.mjs" "$folder" "$tree" --store "${out%/*}" --shard "$i/$n"
  [ -e "$out/${folder##*/}/${i}of$n.runs.jsonl" ]
  exit
fi

if [ "${1:-}" = status ]; then
  if [ $# -ne 2 ]; then
    echo "usage: $0 status <commit>" >&2
    exit 2
  fi
  commit=$2
  # the commit in sx-tree's clone (BASELINE_REPO), else in the repository around the current folder
  git -C "$repo" cat-file -e "$commit^{commit}" 2> /dev/null || repo=.
  if ! src=$(git -C "$repo" rev-parse --verify -q "$commit:src"); then
    echo "baseline $commit: no commit with src/ in sx-tree's clone or here" >&2
    exit 2
  fi
  out=$root/$src
  areas=()
  for area in $(git -C "$repo" ls-tree -d --name-only "$commit:tests/families"); do
    git -C "$repo" ls-tree --name-only "$commit:tests/families/$area" | grep -q '\.mjs$' && areas+=("$area")
  done
  git -C "$repo" cat-file -e "$commit:tools/corpus/fixture" 2> /dev/null && areas+=(fixture)
  complete=() states=()
  for area in "${areas[@]}"; do
    dir=$out/$area
    n=$(sed -n 's/^shards //p' "$dir/PLAN" 2> /dev/null)
    have=$(compgen -G "$dir/*of$n.runs.jsonl" | wc -l)
    if [ -e "$dir/SHA256SUMS" ] && (cd "$dir" && sha256sum --quiet --status -c SHA256SUMS); then
      complete+=("$area")
    elif [ -e "$dir/SHA256SUMS" ]; then
      states+=("$area damaged")
    elif [ -n "$n" ] && claimed "$dir"; then
      states+=("$area storing $have/$n")
    elif [ -n "$n" ]; then
      states+=("$area partial $have/$n")
    else
      states+=("$area absent")
    fi
  done
  line="baseline $commit: src tree $src, $out:"
  if [ "${#states[@]}" -eq 0 ]; then
    echo "$line complete: ${complete[*]}"
    exit 0
  fi
  [ "${#complete[@]}" -eq 0 ] || states=("${complete[*]} complete" "${states[@]}")
  printf '%s incomplete: %s' "$line" "${states[0]}"
  printf '; %s' "${states[@]:1}"
  echo
  exit 1
fi

if [ $# -ne 2 ] || ! [[ $2 =~ ^[0-9a-f]{40}$ ]]; then
  echo "usage: $0 <built tree> <its full SHA> | status <commit>" >&2
  exit 2
fi
tree=$1 sha=$2
if [ "$(cat "$tree/.sha" 2> /dev/null)" != "$sha" ] || [ ! -d "$tree/dist" ]; then
  echo "baseline $sha: $tree is no built tree of it" >&2
  exit 2
fi
fail() {
  echo "baseline $sha: $*" >&2
  exit 1
}
mkdir -p "$root"
# a baseline goes with its trees (see above); a per-commit one with its tree
for manifest in "$root"/*/MANIFEST; do
  dir=${manifest%/MANIFEST}
  if [ "$(head -n 1 "$manifest" 2> /dev/null)" = "baseline 3" ]; then
    named=0 kept=0
    while read -r _ _ path; do
      named=$((named + 1))
      [ -d "$path" ] && kept=1
    done < <(grep '^commit ' "$manifest")
    if [ "$named" -gt 0 ] && [ "$kept" = 0 ] && ! storing "$dir"; then
      rm -rf "$dir" && echo "baseline ${dir##*/}: removed with its trees"
    fi
  else
    old=$(sed -n 's/^tree //p' "$manifest" 2> /dev/null)
    if [ -n "$old" ] && [ ! -d "$old" ]; then
      rm -rf "$dir" && echo "baseline ${dir##*/}: removed with its tree"
    fi
  fi
done
src=$(git -C "$repo" rev-parse --verify -q "$sha:src") || fail "$repo has no src/ tree of it"
out=$root/$src
# the commit in the baseline's MANIFEST, made whole on first use
mkdir -p "$out" || fail "$out could not be made"
header=$(printf 'baseline 3\nsrc %s' "$src")
if [ ! -e "$out/MANIFEST" ]; then
  printf '%s\n' "$header" > "$out/MANIFEST.$$.tmp" && ln "$out/MANIFEST.$$.tmp" "$out/MANIFEST" 2> /dev/null
  rm -f "$out/MANIFEST.$$.tmp"
fi
[ "$(head -n 2 "$out/MANIFEST" 2> /dev/null)" = "$header" ] || fail "$out/MANIFEST is no MANIFEST of this baseline"
grep -qxF "commit $sha $tree" "$out/MANIFEST" || echo "commit $sha $tree" >> "$out/MANIFEST" ||
  fail "MANIFEST could not be written"
runner=${BASELINE_RUNNER:-$tree}
if ! grep -q 'baseline 3' "$runner/tests/families/run.mjs" 2> /dev/null; then
  echo "baseline $sha: skipped, the runner in $runner cannot store a baseline"
  exit 0
fi

# the areas not complete, each with its folder
missing=()
for folder in "$tree"/tests/families/*/ "$runner/tools/corpus/fixture/"; do
  compgen -G "$folder*.mjs" > /dev/null || continue
  folder=${folder%/}
  [ -e "$out/${folder##*/}/SHA256SUMS" ] || missing+=("$folder")
done
if [ "${#missing[@]}" -eq 0 ]; then
  echo "baseline $sha: complete in $out"
  exit 0
fi
if storing "$out"; then
  echo "baseline $sha: a writer is storing into $out"
  exit 0
fi
exec {lock}>> "$out/.queue.lock"
if ! flock -n "$lock"; then
  echo "baseline $sha: another call is queueing $out"
  exit 0
fi
if [ -e "$out/QUEUED" ]; then
  echo "baseline $sha: a fill of $out is queued, running or done"
  exit 0
fi
# the jobs run this copy, so that a later install does not change a fill already queued
{ cp "$0" "$out/baseline.sh.tmp" && mv "$out/baseline.sh.tmp" "$out/baseline.sh"; } || fail "this script could not be copied"
queued=0 unqueued=0
for folder in "${missing[@]}"; do
  area=${folder##*/}
  n=$(sed -n 's/^shards //p' "$out/$area/PLAN" 2> /dev/null)
  [[ $n =~ ^[1-9][0-9]*$ ]] || n=16
  jobs=()
  for ((i = 0; i < n; i++)); do
    [ -e "$out/$area/${i}of$n.runs.jsonl" ] || jobs+=("$i")
  done
  # (every shard stored, SHA256SUMS missing: one job writes them)
  [ "${#jobs[@]}" -gt 0 ] || jobs=(0)
  for i in "${jobs[@]}"; do
    if SX_HEAVY_MEM=${BASELINE_MEM:-3G} sx-queue add --owner baseline --priority "${BASELINE_PRIORITY:-7}" --dir "$out" \
      --name "baseline-${src:0:9}-$area-$i" -- bash "$out/baseline.sh" --job "$out" "$tree" "$runner" "$folder" "$i" \
      "$n" "$repo" > /dev/null; then
      queued=$((queued + 1))
    else
      unqueued=$((unqueued + 1))
    fi
  done
done
[ "$unqueued" -eq 0 ] || fail "$unqueued jobs not queued ($queued queued now); call again to queue them"
date -u +%Y-%m-%dT%H:%M:%SZ > "$out/QUEUED" || fail "QUEUED could not be written; call again"
echo "baseline $sha: queued $queued jobs for src tree $src in $out"
