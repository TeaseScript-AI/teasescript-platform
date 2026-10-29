# Generator corpus

The generators reviewers and builders used as evidence on the type core, kept so later builders rerun them. Not in CI:
before a type-core review round, the builder runs the affected areas against the base and head builds and reports the
counts (`docs/TESTING.md`, test admission). Each module under `tests/families/<area>/` reproduces the sources of one
recorded evidence run (#1446), and `check.mjs` checks that it does.

## Running an area

Build both trees (`npm run build:typescript`; each needs `dist/tests/helpers/type-core-oracles.js`), then:

```sh
node tests/families/run.mjs <area> <base checkout or dist> <head checkout or dist> [--sizes 4,8] \
  [--allowances natural,16,256] [--shard i/N] [--timeout 60] [--memory 2048] [--out differences.jsonl]
```

Each source runs in the four modes (source and reversed order, the sharing on and off). The runner compares what it
publishes (`publication`) and, for a generator whose `checks` include `"stops"`, which decisions stop and when at each
demand allowance (`stopSet`). A source that takes more than `--timeout` seconds or `--memory` MB of heap, or that ends
its analysing process (a fatal V8 error), is counted as stalled with the reason (`--out`), and the runner goes on with
the next. It prints one JSON line per generator and a total (sources, unparsed, stalled, modes, runs, differences), and
exits 1 when any run differs or any source stalls. Run large sizes as one capped job per area or shard on a worker.

A mutant is a head tree with one file changed. Its verdict counts only beside proof that the change was applied: the
mutated file's hash in the head tree, which differs from the base's. Without that proof the result is NOT_RUN, never
"killed", the same way identical exceptions on both trees are not agreement (#1439).

## A generator

A module `tests/families/<area>/<name>.mjs` with no imports beyond `node:` built-ins and no side effects:

```js
// <what it generates> (<its origin>)
export const sizes = [64, 128]; // the recorded run's sizes
export const shapes = { "<shape>": (n) => "<source>" }; // or (n) => [{ path, source }]
// or fixed sources: export const cases = [["<name>", "<source>" or [{ path, source }], <globals>?]];
export const checks = ["publication", "stops"]; // default ["publication"]
export const globals = ["hostValue"]; // the run's host globals, where they are not the default
export const recorded = { commands: [["<command>", "<where it is recorded>"]], sources: 0, sha256: "<set key>" };
```

A source runs with the host globals its case gives, else its generator's `globals`, else `hostValue`, `hostOther`,
`hostInit` and `otherHost`. They are part of the input: the analysis declares a host binding for each. A recorded
source keeps the list its run's type-core analysis passed, or, where the run only compiled it, that compile's.

`recorded` is the run the module reproduces: its commands with where its evidence records them, the count of its
distinct sources (each with its globals) and their set key, and the inputs it drops with the reason (`dropped`).
`node tests/families/check.mjs [area...]` checks every module against its record, and CI runs it
(`npm run test:families`); `--list` prints each module's commands and the count and set key of its sources. A module
changes only together with its record, from the run's own sources.

A module reproduces what its run passed to the compiler, at the run's arguments, and nothing it did not:

- the commands the evidence folder records (README, run and queue scripts, review text, result files); for a run that
  recorded none, its driver's run without arguments; a generator no recorded run used is not kept;
- without an input that no longer resolves on `main` for a reason its origin did not test (a removed feature,
  experimental syntax), and with one whose origin meant a parse or name error;
- without the data a driver read but its review did not write: the repository's type-core fixture
  (`tests/fixtures/type-core/cells.jsonl`, whose sources the recorded fixture runs share unchanged), its exported work
  families (`tests/helpers/type-core-families.ts`) and other runs' case files (the 3a budget check's). A program the
  driver derived from a fixture row (a pasted fix) stays, even one equal to another row. The module's first comment
  names what its run also read.

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
- `desktop:~/work/evidence/corpus/consumers/sol-1455-r1/`: Sol's r1 of #1455 (#1436, object presence): the
  natural-budget family (`review-family.mjs` over `review-cases.json` and `opaque-cases.json`), every-allowance stops
  (`stops.mjs`), checkpoint restores (`checkpoints.mjs`) and the builder spot check (`spot.mjs`). Head `3f0bcb1bd`,
  base `2960937a1`; `SHA256SUMS` sha256 `a42f4ef4…`. Its family and checkpoints run on `main` `2960937a1`.
- `desktop:~/work/evidence/corpus/tooling/`: one master copy of each kit that briefs hand out, the split kit (`split/`,
  with `cycles.cjs`) and the #1423 probe kit (`g3-probe/`, with `queue-final.sh`). Its `README.md` says what each
  master fixes.

These kits read `tests/helpers/type-core-oracles` with `publishedAnswers(answers, bindings, request)` and run on trees
from `main` `2960937a1` (#1446): `copies/astra-1423/` (`publication.mjs`, `route-check.mjs`), `copies/astra-1441/`,
`copies/astra-1443/builder-probe/`, `copies/sol-1437-r2/`, `copies/sol-1441-r1/`, `copies/sol-1443-r1/`,
`consumers/astra-1437/` (Astra's `seam-stops.mjs`, the spot publications and the proof scripts),
`consumers/owner-s9b/` and `stops/astra-1434/`; `consumers/sol-1437-r5/`, `-r6/` and `-r7/` read `stopIdentity` from
there too. Each folder's `PORTED-1446.md` names the ported files; each original stays beside its port as
`<file>.pre-1446`. The `sol-1437` kits still name their review's folders: retarget those as their READMEs say.

Known problems in the desktop corpus (`desktop:~/work/evidence/corpus/<area>/`, one README per area):

- `stops/astra-1405/lifecycle.mjs` loads on no tree since the consumers split (#1367). It drives `narrowingPass` and
  patches the consumers' private `#valueRun` and `#syntaxRead`, none of which exist on `main`, and the anchor of its
  `no-restart` mutant is gone, so it needs a rewrite against the current pass, not a port.
- Sol's S8 runner (`~/work/evidence/i1416/<head>/s8-run.sh`) runs `ownership-maps.mjs`, a draft cut off inside its
  first loop, so it parses on no tree. `place-maps` writes the `ownership.json` its classifier reads: leave the
  probe out.
- The made-units probe (`stops/uncharged-making/`) attributes code to source lines. Across trees whose line numbers
  differ, compare per site by a stable key (function name and step), not by line.
- `consumers/sol-1437-r5/probe.mjs` (`controls`, `chain-work`) hooks `readSnapshot(contentSource(walk, value))` in the
  consumers' signatures, which `main` no longer has (the read's class comes from `contract.readClass`): its alias
  bypass needs a redesign. The folder's other scripts run on `main`.
- `consumers/sol-1437-r7/identity-r7.mjs mutant` recreates #1437's B1 by caching a JSON proof's root and items, and
  anchors on the items expression that `main` extended with the unread (stopped) branch. Its other flavors run.
- `consumers/sol-1437-r6/spot.mjs` refuses a tree whose sources differ from its review's head (`source-hashes.json`),
  by design: it reproduces that review on its pinned build only.
- `consumers/sol-1437-r7/spot-r7.mjs`, which the folder's README lists, is in no archive (not on the workers, not in
  the builder's r7 evidence): the r7 spot check cannot be rerun.

## The oracle library's next step

`tests/helpers/type-core-enclosing.ts` (#1434) keeps its own `MODES`: eight modes, with the consumers' order and the
solver's order varied apart. The library's four modes reverse both together. Its modes are the candidate for the
library's next step. Its stop verdict (`enclosingProblems`) is its own oracle and copies no library projection.
