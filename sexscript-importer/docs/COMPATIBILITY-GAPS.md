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

## Conversion gates

Importer progress is measured at package level rather than by requiring every generated `.tease` file to be standalone:

1. **Recognized** — the legacy source parses and the importer understands its structural form.
2. **Lowered** — the script body has TeaseScript IR/output without direct migration errors.
3. **Dependency-closed** — every generated function call resolves to generated package code or a known accepted
   TeaseScript/Standard-Library capability. This includes transitive helper dependencies.
4. **Compiler-clean** — the resulting generated package passes the real compiler for the capability surface being
   claimed. Current POC implementation coverage must be distinguished from accepted V30 syntax.
5. **Runnable/verified** — relevant execution paths have actually run without unresolved runtime behavior.

The current POC embeds transitively required helper functions into generated `.tease` output because generic
package-library linkage is not yet available to the importer. That is a current migration strategy, not a language
requirement that every `.tease` file be permanently standalone.

Auxiliary Groovy classes with fields are not duplicated automatically. Fields may represent shared/static mutable
state whose semantics would change if helper functions were copied independently. The parser exports these fields and
the importer reports `SX_HELPER_SHARED_STATE` instead. The current `Domme3Class` corpus helper has zero class fields,
so its helper methods do not carry hidden in-memory class state.

## Proven importer gaps

Current examples that are not TeaseScript language gaps:

- Groovy `getBooleans(...)` targets accepted `askBooleans(...)`;
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
- 44/44 script bodies are **recognized**;
- 7/44 are fully **lowered** without direct migration errors;
- those same 7/44 are currently **dependency-closed** after package helper composition;
- the corpus has 278 root migration errors after the `getBooleans` mapping, down from 287 before it;
- direct `.groovy` -> Groovy AST -> migration IR -> `.tease` conversion works;
- package conversion embeds only transitively required TeaseScript helper functions and never emits a Groovy runtime
  dependency;
- the focused importer suite passes 46/46 tests and `git diff --check` is clean.

The current engine compiler still rejects all seven dependency-closed outputs because the generated sources use a mix
of accepted V30 capabilities not implemented by the current POC and, for larger scripts, resulting parser cascades.
That is not reported as a TeaseScript language gap until accepted-syntax validation proves the generated form itself
invalid.

The parser also had one important importer bug: Groovy `NotExpression` is a subtype of `BooleanExpression`, so checking
`BooleanExpression` first silently dropped `!`. The exporter now preserves negation before corpus measurements are
trusted.
