# SexScript importer feasibility POC

## Goal

Determine how much real SexScript content can be converted automatically into normal TeaseScript packages without
shipping Groovy or the old SexScript runtime.

## Architecture hypothesis

The POC tests this pipeline:

```text
legacy package discovery
  -> reconstruct effective SexScript Groovy context
  -> parse to Groovy AST without executing user code
  -> normalize to a parser-neutral source AST
  -> SexScript semantic classification
  -> migration IR
  -> .tease lowering
  -> optional narrow .ts helper generation
  -> migration report
```

The parser is a replaceable import-time implementation detail. The migration IR is the boundary that should remain
stable enough to test lowering independently from a particular Groovy parser implementation.

## Target policy

The importer targets accepted TeaseScript (V30 plus accepted ADRs and the owner storage decision below), not the
subset the current compiler implements. Script chaining, for example, has no faithful implemented substitute, so
avoiding accepted-but-unimplemented forms would only trade compiler errors for wrong behavior. Within that target:

- prefer an implemented compact form when it is equally faithful, such as `say` plus `askText`, `askNumber`, or a
  `choose` with numeric or `yes`/`no` labels instead of parenthesized V30 input calls;
- produce natural TeaseScript: keep comments and paragraph breaks, `else if` chains, interpolation, and idiomatic
  forms such as `list.random`; rename only identifiers TeaseScript rejects; make Groovy's implicit last-expression
  result an explicit `return` only in functions whose result some caller in the package uses;
- never move evaluation silently: a rewrite that hoists a condition or an input prompt applies only when the
  expression is unguarded, nothing with side effects is evaluated earlier in the same statement, and a hoisted part
  with side effects does not run before values the statement read earlier;
- resolve package architecture statically instead of emulating Groovy: anonymous-object scripts become globals and
  functions, runtime-loaded mixin modules become functions plus direct load calls (only when the loader's file
  selection is the plain `*.groovy` filter, every file of the directory is a recognized module, and module results do
  not depend on control flow), and closures or functions kept as values become action IDs with one generated
  dispatcher;
- keep every unconverted statement visible: an inline `// TODO` with the root cause, followed by the original Groovy
  as `// |` lines; behavior-relevant approximations get an inline `// NOTE`.

The compiler gate compiles each generated script as is and once more with the accepted-but-unimplemented forms
replaced by placeholder host calls (`src/pending.ts`), so implementation gaps and importer defects are counted apart.

## Target storage semantics

Owner decision (2026-10-02):

- `load "key"` returns `null` when the key is missing;
- `load "key" default value` returns the supplied value when the key is missing;
- neither form writes storage;
- only `save` writes storage.

`main` implements and specifies these semantics (#484); saving `null` removes the key.

## Required diagnostics

Do not silently approximate behavior when the source depends on:

- reflection or `Class.forName`;
- arbitrary Java, Android, AWT, OS, process, filesystem, or unrestricted network APIs;
- Groovy metaprogramming or dynamic method/property names;
- mutable alias identity that is observably different from TeaseScript value-copy semantics;
- a `def` variable changing between incompatible runtime types;
- unsupported closures, exception-driven control flow, or Java object identity;
- platform- or locale-dependent behavior without a defined TeaseScript capability.

Each unsupported construct should retain a source span and a machine-readable diagnostic code.

## Helper boundary

Generated `.ts` is not a generic fallback for unsupported Groovy. It is reserved for deterministic synchronous
portable logic that fits the normal TeaseScript package-library boundary, such as a complex pure transformation or a
deliberate Canvas rewrite of recognized drawing intent.

Anything that blocks on input, time, media completion, or another resumable action must lower to normal TeaseScript /
engine-managed behavior rather than an invisibly suspended TypeScript call.

## Corpus and feasibility output

The corpus and its dated measurements are in [`CORPUS-INVENTORY.md`](CORPUS-INVENTORY.md). Binary media and legacy
archives are not committed. The feasibility report (`node src/cli.ts report --compile ...`) counts the conversion gates,
root diagnostics by code, compiler diagnostics that remain after pending-capability placeholders, and which pending
capabilities block otherwise clean scripts. Those numbers are evidence for deciding the production importer scope,
not compatibility promises.
