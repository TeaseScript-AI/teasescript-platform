#!/bin/bash
# tools/corpus/baseline.sh <built tree> <its full SHA>      the hook: fills the baseline of a new `main`'s src/ tree
# tools/corpus/baseline.sh status <commit or built tree>     one line: what the baseline of its src/ tree holds
# tools/corpus/baseline.sh seed <built tree> <its full SHA> <out>
# tools/corpus/baseline.sh compute <built tree> <seed baseline> <area> <i>/<N> <out>
# tools/corpus/baseline.sh submit <SHA> <src tree> [<seed job id> <shards.tsv>] [--dry]
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
# A fill on any worker into a central store (#1590), each step a central-queue job (`submit`), each shard imported into
# the central store by `baselines.mjs import` alone:
# - `seed` makes <out>/<src tree>/ a new baseline of the tree (`baselines.mjs seed`: as `state` makes it, named by the
#   tree's build of the compiler, `compiled <dist/src/ tree>`, with the PLAN of every area and no shard) and
#   <out>/shards.tsv, one line per shard to store (`<area>\t<i>\t<N>`).
# - `compute` stores one shard from the seed baseline into a new copy of it in its scratch (`import`, `compiled`, then the
#   tree's runner, under sx-sandbox where it is found, only the scratch writable). Where sources stalled, it stores
#   them again alone at the PLAN's limits (`baselines.mjs alone`): a source that ends alone stalled under the machine's
#   load, and the whole shard is stored once more, which fails (exit 1) where a source stalls that did not stall alone; a
#   source that stalls alone stalls on its own and stays. Then <out>/<src tree>/ is that copy's MANIFEST, PLANs and shard
#   (`import`), and <out>/stalls.json lists each stall with its run alone (`baselines.mjs stalls`), as `import` requires.
#   Its scratch is a new folder in $SX_SCRATCH (the central queue's, removed with the job), else in TMPDIR.
# - `submit` prints (`--dry`) or submits the fill's jobs, one line each: the seed's, or with the seed's job id and its
#   shards.tsv one per shard (`sx-job submit … -- bash -c '…'`; #1590's lines, whose command runs without a shell).
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
# Supersession (#1513, by tree): `start` decides for each job of a fill. Where the tree is the current one (the `src/`
# tree of the clone's origin/main), it undoes SUPERSEDED and writes STARTED, the time the fill began, once; where it is
# not and the fill has not STARTED, it writes SUPERSEDED (the current tree) and the job ends at once. A fill that STARTED
# runs to its end (#1590, reversing #1567: a fill cut short was never read), so a newer tree's fill waits behind it.
# SUPERSEDED is undone where the tree is current again, by the hook (`queue`) or by a job. A builder's store is never
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
  # whether this job stores, decided through the state module (see above)
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

if [ "${1:-}" = seed ]; then
  if [ $# -ne 4 ] || ! [[ $3 =~ ^[0-9a-f]{40}$ ]]; then
    echo "usage: $0 seed <built tree> <its full SHA> <out>" >&2
    exit 2
  fi
  if [ "$(cat "$2/.sha" 2> /dev/null)" != "$3" ] || [ ! -d "$2/dist" ]; then
    echo "baseline $3: $2 is no built tree of it" >&2
    exit 2
  fi
  node "$2/tests/families/baselines.mjs" seed "$2" "$4"
  exit
fi

if [ "${1:-}" = compute ]; then
  if [ $# -ne 6 ] || ! [[ $5 =~ ^(0|[1-9][0-9]*)/([1-9][0-9]*)$ ]] || [ "${5%/*}" -ge "${5#*/}" ]; then
    echo "usage: $0 compute <built tree> <seed baseline> <area> <i>/<N> <out>" >&2
    exit 2
  fi
  tree=$2 seed=${3%/} area=$4 i=${5%/*} n=${5#*/} out=$6
  src=${seed##*/} state=$tree/tests/families/baselines.mjs runner=$tree/tests/families/run.mjs
  folder=$tree/tests/families/$area
  [ "$area" != fixture ] || folder=$tree/tools/corpus/fixture
  if [ ! -f "$tree/.sha" ] || [ ! -d "$tree/dist" ] || [ ! -d "$folder" ] || [ ! -f "$seed/MANIFEST" ]; then
    echo "baseline compute: $tree is no built tree with the area $area, or $seed no seed baseline" >&2
    exit 2
  fi
  work=$(mktemp -d "${SX_SCRATCH:-${TMPDIR:-/tmp}}/baseline-compute.XXXXXX") || exit 2
  fail() {
    echo "baseline ${src:0:9} $area $i/$n: $*" >&2
    exit 1
  }
  # a store into a folder of baselines in the scratch, under sx-sandbox where it is found (only the scratch writable):
  # whether its shard then counts
  stored() {
    local sandbox=("${BASELINE_SANDBOX:-sx-sandbox}" --write "$work" --) ended
    command -v "${sandbox[0]}" > /dev/null || sandbox=()
    ended=$("${sandbox[@]}" env TMPDIR="$work" node "$runner" "$1" "$tree" --store "$2" --shard "$3" |
      tee /dev/stderr | tail -n 1)
    grep -q '"verified":true\|"skipped":"stored"' <<< "$ended"
  }
  # the shard stored into a new copy of the seed baseline, named by this tree's build
  copy() {
    node "$state" import "$1" "${seed%/*}" >&2 && node "$state" compiled "$tree" "$1" >&2 &&
      stored "$folder" "$1" "$i/$n" && [ -f "$1/$src/$area/${i}of${n}.runs.jsonl" ]
  }
  take=$work/first
  copy "$take" || fail "the shard could not be stored from the seed $seed"
  stalled=$(node "$state" alone "$folder" "$take/$src/$area/${i}of${n}.runs.jsonl" "$work/alone/$area") || exit 2
  ran=-
  if [ "$(jq -r .stalled <<< "$stalled")" != 0 ]; then
    ran=$work/alone-root/$src/$area/0of1.runs.jsonl
    stored "$work/alone/$area" "$work/alone-root" 0/1 || fail "its stalled sources could not be stored alone"
    if ! node "$state" stalls "$take/$src/$area/${i}of${n}.runs.jsonl" "$ran" "$area" "$i/$n" "$work/stalls.json" >&2; then
      # a source that ended alone stalled under the machine's load: the whole shard once more
      take=$work/second
      copy "$take" || fail "the shard could not be stored again"
      node "$state" stalls "$take/$src/$area/${i}of${n}.runs.jsonl" "$ran" "$area" "$i/$n" "$work/stalls.json" >&2 ||
        fail "sources stalled in two stores that did not stall alone, under the load of the machine"
    fi
  fi
  node "$state" import "$out" "$take" >&2 &&
    node "$state" stalls "$take/$src/$area/${i}of${n}.runs.jsonl" "$ran" "$area" "$i/$n" "$out/stalls.json" >&2 &&
    node "$state" import "$out" "$take" "$area" "$i/$n" "$out/stalls.json"
  exit
fi

if [ "${1:-}" = submit ]; then
  dry=false named=()
  for arg in "${@:2}"; do
    if [ "$arg" = --dry ]; then dry=true; else named+=("$arg"); fi
  done
  set -- "${named[@]}"
  if ! { [ $# -eq 2 ] || { [ $# -eq 4 ] && [[ $3 =~ ^[0-9a-z]+$ ]] && [ -f "$4" ]; }; } ||
    ! [[ $1 =~ ^[0-9a-f]{40}$ && $2 =~ ^[0-9a-f]{40}$ ]]; then
    echo "usage: $0 submit <SHA> <src tree> [<seed job id> <shards.tsv>] [--dry]" >&2
    exit 2
  fi
  sha=$1 src=$2 fill=fill-${2:0:9}
  # one job of the fill: its command line printed (`--dry`), else submitted and its name and id printed
  job() {
    local program=$1 id
    shift
    if $dry; then
      printf "sx-job submit %s -- bash -c '%s'\n" "$*" "$program"
    elif id=$(sx-job submit "$@" -- bash -c "$program"); then
      echo "$4 $id" # (its name, the fourth option word, and its id)
    else
      return 1
    fi
  }
  script='bash "$SX_TREE/tools/corpus/baseline.sh"'
  if [ $# -eq 2 ]; then
    job "$script seed \"\$SX_TREE\" $sha \"\$SX_OUT\"" --owner baseline --name "$fill-seed" --priority background \
      --commit "$sha"
    exit
  fi
  unsubmitted=0
  while IFS=$'\t' read -r area i n; do
    if ! [[ $area =~ ^[A-Za-z0-9._-]+$ && $i =~ ^[0-9]+$ && $n =~ ^[0-9]+$ ]] || [ "$i" -ge "$n" ]; then
      echo "baseline submit: $4 holds a line that is no shard: $area $i $n" >&2
      exit 2
    fi
    job "$script compute \"\$SX_TREE\" \"\$SX_IN/seed/out/$src\" $area $i/$n \"\$SX_OUT\"" --owner baseline \
      --name "$fill-$area-$i" --priority background --campaign "$fill" --commit "$sha" --in-result "seed=$3" ||
      unsubmitted=$((unsubmitted + 1))
  done < "$4"
  [ "$unsubmitted" -eq 0 ] || { echo "baseline submit: $unsubmitted jobs not submitted" >&2; exit 1; }
  exit 0
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
