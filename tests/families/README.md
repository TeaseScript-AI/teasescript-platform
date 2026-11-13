# Generator corpus

The generators reviewers and builders used as evidence on the type core, kept so later builders rerun them. Their runs
are not in CI: before a type-core review round, the builder runs the affected areas against the base and head builds
and reports the counts (`docs/TESTING.md`, test admission). Each module under `tests/families/<area>/` reproduces the
sources of one recorded evidence run (#1446), and `check.mjs` (in CI) checks that it does.

Which tool answers which question:

| Question | Tool |
| --- | --- |
| Does an area's analysis (its publication, its stops) differ between two trees? | `run.mjs`, `stalls.mjs` ([Running an area](#running-an-area)) |
| Does a set's plan, diagnostics, charge trace or questions on the core's route differ between two trees? | `plans.mjs` ([Plans](#plans)) |
| What differs in a differing demand row, and which tree's output does the allowance stop? | `plans.mjs summary` ([Plans](#plans)) |
| Where does the core's route differ from the current checker on one tree (the shadow gate)? | `shadow.mjs`, `shadow-classify.mjs` ([Shadow](#shadow)) |
| Does a stop let a value through that the natural plan rejects? | `stop-runs.mjs` ([Stop runs](#stop-runs)) |
| What do the checker, the core and the core's route each answer for a list of cases, plans and runs included? | `differential.mjs` ([Differential records](#differential-records)) |
| Are two trees' records of a list of cases equal but for some fields, such as a changed message's `message`? | `differential.mjs join --ignore` ([Differential records](#differential-records)) |
| Which receiving-context class (A, R, R+, L, I; #1072) has each typed call of a list of cases, with its fixed points? | `receiving.mjs` (its header) |
| A compiler pull request's whole replay of base against head | `tools/compiler-replay.mjs` |
| Does a change outside the type core keep the current checker's output? | `tools/compiler-differential.mjs` |

## The runner's contract

What `run.mjs`, `stalls.mjs` and the stored baselines (`baselines.mjs`) promise; the sections below explain them.

- **Defaults** (`DEFAULTS`, `baselines.mjs`):
  - `--units 4` (`FAMILIES_UNITS`): a run stalls past 4 times its program's allowance, a publication run's question
    grant added (below);
  - `--timeout 1800` seconds a run (`FAMILIES_TIMEOUT`; 60 in CI), the safety net;
  - `--memory 2048` MB of heap for each source's process. It is the process's own `--max-old-space-size`, so it holds
    whatever heap `NODE_OPTIONS` sets, which holds for the runner's own process only. The usual source of a difference
    is the central queue, which sets `--max-old-space-size` in `NODE_OPTIONS` on every job: the total line (on stdout,
    and the work record's last line) carries `memory`, and beside it `nodeOptions.heapLimit`, the heap limit
    `NODE_OPTIONS` alone gives a Node process, where `NODE_OPTIONS` changes the heap at all and that limit differs from a
    source's process's. Each limit is V8's own, read by a probe process, so the runner reads no form of `NODE_OPTIONS`
    itself; a failed probe is said so (`nodeOptions.probe`, #1956);
  - `--allowances natural,16,256` for the stop runs.

  A stored baseline is made at these defaults: its PLAN records them, and `--store` refuses others.

- **A run's record** (`run-contract.mjs`, one module for the runner, the stall index and the store):
  - why its oracle left questions unanswered: `questions`, `memory`, `read-depth`, `stopped`, or `unknown` from a library
    that names none, each with the first node left or the binding where the answers' own questions stopped;
  - its limit (`limitOf`): `units` × its allowance, plus, for a publication run, its oracle's 64 units for each cell its
    questions returned, kept with the run as `questions`. A store writes and reads every run by the same limit;
  - its peak heap on each tree (`peak`, MiB, exact, on the source's `--work` line, and on each of the head's runs alone
    after the base's crash, `afterBase`): the used heap sampled every 65,536 units its tree's ledger charges and as it
    ends, so it holds garbage not yet collected and varies with when the collector runs. A run is near the cap (`isNearCap`) where its peak passes `NEAR_CAP`, 80 %, of the heap
    limit V8 gives a source's process (`heapLimit` in the total line, what an abort is against). The ground: at the
    default 2,048 MB the highest peak sampled over 36 runs near the cap (W19-sources, W24-varied and W24-alias-group at
    256 to 1,024, every mode) was 79 % of that limit, and the oracle's `memory` stop holds its questions about 512 MiB
    under it. Near the cap is advisory: counted, named, never a stall or an exit status, and never stored;
  - what each tree's build lacks of what the runner reads (`capabilitiesOf`): `publicationHashes` (else the publication's
    whole text is held), `QUESTION_UNITS_PER_CELL` and `questionWork` (else no question grant), `WorkLedger` (else no
    units and no unit limit). A tree that lacks one still runs; a compiled test asserts the built tree lacks none.
- **The total line** (stdout's last; `--work`'s last): the area, generators, sources, unparsed, stalled, exceptions,
  unanswered, unansweredAlike, uncompared, uncharged, runs, differences, `crashed: {base, head}` (stalls that ended the
  process, not the unit limit), `nearCap: {base, head}` (sources with a run near the cap on that tree), modes, the unit
  multiple, the safety net in seconds, `memory` (with `nodeOptions` where `NODE_OPTIONS` asked another heap),
  `heapLimit` (MiB, null where its probe failed), `capabilities` (each tree's lacks, by its part) and the Node version.
  Each generator's line counts `crashed` and `nearCap` the same way; the `--work` record's first line holds `heapLimit`
  and `capabilities` too.
- **A source near the cap** (`--out`, and the source's `--work` line): its runs near the cap, each with its mode, check,
  tree and peak, and in `--out` `heapLimit`. `stalls.mjs` prints those of the `--work` records it reads as one advisory
  line (`nearCap`: runs, sources, first witness); a `--out` file it reads gives its stalls alone.
- **A stall's record** (`--out`, and the source's `--work` line): its reason (`units`, or how the process ended),
  `at: {tree, mode, check}` (#1965): the tree it was on and the run it cut, each `null` where unknown (a stall between
  runs, a stored base's crash), and, where the base's process ended, the head's own outcome on each later run
  (`afterBase`). A stored shard's line keeps a stall over the unit limit's cut run as its certificate (`cut`).
- **Exit codes:**
  - 0: nothing differs, throws, stalls, is uncompared or uncharged, and every run left unanswered is left alike on both
    trees (`unansweredAlike`);
  - 1: something to read: a difference, an exception, a stall (a crash of the base among them), or a run left
    unanswered, uncompared or uncharged;
  - 3: the head crashed where the base did not, ahead of 1 (#1837's F24);
  - 2: a refused usage or record.

  `sx-job status` shows each but 0 as "failed".

- **The evidence total** of a replay is `stalls.mjs`'s total over the shards' `--work` records. It names each area
  complete only with its shards `0/N` to `N-1/N` of one plan, shared out alike (all by index, or all by one costs file,
  `--split`), counts a repeated place once and refuses a shard given twice; a sum of the shards' own totals counts each
  repeat. Its growth lines are advisory.
- **A stored baseline's identity:** its MANIFEST (the `src/` tree, the oracle library, the lockfile, Node) and each
  area's PLAN (the limits above, the allowances, each generator's checks, each shard's places, each by its generator's
  id). The runner's own source, `--work` records and `--out` files are no part of it, nor are peaks, `nearCap`,
  `heapLimit` or `capabilities`, which a stored shard's total line leaves out. `baselines.mjs state` reports, for each
  stored area, its runs left unanswered by reason and those within a question grant.

## Running an area

Build both trees (`npm run build:typescript`; each needs `dist/tests/helpers/type-core-oracles.js`), then:

```sh
node tests/families/run.mjs <area> <base checkout or dist> <head checkout or dist> [--sizes 4,8] \
  [--allowances natural,16,256] [--shard i/N [--split <costs file>]] [--units 4] [--timeout 1800] [--memory 2048] \
  [--out differences.jsonl] [--work <area>-<i>of<N>.work.jsonl] [--only <stall index>] [--items <sources> | --items-from-env]
node tests/families/run.mjs <area> <head> --baseline ~/work/baselines/<base src tree>/<area> [the same options]
node tests/families/run.mjs <area> <base tree> --store ~/work/baselines [--shard i/N]
node tests/families/stalls.mjs <shards' --work records>... [--rerun <rerun's records>...] [--index <new file>]
node tests/families/stalls.mjs rerun <stall index> <base> <head> <new folder> [--timeout 600] [--shard i/N | --items <file>]
```

Each source runs in the four modes (source and reversed order, the sharing on and off). The runner compares what it
publishes (`publication`) part by part (`publicationHashes`: the answers, the record, each occurrence's answer and the
route, in that order, each hashed as it is made), so a publication of any size is compared without one string of it, and
a difference names its first differing part by that index and each tree's count of parts (#1503); and, for a generator
whose `checks` include `"stops"`, which decisions stop and when at each demand allowance (`stopSet`). Unlike the held
set's stops in `plans.mjs` (per phase, over allowances), a stops difference here is classified per decision place (label
and path), over pass and ordinal (#2355): a place's stops identical on both trees pair first and the rest pair in
order, a pair `moved` and a surplus `added` on the head or `removed` on the base, each with both trees' pass and
ordinal; `listsEqual` where the difference is in the stop set's other fields. Which of a place's remaining stops pair is
that order, not a fact the oracle gives. A stored run holds no stops, as a reader before #2355 refuses them, so against
a baseline the line reads `unavailable`, naming the base; a run of the differing sources on two trees gives it.

A run (a source's mode and check on one tree) stalls where the units it charges pass `--units` times its program's
allowance (#1647): every `WorkLedger.charge` of the run (the analysis, its finishing work after a stop, the lowering's
store checks) against the largest `allowance` of a ledger it charged, max(30 M, 256 × syntax nodes). Units are the same
on every machine, so a stall is too. A run that ends past its allowance but within the limit (a budget stop, TSV076) is
an outcome, not a stall. A source that takes more than `--memory` MB of heap, or that ends its analysing process (a
fatal V8 error), stalls as well. A stall is counted with its reason (`units`, or how the process ended; `--out`), and
the runner goes on with the next source. Where the base's run ended the process, the head's runs from that one on run
alone in a fresh child, each recorded beside the stall as the head's own outcome (`afterBase` on the source's `--work`
line and in `--out`: answered, unanswered and why, unparsed, an exception, its own stall, or its safety net, counted as an uncharged run), so that the head's result
is never lost with the base's process (#1837). The wall clock is only a safety net, `--timeout` seconds a run (60 in CI,
which sets `CI=true` and runs only the runner's own tests): a run that reaches it does work no ledger charges (#1424's
class), and is reported as a defect with its source and run (`uncharged`, on stderr and in `--out`), counted apart,
never as a stall. The limit and the safety net were derived from a measured corpus ("The unit limit and the safety
net", below); they replace the 180 s a source that the agents chose on 2026-10-30 (#1512). The runs its process had written before the runner ended it still
count; one whose outcome it was still writing is lost with the process, and a final reply cannot finish the source once
its safety net has run out (#1498). After the kill the runner waits for the process and its pipes to close, so a
descendant holding its stderr delays the next source (no compiler or oracle code spawns one). A run that throws on
either tree is an exception, never compared, because identical exceptions on both trees are not agreement (#1439): the
runner prints it on stderr with its source, mode and check, writes it with each stack to `--out` and counts it apart
from stalls, in a source that stalls later too (`tests/families-runner/families-runner-compare.test.ts`, in CI). A publication is had only up to
the oracle's own stop. Its own questions (each binding's admitted types, then the occurrences) run apart from the
analysis's allowance and stop after the one whose units pass the program's allowance plus 64 per cell returned (an
occurrence's answer, its element's and each property's; two a binding), where 640 bytes per cell returned pass
their room in the heap, or past the read-depth limit (#1837). The room is taken before the publication's analysis:
the process's V8 heap limit less 1.5 GiB, which the analysis's own heap with sharing off needs (#1603: at the default
heap, `W19-sources`, `W24-alias-group`, `W24-exit` and `W24-varied` at k = 1,024 end as `memory` in all four modes,
#1945). Only where what ran before still holds more than 1.5 GiB after a collection (`--expose-gc`, as the runner's
child has it) is it the heap limit less that live heap less 512 MiB, so the run stops as `memory`, not in V8's abort. The
nodes from there on stay unanswered (`publicationHashes`'s `unanswered`, #1499), after the bindings left where the
admitted types stopped. A publication run's unit limit grants the same 64 per cell its tree's oracle reports so far
(`questionWork`; `limitOf` in `run-contract.mjs`, by which a store writes and reads the run too, its report kept as the
run's `questions`), so the oracle's stop comes first wherever a question reports its cells before the runner's limit; one
question's own cost is the runner's to bound. A run with any on either tree is first compared on what both
trees answered (`prefix`: the answers and the record, unless either's answers stopped at a binding, each occurrence both
answered, and the route): where that differs, the run is a difference, counted and recorded as one. Otherwise it agrees
only where both trees left the same count unanswered and published the same parts up to them (#1592): the bound is the
same on both trees, so what it leaves unanswered is too. That run is counted apart (`unansweredAlike`); any other is
neither agreement nor an exception: the runner writes it to `--out` and counts it apart (`unanswered`). Each such run records why on each tree
(`by`, on `--out` and the source's `--work` line, and on a stored run), with the first node or the binding left:
`questions` (the analysis finished and the oracle's questions passed their bound; their per-cell cost rises by a log
factor, #1941), `memory` (their room in the heap passed: the core keeps its answers, about 450 bytes a cell, so the
oracle ends before V8 runs out of heap), `read-depth` (the analysis finished and a question passed the read-depth limit), `stopped` (the
analysis's own budget stopped it), or `unknown` where the tree's oracle or a run stored before this names none. `stalls.mjs` counts them as runner artefacts, one group a reason and `unansweredAlike`,
each with its runs, sources and first witness, on a line of its own where any group has runs and always in `--index`.
It prints one JSON line per generator and the total line, and exits as the contract above says. Run large sizes as one
capped job per area or shard on a worker. Report stalls, uncharged runs and publication exceptions separately; none
establishes agreement.

A pool of shards on the central queue goes through `tests/families/items.mjs`, which writes its items the way the
runners read them and refuses a list that misses a shard, repeats one, names one past the last or holds another form
(a 1-based list skipped shard 0 twice in #1652's campaigns):

```sh
for area in copies joins; do node tests/families/items.mjs make 128 area "$area"; done > replay.txt
node tests/families/items.mjs make 8 held > held.txt
node tests/families/items.mjs submit replay.txt --target 10m --campaign <T> … -- bash -c '…'
```

`make <N> <words…>` prints `<words> 0/N` to `<words> N-1/N` (the runners' 0-based shards), `check <file>` checks a
whole list, and `submit <file> <options…> -- <command>` checks it, then runs `sx-job submit` with the file as its one
items option and the rest, so the items the check accepted are exactly the items the queue receives: it forwards only
the options that cannot change or multiply them, by full name (`--name`, `--owner`, `--campaign`, `--priority`,
`--for`, `--mem`, `--class`, `--timeout`, `--host`, `--node`, `--commit`, `--checkout`, `--patch`, `--in`, `--after`,
`--in-result`, `--needs-baseline`, `--data`, `--alone`, `--write`, `--target`, `--big`, `--writable-trees`,
`--sandbox`, `--dry`), and refuses any other, as `--shards` or another `--items`. A job reads its batch from
`$SX_ITEMS`, one item a line, its shard last. A pool can also hand out sources (#1826): `items.mjs sources <area>`
prints one place a line (`[generator, name, key]`, a repeated source once), `check <file> --area <area>` asks it to hold
the area's every source once, and a job runs its batch with `run.mjs <area> <base> <head> --items-from-env --work …`,
whose record names the batch, so the queue's `--target` balances sources rather than shards. A replay's per-area report is `stalls.mjs`'s area lines and total, counted
in sources, not a sum of the shards' log lines, whose `unansweredAlike` counts runs; a pool's shards run with `--work`,
whose records it reads.

A replay (`tools/compiler-replay.mjs submit`) shares each area out by its sources' recorded seconds (#2272): with
`--split <costs file>`, shard `i/N` runs the sources `split.mjs`'s `binsOf` gives shard `i`, longest first to the
least-loaded shard, by a costs file `split.mjs`'s `costsOf` makes from `--work` records (a baseline fill's or a
replay's). The record names the file's sha256; `--store` refuses `--split`, as a baseline's PLAN binds its shards by
index.

With `--baseline`, the head alone runs, against a stored run of the base: each run is judged as above against the stored
result of the same source (its generator, name and key, so an edited source is new), mode and check (unanswered alike
only where that result holds the base's parts and count), and a run the baseline does not hold is `uncompared`, never
agreement (`--out` names its source and runs); a source stalls or throws outside its runs where either the stored run or
the head did, and the head's runs after a stored stall are uncompared. A baseline stored since #1647 (its PLAN `plan
2`) holds each run's units and allowance, and a stall over the unit limit the run it cut; the head runs at its unit
limit (another `--units` is refused, exit 2). One stored before (`plan 1`) holds no units: it is read as before, and
the stall index says so (below). `--baseline` reads a folder's `*.runs.jsonl` files, and stops (exit 2) at a source
stored twice with other results.

`--work` writes a record of each source and changes no other output (#1564): a first line with what ran and the
comparison's configuration (`configuration`: the sources' sizes, the area's plan (the hash of every source's place, its
generator, name and key, in the area's order, before a shard or `--only` selects), the stop runs' allowances, each
generator's checks, the unit limit's multiple (a replay recorded before #1647 names none, and its rerun since adds
it), each tree as the runner executes it, its compiled compiler and oracle library read from the build it
loads, for a checkout, its `dist/` or a tree without sources alike, and a stored base as its baseline's MANIFEST names
it, which a rerun's base matches by its own identity), one line per source with each run's charged work (`work`: the
units its analyses charged their work ledgers, `WorkLedger.charge`, finishing work included; `null` for a tree without
one), its allowance (`allowance`) and milliseconds (`ms`) on each tree (with `--baseline`, the stored base's units and
allowance first, its milliseconds `null`, and the first line names the stored unit multiple, `stored`) and what the
source counted, and the total last. A source that stalls or reaches the safety net keeps the run then going on as the
runner ended it, from a progress record the child writes over beside the record
(`<file>.progress`, removed at the end; `--out`, `--work` and it must name three files) as a tree starts a run, every
65,536 units and as it ends it: the units charged, at most 65,536 short (exact at a stall over the unit limit), the
milliseconds until the stall and the tree running it (`running`). `stalls.mjs` reads a replay's records (a shard run
without `--work` by its `--out` file, which gives its stalls alone) and prints the rule it judges each stalled source by
(`RULE`), each stalled source with its verdict, each source a run of which reached the safety net (a defect, uncharged
work), and each area's counts and the total. Since #1647 a stall is judged from the records alone: a candidate where the
head alone stalled (over the unit limit on a run the base ended with its units recorded, or for memory or a fatal
error), inherited where the base stalled too, or alone, and unknown where no units of the base are recorded on the run
the head's stall cut (a baseline before #1647, a tree without a ledger), the base stalled at a time limit, or no record
names the tree. The base's units decide only a stall over the unit limit: a head that alone stalls for memory or a
fatal error is a candidate whatever units are recorded, as no unit record would change that verdict. The transition
rule: a replay recorded before #1647 (no unit limit in its configuration) is judged by the rule then, also after its
stalls are rerun by a runner since; the rerun's unit limit is added to its configuration and ignored for that verdict.
A replay since #1647 is judged by units. A record made before #1647 is judged by the rule then (a candidate, load or unknown, its time
clause a heuristic). An
area's records must share one configuration (another is refused, exit 2), so the area is complete only with its shards
0/N to N-1/N of one N, together every source of one plan, or with an item pool's batches alone (#1826), each naming the
area's count of sources and together holding that many (batches beside numbered shards are incomplete), and a source a plan lists more than once (a repeat, which the
runner runs and counts each time) is one source where its repeats record the same counts, stall and runs, milliseconds
apart, refused (exit 2, naming the place) where they differ; a source counts as `agreed` only where it was compared in
every run and agrees, and as `unansweredAlike` where its runs agree but for some unanswered alike, each such source
named on a line of its own with its number of those runs; `closed` (exit 0) needs every area complete, every source
agreed or unanswered alike and no candidate left. `--index` writes the sources still unavailable, with their verdicts
and records and each area's configuration, and names those unanswered alike apart. A stall is the same on every machine,
so a rerun decides only an unknown one, against a baseline that stores no units: `stalls.mjs rerun` runs the index's
sources alone, one at a time with both trees in one process and the replay's configuration (`run.mjs <area> <base>
<head> --only <index>`, an area after another, each once by its name, whatever paths its entries name; only `--timeout`
and `--memory` may differ),
and `--rerun <folder>/*.work.jsonl` reads its records in place of the replay's, so the replay closes without another
campaign; a record of another configuration is refused, and a rerun that ends does not clear a candidate. Older
`--work`/`--out` comparison records omit the answered parts, so `stalls.mjs` cannot reclassify their `unanswered` runs.
A runner implementing #1592 must compare them again; `rerun` does this for indexed stalled sources, including their
earlier unanswered runs. Completed sources' unanswered runs need a fresh comparison. Rerun records are read in the order
given, an earlier round's first: where a source's earlier rerun stalled, or its later one stalls, the later stands (a
round at a larger `--memory`, or a record before #1647 at a longer `--timeout`, may run what an earlier one could not),
and two that ended must say the
same, else refused (#1587); a replay's records are never replaced. `rerun --shard i/N` (#1598) reruns only the index's
entries `k` with `k mod N = i`, in its order, into `<area>.<i>of<N>.work.jsonl` and `<area>.<i>of<N>.jsonl` beside that
part of the index (`index.<i>of<N>.json`) and nothing for an area that part does not hold, so N jobs rerun the index
once and `--rerun` reads their records as one round. `rerun --items <file>` (or `--items-from-env`, the file the central queue's `$SX_ITEMS` names) reruns only the entries its lines
name by number (0-based, in the index's order), into `<area>.items-<hash>.work.jsonl` beside `index.items-<hash>.json`,
so that an item pool (`sx-job submit --items <file of entry numbers> --campaign T … -- bash -c '… stalls.mjs rerun …
--items-from-env'`) sizes the jobs (5 to 15 minutes each, the owner's rule) and its batches rerun the index once (#1612).

`--store` runs one tree of a commit (an `sx-tree` tree: `src/`, `dist/`, `.sha`) at the runner's defaults and stores one
shard of an area, each source's results as one line, in the baseline of its `src/` tree,
`<folder>/<src tree>/<area>/<i>of<N>.runs.jsonl`, where `<src tree>` is `git rev-parse <commit>:src`. Every commit with
that tree and the same oracle library, lockfile and Node shares the baseline; one that differs in any of them stores
none there (base and head run instead). `baselines.mjs` reads and writes the baseline: a folder whose `MANIFEST` it
wrote while the folder held nothing else (what its runs depend on, the commits stored there, each area's `PLAN`),
holding only paths it writes, each named exactly as it names them; a folder holding another path is not written into,
and the refusal names the path. Each area's `PLAN` binds its shards' sources in their order and its checks, and a
writer that would run another is refused (exit 2); its limits (`plan 2`, since #1647: `limits <multiple> x allowance
units, <seconds> s safety net, <MB> MB`, `FAMILIES_UNITS` and `FAMILIES_TIMEOUT` overriding the runner's defaults; a
`plan 1` one's a time a source) bind it too. Under `plan 2` each stored run holds its units and allowance, an ended
run's within the limit, a stall over the limit the run it cut, a charged ledger's allowance above 0 and units over the
limit (its certificate, the same on every machine), and a run that reached the safety net is named apart (`uncharged`,
the run or `outside its runs`), never a stall: one rule for a stored line (`sourceFault`), by which the store checks
each line it writes and every reader of a shard reads it. One rule says whether a stored shard counts, and status,
import, the store and `--baseline` all read shards through it: its total line names its own baseline's inputs (the
`MANIFEST`'s `src/` tree, oracle library, lockfile and Node; any commit of that tree), the `PLAN` and the shard's
planned sources, which are its lines in their order, each one a store writes, and hashes every line before it. A shard
that would count but names other inputs or holds a line no store writes is refused by its readers (exit 2), and a store
does not skip it but stores it again; one that does not verify leaves the area damaged (exit 1), and the next writer of
that shard replaces it. `--baseline` reads an area only where it is complete under that rule, and is
refused as status refuses it otherwise. One running writer at a time stores a shard. Every write into the baseline
but its `MANIFEST`'s making goes through one gate in `baselines.mjs`, which holds the baseline's lock. A store writes
into its tree's baseline only (and its `--out` and `--work` records, with the latter's progress record), and runs
where only that folder and its scratch are writable: `sx-sandbox --write ~/work/baselines/<src tree> --write <scratch>
-- node … --store ~/work/baselines …`, with `TMPDIR=<scratch>`, as the hook queued its jobs (`baseline.sh compute`
also makes `<out>` writable, where its store's `--work` record goes); a write anywhere else fails (EROFS). `node tests/families/writes.mjs`
lists the writes the tools' source shows, an advisory check for the plain forms of a write outside the gate. Nothing
removes a baseline.
`bash tools/corpus/baseline.sh status <commit>` says in one line what each area of the commit's tree holds, and exits 0
only when each one is complete. Before a base run, ask it: compare the head with a complete area through `--baseline`,
and store an area that is not from the base tree's own runner and areas
(`node <base tree>/tests/families/run.mjs <area> <base tree> --store ~/work/baselines --shard i/N`, one job per shard,
N the area's PLAN count: `copies` in 64 where a baseline first plans it, for a 60-minute wall on the slowest worker
(#1826), every other area in 16; a baseline that recorded another count keeps it, and `--baseline` compares a head of
any shard count with it,
the fixture area as `<base tree>/tools/corpus/fixture`), so that it serves every later run on that tree. The script,
installed as the desktop's `~/work/trees/hooks/baseline`, fills each new `main`'s tree at low priority where nobody
stores it. A fill that began runs to its end (#1590, reversing #1567, whose fills cut short were never read); one none
of whose jobs began ends without running once `main` has another `src/` tree, and waits for a builder's store or for
that tree to be `main`'s again.

A fill can also run on any worker into a central store (#1590). `bash tools/corpus/baseline.sh seed <tree> <SHA> <out>`
makes `<out>/<src tree>/` (its `MANIFEST` also naming the tree's build of the compiler, `compiled <dist/src/ tree>`,
and every area's `PLAN`) and `<out>/shards.tsv`, one line per shard to store. `baseline.sh compute <tree> <seed
baseline> <area> <i>/<N> <out>` stores one shard into a copy of the seed at the `PLAN`'s limits, with `--work`, into
`<out>` (an existing folder, the job's `$SX_OUT`): a stall
is the same on every machine, so it is stored once and listed in `<out>/stalls.json` with its reason and, over the unit
limit, the run it cut; `<out>/<area>.<i>of<N>.work.jsonl` is the store's record of each source's units and time. #1612's
run alone at twice a time limit, with `baselines.mjs alone` and `merge`, went with #1647; a seed before #1647 (`plan 1`)
is computed by its own tree's script. `baseline.sh submit <SHA> <src tree> [<seed job id> <shards.tsv>] [--dry]`
prints or submits these steps as central-queue jobs. Every write into the central store is `node
tests/families/baselines.mjs import <central folder> <computed folder> [<area> <i>/<N>]`: a seed's `MANIFEST` and
`PLAN`s are adopted where its baseline is absent, else checked equal; a shard is accepted only where its `MANIFEST` and
`PLAN` are the central ones, it counts, and each source that stalled in it is listed in stalls.json (under `plan 1`
with its run alone that stalled too), and one already there is compared by its lines, which hold no time, and never replaced, with one exception: where they
differ only in that one of a source stalled and the other holds its complete result (every run the stalled line ended
the same in it), that is no value difference, and the complete result stands, kept or put in the stalled line's place,
since a stalled line holds no result; the source is named (`stallOnly`; `sx-fill`, the platform's wrapper, does not yet
reconcile its stall report with it or pass it on: #1636). Any other difference replaces nothing. It exits 0
imported or equal, a stall-only difference among them, 2 refused (naming why), 3 differs. `node tests/families/baselines.mjs status <central folder> <src tree>` says in one
line what a central baseline holds, without a tree, and exits 0 only when it is complete.

A mutant is a head tree with one file changed. Its verdict counts only beside proof that the change was applied: the
mutated file's hash in the head tree, which differs from the base's. Without that proof the result is NOT_RUN, never
"killed", the same way identical exceptions on both trees are not agreement (#1439).

## A seeded family

`seeded.mjs` (#1652's builder, for #1646) generates one program per seed, objects copied into each other's properties
and lists then a host value stored below them, compiles it on two built trees in the source order, and prints one
JSON line per seed: each tree's units, whether the outcomes (each diagnostic's code and offset and the plan's checks, or
a thrown error) are the same, and both and the source where they differ. It is not an area of `run.mjs`: its sources
are generated, not recorded. `seeded.sh` runs it as a central-queue item pool, each item `<first seed> <count>`:

```sh
for i in $(seq 0 39); do echo "$((i * 50)) 50"; done > seeds.txt
sx-job submit --commit base=<base> --commit head=<head> --items seeds.txt --target 10m --campaign <T> \
  -- bash -c 'bash "$SX_TREE_head/tests/families/seeded.sh" pair'
```

## Plans

`plans.mjs` (#1526 phase A's kit, landed from #1678's copy) compiles each source of a set through the core backend on
two built trees in one worker, in the four modes, each the base's `HELD_MODES` entry with the head's of the same `name`
(#2342; trees whose modes are not the same names once each are refused, exit 2), and compares the plan, the
diagnostics, the trace of every unit the compile charges and the questions it asks its answers, exactly; `--demands
16,64` also at those demand allowances, `--stops` the held family's settled stops and questions phase. A set is
`corpus` (the cases file `CASES_JSON` names), `fixture`, `held`, or an area by its name or folder. A run (one compile
of a source in a mode on one tree, or one
analysis of the held family's stop search, or that search's work between them) stalls by the runner's rule above: its
units past `--units` (4) times its program's allowance, the allowance of the source's natural compile for a run at a
test allowance; a run past the safety net, `--timeout` (1,800 s), makes its source `uncharged`, never a stall. A worker,
fresh or after a stall, gets no source before it has loaded and checked both trees, also within `--timeout`; otherwise
the run ends with exit 2, and the next source gets no record. One JSON line per source (its set, name and `key`) goes to
`--out`, whose sources, by name and key, a rerun with it counts as recorded without running them again, and a summary to
stdout; `plans.mjs summary <records>...` classifies the records (identical, work only, questions, publication, stops)
and lists each difference, stall and uncharged source. A differing demand row takes the same one class (publication
where the plan, the diagnostics or the error differ, else questions, else work), lists every part apart, and says which
tree's output the allowance stops against that tree's own unstopped compile in the mode (base, head, both or neither),
each counted. Where a held mode's stop sets differ, the record keeps both trees' stop lists (#2340), and the summary
says per phase which tree added, removed or moved its stops, with both trees' allowances; a stop that changes phase over
an overlapping range reads as one removed and one added, and a record without the lists (from before #2340) is counted
unavailable, never equal. `summary` first checks every line's keys, types and value formats against those the runner
writes: a gate against malformed, foreign and truncated lines, which refuses the input (exit 2), not a proof of the
invariants between one record's fields. A record and a stall's run name their mode by that `name`; a record from before
#2342 holds a number, the mode's index in `HELD_MODES` at the commit that wrote it (`forward`, `reversed`, `forward,
unshared`, `reversed, unshared` from 3804b7d3f, where the table began, to this day; the oracle's `MODES` orders them
otherwise), printed as that number and never translated. A builder runs the head tree's copy instead of copying a kit,
and extends it here where a comparison needs more:

```sh
sx-job submit --commit base=<base> --commit head=<head> --shards 16 --mem 3G --timeout 1h --campaign <T> \
  -- bash -c 'node "$SX_TREE_head/tests/families/plans.mjs" "$SX_TREE_base" "$SX_TREE_head" <set> --shard {i}/{n} \
  --out "$SX_OUT/plans.jsonl" > "$SX_OUT/plans.log"'
```

For `corpus`, add `--data ~/work/o4-m4-g3/cases.json` and `CASES_JSON=$HOME/work/o4-m4-g3/cases.json` before `node`.

## A pull request's replay

`tools/compiler-replay.mjs` runs a compiler pull request's replay of its base against its head through the queue: the
set and every area above, in 16 shards each; the replay steps live in `tools/compiler-replay/`, `plan-checks` in the
entry. Each step's inputs, in order:

- **`submit <base> <head> --owner <owner> [--campaign <prefix>] [--baseline] [--dry]`:** the two commits. It queues
  `<prefix>-set` and `<prefix>-areas` and prints each job's id.
  - The areas are those `baselines.mjs` takes: the folders here that hold a generator, and the fixture folder
    `tools/corpus/fixture`, each passed by its folder. Copies runs at `--memory 6144`.
  - `--baseline` compares the areas with the base's stored runs (`--needs-baseline`). The set always runs two trees.
- **`collect <prefix> --owner <owner> [--results <folder>] [--json <file>] [--replace <job>=<job>]...`:** the
  campaigns' results.
  - It prints each area's shards, sources, runs, differences and stalls, and the set's.
  - It prints each difference that stands: an area's by its first differing part, a set mode's by what differs. A
    difference in the route alone (the last part, as many parts on both trees) stands until `aside`'s rows agree.
  - It reads the stall verdicts from `stalls.mjs`, with `<prefix>-rerun`'s records.
  - A shard is its job name, and one of its attempts is read: the one that left a summary line and whose queue record
    (`meta.json`) shows the runner's own ending: exit 0 or 1, or 3 for an area job, with the queue's outcome for that
    exit, an empty `oom`, no timeout and no lost test file. Every other attempt, one killed after its summary among
    them, is listed with its host and outcome as replaced, and never read.
  - A shard with no such attempt is "not run", never equal.
  - Several such attempts are refused unless all but one are replaced, by a rerun's record (`rerun-shard`) or by
    `--replace <failed>=<rerun>`. A replacement is refused across shards or campaigns, or by a rerun that cannot stand.
- **`rerun-shard <prefix> <base> <head> <job> --owner <owner> [--baseline] [--host <host>] [--dry]`:** a failed or
  killed job of `<prefix>-set` or `<prefix>-areas`. It submits that shard again into its campaign, `submit`'s own
  submission with the shard written in. Its `bash -c` script opens with `: replaces <job>;`, so that the rerun's record
  (`meta.json`'s `command`, kept verbatim) names the job it replaces; `collect` refuses a record naming a job outside
  its shard. `<job>` may itself be a rerun. It is refused when `<job>` ran another script or trees. `<base>` and
  `<head>` go to the queue as full SHAs: what this clone resolves each to, else the job's recorded commit it is a
  hexadecimal prefix of. `--host` pins the worker.
- **`rerun-stalls <prefix> <base> <head> --owner <owner> [--memory <MB>] [--host <host>]`:** the standing attempts'
  work records. It reruns their stalled sources on both trees in one job (`<prefix>-rerun`), at 12,288 MB unless given.
  A work record `stalls.mjs` refuses is exit 2, never "no stalled source".
- **`aside <prefix> <base> <head> --owner <owner> --declare <file>`:** the route-only differences, the differing set
  sources, and a declaration file.
  - The file is a JSON list of `{ "pattern", "reason" }`, passed as an argument and never read from elsewhere.
  - It compiles each row on both trees in one job (`<prefix>-aside`). A row agrees where the plans' JSON text is
    byte-equal and the route text is equal once every declared pattern is removed.
- **`plan-checks <plan.json>...`:** plan files, counted by `tests/helpers/plan-checks.ts`'s `planChecks` from a built
  tree.

Exit statuses:
- 0: the step did what it says. For `collect`, every shard ran, and nothing differs, stalls or stays uncompared beyond
  route text that `aside` set aside.
- 1: something differs, stalls or did not compare; each is listed.
- 2: a usage error, a refused replacement, or input it cannot read.
- 3: for `collect`, a shard did not run.

## Stop runs

`stop-runs.mjs` (#2080) looks, on one built tree, for a stop that lets a value through that the natural plan rejects.
For each item it compiles the unit unstopped and at the item's demand allowance, in its mode, and runs both plans over
host data: `stopRuns` and `hostValues` in `tests/helpers/type-core-stop-runs.ts`, which also feed that data to
`stopProblems` as its violating runs. The host data holds scalars and collections, objects by the unit's own property
names and paths, and values made from every type either plan checks.

It claims only what it demonstrates (#2142, under docs/DEVELOPMENT-WORKFLOW.md#review-convergence). As #2080's design
round put it: positive escapes are the blockers; an unwitnessed cell is unresolved evidence.
- `open`: a run where the natural plan fails at runtime and the stopped plan runs to its end. With no natural plan (a
  compile error the stop turned into runtime checks): a run in a single-file unit that executes the error's own store
  instruction, the innermost one holding the error's site, and passes it. A store's absent property (C5c) is read at the
  store, not at the object the diagnostic names.
- `later`: a run where both fail at different sites, and the stopped run executed the natural failure's exact
  instruction and passed it, in a single-file unit with no loop round in its trace (`docs/RUNTIME.md#instruction-trace`).
- `closed`: the two plans are equal. Nothing else is `closed`, and nothing without a natural plan ever is.
- `unwitnessed`: every other difference, among them multi-file units, loops, an earlier failure, a failure of a sibling
  or of another check, and a no-plan error not shown passed. It is unresolved evidence, never proof that no check is
  owed. `untested` lists each place the plans differ that no run failed either plan inside, and with no natural plan
  each natural error's site; it and the type-derived values find escapes and never decide `closed`.
- `declined`, `natural declined`, `no plan`: a refusal, or nothing to run.

An item is a `plans.mjs` record's `{set, name, key?, mode, demand}` or a records row's `{files, globals, label, demand}`.
A set's item runs the unit of its name and, given one, its `key` (`sourceKey`, which `units.mjs` gives every unit):
units of one name with one key are one unit, and an item matching units with different keys is never resolved by a
pick (#2254). The tool writes `rows.jsonl` (each with the `key` it ran) and `summary.json` to `--out`, a missing unit's
row marked `missing`, an ambiguous item's `ambiguous` with the keys it matches.
- Exit 1: any `open` or `later` item, a missing or ambiguous unit, or an exception.
- Exit 2: a usage error or a bad `--shard`.
- `unwitnessed` is counted, not failed.

```sh
sx-job submit --commit t=<tree> --shards 8 --mem 6G --campaign <T> --in <items.jsonl> \
  -- bash -c 'node "$SX_TREE_t/tests/families/stop-runs.mjs" "$SX_TREE_t" "$SX_IN/<items.jsonl>" --shard {i}/{n} \
  --out "$SX_OUT"'
```

## Differential records

`differential.mjs` (#2298) writes, for each case of a cases file on one built tree, one JSON line holding what the
current checker (`compileProject`), the core (`analyseCore` with `checkedResult`, as the compiler reads it) and the
core's route (`publishedRoute`) each answer, the core and the route in the four `HELD_MODES`. The same tree and cases
give the same bytes. It judges nothing: a reader compares the records, and two trees' records are joined by case name.
It has no unit limit and no process of its own per run, so it is for case lists; areas and the corpus at scale stay
with `plans.mjs` and `shadow.mjs`.

A case is one JSON line: `{name, source | files, globals?, runs?, storage?}` (`globals` `["hostValue"]` by default),
or `{name, set, unit, key?, runs?, storage?}` for a unit of a set as `stop-runs.mjs` names one (`unitResolver`,
`units.mjs`). `runs` is a list of the host globals' values, each run on every plan (`runGlobals`); `storage`, an object
of stored values by key, is the script storage each run starts with, so a `load` reads it (#2338). A name twice, an
unknown key, a malformed line, a set's unit missing or ambiguous, `storage` without `runs`, or storage that cannot be
copied or that the tree's runtime rejects (`validateScriptStorageEntries`) refuses the whole file (exit 2) before any
plan runs or record is written. A run's host values are checked by the runtime as each run starts: a value it rejects
is that run's `threw`, and the run exits 1.

A run claims its `--out` once its arguments are read (#2383): it removes what stands there then; an output that is one
of its inputs, by any path or link, is refused instead. It writes its records to a partial it creates, named by its pid,
and renames that onto `--out` once whole. After its claim it removes nothing it did not create, so a run that ends
without publishing leaves no earlier result at `--out`, and a run that dies midway leaves only its partial. The
exception is a file the run cannot reach or remove: the claim then refuses (exit 2) and says so. Two runs on one `--out`
at a time are not supported: the later claim removes the earlier output, and the loss is a missing file, never another
run's records under this run's name.

A record is `{name, case, checker, core, candidate}`:
- `checker`, and each mode of `candidate` that is not refused: `diagnostics` (severity, code, path, one-based line and
  column, offsets, message), `plan` (`null`, or its `hash`, the first 32 hex digits of the sha256 of `jsonText(plan)`, as
  `plans.mjs` hashes a plan, and `checks`, `planCheckList` in `tests/helpers/plan-checks.ts`: each check's field, path,
  line, offsets and, where it names them, type, place and part), and `runs` where the case names some and there is a
  plan (`{globals, storage?, status, failure, said}`, `storage` where the case names it);
- a refused mode of `candidate` is `{mode, outside}` with the refusal's text and no diagnostics;
- `core` is `{unparsed: true}` where the files do not parse or resolve, else each mode's `outcome`, `diagnostics` (class,
  kind, code, path, line, offsets, the site's text, `coreMessage`) and `checks` (`coreRecord`'s run-time checks: kind,
  target, against, boundary, site). Its diagnostics are the analysis's own and those `checkedResult` adds, such as
  `TSV062`, as the compiler reports them;
- `candidate`, and `core` where the files parse and resolve, hold `modes`, always four, each with its `mode` name, and
  `agree`, whether they are equal but for that name. A part that throws is `{threw: "<name>: <message>"}` in its place
  (a mode, a run, the checker, or the whole `core` where its request throws), and the run exits 1.

`join --cases <cases.jsonl> --base <records>... [--head <records>...] --out <file>` checks every case recorded once on
each side and no other record (else exit 1, nothing written; a side given with no files has every case missing) and
writes them in the cases' order: the record, or `{name, base, head}`. It reads each record's name from the start of its
line and copies the line as bytes, so a record longer than V8's longest string still joins; a line cut short, or an
output that is one of its inputs by any path or link, is refused (exit 2), and the output appears only once whole.
Writing a record that long ends the run with an error instead, and `join` then finds its case missing.

`join … --ignore <field>...` (repeatable; base and head both given) writes the same output and also compares each case's
base and head as JSON values with every field of those names removed at any depth (`--ignore message` masks the
checker's, the core's and the route's messages; `messageKind` is another field). Its summary line adds `ignore`,
`differ` (a count), `differing` (the names of the cases that still differ) and `unread` (cases whose differing records
do not parse, such as a record longer than V8's longest string); it exits 1 when either list is not empty. Records equal
as bytes are equal without being parsed.

A batch of an item pool is itself a cases file, so the queue sizes the jobs; the plan's check list comes from the
tool's own build, so the tool's tree may be newer than the tree it reads:

```sh
sx-job submit --commit tool=<tool> --commit t=<tree> --items cases.jsonl --target 10m --mem 8G --campaign <T> \
  -- bash -c 'node "$SX_TREE_tool/tests/families/differential.mjs" "$SX_TREE_t" "$SX_ITEMS" \
  --out "$SX_OUT/records.jsonl" < /dev/null'
node tests/families/differential.mjs join --cases cases.jsonl --base <base jobs' records.jsonl> \
  --head <head jobs' records.jsonl> --out joined.jsonl
```

## Shadow

`shadow.mjs` (S9b's interim and S11's final shadow comparison, landed by #1704 from the S11 readiness research's copy)
compiles each source of a set (`corpus`, `fixture` or an area) through both public routes of one built tree, the legacy
backend and the core (`decisionRecords`), in the four modes, and writes one JSON line per source to `--out` and the
core's decision records to `--decisions`. Each route runs in its own process with `--memory` MB of old generation
(2,048, the families runner's, so both compare a source under the same cap; a route's process starts without the
caller's `NODE_OPTIONS`, such as the queue's heap flag, and with no other Node option of the caller's, #2329), under
the unit limit below (the legacy route charges no ledger) and the safety net. A run that fails (heap, units, safety
net, the process's end, a V8 abort at its heap limit included: #1738) leaves the source's other runs and is recorded as `{ outcome: "failed",
failure, phase, runsBeforeFailure, heapMiB }` (`heapMiB`: the worker's heap limit as V8 measured it) in its row and in
the record's `failed` list, with `incomplete: true` and the first failure as `reason`; the next run starts in a fresh
worker. A reused worker's heap failure or safety net is retried once in a fresh one, whose result is the run's
(`retried` names the first). `--demands 16` also runs the core route alone at that demand allowance in the four modes
and keeps each run's outcome and decision counts under `demands`: the gate's completion control, since nothing stops at
the natural allowance on current main, so no natural run reaches a receiving completion. It classifies nothing;
`--manifest` prints the sources the same options owe, one `{ key, name }` line each, and runs nothing. An incomplete
record is never agreement.

```sh
sx-job submit --commit <sha> --shards 16 --mem 6G --timeout 2h --campaign <T> -- bash -c \
  'node "$SX_TREE/tests/families/shadow.mjs" "$SX_TREE" <set> --shard {i}/{n} --demands 16 --out "$SX_OUT/shadow.jsonl" \
  --decisions "$SX_OUT/decisions.jsonl" > "$SX_OUT/shadow.log"'
```

`shadow-classify.mjs` (S11's classification, taxonomy version 5) reads the records of a campaign (and the S11 readiness
research's `results.jsonl`, whose crashed sources have no rows) and gives every route pair (a source in one mode, legacy
against core) exactly one class, and every source in each order one class of the sharing column, the core with sharing
on against off (#1711). Each class has its rule in words, a witness and a gate state: `pass`, `attributed` (the rule
class is known; S11 still owes each source's accepted expectation), `accepted (condition 1; condition 2 list)` or `open`. Pairs: `agree`; `differs/stop`,
`/surviving`, `/integer`, `/rule` by the codes whose diagnostic identities (path, code, severity, offsets) changed, in
that precedence, then `/checks`, `/plan`, `/wording` where the identities are equal (the other differing parts are
columns of the pair); from version 5 `declined/lost check` (accepted: the core declined the program where a stop lost a
check it requires, #1781; any other decline text is unclassified); `excluded/<text>`, the research's 53 exclusion texts as 48 rules, and from version 2 `this return statement`, the camera and tag-query texts (#1744) and the open part of a typed default (#1072), and from version 4 a typed default a stop left open (#1775); `failed/ legacy-heap` (the
legacy route's heap in its analysis with the core finished: legacy behaviour the switch resolves, #1075),
`failed/other`, `exception`, `aborted-record`, `unavailable`. Sharing: `equal`, `one-mode-stop` and `both-stop-differ`
(attributed, each row for the stop oracle's judgment), `neither-stops-differ`, `outside`, `uncompared`. Every rule is
tested on every pair: a pair none takes, or two, fails the run (exit 1), so an exclusion text no version names, or
changed codes that none of the rules' codes decide, fail until the next version adds them with a witness; so does input
the classifier cannot read whole (a compared row without its four delta parts, a manifest line without its key), a
record outside `--expect` or a key recorded twice with different readings. The gate table (`gate.json`, `gate.md`) adds
the differing pairs' parts, the research's inventory signatures (`signatures.tsv`), decision coverage (open unless the
natural runs hold ordinary decision records and at least one run at the demand control, 16, reaches a receiving
completion) and, as information only, the sources whose core differs across the four modes and the control's runs that
left the slice, one row a class that names a text, `declined/lost check` and each rule of `EXCLUSIONS` (zeros
included), and one a text no class names (`Unlisted control texts`); the verdict line is `gate:
green` only with no `open` row, and `--gate` (S11's final run, with `--expect`) exits 1 otherwise. Over the research's
records it reproduces its aggregate (`~/work/evidence/1728/`):

```sh
node "$SX_TREE/tests/families/shadow.mjs" "$SX_TREE" <set> --manifest > expect.jsonl
node tests/families/shadow-classify.mjs <shards' shadow.jsonl>... --expect expect.jsonl --out <folder> [--gate]
```

From version 3 the group table in `shadow-groups/` decides the pairs of the four grouped classes (`differs/rule`,
`/checks`, `/plan`, `/wording`; `--groups <folder>` reads another, `--groups none` none). `groups.json` holds each
adjudicated group: `conforms`, `defect` or `pending`, its title, what closes an open one, its witness.
`bindings.jsonl.gz` holds one line a bound pair: its source key and guard by their first 16 digits, its mode, its group,
its class. A pair takes its binding's group where its key, mode, class and guard (`pairGuard`, the sha256 of its
reading) all match; otherwise it is `changed` (bound, but its reading or class differs) or `unbound` (no binding). Only
`conforms` is attributed. `defect` stays open until its issue closes, `pending` until its construction lands, and
`changed` and `unbound` until a re-adjudication; each closes only by a new table, never by a matching signature (one
signature spans several groups). `gate.json` names both files' sha256. Keys and guards are kept by their first 16
digits: two of the gate's sources sharing a key prefix would need a 64-bit collision, and none of today's 12,644 bound
sources do. `shadow-bind.mjs` writes the table from an adjudication and the run it adjudicated, refusing a
binding whose raw publication differs from its record's. A re-adjudication replaces both files whole, so the table's
history is by version, not by diff. The first table is Sol's preparation of gate run 2 (#1744 comment 6655890944).

The #1704 witnesses (`copies`, `--only` with `1188-sol-candidate-neighbours.mjs/node-graft@8`, `node-mixed@8`,
`node-graft@64`, `node-mixed@64`, `construction/node-graft@64`): at 8 both routes plan in every mode; at 64 the legacy
route's heap is exhausted in `analysis` in every mode, and the core plans.

## The unit limit and the safety net (#1647)

The rule is orchestrator 2's, on the owner's delegation of its threshold (#1647, 2026-11-03). It was measured with this
runner on `main`'s `src/` tree `a5af3a394`: a fill of every area at the runner's defaults (231,456 runs) and the
15,406-source set without a unit limit (61,624 runs). Every run ended; none stalled or reached the safety net.

- `m = 4`: the largest total was 2.46 times its allowance (73.8 M units of 30 M, `copies` `3a-spike14-gates.mjs`
  `W18-number@1024`, `rev-off publication`; the set's largest 1.62, `graph/224`). 4 is the smallest whole multiple at
  least 1.5 times that.
- A safety net of 1,800 s a run: the longest run took 380 s (`messages` `1241-astra-r4-extra.mjs` `original-4`,
  39.5 M units, on the laptop). The unit limit at the floor, 120 M units, takes 255 s at the slowest worker's
  10th-percentile rate (TrueNAS, 470 units/ms; the laptop's 638), so the net is 7 times that and 4.7 times the longest
  run. A run as slow per unit as the slowest measured (52 units/ms) would reach the net before the limit: it does
  mostly work no ledger charges, and the net reports it so.

## A generator

A folder of `tests/families` that holds a generator is an area: the check and the baselines find the areas by
`sources.mjs`'s `generatorFolders`, the baselines adding the corpus fixture (`tools/corpus/fixture`). An area's
generators are its top-level `.mjs` files; an area with none there holds groups, one level of subfolders, whose top-level
`.mjs` files are its generators (`generatorFiles`, which the runner, the check and the baselines share). A group's own
subfolders are never read, nor an area's subfolders beside a top-level generator, so `property/`'s tool modules are no
generators. A folder of data only is no area; a utility module stays outside the areas and their groups, as
`shadow-bind.mjs` does (#1786).

A generator's id is its `id` export, else its file name, `.mjs` included and its group left out (`generatorsOf`), so a
generator moved into a group keeps its id. A source's place in a
baseline, its area's PLAN, and the runner's records and stall index name the generator by its id, so a renamed generator that keeps its old file
name as `export const id` and names it in its header line keeps every stored line and its area's PLAN; its `--work` and
`--out` lines add `file`, the new name, which a stored line never holds. Two generators with one id are refused.

A module `tests/families/<area>/<name>.mjs` (`<area>/<group>/<name>.mjs` in an area of groups) with no imports beyond `node:` built-ins and no side effects:

```js
// <what it generates> (<its origin>)
export const sizes = [64, 128]; // the recorded run's sizes
export const shapes = { "<shape>": (n) => "<source>" }; // or (n) => [{ path, source }]
// or fixed sources: export const cases = [["<name>", "<source>" or [{ path, source }], <globals>?]];
export const checks = ["publication", "stops"]; // default ["publication"]
export const globals = ["hostValue"]; // the run's host globals, where they are not the default
export const recorded = {
  commands: [["<command>", "<where it is recorded>"]],
  sources: 0,
  sha256: "<set key>",
};
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
  families (`tests/helpers/type-core/families/`), its paste family (`pasteCases` in `tests/helpers/type-core/type-core-paste.ts`),
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

## Reading decision records

A probe reads a compile's admission decision records with `decisionRecords` (`tests/helpers/type-core-oracles.ts`): one
compile through the public route, its receiving completion included, each pass's records and each completion's apart.
With `require` (`requireRecords` over a campaign's runs) it fails where no record of a kind was read: #1685's first
debit probe read properties the records are not under and compared empty lists.

## Site keys

An oracle or runner keys a site by its file and its offsets (`tests/helpers/site-keys.ts`: the compiler's `siteKey`, a
plan instruction's `planSiteKey`, `enclosingFunction` in the site's own file). `npm run lint` refuses, in `tests/helpers/`
and `tests/families/`, a map's or a set's key whose text holds a site's offsets and not its file, read one step through
its variable or function, not through a call inside that text (`tools/oxlint/check-site-keys.mjs`, #1700).

## Kept outside the repository

The desktop corpus's kits and data, and their known problems, are indexed per area in `corpus/<area>.md` (`tooling`,
`copies`, `stops`, `consumers` and `rings`, and `limits` for those of no one area), not imported: run each from its own
folder on the desktop worker. A new kit's entry goes to its area's file.

## The oracle library's next step

`tests/helpers/type-core/enclosing/type-core-enclosing-verdicts.ts` (#1434) keeps its own `MODES`: eight modes, with the consumers' order and the
solver's order varied apart. The library's four modes reverse both together. Its modes are the candidate for the
library's next step. Its stop verdict (`enclosingProblems`) is its own oracle and copies no library projection.
