# Generator corpus

The generators reviewers and builders used as evidence on the type core, kept so later builders rerun them. Their runs
are not in CI: before a type-core review round, the builder runs the affected areas against the base and head builds
and reports the counts (`docs/TESTING.md`, test admission). Each module under `tests/families/<area>/` reproduces the
sources of one recorded evidence run (#1446), and `check.mjs` (in CI) checks that it does.

## Running an area

Build both trees (`npm run build:typescript`; each needs `dist/tests/helpers/type-core-oracles.js`), then:

```sh
node tests/families/run.mjs <area> <base checkout or dist> <head checkout or dist> [--sizes 4,8] \
  [--allowances natural,16,256] [--shard i/N] [--timeout 180] [--memory 2048] [--out differences.jsonl]
node tests/families/run.mjs <area> <head> --baseline ~/work/baselines/<base SHA>/<area> [the same options]
```

Each source runs in the four modes (source and reversed order, the sharing on and off). The runner compares what it
publishes (`publication`) part by part (`publicationHashes`: the answers, the record, each occurrence's answer and the
route, in that order, each hashed as it is made), so a publication of any size is compared without one string of it, and
a difference names its first differing part by that index and each tree's count of parts (#1503); and, for a generator
whose `checks` include `"stops"`, which decisions stop and when at each demand allowance (`stopSet`). A source that
takes more than `--timeout` seconds (180 by default; 60 in CI, which sets `CI=true` and runs only the runner's own
tests) or `--memory` MB of heap, or that ends its analysing process (a fatal V8 error), is counted as stalled with the
reason (`--out`), and the runner goes on with the next. The runs its process had written before the runner ended it
still count; one whose outcome it was still writing is lost with the process, and a final reply cannot finish the source
once its timeout callback has run (#1498). After the kill the runner waits for the process and its pipes to close, so a
descendant holding its stderr delays the next source (no compiler or oracle code spawns one). A run that throws on
either tree is an exception, never compared, because identical exceptions on both trees are not agreement (#1439): the
runner prints it on stderr with its source, mode and check, writes it with each stack to `--out` and counts it apart
from stalls, in a source that stalls later too (`tests/families-runner.test.ts`, in CI). A publication is had only up to
the oracle's own stop: where its questions after a finished analysis pass the allowance, the nodes from that one on stay
unanswered (`publicationHashes`'s `unanswered`, #1499). A run with any on either tree is neither compared nor an
exception: the runner writes it to `--out` and counts it apart. It prints one JSON line per generator and a total
(sources, unparsed, stalled, exceptions, unanswered, uncompared, modes, runs, differences, the limit in seconds), and
exits 1 when any run differs, throws, leaves nodes unanswered or is uncompared, or any source stalls. Run large sizes as
one capped job per area or shard on a worker. Some recorded large inputs exceed the default timeout on unchanged trees.
Report stalls and publication exceptions separately; neither establishes agreement.

With `--baseline`, the head alone runs, against a stored run of the base: each run is judged as above against the
stored result of the same source (its generator, name and key, so an edited source is new), mode and check, and a run
the baseline does not hold is `uncompared`, never agreement (`--out` names its source and runs); a source stalls or
throws outside its runs where either the stored run or the head did. The limits then apply to each tree alone, where a
run of both trees shares them in one process. `--store <file>` runs one tree and stores each source's results as one
line; `--baseline` reads a folder's `*.runs.jsonl` files. `tools/corpus/baseline.sh`, installed as the desktop's
`~/work/trees/hooks/baseline`, stores every runner area and the type-core fixture (`tools/corpus/fixture/`) of each new
`main` in `~/work/baselines/<sha>/<area>/`; an area without its `SHA256SUMS` is not complete.

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
source is one call's files with the list that call passed: the list its run's type-core analysis passed, or, where the
run only compiled those files, that compile's. Two analysis calls with different lists are two sources.

`recorded` is the run the module reproduces: its commands with where its evidence records them, the count of its
distinct sources (each with its globals) and their set key, and the inputs it drops with the reason (`dropped`).
`node tests/families/check.mjs [area...]` checks every module against its record, and CI runs it
(`npm run test:families`); `--list` prints each module's commands and the count and set key of its sources. A record
comes from the capture of its run's commands (what each call passed), never from the module's own sources, so the
check also fails a module assembled wrongly; a module changes only together with its record.

A module reproduces what its run passed to the compiler, at the run's arguments, and nothing it did not:

- the commands the evidence folder records (README, run and queue scripts, review text, result files); for a run that
  recorded none, its driver's run without arguments; a generator no recorded run used is not kept;
- without an input that no longer resolves on `main` for a reason its origin did not test (a removed feature,
  experimental syntax), and with one whose origin meant a parse or name error;
- without the data a driver read but its review did not write: the repository's type-core fixture
  (`tests/fixtures/type-core/cells.jsonl`, whose sources the recorded fixture runs share unchanged), its exported work
  families (`tests/helpers/type-core-families.ts`), its paste family (`pasteCases` in `tests/helpers/type-core-paste.ts`),
  the programs of its own test files (a review's gate runs of them, whose inputs those tests hold) and other runs' case
  files (the 3a budget check's), judged by where each input came from: a case file its own review wrote stays, and a
  program the driver derived from a fixture row or a paste case (a pasted fix) stays, even one equal to another row. The
  module's first comment names what its run also read.

## A property family

`tests/families/property/` holds the S8 stopped-store family of #1442: 90 sources generated over declared dimensions
(`families/s8-stores.mjs`), a predicate of what fits each written type that reads no compiler code (`lib/model.mjs`),
and a tool that compiles and runs each source in eight modes (the consumers' and the solver's order apart, the sharing
on and off) at each of its profile's allowances. A run fails when a fitting value does not reach `AFTER`, a forbidden
one is not rejected at the store before it, the plan's check at the store is not the complete type, the host's input
changes, or a store above a stop lacks its one owned mark. Which stop a store meets is read from the compiler's own
decisions. Besides PASS and FAIL a row is UNSUPPORTED (the candidate route rejects the source), OUT_OF_SCOPE (a stop at
or above the store's own path, #1440, or a store into an inferred place before admission settled, #1252: only its
fitting runs and the host's input are judged), ERROR, TIMEOUT, CANCELLED or NOT_RUN. Any non-PASS row prevents a green
campaign: FAIL takes precedence, then ERROR for ERROR/TIMEOUT/CANCELLED, otherwise INCOMPLETE for exclusions or
NOT_RUN. `s8-stores.mjs` is the family's sources as a module of this corpus, which `check.mjs` checks and
`run.mjs property` compares; the behavioural verdict stays the tool's. Its runs are not in CI.

A pair of commits, from the repository root on a worker, as one capped job:

```sh
node tests/families/property/bin/prepost.mjs <repository> <pre> <post> <new folder> [--profile quick|focused|deep] \
  [--seed 1442] [--case-timeout-ms 15000] [--library 7ef341030]
```

It builds both commits from the repository's objects with its `node_modules` (`bin/prepare-build.mjs`), runs the
profile on each (`bin/pilot.mjs plan` and `run`), compares the rows (`bin/compare.mjs`) and, where both trees hold the
oracle library, runs `run.mjs property` on the same builds; `--library` adds the library from that commit to a tree
before #1427. It writes `report.json` and `report.md` and exits 0 when the family tells the pair apart (at least one
failure on the first, each run to PASS on the second, no failure on the second, and no ERROR, TIMEOUT, CANCELLED or
NOT_RUN row on either), 1 when it does not, 2 on an error. `quick` runs 12 sources in two modes at four allowances,
`focused` (the default) all 90 in eight modes at nine, `deep` at 23. On the desktop worker (Node 26.13, shared with
other jobs; #1477) a build took 3–5 s, a campaign 2–3 s (`quick`), 52–57 s (`focused`) or 109–124 s (`deep`) per
build, the runner over the same sources 10–12 s, a whole job at most 1.8 GB: `quick` suits a builder's loop in the
stops area, `focused` the run before a review round there, `deep` a change to where or how the budget stops.
`bin/canaries.mjs <build> <out>` checks that 12 mutants of clean plans fail; `bin/shrink.mjs`, `bin/merge.mjs` (shards)
and `bin/metrics.mjs` print their usage. The tool's own tests: `node --test tests/families/property/test/`.

## Kept outside the repository

The desktop corpus's kits and data, and their known problems, are indexed per area in `corpus/<area>.md` (`tooling`,
`copies`, `stops`, `consumers` and `rings`, and `limits` for those of no one area), not imported: run each from its own
folder on the desktop worker. A new kit's entry goes to its area's file.

## The oracle library's next step

`tests/helpers/type-core-enclosing.ts` (#1434) keeps its own `MODES`: eight modes, with the consumers' order and the
solver's order varied apart. The library's four modes reverse both together. Its modes are the candidate for the
library's next step. Its stop verdict (`enclosingProblems`) is its own oracle and copies no library projection.
