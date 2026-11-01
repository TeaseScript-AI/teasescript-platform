# Generator corpus

The generators reviewers and builders used as evidence on the type core, kept so later builders rerun them. Their runs
are not in CI: before a type-core review round, the builder runs the affected areas against the base and head builds
and reports the counts (`docs/TESTING.md`, test admission). Each module under `tests/families/<area>/` reproduces the
sources of one recorded evidence run (#1446), and `check.mjs` (in CI) checks that it does.

## Running an area

Build both trees (`npm run build:typescript`; each needs `dist/tests/helpers/type-core-oracles.js`), then:

```sh
node tests/families/run.mjs <area> <base checkout or dist> <head checkout or dist> [--sizes 4,8] \
  [--allowances natural,16,256] [--shard i/N] [--timeout 180] [--memory 2048] [--out differences.jsonl] \
  [--work <area>-<i>of<N>.work.jsonl] [--only <stall index>]
node tests/families/run.mjs <area> <head> --baseline ~/work/baselines/<base src tree>/<area> [the same options]
node tests/families/run.mjs <area> <base tree> --store ~/work/baselines [--shard i/16]
node tests/families/stalls.mjs <shards' --work records>... [--rerun <rerun's records>...] [--index <new file>]
node tests/families/stalls.mjs rerun <stall index> <base> <head> <new folder> [--timeout 600]
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

With `--baseline`, the head alone runs, against a stored run of the base: each run is judged as above against the stored
result of the same source (its generator, name and key, so an edited source is new), mode and check, and a run the
baseline does not hold is `uncompared`, never agreement (`--out` names its source and runs); a source stalls or throws
outside its runs where either the stored run or the head did. The limits then apply to each tree alone, where a run of
both trees shares them in one process, so a source that stalls there may end here, and the head's runs after a stored
stall are uncompared. `--baseline` reads a folder's `*.runs.jsonl` files, and stops (exit 2) at a source stored twice
with other results.

`--work` writes a record of each source and changes no other output (#1564): a first line with what ran and the
comparison's configuration (`configuration`: the sources' sizes, the area's plan (the hash of every source's place, its
generator, name and key, in the area's order, before a shard or `--only` selects), the stop runs' allowances, each
generator's checks, each tree as the runner executes it, its compiled compiler and oracle library read from the build it
loads, for a checkout, its `dist/` or a tree without sources alike, and a stored base as its baseline's MANIFEST names
it, which a rerun's base matches by its own identity), one line per source with each run's charged work (`work`: the
units its analyses charged their work ledgers, `WorkLedger.charge`, finishing work included; `null` for a tree without
one) and milliseconds (`ms`) on each tree and what the source counted, and the total last. A source that stalls keeps
the run then going on as the runner ended it, from a progress record the child writes over beside the record
(`<file>.progress`, removed at the end; `--out`, `--work` and it must name three files) as a tree starts a run, every
65,536 units and as it ends it: the units charged, at most 65,536 short, the milliseconds until the stall and the tree
running it (`running`). `stalls.mjs` reads a replay's records (a shard run without `--work` by its `--out` file, which
gives its stalls alone) and prints the rule it judges each stalled source by (`RULE`: a candidate stall, load or
unknown; its time clause a heuristic), each stalled source with its verdict, and each area's counts and the total. An
area's records must share one configuration (another is refused, exit 2), so the area is complete only with its shards
0/N to N-1/N of one N, together every source of one plan, and a source a plan lists more than once (a repeat, which the
runner runs and counts each time) is one source where its repeats record the same counts, stall and runs, milliseconds
apart, refused (exit 2, naming the place) where they differ; a source counts as `agreed` only where it was compared in
every run and agrees, and `closed` (exit 0) needs every area complete, every source agreed and no candidate left.
`--index` writes the sources still unavailable, with their verdicts and records and each area's configuration. Against a
stored baseline the base's work is not recorded, so a head's timeout is unknown: `stalls.mjs rerun` runs the index's
sources alone, one at a time with both trees in one process and the replay's configuration (`run.mjs <area> <base>
<head> --only <index>`, an area after another; only `--timeout` and `--memory` may differ), and `--rerun
<folder>/*.work.jsonl` reads its records in place of the replay's, so the replay closes without another campaign; a
record of another configuration is refused, and a rerun that ends does not clear a candidate. Rerun records are read in
the order given, an earlier round's first: where a source's earlier rerun stalled, or its later one stalls, the later
stands (a round at a longer `--timeout` or `--memory` may run what an earlier one could not), and two that ended must
say the same, else refused (#1587); a replay's records are never replaced.

`--store` runs one tree of a commit (an `sx-tree` tree: `src/`, `dist/`, `.sha`) at the runner's defaults and stores one
shard of an area, each source's results as one line, in the baseline of its `src/` tree,
`<folder>/<src tree>/<area>/<i>of<N>.runs.jsonl`, where `<src tree>` is `git rev-parse <commit>:src`. Every commit with
that tree and the same oracle library, lockfile and Node shares the baseline; one that differs in any of them stores
none there (base and head run instead). `baselines.mjs` reads and writes the baseline: a folder whose `MANIFEST` it
wrote while the folder held nothing else (what its runs depend on, the commits stored there, each area's `PLAN`),
holding only paths it writes, each named exactly as it names them; a folder holding another path is not written into,
and the refusal names the path. Each area's `PLAN` binds its shards' sources in their order and its checks, and a
writer that would run another is refused (exit 2). One rule says whether a stored shard counts, and status, the store
and `--baseline` all read shards through it: its total line names its own baseline's inputs (the `MANIFEST`'s `src/`
tree, oracle library, lockfile and Node; any commit of that tree), the `PLAN` and the shard's planned sources, which
are its lines in their order, and hashes every line before it. A shard that would count but names other inputs makes
the baseline hold runs of other inputs (exit 2); one that does not verify leaves the area damaged (exit 1), and the
next writer of that shard replaces it. `--baseline` reads an area only where it is complete under that rule, and is
refused as status refuses it otherwise. One running writer at a time stores a shard. Every write into the baseline
but its `MANIFEST`'s making goes through one gate in `baselines.mjs`, which holds the baseline's lock. A store writes
into its tree's baseline only (and its `--out`), and runs where only that folder and its scratch are writable:
`sx-sandbox --write ~/work/baselines/<src tree> --write <scratch> -- node … --store ~/work/baselines …`, with
`TMPDIR=<scratch>`, as the hook queues its jobs; a write anywhere else fails (EROFS). `node tests/families/writes.mjs`
lists the writes the tools' source shows, an advisory check for the plain forms of a write outside the gate. Nothing
removes a baseline.
`bash tools/corpus/baseline.sh status <commit>` says in one line what each area of the commit's tree holds, and exits 0
only when each one is complete. Before a base run, ask it: compare the head with a complete area through `--baseline`,
and store an area that is not from the base tree's own runner and areas
(`node <base tree>/tests/families/run.mjs <area> <base tree> --store ~/work/baselines --shard i/16`, one job per shard,
the fixture area as `<base tree>/tools/corpus/fixture`), so that it serves every later run on that tree. The script,
installed as the desktop's `~/work/trees/hooks/baseline`, fills each new `main`'s tree at low priority where nobody
stores it. Once `main` has another `src/` tree, the remaining jobs of an older tree's fill end without running, also
after the fill began: its stored shards stay and count, and what it left unstored waits for a builder's store or for
that tree to be `main`'s again.

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
(`families/s8-stores.mjs`), predicates of what fits each written type and of what the source proves at a store, which
read no compiler code (`lib/model.mjs`, `lib/certificate.mjs`), and a tool that compiles and runs each source in eight
modes (the consumers' and the solver's order apart, the sharing on and off) at each of its profile's allowances. A run
fails when a fitting value does not reach `AFTER`, a forbidden one is not rejected at the store before it, the plan's
check at the store is not the complete type, the host's input changes, or a store above a stop, or one judged at or
below it, lacks its one owned mark. Which stop a store meets is read from the compiler's own decisions. Besides PASS
and FAIL a row is UNSUPPORTED (the candidate route rejects the source), OUT_OF_SCOPE (a stop at or above the store's
own path, #1440, or a store into an inferred place before admission settled, #1252: only its fitting runs and the
host's input are judged), ERROR, TIMEOUT, CANCELLED or NOT_RUN. A plan made with `--rules 1440` (`lib/rules.mjs`; none
by default, so a run on any pinned tree is judged as before) judges a store at or below a stop on its whole domain
where the source proves its type apart from the stop, as #1440 (`39b864aa2`) certifies it: the destination's written
type, or a written binding its start value reads directly or through object literal properties, but not a store into
an inferred place before admission settled; such a store's row records whether the source proves it (`certified`).
Before its first row, the run checks a fixed control on its tree (a property a copy decides, at demand allowance 1)
and stops, exit 2, where the store at that stop is not checked against its whole type, as on a tree before #1440. Any
non-PASS row prevents a green campaign: FAIL takes precedence, then ERROR for ERROR/TIMEOUT/CANCELLED, otherwise
INCOMPLETE for exclusions or NOT_RUN. `s8-stores.mjs` is the family's sources as a module of this corpus, which `check.mjs` checks and
`run.mjs property` compares; the behavioural verdict stays the tool's. Its runs are not in CI.

A pair of commits, from the repository root on a worker, as one capped job:

```sh
node tests/families/property/bin/prepost.mjs <repository> <pre> <post> <new folder> [--profile quick|focused|deep] \
  [--seed 1442] [--case-timeout-ms 15000] [--library 7ef341030] [--rules 1440]
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
