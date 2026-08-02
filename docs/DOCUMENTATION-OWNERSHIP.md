# Documentation ownership

This document is the mandatory guide for every non-trivial repository
documentation edit and documentation review. Pure spelling, link, or formatting
corrections may skip the reread only when they cannot alter meaning, authority,
placement, or maintenance obligations. This guide defines where durable
information belongs and how to avoid competing authority, stale copies, and
unnecessary recurring agent-context cost.

## Canonical ownership and useful repetition

Give each maintenance-sensitive fact, rule, status statement, or instruction
one clear canonical owner. Keep the complete authoritative explanation there.
Elsewhere, prefer a link or the smallest stable summary needed for the local
document to remain understandable.

KISS is primary: choose the simplest complete documentation structure across
local clarity, authority, maintenance, and recurring reader or agent context.
Pragmatic YAGNI applies that rule to future-facing documentation and rejects
policy, inventories, or abstractions that have no current accepted purpose.

DRY is recommended when one canonical explanation plus references is clearer
and simpler to understand and maintain than several copies. Limited local
repetition is also recommended when it is the clearer KISS solution, provided
it does not create competing authority, duplicate moving facts, or add
unnecessary recurring context cost. DRY is not an absolute ban on repetition.

Distinguish these uses:

- **canonical definition:** the complete maintained rule, contract, or current
  fact in its owning document;
- **routing summary:** a short statement that directs the reader to the
  canonical definition;
- **necessary local context:** limited repetition needed to understand or apply
  the local document without reconstructing its basic purpose elsewhere;
- **moving fact:** a current revision, test count, implementation status,
  temporary inventory, active default, or similar value that normally needs
  one current location;
- **historical statement:** a stable record of a past accepted decision, such
  as the revision that introduced a contract change.

Historical ADR and specification statements may retain exact old values when
those values explain the recorded decision. Do not convert such history into a
second moving current-state summary.

## Documentation edit and review workflow

Before every non-trivial documentation edit, the writer must:

1. identify the fact, rule, status, or instruction being changed;
2. search the repository for existing coverage and determine the canonical
   owner;
3. update one complete canonical explanation rather than adding a competing
   definition;
4. use links or minimal stable summaries elsewhere where that remains clear;
5. retain concise local repetition where it materially improves independent
   comprehension without creating competing authority or duplicated moving
   facts;
6. update or remove stale statements made false by the change;
7. consolidate existing duplication when it is directly in scope and safe,
   without expanding into unrelated cleanup;
8. review the complete documentation diff for placement, consistency,
   maintenance cost, and recurring agent-context cost.

The documentation reviewer performs the same ownership check independently.
Verify that DRY is used where it reduces total complexity, that intentional
repetition serves local comprehension, that moving facts are not copied without
a concrete local need, and that routing documents do not silently become
competing policy or current-status owners.

## GitHub repository: canonical and continuously maintained

The repository owns documentation that must change with code, architecture, language semantics, security boundaries, product decisions, or the stable development process:

- root routing/status files: `README-FIRST.md`, `CURRENT-DESIGN.md`, `PHASE-STATUS.md`, `AGENTS.md`, and `README.md`;
- accepted syntax specifications;
- ADRs;
- concise current topic documents in `docs/`;
- `docs/DEVELOPMENT-WORKFLOW.md` and other stable repository workflow rules;
- current open decisions, the selected POC-to-alpha backlog, and deliberately maintained repository planning documents;
- `WISHES.xml` product intent/history;
- executable, tested examples under `examples/`.

A code or semantic change is incomplete when its canonical documentation becomes false. Update the relevant repository document in the same pull request unless the change is purely internal and does not affect documented behavior or status.

The selected backlog, temporary coordination, and implementation status have different lifecycles:

- `docs/planning/POC-TO-ALPHA-BACKLOG.md` records owner-selected obligations that remain open before a target gate;
- a deliberately maintained repository issue or phase-scope document may record scheduled scope when the owner or coordinator chooses to keep that planning in GitHub;
- temporary coordinator work breakdowns, executor assignments, integration order, and commit tracking remain outside the repository and are non-canonical;
- accepted decisions and implemented results from temporary coordination are synchronized back into the relevant ADRs, specifications, current topic documents, and `PHASE-STATUS.md`.

Do not keep completed items in the open backlog merely as history; Git already preserves their earlier state.

## Shared project folder: durable context and non-authoritative research

The shared project folder should contain only material useful across chat sessions that is not appropriate as canonical repository documentation:

- a stable project instruction/context file;
- a short routing file pointing to the repository as source of truth;
- capability research about Tease AI, SexScripts/Groovy, Milovana EOS, and VirMst/CyberDom;
- raw or archived third-party script examples;
- historical project packages and superseded design documents;
- dated audit and review reports when retained for evidence.

Research and historical material must be explicitly labeled non-authoritative. It may inform design but cannot silently define syntax, architecture, or implementation status.

## Material intentionally excluded from GitHub

Do not add the following merely to make the repository self-contained:

- large third-party source ZIP files;
- copied legacy engine/script archives;
- chat scratchpads or temporary research notes;
- temporary coordinator work breakdowns, executor assignments, or integration logs;
- generated package manifests/checksum lists for shared-project ZIPs;
- duplicate historical versions of canonical documents;
- PR-specific audit reports after their relevant conclusions are incorporated into current docs and tests.

## Avoiding drift

- GitHub is the source of truth for exact implementation, decision, and stable workflow documentation.
- The shared project context must not claim an exact current commit or test count unless it is a dated handoff note.
- When a chat lacks GitHub access, provide a current repository ZIP or patch rather than treating the shared research package as current code documentation.
- Periodic research-archive cleanup may reorganize files, but must preserve source hashes and non-authoritative labels.
