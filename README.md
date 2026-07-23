# TeaseScript Platform

Browser-first platform and deterministic scripting language for interactive teases, persistent personalities, and broader roleplay packages.

Start with [`README-FIRST.md`](README-FIRST.md).

On `main`, the TypeScript core contains the parser and core-language foundation.
The stacked `feature/runtime-playground` branch adds a serializable runtime and
standalone browser playground. This `feature/control-flow-runtime` branch adds
accepted comments, ranges, deterministic random built-ins, two-word `else if`,
`repeat`, list/set/range `for`, `while`, `break`, and `continue`.

The implemented subset compiles to a versioned JSON-safe instruction plan and
executes with explicit checkpointable runtime state and typed events. Plans,
snapshots, and checkpoints use version 2 on the control-flow branch and reject
unsupported older versions. The wider V30 language and full static type
checking remain out of scope.

## Core development

Use the Node.js version pinned in `.nvmrc`, then run:

```shell
npm ci
npm run check
```

## Standalone development playground

Install the pinned development dependencies and start the local player:

```shell
npm ci
npm run playground
```

The development server builds TypeScript first and listens at
`http://127.0.0.1:4173/` by default. To make it reachable through an LXC or LAN
interface deliberately, run:

```shell
HOST=0.0.0.0 PORT=4173 npm run playground
```

Binding to `0.0.0.0` exposes this development server to every network that can
reach the container. The playground is not production-ready and is not a
public Node backend; Laravel remains the only eventual public backend.

The page offers only the repository-backed `main`, `control-flow`, and
`checkpoint-loop` examples. Selecting another example resets runtime UI state.
Saved checkpoints are namespaced by example and checkpoint format version.
Use event-boundary Step and save during `checkpoint-loop` to inspect and restore
an active serialized loop frame.

Fresh playground runs use the fixed unsigned seed `0x6d2b79f5`
(`1831565813`) with the versioned `xorshift32-v1` runtime RNG. This makes the
repository example reproducible. The generator is not cryptographically secure
and is not a language-syntax guarantee.

The POC has two development-only dependencies, both exactly pinned in the lockfile:

- `typescript` compiles and statically checks the TypeScript parser core. Plain JavaScript or a separate transpiler would either abandon the accepted TypeScript architecture or add another tool. It requires compiler-version maintenance, but adds no runtime package or production network access.
- `@types/node` supplies types for the Node.js test harness. Hand-maintained declarations would duplicate the Node API surface. It must track the pinned Node.js version and currently brings the development-only `undici-types` transitive package; none of these packages are part of the parser runtime.
