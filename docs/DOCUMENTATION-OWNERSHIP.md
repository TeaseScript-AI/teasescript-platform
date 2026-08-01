# Documentation ownership

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
