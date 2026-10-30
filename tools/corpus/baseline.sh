#!/bin/bash
# tools/corpus/baseline.sh <built tree> <its full SHA>
#
# The stored baseline of a `main` commit (owner, 2026-10-30): the corpus runner's runs of the tree alone, stored so that
# a pull request runs only its head against them (`tests/families/run.mjs <area> <head> --baseline <folder>`). Installed
# on a worker as ~/work/trees/hooks/baseline, which `sx-tree` runs with each new `main`'s tree and SHA. It queues one
# job (`sx-queue add --owner baseline`) per shard of each area and returns: the runner's areas (the folders of
# tests/families/ with generators) and the type-core fixture (tools/corpus/fixture/), the smallest first, each in
# shards of at least a hundred sources, at most one per queue slot. A shard stores its runs at the runner's defaults (180 s, 2,048 MB) in
# ~/work/baselines/<sha>/<area>/<i>of<N>.runs.jsonl, beside its `--out` (.out.jsonl), its JSON lines (.stdout),
# .stderr and exit status (.exit); the last shard of an area to end writes the area's SHA256SUMS, so an area without
# one is incomplete. ~/work/baselines/<sha>/MANIFEST says what was queued, with this script's and the runner's hashes.
# A SHA whose folder exists (queued, running or done) is not queued again: remove the folder to redo it.
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
  echo "$status" > "$name.exit"
  # the area's last shard to end sums its files
  exec {lock}>> "$dir/.lock"
  flock "$lock"
  if [ "$(find "$dir" -maxdepth 1 -name '*.exit' | wc -l)" -eq "$n" ] && [ ! -e "$dir/SHA256SUMS" ]; then
    (cd "$dir" && sha256sum -- *of"$n".* > SHA256SUMS.tmp && mv SHA256SUMS.tmp SHA256SUMS)
  fi
  # a stall, an exception or nodes left unanswered (exit 1) are stored outcomes; anything else failed the shard
  [ "$status" -le 1 ]
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
runner=${BASELINE_RUNNER:-$tree}
if ! grep -q 'option("store")' "$runner/tests/families/run.mjs"; then
  echo "baseline $sha: skipped, the runner in $runner cannot store runs"
  exit 0
fi
out=$HOME/work/baselines/$sha
mkdir -p "$(dirname "$out")"
if ! mkdir "$out" 2> /dev/null; then
  echo "baseline $sha: already queued, running or done in $out"
  exit 0
fi

priority=${BASELINE_PRIORITY:-6}
memory=${BASELINE_MEM:-3G}
slots=${BASELINE_SLOTS:-$(systemctl --user show sx-queue-worker@1.service -p Environment --value 2> /dev/null |
  tr ' ' '\n' | sed -n 's/^SX_HEAVY_SLOTS=//p')}
if [[ $slots =~ ^[0-9]+$ ]] && [ -z "${BASELINE_SLOTS:-}" ]; then slots=$((slots - 1)); fi
[[ $slots =~ ^[1-9][0-9]*$ ]] || slots=$(nproc)
# the job runs this copy, so that a later install does not change a baseline already queued
cp "$0" "$out/baseline.sh"

areas=()
for folder in "$tree"/tests/families/*/; do
  compgen -G "$folder*.mjs" > /dev/null && areas+=("$(basename "$folder")=${folder%/}")
done
areas+=("fixture=$runner/tools/corpus/fixture")
{
  echo "sha $sha"
  echo "tree $tree"
  echo "runner $runner ($(cat "$runner/.sha" 2> /dev/null || git -C "$runner" rev-parse HEAD 2> /dev/null))"
  echo "run.mjs sha256 $(sha256sum < "$runner/tests/families/run.mjs" | cut -d' ' -f1)"
  echo "baseline.sh sha256 $(sha256sum < "$out/baseline.sh" | cut -d' ' -f1)"
  echo "node $(cd "$runner" && node --version)"
  echo "queued $(date -u +%Y-%m-%dT%H:%M:%SZ), priority $priority, memory $memory, $slots slots"
} > "$out/MANIFEST"

# each area's sources, as the runner reads them, so that the smallest areas are queued first and end first
sized=()
for entry in "${areas[@]}"; do
  area=${entry%%=*} folder=${entry#*=}
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
  ' "$runner" "$folder") || { echo "area $area: its sources could not be read" >> "$out/MANIFEST"; continue; }
  sized+=("$sources $area $folder")
done

jobs=0
while read -r sources area folder; do
  shards=$((sources / 100))
  [ "$shards" -gt "$slots" ] && shards=$slots
  [ "$shards" -lt 1 ] && shards=1
  echo "area $area $folder: $sources sources, $shards shards" >> "$out/MANIFEST"
  for ((i = 0; i < shards; i++)); do
    id=$(SX_HEAVY_MEM=$memory sx-queue add --owner baseline --priority "$priority" --dir "$out" \
      --name "baseline-${sha:0:9}-$area-$i" -- bash "$out/baseline.sh" --job "$out" "$tree" "$runner" "$area" \
      "$folder" "$i" "$shards") && echo "job $id" >> "$out/MANIFEST" && jobs=$((jobs + 1))
  done
done < <(printf '%s\n' "${sized[@]}" | sort -n)
echo "baseline $sha: queued $jobs jobs in $out"
