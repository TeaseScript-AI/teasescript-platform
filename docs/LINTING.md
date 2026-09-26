# Lint policy

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

This type-evidence route avoids a schema library, another test runner, and a second type-checking engine. Node runs
the rule fixtures directly; the existing compiler type-checks their source. The separate exception checker reuses the
existing `ts-morph` parser dependency. The costs are maintaining the selected plugin source and reviewing justified
exceptions; the plugin's lexical analysis does not prove cross-file type safety or replace runtime boundary tests.

## Player design lint

`npm run lint:design:phase2c` checks Phase 2C Vue/TypeScript, shared `components/ui` source (including
CVA variants), and `PlayerActionButton.vue`. `eslint.design.config.mjs` owns the executable scope and
contracts. The command and `npm run test:lint:design` are required by `npm run check`, including CI.
Selected rules are errors; warnings fail the command. This scope does not cover the editor or every
maintained Player component, and does not select Phase 2C as the production Player.

Use semantic theme utilities and complete class names. Shared components own their appearance;
choose their variants instead of adding padding, color, shape or typography overrides at call sites.
Composition can control placement and containment. Check ownership before adding a variant or
exception: an existing override is not evidence of a sound boundary. The embedded Textarea variant
removes field chrome because Composer owns the enclosing surface and focus treatment; BubbleContent
owns reading size and joined corners. Player-owned material, authored appearance and specialized
chrome stay in their local components. File/component-specific contracts allow their named CSS hooks,
not arbitrary overrides throughout the application. Inline ESLint configuration is disabled; necessary
exceptions belong in the configuration with a concrete rationale and regression coverage.

The arbitrary-value rule rejects bracket values outside the configured mechanics and theme-derived
component formulas. It does **not** impose a finite spacing scale: Tailwind values such as `p-3.25`
remain valid. Do not replace a rejected value mechanically to make lint pass; assess the design intent.
The local fragmented-class rule catches direct interpolation/concatenation in Vue class bindings and
`cn`, `clsx` and `cva` calls, including native elements. Use complete literal alternatives. Unlike upstream
`require-static-classes`, it permits safe helpers; it does not resolve arbitrary helper bodies, aliased
class builders or data flow. Review those paths when changing them.

These checks do not inspect CSS declarations, compute contrast, validate author colors, or prove visual
consistency. Scoped/global CSS, runtime style objects and externally supplied classes still need review
and relevant browser checks. `no-inline-styles` stays off because authored styles, virtualizer offsets
and measured geometry are legitimate; forcing them through CSS variables solely for lint adds indirection.
Do not move a violation into CSS or an opaque helper to evade a diagnostic. Preserve author-selected
foreground/background pairs under the Player color contract. A CSS linter is not added here: meaningful
palette validation would also need to distinguish theme definitions, technical masks/lighting, debug
overlays and author data, beyond this utility/component check.

ESLint, `@shadcn/lint` and the Vue/TypeScript parsers are pinned development dependencies. Oxlint remains
the JavaScript/type-evidence check; its plugin route cannot inspect Vue templates. These packages parse
local source and load theme configuration during checks, execute code in local/CI environments, and add
no browser runtime. The alternative was manual review alone or a larger custom Vue analyzer. Keep the
local rule limited to the demonstrated upstream gap; review parser/plugin compatibility and dependency
advisories on upgrades and run the configured positive/negative fixtures. Upstream currently prints
informational notices for exact scoped CSS hook contracts; these are not ESLint diagnostics and do not
weaken the rules. Do not broaden them to wildcards to hide those notices.
