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

## First supported slice

Target ordinary authored flow first:

- scalar literals, strings, null, lists, simple maps/objects, and local variables;
- arithmetic, comparison, boolean logic, string interpolation/concatenation where semantics are clear;
- `if`/`else`, `while`, simple `for` patterns, `break`, `continue`, and script-level `return`;
- common SexScript interaction calls;
- waits and gauge waits;
- local save/load operations;
- deterministic random and time access where TeaseScript has an accepted equivalent;
- image/audio operations with package-relative resources;
- script chaining through a returned script name.

The POC should preserve readable source structure rather than mechanically reproduce Groovy syntax.

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

## Corpus

The working corpus includes:

- the scripts bundled with the SexScript distribution;
- the user-provided Domme3 package, which contains a multi-script `scripts/Domme3/` tree;
- the user-provided Discipline archive, including the DisciplineClinic scripts;
- later additional real packages as text-only external inputs.

Binary media from those packages is not committed to this repository.

## Feasibility output

The POC should eventually report counts such as:

```text
automatic statements: N / total
helper candidates: N
manual/warning statements: N
SexScript API calls recognized: N / total
Groovy construct kinds encountered: N
unsupported construct kinds: N
```

Those numbers are evidence for deciding the production importer scope. They are not compatibility promises.
