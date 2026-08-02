# TeaseScript platform

Browser-first platform and deterministic scripting language for interactive teases, BDSM scenes, persistent personalities, and broader roleplay packages.

Start with [`README-FIRST.md`](README-FIRST.md).

## Current TypeScript POC

The repository contains the parser/core language, semantic validation, a versioned serializable instruction runtime, explicit loop and call frames, checkpoint save/restore, deterministic control flow and random built-ins, user-defined functions, source-order/checkpoint hardening, and a standalone browser playground.

The current internal instruction-plan, runtime-snapshot, and checkpoint format revisions are documented in [`docs/RUNTIME.md`](docs/RUNTIME.md). Non-current revisions are rejected. The wider V30 language and complete static type checking remain out of scope.

## Development

The exact Node.js version declared in `.nvmrc` is required. Activate it with any suitable mechanism. When NVM is available, `nvm use` is one optional method; missing NVM, or NVM not seeing a version activated by `actions/setup-node`, a container, or another version manager, is not itself a failure. Confirm the effective environment before installing dependencies:

```shell
node --version
npm --version
npm ci
npm run check
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

The POC has three exactly pinned top-level development dependencies:

- `@typescript/native@npm:typescript@7.0.2` provides the canonical TypeScript 7 compiler and public `tsc` command;
- `typescript@npm:@typescript/typescript6@6.0.2` provides the TypeScript 6 programmable API used by repository metadata tooling and exposes `tsc6`;
- `@types/node@24.13.3` supplies types for the Node.js test and development-server harness.

The build and typecheck scripts use the public TypeScript 7 `tsc` command. Repository tooling imports `typescript`, which is deliberately aliased to the TypeScript 6 compatibility package. The lockfile fixes its exact transitive TypeScript 6 implementation. None of these dependencies is a runtime package exposed to TeaseScript content.

## Documentation

- [`CURRENT-DESIGN.md`](CURRENT-DESIGN.md)
- [`PHASE-STATUS.md`](PHASE-STATUS.md)
- [`docs/README.md`](docs/README.md)
- [`docs/specifications/accepted-syntaxes-v30.md`](docs/specifications/accepted-syntaxes-v30.md)
- [`docs/decisions/README.md`](docs/decisions/README.md)
