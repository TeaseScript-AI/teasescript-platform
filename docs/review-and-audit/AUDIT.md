# Audit guidance

An audit provides the strongest practical assurance possible—never an absolute guarantee—that an
exact declared state and scope satisfy all applicable accepted requirements, owner decisions,
acceptance criteria, and canonical project rules. It must expose material defects, unjustified
complexity, weak evidence, and realistic ways the result can fail or be misinterpreted.

Derive checks from the actual authority and audited subject. Use the hierarchy in
[`README-FIRST.md`](../../README-FIRST.md), the finding and blocking-evidence rules in
[`DEVELOPMENT-WORKFLOW.md`](../DEVELOPMENT-WORKFLOW.md), the applicable strategy in
[`TESTING.md`](../TESTING.md), and the rules in
[`DOCUMENTATION-OWNERSHIP.md`](../DOCUMENTATION-OWNERSHIP.md). Do not substitute a generic
checklist, invent requirements, or manufacture hypothetical defects merely to appear thorough.

## Prepare the audit

Before executing an audit, create a temporary, task-specific audit plan. Present it to the owner or coordinator for
approval when the assignment has not already authorized the audit and its declared scope. Do not add a second approval
round-trip merely to restate an explicitly authorized audit. If the audit would expand its declared scope or take
actions outside previously authorized boundaries, obtain approval before that expansion. An audit may assess a final
candidate or diagnose an unfinished or troubled state; identify the exact state and limit every conclusion to it.

Record:

- the exact audit question, snapshot or state, scope, authority, obligations, and exclusions;
- the code, tests, documentation, workflows, configuration, integrations, generated results, and
  boundaries that may be relevant;
- conceivable audit angles, risks, edge cases, failure modes, indirect effects, and likely
  misinterpretations;
- the concrete investigations, probes, and evidence needed;
- how each applicable minimum focus below will be investigated and evidenced, or the inspected
  reason it is immaterial; and
- provisional moving facts that must be refreshed before they support a verdict.

Study the relevant implementation, history, earlier reviews, and current state. Treat earlier
conclusions, author claims, green test totals, and previous approval as leads to challenge, not
proof. When the author is explicitly assigned to audit their own change, the audit still
re-establishes scope, authority, likely misreadings, and evidence from the final candidate; the
author's prior self-review and design intent are not proof and do not reduce the required depth.
A self-audit does not replace independent review or approval when the surrounding workflow requires one.

Update the plan as checks, results, and uncertainty emerge; it guides but never limits
investigation. Add every subject-specific angle and evidence need required by the scope.

Consider every potentially material angle, close it only after enough inspection, and stop once
inspection establishes no material connection to the current subject.

Refresh the audited identity and all material moving facts before issuing the verdict. If the
audited state changes during execution, determine the impact, update the identity, and repeat
every affected investigation and evidence check.

## Scope and depth

Scope determines what is audited, not how deeply each relevant part is examined. A narrow
component audit and a broad integration audit must both be exhaustive within their declared
scope.

A normal feature, implementation, or code audit treats the complete delivered result as one
subject: production implementation, tests that claim to prove it, all relevant documentation,
examples and status text, and affected configuration, workflows, integrations, generated
results, and real public or trusted boundaries. The result cannot Pass while a relevant
supporting part is defective, weak, false, ambiguous, or unjustifiably costly to understand or
maintain.

A narrower audit question may bound the scope when that limitation is explicit, but an informal
request to “audit the code” does not exclude relevant supporting elements.

Identify every potentially relevant implementation element, dependency, test, document, workflow,
configuration, interface, generated result, and indirect interaction. Inspect each far enough to
establish relevance; investigate every relevant element thoroughly, and close it as immaterial
only for a defensible reason supported by inspection.

Repeated or structurally equivalent elements may be assessed as a group only after establishing
that the evidence represents the complete group and that no material variation is hidden by the
grouping. Do not infer relevance or audit depth from the changed-file list, initial scope
assumptions, an earlier review, or the author's claims.

## What the audit must establish

### Requirements and correctness

Account for every applicable obligation from its authoritative source and connect it to
inspected evidence and a result. Keep exclusions, blocked evidence, uncertainty, and unverified
work explicit.

Verify accepted behavior through its real supported or trusted paths, including relevant normal,
boundary, edge, failure, ordering, state, persistence, compatibility, and integration behavior.
Trace indirect consequences beyond the immediate diff when they can change the scoped result.
Passing aggregate tests does not prove an unexamined requirement.

### Simplicity and justification

Apply KISS to the complete result. Every retained layer of complexity—file, function,
abstraction, dependency, compatibility layer, schema, helper, check, workflow step, or
documentation section—must be justified by a current requirement, real boundary, or demonstrated
maintenance need.

Apply pragmatic YAGNI to hypothetical future consumers. Use DRY where it reduces total
complexity, but keep clear local repetition where abstraction would conflict with KISS. Check
whether simplification moved complexity, risk, context cost, or maintenance burden elsewhere,
and what can be removed, combined, clarified, or simplified without weakening accepted behavior
or real protection.

### Clarity, maintainability, and documentation

Code, tests, workflows, and documentation must clearly communicate responsibility, ownership,
intended use, conditions, order, and failure behavior. Test plausible interpretations a future
agent or maintainer could reasonably make, not only the author's intended reading. Dense,
fragmented, or misleading structures are findings when they materially hinder understanding,
debugging, or safe modification.

During preparation, identify the complete documentation set that describes, routes, constrains,
exemplifies, records the status of, or is changed by the audited subject. Audit every document
in that relevant set at full depth; a broader documentation audit changes the amount of
documentation in scope, not the required depth for each relevant document. Do not read unrelated
documentation merely because an audit is being performed.

For every relevant document, establish that:

- normative strength, priority, scope, audience, conditions, timing, order, exceptions, required
  action, failure behavior, and intended practical behavior are correct and preserved;
- maintained rules, moving facts, status statements, and instructions have the correct canonical
  source, placement, lifecycle, and routing without stale competing authority;
- the complete mandatory reading route supplies required information before the affected
  decision or action;
- commands, paths, options, examples, generated derivatives, external copies, status, and
  operational claims agree with their executable or canonical source;
- historical, proposed, superseded, temporary, and non-authoritative material cannot reasonably
  be mistaken for current guidance;
- likely misreadings introduced by shortening, moving, merging, splitting, or reformatting have
  been considered; and
- targeted edits, consolidation with existing text, or an existing canonical source were
  preferred over append-only amendments, unnecessary files, duplicated moving facts, wholesale
  rewrites, or speculative documentation infrastructure where those alternatives preserve the
  intended meaning.

Documentation may be long when its length carries necessary meaning, but every word, sentence,
paragraph, heading, list, example, and repeated fact must provide enough semantic or operational
value to justify its recurring reading and token/context cost. Treat avoidable documentation
growth as a material audit defect when the same intent can be preserved more clearly and
compactly. Never trade away meaning, authority, conditions, ordering, exceptions, execution
clarity, or
resistance to misinterpretation merely to reduce length.

### Security, trust boundaries, performance, and resources

Always consider security, trust boundaries, performance, and resource use, with depth
proportionate to the reachable scope, actual risk, and realistic workloads. Apply adversarial
scrutiny to real boundaries and inspect actual hot paths, algorithmic or resource growth,
unbounded work, and credible operating costs.

Do not add speculative defenses or micro-optimizations without a real requirement or boundary.
Useful improvements without a real violation or material risk may use the appropriate
non-blocking finding class; do not inflate them into blockers merely because further improvement
is possible.

### Evidence and findings

Use reproducible, proportionate evidence that can be checked independently of the auditor's assertion or memory.
Select the smallest evidence set that convincingly proves each obligation, but never use efficiency to excuse
incomplete coverage.
Audit obligations and relevant risk lenses are mandatory within the declared scope; particular evidence techniques
are not rituals. Use mutation probes, fuzzing, history reconstruction, maximum-scale cases, or other expensive
techniques when they are reasonably expected to materially reduce unresolved uncertainty. If a material risk makes such
an expensive technique a credible way to do that, use it or record the inspected reason or equivalent evidence that
closes the uncertainty; update the plan when that need emerges. Avoid duplicate equivalent checks and permanent audit
machinery for a bounded problem.

Classify actionable findings with the existing project finding classes. A finding must identify
the violated requirement, supported path, real boundary, or demonstrated maintenance
consequence; concrete evidence; practical impact; affected scope; and smallest complete repair.
Personal style preferences, impossible internal states, unsupported future consumers, and
speculative risks are not defects unless they expose a real accepted boundary or maintenance
consequence.

When tests or test infrastructure are within scope, green results alone are insufficient. Where
the mechanism permits, introduce representative temporary defects or perform negative probes only
in a disposable local checkout, isolated fixture, or equivalent local test state. Never commit,
push, or introduce them into shared branches, CI configuration, shared services, or operational
external state. Confirm that:

- the intended test, oracle, validator, generator, replay system, matrix, or framework detects
  the defect for the intended reason rather than through an unrelated failure;
- materially different claimed failure families are probed when one defect cannot establish the
  claimed breadth;
- the failure identifies the relevant requirement, case, input, seed, boundary, or location
  closely enough to reproduce and debug it; and
- the probe, expected and actual detection, detecting mechanism, and diagnostic quality are
  recorded.

The required diagnostic detail follows the owned abstraction: infrastructure that owns
case-level evidence should normally provide case-level diagnostics. Restore every temporary
change and rerun enough clean verification to prove that no probe or stale generated output
remains. Do not create permanent mutation-testing machinery for a bounded audit. A
documentation-only audit does not mutate production code unless executable documentation checks
are themselves within scope.

## Findings outside scope

Distinguish an external issue that affects the scoped subject from an independent issue merely
found while investigating it:

- A **scope-impacting consequence** affects the correctness, safety, behavior, evidence,
  documentation, or maintainability of the scoped result. It is part of the audit and can affect
  the verdict.
- An **independent outside-scope finding** does not affect whether the scoped result satisfies
  its requirements. It does not lower the scoped verdict.

Report independent outside-scope findings separately as follow-up advice, using the appropriate
finding class and explaining the practical concern. The owner decides whether to schedule them.
Do not mislabel them as amendments, and do not require re-audit of a Passed scope unless later
work changes that scope or its dependencies.

## Report and verdict

Produce a complete Markdown audit report as the evidence record, with no empty ceremonial
sections or repeated boilerplate. Identify the exact audited identity and question, scope,
authority, exclusions, prepared and newly discovered angles, checks, decisive evidence,
findings, impact, smallest complete repairs, remaining uncertainty, and enough relevant
no-finding coverage to prove that material angles were investigated rather than silently
skipped.

Also provide a concise, decision-oriented chat summary containing the verdict, every actionable
finding ordered by severity, the most important evidence and uncertainty, the required next
action, and a short grouped summary of significant angles checked without findings. Do not
duplicate the full report.

Use exactly one verdict:

- `Passed`: the declared scope is convincingly satisfied. Only this closes the audit.
- `Passed with amendments`: the basis is sound, but a bounded set of concrete repairs remains.
  The repairs must be completed and re-audited before a final Pass.
- `Failed`: the result is fundamentally unsound, substantially misses applicable requirements,
  or requires major rework or redesign rather than bounded amendments.

Missing necessary evidence is not a fourth verdict. Obtain it. Adjust scope only when the assignment
authorizes that change or after owner or coordinator approval; never remove unavailable evidence
merely to obtain a Pass. Without the evidence or authorization, issue no verdict and report the
blockage.

Retain the final audit report as dated, non-canonical historical evidence linked to the exact
audited state, scope, verdict, and any later re-audit. The applicable workflow selects its durable
location; do not create a repository document solely for retention. Keep it outside default reading
routes and do not treat it as current project authority. Do not retain the temporary plan or other
preparation material.

## Re-audit

After `Passed with amendments`, start with the complete repair diff and verify that every
amendment was addressed correctly rather than superficially. Trace each repair through all
affected behavior, ordering, interfaces, tests, workflows, documentation, examples, generated
results, ownership, compatibility, boundaries, and adjacent effects.

Determine which earlier assumptions, conclusions, and evidence may have been affected. Re-audit
those areas at the depth their impact requires and rerun or extend all affected evidence.
Previously proved details need not be repeated mechanically only after establishing that they
remain unaffected. When a repair changes a fundamental assumption or broad shared behavior,
repeat the affected audit work at full depth.

Base the new verdict on current evidence for the repaired candidate. Only a new `Passed` closes
the audit.
