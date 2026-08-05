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
append-only amendments when existing wording should own the meaning. Preserve authority, conditions,
order, exceptions, executable detail, and resistance to misinterpretation.

## Self-review and assigned review

Before handoff, the implementer reviews the exact final diff. For each assigned review or re-review,
the independent reviewer establishes the exact head, applicable comparison or merge base, scope,
exclusions, criteria, and authority. Examine the complete current diff and enough surrounding code,
tests, documentation, and behavior to find every material consequence. Changed-file lists, green CI,
author claims, and earlier approval are evidence, not proof.

Treat review as a proportional, change-scoped examination. Inspect every material part deeply enough
to support the landing decision without audit-only ceremony or unrelated cleanup. Apply the relevant
lenses below; not every lens applies equally, and preference alone is not a blocker. Escalate
uncertainty that cannot be bounded through a separately assigned [`AUDIT.md`](AUDIT.md).

- **Requirements and paths:** accepted behavior, scope, failures, indirect effects, and real
  supported or trusted paths.
- **Design and maintenance:** ownership, coherent boundaries, ordering, state, persistence,
  compatibility, readability, debuggability, KISS, YAGNI, useful DRY, fragmentation, and dependency
  cost.
- **Tests and evidence:** suitable layers, assertions, oracles, diagnostics, reproducibility,
  negative paths, and proof of the claim rather than a green total.
- **Documentation and context:** correctness, canonical ownership, lifecycle, routing, executable
  details, stale or competing text, consolidation, and safe, token-efficient compactness.
- **Boundaries and cost:** reachable trust boundaries, realistic workloads, unbounded work, hot
  paths, and proportionate security, performance, and resource scrutiny without speculative
  hardening.
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
- [ ] Dependencies, trust boundaries, security, performance, and resources checked proportionately.
- [ ] Diff contains no unrelated changes, residue, secrets, debug code, or stale text.
- [ ] Exact head, comparison base, checks, skips, uncertainty, and PR metadata recorded.
- [ ] Findings classified; blockers resolved; convergence or escalation recorded.
