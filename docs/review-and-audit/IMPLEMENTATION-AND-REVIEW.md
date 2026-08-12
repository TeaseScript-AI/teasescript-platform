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
and pragmatic YAGNI. Apply DRY when removing duplication keeps or lowers total complexity. Less code
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
- caller-specific expensive work in shared helpers that sibling callers do not need; and
- input-controlled recursion, dynamic argument spreading, large materialization/stringification,
  indexing/allocation domains, or other native-JavaScript behavior that can fail otherwise valid content
  before an accepted product or resource boundary requires rejection.

Do not knowingly introduce or retain material accidental amplification or an avoidable native failure
on the changed scalable path when a local, proportionate structural repair exists; address it as part of
the implementation rather than relabeling it as later optimization. Code inspection should catch these
structural red flags. Reuse, caching, indexing, or micro-allocation changes whose benefit is not evident
remain profiling-driven rather than mandatory pre-optimization.

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

## Self-review and assigned review

Before handoff, the implementer reviews the exact final diff. For each assigned review or re-review,
the independent reviewer establishes the exact head, applicable comparison or merge base, scope,
exclusions, criteria, and authority. An assigned review is read-only by default: post only the review,
findings, and necessary review comments. Do not push fixes, resolve another reviewer's thread, change
pull-request state, merge, or modify the implementation branch unless a separate repair assignment is
accepted and the handoff is visible. Examine the complete current diff and enough surrounding code,
tests, documentation, and behavior to find every material consequence. Changed-file lists, green CI,
author claims, and earlier approval are evidence, not proof.

Treat review as a proportional, change-scoped examination. Inspect every material part deeply enough
to support the landing decision without audit-only ceremony or unrelated cleanup. Apply the relevant
lenses below; not every lens applies equally, and preference alone is not a blocker. On changed scalable
paths, independently apply the input-driven scaling and native-JavaScript lens above; small fixtures and
green CI do not by themselves prove that valid large or complex input avoids accidental amplification or
native failure. Escalate uncertainty that cannot be bounded through a separately assigned
[`AUDIT.md`](AUDIT.md).

- **Requirements and paths:** accepted behavior, scope, failures, indirect effects, and real
  supported or trusted paths.
- **Design and maintenance:** ownership, coherent boundaries, ordering, state, persistence,
  compatibility, readability, debuggability, KISS, YAGNI, useful DRY, fragmentation, and dependency
  cost.
- **Tests and evidence:** suitable layers, assertions, oracles, diagnostics, reproducibility,
  negative paths, and proof of the claim rather than a green total.
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
whether relied-on checks detect representative defects for the intended reason. Probe only in
disposable local or isolated test state. Never commit, push, or expose probes to shared or
operational state. Restore every temporary change and rerun affected clean checks.

## Findings and outcome

Use the existing finding classes and blocking-evidence rules. Each finding gives the governing
requirement, supported path, real boundary, or class-appropriate rationale; evidence where
applicable; practical impact; and the smallest complete repair or follow-up.
The review comment records the exact head, comparison base, scope, blockers and non-blocking
findings, checks and outcomes, including failures, warnings, skips, unavailable checks, remaining
uncertainty, and whether the change can land. Landing requires no blocker and sufficient evidence
for the complete result.

### Convergence

When sibling findings and isolated repairs stop reducing uncertainty, report non-convergence and the
common invariant or coverage gap. The implementer adopts, or the reviewer recommends or requires,
the smallest systematic repair or evidence method that can establish completeness. Material scope,
redesign, issue split, or execution-strategy changes require the applicable owner or coordinator
decision; unbounded uncertainty may require a separately assigned audit. No fixed count applies, and
repeated one-off patches do not prove convergence.

## Compact working checklist

Non-authoritative memory aid; mark `N/A` only after considering the item.

- [ ] Scope, authority, criteria, risks, and affected paths established.
- [ ] Simplest complete solution; DRY keeps or lowers total complexity.
- [ ] Code, tests, documentation, workflows, and integrations form one result.
- [ ] Supported behavior and failures proved through real paths.
- [ ] Tests and oracles are sound; negative probes used when warranted.
- [ ] Documentation is canonical, current, consolidated, and token-efficient without semantic loss.
- [ ] Dependencies, trust boundaries, input-driven scaling/native-JavaScript failures, security, performance,
  and resources checked proportionately.
- [ ] Diff contains no unrelated changes, residue, secrets, debug code, or stale text.
- [ ] Exact head, comparison base, checks, skips, uncertainty, and PR metadata recorded.
- [ ] Findings classified; blockers resolved; convergence or escalation recorded.
