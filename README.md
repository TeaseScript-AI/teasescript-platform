# TeaseScript platform

Browser-first platform and deterministic scripting language for interactive teases, BDSM scenes, persistent personalities, and broader roleplay packages.

Start with [`README-FIRST.md`](README-FIRST.md).

## Current TypeScript POC

The repository contains the parser/core language, semantic validation, a versioned serializable instruction runtime, explicit loop and call frames, checkpoint save/restore, deterministic control flow and random built-ins, user-defined functions, source-order/checkpoint hardening, and a standalone browser playground.

Instruction plans, runtime snapshots, and checkpoints currently use version 3 and reject unsupported older versions. The wider V30 language and complete static type checking remain out of scope.

## Development

Use Node.js 24.18.0 from `.nvmrc`:

```shell
nvm use
npm ci
npm run check
npm run build
git diff --check
```

## Standalone development playground

```shell
npm ci
npm run playground
```

The development server builds TypeScript first and listens at `http://127.0.0.1:4173/` by default. To expose it deliberately through an LXC or LAN interface:

```shell
HOST=0.0.0.0 PORT=4173 npm run playground
```

Binding to `0.0.0.0` exposes this development server to every network that can reach the container. The playground is not production-ready and is not a public Node backend; Laravel remains the only eventual public backend.

The page offers fixed repository examples for core behavior, control flow, active-loop checkpoints, and functions. Saved checkpoints are namespaced by example and checkpoint format version.

Fresh playground runs use the fixed unsigned seed `0x6d2b79f5` (`1831565813`) with the versioned `xorshift32-v1` runtime RNG. It is deterministic and serializable, not cryptographically secure and not a permanent syntax guarantee.

The POC has two exactly pinned development dependencies:

- `typescript` compiles and statically checks the TypeScript core;
- `@types/node` supplies types for the Node.js test and development-server harness.

Neither is a runtime package exposed to TeaseScript content.

## Documentation

- [`CURRENT-DESIGN.md`](CURRENT-DESIGN.md)
- [`PHASE-STATUS.md`](PHASE-STATUS.md)
- [`docs/README.md`](docs/README.md)
- [`docs/specifications/accepted-syntaxes-v30.md`](docs/specifications/accepted-syntaxes-v30.md)
- [`docs/decisions/README.md`](docs/decisions/README.md)
