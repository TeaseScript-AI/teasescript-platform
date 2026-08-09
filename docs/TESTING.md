# Testing strategy

## Authority and purpose

Accepted language and runtime behavior remains defined by accepted specifications and ADRs. This document defines the repository's verification strategy, required test categories, and quality expectations for changes.

Owner-selected release-stage testing outcomes are tracked in [`planning/RELEASE-ROADMAP.md`](planning/RELEASE-ROADMAP.md). Roadmap placement does not schedule implementation or accept unresolved syntax, APIs, host protocols, or architecture.

## Current testing model

The current repository uses:

- TypeScript type checking through `tsc --noEmit`;
- a complete TypeScript build before compiled tests run;
- Node's built-in test runner;
- focused tests during development plus the complete configured suite before merge;
- real source-to-runtime tests where public behavior crosses parser, compiler, instruction-plan, and runtime boundaries;
- deterministic RNG seeds, JSON checkpoint round trips, and runtime resume-equivalence coverage;
- playground HTTP and static-path security tests;
- a small repository-owned deterministic property campaign for runtime and source-pipeline boundaries.

The repository currently has no browser-automation dependency and no external property-testing dependency. New dependencies require a demonstrated need and the normal maintenance and security review.

## Normal and diagnostic verification

`npm run check` is the normal complete configured suite and preserves actionable
failure information. `npm run test:full-output` and `npm run check:full-output`
are diagnostic reruns only when compact output is insufficient for a failure or
specific investigation. Do not run a normal and full-output variant by default
for the same revision. Focused checks remain appropriate when they supply
distinct task-relevant evidence.

CI and tests verify executable code, scripts, configuration, generated artifacts,
and real machine-checkable boundaries. They must not freeze living documentation
prose, headings, routing wording, lifecycle wording, or equivalent Markdown
content as required string assertions. Documentation correctness and ownership
remain implementation, review, and explicitly assigned audit responsibilities.

Use the smallest representative bounded fixture that proves the invariant,
and reserve maximum-size or worst-form fixtures for cases where size or form is
itself under test.

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

## Test layers

The testing strategy uses complementary layers:

```text
lexer/parser/semantic unit tests
source-to-runtime contract tests
runtime invariant and checkpoint tests
external-data validation and corruption tests
deterministic property and bounded source-fuzz tests
player/host integration tests
browser E2E tests
performance benchmarks
```

Focused tests isolate syntax, diagnostics, lowering, validators, and runtime operations. Source-to-runtime tests prove that the public compilation and execution path preserves the accepted behavior. Runtime invariant and corruption tests cover explicit serializable state and restore boundaries. Future integration and browser tests cover concrete player/host surfaces after those surfaces exist.

New author-facing syntax and source-reachable observable behavior require
representative source-to-runtime coverage. Runtime-only primitives without a
source route retain focused public or trusted-boundary coverage until one
exists.

End-to-end testing does not replace focused unit, validator, and invariant tests.

## Regression-test rule

Every confirmed defect fix on a supported product path or real boundary requires
a focused regression test. The test should normally fail on the unmodified
baseline for the reported root cause and pass after the repair. When
failing-before evidence cannot reasonably be supplied, document why and provide
the strongest focused reproduction available.

A focused regression set is sufficient when the defect and its neighboring
supported behavior are understood. When repeated sibling findings or an
enumerable behavior space leave material completeness uncertainty, use the
systematic-coverage guidance below instead of indefinitely accumulating
incident-specific tests.

Do not weaken tests to hide failures. Do not fold unrelated speculative cases into a focused repair pull request. A newly suspected defect should first be reproduced against the relevant public boundary before it is documented or filed as established behavior.

A failing test is evidence, not by itself a new product contract or review
blocker. Classify whether it demonstrates accepted behavior failing through a
supported public or trusted path, corruption of canonical/persisted state, or a
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

Unsupported or out-of-scope combinations do not automatically require
executable cases. For obligations included in the bounded coverage model,
accepted behavior and required rejection through a real supported or trusted
boundary require executable evidence. When a real boundary must reject an
otherwise unsupported composition, classify that cell as a rejected obligation
and test it as such. Other unsupported or out-of-scope cells may remain
classified but unexecuted.

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
tests/property.test.ts
tests/property/
  replay.ts
  source-fuzz.ts
```

`tests/property.test.ts` is a root test entrypoint, so normal compiled-test
discovery executes the required 128-case campaign through `npm run check`.
The replay implementation imports only public exports from `src/index.ts`.

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
ordering is not a compatibility contract. Every failure reports seed, run
count, case number, property ID, boundary, property-specific context, the
generated source when applicable, cause, and a working replay command such as:

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
identity, profiles, or CLI compatibility. Exact technical limits, hostile-data
shapes, interaction variants, and confirmed defects remain in their focused
runtime/checkpoint/corruption/regression suites. Canonical limit classification,
evidence status, and coupling/repair routing live in
[`RESOURCE-LIMITS.md`](RESOURCE-LIMITS.md). A test around a production constant proves only current implementation
behavior unless independent evidence justifies that boundary. Tests for values whose retention is unsupported move or
disappear with the repair; they do not turn the historical number into an acceptance target.
Convert a confirmed product defect to a focused permanent regression; do not
preserve private harness bookkeeping as evidence.

## Source-to-runtime conformance corpus

The current behavior-oriented corpus lives in focused `tests/*.test.ts` files
next to the behavior they cover, with `tests/source-to-runtime-conformance.test.ts`
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
  templates; variables, lexical scope, lists, objects, scalar sets and `for`;
  conditions, `repeat`, `while`, `break` and `continue`; defaults, named calls
  and bounded recursion; speaker output and `say as`; and deterministic random
  built-ins.
- Near-valid templates apply one targeted current diagnostic mutation: a missing
  declaration identifier or template expression, out-of-loop `break`, unknown
  name, duplicate function parameter, or composite set element.

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
runner. Focused parser, compiler, checkpoint, corruption, and source-to-runtime
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
- duplicate delivery returning the same bounded `lastSettlement`;
- active foreground/background lookup before settled, stale, or unknown classification;
- an older active background action remaining valid after a newer action settles;
- stale and unknown IDs;
- wrong action kind or response type;
- event and action IDs not being reused after restore;
- malformed action, settlement, status, time, or deadline state.

Timed actions must use an injected fake clock or equivalent deterministic time source. Tests must never wait for real seconds.

ADR 0016 defines the shared contract; action-specific tests remain required for each later API and UI behavior.

The implemented ADR 0018 interaction slice covers button, text, number, unlabelled choice, identifier-labelled choice,
and numeric-labelled choice through both direct validated plans and real compact source. Tests cover exact parser spans
and recovery, V30 comma-newline continuation and enclosing-delimiter composition for compact `choose`, protected prelude
names, choice domains and duplicates, requesting-speaker capture, prepared UI provenance while preparation state exists,
intrinsic post-cleanup settlement checks, source-order evaluation, sequential blocking expressions, function arguments, root/function checkpoint
resume, typed completion, transcript behavior, downstream guard delegation, and atomic rejection. The single-use handoff
regressions prove that a newer retained settlement cannot remove destination/result mismatch rejection before consumption,
that the handoff disappears immediately after the first successful consume or discard instruction, and that later ordinary
state no longer carries interaction provenance. Non-canonical branches, loops, second actions, unrelated writers, duplicate
producers, and independent targets inside the handoff are rejected locally rather than supported through global
interaction-result liveness. Current interaction-guard cases remain implementation-boundary regressions for the
provisional POC policies and structural separation; they are not source-capacity evidence and must move with later
evidence-based reassessment. Every rejected completion compares
the complete canonical snapshot so RNG state, event/action counters, destinations, ownership, and continuation cannot
change unnoticed. Standard Player/browser UI coverage remains assigned to its later implementation slice.

## Browser E2E gate

Real browser automation becomes required after the cross-origin host shell and player exist. Coverage should then include:

- iframe sandboxing;
- Content Security Policy;
- typed or otherwise strictly validated `postMessage` communication;
- startup, reload, reconnect, and fatal failure;
- checkpoint save and restore;
- Standard UI, extending the same browser matrix to package custom UI once custom views are implemented;
- focus and keyboard behavior;
- fullscreen and navigation;
- hostile or malformed host/player messages.

No browser framework is selected yet. Playwright or another dependency should be chosen only when a concrete browser surface and its maintenance requirements can be evaluated.

## Coverage and performance boundaries

The repository does not use an arbitrary mandatory line-coverage threshold such as 95 percent. Coverage may later help identify untouched branches and error paths, but correctness, determinism, restore equivalence, and boundary validation are more important than maximizing a percentage.

Performance benchmarks are separate from correctness tests. [`planning/RELEASE-ROADMAP.md`](planning/RELEASE-ROADMAP.md) tracks the Beta outcome **Establish a runtime performance baseline and optimization plan**.

Performance workloads should measure long-running runtime-state growth as well as instruction throughput. This includes growth in runtime-managed identities, snapshots, checkpoints, cloning, validation, and serialization costs. Repeated scoped speaker creation is a representative workload, but measurements and reachability/lifetime analysis must precede any reclamation or garbage-collection rule.

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

## Parser recursion safety

Regression coverage verifies valid nesting beyond the removed parser guard and malformed-input diagnostics without
pinning an incidental host-stack failure point. Historical measurements in [`RESOURCE-LIMITS.md`](RESOURCE-LIMITS.md)
are diagnostic evidence, not CI thresholds or capacity.
