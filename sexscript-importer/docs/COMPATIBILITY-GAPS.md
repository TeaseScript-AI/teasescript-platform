# Compatibility gaps and TeaseScript feedback

This document separates importer limitations from actual TeaseScript design questions. SexScript compatibility is not
a reason by itself to copy Groovy or the old runtime.

## Classification

Every unsupported corpus construct should end in one of four buckets:

1. **Importer gap** — TeaseScript already expresses the behavior; the converter needs a rewrite or better analysis.
2. **Semantic difference** — both languages can express the intent, but automatic conversion needs an explicit rewrite
   or warning because observable behavior differs.
3. **Capability candidate** — the legacy script uses a generally useful behavior for which accepted TeaseScript has no
   proven equivalent. This is evidence for owner evaluation, not an automatic language change.
4. **Legacy baggage** — JVM, reflection, process, filesystem, dynamic class loading, or similarly host-specific behavior
   that should not be reproduced in TeaseScript merely for compatibility.

## Proven importer gaps

Current examples that are not TeaseScript language gaps:

- Groovy `getBooleans(...)` can target accepted `askBooleans(...)`;
- Groovy list `.size`/`.size()` can target TeaseScript `.length` when the receiver is proven to be a list;
- ordinary Groovy helper closures/methods can usually become normal TeaseScript functions;
- static Groovy maps with identifier-like keys can become TeaseScript objects;
- list `indexOf` and SexScript `loadFirstTrue` can be expressed through generated ordinary TeaseScript helper functions.

## Known semantic differences

- Groovy lists/maps use mutable reference aliasing; TeaseScript ordinary composite values use ADR 0014 deep-copy value
  semantics. Alias-dependent scripts need analysis or a warning rather than silently changing TeaseScript semantics.
- Groovy `def` may change runtime type; TeaseScript variables keep their inferred or declared type.
- SexScript/JVM APIs may expose host state that has no deterministic package-level equivalent.

## Capability candidates

### Single-field input prefill/default values

SexScript `getString`, `getInteger`, and `getFloat` accept a value that is shown as the field's initial value. Accepted
TeaseScript has defaults for multi-field `askNumbers`, `askIntegers`, and `askBooleans`, but no proven equivalent option
for the single-field `askText`, `askInteger`, or `askNumber` APIs. The corpus currently has 62 root diagnostics in this
family. This is evidence worth owner evaluation, but the importer must not invent an approximation.

## Accepted syntax versus current implementation

The accepted V30 specification is broader than the current POC compiler/runtime. In particular, generated use of
accepted storage plus `run`/`end` can still be rejected by the current implementation. That is an implementation
coverage gap, not by itself a language-design gap.

A direct conversion of the distribution's `simpleexample.groovy` is importer-clean. When only those accepted but
currently unimplemented operations are replaced in a local compiler probe, the rest of the generated source parses,
validates, and compiles to an instruction plan with zero diagnostics.

## Current end-to-end evidence

At the current POC checkpoint:

- 45/45 corpus Groovy files parse;
- 44 are executable SexScript script bodies and one is an auxiliary helper class;
- 7 script bodies are importer-clean after self-contained package helper composition;
- direct `.groovy` -> Groovy AST -> migration IR -> `.tease` conversion works;
- package conversion embeds only transitively required TeaseScript helper functions and never emits a Groovy runtime
  dependency.

These numbers are feasibility measurements, not a promise that every importer-clean script is already executable by the
current TeaseScript POC runtime.
