# Audit requirements — owner working draft

**Status:** Working draft for owner discussion. Not ready for repository publication.

## Purpose

An audit provides the strongest practical assurance possible—never an absolute
100% guarantee—that one exact, declared scope satisfies all applicable accepted
requirements, owner decisions, issue acceptance criteria, and canonical project
rules. It must expose material defects, unjustified complexity, weak evidence,
and realistic ways the result can be misunderstood or fail.

The audit derives its checks from the actual authority and audited subject. It
must not replace that work with a generic checklist, invent requirements, or
manufacture hypothetical defects merely to appear thorough.

## Pre-audit preparation

The auditor prepares before the final audit candidate is ready. This preparation
is substantive audit work, not ceremony.

1. Read the assigned issue, owner decisions, controlling documentation, relevant
   code, tests, workflows, documentation, and earlier review history. Earlier
   conclusions are leads, not proof.
2. Identify the intended final audit target, but treat live SHAs, PR state,
   generated artifacts, test results, and other moving facts as provisional until
   the final candidate is fixed.
3. Create a temporary Markdown audit checklist by combining:
   - these general audit requirements;
   - the applicable maintained audit profile;
   - every requirement, exclusion, and acceptance criterion from the assigned
     work;
   - risks, edge cases, impact paths, and evidence needed for the actual code or
     documentation being audited.
4. Add concrete checks discovered while reading the implementation and history.
   The maintained audit guidance is a floor, not a complete task checklist.
5. When the final candidate is ready, refresh its exact identity, current
   authority, diff, issue and PR state, CI, artifacts, and affected files. Stale
   preparation facts may not support the final verdict.
6. During the audit, execute the checklist, record decisive evidence and results,
   and add newly discovered checks. The checklist guides the audit but may not
   limit further investigation.
7. Maintain the checklist with targeted text edits so existing requirements,
   evidence, and completed work are not accidentally discarded by full-file
   rewrites.

The checklist is a temporary working instrument. Its task-specific detail does
not need to become permanent repository documentation, but the final report must
show enough evidence to prove that the relevant checklist was completed.

## Default integrated audit surface

A normal audit of a feature or implementation treats the complete delivered
change as one integrated subject. It includes, by default:

- the production implementation;
- the tests that claim to prove it;
- the documentation, examples, and status text that describe or route it; and
- the affected integrations, workflows, configuration, and public or trusted
  boundaries.

Code, tests, and documentation are not separate optional audit tracks when they
belong to the same change. A feature cannot Pass when its implementation works
but its tests are weak, its documentation is false or ambiguous, or its
documented behavior is not implemented.

Specialized profiles add audit methods that are unusual or substantially deeper;
they do not switch ordinary responsibilities on or off. Therefore:

- every implementation audit includes proportionate documentation and test
  scrutiny without loading a separate profile;
- the documentation profile is used when documentation itself is the primary
  audit subject or requires a full documentation-specific audit;
- the test-infrastructure profile is used when a matrix, generator, fuzzer,
  replay system, or test framework is itself being audited; and
- the workflow profile is used when automation behavior, permissions, triggers,
  artifacts, or trusted execution form a material part of the scope.

An audit may combine profiles when several specialized methods are genuinely
needed, but it must not create a profile tree for ordinary integrated feature
work.

## Scope and audit depth

The declared scope limits what system, component, change, or document set is
being audited. It does not preselect which angles matter inside that scope.

Within the declared scope, the auditor turns over every stone:

- inspect every file, module, function, branch, data structure, dependency,
  test, workflow step, configuration item, interface, generated result, and
  documentation passage that belongs to or can affect the scoped subject;
- consider every conceivable angle before deciding that an angle is irrelevant;
- treat relevance as a conclusion supported by inspection, not as an assumption
  used to skip inspection;
- require every retained element and every layer of complexity to justify its
  existence against an accepted requirement, real boundary, or demonstrated
  maintenance need;
- examine functional correctness, edge and failure behavior, security and trust
  boundaries, performance and resource use, determinism, persistence,
  compatibility, readability, maintainability, testing, documentation,
  integration effects, KISS, pragmatic YAGNI, useful DRY, and any additional
  angle the scoped subject can plausibly expose;
- trace interactions and indirect consequences beyond the immediate diff when
  they can change the scoped result;
- challenge whether something can be removed, simplified, clarified, combined,
  or replaced without weakening accepted behavior or real protections; and
- distinguish a checked angle that proved immaterial from an angle that was
  never considered.

The preparation checklist must deliberately brainstorm the widest practical set
of conceivable angles. It may group obviously related checks to remain usable,
but it may not discard an angle merely because it initially appears unlikely or
unimportant. During the audit, each angle is investigated far enough to justify
whether it requires deeper evidence or can be closed as immaterial.

A narrow audit may cover one component and its documentation. A broad audit may
cover an integrated program. Both are exhaustive within their declared scope.
The auditor may not use scope, expected relevance, the changed-file list, or a
prior review as permission for a shallow inspection.

## What every audit must establish

1. **All applicable obligations are accounted for.** Identify the exact audited
   snapshot and scope, derive the applicable obligations from their authoritative
   sources, and connect every obligation to inspected evidence and a result.
   Anything excluded, blocked, uncertain, or not checked remains explicit.

2. **The result is actually correct through its real supported paths.** Inspect
   normal behavior, relevant edge and failure behavior, security or trust
   boundaries, and interactions with adjacent components where they can change
   the outcome. Passing aggregate tests or repeating an earlier agent's claim is
   not proof of an unexamined requirement.

3. **KISS is applied to the complete result.** Check whether the same accepted
   outcome can be achieved more simply, whether local simplification moved
   complexity elsewhere, and whether abstractions, compatibility layers,
   indirection, files, helpers, schemas, checks, or documentation exist without a
   demonstrated current need. Apply pragmatic YAGNI. Apply DRY where it reduces
   total complexity, but retain clear local repetition where abstraction would
   conflict with KISS.

4. **The result is readable, maintainable, and difficult to misinterpret.** Code,
   tests, workflows, and documentation must communicate their responsibility,
   conditions, order, failure behavior, ownership, and intended use clearly.
   Compact forms are preferred only while they remain easier to understand;
   split or expand dense constructions when that materially improves
   comprehension. Test plausible interpretations an agent or maintainer could
   reasonably make, not only the author's intended reading.

5. **Evidence is independent and proportionate.** Treat implementation notes,
   previous reviews, test totals, and earlier audit conclusions as inputs to
   challenge, not proof. Use the smallest evidence set that convincingly proves
   each obligation. Do not duplicate equivalent checks, use maximum-scale cases
   when smaller evidence proves the same invariant, or add elaborate test or
   audit machinery for a bounded problem.

6. **Findings are real and actionable.** A finding identifies the violated
   requirement or supported path, concrete consequence, evidence, affected scope,
   and smallest complete repair. Personal style preferences, impossible internal
   states, unsupported future consumers, and speculative risks are not defects
   unless they expose a real accepted boundary or maintenance consequence.

7. **The conclusion matches the achieved assurance.** The auditor may claim only
   what the accounted obligations and evidence support. A complete audit states
   the exact scope, unresolved findings, blocked evidence, remaining uncertainty,
   and one of the three audit outcomes defined below.

## Proving that tests and test frameworks detect defects

When tests, a test matrix, a generator, a replay system, or a test framework is
inside the audit scope, green results alone are not sufficient evidence.

The auditor must, where the scoped mechanism permits it:

- introduce small temporary defects that violate the guarantee the test is
  supposed to protect;
- run the relevant test path and confirm that it fails for the intended reason;
- inspect the resulting failure and verify that the intended protection, oracle,
  or validation path detected the defect rather than an unrelated syntax,
  setup, build, or secondary failure;
- assess whether the diagnostic is proportionate to the scoped guarantee:
  it should identify the failing requirement, case, boundary, or location closely
  enough for a maintainer to reproduce, understand, and debug the problem without
  reverse-engineering an opaque generic error;
- record the mutation, expected detection, actual failure, detecting mechanism,
  diagnostic quality, and any missing debugging information;
- restore the original code completely;
- rebuild or rerun enough verification to prove that no temporary mutation or
  stale generated output remains.

This is commonly called a negative probe or mutation test. Its purpose in an
audit is not to create a permanent mutation-testing framework, but to prove that
the existing tests and their assertions can actually detect representative
failures.

Detection quality includes debuggability. A red result is weak evidence when it
does not show which guarantee failed, which generated or matrix case triggered
it, what input or seed reproduces it, or where the mismatch occurred. The exact
diagnostic detail depends on the audited surface: a broad generic error may be
acceptable for a broad boundary, while a framework that owns case-level evidence
should normally expose case-level diagnostics.

The mutations must target the guarantees owned by the audited test surface.
They should include different failure families where one mutation would not
demonstrate the breadth claimed by a matrix or framework.

This requirement is scope-dependent. It applies when the effectiveness of tests
or test infrastructure is being audited. A documentation-only audit does not
modify production code merely to perform mutation testing, unless executable
documentation checks are themselves part of the declared scope.

## Additional requirements for documentation audits

A documentation audit must additionally establish that:

- every maintained rule, moving fact, status statement, and instruction has the
  correct canonical owner and lifecycle, without stale competing authority;
- substantive wording preserves normative strength, priority, scope, audience,
  conditions, timing, order, exceptions, required action, failure behavior, and
  intended practical agent behavior;
- the complete mandatory reading route supplies the required rule before the
  affected decision or action, rather than relying on an isolated correct file or
  a bare link;
- likely misreadings introduced by shorter, moved, merged, or reformatted text
  have been tested explicitly;
- documentation is no longer than needed across the complete routed reading set,
  while clarity and semantic preservation take priority over word or token
  reduction;
- targeted edits were preferred over append-only amendments, unnecessary new
  files, complete rewrites, duplicated moving facts, or speculative documentation
  infrastructure;
- commands, paths, options, examples, generated derivatives, external copies,
  current status, and operational claims agree with the maintained executable or
  canonical source;
- historical, proposed, superseded, temporary, and non-authoritative material
  cannot reasonably be mistaken for current guidance;
- names, headings, lists, line wrapping, paragraph structure, and code blocks are
  as compact or expanded as needed for comprehension, not optimized by a rigid
  formatting rule;
- the required reading set is the smallest authoritative set for the task and
  does not force agents to load unrelated procedures or large documents.

## Findings outside the declared scope

A finding that is genuinely outside the declared scope does not prevent a Pass
for the audited scope.

The auditor must distinguish:

- **scope-impacting consequence:** the external issue affects the correctness,
  safety, behavior, evidence, documentation, or maintainability of the scoped
  subject. It is therefore part of the audit and can affect the verdict;
- **independent outside-scope finding:** the issue was discovered while turning
  over stones, but the auditor has established that it does not affect whether
  the scoped subject satisfies its requirements. It does not lower the scoped
  verdict.

Independent outside-scope findings are reported separately in the chat summary
as follow-up points. The auditor explains the practical concern and may advise
creating or updating an issue. The owner decides whether those follow-ups should
be scheduled.

A Passed audit may therefore include outside-scope follow-up advice. Those
points must not be mislabeled as amendments to the audited scope, and they do
not require re-audit of the Passed scope unless later work changes that scope or
its dependencies.

## Audit report and chat summary

The auditor produces two outputs with different purposes.

### Full audit report

The report is the complete evidence record. Its format is flexible and must not
contain empty ceremonial sections or repeated tables. It contains enough detail
to show:

- the exact audited identity, question, scope, authority, and exclusions;
- the prepared audit angles and additions discovered during the audit;
- applicable obligations and how complete coverage was established;
- checks performed, decisive evidence, findings, impact analysis, and smallest
  repairs;
- sufficient detail about angles that produced no finding to prove that they
  were considered and investigated rather than silently skipped;
- unresolved gaps and remaining uncertainty; and
- one precise outcome for the declared scope:
  - **Passed:** the audit is complete and the audited result satisfies the
    applicable requirements. This is the only outcome that closes the audit;
  - **Passed with amendments:** the basis is sound and most requirements are met,
    but the report identifies a limited set of concrete defects or required
    improvements. They must be repaired and re-audited before the result may
    receive a final Pass;
  - **Failed:** the result is fundamentally unsound, substantially misses the
    requirements, or needs redesign rather than a bounded repair. It returns to
    implementation or design work and requires a new audit after rework.

### Chat summary

The chat message is a concise decision-oriented summary. It contains:

- the verdict;
- every actionable finding, ordered by severity;
- the most important evidence and remaining uncertainty;
- the required next action; and
- a short grouped mention of significant angles that were checked but produced
  no finding.

The chat summary does not repeat the full report. It must remain complete enough
for the owner to understand the result, while the report preserves the detailed
audit trail.

## Re-audit after amendments

A `Passed with amendments` result is not closed by checking only that each listed
edit was made. The auditor must:

- inspect the complete repair diff and verify that every amendment was addressed
  correctly rather than superficially;
- trace each repair through all affected behavior, interfaces, tests, workflows,
  documentation, examples, generated derivatives, and adjacent components;
- determine whether a repair changed assumptions, ordering, failure behavior,
  ownership, compatibility, or another previously audited conclusion;
- rescan the complete declared audit scope for material findings missed during
  the first pass, with extra attention to areas touched directly or indirectly
  by the repairs;
- re-run or extend the evidence needed to prove the repaired result, rather than
  relying on the earlier evidence when the repair could invalidate it; and
- issue a new outcome. Only a new `Passed` closes the audit.

The re-audit is therefore impact-driven, not merely amendment-driven. Previously
proved, demonstrably unaffected details need not be repeated mechanically, but
the auditor must establish why they remain unaffected. When the repairs alter a
fundamental assumption or broad shared behavior, the relevant audit work is
performed again at full depth.

If required evidence is unavailable, the auditor does not invent a final
outcome. The audit remains incomplete until the evidence is obtained or the
owner explicitly changes the scope.

Detailed working inventories may remain temporary when the final report can
prove coverage more clearly and compactly. Audit-specific evidence that matters
only to one run belongs with that audit, issue, pull request, or CI record rather
than becoming permanent repository boilerplate.

## Still to decide with the owner

- Which domain-specific audit profiles are useful enough to justify separate
  maintained guidance instead of task-specific criteria.
