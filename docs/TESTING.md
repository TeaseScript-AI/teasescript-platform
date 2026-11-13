# Testing strategy

## Authority and purpose

Accepted language and runtime behavior remains defined by accepted specifications and ADRs. This document defines the repository's verification strategy, required test categories, and quality expectations for changes.

Owner-selected release-stage testing outcomes are tracked in [`planning/RELEASE-ROADMAP.md`](planning/RELEASE-ROADMAP.md). Roadmap placement does not schedule implementation or accept unresolved syntax, APIs, host protocols, or architecture.

## Current testing model

The current repository uses:

- TypeScript type checking through `tsc --noEmit`;
- a TypeScript build that removes the previous compiled test tree before emitting, so removed or renamed source tests
  cannot remain discoverable;
- Node's built-in test runner;
- focused tests during development plus the complete configured suite before merge;
- real source-to-runtime tests where public behavior crosses parser, compiler, instruction-plan, and runtime boundaries;
- deterministic RNG seeds, JSON checkpoint round trips, and runtime resume-equivalence coverage;
- playground HTTP and static-path security tests;
- a dependency-free Chromium DevTools smoke script for implemented playground and Player browser behavior; and
- a small repository-owned deterministic property campaign for runtime and source-pipeline boundaries.

The repository currently has no browser-automation dependency and no external property-testing dependency. New dependencies require a demonstrated need and the normal maintenance and security review.

## Normal and diagnostic verification

`npm run check` runs formatting verification, lint, lint-rule/exception fixtures, Knip, the doc links, and the build
with compiled tests, preserving actionable failure information. `npm run format` applies the formatter policy; `npm run
format:check` verifies it without writing. `npm run lint` applies the [type-evidence policy](LINTING.md); `npm run
test:lint` type-checks and tests the maintained rule implementation; `npm run knip` checks the selected unused-code and
dependency categories. `npm run check:doc-links` runs remark-validate-links, with remark-gfm, in unified-engine within
its own process, on exactly Git's regular Markdown files: it reports every relative link and heading anchor in the
Markdown files that Git tracks or does not ignore that does not resolve. Absolute URLs, this repository's included, are
not checked. Outside that claim, as the plugin does not read them as GitHub does: raw-HTML links, and GitHub's view
forms (`?plain=1`, `?raw=1`, a folder's README anchors, a heading GitHub's sanitizer filters a tag from); the docs have
none of them. A reference definition naming a missing file is reported even when no link uses it. A broken link fails
`check:pretest` wherever it sits, so its fix belongs to whoever moved the file or renamed the heading, also in a file
they did not touch. `npm run check:imports` runs dependency-cruiser: cruising each tsconfig with the compiler's import
elision, it reports no edge a rule forbids, and its graph has no value cycle outside the waiting list. The rules are the
boundaries the architecture documents declare (`src/` imports no `player/`, `playground/` or package it is not admitted;
the framework-independent `player/` no `player/vue/`); cycles through imports the compiler erases are counted, not
refused. Not seen: a `<script src>` block, a `.js` file beside a same-name `.ts` (read as the `.js`), and a `.vue` file
Vue's parser refuses (vue-tsc refuses it in CI). `tools/repository-checks/imports.mjs` lists the boundaries with their
sources, the packages each area may import with their reasons, the generated-component exception, and what no document
declares. `npm run lint:design` and `npm run test:lint:design` check the [Player design
contracts](LINTING.md#player-design-lint) and their positive/negative fixtures; both are included in `npm run check`.
Independent pre-test gates and UI checks/builds run concurrently through `tools/check/run-parallel.mjs`; the pre-test gates
are the npm scripts `tools/check/check-pretest-steps.txt` lists, one per line.
`npm run check` (`tools/check/run-check.mjs`) runs the build and the compiled tests also when a pre-test check failed, and
its last line names what ran, failed and did not run. TypeScript compilation precedes UI work; compiled tests run only
after all builds pass, as many files at once as
`node --test` runs, fewer under the job's memory: as many as fit at 4 GiB plus 576 MiB a file in `SX_MEM_MIB` (the
queue's reservation, in MiB) or the smallest visible cgroup limit, whichever is smaller, so the variable can lower the
figure but never raise it above a cap the runner can see (`tools/test-runner/test-files-at-once.mjs`). A file that reports no test of
its own, as one whose process ends before its tests report, fails the full suite and is named. Each command's output is printed together, including warnings. A failed command stops no
other in its group, and its leftover process group is terminated. On SIGINT and SIGTERM, `run-parallel` stops its own
command groups, escalating after a grace period, and starts no other; `run-check` forwards the signal and waits for its
part, without a deadline. A command `run-parallel` stops this way is labelled `ABORTED`, not `FAIL`. `npm run test:verification` runs every
`tools/**/*.test.mjs` outside `tools/oxlint/`, whose tests `test:lint` runs, by glob: a new tool test needs no entry.
It checks scheduling, diagnostics and process cleanup (POSIX cleanup assertions run on CI; Windows uses `taskkill /t /f`). A tool test that builds a git
repository takes its git environment from `tools/fixture-git.mjs`, so that no host git configuration, ignore or
attributes file, `GIT_*` variable or message language reaches the fixture; the helper's comment names what it keeps.

Use `VERIFY_SERIAL=1 npm run check` for serial diagnosis or constrained machines; it runs the same commands.
CI uses a job-local Node module compilation cache. Standard checks omit UI source maps because no configured check
consumes them; direct `npm run build` and `npm test` runs retain source maps. UI builds write separate `dist`
subdirectories, Vue typechecking emits nothing, and the clean-build regression uses an isolated temporary directory.

`npm run test:full-output` and `npm run check:full-output`
are diagnostic reruns only when compact output is insufficient for a failure or
specific investigation. `npm run check:full-output` runs `npm run check`'s stages with `TEST_FULL_OUTPUT=1`, which
gives every test run in them full output. Do not run a normal and full-output variant by default
for the same revision. Focused checks remain appropriate when they supply
distinct task-relevant evidence. To see what the checkout's compiler and
runtime do with one source or a project, run
`npm run probe -- [--run] [--json] <file.tease | - | folder | file.tease...>`
after `npm run build:typescript`: it prints the diagnostics and, with `--run`, the
messages, runtime failure, or first player interaction (see `tools/probe.mjs`).
A folder is one project of its `.tease` files, as are several files at their paths from the folder that holds them
all; the project runs from its `main.tease`, so a `call` or `goto` to another file can be tried.
A run reads the current time only when `--clock 2026-10-04T18:30:00Z` gives it a UTC
wall clock, and `--zone Europe/Amsterdam` replaces UTC with that IANA time zone.
Its `playerProfile` has person fields, which `playerProfile.petNames` reads and `player.copyFrom(playerProfile)`
copies, only when `--player-profile profile.json` gives a JSON object of them, such as
`{"firstName": "Alex", "petNames": ["puppy"]}`. The probe is a developer aid, not a test.
The suite is every `tests/*.test.ts`, `tests/<folder>/*.test.ts` and `tests/<folder>/<folder>/*.test.ts`, at most two
folders down (none deeper), except under `fixtures/` and `helpers/`, which hold no tests (a closed list, `suiteTestFiles`
in `tools/test-runner/test-shards.mjs`); a file is named by its path under `tests/`, one at the top by its name alone.
`npm run test -- dist/tests/<file>.test.js` runs one compiled test through the same compact filter, which fails before running anything when a passed path matches no file, and ends with each named file's test counts (`ℹ <file>: N passed`, and `; the file failed outside any test` when it threw while loading or its process ended non-zero); a named file that ran no test (a suite alone is none) fails the run, unless the tests were selected (a name or skip pattern, or `--test-only`, as an argument or in `NODE_OPTIONS`), where its line says the selection matched no test in it; the per-file counts, and this check, need Node's default process isolation, and a watch run is not checked per cycle; use `npm run test:full-output -- dist/tests/<file>.test.js` only for diagnosis. A compiled-only run (`node tools/test-output-filter.mjs dist/tests/<file>.test.js` after `npm run build:typescript`) fails every Player test that loads a module when `dist/player-test-modules` was built before a file of the checkout changed, a test file included; `npm run build:player-test-modules` rebuilds it. In the full suite and for named files, a test, or one of its hooks, that waits 5 minutes fails (`TEST_LIMIT_MS`, `tools/test-runner/test-in-flight.mjs`), so an asynchronous hang fails by name (its line can wait until earlier files have reported); synchronous work is not ended. A test or hook that needs longer sets its own `timeout`.
`node tools/check-changed.mjs` runs before a push the checks CI fails on for what changed since the base (`git diff --check`, `merge commits`, format, oxlint, knip, the doc links, the imports, `test:lint` for every change that is not documentation only, and the type checks and tool tests selected by every touched path, deleted ones and both sides of a move included; its header lists them and its exit codes); CI still runs the tests. `--merged` runs them on HEAD merged into the base's current commit, as CI tests after a squash. In a checkout the queue has already merged with its base (`--merged-with`), run `--merged-checkout "$SX_MERGED_HEAD" --base "$SX_MERGED_BASE"` instead (the queue sets both), so that `merge commits` judges the head's merge commits and not the queue's own merge.
`node tools/check-shas.mjs [--repo <path>]... [<file>]` checks that the commit SHAs a report or pull-request body names exist and are on a remote (a remote-tracking ref, or an archived or pull-request head on `origin`; a tree or blob hash only exists), and finds its unfilled placeholders and its closing clauses that name several issues after one keyword; it names and counts, without failing, the paths it reads into the scratch area `/tmp/agent-work/`, a count that claims no completeness (its header lists the rules and what it does not read); it never fetches. `--append` writes its last line into the checked file as that file's last line, replacing its earlier one, so the report sent is that file.
`tools/archive-replaced-heads.mjs` is a `pre-push` hook: before a push deletes or rewrites a ref on the remote, it pushes the old value to `refs/archive/<sha>` there and keeps the same ref in this clone, and refuses the push when it cannot or when the push would delete or rewrite an archive (its header lists the rules and the limit).
CI's "Structure signals (advisory)" step, after `check:pretest` in the job that runs it, prints
`node tools/structure-report.mjs --diff HEAD^1 --moved`: the structure signals the change adds to, against the merge's
first parent, without Git's moved lines. Its `--summary` rows, each file over 1,000 lines or gaining over 300, go to
that job's summary and the end of its log. It never fails; the plan or the review answers each signal.
`node tools/reading-route-size.mjs [--rev REV] [--base REV]` prints the characters of each document the start route sends an implementing agent to read, their total, the conditional documents beside it, and each `.md` path that `AGENTS.md`, `docs/agents/README.md` or `docs/agents/DIRECT-REPOSITORY.md` names and its lists do not classify (its header names where the route is stated); CI's "Reading route size (reported)" step, after the structure step, prints it with a pull request's difference from the base and never fails.
`node tools/test-runner/ci-test-counts.mjs <run id>` prints a GitHub Actions run's node:test totals (tests, pass, fail, skipped) per job and step, read from `gh run view <run id> --log`, and their sum; `--log <file>` reads a saved log.
`node tools/counters.mjs [ROOT] [--json]` counts a checkout's lint disables, `@ts-expect-error` and `@ts-ignore` directives, skipped and todo tests, shrink-only list entries, and structure signals with their excess summed, with the `@ts-` directives and long functions also counted in tests and outside, and the skipped tests without a condition, as a platform guard and on another condition (its header defines each), for comparing them over time.

For a compiler change meant to preserve behaviour, such as a refactor,
`node tools/compiler-differential.mjs --base <dist> --head <dist>` loads two builds (each a `dist/` from
`npm run build:typescript` in its own checkout) in one process, compiles the same generated sources, `.tease` files,
and projects with each, and classifies every case whose diagnostics, plan, with `--run` runs, or, with `--internal`,
what the checks before lowering found, such as the whole type check result, differ; `--time R` compares their compile
times (options in `tools/compiler-differential.mjs`). It is also a developer aid, not a test.

CI and tests verify executable code, scripts, configuration, generated artifacts,
and real machine-checkable boundaries. They must not freeze living documentation
prose, headings, routing wording, lifecycle wording, or equivalent Markdown
content as required string assertions. Documentation correctness and ownership
remain implementation, review, and explicitly assigned audit responsibilities.

The ChatGPT project-settings prompt has an owner-confirmed hard acceptance limit
of 8,000 characters. CI may enforce that quantitative external interface
boundary for `docs/chatgpt-project/SYSTEM-PROMPT.txt`; it must not assert prompt
wording, headings, routing strings, or other prose content.

Workflow and connector tooling has one canonical complete validation command:

```shell
bash tools/local-agent/check-local-agent.sh
```

It runs each local-agent producer, consumer, workflow-contract, and compact-output
suite exactly once. Individual files remain useful for focused development, and
normal CI always uses this canonical command to prevent duplicate execution and
test-list drift.

Verified patch publication uses a trusted change-scope profile instead of always
repeating every suite before the candidate is pushed. Workflow and local-agent
changes, unknown paths, and mixed changes that include either boundary still run
the complete command. Ordinary product source runs the configured repository
build/tests, while strict documentation-only changes retain exact candidate
identity verification without executing Node. The normal pull-request CI starts
again after publication and still runs the complete canonical command on the
published commit.

### The switch's shadow gate

The switch to the constraint backend ([architecture](ARCHITECTURE.md#static-type-analysis)) needs this gate's
verdict `green` on the switching commit's `main`. The gate compiles every source of the 15,406-source set (`corpus`,
its cases file named by `CASES_JSON`), the type-core fixture (`fixture`) and each maintained family (`copies`,
`joins`, `messages`, `property`, `rings`, `stops`) through both public routes of one built tree in the four modes. It
then classifies every legacy/core pair, and every source's core with sharing on against off, with
`tests/families/shadow-classify.mjs` (runner and classes: [`tests/families/README.md`](../tests/families/README.md#shadow)).
Per set, its manifest from a built tree of that commit, then its shards on the central queue:

```shell
node <tree>/tests/families/shadow.mjs <tree> <set> --manifest > expect-<set>.jsonl
sx-job submit --owner <lane tag> --commit <main sha> --shards 16 --mem 6G --timeout 2h --campaign <T>-<set> \
  -- bash -c \
  'node "$SX_TREE/tests/families/shadow.mjs" "$SX_TREE" <set> --shard {i}/{n} --demands 16 --out "$SX_OUT/shadow.jsonl" \
  > "$SX_OUT/shadow.log"'
```

and then over all records:

```shell
node tests/families/shadow-classify.mjs <every shard's shadow.jsonl> --expect expect-corpus.jsonl \
  --expect expect-fixture.jsonl --expect expect-copies.jsonl ... --out <folder> --gate
```

with one `--expect` per set's manifest (the flag takes one file).

For `corpus`, both commands also need `CASES_JSON=<cases.json>` before `node`, and the job `--data <cases.json>`.
Each route's `--memory` holds whatever `NODE_OPTIONS` the queue sets: a route starts without it. `--demands 16` is the
completion control: nothing stops at the natural allowance on current `main`, so only a demand-allowance run reaches
a receiving completion. The gate table also counts, as information only, the control's runs that left the slice by
the class that names their text (`declined/lost check` or an exclusion rule), every such class a row and a text no class
names apart. `--expect` makes a source without a result count as
`unavailable`.

Each class has one of four states:

- `pass`: agreement, or the legacy route's heap exhausted in its analysis while the core finished (legacy behaviour the
  switch resolves);
- `attributed`: for `differs/rule`, `/checks`, `/plan` and `/wording`, a pair takes its binding's group only where key,
  mode, class and guard all match; otherwise it is `changed` (bound but its reading or class differs) or `unbound`, both
  open until re-adjudication. Only a `conforms` group is attributed for those four classes. Sharing-dependent stop
  classes retain their attribution; the switch still owes each source its accepted expectation, a stop through the stop
  oracle's lost-check judgment;
- `accepted (condition 1; condition 2 list)`: from taxonomy v5, `declined/lost check`, a program the core declines
  where a stop lost a check it requires (#1781), at the natural allowance and at the control alike. #1526 decision 2's
  condition 1 accepts it (the legacy compiles); condition 2 re-assesses every such case before the switch;
- `open`: the gate is not green while such a row has a pair. These rows are every exclusion of the candidate slice,
  the surviving-check, integer-use and stop differences, failed runs other than the legacy heap, exceptions, results
  that are missing or rowless; in the sharing column, a difference where neither mode stops, a mode outside the slice
  and an order not compared; and coverage without ordinary decisions or without a completion at the control.

The verdict line is `gate: green` only when no row is `open`. A result the classifier cannot read, a pair that no
class or two classes take, a result outside the manifests, or a source recorded twice with different results fails
the run (`gate: failed`, exit 1). An exclusion text or a changed diagnostic code that no taxonomy version decides needs
a new version with a witness before the gate can pass. `--gate` exits 1 unless the verdict is `green`.

Each adjudicated group names what it covers, its verdict, witness, evidence and, while open, what closes it. A defect
stays open until its issue is resolved and a new adjudication records it; a pending construction stays open until it is
built and re-adjudicated. Bindings must validate every raw publication against the adjudicated run; re-adjudication
replaces the group table and bindings together, with history by version. Claim gate movement only from replays;
projected counts remain ceilings until replay. Before reading the switch verdict, add independent area sources for
accepted calls, camera forms and tag predicates that neither gate sources nor converted units exercise.

A wording difference that drops a fix the legacy route gives, or gives a worse one, is a defect to repair, not an
owner question: the new checker keeps every fix the legacy checker gives, in the form of
[Messages](DIAGNOSTICS.md#messages) (owner decision, 2026-10-27, #1195). The legacy route is the reference until #2201
freezes its messages as the reference for after its removal.

## Checks and corpora by component

Each row defines that component's [evidence levels](DEVELOPMENT-WORKFLOW.md#evidence); each level includes the ones
before it. An empty cell has no corpus yet.

| Component | Level 1: checks | Level 2: before/after comparison | Level 3: extended set |
| --- | --- | --- | --- |
| Compiler | `npm run check`, plus the `tests/families/` areas the change touches, base against head (for the type core, at least the fixture and messages areas) | level 1 plus the families' set (the `tests/families` corpus in its four modes), base against head, classified; the growth bar always applies when the change touches `layersOf`, the walk, admission or the contract; for changes outside the type core, `tools/compiler-differential.mjs` ([Normal and diagnostic verification](#normal-and-diagnostic-verification)) | level 2 plus all areas and the held set with stops, classified; `TEASESCRIPT_SWEEP=full` ([Sampled sweeps](#sampled-sweeps)) for the legacy checker |
| Runtime | `npm run check` | the [conformance corpus](#source-to-runtime-conformance-corpus) run at base and at head, outcomes compared; once the runtime differential harness exists (#1797), its campaign | |
| Backend | none yet: its checks, compatibility documents, and area label come when the backend exists | | |
| Website front end | none yet: its checks and area label come when the front end exists | | |
| Player | `npm run check`; the [scoped visual check](#player-browser-and-visual-verification) after a visible UI change; [`npm run test:player:browser`](#local-browser-smoke-and-future-host-e2e-gate) for a change to `player/` or its fixture packages | `npm run test:player:browser` plus [`npm run test:player:preview`](#player-browser-and-visual-verification) | a real-device check |

The compiler's shadow gate (`tests/families/shadow.mjs`) is a campaign run from the tree after merges and reported on
the tracker issue; it is not a per-pull-request level.

The exact compiler comparison uses `tests/families/plans.mjs` for the whole plan, diagnostics, charge trace and
questions in four modes, counting resumed records in its verdict and refusing one build as both trees. Judge each
compile, each held-stop analysis and search work between analyses separately against the unit limit, using the source's
natural compile allowance even for a test-allowance run; a safety-net timeout means uncharged work, never a unit stall.

When either tree leaves nodes unanswered, compare the common answered prefix by hash: answers and records unless either
side stopped at a binding, every occurrence both answered, and route. A differing prefix is a difference; an agreeing
prefix remains explicitly incomplete. Count equal unanswered counts with equal recorded answered parts as agreement
apart; missing counts or parts cannot establish it. List alike sources separately without rerunning them, require
ordinary plus alike agreement to cover every source for closure, and refuse inconsistent totals, reading older absent
alike totals as zero.

Read rerun judgments in supplied order: the latest replaces an earlier attempt only if either stalled. Two completed
attempts are repeats and are refused by source if their results differ; replay records are never replaced, and counts,
verdicts and the index use only the selected attempt.

Keep a stall's tree, mode and check in its record and saved index, including stored-base-only stalls and crashes between
runs. Count fatal V8 errors and signals as crashes per tree, separately from unit stops; a head-only crash takes
precedence over a difference in the exit status. Give each source process its requested heap regardless of inherited
Node options; report the measured effective limits and any probe failure so an override is visible. Growth summaries
are advisory, excluding and counting runs stopped on either tree; stored-area summaries retain reasons, grants and
over-limit runs, including older records without a reason. Use the stall summary's total as the campaign evidence total.

Keep the base's sampled heap peak when the head aborts; count and name sources with a near-cap run per tree, treating
peaks as advisory, never as stalls, exit criteria or stored baseline identity. Report each built tree's actual
question-grant, work-ledger and publication-hash capabilities, with compiled coverage of the real exports so a rename
cannot silently remove them.

Submit exactly the checked, complete zero-based shard list, refusing missing, repeated, out-of-range or malformed items
and mixed shard counts. Forward only admitted queue options that cannot change or multiply that list, testing every
forwarded option against the received items. A batched area is complete only when its batches cover every source;
explicit source lists refuse empty, malformed, unknown or repeated places and cannot be combined with store, shard or
only selection.

Complete every baseline fill whose jobs have started; supersede only a fill with no started job. A seed names the
compiler build and holds every area's plan and shard table, with no shard; validate imports as external data, including
plan version, area, positive manifest-matching shard count and complete ordered entries. The manifest's recorded shard
count controls filling and comparison, including older counts; refuse a first writer using another count and require
complete coverage when comparing across counts. Adopt a seed or check it equal; accept a shard only against the central
manifest and plan, its expected source membership and a source-bound certificate for every stall. Compare an existing
shard by its lines and refuse differences without replacement; baseline status succeeds only when the seed names its
build and every recorded area is complete.

**Pinned work.** Some suites pin the core's exact work or its published answers: totals, listed copy and construction
sites, work tables, and the published answers' digests. Each file holding such pins says so in its first
line, a mark that `tools/repository-checks/pin-suites.mjs` reads (`// pins: <what> | line /<regex>/`, or
`// pins for <suite>, ...: …` in a helper). A change under `src/type-inference/core/` runs all of them before
it asks for review and before READY: `node tools/repository-checks/pin-suites.mjs --run`. A pin that moves is re-pinned
only with its ground: a comment at the pin, or in its test's header, naming how many units more or fewer and the change
that moved them ("18 units more at demand 64 since #1828: …" above the closure suite's list-join row; "6 fewer since
#1901 …" in the contract-capture test's opening comment). Grounds are the reviewer's to check: for each changed pin line
of the diff, the reviewer finds its ground and checks that the units added are not a question the core already answered
once (a repeated question). A mechanical check of grounds was tried and dropped (#2051): reading a pin's text, it stayed
open to a pin written in a form it did not read. A change to a test helper lists only a suite whose pins it holds, not
every suite that imports it.

## Test admission and consolidation

Give each maintained test family a distinct evidence obligation: accepted behavior, a real public/trusted boundary,
confirmed regression, deterministic invariant, or material browser-only risk. CI time is costly, so every test must add evidence worth its run time: choose the cheapest
layer that proves it; keep representative source-to-runtime integration where isolated tests cannot prove the connection. Browser tests own
rendering, focus, input, scrolling and accessibility semantics, not repeated runtime normalization/checkpoint matrices.

Use the smallest representative fixture; retain large inputs when scale itself caused the defect. Separate expensive
setup from the boundary under test when a small integration case plus direct boundary evidence proves both obligations.
Measure changed suites and record revision, environment, command and timings in the issue/PR rather than imposing local
measurements as permanent limits.

Before removing or consolidating a family, record its obligation and remaining evidence in the issue/PR. Delete checks
that only freeze provisional geometry, development-fixture content, private implementation details, or temporary
incompleteness (for example an accepted or intended capability being absent, unsuggested, disabled, or represented by a
placeholder); preserve genuine regressions and browser risks exercised _through_ fixtures. Replace numeric tuning
assertions with observable behavior where possible. A POC check needs reassessment when its experiment changes or ends,
not automatic repair to preserve an obsolete expectation. Repeated input/viewport cases need distinct failure modes, not
merely different values.

Tests do not establish product policy. Each test must identify the desirable behavior that would regress if it failed;
"the code currently does this" is not enough. Derive expected values from specification or independent reasoning where
possible. A value captured from the current implementation is acceptable only as an explicitly scoped regression oracle
and does not by itself make that value a broader product requirement. For example, a numeric oracle tied to a current
algorithm, such as a plan-size baseline, may detect regression without making that number a project-wide accessibility,
performance, or compatibility requirement; identify that scope explicitly. The baseline may be reviewed and updated when
an intentional implementation change legitimately changes it.

Type-core tests compare analyses through the projections in `tests/helpers/type-core-oracles.ts`: the diagnostics'
identity a stop keeps, what a program publishes in the four modes (both orders, sharing on and off), and which
decisions stop and when. A test that needs another projection adds it there instead of keeping a private copy. The
fixture's narrowing holds are one closed map of named records with reasons and issues: in every mode, independently
verify each name's existence, narrowing cell, own hold reason and continuing disagreement, comparing causes as a
multiset and reporting outcome, site, context and narrowing payload separately. A matching record returns to ordinary
assertions; a matching hold fails completeness.
`tests/families/` holds the generators that reviewers and builders used as evidence, each module the sources of one
recorded evidence run, with their runner and module contract (`tests/families/README.md`). Their runs are outside CI:
before a type-core review round, the builder runs the affected areas against the base and head builds and reports the
counts. CI runs only `npm run test:families`, which checks that every module still reproduces its recorded run.

### Sampled sweeps

CI runs `npm run check` as three jobs side by side, `check-1` to `check-3`, each meant to stay at least 3 minutes under
its 15-minute limit at the slow end of runner variance (#1638, #1978): each builds and runs one third of the compiled
tests (`npm test -- --shard=i/3`), `check-3` also the checks before them (`npm run check:pretest`). Every type-core test
file and every other of 10 s or more is listed, costliest first, with its median seconds over three CI runs or more in
`tools/test-runner/costly-test-files.mjs`, beside the seconds of `check:pretest`: each test job keeps its files' seconds as an
artifact for 7 days, and `node tools/test-runner/measure-test-files.mjs --write --from-ci RUN ...` regenerates the module from them
(`--from-ci --base-branch BRANCH` takes the first three matches among CI's latest hundred passed pull-request runs into BRANCH, which may be of one pull request or one head and may predate BRANCH's tip, while the current checkout supplies the file set; a refusal says how to find runs to give instead; its header names the runs; seconds measured on a worker do not predict CI's). A new type-core test file runs in full
before it has an entry, at the other files' seconds; `check-changed` and the shard test name it, and the coordinator
lands its entry from the merge's CI runs in a light pull request. The full suite starts the listed files
first, and `tools/test-runner/test-shards.mjs` shares the files out so that the jobs end together, `check-3`'s after its checks
before the tests. Their costliest sweeps
that claim something at every member of a list of settled stops or allowances (`testedStops`, the stops before admission
settled in `type-core-stop-unsettled`, `completionAllowances`) visit of each list the first, the last and two evenly between
(`sampled`, `tests/helpers/sweep.ts`), and `type-core-sharing-differential` runs its fixture and matrix programs in the source order
alone; a search for a member where something happens keeps its list. `TEASESCRIPT_SWEEP=full` makes every sampled list
whole and runs those programs in both orders: `TEASESCRIPT_SWEEP=full npm run test:compiled`, after `npm run build`,
is the sweeps' queue evidence, which the builder of a change that can move a stop runs on a worker before a type-core
review round, beside the generator areas above.

### Frozen retained state

In the type-core suites, a test-mode instrument (`tests/helpers/retained-instrument.ts`, installed by its preload
through `tools/test-output-filter.mjs`) checks the state the type core keeps between solver runs where it is stored and
at each run switch, and freezes what an ended run stored (#1072). It counts each refusal it throws, wherever it is
caught, and the preload fails the file at its exit when it threw any. It catches a write that the type core makes by
ordinary code, across runs, in test mode; it does not claim to resist code written to get around it (#1072 R33).

Covered, each closed by construction:

- **What a maker returns:**
  - a record, an arena or an array: a copy of the given top level (`retainedCopy`) that the instrument wraps;
  - a map, set, weak map or weak set: its own writers.
- **The plain data a covered kind reaches.** It is frozen at the switch. V8's `TypeError` at a write to plain data
  frozen at the switch, to what a registration freezes or to a locked owner field is a refusal while it leaves the core
  as the pending error: the `catch` and `finally` rule keeps it from being handled in `src/type-inference/`
  (docs/LINTING.md, "Retained state in type inference"), and the compiler's own catches outside take only native stack
  exhaustion. It is not counted where it is raised, so a later error can replace it (#1072 R68, below). The
  instrument's own refusals are counted where they are raised, and are not affected.
- **An owner's fields:** locked at its first switch and opened by marks. Its private fields are reached through
  `hidden`.
- **A registered program:** what it reaches is frozen, its maps and sets refuse writes, its typed arrays are compared
  at the process's exit, what its walk cannot see into (a weak collection, another built-in, an accessor) is refused,
  and its classes' private collections are reached through `hidden` (`Retained.programPart`).
- **A registered function's own properties:** frozen at registration.
- **A typed array under `TYPED_ENTRIES`:** compared at the process's exit with its bytes when its run ended; a
  difference fails the file.

Not covered, each with its reason:

- module scope (#1072 R57: an item of its own);
- what a closure captures (its registration comment, read at review, R26), and what a function the program reaches
  captures, a bound function's values among them (code the program's indexing made);
- code outside `src/type-inference/`: an owner given to it, its writes and its catches;
- V8's `TypeError` at such a write when a later error replaces it before it leaves the core (#1072 R68):
  - a generator closed by a loop whose body throws, whose `finally` makes the write (the engine drops an error raised
    while it closes a generator);
  - a `finally` whose call throws after the write.

  No generator `finally` in the core writes retained state today: the six are `core/values.ts:329` and `:964`,
  `core/contract/value-kinds.ts:244` and `:374`, `core/contract-descriptors.ts:299` and `core/budget.ts:392`;
- a prototype set by a `"__proto__"` key from data on an owner, a registered function or a function the program
  reaches (#1072 R65): no core file writes a key from data to one. Of the 93 lines this lists in `src/type-inference/`
  at #2417's head, 88 of them writes, none has an owner (`this`, or `pass` in `answers.ts`) or a function as its
  object:

  ```sh
  rg --pcre2 -g '*.ts' -o '(?<![\w.$\]])[\w$.#]+(?:\[[^\]]*\])*\[[^\]]+\]\s*(=|\?\?=|\|\|=|\+=|-=)(?!=)' src/type-inference
  ```

- a typed array written and then restored between two comparisons;
- a private `readonly` field assigned again in its constructor after a run switch inside that constructor (R36);
- a write within one run; production;
- admission and the receiving domain (#1072 1b ii); `narrowing/` (R49, an item of its own);
- an `IDENTITY_CLASSES` class's own state, each listed with its reason;
- the retained API itself, a trusted implementation.

It runs in two regimes:

- **CI** freezes only the files of `tests/helpers/retained-subset.ts`: a greedy cover, by their frozen cost, of every
  retained kind by its site, owner kind and registered function that the type-core files exercise frozen, within no CI
  shard above 10 minutes. That file names what the subset does not exercise. Its work-pinning suites run again
  unfrozen in `tests/type-core-production/`.
- **The whole survey** freezes every type-core file, as one queue pool, outside CI and never scheduled. A pull request
  that changes `src/type-inference/core/**`, its retained makers included, carries in its READY the whole frozen survey
  at its head: the pool's job exits, and the files, refusals and frozen writes that `node tools/retained-survey.mjs`
  counts. From the pull request's checkout, `<SHA>` its head's full SHA:

  ```sh
  find tests/type-core tests/type-core-stop -maxdepth 2 -name '*.test.ts' | sort |
    sed -E 's#^tests/#dist/tests/#; s#\.ts$#.js#' > /tmp/agent-work/<task>/survey-items.txt
  sx-job submit --name 'survey-{i}' --owner <owner> --campaign <tag> --items /tmp/agent-work/<task>/survey-items.txt \
    --target 20m --checkout <SHA> --unmerged "the whole frozen survey of the head" --timeout 2h --mem 8G -- \
    bash -c 'cd "$SX_CHECKOUT" && mapfile -t items < "$SX_ITEMS" && RETAINED_SURVEY="$SX_OUT/survey" node tools/test-output-filter.mjs "${items[@]}" < /dev/null > "$SX_OUT/filter.txt" 2>&1'
  sx-job wait --campaign <tag>
  sx-job gather --campaign <tag> --into ~/work/evidence/<issue>/<SHA>/survey
  node tools/retained-survey.mjs ~/work/evidence/<issue>/<SHA>/survey
  ```

  A job starts outside its checkout, hence the `cd "$SX_CHECKOUT"`. The last line exits 0 when every type-core file was
  surveyed with no refusal and no frozen write; the tests' own outcome is the jobs' exits. `RETAINED_FREEZE=all` freezes
  every file without the survey's notes.

`RETAINED_MEASURE=<folder>`, with `NODE_OPTIONS=--enable-source-maps`, freezes every file too and writes what each
exercises by its source site: the measurement the subset is chosen from.

## Test layers

The testing strategy uses complementary layers:

```text
lexer/parser/semantic unit tests
source-to-runtime contract tests
runtime invariant and checkpoint tests
external-data and runtime-state validation tests
deterministic property and bounded source-fuzz tests
player/host integration tests
browser E2E tests
performance benchmarks
```

Focused tests isolate syntax, diagnostics, lowering, validators, and runtime operations. Source-to-runtime tests prove
that the public compilation and execution path preserves the accepted behavior. Runtime invariant and state-validation
tests cover explicit serializable state and restore boundaries. Future integration and browser tests cover concrete
player/host surfaces after those surfaces exist.

New author-facing syntax and source-reachable observable behavior require
representative source-to-runtime coverage. Runtime-only primitives without a
source route retain focused public or trusted-boundary coverage until one
exists. For the solver's forget handoffs, count only completed source probes as evidence, never as an unreachability
proof; revisit both handoff witnesses when a feature runs a component's first computation inside a decision.

End-to-end testing does not replace focused unit, validator, and invariant tests.

## Player browser and visual verification

Use focused unit tests for deterministic presentation logic and the repository's local Chromium smoke route for changed
browser behavior. While the Player UI is a proof of concept, keep these checks coarse: the Player loads, plays the demo,
its main controls work, and settled text stays readable. Behavior that took repeated fixes keeps focused checks, such
as scrolling that must feel the same over the conversation, beside it, and over its scrollbar, and focus and input. Do
not pin animations, timings, exact colours, or layout; the scoped visual check below covers those by eye. The existing
Chromium DevTools smoke route has no browser-automation package dependency; it plays the repository demo end to end (see
[Local browser smoke](#local-browser-smoke-and-future-host-e2e-gate)). For the development preview, run
`npm run test:player:preview`: it starts this checkout's preview on a port Vite chooses and ends it with the run,
however the run ends. `npm run test:player:preview -- <preview-url>` runs against a running `npm run dev:player`
server of this checkout instead, and refuses one that serves another. Both require `playwright-cli` on `PATH` and an
available Chromium browser. Both run outside `npm run check` and are not a final
cross-browser or production-host E2E suite. Preview groups use fresh browser contexts. A run that does not pass, as
when a group fails, a started preview does not start or ends early, or the browser does not close, keeps its
artifacts and names their folder: a screenshot and Playwright trace of a failing group, the Playwright CLI's output,
and the started preview's log. When `SX_OUT` is set and not empty, as it is in a queue job, the folder is made there,
so the job's results hold it (the queue copies `$SX_OUT` back); otherwise it is in the system's temporary folder, to
delete after diagnosis. A passing run keeps nothing. A run ended before its cleanup, by a signal or by a job's time
limit, leaves the folder as far as it was written and prints no folder line: a group's screenshot and trace are taken
when the group fails, not when the run is ended. The preview's dependency cache is never among the kept artifacts: the
run's cleanup removes it, and a run ended before its cleanup leaves it.
`npm run test:player:firefox-camera` keeps its failure artifacts the same way (`tools/failure-artifacts.mjs`).
`npm test` separately checks that the default Player build does not statically load development preview content, and
`tests/player/player-demo.test.ts` plays the repository demo to its exit through the runtime adapter and media device.

After every visible UI change, the implementer must also open the affected flow with interactive browser tooling
(computer use where available) and inspect the changed state plus its immediate responsive/interaction neighbors. This
is a scoped visual check, not a full UI audit; it catches clipping, overlap, unreadable wrapping, misplaced popovers,
and other failures that source assertions or DOM semantics do not prove. A timing defect's regression test uses
deterministic delays or fakes, not a device. Use a real device only to judge feel, for the Player's level 3 evidence
([Checks and corpora by component](#checks-and-corpora-by-component)), or when the behavior depends on mobile browser
chrome, a software keyboard, safe areas, or input hardware that emulation cannot reproduce.

## Regression-test rule

Every confirmed defect fix on a supported product path or real boundary requires
a focused regression test. The test should normally fail on the unmodified
baseline for the reported root cause and pass after the repair. When
failing-before evidence cannot reasonably be supplied, document why and provide
the strongest focused reproduction available.

A regression test may be declared as a regression case: `regressionCase(name, { pr, atBase }, fn)`
(`tests/helpers/regression-case.ts`) in place of `test(name, fn)`. `pr` is the pull request whose fix it witnesses.
`atBase` matches the first line of the message of the error the case throws without the fix, on the Node that `.nvmrc`
pins (Node's own messages change between versions), cut at its first line break (CR LF, LF, CR, U+2028 or U+2029). The
tool anchors it at both ends, so write the line without `^` and `$`; its flags may be `i`, `u` and `v` only:
- `assert.rejects`: `/Missing expected rejection \(ForeignSessionError\)\./`;
- a table of rows: `assert.deepStrictEqual`'s own first line, `Expected values to be strictly deep-equal:`, is the same
  for every wrong value, so give each row's assertion a message whose first line names the witness, as
  ``assert.deepStrictEqual(actual, row.expected, `#1828 ${row.name}`)`` with `atBase` `/#1828 nested set/`.

On a pull request, CI's `check-1` runs the cases it declares against its base after its build
(`tools/repository-checks/regression-cases.mjs`), and reports how each ends there; the report is evidence for the
review, not a gate, and the step never fails the job. A case is its `regressionCase` call, by its place in the compiled
file, so declare it at a file's top level or in a `describe`, never inside a test or a skipped suite. The report names a
call that did not register, a file whose declarations cannot be listed, and each selected case that passes at the base,
fails for another reason, does not finish, or does not run. A case of another pull request does not run when that one is
merged into the base (a commit subject ending `(#N)` in the base's `git log`), and is reported otherwise. Name what the
fix adds by string (`{ name: "ForeignSessionError" }`), not by import, or the file does not load at the base. The base
is compiled with `tsc` and its Player test bundles are built, so a case may load a Player module
(`tests/helpers/player-modules.ts`). What the report does not establish, which is why it is not enforced: that an id
names the same declaration at the base (the base's compilation can move a call site, and a loop can register its rows in
another order), that every way of calling `regressionCase` is found, and that the selected cases run alone (another
`only` test in the file runs too). A case that loads a module the head adds to the bundles' list
(`player/vue/vite.test-modules.config.ts`) fails at the base with `Cannot find module`, another reason than its
`atBase`; and the base is compiled and bundled with the head's `node_modules`. Interrupted, the tool stops by the
signal; the next run removes what an interrupted run left. Declaring is opt-in; no rule requires it.

A focused regression set is sufficient when the defect and its neighboring
supported behavior are understood. When repeated sibling findings or an
enumerable behavior space leave material completeness uncertainty, use the
systematic-coverage guidance below instead of indefinitely accumulating
incident-specific tests.

Do not weaken tests to hide failures. Do not fold unrelated speculative cases into a focused repair pull request. A newly suspected defect should first be reproduced against the relevant public boundary before it is documented or filed as established behavior.

A failing test is evidence, not by itself a new product contract or review
blocker. Classify whether it demonstrates accepted behavior failing through a
supported public or trusted path, invalid canonical or persisted state, or a
real determinism or security boundary failure. A fixture, generator, replay
record, private helper, or manually fabricated unreachable state that fails
without such a consequence is normally a test-harness issue, optional
hardening, or future work. Test-owned IDs, signatures, layouts, and helper
identity may support reliable replay without becoming public compatibility
promises.

This distinction does not reduce coverage at real boundaries. Reproducible
failures in source-to-runtime behavior, checkpoint/restore equivalence,
structured external-data rejection, atomic mutation, deterministic ordering,
or other accepted invariants remain correctness defects and require the
appropriate focused regression.

When an accepted default intentionally changes behavior used incidentally by a
broad test corpus, classify the shared changed assumption before treating every
failure as an independent product defect. Tests whose purpose is unrelated to
the changed default should, where the real supported setup permits it, configure
a neutral environment rather than rewrite source into a different language form
solely to recover the previous incidental behavior. Retain representative
integration coverage with the real defaults so the neutral fixture cannot hide
errors in the default path.

For smart `say` pacing, for example, control-flow, function, RNG, and equivalence
tests that are not testing pacing may use captured pacing settings that produce
a zero duration while continuing to exercise ordinary `say` source. The pacing
coverage must still include the actual platform defaults, positive-duration
lifecycle, and a representative ordinary multi-`say` integration path. This
pattern is a test-isolation technique, not a source compatibility promise or
permission to hide behavior that the test actually owns.

## Runtime-check evidence rule

A test that claims a type constraint is actually enforced must not only check
that the type derivation is right. It must prove that every necessary runtime
check actually lands in the executable plan and runs before any side effect.
This applies to every compiler step that owes a runtime check, not only to the
new type checker.

Such a test asserts three layers:

1. **The decision.** The compiler's answer for the place: its diagnostics and
   the checks it reports owing, each at its site.
2. **The plan.** The executable plan contains each owed check at the intended
   site, with the intended target and type. A check the compiler reports but
   does not lower is a failing test.
3. **The execution.** The plan runs through the public route with a conforming
   value and with a violating value. The conforming run reaches the next
   observable effect; the violating run stops at the check before that effect,
   with the intended TSR code at the intended site.

Not every test case walks all three layers itself: a focused test of the
solver's internals or of its performance needs no runtime execution, and a
lowering test may stop at the plan. The three layers are required where the
test's claim is that a constraint is enforced; a test that stops at the first
layer does not count as coverage of that claim. A regression test for a defect
in enforcement asserts all three layers. Asserting the presence of one owed
check is a focused lowering assertion about the subject under test, not the
broad instruction-plan snapshot that the conformance-corpus section
discourages.

Derive the obligation inventory from admission's code, recording each obligation-creating site's actual published,
marked-undecided and reasoned-decline exits, and key the fresh pass and finishing read to it. Apply the accepted
record's entry [r4-182](specifications/type-inference-accepted-record/oracles.md#r4-182) to the inventory guard and
entry [r4-165](specifications/type-inference-accepted-record/oracles.md#r4-165) to the question-source guard; the stop
matrix measures present losses and does not replace either guard. Retained boundary kinds survive discharge without
re-derivation from the destination.

Compare stopped diagnostic messages exactly with the unstopped message or its own words rendering from the message
module, keeping every other field exact; never parse author text to infer equivalent wording. The extra rendering is
test-only, absent from author output, plans and checkpoints.

For a combined stop's equivalent marks, compare accepted domains independently as sets of kinds at the same kind,
target and site: only marks owing all and only that slot's checks, with an intersected domain equal to the reference,
satisfy it. A wider domain must fail the oracle.

Count each check's content on both sides, subtracting only copies represented by owning records, one accepted
combined-stop replacement, a marked store's records and, on the stopped side, one copy formed only with the marks. The
remaining counts must match: surplus is extra, deficit is lost, and a record whose own side publishes no corresponding
check is lost on either side; ownership follows content, never object identity.

A standing null-check replacement is limited to the operator operand, for-iterable and repeat-count pairs named by both
checks' words, at the same whole site and boundary, with a domain excluding null and unknown inside the null check's
expected domain. Only the iterable and count pairs require identical target text; the operator pair uses the operand's
own span, without comparing target text. Replace one copy at a time, compare order and count the replacing check as its
own content. Identify decisions by list, place, exact path and occurrence; preserve repeated occurrences, compare
counts, pair in order and report repetitions separately from the verdict.

Apply the accepted record's entry [r4-322](specifications/type-inference-accepted-record/oracles.md#r4-322) with a
written-leaf proof: the stopped kinds must exactly equal the written leaf domain reached from the label root through
every recorded step. Compare every remaining record field exactly, except read-derived fields must equal what the proven
kinds and proof route imply through the consumer's own derivation or be refused. Guard against drift in kind-reading
obligation sites and read-derived fields; keep narrowed operand domains, changed fallback expectations, changed sites or
boundaries and an extra property-presence sentence unpaired. This proof does not relax the shadow gate's wording
comparison.

Attribute a shifted stop threshold to a scheduled baseline-defect issue only when charging is correct and the mechanism
and lost check are identical, listing each moved row beside its baseline twin. A loss introduced by the construction
itself never qualifies.

Key oracle sites by file and offsets through the shared site-key helper, including plan checks, stop records, paste
joins and containment, resolving enclosing functions in the site's own file. The reviewed single-source exceptions are
the derived oracle's site set and the enclosing helper's text search; offsets alone do not identify a project site.

A pasted fix counts as executed only when bounded scripted completions drive its session terminal and the instruction
consuming its evaluated operands runs: the last lowering instruction for the smallest containing statement, or for the
lazy position containing it. Executed setup, even at the same span, is insufficient; an unreached site is a named
incomplete outcome, never success.

Derive typed-default snapshots independently from syntax at each call, copying finite value trees and capturing only
names the statement reads. Join only stores from live falling-through conditional arms, excluding syntax-proven dead
arms and those ending in exit or end; host data opens a join, and stored parts take their binding's written type per
block. Name refusals for loops (stores and outer body reads), dead calls, stored computations, methods, open property
stores, unwalked statements, goto, file calls and unmodelled variable-reading expressions; distinguish indexing from a
property named element. Report disagreements with the plan without changing the independent answer to match it.

## Systematic coverage for bounded behavior spaces

When supported behavior can be described through a finite or otherwise
systematically enumerable set of dimensions, prefer an explicit coverage model
over an accumulating collection of isolated regressions when that model is the
smallest credible way to establish completeness. Derive the model from accepted
behavior and real public or trusted boundaries, not only from defects already
discovered.

Relevant dimensions may include:

- operation or instruction kind;
- accepted, rejected, and unsupported forms;
- state or lifecycle phase;
- ownership or execution context;
- persistence or checkpoint boundary;
- replay classification;
- failure and atomicity behavior;
- combinations whose evaluation rules differ.

The model may be a test matrix, state-transition table, invariant inventory,
bounded property strategy, or bounded model-based strategy. Choose the smallest
form that makes the concrete obligations and omissions visible; do not create a
generic framework or enumerate a Cartesian product whose combinations have no
distinct behavior.

A matrix or equivalent model should:

- name the relevant dimensions and give each included accepted or rejected row,
  transition, or generated class a distinct evidence obligation;
- distinguish accepted, rejected, unsupported, and out-of-scope behavior so
  omissions are intentional;
- make uncovered obligations visible rather than relying on the set of bugs
  found so far;
- describe fixture provenance truthfully, distinguishing directly
  runtime-produced fixtures, compiler-produced canonical fixtures, and
  validator-confirmed or otherwise assembled fixtures;
- avoid claiming stronger runtime provenance than fixture construction proves;
- preserve evidence across checkpoint, replay, failure, and atomicity
  boundaries when those boundaries are relevant;
- permit later consolidation without losing any unique evidence obligation.

The type-core stop matrix crosses consumer positions (destination stores, direct consumers, single- and multi-site
arguments, returns and conditions), value shapes (mixed list, set and dictionary literals, nesting, scalar, list and
object ingress, and copies) and four modes, retaining the review witnesses. Cross every ingress shape with literal,
named written-variable, named inferred-variable and call defaults. At every stop compare diagnostics, the whole plan
and direct and composed questions against unstopped answers, requiring a retained answer or an owning mark wherever a
check is owed. Keep the structural guards, matrix, whole-plan mutants, named-exception recounts and four-mode unstopped
comparison together through later ports.

Unsupported or out-of-scope combinations do not automatically require executable cases. For obligations included in the
bounded coverage model, accepted behavior and required rejection through a real supported or trusted boundary require
executable evidence. When accepted behavior or a real validation boundary requires durable rejection of an otherwise
unsupported composition, classify that cell as a rejected obligation and test it as such. Behavior that is merely not
yet implemented is not a rejected obligation; any test for it follows
[test admission](#test-admission-and-consolidation). Other unsupported or out-of-scope cells may remain classified but
unexecuted.

An additive evidence phase may temporarily retain overlapping regressions while
the behavior space is being mapped. Once an independent check confirms that the
coverage model accounts for the accepted dimensions and real boundaries,
remove duplicate regressions and temporary scaffolding while preserving every
unique obligation. A final independent review should verify both the resulting
coverage model and the consolidated evidence.

For this process, the completeness check is independent when it is performed by
a reviewer or agent that did not construct the coverage model being audited.
The final review must be performed by a reviewer or agent that did not perform
the consolidation it assesses. This does not require a new role framework or a
separate branch.

Do not require this multi-stage process for ordinary small changes, isolated
defects, or a known finite repair list whose coverage is already clear.
Pragmatic YAGNI permits systematic evidence when it is needed to resolve a
demonstrated completeness problem; it does not justify speculative test
infrastructure, unrelated hardening, or a permanent framework without a
concrete need.

## Runtime resume-equivalence invariant

For deterministic runtime scenarios, the required invariant is:

```text
uninterrupted execution
==
execution resumed after JSON checkpoint round trip
```

The current shared test-only runtime-equivalence helper evaluates every completed instruction boundary. It compiles real TeaseScript source, runs an uninterrupted baseline, advances a second execution one instruction at a time, round-trips a self-contained checkpoint through real JSON and the public restore boundary, resumes to completion, and compares the result.

For this same-version resume-equivalence check, complete event and final-snapshot
equality is the required current invariant. It does not make historical
snapshot layouts, test-helper identity, or private harness traces public
compatibility promises. The comparison includes:

- accumulated and resumed events;
- event sequence numbers;
- final runtime snapshot and status;
- serialized RNG state;
- speakers and default/contextual speaker state;
- developer-warning events, ordering, replay behavior, and explicitly serialized warning-deduplication state;
- scopes and bindings;
- loop frames;
- call frames;
- temporaries;
- prepared references;
- halt or structured failure state.

Specialized tests may additionally inspect selected event, call, loop, or prepared-reference boundaries, but they do not replace complete equivalence.

The helper also runs each scenario through a [runtime session](RUNTIME.md#runtime-sessions), uninterrupted and one
boundary at a time, continuing from a restored, forked, or tag-restored session at each boundary, and requires the
snapshot API's events, outcomes, view, and checkpoint bytes, the checked export's JSON from the trusted and tagged
exports, and that JSON from a tagged restore that captures nothing.

The canonical self-contained checkpoint guarantee uses the serialized runtime RNG. A host-provided `RuntimeCapabilities.random` implementation is a compatibility/testing override whose external state is not captured by the runtime snapshot. Tests using that override must explicitly recreate the same deterministic external source and must not present the result as a self-contained checkpoint guarantee.

JSON-safe runtime state at every instruction boundary does not mean production execution must persist after every instruction.

## Implemented Phase 1 deterministic property harness

The repository keeps one small deterministic campaign around the current public
plan, runtime, completion, checkpoint, restore, and external-data boundaries.
It is test-owned, uses Node's built-in runner, and adds no dependency or
production hook. It complements focused regressions and source-to-runtime
tests; it is not a second runtime model or a compatibility contract for its
private runner implementation.

### Layout and discovery

```text
tests/runtime/engine/property.test.ts
tests/property/
  replay.ts
  source-fuzz.ts
```

`tests/runtime/engine/property.test.ts` is a test entrypoint, so normal compiled-test
discovery executes the required 128-case campaign through `npm run check`.
The fixed operation, rejected-completion, checkpoint, and malformed-input
fixtures consume no randomness, so they run once each in that entrypoint and
before the campaign in a full CLI run; the generated cases cover same-seed
determinism and source fuzzing. The replay implementation imports only public
exports from `src/index.ts`.

### Commands and budgets

The required campaign defaults to seed `1364229357` and 128 cases. For a
larger local campaign, use the same implementation with an explicit seed and
run count:

```shell
npm run test:property -- --seed 1591436852 --runs 2000
```

After one successful build, the compiled entrypoint may be run directly. The
global run cap is 100,000 cases; there are no real waits, network calls, or
unbounded generated inputs.

### CLI and replay contract

The command accepts `--seed`, `--runs`, and optional zero-based `--case`.
`--case` replays one generated case from the stated campaign on the same
repository revision and campaign implementation. The small internal property
ordering is not a compatibility contract. A fixed-fixture failure reports its
property ID, boundary, variant, and cause; `--case` skips the fixed fixtures.
Every generated-case failure reports seed, run count, case number, property ID,
boundary, property-specific context, the generated source when applicable,
cause, and a working replay command such as:

```shell
npm run test:property -- --seed 12345 --runs 250 --case 17
```

### Executable properties

The bounded campaign keeps only these durable properties:

```text
accepted plan + valid snapshot + successful public runtime operation
=> result snapshot passes the public validator

invalid or duplicate completion
=> complete canonical state and emitted events remain unchanged

checkpoint -> JSON -> restore
=> complete canonical plan and snapshot equality with those original inputs

restore then continue
=> complete event and final-snapshot equality with uninterrupted execution

malformed external plan/snapshot/checkpoint data
=> structured rejection at the public or trusted boundary

same source + same inputs/time observations + same seed
=> identical result
```

The campaign deliberately does not pin an ordered catalog/count, PRNG vectors,
successful signatures, complete traces, work/mutation accounting, fixture
identity, profiles, or CLI compatibility. Exact technical limits, external-data
edge cases, interaction variants, and confirmed defects remain in their focused
runtime/checkpoint/validation/regression suites. Canonical limit classification,
evidence status, and coupling/repair routing live in
[`RESOURCE-LIMITS.md`](RESOURCE-LIMITS.md). A test around a production constant proves only current implementation
behavior unless independent evidence justifies that boundary. Tests for values whose retention is unsupported move or
disappear with the repair; they do not turn the historical number into an acceptance target.
Convert a confirmed product defect to a focused permanent regression; do not
preserve private harness bookkeeping as evidence.

## Source-to-runtime conformance corpus

The current behavior-oriented corpus lives in focused test files under `tests/`
next to the behavior they cover, with `tests/runtime/language/source-to-runtime-conformance.test.ts`
exercising representative public-package scenarios. New representative cases
start with real `.tease` source, call the root `compileSource(...)` API, and
assert only the relevant observable diagnostic/span, event/order/provenance,
status, selected binding, structured failure, or checkpoint/replay result.

The shared resume-equivalence helper compiles through the same root API and
checks every completed instruction boundary by creating a real JSON checkpoint,
restoring it through the public boundary, and comparing complete events and the
final snapshot with uninterrupted execution. Use it whenever a representative
scenario crosses a resumable instruction boundary. Pending-action suites retain
their focused fake-time and checkpoint cases because completion is a separate
public operation.

Prefer behavior-oriented local tests over a generic case schema, fixture
registry, or broad instruction-plan snapshots. Inspect lowering only in focused
compiler tests where lowering itself is the subject. The bounded coverage model
for a consolidation/review lives in the active pull request rather than as a
second language specification or permanent test catalog.

## Implemented bounded source fuzzing

The same required deterministic campaign includes two classifications through
the package-root `compileSource(...)` boundary: six valid families and six
targeted near-valid families. Each family uses a few bounded seed/case-derived
choices, so larger explicit-seed campaigns explore additional meaningful source
strings. This is not a grammar framework or an arbitrary-token fuzzer.

- Valid source templates cover literals, unary/binary expressions, ranges and
  templates; variables, lexical scope, lists, objects, sets of text and of
  lists, and `for`; conditions, `repeat`, `while`, `break` and `continue`;
  defaults, named calls and bounded recursion; speaker output and `say as`; and
  deterministic random built-ins.
- Near-valid templates apply one targeted current diagnostic mutation: a missing
  declaration identifier or template expression, out-of-loop `break`, unknown
  name, duplicate function parameter, or duplicate dict key.

Every valid case is at most 512 source characters, uses nesting at most three,
collections and loop/recursion counts at most four, and runs with a 200
instruction budget. It compiles without diagnostics, validates its public plan,
runs to a valid halted snapshot, and is independently compiled and executed a
second time with the same seed before comparing the complete observable result.
Near-valid cases compile the same prepared source twice and must return the
same ordered diagnostic codes and spans with no executable plan. There are no
generated waits, real sleeping, network input, filesystem corpus,
process-global generator state, or external service.

The default 128-case campaign reaches every template family and at least two
source strings per family. Larger explicit-seed campaigns use the same bounded
choices to explore more source shapes. Exact replay remains revision-scoped:
the same repository revision, campaign implementation, seed, run count, and
case reproduce the source and outcome; internal ordering and the generated
corpus are not compatibility contracts. A source failure prints its
valid/near-valid classification, family, selected variant or mutation, and
exact bounded source before the replay command.

This is deliberately not a complete grammar, abstract runtime model, reducer,
dependency, browser/Laravel/device fuzzing route, or self-hosted untrusted-PR
runner. Focused parser, compiler, checkpoint, validation, and source-to-runtime
tests remain the evidence for their detailed boundaries.

## Interactive runtime state-machine testing

ADR 0016 defines the shared pending-action runtime contract. Every implemented choice, input, wait, timer, button, media completion, or future typed player action requires deterministic state-machine testing against that contract.

Representative transitions include:

```text
running
-> waiting
-> checkpoint
-> restore
-> time observation or typed response
-> running
-> event
-> halted
```

Shared required cases include:

- normal completion;
- checkpoint and restore while pending;
- JSON round-trip and deterministic resume equivalence;
- persisted `currentSessionTimeMs` surviving restore;
- a lower time observation not decreasing the persisted coordinate;
- atomic session-time update and due-action settlement;
- invalid session-time values;
- cancellation and timeout according to the action kind;
- invalid, duplicate, or late response;
- duplicate delivery returning the same bounded `lastSettlement` for replayable completions;
- timer lifecycle transitions and suspended media-wait settlements preserving the previous replay settlement;
- interrupted foreground completions returning `suspendedAction` without mutation;
- active foreground/background lookup before settled, stale, or unknown classification;
- an older active background action remaining valid after a newer action settles;
- stale and unknown IDs;
- wrong action kind or response type;
- event and action IDs not being reused after restore;
- malformed action, settlement, status, time, or deadline state.

Timed actions must use an injected fake clock or equivalent deterministic time source. Tests must never wait for real seconds.

ADR 0016 defines the shared contract; action-specific tests remain required for each later API and UI behavior.

The implemented ADR 0018 interaction slice covers button, text, number, and choice with options without a written value,
with identifier and numeric values, and list options through both direct validated plans and real compact source. Tests cover exact parser spans
and recovery, V30 comma-newline continuation and enclosing-delimiter composition for `askChoice`, protected prelude
names, choice domains and repeated values, requesting-speaker capture, prepared UI provenance while preparation state exists,
intrinsic post-cleanup settlement checks, source-order evaluation, sequential blocking expressions, function arguments,
root/function checkpoint resume, typed completion, transcript behavior, located diagnostics for compiled interaction
data that plan validation rejects, and atomic rejection. The single-use handoff tests cover one row per accepted handoff
category and prove that the handoff must agree with its settlement on owning and continuation positions, owner,
destination, and result, that a newer retained settlement cannot remove destination/result mismatch rejection before
consumption, that the handoff disappears immediately after the first successful consume or discard instruction, and that
later ordinary state no longer carries interaction provenance. Handoff shapes that would let a validated plan reach a
rejected snapshot (a second blocking action, a missing or different cleanup, a second producer, an independent entry)
are rejected locally rather than supported through global interaction-result liveness. Current interaction-guard cases
remain implementation-boundary regressions for the provisional POC policies and structural separation; they are not
source-capacity evidence and must move with later evidence-based reassessment. Every rejected completion compares
the complete canonical snapshot so RNG state, event/action counters, destinations, ownership, and continuation cannot
change unnoticed. The local playground Player slice adds deterministic controller coverage for active-presentation
inspection, all four interaction completions and rejections, pacing skip, explicit time, and checkpoint reconstruction.

The implemented ADR 0018 `say` pacing slice adds source-to-runtime coverage for contextual skip/pacing syntax, captured
smart-autoplay settings, Unicode code-point and word counting, exact/zero/`instant` pacing, speaker skip defaults,
reading times that hold every later statement, including instant output, interactions, media, timers, and `wait`,
typed/time settlement, timer, cue, and button blocks that interrupt a reading time, deterministic event ordering,
checkpoint/JSON restore equivalence, and negative snapshot/checkpoint validation. Boundary regressions also cover action/event-sequence
exhaustion and terminal transition atomicity. The dependency-free browser smoke script covers primary pointer/touch and
eligible Space input, interactive-input priority, rejection feedback, canonical transcript rendering, checkpoint
control reconstruction, and desktop/button versus narrow/dropdown presentation.

Timer coverage starts with real `.tease` source and exercises elapsed units and cross-unit values, compound assignment,
short/named forms, blocking and asynchronous presentation, handles, pause/resume/stop, current-round adjustment,
repetition, and settled-operation warnings. Deterministic cases cover queued non-nested expiry interrupts, normal resume
versus handler `exit`, suspended input rejection, an interrupted action standing still and resuming with its remaining
time, pacing and result-handoff boundaries, and JSON checkpoint/restore equivalence. Late observation must give the same
output, events, and snapshot as observing every deadline on time, for main-path waits and pacing as well as expiry
blocks.

Permanent button coverage starts with real `.tease` source and exercises clicks during waits and questions, queued,
busy, removed, and early clicks, removal, and file-entry ownership across `call`, `end`, `goto`, and `exit`. The shared
resume-equivalence helper takes an optional simulated Player that clicks permanent buttons whenever execution waits,
so restore is checked at every boundary with buttons shown and blocks running.

Player adapter coverage derives presented timers and observation deadlines from real `.tease` fixtures, catches up
late observations, and restores the same timer state from a checkpoint. Malformed timer, handler, suspended-action, and handle-reference state is rejected
through public validation/restore paths.

Media coverage starts with real `.tease` source and exercises accepted and rejected forms, load/failure transitions,
blocking and asynchronous waits including terminal ones, bounded and indefinite repetition, seeks and endpoint cues,
`elapsed` excluding pauses and stalls, one-late versus many-small progress observations, same-time ordering across
media and timers, cue blocks with self-handles, Stage replacement, playback projections, JSON
checkpoint/restore equivalence with a simulated Player, and rejection of malformed media state.
`tests/player/player-media-device.test.ts` drives the Player's media device against real sessions with deterministic element
stand-ins: single load reports, stalls, range repetition and terminal stop, overlapping instances of one file that each
play out once, also after a late `seeked` notification or a rounding error at the range end, pause/resume/seek
repositioning, refused playback and retry also within the end tolerance, failed video and unavailable sources, restore
reconnection without repeated cues, and element reuse without stale listeners or late `play()` results reaching the
next media. The preview browser checks cover Start activation, the runtime Stage image, refused-audio retry, and
actually played audio.

## Local browser smoke and future host E2E gate

The playground and the Player's repository demo have a reproducible Chromium smoke route, which builds first:

```shell
npm run test:player:browser
```

Run it for a change to `player/` or to the fixture packages it opens (`tests/fixtures/packages/`): it needs a browser,
so it is not part of `npm run check`. After a build, `node tools/player-browser-smoke.mjs` runs the smoke alone.

`PLAYER_SMOKE_ONLY=photoColour,camera` runs only the named scenarios (each scenario function's name without
`Scenario`; the technical playground is `playground`); an unknown name fails and lists the known ones.

It covers the technical playground and, on the built `/player/` route with trusted input, plays `examples/demo/` to its
end without console errors: a typed answer, buttons, presses on a message, not on a control, that skip pacing, Space
that skips pacing or presses a `showButton`, Stage images, audible sounds, and smart follow with Return to latest; it
also starts over plain HTTP on a local-network name.
It opens fixture packages by URL in the Player and the playground, including one that does not compile; checks
script storage, a session kept across a reload with an image the script asked for, saved data exported and imported into
a fresh profile, a session exported from one fresh profile and continued in another, the debug export after a script error, the rewind history's IndexedDB store, readable text once photo
colours and the vignette have settled, a photo shown again from the Player's cache with its colour, the reading position
while messages change and enter, and the camera with Chromium's two fake cameras, also the camera view's mirror and
Switch camera buttons clicked on a phone-sized screen and a camera that stops delivering frames opening again. Firefox
captures camera frames differently: after `npm run build`, `npm run test:player:firefox-camera` drives Firefox's single
fake camera, which offers no switch and also opens again, through `playwright-cli` and a Playwright-managed Firefox, and
skips explicitly when either is missing. Neither route needs a physical or virtual camera device. `CHROMIUM_BIN` is
tried before the `/usr/bin` Chromium paths and then the newest Playwright-managed Chromium; an unusable value falls back
to them. An unavailable Chromium executable is an explicit skip; an available browser must pass the configured smoke
checks.

Production browser E2E coverage becomes required after the cross-origin host shell and player exist. It should then
include:

- iframe sandboxing;
- Content Security Policy;
- typed or otherwise strictly validated `postMessage` communication;
- startup, reload, reconnect, and fatal failure;
- checkpoint save and restore;
- Standard UI, extending the same browser matrix to package custom UI once custom views are implemented;
- focus and keyboard behavior;
- fullscreen and navigation;
- invalid host/player messages.

Select the production host's browser-automation stack when that concrete surface exists, based on the engines,
accessibility checks, isolation boundaries, cost, and stability it must prove. The current dependency-free Chromium
smoke does not predetermine that later tooling decision.

## Coverage and performance boundaries

The repository does not use an arbitrary mandatory line-coverage threshold such as 95 percent. Coverage may later help identify untouched branches and error paths, but correctness, determinism, restore equivalence, and boundary validation are more important than maximizing a percentage.

Performance benchmarks are separate from correctness tests. The runtime benchmark
([`benchmarks/runtime/README.md`](../benchmarks/runtime/README.md)) keeps the two apart in one tool: CI checks its exact
instruction counts and results against a baseline that a PR updates on purpose, and its paired CPU comparison runs on
demand on a queue worker, reported and never a threshold. [`planning/RELEASE-ROADMAP.md`](planning/RELEASE-ROADMAP.md) tracks the Beta outcome **Establish a runtime performance baseline and optimization plan**.

Performance workloads should measure long-running runtime-state growth as well as instruction throughput. This includes growth in runtime-managed identities, snapshots, checkpoints, cloning, validation, and serialization costs. Repeated timer or media creation is a representative workload, but measurements and reachability/lifetime analysis must precede any reclamation or garbage-collection rule.

### Scaling diagnostics

When a change introduces or materially alters a path whose work, memory/allocation, serialized representation, or
native-JavaScript exposure grows with valid `.tease` input or derived engine data, use the smallest bounded scale
probe that resolves a material uncertainty. A `1x`/`2x`/`4x`/`8x` series is often enough to expose repeated work,
representation amplification, allocation jumps, or a native-engine cliff. Vary the dimension actually at risk—such
as source width or nesting, expression/instruction count, calls or arguments, temporaries, collection width, or text
bytes—rather than treating file size alone as the scale model.

Prefer deterministic structural measurements before wall-clock timing: emitted instructions, temporaries/frames,
traversal or validation visits, serialized plan/checkpoint bytes, and observed depth are examples. Use timing and peak
memory/RSS when CPU or memory cost is the actual question. Exercise the relevant public or trusted pipeline when a
native failure is the concern so a helper-specific or host-library failure is not mistaken for engine behavior.

These probes are diagnostic evidence, not capacity contracts. The largest passing fixture, first observed JavaScript
`RangeError` or other native failure, host timing, and peak memory do not become supported TeaseScript maxima. Test an
accepted product or technical limit separately against its authoritative boundary. Do not require scale probes for
every PR or create permanent benchmark infrastructure for a bounded question; use them when changed scalable code or
inspection leaves a credible amplification, memory, representation, or native-failure risk unresolved.

A full-route plan's [growth bar](DEVELOPMENT-WORKFLOW.md#evidence) compares head with base by this method: deterministic
counters for both at doublings of the dimension at risk. The head/base ratio falls, or rises by less than a fraction
the accepted plan states for that pull request, at each doubling rather than cumulatively. That fraction is an
acceptance criterion of that pull request, not a project limit or capacity contract. Read each factor against the
input's own growth: a factor near 4 per doubling of a linearly growing input is quadratic.

A structural repair of the type core has a fixed growth bar, its growth gate, and these rules define what its gate
report must show. Per-doubling growth is no greater than `main`'s at
every measured doubling, total work no greater than `main`'s at each family's largest measured size, and work spent on
checks no greater than `main`'s at every size; any small-size excess is reported with its work-ledger attribution
(#1444, 2026-10-31). This gate applies instead of requiring cost at or below `main` before other measurements (#1547,
2026-11-01).

- **The largest-size exception:** where both versions' work is linear, an excess of at most 10 % passes, attributed
  to the extra representation the repair retains (#1547, 2026-11-01). For landing families whose output grows
  superlinearly, both versions' landing work is instead bounded by a constant multiple of the paths returned, and the
  excess lies within named work outside the reporter that is linear in input size; it need not equal that work, and
  the 10 % is of `main`'s landing work at the largest completed size (#1428 and #1547, 2026-11-04). Per-doubling
  growth and work spent on checks still meet the gate in every mode. A size where both runs stop establishes nothing.
- **A count with a fixed intercept:** the gate's count term is read across the measured doublings. A site whose count
  is exactly linear with a fixed intercept passes when, at each doubling after the smallest, its doubling ratio
  exceeds total charged work's by no more than that intercept accounts for; its excess at the smallest doubling is the
  intercept, not growth. A site that exceeds at the largest doubling fails (the lead's reading, #1466, 2026-10-31).
- **A saving:** a candidate at or below `main` at every measured size passes the growth clause when the saving comes
  from the accepted representation change and does not shrink in absolute terms over the last doubling, whatever its
  shape (#1466, 2026-11-01). The report names this `under main at every size`, with the saving's sequence; for a
  linear saving it reports the common remainder as `main`'s work (#1444, 2026-10-31).
- **A converging slope:** for an excess whose slope per input size rises and converges, make any bounded repair the
  ledger identifies, then extend the measurements by one or two doublings where cost allows. The later two slopes
  within 3 % pass the growth clause, the smaller sizes' deviation from the linear fit being the fixed intercept; the
  largest-size total still needs the exception's conditions. If the slopes still diverge at the extended sizes, the
  cost is repaired before READY (#1466, 2026-11-01).
- **A restored obligation:** where `main` is cheaper because it drops an obligation a correctness repair restores, its
  cost is not the reference for the largest-size total or work spent on checks on that family. The repaired family's
  growth is linear, or of `main`'s order where `main` is superlinear, its work is bounded per read, and the ledger
  attributes the entire excess to the restored obligation; every untouched family stays at or below `main` as a
  control. The report names this reading, and the PR each repaired family with its ratio and attribution (#1491 and
  #1502, 2026-11-01).
- **Work `main` does uncounted:** where the candidate charges inside the analysis work `main` does uncounted after it,
  the candidate's charged total is compared with `main`'s charged total plus its uncounted work for the same
  obligations, and an output-bound term is judged by the candidate's work per output node (#1526, 2026-11-02).
- **A lazily activated index:** a run asked at exactly the activation count, whose walk costs less than the index, may
  pay at most one construction per run per pass above `main` at the largest size. The excess is linear, grows no faster
  than `main`'s, and is entirely construction in the ledger; the report names this reading, and the PR lists each such
  sibling with its excess (#1384, 2026-11-01). Amortised activation, indexing a root only once its walks have paid the
  index's cost, is a separate mechanism to propose if a real source shows this boundary cost matters.

## Reproducibility requirements

Tests and benchmarks should use:

- fixed RNG seeds;
- bounded loops, recursion, depth, generated input, and total work;
- clear scenario names;
- failing source, seed, mutation, and boundary context in assertion output;
- no external network dependency in ordinary unit tests;
- no real-time sleeping;
- clean deterministic CI behavior;
- exact commands and failures reported in pull-request descriptions.

For desktop corpus-kit updates, establish running readers from central-queue declarations rather than process-table
visibility; the evidence covers only that declaration boundary. Protect undeclared readers with atomic
temporary-file-and-rename writes and before/after hashes, claiming only what the records establish. Take declared paths
whole and identify linked kits by real-directory identity and real-path ancestry where links resolve, outside the
hidden-corpus sandbox; state bind-containment and retrospective log-to-attempt join limits.

Desktop corpus-kit readers admit caught bindings only as direct arguments of total guards with one result type, except
explicitly classified enclosing-catch sites; text guards use guarded property reads and nullish fallback. A caught-value
text guard returns a string property as read, otherwise JSON text, otherwise a description of the value. Keep guard
admission closed, and exercise every guard and reader template against the same enumerated thrown values. Snapshots
preserve JSON serialization's exact text whenever it returns a string, without JavaScript recursion on that successful
path; otherwise descend one level with a marker, applying the depth-1,000 cap only to that descent.

## Parser recursion safety

Regression coverage verifies valid nesting beyond the removed parser guard and malformed-input diagnostics without
pinning an incidental host-stack failure point. Historical measurements in [`RESOURCE-LIMITS.md`](RESOURCE-LIMITS.md)
are diagnostic evidence, not CI thresholds or capacity.
