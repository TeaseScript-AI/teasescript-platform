# TeaseScript Platform

Browser-first platform and deterministic scripting language for interactive teases, persistent personalities, and broader roleplay packages.

Start with [`README-FIRST.md`](README-FIRST.md).

Current development stage: initial local parser POC. The implemented grammar slice is limited to speaker declarations, default-speaker selection, `say`, `say as`, strings, template interpolation, property access in interpolation, and `exit`. Runtime execution remains out of scope.

## Parser POC development

Use the Node.js version pinned in `.nvmrc`, then run:

```shell
npm ci
npm run check
```

The POC has two development-only dependencies, both exactly pinned in the lockfile:

- `typescript` compiles and statically checks the TypeScript parser core. Plain JavaScript or a separate transpiler would either abandon the accepted TypeScript architecture or add another tool. It requires compiler-version maintenance, but adds no runtime package or production network access.
- `@types/node` supplies types for the Node.js test harness. Hand-maintained declarations would duplicate the Node API surface. It must track the pinned Node.js version and currently brings the development-only `undici-types` transitive package; none of these packages are part of the parser runtime.
