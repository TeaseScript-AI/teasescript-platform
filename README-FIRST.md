# Read this first

## Current authority order

Use project documents in this order:

1. `docs/specifications/accepted-syntaxes-v30.md` for accepted TeaseScript syntax.
2. Explicit decisions confirmed by Peter after V30.
3. Accepted ADRs in `docs/decisions/`.
4. `CURRENT-DESIGN.md` for the current architecture and POC scope.
5. `docs/planning/V30-TO-V31-GAP-REVIEW.md` for proposed additions, conflicts, and unresolved work.
6. `docs/planning/POST-POC-DEVELOPMENT-BACKLOG.md` for later implementation work.
7. Older project packages and research documents only as non-authoritative reference material.

When sources conflict, do not silently reconcile them. V30 leads over older syntax unless a newer confirmed decision or accepted ADR explicitly supersedes it.

## Current POC scope

The first milestone is a local parser POC:

```text
TeaseScript source -> lexer -> parser -> AST -> diagnostics
```

The next small milestone is a speaker execution POC that interprets only the speaker-related AST and emits testable events. It is not the complete runtime engine.

Do not add Laravel, media, storage, account APIs, custom views, module selection, or continuous-personality services to the first parser POC.

## Language and architecture boundaries

- Regular content uses `.tease`.
- Advanced reusable programming logic uses real TypeScript in `.ts`.
- `.ts` libraries are never selected as random content modules.
- Laravel is the only public backend.
- Parser and runtime code are TypeScript compiled to JavaScript.
- The final player and package code run inside a sandboxed cross-origin iframe.
- Keep one engine, one state model, and one save format.
- Keep execution deterministic, testable, pausable, and resumable.

## Repository documents

- `CURRENT-DESIGN.md`: current architecture and development scope.
- `AGENTS.md`: coding, review, and Git workflow rules.
- `docs/specifications/`: current accepted specifications.
- `docs/decisions/`: accepted and proposed architectural decisions.
- `docs/planning/`: non-authoritative proposals and backlog.
- `docs/reference/`: capability research and explicitly non-authoritative historical material.
