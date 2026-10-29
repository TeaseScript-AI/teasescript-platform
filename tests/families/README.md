# Generator corpus

The generators reviewers and builders used as evidence on the type core, kept so later builders rerun them. Not in CI:
before a type-core review round, the builder runs the affected areas against the base and head builds and reports the
counts (`docs/TESTING.md`, test admission). This folder holds the runner and the module contract. The modules arrive
under `tests/families/<area>/` in a follow-up, #1446. That follow-up rebuilds each module from the inputs of its
recorded evidence command, and each module must reproduce that run's sources and arguments.

## Running an area

Build both trees (`npm run build:typescript`; each needs `dist/tests/helpers/type-core-oracles.js`), then:

```sh
node tests/families/run.mjs <area> <base checkout or dist> <head checkout or dist> [--sizes 4,8] \
  [--allowances natural,16,256] [--shard i/N] [--timeout 60] [--memory 2048] [--out differences.jsonl]
```

Each source runs in the four modes (source and reversed order, the sharing on and off). The runner compares what it
publishes (`publication`) and, for a generator whose `checks` include `"stops"`, which decisions stop and when at each
demand allowance (`stopSet`). A source that takes more than `--timeout` seconds or `--memory` MB of heap is counted as
stalled, and the runner goes on with the next. It prints one JSON line per generator and a total (sources, unparsed,
stalled, modes, runs, differences), and exits 1 when any run differs or any source stalls. Run large sizes as one
capped job per area or shard on a worker.

A mutant is a head tree with one file changed. Its verdict counts only beside proof that the change was applied: the
mutated file's hash in the head tree, which differs from the base's. Without that proof the result is NOT_RUN, never
"killed", the same way identical exceptions on both trees are not agreement (#1439).

## A generator

A module `tests/families/<area>/<name>.mjs` with no imports beyond `node:` built-ins and no side effects:

```js
// <what it generates>
export const sizes = [4, 8]; // default sizes, one doubling
export const shapes = { "<shape>": (n) => "<source>" }; // or (n) => [{ path, source }]
// or fixed sources: export const cases = [["<name>", "<source>"]];
export const checks = ["publication", "stops"]; // default ["publication"]
```

Sources may use the host globals `hostValue`, `hostOther`, `hostInit` and `otherHost`; a generator whose sources
need other names exports `globals`, the full list.

## Kept outside the repository

Data, indexed here and not imported: run each from its own folder on the desktop worker.

- `desktop:~/work/evidence/corpus/copies/astra-1423/`: Astra's r1 of #1423 (G3 part 2). It holds generators
  (`cases.mjs`, `families.mjs`, `stop-cases.mjs`, `route-cases.mjs`, `growth.mjs`), fixed case lists, and their
  publication, stop-set and growth harnesses. Its `README.md` gives the pins.
- `desktop:~/work/evidence/corpus/stops/owner-s8/`: the owner's independent S8 reviews. It holds the 75-source
  domain matrix, the every-allowance sweeps, the cache lifecycle probe and the JSON and load matrix. It is untrusted
  input, never imported into a build.
- `desktop:~/work/evidence/corpus/stops/owner-s8/compiler-enclosing-evidence/`: the owner's reviewer's second bundle
  (164 files, PR #1434). It holds the 75-source domain generator, a 134-text complete-requirement matrix with an
  implementation-independent predicate, the relocation-only replay driver (`replay.mjs`, `check-run.py`),
  `cost-probe.mjs` and the raw results, and its `README.md` gives the replay commands. It is the standard oracle for
  the stops area: it runs before a builder's first review there.

Known problems in the desktop corpus (`desktop:~/work/evidence/corpus/<area>/`, one README per area), reported by the
#1416 builder:

- `stops/astra-1405/lifecycle.mjs` no longer loads on any tree. Its hook patches private methods of `Consumers`, which
  the consumers split (#1367) removed, so it needs a port to the split layout.
- Sol's runner's `ownership-maps` helper fails on both trees, and its classifier does not read it.
- The made-units probe (`stops/uncharged-making/`) attributes code to source lines. Across trees whose line numbers
  differ, compare per site by a stable key (function name and step), not by line.

## The oracle library's next step

`tests/helpers/type-core-enclosing.ts` (#1434) keeps its own `MODES`: eight modes, with the consumers' order and the
solver's order varied apart. The library's four modes reverse both together. Its modes are the candidate for the
library's next step. Its stop verdict (`enclosingProblems`) is its own oracle and copies no library projection.
