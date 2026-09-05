# Type evidence and lint policy

The lint policy catches discarded type evidence and straightforward JavaScript mistakes while preserving runtime
validation. `.oxlintrc.json` is the executable rule/severity list; all selected rules are errors. `npm run lint` checks
TypeScript and JavaScript source, tests, playground code, and tooling, including the vendored rules themselves.
Dependency, build, coverage, and Git directories are excluded. `npm run check` includes lint and rule fixtures.

## Type evidence

Keep precise contracts through ordinary code. Do not erase a known value into `any`, `unknown`, broad `object`, or an
uninformative dictionary and recreate its type with assertions. Precise inline object contracts, typed dictionaries,
and calls to runtime validators remain valid. Mutable boundary accumulators may start with a nullish sentinel.

Explicit `unknown` inputs and dictionary values remain appropriate for capture, validation, error handling, and
external data. Do not disguise `unknown` with a type alias or claim an already parsed domain type before validation.
Functions returning still-unvalidated data need a local return-contract exception. Dictionaries of `any`, broad
`object`, or effectively empty objects need a concrete value contract or a justified exception. Explicit `any` is also
checked outside dictionary types, including test helpers and mutation callbacks.

Runtime `typeof`, descriptor/prototype inspection, property omission, and partial static analyses are legitimate
techniques. Lint does not require schema dependencies, forbid every reflective operation, or determine whether a
boundary validation is sufficient. `Reflect.get` and `Reflect.apply` require a specific justification because they
bypass ordinary typed property access or invocation.

## Evidence and exceptions

Every non-const type assertion needs an `EVIDENCE:` comment attached to that assertion or its immediate statement.
State the actual invariant, validation stage, external contract, or intentionally invalid fixture. A comment above a
function or block does not justify assertions inside it. A comment immediately before an object property applies to
assertions in that property's value. For example:

```ts
// EVIDENCE: validation: the preceding descriptor checks captured every required envelope field.
```

Use a rule-specific line exception when a selected rule would reject a necessary construct:

```ts
// oxlint-disable-next-line anti-slop/no-reflect-get -- EVIDENCE: fixture: forward unchanged proxy keys while varying items.
```

Only `oxlint-disable-next-line` and `oxlint-disable-line` with explicit rule names and an `EVIDENCE:` explanation are
allowed. Multiple named rules may apply to the same operation. File/block/all-rule disables and alternative inline
configuration are prohibited. A separate comment check enforces this syntax; Oxlint rejects unused disables.
An evidence comment alone does not disable other rules. Search for `EVIDENCE:` to find intentional exceptions.

Legitimate cases include external capture/validation, branded constructors, compiler invariants not represented by
TypeScript, and malformed-data or proxy fixtures. File location alone is not evidence. Keep fixture setup and outcome
assertions typed where possible; do not centralize exceptions in universal unchecked cast or mutation helpers.
Comments must describe real evidence, not merely repeat that an assertion is safe. Their truth remains a review
responsibility: the checker validates attachment and syntax, not the underlying invariant.

## Maintenance

Oxlint and its plugin API package are development-only dependencies pinned together in `package.json` and the lockfile.
They execute native/JavaScript code during local checks and CI. Vendored source retains upstream attribution and the
selected revision in `tools/oxlint/anti-slop/`; upgrades require reviewing changes and rerunning local rule fixtures.
The local adaptations allow precise contracts and honest `unknown` dictionaries and restrict assertion-comment scope.
Do not enable new upstream defaults as an incidental upgrade.

This avoids adding ESLint, a schema library, another test runner, or a second type-checking engine. Node runs the rule
fixtures directly; the existing compiler type-checks their source. The separate exception checker reuses the existing
`ts-morph` parser dependency. The costs are maintaining the selected plugin source and reviewing justified exceptions;
the plugin's lexical analysis does not prove cross-file type safety or replace runtime boundary tests.
