# Data and API boundaries

Laravel owns accounts, forum, catalog, publishing, moderation, persistent state, media metadata, and public platform APIs. PostgreSQL is the primary database.

The player receives only selected validated data across the parent/player and server boundaries. Main-site cookies are host-only and unavailable to the player iframe. Package code may not access forum state, internal site data, or unrestricted external network endpoints.

## Current TypeScript POC surfaces

The repository currently exports several TypeScript layers through `src/index.ts`. These support the POC, repository tests, the playground, and compatibility callers; they do not create a second public backend.

### Source frontend

The source-oriented layer includes:

- `lex(...)`;
- `parse(...)`;
- `validateSemantics(...)`;
- `compileSource(...)`.

`compileSource(...)` is the normal combined route from source text to diagnostics and a compiled instruction plan. It returns no plan when parser, finite-literal, or semantic errors remain. In particular, non-finite numeric literals are reported as exact-span `TSC001`, while large finite literals remain valid. A returned plan is validated when a fresh runtime snapshot is created, when runtime execution begins, or when a caller invokes `validateInstructionPlan(...)` explicitly.

The lower-level `lex(...)` and `parse(...)` functions expose frontend results without promising that the source is compilable. Callers must not substitute parsing alone for the `compileSource(...)` validation boundary.

### Low-level plan and runtime

The lower-level layer includes:

- `compileProgram(...)` and `validateInstructionPlan(...)`;
- `createFreshRuntimeSnapshot(...)` and `validateRuntimeSnapshot(...)`;
- `executeInstruction(...)`, `stepToEvent(...)`, and `run(...)`;
- checkpoint creation, serialization, deserialization, and restore functions;
- versioned RNG state creation and advancement helpers.

The normal composition is:

```text
source
    -> compileSource
    -> compiled instruction plan
    -> fresh or restored validated runtime snapshot
    -> executeInstruction, stepToEvent, or run
```

Low-level functions remain separately exported for tests, tooling, debugging, and controlled integration. Callers that bypass `compileSource(...)` are responsible for composing the documented semantic, plan, snapshot, and checkpoint validation stages. `compileProgram(...)` performs lowering and limited defensive checks; it is not a substitute for semantic validation. It reuses the shared finite-literal AST validation and throws `InstructionCompilationError` with `TSC001` rather than returning a plan containing `NaN`, `Infinity`, or `-Infinity`. `validateInstructionPlan(...)` independently rejects non-JSON-safe plan data.

### Compatibility host boundary

`execute(program, options)` and `Interpreter` form the current direct-AST compatibility/testing boundary. They run shared finite-literal AST validation and semantic validation using configured global and builtin names before lowering. Non-finite literal values and semantic failures are exposed through ordered `InterpreterCompilationError` diagnostics rather than an unstructured runtime crash.

Compatibility globals and builtin results cross a serializable-value adapter. Values are copied and validated before entering runtime state. Host `RuntimeSpeaker` objects are not currently supported across this boundary; declared TeaseScript speakers remain runtime-owned values.

Runtime builtins are explicit capabilities. Only own registered properties are callable, core builtins retain precedence, and low-level named arguments use a prototype-free record. These rules prevent inherited JavaScript properties or prototype-mutating names from becoming implicit capabilities.

See [`docs/RUNTIME.md`](RUNTIME.md) for current execution behavior, structured errors, capabilities, compiler/template behavior, RNG invariants, defaults, and limits.

## Stability and future contracts

The current TypeScript exports and version-3 plan, snapshot, and checkpoint formats are POC implementation surfaces. Their current use does not establish permanent third-party API stability, a production wire-format guarantee, or a final Laravel/player protocol.

Exact account, toy, history, global-data, checkpoint storage, host-message, and integration payloads remain open and must be defined as typed contracts before implementation. This document does not accept those payloads or resolve their long-term versioning and migration policy.
