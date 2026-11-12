# Implementation and review guidance

Read this before implementation. Apply the same quality standard to the implementer's final
self-review and every explicitly assigned pull-request review; the independent reviewer must
re-establish the facts rather than trust the author's conclusions.

Use the assigned issue or pull request for task scope and acceptance criteria. Use applicable
`AGENTS.md` files and [`README-FIRST.md`](../../README-FIRST.md) for controlling authority.
Owner-approved assignment criteria bind within their scope; the artifact is not general authority.
Follow
[`DEVELOPMENT-WORKFLOW.md`](../DEVELOPMENT-WORKFLOW.md) for finding classes, blocking evidence,
proportionality, and convergence; [`TESTING.md`](../TESTING.md) for test strategy; and
[`DOCUMENTATION-OWNERSHIP.md`](../DOCUMENTATION-OWNERSHIP.md) for documentation changes.

## Prepare and implement

Before coding, establish the exact result, scope, exclusions, acceptance criteria, authority,
affected code, tests, documentation, supported paths, risks, evidence needs, and unresolved
owner decisions. Inspect enough surrounding implementation, history, and current behavior to
understand the change. Issues, tests, drafts, claims, and earlier reviews are context, not authority
by themselves. Route unresolved owner decisions before depending on them.

Choose the simplest complete solution for the current requirement and real boundaries. Apply KISS
and pragmatic YAGNI. Apply DRY when removing duplication keeps or lowers total complexity, in
particular when every change to one copy would have to be made to the others; a copy kept to check
another, such as an independently derived expected value or an oracle, is not duplication. Less code
or documentation is beneficial when clarity, behavior, evidence, and maintenance remain at least as
strong; prefer clear local repetition over abstraction or indirection that makes the whole result
harder to understand or change.

### Input-driven scaling and native JavaScript resilience

Treat valid `.tease` input scale as an implementation dimension when CPU work, allocation or memory,
serialized representation size, or native JavaScript stack/API use can grow with source width or depth
or with derived AST, plan, snapshot, checkpoint, or runtime data. Identify the material growth dimension
when it is non-trivial; ordinary changes do not require a formal complexity proof or benchmark worksheet.

Inspect proportionately for:

- input-sized scans, copies, searches, filters, or slices nested inside other input-sized work, including
  whole-region work repeated per expression, instruction, call, event, or boundary;
- repeated whole-structure capture, copy, validation, or traversal without a semantic, ownership, or
  isolation need;
- source-to-plan/state amplification, unnecessary temporary/frame growth, and large throwaway
  collections, strings, or copies created only to count, inspect, or immediately discard them;
- setup or invariant work repeated at a lifecycle frequency when once per enclosing operation would
  preserve the same behavior;
- long-lived callbacks, subscriptions, or objects that retain large data beyond its needed lifetime
  (check captured references and release paths);
- caller-specific expensive work in shared helpers that sibling callers do not need; keep it on the requiring
  ownership/lifecycle path; and
- input-controlled recursion, dynamic argument spreading, large materialization/stringification,
  indexing/allocation domains, or other native-JavaScript behavior that can fail otherwise valid content
  before an accepted product or resource boundary requires rejection.

Do not knowingly introduce or retain material accidental amplification or an avoidable native failure
on the changed scalable path when a local, proportionate structural repair exists; address it as part of
the implementation rather than relabeling it as later optimization. Code inspection should catch these
structural red flags. Reuse, caching, indexing, or micro-allocation changes whose benefit is not evident
remain profiling-driven rather than mandatory pre-optimization. In narrowing modules, every function body
charges on entry, except an inline callback handed to the charging iterator, with lint coverage of that discipline.

Do not categorically forbid superlinear algorithms, recursion, copying, or other deliberate trade-offs:
judge realistic workloads, normal-path CPU/memory cost, implementation complexity, and alternatives.
When a material limitation is found but a proportionate repair would require broad redesign or would
impose a material recurring cost, classify it through the normal finding rules and preserve the evidence
in the active issue/PR. If the limitation remains open when that work closes, create or update a concrete
follow-up before closure so it stays discoverable. Record the controlling input shape, observed consequence,
likely or measured benefit, repair scope, and reason for deferral so related findings can support a later
redesign decision. Do not silently ignore the limitation or turn an incidental JavaScript/V8 failure into
TeaseScript product policy.

Treat code, tests, relevant documentation and examples, configuration, workflows, generated
results, and affected integrations or boundaries as one result; it is incomplete while any relevant
part remains false, stale, weak, ambiguous, or needlessly costly. Keep responsibilities,
dependencies, ordering, failures, and boundaries clear. Do not weaken tests, broaden scope silently,
hide a shared-workflow failure behind a local workaround, or add a dependency without the
justification required by `AGENTS.md`.

Documentation is recurring agent input: every retained token consumes context-window capacity and
can displace task-specific evidence. Safe compactness is therefore a quality requirement. Before
adding text, first try correction, consolidation, relocation, routing, or removal. Reject competing
authority and unjustified duplicated moving facts. Prefer targeted correction or consolidation over
append-only amendments when existing wording should carry the meaning. Preserve authority, conditions,
order, exceptions, executable detail, and resistance to misinterpretation.

### One home for each language rule

Each TeaseScript rule (evaluation order, which code runs, protected names, keyword and unit lists,
built-in signatures and value domains, what counts as a known value, type rules, diagnostic texts and
codes, the editor's syntax facts) is defined in one place that every component uses, so the parser, type
checker, lowering, plan, runtime and editor cannot drift apart.

- Before encoding a language rule, find where it is already defined and use that definition. If a second
  component needs it, move it to a shared module instead of copying it. A copy is acceptable only where a
  trust boundary must validate independently (checkpoint and host data); then a test compares the copy
  with the original.
- An analysis that predicts runtime behavior (a warning, a compile check, a flow fact) takes the order
  and the reachable code from the compiled plan or the shared helpers, not from its own model of the
  runtime. Reuse the plan's control flow (`src/plan/control-flow.ts`) and the forward and backward dataflow
  solvers (`src/plan/dataflow.ts`) where they fit; `src/speaker-flow.ts` shows a client.
- Such an analysis is tested against the runtime: for representative variants of every construct it
  covers (branches, loops, short-circuit operators, defaults supplied and left out, the parts of an ask,
  gotos, calls), a reported problem must occur when the script runs, and an accepted script must not fail
  that way.
- Check each rule in one compiler pass: names, scopes, and placement in the name pass, values and types
  in the type checker. One problem gets one code, whichever pass, path, or form of the source finds it.
- A compile-time value check uses the shared known-value fold, so a constant expression counts like the
  literal it equals. The compile-time and runtime checks of one domain use one predicate and one message.
- Type discovery may follow the source order of ADR 0021 §1.6, but a fact that depends on what has run
  before (narrowing, what a call or ask may change, definite assignment) follows evaluation order through
  the shared order helpers (`src/expression-children.ts`).
- Where the lowering has a lazy path and an instruction path for one construct, both use one
  implementation and one message for each runtime rule.
- Every editor completion of implemented syntax compiles where it is offered, and the editor's syntax help
  is built from the parser's tables. Accepted syntax may be offered before it is implemented
  ([completion policy](../CODE-EDITOR.md#accepted-first-standard-library-poc-tooling)).
- When a second fix for the same kind of case is needed in one area, look for the shared cause before
  patching again (see Convergence).

### Rules over an open set

Which forms a rule must support is decided by the repository's documents (the language reference, the accepted record, a
tool's contract page), not by which forms a builder has seen reached: a form they name is supported. A narrower claim
takes one of three shapes: a declared bounded difference with its measured term and bound; a record held under a named
issue; a refusal by name of forms outside the documents. A form silently handled for fewer cases is not a narrower
claim, and a claim that would drop a documented form is not the builder's to make ([Who decides what](../../AGENTS.md)).
A charging-lint claim names its checked and unseen execution forms and trusted caller/property boundaries; expanding it
into a TypeScript effect checker remains an owner decision.
For the forms that stay supported, a rule that ranges over an open set, such as every option, every caller, every code
form or every value that reaches a boundary, is built so that its completeness follows from the construction, before the
first review:

- One function in one place decides the rule, and every caller uses it.
- Anything that function has not proved gets a conservative default: an unknown kind fails or is treated as unsafe. It
  is never silently skipped or passed. The default under-offers and never over-offers: it may refuse what the rule
  could admit until a row admits it, and it never admits what the function has not proved.
- The rule is written as the closed set of forms it admits, never as a list of forms it rejects: a reject-list fails
  open on every form it did not name, and each unnamed form becomes a sibling. For ordinary edits of the objects-query
  module, the charging lint uses closed enumerations for whole-type mutually assignable widening (with reviewed trivial
  exceptions), sorted candidates and uses, local callable export declarations, mixed-element checks on every walked or
  written collection, and value-position `any`/`unknown` checks. Runtime provenance through carriers remains a reviewed
  residual, which the lint does not prove; support the charging invariant with mutants, the family growth bar and area
  comparisons including work.
- A generated test family covers the rule's axes (for example sites × forms × kinds, in both orders), with a check
  that every combination is covered.

A sibling a reviewer finds later is then a missing row in that family, or a case the default already refuses, not a
new mechanism. Before each new review round, rerun the earlier rounds' reproductions and generators on the new head,
and say so in the round's request.

### Code that does not mislead

Names, types, comments and documentation say what the code does. A large share of builders' and reviewers' wrong
turns came from the code itself:

- a helper whose name or type promised handling it did not do, so its callers stopped doing it;
- a check that covered less than its name said, such as a guard that checked only on entry, a wait that covered one of
  two queues, or a fake that counted one of three write methods;
- documentation that still described an earlier design, architecture or language version;
- a comment that forecast later work ("until #N", "which replaces this"), and was wrong as soon as that work merged or
  changed;
- two mechanisms for one job, or state with no single obvious owner;
- a tool flag or default that silently overrides what the caller set;
- names that differ by a letter, such as a file and its plural.

A comment says what the code does now, so it stays true whatever merges later. It never forecasts later work: no
"until #N" or "until" a package or stage, no "once #N", no "will be replaced" or "replaces this", and no TODO in any
form. A known temporary state is stated as a fact, and its plan lives in its issue. A reference to an accepted record
in the repository (an issue, a merged pull request, an ADR, a section of a repository document) is a citation and is
allowed; what it says about the code must still be true now. A reference to a document outside the repository is no
citation, because a reviewer cannot read it.

When something misleads you, or would mislead the next builder:

- Fix it at its source: rename it, make the misuse a type or runtime error, correct the comment or document, or fold
  the two mechanisms into one. Fixing only your own call site is not enough.
- Fix it in the current pull request when it is small and in code the change touches. Otherwise file an issue that
  names the misleading thing, what it suggests, what it does, and where it led someone wrong. When the fix crosses
  files another open pull request changes, file the issue and say so in READY rather than widening this one.
- Report it as [friction](#report-what-cost-a-wrong-turn), class `misleading code`.

### Code structure

The code's architecture is right by construction, not repaired after someone notices. It covers:

- **Ownership:** each piece of state or behavior has one owning module, and a module's folder names its owner.
- **Direction:** dependencies run one way, without cycles. `npm run check:imports` checks the declared import
  boundaries and the cycles in dependency-cruiser's graph; its header defines the scope and the exceptions.
- **Granularity:** one job per file. A file that gains a second job is split at that seam.
- **Folders:** grouped by feature or owner, typically 5 to 20 files, never a folder per file. A new file never lands at
  the top level of a component that already has a folder for its concern; creating a missing folder is part of the
  plan.
- **Surfaces:** what a module exports is a deliberate, small interface.
- **Names:** a file or folder name says what it owns, and no two names differ by a letter.

The plan names where new code goes: its module and its folder. A change that brings a new responsibility gets its
own module, or folder, from the start.

These signals each ask, in the plan, for the seam or for the reason there is none; the review checks that the plan
answered them, for the files the change touches as well as for the code it adds. They are not limits:

- a file over 1,000 lines;
- a pull request growing one file by over 300 lines (its added lines less its removed ones);
- a function over 150 lines;
- a folder over 20 files, or a component's top level over 12 (the components are `src/`, `player/`, `tests/`, `tools/`
  and `playground/`, and no other folder counts as a top level).

`node tools/structure-report.mjs` lists them, with `--diff <base>` for the signals a committed change adds to, crossing a
line or adding to one already over, and a file's only when the change grows it; CI prints that list on every pull
request (`docs/TESTING.md`).

Moving or splitting files is its own pull request on the light route. It changes no behavior, and its build output
is byte-identical where the build allows it. `node tools/pure-move-check.mjs <base>` checks that every line it adds or
removes is moved, one of the forms that file names, or declared with a reason; `node tools/move-sweep.mjs <base>` finds
the lines that still name a moved file by its old path; `structure-report.mjs --diff <base> --moved` reads its signals
without the moved lines. `node tools/reconstruct-move.mjs BASE OLD NEW…` checks a split's whole-line reconstruction,
with admitted differences and limits defined in its header; `node tools/moves/split-write.mjs ASSIGN` writes a split
the builder has decided, from an assignment file kept with the move's evidence. The coordinator schedules it between
packages, so that no open pull request's hunks collide. A feature pull request never moves files another open pull
request changes.

Report a structure concern as [friction](#report-what-cost-a-wrong-turn), class `structure`. Each pull request can be
reasonable while the whole drifts, so the coordinator also checks the whole
([`ORCHESTRATION.md`](../ORCHESTRATION.md#structure-and-friction)).

### Report what cost a wrong turn

Some problems have no owner until they cost someone a wrong turn: misleading code, a tool whose default overrides its
caller, a run that could not change the result, a status nobody sourced. Everyone who works on the repository reports
them: builders, reviewers, researchers and coordinators.

- **What:** anything that cost you a wrong turn, a wasted run or a question nobody owned, or would cost the next agent
  one. That includes a tax that never felt like a wrong turn: anything you worked around, did by hand because a tool
  did not, or repeated in more than one change.
- **How:** one line in your next regular message (the plan, READY, a question, a review round or a report): its class
  from [`FRICTION.md`](../FRICTION.md), what happened, and what you did: fixed here, the issue you filed, or the rule
  you propose. A line that fits no class is tagged `other` with a proposed class name. READY and every review report
  carry the line "Worked around or repeated by hand:", with "none" when there was nothing.
- **At once** instead, in its own message, for a line that blocks you or keeps wasting compute.
- **Before working around a missing tool or resource,** check the environment's documentation for it. If it is still
  missing, report it at once instead of building the workaround silently.

Fix what you can at its source, and report it even when fixed: the counts show where the next fix pays.

A step you repeat by hand becomes a script, shared with everyone who would repeat it.

- **A repository tool:** in `tools/`, with a header that states its contract; a new repository tool comes with tests.
  A script becomes one from the moment a rule, a brief template or a READY requirement names its output. It is
  promoted before that rule takes effect, so no rule depends on an unowned helper.
- **Until then, a shared helper** in the coordinators' repository. It carries a one-line header (purpose, side, date,
  inputs), so that a friction line can name it. Its friction is fixed only when fixing costs less than the friction. A
  brief that relies on a helper names its path. A blind brief gets a copy outside the coordinators' repository.
- **Tools of the agent environment** belong to that environment's documentation.

## Self-review and assigned review

Before handoff, the implementer reviews the exact final diff. For each assigned review or re-review,
the independent reviewer establishes the exact head, applicable comparison or merge base, scope,
exclusions, criteria, and authority. An assigned review is read-only by default: post only the review,
findings, and necessary review comments. Do not push fixes, resolve another reviewer's thread, change
pull-request state, merge, or modify the implementation branch unless a separate repair assignment is
accepted and the handoff is visible. Examine the complete current diff and enough surrounding code,
tests, documentation, and behavior to find every material consequence. For removed or replaced
behavior, identify the obligation it served and where the new result preserves it, or why the change
is authorized; apply test admission to removed coverage. Changed-file lists, green CI, author claims,
and earlier approval are evidence, not proof.

Treat review as a proportional, change-scoped examination. Inspect every material part deeply enough
to support the landing decision without audit-only ceremony or unrelated cleanup. Apply the relevant
lenses below; not every lens applies equally, and preference alone is not a blocker. On changed scalable
paths, independently apply the input-driven scaling and native-JavaScript lens above; small fixtures and
green CI do not by themselves prove that valid large or complex input avoids accidental amplification or
native failure. On changes that encode a language rule or predict runtime behavior, apply the one-home
lens above. On everything the change adds or touches, apply the [clarity lens](#code-that-does-not-mislead): a
name, type, comment or document that promises a guarantee the code does not give, or hides one it needs, is a
finding even when today's callers are correct. It blocks only when a caller is wrong today; otherwise it is fixed in
the pull request when small, or filed. Apply the [structure lens](#code-structure) the same way: new code in the
module and folder its owner names, and each signal it raises answered. Escalate uncertainty that cannot be bounded through a separately assigned
[`AUDIT.md`](AUDIT.md).

- **Requirements and paths:** accepted behavior, scope, failures, indirect effects, and real
  supported or trusted paths.
- **Design and maintenance:** ownership, coherent boundaries, ordering, state, persistence,
  compatibility, readability, debuggability, KISS, YAGNI, useful DRY, fragmentation, and dependency
  cost.
- **Tests and evidence:** suitable layers, assertions, independently derived or explicitly scoped regression oracles,
  diagnostics, reproducibility, negative paths, whether each new or materially changed test protects a real obligation
  rather than temporary implementation state, whether a cheaper form would prove the same, and proof of the claim
  rather than a green total.
- **Documentation and context:** correctness, canonical-source placement, lifecycle, routing, executable
  details, stale or competing text, consolidation, and safe, token-efficient compactness.
- **Boundaries and cost:** reachable trust boundaries, realistic workloads, input-driven scaling,
  native-JavaScript failure modes, unbounded work, hot paths, and proportionate security, performance,
  and resource scrutiny without speculative hardening or premature micro-optimization.
- **Diff hygiene:** accidental scope, generated residue, debug artifacts, secrets, stale text, and
  undocumented public or compatibility commitments.

Run the applicable configured verification required by `AGENTS.md` and
[`TESTING.md`](../TESTING.md), including `git diff --check`. Use focused temporary negative probes
when test infrastructure is a substantial part of the change or material doubt remains about
whether relied-on checks detect representative defects for the intended reason; a full-route plan
also has one for each clause of its construction ([mutants](../DEVELOPMENT-WORKFLOW.md#evidence)).
Probe only in disposable local or isolated test state. Never commit or push probes or expose them to
operational state; a probe's patch may be kept in the route's evidence directory
([Evidence](../DEVELOPMENT-WORKFLOW.md#evidence)). Restore every temporary change and rerun affected
clean checks.

## Findings and outcome

Use the existing finding classes and blocking-evidence rules. Each finding gives the governing
requirement, supported path, real boundary, or class-appropriate rationale; evidence where
applicable; practical impact; and the smallest complete repair or follow-up. For reuse or
simplification, check nearby and shared code, then name the existing helper or simpler equivalent
and the concrete cost removed.
The review comment records the exact head SHA, comparison base, scope, blockers and non-blocking
findings, from the second round on whether each earlier finding is closed, checks and outcomes,
including failures, warnings, skips, unavailable checks, remaining uncertainty, and whether the
change can land. Landing requires no blocker and sufficient evidence for the complete result.
Its first line is `Review round <n> (<reviewer>, <head>): <outcome>`, so rounds can be counted per pull request:
`<n>` counts this pull request's review rounds from 1, scoped and final checks included; `<reviewer>` names the model
or role, with `final` for a final review (`Sol final`); `<head>` is the short SHA it judged; and `<outcome>` is
`approve`, `request changes`, `cannot land`, or `closed` for a check bounded to earlier findings that finds them all
closed. A coordinator's own check and a builder's repair note are not rounds and do not use this line.

### Convergence

When sibling findings and isolated repairs stop reducing uncertainty, report non-convergence and the
common invariant or coverage gap. The implementer adopts, or the reviewer recommends or requires,
the smallest systematic repair or evidence method that can establish completeness. Material scope,
redesign, issue split, or execution-strategy changes require the applicable owner or coordinator
decision ([Review convergence](../DEVELOPMENT-WORKFLOW.md#review-convergence)); unbounded uncertainty
may require a separately assigned audit. No fixed review count applies, and repeated one-off patches
do not prove convergence.

## Compact working checklist

Non-authoritative memory aid; mark `N/A` only after considering the item.

- [ ] Scope, authority, criteria, risks, and affected paths established.
- [ ] Simplest complete solution; DRY keeps or lowers total complexity.
- [ ] Code, tests, documentation, workflows, and integrations form one result.
- [ ] Language rules reused from their one home; analyses that predict runtime behavior derive it from
  the plan or shared helpers and are tested against the runtime.
- [ ] Nothing the change adds or touches misleads; friction met on the way is fixed or filed, and reported with its
  class.
- [ ] New code sits in the module and folder its owner names; each structure signal is answered.
- [ ] Supported behavior and failures proved through real paths.
- [ ] Tests and oracles are sound and worth their run time; negative probes used when warranted.
- [ ] Documentation is canonical, current, consolidated, and token-efficient without semantic loss.
- [ ] Dependencies, trust boundaries, input-driven scaling/native-JavaScript failures, security, performance,
  and resources checked proportionately.
- [ ] Diff contains no unrelated changes, residue, secrets, debug code, or stale text.
- [ ] Exact head, comparison base, checks, skips, uncertainty, and PR metadata recorded.
- [ ] Findings classified; blockers resolved; convergence or escalation recorded.
