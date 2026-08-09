# Documentation ownership

This document is the mandatory guide for every non-trivial repository
documentation edit and documentation review. Pure spelling, link, or formatting
corrections may skip the reread only when they cannot alter meaning, authority,
placement, or maintenance obligations. This guide defines where durable
information belongs and how to avoid competing authority, stale copies, and
unnecessary recurring agent-context cost.

## Canonical sources and useful repetition

Give each maintenance-sensitive fact, rule, status statement, or instruction
one clear canonical source. Keep the complete authoritative explanation there.
Elsewhere, prefer a link or the smallest stable summary needed for the local
document to remain understandable.

**Owner** means the project's human owner and final decision authority. Agents may
temporarily execute or coordinate work, but they are not owners. A **canonical
source** is the repository location that maintains a rule or fact. Durable
responsibility must be recoverable from repository state; record the canonical
source and any required owner approval or change process rather than assigning
persistent agent ownership. A coordinator is only an explicitly assigned temporary
workflow role.

KISS is primary: choose the simplest complete documentation structure across
local clarity, authority, maintenance, and recurring reader or agent context.
Pragmatic YAGNI applies that rule to future-facing documentation and rejects
policy, inventories, or abstractions that have no current accepted purpose.

DRY is subordinate to KISS and pragmatic YAGNI. Use one canonical explanation
plus references when that is clearer and simpler to understand and maintain
than several copies. Prefer limited local repetition when it is the clearer
KISS solution, provided it does not create competing authority, duplicate
moving facts, or add unnecessary recurring context cost. DRY is not an absolute
ban on repetition.

Distinguish these uses:

- **canonical definition:** the complete maintained rule, contract, or current
  fact in its canonical source;
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
second moving current-state summary. Retain historical material in the working
tree only when it preserves unique reasoning likely to answer a concrete future
question and cannot be reduced without meaningful loss. Mark retained history
non-authoritative and exclude it from default reading. Git history is the normal
fallback; deep historical research also checks relevant commits, pull requests,
and earlier file versions. When retention value is uncertain, rely on Git. The
compact checked milestone summaries explicitly retained by the release roadmap
are the narrow exception: they record roadmap progress, not current implementation
detail or decision rationale.

## Canonical source map

- **Approved product intent and owner wish history:** [`WISHES.xml`](../WISHES.xml).
- **Accepted decisions and rationale:** accepted ADRs in [`docs/decisions/`](decisions/).
- **Accepted syntax and semantics:**
  [`docs/specifications/accepted-syntaxes-v30.md`](specifications/accepted-syntaxes-v30.md), overridden only within
  the exact scope of a later accepted ADR or an accepted update to that specification.
- **Current architecture map and component boundaries:** [`CURRENT-DESIGN.md`](../CURRENT-DESIGN.md) and
  [`docs/ARCHITECTURE.md`](ARCHITECTURE.md); accepted ADRs are canonical for the decisions and rationale.
- **Exact current implementation:** repository code and executable configuration. Current topic documents are canonical
  for maintained contracts, while [`PHASE-STATUS.md`](../PHASE-STATUS.md) is canonical for high-level capability state.
- **Release-stage placement, open release-stage outcomes, and compact roadmap progress:**
  [`docs/planning/RELEASE-ROADMAP.md`](planning/RELEASE-ROADMAP.md), while [`PHASE-STATUS.md`](../PHASE-STATUS.md) records
  verified current state. The roadmap does not replace accepted decisions, specifications, or topic contracts.
- **Unresolved product or technical choices:** [`docs/OPEN-DECISIONS.md`](OPEN-DECISIONS.md).
- **Concrete execution tasks:** GitHub issues; pull requests are implementation handoffs and review evidence.

A product or technical decision by the Owner becomes durable implementation authority only after an accepted ADR,
accepted specification, or controlling current topic document is updated. `WISHES.xml` may preserve approved product
intent and wish history, but it does not by itself accept an implementation decision. Chat messages, issues,
pull-request text, tests, CI results, and reviews may prove intent, behavior, or execution state, but remain evidence or
task context until the required synchronization occurs.

Executable sources retain moving values they directly control: `.nvmrc` records the required Node runtime selection;
`package.json` and the lockfile record dependency requirements; bootstrap `MANIFEST.json` files record release payload
identity; workflows and live CI record current run results. Truthful dated SHAs, commands, counts, timings, and results
in issues, pull requests, reviews, CI, or audits remain historical evidence; do not rewrite them merely because the
repository advanced. Retain benchmark or resource measurements in a dated evidence record only when they have a
concrete current consumer and enough revision, environment, method, workload, configuration, result, limitation, and
intended-use detail to support comparison.

## Documentation edit and review workflow

Before every non-trivial documentation edit, the writer must:

1. identify the fact, rule, status, or instruction being changed;
2. search the repository for existing coverage and determine the canonical
   source;
3. make targeted edits to one complete canonical explanation rather than
   appending amendments, replacing the whole document when existing content
   should survive, or adding a competing definition;
4. use links or minimal stable summaries elsewhere where that remains clear;
5. retain concise local repetition where it materially improves independent
   comprehension without creating competing authority or duplicated moving
   facts;
6. update or remove stale statements made false by the change;
7. consolidate existing duplication when it is directly in scope and safe,
   without expanding into unrelated cleanup;
8. review the complete documentation diff for placement, consistency,
   maintenance cost, and recurring agent-context cost.

The documentation reviewer performs the same canonical-source check independently.
Verify that DRY is used where it reduces total complexity, that intentional
repetition serves local comprehension, that moving facts are not copied without
a concrete local need, and that routing documents do not silently become
competing policy or current-status sources.

For coordinated work, assign semantic write ownership for each canonical
surface instead of having multiple agents independently reconcile the same
meaning. This is a risk-based default, not an absolute rule that an executor may
never edit documentation: a small mechanical correction may travel with an
implementation when its authority, meaning, and conflict risk are clear, while
cross-document consolidation, decision wording, or other semantically sensitive
changes should normally be handled by one designated documentation writer or an
explicit handoff. Concurrent documentation work must not create competing
current-state descriptions merely because the file edits do not textually
conflict.

Document names describe durable purpose, not a temporary cleanup history or the
latest review complaint. General tool, command, option, branch, issue, and
workflow naming is canonically defined in [`DEVELOPMENT-WORKFLOW.md`](DEVELOPMENT-WORKFLOW.md).

### Markdown source wrapping

Hard-wrap ordinary Markdown prose at 120 characters where practical. Do not rewrap unchanged paragraphs solely for
formatting. When materially editing a paragraph, rewrap that paragraph consistently at the target width.

Code blocks, tables, long links, generated content, and other structures may exceed the target when wrapping
would reduce clarity, correctness, or maintainability.

## GitHub repository: canonical and continuously maintained

The repository is the canonical source for documentation that must change with code, architecture, language semantics,
security boundaries, product decisions, or the stable development process:

- root routing/status files: `README-FIRST.md`, `CURRENT-DESIGN.md`, `PHASE-STATUS.md`, `AGENTS.md`, and `README.md`;
- accepted syntax specifications;
- ADRs;
- concise current topic documents in `docs/`;
- `docs/DEVELOPMENT-WORKFLOW.md` for universal issue, branch, pull-request,
  review, documentation, merge, and verification rules;
- `docs/agents/README.md` and its focused guides for capability-specific
  source acquisition, writes, verification, and publication constraints, with
  separate focused task guidance for explicitly coordinated work;
- `docs/PATCH-PUBLICATION.md` for the verified patch protocol and security boundary;
- current open decisions, the release roadmap, and deliberately maintained repository planning documents;
- `WISHES.xml` product intent/history;
- executable, tested examples under `examples/`.

A code or semantic change is incomplete when its canonical documentation becomes false. Update the relevant repository document in the same pull request unless the change is purely internal and does not affect documented behavior or status.

The release roadmap, temporary coordination, and implementation status have different lifecycles:

- `docs/planning/RELEASE-ROADMAP.md` records owner-selected release-stage placement and open outcomes, and may retain
  compact checked milestones as progress history; current implementation details and status remain in their canonical
  sources;
- a deliberately maintained repository issue or phase-scope document may record scheduled scope when the owner or coordinator chooses to keep that planning in GitHub;
- temporary coordinator work breakdowns, executor assignments, integration order, and commit tracking remain outside the repository and are non-canonical;
- accepted decisions and implemented results from temporary coordination are synchronized back into the relevant ADRs, specifications, current topic documents, and `PHASE-STATUS.md`.

Capability routing follows the same canonical-source rule. `docs/agents/README.md` is the canonical source for
selection and composition; each focused guide is canonical only for its profile procedure. After a verified checkout
exists, replaceable connector artifact mechanics live in `docs/agents/CONNECTOR-SOURCE-ACQUISITION.md`. The compact
project-folder `README-FIRST.md` is the narrow pre-checkout exception: it carries the concrete startup acquisition steps
needed to obtain the first exact checkout from an otherwise empty project context. Later source refreshes use the
current connector acquisition guide; universal documents and other controlled derivatives do not copy those moving
mechanics.

## Shared project folder: durable context and non-authoritative research

The ChatGPT project folder contains at most the compact `README-FIRST.md`, the small tools `tar.gz`, the large runtime
`tar.zst`, the standalone setup script, and the optional non-authoritative research archive. Stable routing and
bootstrap files are controlled derivatives rather than second editable workflow sources.

Maintainable installed project-agent files live under `tools/chatgpt-project-agent/`, whose relative layout mirrors the
installed environment where practical. The external tools archive is made from that directory; generated archive
binaries are not committed. Large runtime-only payloads remain outside Git.

`docs/chatgpt-project/README-FIRST.md` is the compact project-folder wayfinder, not a concatenation of installed guides.
`docs/chatgpt-project/SYSTEM-PROMPT.txt` is the repository-maintained prompt candidate for deliberate owner-approved
synchronization into the separate ChatGPT Project Settings field. It is not proof of the live Project Settings state, is
not a project-folder file, and is absent from both archives. Repository merge, project-folder replacement, and an owner
change to Project Settings are distinct steps and must not be treated as proof of one another.

Research and historical material must be explicitly labeled non-authoritative. It may inform design but cannot silently define syntax, architecture, or implementation status.

## Material intentionally excluded from GitHub

Do not add the following merely to make the repository self-contained:

- large third-party source ZIP files;
- copied legacy engine/script archives;
- chat scratchpads or temporary research notes;
- temporary coordinator work breakdowns, executor assignments, or integration logs;
- generated archive binaries, per-release checksums, or temporary staging manifests for ChatGPT project-folder derivatives;
- duplicate historical versions of canonical documents;
- PR-specific audit reports after their relevant conclusions are incorporated into current docs and tests.

## Avoiding drift

- GitHub is the source of truth for exact implementation, decision, and stable workflow documentation.
- The shared project context must not claim an exact current commit or test count unless it is a dated handoff note.
- When a chat lacks GitHub access, provide a current repository ZIP or patch rather than treating the shared research package as current code documentation.
- Periodic research-archive cleanup may reorganize files, but must preserve source hashes and non-authoritative labels.
