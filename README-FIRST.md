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

On `main`, the parser and core-language foundation are complete. The stacked
`feature/runtime-playground` branch adds the local serializable-runtime and
browser-playground vertical slice. The current `feature/control-flow-runtime`
branch extends that slice with accepted comments, ranges, deterministic random
built-ins, `else if`, loops, loop control, fixed examples, and CI:

```text
TeaseScript source
    -> lexer and parser
    -> semantic validation
    -> versioned serializable instruction plan
    -> versioned serializable deterministic runtime state
    -> typed runtime events
    -> standalone browser playground
```

The runtime executes compiled instructions rather than AST nodes. Its POC
checkpoint is a self-contained plan-and-snapshot bundle. The playground is a
development page, not the future public backend or cross-origin host/iframe
integration.

The control-flow branch uses instruction-plan version 2, runtime-snapshot
version 2, and checkpoint version 2. Unsupported older versions are rejected
explicitly.

Do not add Laravel, media, storage, account APIs, custom views, module selection,
or continuous-personality services to this milestone.

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
