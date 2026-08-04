# Documentation review and audit profile

## Purpose

Use this profile for every non-trivial documentation review and for audits whose
question includes documentation correctness, authority, lifecycle, routing, or
recurring context cost. Read `../../DOCUMENTATION-OWNERSHIP.md` first.

An ordinary PR review applies the changed-surface section proportionately. A
full documentation audit additionally inventories and walks the complete
declared document system or route.

## Priority order

Apply this order when requirements conflict:

1. correctness and controlling authority;
2. preservation of accepted meaning and intended behavior;
3. clear, executable instructions available before the affected decision;
4. correct canonical ownership, lifecycle, routing, and synchronization;
5. maximum safe token and context efficiency.

A shorter text is not better when it weakens, broadens, narrows, delays,
reprioritizes, or obscures the rule. When equivalence is uncertain, retain the
clearer wording and record the uncertainty.

## Changed-surface review

For each added, removed, rewritten, merged, or relocated substantive rule,
status statement, instruction, or explanation:

1. identify its intended function, audience, and canonical owner;
2. find existing repository coverage before accepting a new document or
   duplicate explanation;
3. compare the previous and proposed meaning;
4. verify dependent references, examples, routes, generated derivatives, and
   moving facts;
5. inspect the complete documentation diff and the combined reading flow;
6. perform the safe-compaction pass only after semantic correctness is proven.

A code, test, or workflow change is incomplete when it makes canonical
information false or omits documentation needed to use, maintain, verify, or
review the supported behavior safely. Internal implementation detail need not be
documented when no maintained statement or user/agent behavior changes.

## Semantic preservation

Compare more than shared nouns or keywords. Record whether the rewrite preserves:

- normative force: requirement, prohibition, permission, recommendation, or
  example;
- priority and hierarchy relative to other rules;
- scope, audience, and applicability conditions;
- timing and order: when the reader must know or perform the step;
- exceptions and stop conditions;
- owner or decision authority;
- required evidence, action, result, and failure behavior;
- intended practical reader or agent behavior.

Classify the result as preserved, preserved through the complete route, weakened,
broadened, narrowed, delayed, ambiguous, lost, moved to the wrong owner, or
duplicated into competing authority.

Semantic preservation is the default. A meaning change is acceptable only when
traceable to the owning issue, an accepted ADR or specification, or an explicit
owner-approved scope amendment. A cleaner rewrite or PR implementation choice
is not authority by itself. Without authority, an altered policy, priority,
scope, timing, exception, or behavior is a blocker when it affects a supported
route or required workflow.

## Ownership, lifecycle, and placement

Verify that each maintenance-sensitive rule or moving fact has one clear
canonical owner. Elsewhere use a link or the smallest stable summary needed for
independent comprehension. Limited local repetition is valid when it is the
clearer KISS solution and does not create competing authority, duplicated moving
facts, drift, or unnecessary recurring context.

Check whether content is:

- a canonical current definition;
- a routing summary;
- necessary local context;
- a moving current fact;
- an accepted historical statement;
- non-authoritative research, proposal, example, issue, PR, audit, or review
  evidence.

Do not leave completed planning or migration wording in current routes merely as
history. Do not turn historical values into a second current inventory. Check
that file names describe durable purpose rather than one incident or review
complaint.

Before adding a file, ask whether a targeted update to an existing canonical
owner is clearer and cheaper. A new file needs a distinct audience, lifecycle,
ownership boundary, or independently executable purpose.

## Routing and executable instructions

Audit complete reading and execution routes, not only isolated files. For each
relevant task profile, verify that:

1. the startup or routing document points to the controlling destination;
2. required detail is read before the affected action or decision;
3. the destination contains the complete conditions, exceptions, order, failure
   handling, and authority;
4. no other current document presents a conflicting or weaker route;
5. the combined route produces the intended behavior without broad speculative
   reading.

A bare link or retained keyword does not prove semantic preservation. Conversely,
a routing summary need not repeat maintainer detail when the destination is
available at the point of use and independently executable.

Check commands, file names, options, paths, identifiers, examples, and described
outputs against the exact maintained implementation or artifact when the audit
claims operational correctness.

## Generated and external derivatives

When documentation or tooling produces shared files, archives, generated guides,
or external project-folder copies, identify:

- the editable canonical source;
- generation and validation steps;
- exact derivative inventory and stable names;
- synchronization owner and manual gates;
- stale or ambiguous copies that must be removed;
- proof that the reviewed derivative, not only its source, was regenerated and
  checked.

A repository merge does not prove an external derivative or settings field was
updated.

## Staleness and consistency audit

Search the declared scope for:

- statements made false by current code, accepted decisions, or workflow;
- conflicting authorities or summaries;
- obsolete files still routed as current;
- temporary rollout, fallback, migration, or review-repair text that should have
  expired;
- duplicate moving facts such as versions, current counts, active defaults,
  inventories, timings, or status;
- broken or misleading links, filenames, commands, and anchors;
- current documents that rely on non-authoritative issues, PRs, tests, audits,
  wishes, or research as if they were accepted authority.

Identify the exact conflict and controlling source. Do not silently reconcile
incompatible statements.

## Token-efficiency and word-existence pass

After correctness and semantic preservation are established, review each
maintained sentence, heading, list, code block, warning, example, and repeated
summary. Ask:

1. Does each word add a distinct rule, condition, exception, boundary, action,
   route, evidence requirement, or necessary disambiguation?
2. Can filler, repeated setup, duplicated nouns, or redundant qualifications be
   removed?
3. Can adjacent sentences or list items be combined without hiding priority,
   timing, or exceptions?
4. Can one-item lists, one-line code blocks, repeated headings, or excess
   vertical structure be collapsed without reducing scanability?
5. Is complete detail repeated where one canonical explanation plus a short
   route would be clearer?
6. Does local repetition materially improve independent comprehension, or only
   consume recurring context?
7. Would the shorter wording create a plausible misreading or weaken normative
   force?
8. Is the content always loaded, routinely loaded, or rare? Apply the strictest
   context-cost standard to startup and universal documents.

Classify candidates as safe compaction, unsafe compaction, useful local
repetition, harmful duplication, or formatting overhead. Do not use raw word or
token reduction as a quality target. Measurements are evidence that equivalent
compaction exists, not a numeric policy.

For a material rewrite, preserve the original meaning, proposed replacement,
reason removed words are redundant, and plausible misreadings tested. Prefer no
edit when equivalence is uncertain.

Optimize the complete routed reading set, not only individual files. Moving
text into a document that every agent must now read may increase total context
even when each file becomes shorter.

## Full documentation-audit inventory

A full documentation audit records, within its declared scope:

- every current routing and always-read document;
- applicable topic documents, specifications, accepted and proposed ADRs,
  planning, status, history, research, and generated derivatives;
- each document's authority, audience, lifecycle, canonical owner, and normal
  reading route;
- cross-document semantic ownership and moving facts;
- task-profile walkthroughs through the complete mandatory route;
- current implementation or workflow evidence needed to validate operational
  statements;
- word or token measurements for materially revised recurring routes when they
  help demonstrate safe simplification.

Use a coverage table. Every inventoried item must be reviewed, excluded with a
reason, blocked by identified missing evidence, or classified not applicable.

## Evidence and findings

A documentation blocker should identify:

- the exact text or missing owner;
- the controlling authority or supported workflow;
- the incorrect, changed, ambiguous, or stale meaning;
- the practical reader, agent, maintenance, security, or workflow consequence;
- a reproducible route, comparison, or implementation check;
- the smallest wording, placement, routing, or ownership repair.

For safe compaction, provide the replacement when practical and state why the
removed text adds no distinct meaning. Keep style preferences non-blocking
unless they create real ambiguity, maintenance failure, or material recurring
context without useful comprehension value.

## Completion criteria

A changed-surface documentation review is complete when canonical ownership,
semantic preservation, dependent routes, stale references, generated outputs,
and safe compactness have been checked for the complete diff.

A full documentation audit is complete only when its declared inventory and
reading routes are accounted for, authority conflicts are resolved or reported,
operational statements have sufficient evidence, token-efficiency review is
complete, findings and limitations are recorded, and excluded or blocked areas
are explicit. State the audited scope; do not claim that all repository
documentation is correct unless the inventory and evidence support that claim.
