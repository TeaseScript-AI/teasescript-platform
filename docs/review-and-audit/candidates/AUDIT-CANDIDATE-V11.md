# Audit requirements — owner working draft

**Status:** Working draft. Not ready for repository publication.

## Purpose and audit readiness

An audit provides the strongest practical assurance possible—never an absolute
100% guarantee—that one exact, declared scope satisfies all applicable accepted
requirements, owner decisions, issue criteria, and canonical project rules. It
must expose material defects, unjustified complexity, weak evidence, and
realistic ways the result can fail or be misinterpreted.

The final audit starts only after implementation, normal review, and known
repairs are complete. The auditor may prepare earlier, but final evidence and
the verdict must use one fixed candidate.

Checks come from the actual authority and audited subject. Generic guidance may
support that work, but may not replace it, invent requirements, or manufacture
hypothetical defects merely to appear thorough.

## Pre-audit preparation

Before the candidate is final, the auditor:

1. reads the issue, owner decisions, controlling documentation, relevant code,
   tests, workflows, documentation, and earlier review history;
2. treats earlier conclusions as leads rather than proof, and moving facts such
   as SHAs, PR state, artifacts, and test results as provisional;
3. creates a temporary Markdown checklist containing every requirement,
   exclusion, acceptance criterion, conceivable audit angle, likely risk,
   edge case, indirect effect, and required item of evidence;
4. adds checks discovered while studying the implementation and history; and
5. maintains the checklist with targeted edits so existing checks, evidence,
   and completed work are not lost through repeated full-file rewrites.

When the candidate is final, the auditor refreshes its exact commit, tree, diff,
authority, issue and PR state, affected files, CI, artifacts, and other moving
facts. Evidence tied to an older state cannot support the verdict.

During the audit, the checklist is executed and updated with results, decisive
evidence, and newly discovered checks. It guides the audit but never limits it.

## Scope and depth

Scope determines **what** is audited, not **how deeply**. A narrow component
audit and a broad integration audit are both exhaustive within their declared
scope.

Within that scope, the auditor turns over every stone:

- inspect every file, module, function, branch, data structure, dependency,
  test, workflow step, configuration item, interface, generated result, and
  documentation passage that belongs to or can affect the scoped subject;
- consider every conceivable angle before deciding it is immaterial;
- treat relevance as a conclusion supported by inspection, not an assumption
  used to skip work;
- trace indirect consequences beyond the diff when they can change the scoped
  result; and
- distinguish an angle checked and closed as immaterial from one never examined.

A normal feature audit treats implementation, tests, documentation, examples,
status text, configuration, workflows, integrations, and real public or trusted
boundaries as one delivered result. Code cannot Pass while its tests are weak,
its documentation is false or ambiguous, or documented behavior is absent.

## What the audit must establish

### Requirements and correctness

- Every applicable obligation is derived from authoritative sources and linked
  to inspected evidence and a result.
- Supported behavior, edge cases, failure paths, ordering, integration effects,
  and real external, persistence, host, package, publication, or security
  boundaries work correctly.
- Previous approval, green aggregate tests, test totals, implementation notes,
  and confident agent claims are evidence to challenge, not proof.
- Excluded, blocked, uncertain, unavailable, or unverified work remains explicit.

### Simplicity and justification

- Every retained file, function, abstraction, dependency, compatibility layer,
  schema, check, workflow step, and documentation section justifies its
  existence through a current requirement, real boundary, or demonstrated
  maintenance need.
- KISS applies to the complete result, not only individual files.
- Pragmatic YAGNI rejects complexity for hypothetical future consumers.
- DRY is used where it reduces total complexity; clear local repetition remains
  acceptable where abstraction would conflict with KISS.
- Simplification must not move complexity, risk, context cost, or maintenance
  burden elsewhere.
- The auditor actively asks what can be removed, combined, clarified, or
  simplified without weakening accepted behavior or real protection.

### Clarity, maintainability, and documentation

- Code, tests, workflows, and documentation clearly communicate responsibility,
  ownership, intended use, conditions, order, and failure behavior.
- Plausible alternative interpretations are tested, especially after text or
  structure is shortened, moved, merged, or reformatted.
- Naming, headings, paragraphs, lists, wrapping, code blocks, and code structure
  are as compact or expanded as comprehension requires. Dense or fragmented
  forms are findings when they materially hinder understanding, debugging, or
  safe modification.
- Documentation preserves normative strength, priority, scope, audience,
  conditions, timing, order, exceptions, required action, failure behavior, and
  intended practical behavior.
- Maintained rules, moving facts, status statements, and instructions have one
  correct canonical owner and lifecycle, without stale competing authority.
- The complete mandatory reading route supplies each required rule before the
  affected decision or action; an isolated correct file or bare link is not
  sufficient.
- Commands, paths, options, examples, generated derivatives, external copies,
  status, and operational claims agree with their executable or canonical
  source.
- Historical, proposed, superseded, temporary, and non-authoritative material
  cannot reasonably be mistaken for current guidance.
- Documentation and its routed reading set are no longer than necessary, but
  correctness, semantic preservation, unambiguous execution, and local
  comprehension take priority over word or token reduction.
- Targeted edits are preferred over append-only amendments, unnecessary files,
  wholesale rewrites, duplicated moving facts, or speculative documentation
  infrastructure.

### Security and performance

Security and performance are always examined against the real reachable scope:

- external, persisted, host, package, account, publication, and other trust
  boundaries receive proportionate adversarial scrutiny;
- validated internal code is not burdened with speculative defenses for an
  unaccepted future API;
- actual hot paths, algorithmic or resource growth, unbounded work, and
  realistic operating costs are examined; and
- hypothetical threats and micro-optimizations do not justify complexity that
  makes the result less KISS without protecting a real requirement or boundary.

### Evidence and findings

Evidence must be independent, reproducible, and proportionate. Use the smallest
set that convincingly proves each obligation, but never use efficiency to excuse
incomplete coverage. Avoid duplicate equivalent checks, maximum-scale cases
when smaller evidence proves the same invariant, and permanent audit machinery
for a bounded problem.

When tests or test infrastructure are within scope, green results alone are not
enough. Where the mechanism permits it, the auditor introduces representative
temporary defects or negative probes and confirms that:

- the intended test, oracle, or validator detects them for the intended reason;
- different claimed failure families are probed when one mutation cannot prove
  the claimed breadth;
- the failure identifies the relevant requirement, case, input, seed, boundary,
  or location closely enough to reproduce and debug it; and
- the mutation, expected and actual detection, detecting mechanism, and
  diagnostic quality are recorded.

A generic diagnostic is acceptable only when it matches the abstraction
boundary; case-owning infrastructure should normally provide case-level
evidence. All temporary changes and stale generated output are removed and clean
verification is repeated. A documentation-only audit does not mutate production
code unless executable documentation checks are themselves in scope.

A finding identifies the violated requirement or supported path, evidence,
practical consequence, affected scope, and smallest complete repair. Personal
style preferences, impossible states, unsupported future consumers, and fantasy
risks are not defects unless they expose a real accepted boundary or maintenance
consequence.

## Findings outside scope

The auditor distinguishes:

- **scope-impacting consequence:** an external issue affects the correctness,
  safety, behavior, evidence, documentation, or maintainability of the scoped
  result and therefore affects the audit;
- **independent outside-scope finding:** the issue does not affect whether the
  scoped result satisfies its requirements.

Independent outside-scope findings do not lower a Passed verdict. They are
reported separately as follow-up advice, normally with a recommendation to
create or update an issue. The owner decides whether to schedule them. They do
not require re-audit unless later work changes the Passed scope or its
dependencies.

## Report and verdict

The auditor produces:

1. a full Markdown report containing the detailed audit trail; and
2. a concise chat summary containing the verdict, every actionable finding
   ordered by severity, important evidence, remaining uncertainty, required next
   action, and a short grouped summary of significant angles checked without
   findings.

The report records the exact audited identity, scope, authority, exclusions,
prepared and added audit angles, checks, decisive evidence, findings, impact
analysis, unresolved uncertainty, and enough detail to prove that apparently
immaterial angles were considered rather than silently skipped. Its structure
is flexible and contains no empty ceremonial sections or repeated boilerplate
tables.

The verdict is one of:

- **Passed:** all requirements within scope are convincingly satisfied. This is
  the only outcome that closes the audit.
- **Passed with amendments:** the basis is sound, but a bounded set of concrete
  defects or required improvements remains. They must be repaired and
  re-audited before a final Pass.
- **Failed:** the result is fundamentally unsound or needs redesign rather than
  a bounded repair. It returns to implementation and normal review before a new
  audit.

Unavailable required evidence leaves the audit incomplete. The evidence must be
obtained, or the owner must explicitly change the scope before a verdict is
issued.

## Re-audit

After `Passed with amendments`, the auditor:

- inspects the complete repair diff and verifies every amendment was addressed
  correctly rather than superficially;
- traces each repair through behavior, ordering, interfaces, tests, workflows,
  documentation, examples, generated results, ownership, compatibility, and
  adjacent effects;
- identifies which earlier assumptions and evidence the repairs invalidate;
- rescans the complete original scope for missed findings; and
- reruns or extends all affected evidence.

The re-audit is impact-driven, not a checklist confirmation. Previously proved
details need not be repeated mechanically only when the auditor establishes that
they remain unaffected. A repair that changes a fundamental assumption or broad
shared behavior triggers renewed full-depth work for the affected audit area.
Only a new `Passed` closes the audit.

## Retention

The temporary checklist may be discarded after the audit closes.

The final report is retained as dated, non-authoritative historical evidence,
tied to its exact audited commit or tree, scope, verdict, and any later re-audit.
It does not become a current specification or replace canonical documentation.
