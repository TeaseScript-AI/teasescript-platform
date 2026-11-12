# Runtime benchmark

Computations creators plausibly write, run through the public runtime API by `tools/benchmark-runtime.mjs` (#827,
#1693). `manifest.json` gives each source its useful unit (cell, turn, call and so on), and its seed and clock (one for
all), and states the texts that independent references give: the suite's results from the research's reference
implementations, a probe's expected output.

- `workloads/`: the seven suite workloads (`suite: true`, the CPU summary's geometric mean), the issue and list loops,
  a Battleship enemy shot at 500 tries, the six waits (1,024 to 32,768 retained values, 20 or 2,000 instructions between
  waits), and the two full 10,000-try Battleship shots, which are on demand (`onDemand`) and stay out of CI.
- `probes/`: small semantic probes of evaluation order, capture (`{ before: rows, removed: rows.removeLast() }`),
  copies and references, loops, defaults, waits in calls, and the target-before-right-hand-side failure at three seeds.
  Each also runs restored from checkpoint JSON at every cut and must give the same cuts.
- `baseline.json`: per case, its source hash, its instructions, its texts and every cut (each `stepToEvent` or
  `observeTime` return): instructions so far, status, RNG state, number and digest of the events, and the digest of the
  snapshot without its `format` and `version`. The counts are a regression oracle of the current runtime and compiler,
  not a performance requirement.

## Exact counts and results

```sh
npm run build:typescript
npm run benchmark:runtime -- --count-only           # CI's cases; add --all for the full Battleship shots
npm run benchmark:runtime -- --count-only --update  # rewrite the baseline after an intended change
```

CI runs the check as `tests/runtime/engine/runtime-benchmark.test.ts`. A PR that changes a count or a result on purpose updates the
baseline with `--update` (with `--all`, so the on-demand rows follow too) and says in its text why each case moved; the
diff shows one line per cut. A manifest text or a restored run that differs fails even under `--update`.

## Paired CPU comparison

`--cpu --base <dist> --candidate <dist> --out <dir>` loads both builds in one process, requires the candidate to give
the base's results at every cut (counts may differ), then runs them interleaved, the builds' order alternating per
round, after tagged warmup rounds. The timed part is the `stepToEvent` and `observeTime` calls; every timed run is
recorded outside those calls and must equal its build's untimed record. `<dir>` gets `samples.jsonl` (raw CPU microseconds per sample) and `summary.json`:
per case and build the instructions per unit, CPU per unit and per instruction, the paired `base / candidate` speed in
matching rounds as median [min–max], and the suite's geometric mean of those medians. CPU is reported, never checked.

Run it on a queue worker, not on a developer machine, with both trees pinned by commit. With the defaults (9 measured
rounds after 3 warmups, 7 executions per sample) CI's cases take a few minutes; time the full Battleship shots in a job
of their own (`--cases battleship-empty,battleship-three-hits`, one execution per sample):

```sh
sx-job submit --campaign <tag> --commit base=<sha> --commit head=<sha> --checkout <head sha> --timeout 30m -- \
  bash -c 'cd "$SX_CHECKOUT" && node tools/benchmark-runtime.mjs --cpu --base "$SX_TREE_base/dist" \
    --candidate "$SX_TREE_head/dist" --out "$SX_OUT/cpu"'
```
