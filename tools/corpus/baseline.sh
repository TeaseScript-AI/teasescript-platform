#!/bin/bash
# tools/corpus/baseline.sh <built tree> <its full SHA>
#
# The stored baseline of a `main` commit (owner, 2026-10-30): the corpus runner's runs of the tree alone, stored so that
# a pull request runs only its head against them (`tests/families/run.mjs <area> <head> --baseline <folder>`). Installed
# on a worker as ~/work/trees/hooks/baseline, which `sx-tree` runs with each new `main`'s tree and SHA. It queues one
# job (`sx-queue add --owner baseline`) per shard of each area and returns: the runner's areas (the folders of
# tests/families/ with generators) and the type-core fixture (tools/corpus/fixture/), the smallest first, each in one
# shard per hundred sources, at least one and at most one per queue slot. A shard stores its runs at the runner's
# defaults (180 s, 2,048 MB) in ~/work/baselines/<sha>/<area>/<i>of<N>.runs.jsonl, beside its `--out` (.out.jsonl),
# its JSON lines (.stdout), .stderr and state (.exit: `complete` or `failed`, and the runner's exit status). A shard is
# complete when the runner ended with its total line (exit 0, or 1 for a stall, an exception or nodes left unanswered,
# which are stored like any outcome) and stored one line per source; a failed shard fails its job. The area's last
# shard to end writes SHA256SUMS when every shard is complete, else INCOMPLETE naming the failed ones; an area with
# neither is still running or lost a job. ~/work/baselines/<sha>/MANIFEST holds the plan and each queued job, with
# this script's and the runner's hashes, and QUEUED marks a baseline whose every job was queued, which is not queued
# again. A call whose submission failed exits 1; calling it again queues the missing jobs. To redo a baseline, remove
# its folder. A baseline goes with its tree: once `sx-tree --prune` removed the tree, the next call removes it.
#
# The tree's own runner runs its own areas. A tree whose runner cannot store runs (from before this script) is skipped,
# unless BASELINE_RUNNER names a built checkout whose runner and fixture area run it instead. BASELINE_PRIORITY (6),
# BASELINE_MEM (3G, each job's memory cap) and BASELINE_SLOTS (the queue workers' slots but the one sx-heavy keeps for
# direct runs, else the CPU count) override the defaults.
set -uo pipefail

if [ "${1:-}" = --job ]; then
  # one shard, run by its queued job: --job <baseline folder> <tree> <runner> <area> <area folder> <i> <N>
  out=$2 tree=$3 runner=$4 area=$5 folder=$6 i=$7 n=$8
  dir=$out/$area
  name=$dir/${i}of$n
  mkdir -p "$dir"
  node "$runner/tests/families/run.mjs" "$folder" "$tree" --store "$name.runs.jsonl" --shard "$i/$n" \
    --out "$name.out.jsonl" > "$name.stdout" 2> "$name.stderr"
  status=$?
  sources=$(tail -n 1 "$name.stdout" | sed -En 's/^\{"area":.*,"generators":[0-9]+,"sources":([0-9]+),.*"node":"[^"]*"\}$/\1/p')
  state=failed
  if [ "$status" -le 1 ] && [ -n "$sources" ] && [ "$(wc -l < "$name.runs.jsonl" 2> /dev/null)" = "$sources" ]; then
    state=complete
  fi
  # the state is written and the area's shards counted under one lock, so the last shard sees every other's state
  exec {lock}>> "$dir/.lock"
  flock "$lock"
  echo "$state $status" > "$name.exit"
  if [ "$(find "$dir" -maxdepth 1 -name "*of$n.exit" | wc -l)" -eq "$n" ]; then
    if grep -l '^failed ' "$dir"/*of"$n".exit > "$dir/INCOMPLETE.tmp" && [ -s "$dir/INCOMPLETE.tmp" ]; then
      mv "$dir/INCOMPLETE.tmp" "$dir/INCOMPLETE"
    else
      rm -f "$dir/INCOMPLETE.tmp"
      (cd "$dir" && sha256sum -- *of"$n".* > SHA256SUMS.tmp && mv SHA256SUMS.tmp SHA256SUMS)
    fi
  fi
  [ "$state" = complete ]
  exit
fi

if [ $# -ne 2 ] || ! [[ $2 =~ ^[0-9a-f]{40}$ ]]; then
  echo "usage: $0 <built tree> <its full SHA>" >&2
  exit 2
fi
tree=$1 sha=$2
if [ "$(cat "$tree/.sha" 2> /dev/null)" != "$sha" ] || [ ! -d "$tree/dist" ]; then
  echo "baseline $sha: $tree is no built tree of it" >&2
  exit 2
fi
mkdir -p "$HOME/work/baselines"
for manifest in "$HOME"/work/baselines/*/MANIFEST; do
  old=$(sed -n 's/^tree //p' "$manifest" 2> /dev/null)
  if [ -n "$old" ] && [ ! -d "$old" ]; then
    rm -rf "$(dirname "$manifest")" && echo "baseline $(basename "$(dirname "$manifest")"): removed with its tree"
  fi
done
runner=${BASELINE_RUNNER:-$tree}
if ! grep -q 'option("store")' "$runner/tests/families/run.mjs"; then
  echo "baseline $sha: skipped, the runner in $runner cannot store runs"
  exit 0
fi
out=$HOME/work/baselines/$sha
mkdir -p "$out"
exec {lock}>> "$out/.queue.lock"
if ! flock -n "$lock"; then
  echo "baseline $sha: another call is queueing it"
  exit 0
fi
if [ -e "$out/QUEUED" ]; then
  echo "baseline $sha: already queued, running or done in $out"
  exit 0
fi

priority=${BASELINE_PRIORITY:-6}
memory=${BASELINE_MEM:-3G}
if [ ! -e "$out/MANIFEST" ]; then
  slots=${BASELINE_SLOTS:-$(systemctl --user show sx-queue-worker@1.service -p Environment --value 2> /dev/null |
    tr ' ' '\n' | sed -n 's/^SX_HEAVY_SLOTS=//p')}
  if [[ $slots =~ ^[0-9]+$ ]] && [ -z "${BASELINE_SLOTS:-}" ]; then slots=$((slots - 1)); fi
  [[ $slots =~ ^[1-9][0-9]*$ ]] || slots=$(nproc)
  # the jobs run this copy, so that a later install does not change a baseline already queued
  cp "$0" "$out/baseline.sh"
  folders=()
  for folder in "$tree"/tests/families/*/; do
    compgen -G "$folder*.mjs" > /dev/null && folders+=("${folder%/}")
  done
  folders+=("$runner/tools/corpus/fixture")
  # the plan: each area's sources, as the runner reads them, and shards, the smallest area first so it ends first
  plan=()
  for folder in "${folders[@]}"; do
    sources=$(cd "$runner" && node --input-type=module -e '
      import { readdirSync } from "node:fs";
      import path from "node:path";
      import { pathToFileURL } from "node:url";
      const [runner, folder] = process.argv.slice(1);
      const { sourcesOf } = await import(pathToFileURL(path.join(runner, "tests/families/sources.mjs")).href);
      let count = 0;
      for (const name of readdirSync(folder).filter((file) => file.endsWith(".mjs")))
        count += sourcesOf(await import(pathToFileURL(path.join(folder, name)).href)).length;
      console.log(count);
    ' "$runner" "$folder") || { echo "baseline $sha: the sources of $folder could not be read" >&2; exit 1; }
    shards=$((sources / 100))
    [ "$shards" -gt "$slots" ] && shards=$slots
    [ "$shards" -lt 1 ] && shards=1
    plan+=("$sources $(basename "$folder") $shards $folder")
  done
  {
    echo "sha $sha"
    echo "tree $tree"
    echo "runner $runner ($(cat "$runner/.sha" 2> /dev/null || git -C "$runner" rev-parse HEAD 2> /dev/null))"
    echo "run.mjs sha256 $(sha256sum < "$runner/tests/families/run.mjs" | cut -d' ' -f1)"
    echo "baseline.sh sha256 $(sha256sum < "$out/baseline.sh" | cut -d' ' -f1)"
    echo "node $(cd "$runner" && node --version)"
    echo "planned $(date -u +%Y-%m-%dT%H:%M:%SZ), $slots slots"
    printf '%s\n' "${plan[@]}" | sort -n | sed 's/^/area /'
  } > "$out/MANIFEST.tmp" && mv "$out/MANIFEST.tmp" "$out/MANIFEST"
fi

# each planned shard not queued yet (`job <area> <i> <id>` in MANIFEST)
queued=0 missing=0
while read -r _ _ area shards folder; do
  if ! [[ $shards =~ ^[1-9][0-9]*$ ]] || [ ! -d "$folder" ]; then
    echo "baseline $sha: no plan in $out/MANIFEST for $area" >&2
    exit 1
  fi
  for ((i = 0; i < shards; i++)); do
    grep -q "^job $area $i " "$out/MANIFEST" && continue
    if id=$(SX_HEAVY_MEM=$memory sx-queue add --owner baseline --priority "$priority" --dir "$out" \
      --name "baseline-${sha:0:9}-$area-$i" -- bash "$out/baseline.sh" --job "$out" "$tree" "$runner" "$area" \
      "$folder" "$i" "$shards"); then
      echo "job $area $i $id" >> "$out/MANIFEST"
      queued=$((queued + 1))
    else
      missing=$((missing + 1))
    fi
  done
done < <(grep '^area ' "$out/MANIFEST")
if [ "$missing" -gt 0 ]; then
  echo "baseline $sha: $missing jobs not queued ($queued queued now); call again to queue them" >&2
  exit 1
fi
echo "queued $(date -u +%Y-%m-%dT%H:%M:%SZ), priority $priority, memory $memory" >> "$out/MANIFEST"
touch "$out/QUEUED"
echo "baseline $sha: queued $queued jobs in $out"
