# Runtime benchmark

Computations creators plausibly write, run through the public runtime API by `tools/benchmark-runtime.mjs` (#827,
#1693). `manifest.json` gives each source its useful unit (cell, turn, call and so on), and its seed and clock (one for
all), and states the texts that independent references give: the suite's results from the research's reference
implementations, a probe's expected output.

- `workloads/`: the seven suite workloads (`suite: true`, the CPU summary's geometric mean), the issue and list loops,
  a Battleship enemy shot at 500 tries, the six waits (1,024 to 32,768 retained values, 20 or 2,000 instructions between
  waits), and the two full 10,000-try Battleship shots, which are on demand (`onDemand`) and stay out of CI.
- The interactive workloads (#1797), small extracts of the mechanism of a converted package that `origin` names, with
  neutral texts: accepted answers to helpers 19 frames deep, completed forms, committed storage writes and a failed one,
  completed file operations, entered files of a project, the cooperative Battleship think (its real 10 ms rest every
  1,000 placement attempts, at 150 tries), and a text of 65,536 code points (300,032 on demand) and a list of 10,000
  items. Their sizes are workload dimensions, not limits. Packages DisciplineClinic, Toy and
  ToyExpanded, and the research's other measured packages, are holdouts: never an `origin`, never tuned against.
- `tapes/`: a tape is the input of a case that needs the host: its calls in order, `{ kind, args }` as the Playroom's
  debug export names them (`completeAction`, `updateInteraction`, `observeTime`, `reportMediaLoad`,
  `pressPermanentButton`), with literal action IDs, a `completeAction`'s recorded media store answers
  (`admissionQueries`), and `unit: true` on each call that completes a useful unit. What the calls give is the
  baseline's, never the tape's.
- `references.mjs`: the interactive workloads' texts computed in plain JavaScript from each fixture's parameter and tape;
  `tools/benchmark-runtime.test.mjs` checks the manifest against them.
- `probes/`: small semantic probes of evaluation order, capture (`{ before: rows, removed: rows.removeLast() }`),
  copies and references, loops, defaults, waits in calls, the target-before-right-hand-side failure at three seeds, and
  the runtime oracle's own cases that need no host or compile options: a two-file project, a runtime failure and a
  seeded draw at two seeds. Each also runs restored from checkpoint JSON at every cut and must give the same cuts, as
  does a case with `restoreEachCut`.
- `baseline.json`: per case, its source hash (and tape hash), its instructions, its texts and every cut (each
  `stepToEvent`, `run`, `observeTime` or tape call return): instructions so far, status, RNG state, number and digest of
  the events, the digest of the snapshot without its `format` and `version`, and a tape call's outcome, its kind and the
  digest of all of it. The counts are a regression oracle of the current runtime and compiler, not a performance
  requirement.

## Driving a case

A case drives `stepToEvent` with a research allowance of 2,000,000,000 instructions, which lets the stress shots finish.
With `budget: "product"` it drives `run` without a budget, as the Playroom does, so the product default applies at each
scene time; `stepToEvent` gives each call its own count, so only `run` shows that contract. The three Battleship claims
stay apart: `battleship-three-hits-product-budget` stops with `TSR037` after exactly 1,000,000 instructions (the
manifest's `failure`); the cooperative case, more than one budget in all, finishes under the same default through its rests; the full shots finish
only under the allowance.

Without a tape a case observes each wait's deadline. With one, every host call is the tape's next entry, `observeTime`
too; after a call that leaves nothing to run, such as a form edit or a refused answer, the next follows at once. The
tape must be used up exactly when the session stops waiting, and each `unit` call must complete. Every session the
case makes receives its host calls through a guard (`checkedHostSession`), which compares each call's method and data
arguments, where the session receives it and before it runs, with the tape's entry, read from the tape alone, and a
`completeAction`'s media store questions and answers with the entry's recorded ones: a different call fails there,
also one with the same effect. The differential test guards the sessions it makes the same way. A project case
(`project`, `files` in order) compiles with `compileProject`; `fresh` adds session options such as
`persistentScriptStorage`. `saidSha256` states a case's texts by the SHA-256 of their canonical JSON when they are long.

## Exact counts and results

```sh
npm run build:typescript
npm run benchmark:runtime -- --count-only           # CI's cases; add --all for the on-demand ones
npm run benchmark:runtime -- --count-only --update  # rewrite the baseline after an intended change
```

CI runs the check as `tests/runtime/engine/runtime-benchmark.test.ts`. A PR that changes a count or a result on purpose updates the
baseline with `--update` (with `--all`, so the on-demand rows follow too) and says in its text why each case moved; the
diff shows one line per cut. A manifest statement, a tape's problem or a restored run that differs fails even under
`--update`.

## Paired CPU comparison

`--cpu --base <dist> --candidate <dist> --out <dir>` loads both builds in one process, requires the candidate to give
the base's results at every cut (counts may differ) and both to hold the manifest's statements, then runs them
interleaved, the builds' order alternating per round, after tagged warmup rounds. The timed part is the drive
(`stepToEvent` or `run`), `observeTime` and tape calls, with the guard's comparisons outside it and its record of the
media store's answers inside; every timed run is recorded outside those calls and must equal its build's untimed
record. `<dir>` gets `samples.jsonl` (raw CPU microseconds per sample) and `summary.json`:
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
